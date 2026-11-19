use crate::models::Room;
use crate::store::RoomStore;
use async_trait::async_trait;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

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
    async fn insert_if_absent(&self, room: Room) -> bool {
        let mut rooms = self.rooms.write().await;
        match rooms.entry(room.id().to_string()) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(room);
                true
            }
        }
    }

    async fn get(&self, id: &str) -> Option<Room> {
        let rooms = self.rooms.read().await;
        rooms.get(id).cloned()
    }

    async fn remove(&self, id: &str) {
        let mut rooms = self.rooms.write().await;
        rooms.remove(id);
    }

    async fn get_stale_room_ids(&self, max_age: Duration) -> Vec<String> {
        let rooms = self.rooms.read().await;
        let now = Instant::now();
        let mut stale = Vec::new();

        for (id, room) in rooms.iter() {
            let last_activity = *room.last_activity().read().await;
            if now.duration_since(last_activity) > max_age {
                stale.push(id.clone());
            }
        }

        stale
    }

    async fn count(&self) -> usize {
        self.rooms.read().await.len()
    }
}