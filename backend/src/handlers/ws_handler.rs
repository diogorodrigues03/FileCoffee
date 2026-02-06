use crate::models::{ClientMessage, PeerSender, ServerMessage, error_codes};
use crate::services::{RoomService, SignalingService};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;
use warp::ws::Message;

/// Context for the current peer connection.
pub struct PeerContext {
    pub room_id: Option<String>,
    pub peer_id: Option<Uuid>,
}

impl PeerContext {
    pub fn new() -> Self {
        Self {
            room_id: None,
            peer_id: None,
        }
    }
}

/// Handle incoming WebSocket messages.
/// This function ONLY parses messages and delegates to services.
pub async fn handle_client_message(
    msg: ClientMessage,
    peer_tx: &PeerSender,
    room_service: &RoomService,
    signaling_service: &SignalingService,
    peer_context: &Arc<RwLock<PeerContext>>,
) {
    match msg {
        ClientMessage::CreateRoom { password } => {
            handle_create_room(password, peer_tx, room_service, peer_context).await;
        }
        ClientMessage::JoinRoom { room_id, password } => {
            handle_join_room(
                room_id,
                password,
                peer_tx,
                room_service,
                signaling_service,
                peer_context,
            )
            .await;
        }
        ClientMessage::Signal { data } => {
            handle_signal(data, peer_tx, room_service, signaling_service, peer_context).await;
        }
        ClientMessage::Ping => {
            send_message(peer_tx, ServerMessage::Pong);
        }
    }
}

async fn handle_create_room(
    password: Option<String>,
    peer_tx: &PeerSender,
    room_service: &RoomService,
    peer_context: &Arc<RwLock<PeerContext>>,
) {
    match room_service.create_room(password.clone()).await {
        Ok(room_id) => {
            // Add creator as first peer
            match room_service
                .join_room(&room_id, password, peer_tx.clone())
                .await
            {
                Ok((peer_id, _)) => {
                    // Update peer context
                    let mut ctx = peer_context.write().await;
                    ctx.room_id = Some(room_id.clone());
                    ctx.peer_id = Some(peer_id);
                    drop(ctx);

                    send_message(peer_tx, ServerMessage::RoomCreated { room_id });
                }
                Err(e) => {
                    send_error(peer_tx, error_codes::ROOM_NOT_FOUND, &e.to_string());
                }
            }
        }
        Err(e) => {
            send_error(peer_tx, error_codes::ROOM_NOT_FOUND, &e.to_string());
        }
    }
}

async fn handle_join_room(
    room_id: String,
    password: Option<String>,
    peer_tx: &PeerSender,
    room_service: &RoomService,
    signaling_service: &SignalingService,
    peer_context: &Arc<RwLock<PeerContext>>,
) {
    match room_service
        .join_room(&room_id, password, peer_tx.clone())
        .await
    {
        Ok((peer_id, peer_count)) => {
            // Update peer context
            let mut ctx = peer_context.write().await;
            ctx.room_id = Some(room_id.clone());
            ctx.peer_id = Some(peer_id);
            drop(ctx);

            // Notify other peers
            if let Some(room) = room_service.get_room(&room_id).await {
                signaling_service
                    .broadcast_peer_joined(&room, peer_id, peer_count)
                    .await;
            }

            send_message(peer_tx, ServerMessage::RoomJoined);
        }
        Err(e) => {
            let code = match &e {
                crate::error::AppError::RoomNotFound(_) => error_codes::ROOM_NOT_FOUND,
                crate::error::AppError::InvalidPassword => error_codes::INVALID_PASSWORD,
                crate::error::AppError::RoomCapacityExceeded => error_codes::ROOM_FULL,
                _ => error_codes::INVALID_MESSAGE,
            };
            send_error(peer_tx, code, &e.to_string());
        }
    }
}

async fn handle_signal(
    data: serde_json::Value,
    peer_tx: &PeerSender,
    room_service: &RoomService,
    signaling_service: &SignalingService,
    peer_context: &Arc<RwLock<PeerContext>>,
) {
    let ctx = peer_context.read().await;
    let (room_id, peer_id) = match (&ctx.room_id, ctx.peer_id) {
        (Some(rid), Some(pid)) => (rid.clone(), pid),
        _ => {
            send_error(peer_tx, error_codes::NOT_IN_ROOM, "Not in a room");
            return;
        }
    };
    drop(ctx);

    if let Some(room) = room_service.get_room(&room_id).await {
        signaling_service
            .broadcast_signal(&room, peer_id, data)
            .await;
    }
}

/// Cleanup when a peer disconnects
pub async fn cleanup_peer(
    peer_context: Arc<RwLock<PeerContext>>,
    room_service: &RoomService,
    signaling_service: &SignalingService,
) {
    let ctx = peer_context.read().await;
    let (room_id, peer_id) = match (&ctx.room_id, ctx.peer_id) {
        (Some(rid), Some(pid)) => (rid.clone(), pid),
        _ => return,
    };
    drop(ctx);

    // Get room before removing peer (to broadcast to remaining peers)
    if let Some(room) = room_service.get_room(&room_id).await {
        let was_deleted = room_service
            .leave_room(&room_id, peer_id)
            .await
            .unwrap_or(false);

        if !was_deleted {
            let remaining = room.peers().read().await.len().saturating_sub(1);
            signaling_service
                .broadcast_peer_left(&room, remaining)
                .await;
        }
    }
}

// Helper functions
fn send_message(peer_tx: &PeerSender, msg: ServerMessage) {
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = peer_tx.send(Message::text(text));
    }
}

fn send_error(peer_tx: &PeerSender, code: &str, message: &str) {
    send_message(
        peer_tx,
        ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    );
}

/// HTTP handler for checking room existence
pub async fn check_room_handler(
    room_id: String,
    room_service: Arc<RoomService>,
) -> Result<impl warp::Reply, warp::Rejection> {
    match room_service.get_room_info(&room_id).await {
        Some((exists, has_password)) => {
            let response = ServerMessage::RoomExists {
                exists,
                has_password,
            };
            Ok(warp::reply::json(&response))
        }
        None => Err(warp::reject::not_found()),
    }
}
