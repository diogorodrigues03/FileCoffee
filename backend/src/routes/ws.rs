use crate::handlers::ws_handler::{PeerContext, cleanup_peer, handle_client_message};
use crate::models;
use crate::models::ClientMessage;
use crate::services::{RoomService, SignalingService};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc};
use warp::{
    Filter,
    ws::{Message, WebSocket},
};

pub fn ws_route(
    room_service: Arc<RoomService>,
    signaling_service: Arc<SignalingService>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path("ws")
        .and(warp::ws())
        .and(warp::any().map(move || room_service.clone()))
        .and(warp::any().map(move || signaling_service.clone()))
        .map(|ws: warp::ws::Ws, room_svc, sig_svc| {
            ws.on_upgrade(move |socket| handle_connection(socket, room_svc, sig_svc))
        })
}

async fn handle_connection(
    ws: WebSocket,
    room_service: Arc<RoomService>,
    signaling_service: Arc<SignalingService>,
) {
    tracing::debug!("New WebSocket connection");

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let peer_context = Arc::new(RwLock::new(PeerContext::new()));
    let peer_context_clone = peer_context.clone();
    let room_service_clone = room_service.clone();
    let signaling_service_clone = signaling_service.clone();

    // Forward messages to WebSocket
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if ws_tx.send(message).await.is_err() {
                break;
            }
        }
    });

    // Process incoming messages
    while let Some(result) = ws_rx.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                tracing::error!(error = %e, "WebSocket error");
                break;
            }
        };

        if let Ok(text) = msg.to_str() {
            match serde_json::from_str::<ClientMessage>(text) {
                Ok(client_msg) => {
                    handle_client_message(
                        client_msg,
                        &tx,
                        &room_service,
                        &signaling_service,
                        &peer_context,
                    )
                    .await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to parse message");
                    let error = models::ServerMessage::Error {
                        code: models::error_codes::INVALID_MESSAGE.to_string(),
                        message: "Invalid message format".to_string(),
                    };
                    let _ = tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                }
            }
        }
    }

    cleanup_peer(
        peer_context_clone,
        &room_service_clone,
        &signaling_service_clone,
    )
    .await;
}
