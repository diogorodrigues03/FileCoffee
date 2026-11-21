use crate::config::Config;
use crate::handlers::ws_handler::{PeerContext, cleanup_peer, handle_client_message};
use crate::middleware::rate_limit::{
    ClientKey, ConnectionGuard, RateLimited, RateLimits, client_key,
};
use crate::models::{ClientMessage, ServerMessage, error_codes};
use crate::services::{RoomService, SignalingService};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc};
use warp::{
    Filter,
    ws::{Message, WebSocket},
};

/// Shared state needed by every WebSocket connection.
#[derive(Clone)]
pub struct WsState {
    pub config: Arc<Config>,
    pub room_service: Arc<RoomService>,
    pub signaling_service: Arc<SignalingService>,
    pub limits: Arc<RateLimits>,
}

pub fn ws_route(
    state: WsState,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    let admit_state = state.clone();
    warp::path("ws")
        .and(warp::ws())
        .and(client_key(state.limits.trusted_proxy_hops))
        // Per-client connection limits are checked *before* the upgrade, so a
        // rejected client gets a plain HTTP 429 and costs us no socket task.
        .and_then(move |ws: warp::ws::Ws, key: ClientKey| {
            let limits = admit_state.limits.clone();
            async move {
                if !limits.ws_connect.check(key) {
                    limits.log_limited(key, "ws_connect");
                    return Err(warp::reject::custom(RateLimited));
                }
                match limits.ws_open.try_acquire(key) {
                    Some(guard) => Ok((ws, key, guard)),
                    None => {
                        limits.log_limited(key, "ws_open");
                        Err(warp::reject::custom(RateLimited))
                    }
                }
            }
        })
        .untuple_one()
        .map(move |ws: warp::ws::Ws, key: ClientKey, guard: ConnectionGuard| {
            let state = state.clone();
            ws.max_message_size(state.config.ws_max_message_size)
                .max_frame_size(state.config.ws_max_message_size)
                .on_upgrade(move |socket| handle_connection(socket, state, key, guard))
        })
}

fn send(tx: &mpsc::UnboundedSender<Message>, msg: &ServerMessage) {
    if let Ok(text) = serde_json::to_string(msg) {
        let _ = tx.send(Message::text(text));
    }
}

fn send_error(tx: &mpsc::UnboundedSender<Message>, code: &str, message: &str) {
    send(
        tx,
        &ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        },
    );
}

async fn handle_connection(
    ws: WebSocket,
    state: WsState,
    client: ClientKey,
    // Held for the lifetime of the connection; frees the per-client slot on drop.
    _connection_slot: ConnectionGuard,
) {
    tracing::debug!(client = %client, "New WebSocket connection");

    let WsState {
        room_service,
        signaling_service,
        limits,
        ..
    } = state;

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let peer_context = Arc::new(RwLock::new(PeerContext::new()));
    let mut message_bucket = limits.ws_message_bucket();

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
                // Includes messages over `ws_max_message_size`
                tracing::warn!(error = %e, "WebSocket error");
                break;
            }
        };

        // Every frame counts, so ping/binary floods are limited too.
        if !message_bucket.try_take() {
            limits.log_limited(client, "ws_messages");
            send_error(&tx, error_codes::RATE_LIMITED, "Too many messages; disconnected");
            let _ = tx.send(Message::close());
            break;
        }

        let Ok(text) = msg.to_str() else {
            continue;
        };

        let client_msg = match serde_json::from_str::<ClientMessage>(text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to parse message");
                send_error(&tx, error_codes::INVALID_MESSAGE, "Invalid message format");
                continue;
            }
        };

        // Expensive operations get their own per-client limits.
        let allowed = match &client_msg {
            ClientMessage::CreateRoom { .. } => limits.create_room.check(client),
            ClientMessage::JoinRoom { .. } => limits.join_room.check(client),
            _ => true,
        };
        if !allowed {
            limits.log_limited(client, "create_or_join");
            send_error(
                &tx,
                error_codes::RATE_LIMITED,
                "Too many attempts. Please wait a minute and try again.",
            );
            continue;
        }

        handle_client_message(
            client_msg,
            &tx,
            &room_service,
            &signaling_service,
            &peer_context,
        )
        .await;
    }

    cleanup_peer(peer_context, &room_service, &signaling_service).await;
}
