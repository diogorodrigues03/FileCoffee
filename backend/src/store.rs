use crate::room::Room;
use std::collections::HashMap;
use tokio::sync::RwLock;
use async_trait::async_trait;

#[async_trait]
pub trait RoomStore: Send + Sync {
    async fn insert(&self, room: Room);
    async fn get(&self, id: &str) -> Option<Room>;
    async fn remove(&self, id: &str);
}

pub struct InMemoryRoomStore {
    rooms: RwLock<HashMap<String, Room>>,
}

impl InMemoryRoomStore {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryRoomStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RoomStore for InMemoryRoomStore {
    async fn insert(&self, room: Room) {
        let mut rooms = self.rooms.write().await;
        rooms.insert(room.id().to_string(), room);
    }

    async fn get(&self, id: &str) -> Option<Room> {
        let rooms = self.rooms.read().await;
        rooms.get(id).cloned()
    }

    async fn remove(&self, id: &str) {
        let mut rooms = self.rooms.write().await;
        rooms.remove(id);
    }
}
