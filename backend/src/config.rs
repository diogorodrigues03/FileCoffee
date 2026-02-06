use std::env;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    // Server Settings
    pub port: u16,
    pub allowed_origins: Vec<String>,

    // Room Settings
    pub room_ttl_seconds: u64,
    pub room_max_peers: usize,
    pub slug_max_attempts: u8,

    // WebSocket Settings
    pub ws_heartbeat_interval_secs: u64,
    pub ws_heartbeat_timeout_secs: u64,
    pub ws_max_message_size: usize,

    // TURN Settings
    pub turn_url: Option<String>,
    pub turn_secret: Option<String>,
    pub turn_realm: String,
    pub turn_credential_ttl_secs: u64,

    // Rate Limiting
    pub rate_limit_requests_per_minute: u32,
}

impl Config {
    // Load configuration from environment variables with defaults

    pub fn from_env() -> Self {
        Self {
            // Server
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3030),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .map(|s| s.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_else(|_| vec!["*".to_string()]),

            // Room
            room_ttl_seconds: env::var("ROOM_TTL_SECONDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3600),
            room_max_peers: env::var("ROOM_MAX_PEERS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2),
            slug_max_attempts: env::var("SLUG_MAX_ATTEMPTS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),

            // WebSocket
            ws_heartbeat_interval_secs: env::var("WS_HEARTBEAT_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            ws_heartbeat_timeout_secs: env::var("WS_HEARTBEAT_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            ws_max_message_size: env::var("WS_MAX_MESSAGE_SIZE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(64 * 1024),

            // TURN
            turn_url: env::var("TURN_URL").ok(),
            turn_secret: env::var("TURN_SECRET").ok(),
            turn_realm: env::var("TURN_REALM").unwrap_or_else(|_| "localhost".to_string()),
            turn_credential_ttl_secs: env::var("TURN_CREDENTIAL_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(7200),

            // Rate limiting
            rate_limit_requests_per_minute: env::var("RATE_LIMIT_RPM")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
        }
    }

    /// Get room TTL as a Duration
    pub fn room_ttl(&self) -> Duration {
        Duration::from_secs(self.room_ttl_seconds)
    }

    /// Get heartbeat interval as a Duration
    pub fn heartbeat_interval(&self) -> Duration {
        Duration::from_secs(self.ws_heartbeat_interval_secs)
    }

    /// Get TURN credential TTL as a Duration
    pub fn turn_credential_ttl(&self) -> Duration {
        Duration::from_secs(self.turn_credential_ttl_secs)
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::from_env()
    }
}
