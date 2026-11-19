use crate::config::Config;
use crate::error::AppError;
use crate::models::{Peer, PeerSender, Room};
use crate::slug_generator::{generate_slug, is_valid_room_id};
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

    /// Create a new room with an optional password, adding the creator as its
    /// owner and first peer. Returns `(room_id, owner_peer_id)`.
    pub async fn create_room(
        &self,
        password: Option<String>,
        owner_sender: PeerSender,
    ) -> Result<(String, Uuid), AppError> {
        // Hash password if provided
        let password_hash = match password {
            Some(pwd) if !pwd.is_empty() => Some(self.hash_password(&pwd)?),
            _ => None,
        };
        let has_password = password_hash.is_some();

        let owner = Peer::new(owner_sender);
        let owner_id = owner.id;

        // With a 128-bit token a collision is practically impossible, but the
        // insert is still atomic so a collision can never overwrite a live room.
        for _ in 0..self.config.slug_max_attempts.max(1) {
            let room_id = generate_slug();
            let room = Room::new(room_id.clone(), password_hash.clone(), owner.clone());
            if self.store.insert_if_absent(room).await {
                tracing::info!(room_id = %room_id, has_password, "Room created");
                return Ok((room_id, owner_id));
            }
        }

        Err(AppError::InternalError(
            "Could not generate a unique room ID".to_string(),
        ))
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
        if !is_valid_room_id(room_id) {
            return Err(AppError::RoomNotFound(room_id.to_string()));
        }

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

    /// Remove `target_id` from the room on behalf of `requester_id`.
    /// Only the room owner may do this, and the owner cannot remove itself.
    /// Returns the removed peer's sender so the caller can notify it.
    pub async fn reject_peer(
        &self,
        room_id: &str,
        requester_id: Uuid,
        target_id: Uuid,
    ) -> Result<PeerSender, AppError> {
        let room = self
            .store
            .get(room_id)
            .await
            .ok_or_else(|| AppError::RoomNotFound(room_id.to_string()))?;

        if room.owner_id() != requester_id {
            return Err(AppError::Forbidden);
        }
        if target_id == requester_id {
            return Err(AppError::PeerNotFound);
        }

        let removed = room.peers().write().await.remove(&target_id);
        match removed {
            Some(peer) => {
                tracing::info!(peer_id = %target_id, "Peer rejected by room owner");
                Ok(peer.sender)
            }
            None => Err(AppError::PeerNotFound),
        }
    }

    /// Whether `peer_id` is currently a member of `room_id`.
    pub async fn is_member(&self, room_id: &str, peer_id: Uuid) -> bool {
        match self.store.get(room_id).await {
            Some(room) => room.peers().read().await.contains_key(&peer_id),
            None => false,
        }
    }

    /// Get room info for existence check.
    pub async fn get_room_info(&self, room_id: &str) -> Option<(bool, bool)> {
        if !is_valid_room_id(room_id) {
            return None;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::InMemoryRoomStore;
    use tokio::sync::mpsc;

    fn service() -> RoomService {
        RoomService::new(
            Arc::new(InMemoryRoomStore::new()),
            Arc::new(Config::from_env()),
        )
    }

    fn sender() -> PeerSender {
        mpsc::unbounded_channel().0
    }

    #[tokio::test]
    async fn owner_can_reject_joined_peer() {
        let svc = service();
        let (room_id, owner) = svc.create_room(None, sender()).await.unwrap();
        let (guest, count) = svc.join_room(&room_id, None, sender()).await.unwrap();
        assert_eq!(count, 2);

        assert!(svc.reject_peer(&room_id, owner, guest).await.is_ok());
        assert!(!svc.is_member(&room_id, guest).await);
        assert!(svc.is_member(&room_id, owner).await);

        // Slot is free again for the intended receiver
        assert!(svc.join_room(&room_id, None, sender()).await.is_ok());
    }

    #[tokio::test]
    async fn non_owner_cannot_reject() {
        let svc = service();
        let (room_id, owner) = svc.create_room(None, sender()).await.unwrap();
        let (guest, _) = svc.join_room(&room_id, None, sender()).await.unwrap();

        assert!(matches!(
            svc.reject_peer(&room_id, guest, owner).await,
            Err(AppError::Forbidden)
        ));
        assert!(svc.is_member(&room_id, owner).await);
    }

    #[tokio::test]
    async fn owner_cannot_reject_self() {
        let svc = service();
        let (room_id, owner) = svc.create_room(None, sender()).await.unwrap();
        assert!(svc.reject_peer(&room_id, owner, owner).await.is_err());
        assert!(svc.is_member(&room_id, owner).await);
    }

    #[tokio::test]
    async fn invalid_room_ids_are_not_found() {
        let svc = service();
        assert!(svc.get_room_info("../../etc").await.is_none());
        assert!(matches!(
            svc.join_room("hot-latte-42", None, sender()).await,
            Err(AppError::RoomNotFound(_))
        ));
    }

    #[tokio::test]
    async fn password_still_enforced() {
        let svc = service();
        let (room_id, _) = svc
            .create_room(Some("secret".into()), sender())
            .await
            .unwrap();
        assert!(matches!(
            svc.join_room(&room_id, Some("wrong".into()), sender()).await,
            Err(AppError::InvalidPassword)
        ));
        assert!(svc
            .join_room(&room_id, Some("secret".into()), sender())
            .await
            .is_ok());
    }
}
