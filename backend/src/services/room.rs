use crate::config::Config;
use crate::error::AppError;
use crate::models::{Peer, PeerSender, Room};
use crate::slug_generator::{generate_slug, is_valid_room_id};
use crate::store::RoomStore;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Service for room management operations.
/// Contains ALL business logic related to rooms.
pub struct RoomService {
    store: Arc<dyn RoomStore + Send + Sync>,
    config: Arc<Config>,
    /// Bounds concurrent Argon2 work so password traffic can't exhaust CPU or
    /// memory (each operation uses ~19 MiB).
    argon2_permits: Arc<Semaphore>,
}

impl RoomService {
    pub fn new(store: Arc<dyn RoomStore + Send + Sync>, config: Arc<Config>) -> Self {
        let argon2_permits = Arc::new(Semaphore::new(config.argon2_max_concurrent));
        Self {
            store,
            config,
            argon2_permits,
        }
    }

    /// Create a new room with an optional password, adding the creator as its
    /// owner and first peer. Returns `(room_id, owner_peer_id)`.
    pub async fn create_room(
        &self,
        password: Option<String>,
        owner_sender: PeerSender,
    ) -> Result<(String, Uuid), AppError> {
        // Global backstop against memory exhaustion from many clients.
        // (Approximate under concurrency, which is fine for a safety cap.)
        if self.store.count().await >= self.config.max_rooms {
            tracing::warn!(max_rooms = self.config.max_rooms, "Room limit reached");
            return Err(AppError::TooManyRooms);
        }

        // Hash password if provided
        let password_hash = match password {
            Some(pwd) if !pwd.is_empty() => {
                if pwd.len() > self.config.password_max_len {
                    return Err(AppError::PasswordTooLong(self.config.password_max_len));
                }
                Some(self.hash_password(pwd).await?)
            }
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

    /// Run a CPU-heavy Argon2 operation on the blocking thread pool, limited to
    /// `argon2_max_concurrent` at a time, so it never stalls the async runtime.
    async fn run_argon2<T, F>(&self, work: F) -> Result<T, AppError>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let _permit = self
            .argon2_permits
            .acquire()
            .await
            .map_err(|_| AppError::InternalError("Argon2 limiter closed".to_string()))?;
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|_| AppError::InternalError("Argon2 task failed".to_string()))
    }

    /// Hash a password using Argon2.
    async fn hash_password(&self, password: String) -> Result<String, AppError> {
        self.run_argon2(move || {
            let salt = SaltString::generate(&mut rand::rngs::OsRng);
            Argon2::default()
                .hash_password(password.as_bytes(), &salt)
                .map(|hash| hash.to_string())
                .map_err(|_| AppError::InternalError("Password hashing failed".to_string()))
        })
        .await?
    }

    /// Verify a password against a hash.
    async fn verify_password(&self, password: String, hash: String) -> Result<bool, AppError> {
        self.run_argon2(move || {
            use argon2::{PasswordHash, PasswordVerifier};
            match PasswordHash::new(&hash) {
                Ok(parsed) => Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok(),
                Err(_) => false,
            }
        })
        .await
    }

    /// Check a join attempt's password. Each non-empty attempt reserves one of
    /// the room's `room_max_password_attempts` slots *before* running Argon2,
    /// so concurrent guesses can't exceed the limit; a correct password gives
    /// its slot back.
    async fn check_room_password(
        &self,
        room: &Room,
        hash: &str,
        password: Option<String>,
    ) -> Result<(), AppError> {
        let provided = password.unwrap_or_default();

        // Cheap rejections that can never be the right password: no Argon2,
        // and they don't use up an attempt.
        if provided.is_empty() {
            return Err(AppError::InvalidPassword);
        }
        if provided.len() > self.config.password_max_len {
            return Err(AppError::InvalidPassword);
        }

        let max = self.config.room_max_password_attempts;
        let attempt = room.failed_password_attempts().fetch_add(1, Ordering::SeqCst);
        if attempt >= max {
            // Limit already reached; the room is being closed.
            return Err(AppError::RoomNotFound(room.id().to_string()));
        }

        if self.verify_password(provided, hash.to_string()).await? {
            room.failed_password_attempts().fetch_sub(1, Ordering::SeqCst);
            return Ok(());
        }

        tracing::warn!(attempt = attempt + 1, max, "Invalid password attempt");
        if attempt + 1 >= max {
            Err(AppError::TooManyPasswordAttempts)
        } else {
            Err(AppError::InvalidPassword)
        }
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
            self.check_room_password(&room, hash, password).await?;
        }

        // Check room capacity
        let mut peers = room.peers().write().await;
        if room.is_closed() {
            // Expired or closed after we fetched it.
            return Err(AppError::RoomNotFound(room_id.to_string()));
        }
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

        room.touch().await;

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
            // Back to just the sender waiting: restart the idle clock so a room
            // that just finished a long transfer isn't expired straight away.
            room.touch().await;
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
                room.touch().await;
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

    /// Remove a room immediately (e.g. after too many wrong passwords) and
    /// return it so the caller can notify the peers that were in it.
    pub async fn close_room(&self, room_id: &str) -> Option<Room> {
        let room = self.store.get(room_id).await?;
        let peers = room.peers().write().await;
        room.mark_closed();
        self.store.remove(room_id).await;
        drop(peers);
        tracing::warn!("Room closed after too many wrong password attempts");
        Some(room)
    }

    /// Remove rooms where the sender has waited longer than `max_age` with
    /// nobody joining (called periodically). Rooms with a receiver in them are
    /// never expired: once WebRTC is up, a transfer can run for hours without
    /// any signaling. Returns the removed rooms so the caller can tell their
    /// peers.
    pub async fn cleanup_stale_rooms(&self, max_age: Duration) -> Vec<Room> {
        let stale_room_ids = self.store.get_stale_room_ids(max_age).await;
        let mut expired = Vec::new();

        for room_id in stale_room_ids {
            let Some(room) = self.store.get(&room_id).await else {
                continue;
            };
            // Same lock order as join_room (peers, then last_activity), and
            // re-checked under the lock so a join that just happened wins.
            let peers = room.peers().write().await;
            let idle = room.last_activity().read().await.elapsed();
            if peers.len() > 1 || idle <= max_age {
                continue;
            }
            room.mark_closed();
            self.store.remove(&room_id).await;
            drop(peers);

            tracing::info!(room_id = %room_id, "Idle room expired");
            expired.push(room);
        }

        expired
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
        service_with(|_| {})
    }

    fn service_with(tweak: impl FnOnce(&mut Config)) -> RoomService {
        let mut config = Config::from_env();
        tweak(&mut config);
        RoomService::new(Arc::new(InMemoryRoomStore::new()), Arc::new(config))
    }

    fn sender() -> PeerSender {
        mpsc::unbounded_channel().0
    }

    /// Pretend the room has been idle for `secs`.
    async fn age_room(svc: &RoomService, room_id: &str, secs: u64) {
        let room = svc.get_room(room_id).await.unwrap();
        *room.last_activity().write().await = std::time::Instant::now() - Duration::from_secs(secs);
    }

    const TTL: Duration = Duration::from_secs(3600);

    #[tokio::test]
    async fn idle_waiting_room_expires() {
        let svc = service();
        let (room_id, _) = svc.create_room(None, sender()).await.unwrap();

        age_room(&svc, &room_id, 60).await;
        assert!(svc.cleanup_stale_rooms(TTL).await.is_empty());

        age_room(&svc, &room_id, 3601).await;
        let expired = svc.cleanup_stale_rooms(TTL).await;
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].id(), room_id);
        assert!(svc.get_room(&room_id).await.is_none());
    }

    #[tokio::test]
    async fn room_with_receiver_never_expires() {
        let svc = service();
        let (room_id, _) = svc.create_room(None, sender()).await.unwrap();
        svc.join_room(&room_id, None, sender()).await.unwrap();

        // A transfer can run for hours with no signaling at all.
        age_room(&svc, &room_id, 10 * 3600).await;
        assert!(svc.cleanup_stale_rooms(TTL).await.is_empty());
        assert!(svc.get_room(&room_id).await.is_some());
    }

    #[tokio::test]
    async fn receiver_leaving_restarts_idle_clock() {
        let svc = service();
        let (room_id, _) = svc.create_room(None, sender()).await.unwrap();
        let (guest, _) = svc.join_room(&room_id, None, sender()).await.unwrap();
        age_room(&svc, &room_id, 10 * 3600).await;

        svc.leave_room(&room_id, guest).await.unwrap();
        assert!(svc.cleanup_stale_rooms(TTL).await.is_empty());
    }

    #[tokio::test]
    async fn cannot_join_room_closed_after_lookup() {
        let svc = service();
        let (room_id, _) = svc.create_room(None, sender()).await.unwrap();
        // Simulate a join that fetched the room just before it was closed.
        let room = svc.get_room(&room_id).await.unwrap();
        age_room(&svc, &room_id, 3601).await;
        assert_eq!(svc.cleanup_stale_rooms(TTL).await.len(), 1);
        assert!(room.is_closed());
        svc.store.insert_if_absent(room).await;

        assert!(matches!(
            svc.join_room(&room_id, None, sender()).await,
            Err(AppError::RoomNotFound(_))
        ));
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

    async fn locked_room(max: u32) -> (RoomService, String) {
        let svc = service_with(|c| {
            c.room_max_password_attempts = max;
            c.room_max_peers = 10;
        });
        let (room_id, _) = svc
            .create_room(Some("correct horse".into()), sender())
            .await
            .unwrap();
        (svc, room_id)
    }

    #[tokio::test]
    async fn wrong_passwords_close_room_after_limit() {
        let (svc, room_id) = locked_room(3).await;
        for _ in 0..2 {
            assert!(matches!(
                svc.join_room(&room_id, Some("guess".into()), sender()).await,
                Err(AppError::InvalidPassword)
            ));
        }
        assert!(matches!(
            svc.join_room(&room_id, Some("guess".into()), sender()).await,
            Err(AppError::TooManyPasswordAttempts)
        ));
        // Even the right password no longer works once the limit is hit
        assert!(matches!(
            svc.join_room(&room_id, Some("correct horse".into()), sender()).await,
            Err(AppError::RoomNotFound(_))
        ));
        assert!(svc.close_room(&room_id).await.is_some());
        assert!(svc.get_room_info(&room_id).await.is_none());
    }

    #[tokio::test]
    async fn correct_and_empty_passwords_do_not_use_attempts() {
        let (svc, room_id) = locked_room(2).await;
        for _ in 0..5 {
            assert!(svc.join_room(&room_id, None, sender()).await.is_err());
            assert!(svc.join_room(&room_id, Some(String::new()), sender()).await.is_err());
            assert!(svc.join_room(&room_id, Some("correct horse".into()), sender()).await.is_ok());
        }
        // Still one wrong guess allowed before the limit
        assert!(matches!(
            svc.join_room(&room_id, Some("guess".into()), sender()).await,
            Err(AppError::InvalidPassword)
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_guesses_cannot_exceed_limit() {
        let (svc, room_id) = locked_room(5).await;
        let svc = Arc::new(svc);
        let handles: Vec<_> = (0..20)
            .map(|i| {
                let svc = svc.clone();
                let room_id = room_id.clone();
                tokio::spawn(async move {
                    svc.join_room(&room_id, Some(format!("guess{i}")), sender()).await
                })
            })
            .collect();

        let (mut invalid, mut too_many, mut gone) = (0, 0, 0);
        for h in handles {
            match h.await.unwrap() {
                Err(AppError::InvalidPassword) => invalid += 1,
                Err(AppError::TooManyPasswordAttempts) => too_many += 1,
                Err(AppError::RoomNotFound(_)) => gone += 1,
                other => panic!("unexpected result: {:?}", other.map(|_| ())),
            }
        }
        // Exactly 5 guesses were actually checked
        assert_eq!((invalid, too_many, gone), (4, 1, 15));
    }

    #[tokio::test]
    async fn overlong_passwords_rejected() {
        let svc = service_with(|c| c.password_max_len = 16);
        assert!(matches!(
            svc.create_room(Some("x".repeat(17)), sender()).await,
            Err(AppError::PasswordTooLong(16))
        ));
        let (room_id, _) = svc.create_room(Some("x".repeat(16)), sender()).await.unwrap();
        // Too-long guesses are rejected without using an attempt or running Argon2
        for _ in 0..10 {
            assert!(matches!(
                svc.join_room(&room_id, Some("y".repeat(10_000)), sender()).await,
                Err(AppError::InvalidPassword)
            ));
        }
        assert!(svc.join_room(&room_id, Some("x".repeat(16)), sender()).await.is_ok());
    }
}
