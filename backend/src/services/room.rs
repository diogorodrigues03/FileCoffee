use crate::config::Config;
use crate::error::AppError;
use crate::models::{Peer, PeerSender, Room};
use crate::slug_generator::generate_slug;
use crate::store::RoomStore;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Service for room management operations.
/// Contains ALL business logic related to rooms.
pub struct RoomService {
    store: Arc<dyn RoomStore + Send + Sync>,
    config: Arc<Config>,
}

impl RoomService {
    pub fn new(store: Arc<dyn RoomStore + Send + Sync>, config: Arc<Config>) -> Self {
        Self { store, config }
    }

    /// Create a new room with an optional password.
    /// Returns the room ID on success.
    pub async fn create_room(&self, password: Option<String>) -> Result<String, AppError> {
        // Generate unique room ID
        let room_id = self.generate_unique_room_id().await?;

        // Hash password if provided
        let password_hash = match password {
            Some(pwd) if !pwd.is_empty() => Some(self.hash_password(&pwd)?),
            _ => None,
        };

        let has_password = password_hash.is_some();

        let room = Room::new(room_id.clone(), password_hash);
        self.store.insert(room).await;

        tracing::info!(room_id = %room_id, has_password, "Room created");

        Ok(room_id)
    }

    /// Generate a unique slug, falling back to UUID if needed.
    async fn generate_unique_room_id(&self) -> Result<String, AppError> {
        for _ in 0..self.config.slug_max_attempts {
            let candidate = generate_slug();
            if self.store.get(&candidate).await.is_none() {
                return Ok(candidate);
            }
        }

        // Fallback to UUID (virtually no collision risk)
        let uuid = Uuid::new_v4().to_string();
        tracing::warn!("Slug collision limit reached, using UUID: {}", uuid);
        Ok(uuid)
    }

    /// Hash a password using Argon2.
    fn hash_password(&self, password: &str) -> Result<String, AppError> {
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        let argon2 = Argon2::default();

        argon2
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| AppError::InternalError("Password hashing failed".to_string()))
    }

    /// Verify a password against a hash.
    fn verify_password(&self, password: &str, hash: &str) -> bool {
        use argon2::{Argon2, PasswordHash, PasswordVerifier};

        let parsed_hash = match PasswordHash::new(hash) {
            Ok(h) => h,
            Err(_) => return false,
        };

        Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok()
    }

    /// Join an existing room. Validates password and room capacity.
    pub async fn join_room(
        &self,
        room_id: &str,
        password: Option<String>,
        peer_sender: PeerSender,
    ) -> Result<(Uuid, usize), AppError> {
        let room = self
            .store
            .get(room_id)
            .await
            .ok_or_else(|| AppError::RoomNotFound(room_id.to_string()))?;

        // Validate password if the room has one
        if let Some(hash) = room.password_hash() {
            let provided = password.unwrap_or_default();
            if !self.verify_password(&provided, hash) {
                tracing::warn!(room_id = %room_id, "Invalid password attempt");
                return Err(AppError::InvalidPassword);
            }
        }

        // Check room capacity
        let mut peers = room.peers().write().await;
        if peers.len() >= self.config.room_max_peers {
            tracing::warn!(room_id = %room_id, "Room capacity exceeded");
            return Err(AppError::RoomCapacityExceeded);
        }

        // Add peer
        let peer = Peer::new(peer_sender);
        let peer_id = peer.id;
        peers.insert(peer_id, peer);
        let peer_count = peers.len();
        drop(peers);

        // Update last activity
        *room.last_activity().write().await = Instant::now();

        tracing::info!(room_id = %room_id, peer_id = %peer_id, peer_count, "Peer joined room");

        Ok((peer_id, peer_count))
    }

    /// Remove a peer from a room. Returns true if the room was deleted (empty).
    pub async fn leave_room(&self, room_id: &str, peer_id: Uuid) -> Result<bool, AppError> {
        let room = match self.store.get(room_id).await {
            Some(r) => r,
            None => return Ok(false), // Room already gone
        };

        let mut peers = room.peers().write().await;
        peers.remove(&peer_id);
        let is_empty = peers.is_empty();
        let remaining_count = peers.len();
        drop(peers);

        if is_empty {
            self.store.remove(room_id).await;
            tracing::info!(room_id = %room_id, "Room deleted (empty)");
        } else {
            tracing::info!(room_id = %room_id, peer_id = %peer_id, remaining = remaining_count, "Peer left room");
        }

        Ok(is_empty)
    }

    /// Get room info for existence check.
    pub async fn get_room_info(&self, room_id: &str) -> Option<(bool, bool)> {
        self.store
            .get(room_id)
            .await
            .map(|room| (true, room.has_password()))
    }

    /// Clean up stale rooms (called periodically).
    pub async fn cleanup_stale_rooms(&self, max_age: Duration) {
        let stale_room_ids = self.store.get_stale_room_ids(max_age).await;

        for room_id in stale_room_ids {
            self.store.remove(&room_id).await;
            tracing::info!(room_id = %room_id, "Stale room cleaned up");
        }
    }

    /// Get room for signaling operations.
    pub async fn get_room(&self, room_id: &str) -> Option<Room> {
        self.store.get(room_id).await
    }
}
