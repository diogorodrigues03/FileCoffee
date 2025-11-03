use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{RwLock, mpsc};
use warp::ws::Message;

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ClientMessage {
    CreateRoom,
    JoinRoom { room_id: String },
    Signal { data: serde_json::Value }, // WebRTC signaling data
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ServerMessage {
    RoomCreated { room_id: String },
    RoomJoined,
    PeerJoined,
    Signal { data: serde_json::Value },
    Error { message: String },
}

//This will store all active rooms
// Arc = Atomic Reference Counted for thread-safe shared ownership
// RwLock = Allows multiple readers OR on writer (async-safe)
pub type Rooms = Arc<RwLock<HashMap<String, Room>>>;
// Type alias for a sender that can send WebSocket messages
pub type PeerSender = mpsc::UnboundedSender<Message>;

#[derive(Clone)]
pub struct Room {
    pub id: String,
    pub peers: Arc<RwLock<Vec<PeerSender>>>,
}
