use serde::{Deserialize, Serialize};

/// Messages sent FROM client TO server
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ClientMessage {
    CreateRoom {
        password: Option<String>,
    },
    JoinRoom {
        room_id: String,
        password: Option<String>,
    },
    Signal {
        data: serde_json::Value,
    },
    Ping, // Add Ping/Pong for heartbeat in the future
}

/// Messages sent FROM server TO client
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ServerMessage {
    RoomCreated { room_id: String },
    RoomJoined,
    PeerJoined { peer_count: usize }, // we are letting the client know how many peers are connected
    PeerLeft { peer_count: usize },
    Signal { data: serde_json::Value },
    Error { code: String, message: String },
    RoomExists { exists: bool, has_password: bool },
    Pong, // Add Ping/Pong for heartbeat in the future
}

/// Error codes for structured error handling
pub mod error_codes {
    pub const ROOM_NOT_FOUND: &str = "ROOM_NOT_FOUND";
    pub const INVALID_PASSWORD: &str = "INVALID_PASSWORD";
    pub const ROOM_FULL: &str = "ROOM_FULL";
    pub const NOT_IN_ROOM: &str = "NOT_IN_ROOM";
    pub const INVALID_MESSAGE: &str = "INVALID_MESSAGE";
    pub const RATE_LIMITED: &str = "RATE_LIMITED";
}
