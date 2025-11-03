mod handler;
mod room;
mod types;
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc};
use types::{ClientMessage, Rooms, ServerMessage};
use warp::{Filter, ws::Message};

#[tokio::main]
async fn main() {
    // Initialize the shared rooms storage
    let rooms: Rooms = Arc::new(RwLock::new(HashMap::new()));

    // Clone for the filter (warp requires 'static lifetime)
    let rooms_filter = warp::any().map(move || rooms.clone());

    // Serve static files (HTML/JS frontend)
    let static_files = warp::fs::dir("./static/");

    // WebSocket endpoint
    let ws_route =
        warp::path("ws")
            .and(warp::ws())
            .and(rooms_filter)
            .map(|ws: warp::ws::Ws, rooms| {
                ws.on_upgrade(move |socket| handle_connection(socket, rooms))
            });

    let routes = static_files.or(ws_route);

    println!("Server running on http://localhost:3030");
    warp::serve(routes).run(([127, 0, 0, 1], 3030)).await;
}

async fn handle_connection(ws: warp::ws::WebSocket, rooms: Rooms) {
    // Can read/write messages and manage rooms using the `rooms` storage
    println!("New WebSocket connection!");
    let rooms_guard = rooms.read().await;
    for room_id in rooms_guard.keys() {
        println!("Room ID: {}", room_id);
    }
    drop(rooms_guard);

    // Split socket into sender and receiver
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Create a channel for this peer
    // Other tasks can send messages to this peer via tx
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Track which room this peer is in
    let current_room: Arc<RwLock<Option<(String, usize)>>> = Arc::new(RwLock::new(None));
    let current_room_clone = current_room.clone();
    let rooms_clone = rooms.clone();

    // Spawn a task to forward messages from rx to the WebSocket
    tokio::task::spawn(async move {
        while let Some(message) = rx.recv().await {
            if ws_tx.send(message).await.is_err() {
                break;
            }
        }
    });

    // Process each incoming messages
    while let Some(result) = ws_rx.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("WebSocket error: {}", e);
                break;
            }
        };

        // Only process text messages
        if let Ok(text) = msg.to_str() {
            // Parse JSON into our ClientMessage enum
            let client_msg: ClientMessage = match serde_json::from_str(text) {
                Ok(m) => {
                    println!("Received message: {:?}", m);
                    m
                },
                Err(e) => {
                    eprintln!("Failed to parse message: {}", e);
                    let error = ServerMessage::Error {
                        message: "Invalid message format".to_string(),
                    };
                    let _ = tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                    continue;
                }
            };

            handler::handle_client_message(client_msg, &tx, &rooms, &current_room).await;
        }
    }

    handler::cleanup_peer(current_room_clone, rooms_clone).await;
}
