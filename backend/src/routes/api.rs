use crate::handlers::ws_handler::check_room_handler;
use crate::middleware::rate_limit::{RateLimits, limit_http};
use crate::services::RoomService;
use std::sync::Arc;
use warp::Filter;

pub fn api_routes(
    room_service: Arc<RoomService>,
    limits: Arc<RateLimits>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    // ICE/TURN credentials are deliberately not exposed over HTTP: they are
    // only sent over the WebSocket to peers that have joined a room.
    check_rooms_route(room_service, limits).or(health_route())
}

/// GET /api/rooms/:id
fn check_rooms_route(
    room_service: Arc<RoomService>,
    limits: Arc<RateLimits>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path!("api" / "rooms" / String)
        .and(warp::get())
        .and(limit_http(limits))
        .and(warp::any().map(move || room_service.clone()))
        .and_then(|room_id, room_svc| check_room_handler(room_id, room_svc))
}

/// GET /health
fn health_route() -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path!("health")
        .and(warp::get())
        .map(|| warp::reply::json(&serde_json::json!({"status": "healthy"})))
}
