use serde::{Deserialize, Serialize};
use crate::ice::IceServer;
use uuid::Uuid;

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
    /// Sent by the room owner to refuse a peer that joined. The peer is removed
    /// from the room and its connection is closed.
    RejectPeer {
        peer_id: Uuid,
    },
    Ping, // Add Ping/Pong for heartbeat in the future
}

/// Messages sent FROM server TO client
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ServerMessage {
    RoomCreated { room_id: String },
    /// Sent to a peer that was admitted to a room. Carries the ICE servers
    /// (including short-lived TURN credentials) for that peer only.
    RoomJoined { ice_servers: Vec<IceServer> },
    /// Sent to existing peers when someone joins. The owner uses `peer_id` to
    /// approve (start the transfer) or reject (send `RejectPeer`) the newcomer.
    /// `ice_servers` carries fresh ICE/TURN credentials for the recipient, so
    /// the owner only gets TURN access once someone has actually joined.
    PeerJoined {
        peer_id: Uuid,
        peer_count: usize,
        ice_servers: Vec<IceServer>,
    },
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
    pub const REJECTED: &str = "REJECTED";
    pub const FORBIDDEN: &str = "FORBIDDEN";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
    pub const TOO_MANY_ATTEMPTS: &str = "TOO_MANY_ATTEMPTS";
    pub const PASSWORD_TOO_LONG: &str = "PASSWORD_TOO_LONG";
    pub const SERVER_BUSY: &str = "SERVER_BUSY";
}
