use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio::sync::mpsc;
use uuid::Uuid;
use warp::ws::Message;

/// Type alias for a sender that can send WebSocket messages
pub type PeerSender = mpsc::UnboundedSender<Message>;

/// Represents a peer in a room
#[derive(Clone)]
pub struct Peer {
    pub id: Uuid,
    pub sender: PeerSender,
    pub joined_at: Instant,
}

impl Peer {
    pub fn new(sender: PeerSender) -> Self {
        Self {
            id: Uuid::new_v4(),
            sender,
            joined_at: Instant::now(),
        }
    }
}

/// Room data structure
#[derive(Clone)]
pub struct Room {
    /// Unique room identifier (slug or UUID)
    id: String,
    /// Optional password hash
    password_hash: Option<String>,
    /// Connected peers, keyed by UUID to avoid index shifting issues
    peers: Arc<RwLock<HashMap<Uuid, Peer>>>,
    /// When the room was created
    created_at: Instant,
    /// Last activity timestamp, for TTL calculations
    last_activity: Arc<RwLock<Instant>>,
}

impl Room {
    /// Create a new room. Password should already be hashed!
    pub fn new(id: String, password_hash: Option<String>) -> Self {
        let now = Instant::now();
        Self {
            id,
            password_hash,
            peers: Arc::new(RwLock::new(HashMap::new())),
            created_at: now,
            last_activity: Arc::new(RwLock::new(now)),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn password_hash(&self) -> Option<&str> {
        self.password_hash.as_deref()
    }

    pub fn has_password(&self) -> bool {
        self.password_hash.is_some()
    }

    pub fn created_at(&self) -> Instant {
        self.created_at
    }

    pub fn peers(&self) -> &Arc<RwLock<HashMap<Uuid, Peer>>> {
        &self.peers
    }

    pub fn last_activity(&self) -> &Arc<RwLock<Instant>> {
        &self.last_activity
    }
}
