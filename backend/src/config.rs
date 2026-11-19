use std::env;
use std::time::Duration;

/// The secret used by docker-compose.dev.yml. It's public, so it must never be
/// used in production.
pub const DEV_TURN_SECRET: &str = "development_secret_key";

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

    // Rate Limiting (all per client IP, or per IPv6 /64)
    /// HTTP API requests per minute
    pub rate_limit_requests_per_minute: u32,
    /// New WebSocket connections per minute
    pub ws_connections_per_minute: u32,
    /// WebSocket connections open at the same time
    pub ws_max_connections_per_ip: usize,
    /// `CreateRoom` messages per minute
    pub rooms_per_minute: u32,
    /// `JoinRoom` messages per minute (password guesses across all rooms)
    pub joins_per_minute: u32,
    /// Sustained messages per second on one WebSocket connection
    pub ws_messages_per_sec: u32,
    /// Burst of messages allowed on one WebSocket (ICE candidates arrive in bursts)
    pub ws_message_burst: u32,
    /// Number of reverse proxies in front of the server that append to
    /// `X-Forwarded-For`. 0 = use the TCP peer address and ignore the header.
    pub trusted_proxy_hops: usize,
    /// Hard cap on rooms in memory, across all clients
    pub max_rooms: usize,

    // Password protection
    /// Wrong password attempts allowed per room before it is closed.
    pub room_max_password_attempts: u32,
    /// Maximum accepted password length in bytes.
    pub password_max_len: usize,
    /// Maximum number of Argon2 hash/verify operations running at once.
    /// Each uses ~19 MiB of memory and a full CPU core.
    pub argon2_max_concurrent: usize,
}

/// Read a positive number from the environment, falling back to `default` if
/// the variable is missing, unparsable or zero.
fn env_or<T>(name: &str, default: T) -> T
where
    T: std::str::FromStr + PartialEq + Default,
{
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v != T::default())
        .unwrap_or(default)
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
            rate_limit_requests_per_minute: env_or("RATE_LIMIT_RPM", 60),
            ws_connections_per_minute: env_or("WS_CONNECTIONS_PER_MINUTE", 30),
            ws_max_connections_per_ip: env_or("WS_MAX_CONNECTIONS_PER_IP", 20),
            rooms_per_minute: env_or("ROOMS_PER_MINUTE", 10),
            joins_per_minute: env_or("JOINS_PER_MINUTE", 20),
            ws_messages_per_sec: env_or("WS_MESSAGES_PER_SEC", 20),
            ws_message_burst: env_or("WS_MESSAGE_BURST", 100),
            trusted_proxy_hops: env::var("TRUSTED_PROXY_HOPS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            max_rooms: env_or("MAX_ROOMS", 10_000),

            // Password protection
            room_max_password_attempts: env::var("ROOM_MAX_PASSWORD_ATTEMPTS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&v| v > 0)
                .unwrap_or(5),
            password_max_len: env::var("PASSWORD_MAX_LEN")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&v| v > 0)
                .unwrap_or(256),
            argon2_max_concurrent: env::var("ARGON2_MAX_CONCURRENT")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|&v| v > 0)
                .unwrap_or_else(|| {
                    std::thread::available_parallelism()
                        .map(|n| n.get().min(8))
                        .unwrap_or(2)
                }),
        }
    }

    /// Log a warning for TURN secrets that are known, weak, or unsafe to pass
    /// to coturn. Returns the warnings so they can be tested.
    pub fn turn_secret_warnings(&self) -> Vec<&'static str> {
        let Some(secret) = self.turn_secret.as_deref() else {
            return vec![];
        };
        let mut warnings = vec![];
        if secret == DEV_TURN_SECRET {
            warnings.push(
                "TURN_SECRET is the public development default; anyone can mint TURN credentials. Set a random secret (openssl rand -hex 32)",
            );
        } else if secret.len() < 32 {
            warnings.push("TURN_SECRET is shorter than 32 characters; use openssl rand -hex 32");
        }
        // Characters that are inert inside the coturn entrypoint's `eval "echo $arg"`
        // (covers hex and base64 secrets).
        let shell_safe = |b: u8| b.is_ascii_alphanumeric() || b"_-.+/=".contains(&b);
        if !secret.bytes().all(shell_safe) {
            warnings.push(
                "TURN_SECRET contains shell metacharacters; the coturn image entrypoint evals its arguments, so this may break or execute in coturn",
            );
        }
        warnings
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

#[cfg(test)]
mod tests {
    use super::*;

    fn with_secret(secret: Option<&str>) -> Config {
        let mut c = Config::from_env();
        c.turn_secret = secret.map(str::to_string);
        c
    }

    #[test]
    fn secret_warnings() {
        assert!(with_secret(None).turn_secret_warnings().is_empty());
        assert!(
            with_secret(Some(&"a1".repeat(32)))
                .turn_secret_warnings()
                .is_empty()
        );
        assert_eq!(with_secret(Some(DEV_TURN_SECRET)).turn_secret_warnings().len(), 1);
        assert_eq!(with_secret(Some("short")).turn_secret_warnings().len(), 1);
        assert_eq!(
            with_secret(Some(&format!("{}$(id)", "a".repeat(32))))
                .turn_secret_warnings()
                .len(),
            1
        );
    }
}
