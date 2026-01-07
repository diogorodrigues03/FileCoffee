use crate::room::Room;
use crate::types::{ClientMessage, PeerSender, Rooms, ServerMessage};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;
use warp::filters::ws::Message;

pub async fn handle_client_message(
    msg: ClientMessage,
    peer_tx: &PeerSender,
    rooms: &Rooms,
    current_room: &Arc<RwLock<Option<(String, usize)>>>,
) {
    // Handle different message types
    match msg {
        ClientMessage::CreateRoom { password } => {
            println!("Handling CreateRoom request");
            
            // Try to generate a unique slug
            let mut room_id = String::new();
            let mut attempts = 0;
            const MAX_ATTEMPTS: u8 = 5;

            while attempts < MAX_ATTEMPTS {
                 let candidate = crate::slug_generator::generate_slug();
                 if rooms.get(&candidate).await.is_none() {
                     room_id = candidate;
                     break;
                 }
                 attempts += 1;
            }

            // Fallback to UUID if slug generation fails (unlikely but safe)
            if room_id.is_empty() {
                room_id = Uuid::new_v4().to_string();
                println!("Slug collision limit reached, falling back to UUID: {}", room_id);
            }

            let room = Room::new(room_id.clone(), password);
            println!("Created new room: {}", room_id);

            // Add this peer to the room
            let mut room_peers = room.peers().write().await;
            room_peers.push(peer_tx.clone());
            let peer_index = room_peers.len() - 1;
            drop(room_peers); // Release the lock

            // Store room in the global rooms map
            rooms.insert(room).await;

            // Update this peer's current room
            let mut current = current_room.write().await;
            *current = Some((room_id.clone(), peer_index));
            drop(current);

            // Send the response to the peer
            let response = ServerMessage::RoomCreated { room_id };
            println!("Sending RoomCreated response: {:?}", response);
            let send_result =
                peer_tx.send(Message::text(serde_json::to_string(&response).unwrap()));
            println!("Send result: {:?}", send_result);
        }
        ClientMessage::JoinRoom { room_id, password } => {
            println!("Handling JoinRoom request for room_id: {}", room_id);
            // Check if the room exists
            let room = match rooms.get(&room_id).await {
                Some(r) => r,
                None => {
                    let error = ServerMessage::Error {
                        message: "Room not found".to_string(),
                    };
                    let _ = peer_tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                    return;
                }
            };

            // Check password
            if room.password.is_some() && room.password != password {
                println!("Invalid password attempt for room_id: {}", room_id);
                let error = ServerMessage::Error {
                    message: "Invalid password".to_string(),
                };
                let _ = peer_tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                return;
            }

            // Add this peer to the room
            let mut room_peers = room.peers().write().await;
            room_peers.push(peer_tx.clone());
            let peer_index = room_peers.len() - 1;
            drop(room_peers);

            // Update this peer's current room
            let mut current = current_room.write().await;
            *current = Some((room_id.clone(), peer_index));
            drop(current);

            // Notify all OTHER peers in the room that someone joined
            let notify = ServerMessage::PeerJoined;
            room.broadcast(
                Message::text(serde_json::to_string(&notify).unwrap()),
                Some(peer_index), // Skip notifying the peer that just joined
            )
            .await;

            // Confirm to the joining peer
            let response = ServerMessage::RoomJoined;
            let _ = peer_tx.send(Message::text(serde_json::to_string(&response).unwrap()));
        }
        ClientMessage::Signal { data } => {
            // Get current room
            let current = current_room.read().await;
            let (room_id, peer_index) = match current.as_ref() {
                Some(r) => r.clone(),
                None => {
                    let error = ServerMessage::Error {
                        message: "Not in a room".to_string(),
                    };
                    let _ = peer_tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                    return;
                }
            };
            drop(current);

            // Get the room
            let room = match rooms.get(&room_id).await {
                Some(r) => r,
                None => return,
            };

            // Broadcast the signal to all other peers
            let signal = ServerMessage::Signal { data };
            room.broadcast(
                Message::text(serde_json::to_string(&signal).unwrap()),
                Some(peer_index), // Don't send back to the sender
            )
            .await;
        }
    }
}

pub async fn cleanup_peer(current_room: Arc<RwLock<Option<(String, usize)>>>, rooms: Rooms) {
    let current = current_room.read().await;
    if let Some((room_id, peer_index)) = current.as_ref() {
        let room_id = room_id.clone();
        let peer_index = *peer_index;

        if let Some(room) = rooms.get(&room_id).await {
            let mut peers = room.peers().write().await;
            if peer_index < peers.len() {
                peers.remove(peer_index);
            }
            let is_empty = peers.is_empty();
            drop(peers);

            // Let's remove the room if it's empty
            if is_empty {
                rooms.remove(&room_id).await;
                println!("Room {} was empty and has been removed", room_id);
            } else {
                // Notify others that a peer left
                let notify = ServerMessage::PeerLeft;
                room.broadcast(
                    Message::text(serde_json::to_string(&notify).unwrap()),
                    None,
                )
                .await;
            }
        }
    }
}

pub async fn check_room_handler(room_id: String, rooms: Rooms) -> Result<impl warp::Reply, warp::Rejection> {
    if let Some(room) = rooms.get(&room_id).await {
        // The Room exists, check if it has a password
        let has_password = room.password.is_some();

        let message = ServerMessage::RoomExists { exists: true, has_password };

        // Return a 200 OK with the result
        Ok(warp::reply::json(&serde_json::json!(message)))
    }else{
        // The Room does not exist, return a 404 Not Found
        Err(warp::reject::not_found())
    }
}
