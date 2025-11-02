use crate::types;
use axum::{Json, Router, routing::get};
use std::net::SocketAddr;
use uuid::Uuid;


async fn root() -> &'static str {
    "Welcome to my first API using Axum!"
}

async fn join_room() -> Json<types::Message> {
    let response = types::Message {
        status: http::StatusCode::OK.as_u16(),
        message_type: Some(types::MessageType::Info),
        message: "Connection Successful".to_string(),
    };
    Json(response)
}

async fn create_room() -> Json<types::Message> {

    //Here I want to create a room and return the room ID
    let room_id = Uuid::new_v4();


    let response = types::Message {
        status: http::StatusCode::OK.as_u16(),
        message_type: Some(types::MessageType::Info),
        message: "Room Created Successfully".to_string(),
    };
    Json(response)
}

pub async fn create_endpoints() {
    let app = Router::new()
        .route("/", get(root))
        .route("create_room", get(create_room))
        .route("/join_room", get(join_room));

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    println!("Listening on {}", addr);

    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await
        .unwrap();
}
