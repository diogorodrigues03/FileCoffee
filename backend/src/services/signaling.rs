use crate::models::{Room, ServerMessage};
use uuid::Uuid;
use warp::ws::Message;

/// Services for WebRTC signaling operations.
/// Handles broadcasting signals between peers.
pub struct SignalingService;

impl SignalingService {
    pub fn new() -> Self {
        Self
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

    /// Notify all peers that someone joined.
    pub async fn broadcast_peer_joined(&self, room: &Room, new_peer_id: Uuid, peer_count: usize) {
        let msg = ServerMessage::PeerJoined { peer_count };
        let msg_text = serde_json::to_string(&msg).unwrap_or_default();

        let peers = room.peers().read().await;
        for (peer_id, peer) in peers.iter() {
            if *peer_id != new_peer_id {
                let _ = peer.sender.send(Message::text(msg_text.clone()));
            }
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

impl Default for SignalingService {
    fn default() -> Self {
        Self::new()
    }
}
