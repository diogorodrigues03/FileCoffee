mod config;
mod error;
mod handlers;
mod ice;
mod models;
mod routes;
mod services;
mod slug_generator;
mod store;

use crate::config::Config;
use crate::routes::{api_routes, ws_route};
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

    // Initialize services
    let store = Arc::new(InMemoryRoomStore::new());
    let room_service = Arc::new(RoomService::new(store.clone(), config.clone()));
    let signaling_service = Arc::new(SignalingService::new());

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

    // Setup CORS
    let cors = warp::cors()
        .allow_any_origin() // TODO: Restrict in production
        .allow_methods(vec!["GET", "POST", "OPTIONS"]);

    // Combine routes from modules
    let routes = api_routes(room_service.clone())
        .or(ws_route(room_service.clone(), signaling_service.clone()))
        .with(cors);

    tracing::info!(port = config.port, "Server starting");
    warp::serve(routes).run(([0, 0, 0, 0], config.port)).await;
}
