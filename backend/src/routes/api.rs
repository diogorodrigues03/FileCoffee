use crate::handlers::ws_handler::check_room_handler;
use crate::ice;
use crate::services::RoomService;
use std::sync::Arc;
use warp::Filter;

pub fn api_routes(
    room_service: Arc<RoomService>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    check_rooms_route(room_service)
        .or(ice_servers_route())
        .or(health_route())
}

/// GET /api/rooms/:id
fn check_rooms_route(
    room_service: Arc<RoomService>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path!("api" / "rooms" / String)
        .and(warp::get())
        .and(warp::any().map(move || room_service.clone()))
        .and_then(|room_id, room_svc| check_room_handler(room_id, room_svc))
}

/// GET /api/ice-servers
fn ice_servers_route() -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path!("api" / "ice-servers").and(warp::get()).map(|| {
        let config = ice::get_ice_servers();
        warp::reply::json(&config)
    })
}

/// GET /health
fn health_route() -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    warp::path!("health")
        .and(warp::get())
        .map(|| warp::reply::json(&serde_json::json!({"status": "healthy"})))
}
