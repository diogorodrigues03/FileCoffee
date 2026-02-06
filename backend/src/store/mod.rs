pub mod memory;

use crate::models::Room;
use async_trait::async_trait;
use std::time::Duration;

/// Trait for room storage operations.
/// Implementations can use memory, Redis, PostgreSQL, etc.
#[async_trait]
pub trait RoomStore: Send + Sync {
    /// Insert a new room
    async fn insert(&self, room: Room);

    /// Get a room by ID
    async fn get(&self, id: &str) -> Option<Room>;

    /// Remove a room by ID
    async fn remove(&self, id: &str);

    /// Get IDs of rooms that haven't had activity for `max_age`
    async fn get_stale_room_ids(&self, max_age: Duration) -> Vec<String>;

    /// Get count of active rooms (for metrics)
    async fn count(&self) -> usize;
}

pub use memory::InMemoryRoomStore;