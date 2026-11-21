//! Per-client rate limiting.
//!
//! Clients are identified by [`ClientKey`]: the IPv4 address, or the /64
//! prefix for IPv6 (a single host usually controls a whole /64, so keying on
//! the full address would let it rotate addresses for free).
//!
//! Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` so the real client address
//! is taken from `X-Forwarded-For` instead of the proxy's address.

use crate::config::Config;
use crate::server::PeerAddr;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use warp::Filter;

/// Identity used for rate limiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientKey(IpAddr);

impl ClientKey {
    pub fn from_ip(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(v4) => ClientKey(IpAddr::V4(v4)),
            IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return ClientKey(IpAddr::V4(v4));
                }
                let mut seg = v6.segments();
                seg[4..].fill(0); // keep the /64 network prefix
                ClientKey(IpAddr::V6(Ipv6Addr::from(seg)))
            }
        }
    }
}

impl std::fmt::Display for ClientKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Work out the client's address.
///
/// With `trusted_hops == 0` the TCP peer address is used and `X-Forwarded-For`
/// is ignored (it is trivially spoofable). With `n` trusted proxies in front of
/// the server, each appends the address it received the request from, so the
/// real client is the `n`th entry from the right.
pub fn resolve_client_ip(
    remote: Option<SocketAddr>,
    forwarded_for: Option<&str>,
    trusted_hops: usize,
) -> IpAddr {
    let fallback = remote
        .map(|a| a.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));

    if trusted_hops == 0 {
        return fallback;
    }

    let Some(xff) = forwarded_for else {
        return fallback;
    };
    let entries: Vec<&str> = xff.split(',').map(str::trim).collect();
    let candidate = if entries.len() >= trusted_hops {
        entries[entries.len() - trusted_hops]
    } else {
        entries[0]
    };
    candidate.parse().unwrap_or(fallback)
}

/// Warp filter extracting the [`ClientKey`] for a request.
pub fn client_key(
    trusted_hops: usize,
) -> impl Filter<Extract = (ClientKey,), Error = warp::Rejection> + Clone {
    warp::ext::optional::<PeerAddr>()
        .and(warp::header::optional::<String>("x-forwarded-for"))
        .map(move |peer: Option<PeerAddr>, xff: Option<String>| {
            let remote = peer.map(|p| p.0);
            ClientKey::from_ip(resolve_client_ip(remote, xff.as_deref(), trusted_hops))
        })
}

/// A token bucket: holds up to `capacity` tokens, refilled continuously at
/// `refill_per_sec`. Each allowed action takes one token.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    refill_per_sec: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self::new_at(capacity, refill_per_sec, Instant::now())
    }

    fn new_at(capacity: u32, refill_per_sec: f64, now: Instant) -> Self {
        Self {
            capacity: capacity as f64,
            refill_per_sec,
            tokens: capacity as f64,
            last: now,
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last = now;
    }

    pub fn try_take_at(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    pub fn try_take(&mut self) -> bool {
        self.try_take_at(Instant::now())
    }

    fn is_full_at(&mut self, now: Instant) -> bool {
        self.refill(now);
        self.tokens >= self.capacity
    }
}

/// Token buckets keyed by client, `per_minute` actions per minute each.
pub struct KeyedLimiter {
    per_minute: u32,
    buckets: Mutex<HashMap<ClientKey, TokenBucket>>,
}

impl KeyedLimiter {
    pub fn per_minute(per_minute: u32) -> Self {
        Self {
            per_minute: per_minute.max(1),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, key: ClientKey) -> bool {
        self.check_at(key, Instant::now())
    }

    fn check_at(&self, key: ClientKey, now: Instant) -> bool {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        buckets
            .entry(key)
            .or_insert_with(|| {
                TokenBucket::new_at(self.per_minute, self.per_minute as f64 / 60.0, now)
            })
            .try_take_at(now)
    }

    /// Drop buckets that have fully refilled; they behave exactly like a new
    /// bucket, so forgetting them is free and keeps memory bounded.
    fn prune_at(&self, now: Instant) {
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        buckets.retain(|_, b| !b.is_full_at(now));
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Counts open WebSocket connections per client.
pub struct ConnectionTracker {
    max_per_client: usize,
    open: Mutex<HashMap<ClientKey, usize>>,
}

/// Releases a connection slot when dropped.
pub struct ConnectionGuard {
    tracker: Arc<ConnectionTracker>,
    key: ClientKey,
}

impl ConnectionTracker {
    pub fn new(max_per_client: usize) -> Self {
        Self {
            max_per_client: max_per_client.max(1),
            open: Mutex::new(HashMap::new()),
        }
    }

    /// Reserve a connection slot, or `None` if the client is at its limit.
    pub fn try_acquire(self: &Arc<Self>, key: ClientKey) -> Option<ConnectionGuard> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(key).or_insert(0);
        if *count >= self.max_per_client {
            return None;
        }
        *count += 1;
        Some(ConnectionGuard {
            tracker: self.clone(),
            key,
        })
    }

    #[cfg(test)]
    fn open_for(&self, key: ClientKey) -> usize {
        let open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        open.get(&key).copied().unwrap_or(0)
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        let mut open = self.tracker.open.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.key);
            }
        }
    }
}

/// All rate limits used by the server.
pub struct RateLimits {
    pub trusted_proxy_hops: usize,
    /// HTTP API requests (e.g. `GET /api/rooms/:id`)
    pub http: KeyedLimiter,
    /// New WebSocket connections
    pub ws_connect: KeyedLimiter,
    /// Concurrently open WebSocket connections
    pub ws_open: Arc<ConnectionTracker>,
    /// `CreateRoom` messages (each may run Argon2 and allocates a room)
    pub create_room: KeyedLimiter,
    /// `JoinRoom` messages (password guesses across all rooms)
    pub join_room: KeyedLimiter,
    /// Messages per second allowed on one WebSocket, and the burst size
    pub ws_messages_per_sec: u32,
    pub ws_message_burst: u32,
    /// Limits rate-limit *log lines* to one per client per minute, so a flood
    /// can't also flood the logs.
    log_throttle: KeyedLimiter,
}

impl RateLimits {
    pub fn from_config(config: &Config) -> Self {
        Self {
            trusted_proxy_hops: config.trusted_proxy_hops,
            http: KeyedLimiter::per_minute(config.rate_limit_requests_per_minute),
            ws_connect: KeyedLimiter::per_minute(config.ws_connections_per_minute),
            ws_open: Arc::new(ConnectionTracker::new(config.ws_max_connections_per_ip)),
            create_room: KeyedLimiter::per_minute(config.rooms_per_minute),
            join_room: KeyedLimiter::per_minute(config.joins_per_minute),
            ws_messages_per_sec: config.ws_messages_per_sec.max(1),
            ws_message_burst: config.ws_message_burst.max(1),
            log_throttle: KeyedLimiter::per_minute(1),
        }
    }

    /// Log that `key` hit a limit, at most once per minute per client.
    pub fn log_limited(&self, key: ClientKey, what: &'static str) {
        if self.log_throttle.check(key) {
            tracing::warn!(client = %key, limit = what, "Rate limit exceeded (further hits from this client suppressed for 1 min)");
        }
    }

    /// A fresh per-connection message bucket.
    pub fn ws_message_bucket(&self) -> TokenBucket {
        TokenBucket::new(self.ws_message_burst, self.ws_messages_per_sec as f64)
    }

    /// Forget idle clients. Called periodically.
    pub fn prune(&self) {
        let now = Instant::now();
        for limiter in [
            &self.http,
            &self.ws_connect,
            &self.create_room,
            &self.join_room,
            &self.log_throttle,
        ] {
            limiter.prune_at(now);
        }
    }

    /// How often `prune` should run.
    pub const PRUNE_INTERVAL: Duration = Duration::from_secs(60);
}

/// Rejection used when an HTTP request is over its limit.
#[derive(Debug)]
pub struct RateLimited;
impl warp::reject::Reject for RateLimited {}

/// Filter that rejects with [`RateLimited`] when `limiter` is exhausted for the client.
pub fn limit_http(
    limits: Arc<RateLimits>,
) -> impl Filter<Extract = (), Error = warp::Rejection> + Clone {
    client_key(limits.trusted_proxy_hops)
        .and_then(move |key: ClientKey| {
            let limits = limits.clone();
            async move {
                if limits.http.check(key) {
                    Ok(())
                } else {
                    limits.log_limited(key, "http");
                    Err(warp::reject::custom(RateLimited))
                }
            }
        })
        .untuple_one()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> ClientKey {
        ClientKey::from_ip(s.parse().unwrap())
    }

    #[test]
    fn bucket_allows_burst_then_refills() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new_at(3, 1.0, t0);
        assert!(b.try_take_at(t0));
        assert!(b.try_take_at(t0));
        assert!(b.try_take_at(t0));
        assert!(!b.try_take_at(t0));
        assert!(!b.try_take_at(t0 + Duration::from_millis(500)));
        assert!(b.try_take_at(t0 + Duration::from_millis(1100)));
        // Never refills past capacity
        let later = t0 + Duration::from_secs(100);
        for _ in 0..3 {
            assert!(b.try_take_at(later));
        }
        assert!(!b.try_take_at(later));
    }

    #[test]
    fn keyed_limiter_is_per_client_and_prunes() {
        let t0 = Instant::now();
        let l = KeyedLimiter::per_minute(2);
        assert!(l.check_at(key("1.1.1.1"), t0));
        assert!(l.check_at(key("1.1.1.1"), t0));
        assert!(!l.check_at(key("1.1.1.1"), t0));
        assert!(l.check_at(key("2.2.2.2"), t0)); // other clients unaffected
        assert_eq!(l.len(), 2);

        l.prune_at(t0 + Duration::from_secs(1)); // still draining
        assert_eq!(l.len(), 2);
        l.prune_at(t0 + Duration::from_secs(61)); // both full again
        assert_eq!(l.len(), 0);
    }

    #[test]
    fn ipv6_keyed_by_slash_64() {
        assert_eq!(key("2001:db8:1:2:aaaa::1"), key("2001:db8:1:2:bbbb::9"));
        assert_ne!(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"));
        assert_eq!(key("::ffff:1.2.3.4"), key("1.2.3.4"));
    }

    #[test]
    fn client_ip_resolution() {
        let remote: Option<SocketAddr> = Some("10.0.0.1:5000".parse().unwrap());
        let xff = Some("6.6.6.6, 1.2.3.4, 10.0.0.9");

        // No trusted proxies: X-Forwarded-For is ignored (spoofable)
        assert_eq!(resolve_client_ip(remote, xff, 0), "10.0.0.1".parse::<IpAddr>().unwrap());
        // One proxy (the TCP peer) appended 10.0.0.9 as the client
        assert_eq!(resolve_client_ip(remote, xff, 1), "10.0.0.9".parse::<IpAddr>().unwrap());
        // Two proxies: client is second from the right; the spoofed left entry is ignored
        assert_eq!(resolve_client_ip(remote, xff, 2), "1.2.3.4".parse::<IpAddr>().unwrap());
        // Missing or garbage header falls back to the TCP peer
        assert_eq!(resolve_client_ip(remote, None, 1), "10.0.0.1".parse::<IpAddr>().unwrap());
        assert_eq!(
            resolve_client_ip(remote, Some("not-an-ip"), 1),
            "10.0.0.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn connection_tracker_limits_and_releases() {
        let tracker = Arc::new(ConnectionTracker::new(2));
        let k = key("1.1.1.1");
        let a = tracker.try_acquire(k).unwrap();
        let _b = tracker.try_acquire(k).unwrap();
        assert!(tracker.try_acquire(k).is_none());
        assert!(tracker.try_acquire(key("2.2.2.2")).is_some());
        drop(a);
        assert_eq!(tracker.open_for(k), 1);
        assert!(tracker.try_acquire(k).is_some());
    }
}
