use crate::types::{ClientMessage, PeerSender, Rooms, ServerMessage};
use crate::room::Room;
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
        ClientMessage::CreateRoom => {
            println!("Handling CreateRoom request");
            let room_id = Uuid::new_v4().to_string();
            let room = Room::new(room_id.clone());
            println!("Created new room: {}", room_id);

            // Add this peer to the room
            let mut room_peers = room.peers().write().await;
            room_peers.push(peer_tx.clone());
            println!("Current peers: {}", room_peers.len());
            let peer_index = room_peers.len() - 1;
            println!("Peer index: {}", peer_index);
            drop(room_peers); // Release the lock

            // Store room in global rooms map
            println!("Acquiring rooms write lock");
            let mut rooms_map = rooms.write().await;
            println!("Acquired rooms write lock");
            rooms_map.insert(room_id.clone(), room);
            println!("Inserted room");
            drop(rooms_map);
            println!("Dropped rooms_map");

            // Update this peer's current room
            println!("Acquiring current_room write lock");
            let mut current = current_room.write().await;
            println!("Acquired current_room write lock");
            *current = Some((room_id.clone(), peer_index));
            println!("Updated current_room");
            drop(current);
            println!("Dropped current_room");

            // Send response to the peer
            let response = ServerMessage::RoomCreated { room_id };
            println!("Sending RoomCreated response: {:?}", response);
            let send_result =
                peer_tx.send(Message::text(serde_json::to_string(&response).unwrap()));
            println!("Send result: {:?}", send_result);
        }
        ClientMessage::JoinRoom { room_id } => {
            println!("Handling JoinRoom request for room_id: {}", room_id);
            // Check if room exists
            let rooms_map = rooms.read().await;
            let room = match rooms_map.get(&room_id) {
                Some(r) => r.clone(),
                None => {
                    let error = ServerMessage::Error {
                        message: "Room not found".to_string(),
                    };
                    let _ = peer_tx.send(Message::text(serde_json::to_string(&error).unwrap()));
                    return;
                }
            };
            drop(rooms_map);

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
            let rooms_map = rooms.read().await;
            let room = match rooms_map.get(&room_id) {
                Some(r) => r.clone(),
                None => return,
            };
            drop(rooms_map);

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
        let rooms_map = rooms.read().await;
        if let Some(room) = rooms_map.get(room_id) {
            let mut peers = room.peers().write().await;
            if *peer_index < peers.len() {
                peers.remove(*peer_index);
            }
            // If room is empty, we could remove it from the map
            // (would need to upgrade to write lock on rooms_map)
        }
    }
}
