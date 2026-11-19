mod config;
mod error;
mod handlers;
mod ice;
mod middleware;
mod models;
mod routes;
mod server;
mod services;
mod slug_generator;
mod store;

use crate::config::Config;
use crate::middleware::rate_limit::{RateLimited, RateLimits};
use crate::models::{ServerMessage, error_codes};
use crate::routes::ws::WsState;
use crate::routes::{api_routes, ws_route};
use std::convert::Infallible;
use crate::services::{RoomService, SignalingService};
use crate::store::InMemoryRoomStore;
use dotenvy::dotenv;
use std::sync::Arc;
use std::time::Duration;
use warp::Filter;

#[tokio::main]
async fn main() {
    dotenv().ok();

    // Initialize tracing (structured logging)
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let config = Arc::new(Config::from_env());
    for warning in config.turn_secret_warnings() {
        tracing::warn!("{}", warning);
    }

    // Initialize services
    let store = Arc::new(InMemoryRoomStore::new());
    let room_service = Arc::new(RoomService::new(store.clone(), config.clone()));
    let signaling_service = Arc::new(SignalingService::new(config.clone()));
    let limits = Arc::new(RateLimits::from_config(&config));
    if config.trusted_proxy_hops == 0 {
        tracing::info!(
            "TRUSTED_PROXY_HOPS=0: rate limiting by TCP peer address. Set it if running behind a reverse proxy, or every client will share the proxy's limit."
        );
    }

    // Periodically forget idle rate-limit buckets
    let prune_limits = limits.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(RateLimits::PRUNE_INTERVAL);
        loop {
            interval.tick().await;
            prune_limits.prune();
        }
    });

    // Spawn room cleanup task
    let cleanup_room_service = room_service.clone();
    let cleanup_config = config.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            cleanup_room_service
                .cleanup_stale_rooms(cleanup_config.room_ttl())
                .await;
        }
    });

    let routes = build_routes(WsState {
        config: config.clone(),
        room_service: room_service.clone(),
        signaling_service: signaling_service.clone(),
        limits: limits.clone(),
    });

    tracing::info!(port = config.port, "Server starting");
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], config.port));
    if let Err(e) = server::serve(warp::service(routes), addr).await {
        tracing::error!(error = %e, %addr, "Server failed");
        std::process::exit(1);
    }
}

/// All HTTP and WebSocket routes, with error handling and CORS.
fn build_routes(
    state: WsState,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    let cors = warp::cors()
        .allow_any_origin() // TODO: Restrict in production
        .allow_methods(vec!["GET", "POST", "OPTIONS"]);

    api_routes(state.room_service.clone(), state.limits.clone())
        .or(ws_route(state))
        .recover(handle_rejection)
        // CORS last so error responses (e.g. 429) also carry CORS headers and
        // the browser can read them.
        .with(cors)
}

/// Turn rejections into responses. Rate-limited requests get a 429 with a JSON
/// body in the same shape as WebSocket errors.
async fn handle_rejection(err: warp::Rejection) -> Result<warp::reply::Response, Infallible> {
    use warp::Reply;
    use warp::http::StatusCode;

    let (status, code, message) = if err.find::<RateLimited>().is_some() {
        (
            StatusCode::TOO_MANY_REQUESTS,
            error_codes::RATE_LIMITED,
            "Too many requests. Please wait a minute and try again.",
        )
    } else if err.is_not_found() {
        (StatusCode::NOT_FOUND, error_codes::ROOM_NOT_FOUND, "Not found")
    } else if err.find::<warp::reject::MethodNotAllowed>().is_some() {
        (StatusCode::METHOD_NOT_ALLOWED, error_codes::INVALID_MESSAGE, "Method not allowed")
    } else {
        (StatusCode::BAD_REQUEST, error_codes::INVALID_MESSAGE, "Bad request")
    };

    let body = warp::reply::json(&ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    });
    let mut response = warp::reply::with_status(body, status).into_response();
    if status == StatusCode::TOO_MANY_REQUESTS {
        response.headers_mut().insert(
            warp::http::header::RETRY_AFTER,
            warp::http::HeaderValue::from_static("60"),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::PeerAddr;
    use serde_json::{Value, json};
    use std::net::SocketAddr;

    /// Test app. `trusted_proxy_hops` defaults to 1 so WebSocket tests (whose
    /// builder can't set request extensions) can pick a client IP with
    /// `X-Forwarded-For`; requests without the header use the `PeerAddr`.
    fn app(tweak: impl FnOnce(&mut Config)) -> WsState {
        let mut config = Config::from_env();
        config.trusted_proxy_hops = 1;
        tweak(&mut config);
        let config = Arc::new(config);
        let store = Arc::new(InMemoryRoomStore::new());
        WsState {
            room_service: Arc::new(RoomService::new(store, config.clone())),
            signaling_service: Arc::new(SignalingService::new(config.clone())),
            limits: Arc::new(RateLimits::from_config(&config)),
            config,
        }
    }

    fn peer(ip: &str) -> PeerAddr {
        PeerAddr(SocketAddr::new(ip.parse().unwrap(), 40000))
    }

    async fn recv_json(ws: &mut warp::test::WsClient) -> Value {
        let msg = ws.recv().await.expect("expected a message");
        serde_json::from_str(msg.to_str().expect("text message")).unwrap()
    }

    #[tokio::test]
    async fn http_api_is_rate_limited_per_ip_with_cors() {
        let routes = build_routes(app(|c| c.rate_limit_requests_per_minute = 3));
        let get = |ip: &str| {
            warp::test::request()
                .path("/api/rooms/hot-latte-abc")
                .header("origin", "http://example.test")
                .extension(peer(ip))
                .reply(&routes)
        };

        for _ in 0..3 {
            assert_eq!(get("1.1.1.1").await.status(), 404);
        }
        let limited = get("1.1.1.1").await;
        assert_eq!(limited.status(), 429);
        assert_eq!(limited.headers()["retry-after"], "60");
        assert!(limited.headers().contains_key("access-control-allow-origin"));
        let body: Value = serde_json::from_slice(limited.body()).unwrap();
        assert_eq!(body["code"], "RATE_LIMITED");

        // Another client is unaffected; /health is never limited
        assert_eq!(get("2.2.2.2").await.status(), 404);
        let health = warp::test::request()
            .path("/health")
            .extension(peer("1.1.1.1"))
            .reply(&routes)
            .await;
        assert_eq!(health.status(), 200);
    }

    #[tokio::test]
    async fn forwarded_for_only_trusted_when_configured() {
        // Behind one proxy: clients sharing the proxy address are told apart
        let routes = build_routes(app(|c| {
            c.rate_limit_requests_per_minute = 1;
            c.trusted_proxy_hops = 1;
        }));
        let via_proxy = |client: &str| {
            warp::test::request()
                .path("/api/rooms/x")
                .header("x-forwarded-for", client)
                .extension(peer("10.0.0.1"))
                .reply(&routes)
        };
        assert_eq!(via_proxy("1.1.1.1").await.status(), 404);
        assert_eq!(via_proxy("2.2.2.2").await.status(), 404);
        assert_eq!(via_proxy("1.1.1.1").await.status(), 429);
        // Spoofed extra entries on the left don't help
        assert_eq!(via_proxy("9.9.9.9, 1.1.1.1").await.status(), 429);

        // Without trusted hops the header is ignored entirely
        let routes = build_routes(app(|c| {
            c.rate_limit_requests_per_minute = 1;
            c.trusted_proxy_hops = 0;
        }));
        let direct = |spoof: &str| {
            warp::test::request()
                .path("/api/rooms/x")
                .header("x-forwarded-for", spoof)
                .extension(peer("3.3.3.3"))
                .reply(&routes)
        };
        assert_eq!(direct("4.4.4.4").await.status(), 404);
        assert_eq!(direct("5.5.5.5").await.status(), 429);
    }

    #[tokio::test]
    async fn websocket_connections_limited_per_ip() {
        let routes = build_routes(app(|c| {
            c.ws_max_connections_per_ip = 2;
            c.ws_connections_per_minute = 100;
        }));
        let connect = |ip: &str| {
            warp::test::ws()
                .path("/ws")
                .header("x-forwarded-for", ip)
                .handshake(routes.clone())
        };

        let a = connect("1.1.1.1").await.expect("first connection");
        let _b = connect("1.1.1.1").await.expect("second connection");
        assert!(connect("1.1.1.1").await.is_err(), "third should be refused");
        assert!(connect("2.2.2.2").await.is_ok(), "other IPs unaffected");

        // Closing a connection frees its slot
        drop(a);
        let mut freed = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if connect("1.1.1.1").await.is_ok() {
                freed = true;
                break;
            }
        }
        assert!(freed, "slot was not released after disconnect");
    }

    #[tokio::test]
    async fn websocket_connection_rate_limited() {
        let routes = build_routes(app(|c| c.ws_connections_per_minute = 2));
        for _ in 0..2 {
            let ws = warp::test::ws()
                .path("/ws")
                .header("x-forwarded-for", "1.1.1.1")
                .handshake(routes.clone())
                .await;
            assert!(ws.is_ok());
        }
        let third = warp::test::ws()
            .path("/ws")
            .header("x-forwarded-for", "1.1.1.1")
            .handshake(routes.clone())
            .await;
        assert!(third.is_err());
    }

    #[tokio::test]
    async fn create_room_limited_per_ip_across_connections() {
        let routes = build_routes(app(|c| c.rooms_per_minute = 2));
        for i in 0..3 {
            let mut ws = warp::test::ws()
                .path("/ws")
                .header("x-forwarded-for", "1.1.1.1")
                .handshake(routes.clone())
                .await
                .unwrap();
            ws.send_text(json!({"type": "CreateRoom"}).to_string()).await;
            let reply = recv_json(&mut ws).await;
            if i < 2 {
                assert_eq!(reply["type"], "RoomCreated", "attempt {i}");
            } else {
                assert_eq!(reply["code"], "RATE_LIMITED");
            }
        }
    }

    #[tokio::test]
    async fn join_room_limited_per_ip() {
        let routes = build_routes(app(|c| c.joins_per_minute = 2));
        let mut ws = warp::test::ws()
            .path("/ws")
            .header("x-forwarded-for", "1.1.1.1")
            .handshake(routes.clone())
            .await
            .unwrap();
        let join = json!({"type": "JoinRoom", "room_id": "hot-latte-nope"}).to_string();
        for _ in 0..2 {
            ws.send_text(join.clone()).await;
            assert_eq!(recv_json(&mut ws).await["code"], "ROOM_NOT_FOUND");
        }
        ws.send_text(join).await;
        assert_eq!(recv_json(&mut ws).await["code"], "RATE_LIMITED");
    }

    #[tokio::test]
    async fn message_flood_closes_connection() {
        let routes = build_routes(app(|c| {
            c.ws_message_burst = 5;
            c.ws_messages_per_sec = 1;
        }));
        let mut ws = warp::test::ws()
            .path("/ws")
            .header("x-forwarded-for", "1.1.1.1")
            .handshake(routes.clone())
            .await
            .unwrap();

        for _ in 0..6 {
            ws.send_text(json!({"type": "Ping"}).to_string()).await;
        }
        for _ in 0..5 {
            assert_eq!(recv_json(&mut ws).await["type"], "Pong");
        }
        assert_eq!(recv_json(&mut ws).await["code"], "RATE_LIMITED");
        ws.recv_closed().await.expect("connection should be closed");
    }

    #[tokio::test]
    async fn oversized_messages_rejected() {
        let routes = build_routes(app(|c| c.ws_max_message_size = 1024));
        let mut ws = warp::test::ws()
            .path("/ws")
            .header("x-forwarded-for", "1.1.1.1")
            .handshake(routes.clone())
            .await
            .unwrap();
        let big = json!({"type": "CreateRoom", "password": "x".repeat(4096)}).to_string();
        ws.send_text(big).await;
        ws.recv_closed().await.expect("oversized message should close the connection");
    }

    #[tokio::test]
    async fn global_room_cap() {
        let routes = build_routes(app(|c| c.max_rooms = 1));
        let mut replies = vec![];
        for ip in ["1.1.1.1", "2.2.2.2"] {
            let mut ws = warp::test::ws()
                .path("/ws")
                .header("x-forwarded-for", ip)
                .handshake(routes.clone())
                .await
                .unwrap();
            ws.send_text(json!({"type": "CreateRoom"}).to_string()).await;
            replies.push(recv_json(&mut ws).await);
            std::mem::forget(ws); // keep the first room alive
        }
        assert_eq!(replies[0]["type"], "RoomCreated");
        assert_eq!(replies[1]["code"], "SERVER_BUSY");
    }
}
