use serde::Serialize;

#[derive(Serialize)]
pub struct Message {
    pub status: u16,
    pub message: String,
    pub message_type: Option<MessageType>,
}

#[derive(Serialize)]
pub enum MessageType {
   Start,
   Pause,
   Done,
   Error,
   RequestInfo,
   Info,
}