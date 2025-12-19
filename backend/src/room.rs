use crate::types::PeerSender;
use std::sync::Arc;
use tokio::sync::RwLock;
use warp::filters::ws::Message;

#[derive(Clone)]
pub struct Room {
    id: String,
    pub password: Option<String>,
    peers: Arc<RwLock<Vec<PeerSender>>>,
}

impl Room {
    pub fn new(id: String, password: Option<String>) -> Self {
        Room {
            id,
            password,
            peers: Arc::new(RwLock::new(Vec::new())),
        }
    }

    // Helper method to broadcast a message to all peers except the sender
    pub async fn broadcast(&self, message: Message, skip_peer: Option<usize>) {
        let peers = self.peers.read().await;
        for (index, peer) in peers.iter().enumerate() {
            // Skip the sender if specified
            if let Some(skip_index) = skip_peer && index == skip_index {
                    continue;
            }
            // Ignore errors (peer might have disconnected)
            let _ = peer.send(message.clone());
        }
    }

    pub fn peers(&self) -> &Arc<RwLock<Vec<PeerSender>>> {
        &self.peers
    }
}
