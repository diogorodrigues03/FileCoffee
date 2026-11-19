use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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
    /// Peer that created the room (the sender). Only the owner may reject peers.
    owner_id: Uuid,
    /// Connected peers, keyed by UUID to avoid index shifting issues
    peers: Arc<RwLock<HashMap<Uuid, Peer>>>,
    /// When the room was created
    created_at: Instant,
    /// Last activity timestamp, for TTL calculations
    last_activity: Arc<RwLock<Instant>>,
    /// Wrong password attempts so far (shared by all clones of this room)
    failed_password_attempts: Arc<AtomicU32>,
    /// Set (under the peers write lock) when the room is removed from the
    /// store, so a join that fetched the room just before can't add a peer
    /// to a room nobody can reach any more.
    closed: Arc<AtomicBool>,
}

impl Room {
    /// Create a new room with `owner` as its first peer.
    /// Password should already be hashed!
    pub fn new(id: String, password_hash: Option<String>, owner: Peer) -> Self {
        let now = Instant::now();
        let owner_id = owner.id;
        let mut peers = HashMap::new();
        peers.insert(owner_id, owner);
        Self {
            id,
            password_hash,
            owner_id,
            peers: Arc::new(RwLock::new(peers)),
            created_at: now,
            last_activity: Arc::new(RwLock::new(now)),
            failed_password_attempts: Arc::new(AtomicU32::new(0)),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn password_hash(&self) -> Option<&str> {
        self.password_hash.as_deref()
    }

    pub fn owner_id(&self) -> Uuid {
        self.owner_id
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

    pub fn failed_password_attempts(&self) -> &AtomicU32 {
        &self.failed_password_attempts
    }

    pub fn last_activity(&self) -> &Arc<RwLock<Instant>> {
        &self.last_activity
    }

    /// Restart the idle clock used for expiry.
    pub async fn touch(&self) {
        *self.last_activity.write().await = Instant::now();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Call while holding the peers write lock.
    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }
}
