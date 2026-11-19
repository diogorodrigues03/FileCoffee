use crate::config::Config;
use crate::ice::ice_servers_for_peer;
use crate::models::{Room, ServerMessage};
use std::sync::Arc;
use uuid::Uuid;
use warp::ws::Message;

/// Services for WebRTC signaling operations.
/// Handles broadcasting signals between peers.
pub struct SignalingService {
    config: Arc<Config>,
}

impl SignalingService {
    pub fn new(config: Arc<Config>) -> Self {
        Self { config }
    }

    /// Broadcast a signal to all peers except the sender.
    pub async fn broadcast_signal(
        &self,
        room: &Room,
        sender_id: Uuid,
        signal_data: serde_json::Value,
    ) {
        let signal_msg = ServerMessage::Signal { data: signal_data };
        let msg_text = serde_json::to_string(&signal_msg).unwrap_or_default();

        let peers = room.peers().read().await;
        for (peer_id, peer) in peers.iter() {
            if *peer_id != sender_id {
                let _ = peer.sender.send(Message::text(msg_text.clone()));
            }
        }
    }

    /// Notify all peers that someone joined. Each recipient gets its own
    /// ICE/TURN credentials, bound to its peer ID.
    pub async fn broadcast_peer_joined(&self, room: &Room, new_peer_id: Uuid, peer_count: usize) {
        let peers = room.peers().read().await;
        for (peer_id, peer) in peers.iter() {
            if *peer_id != new_peer_id {
                let msg = ServerMessage::PeerJoined {
                    peer_id: new_peer_id,
                    peer_count,
                    ice_servers: ice_servers_for_peer(&self.config, *peer_id),
                };
                let msg_text = serde_json::to_string(&msg).unwrap_or_default();
                let _ = peer.sender.send(Message::text(msg_text));
            }
        }
    }

    /// ICE servers for a single peer (used when a peer joins a room).
    pub fn ice_servers_for(&self, peer_id: Uuid) -> Vec<crate::ice::IceServer> {
        ice_servers_for_peer(&self.config, peer_id)
    }

    /// Send an error to every peer in a room that is being shut down, then
    /// close their connections.
    pub async fn close_room_with_error(&self, room: &Room, code: &str, message: &str) {
        let msg = ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        };
        let msg_text = serde_json::to_string(&msg).unwrap_or_default();

        let peers = room.peers().read().await;
        for peer in peers.values() {
            let _ = peer.sender.send(Message::text(msg_text.clone()));
            let _ = peer.sender.send(Message::close());
        }
    }

    /// Notify all remaining peers that someone left.
    pub async fn broadcast_peer_left(&self, room: &Room, peer_count: usize) {
        let msg = ServerMessage::PeerLeft { peer_count };
        let msg_text = serde_json::to_string(&msg).unwrap_or_default();

        let peers = room.peers().read().await;
        for (_, peer) in peers.iter() {
            let _ = peer.sender.send(Message::text(msg_text.clone()));
        }
    }
}
