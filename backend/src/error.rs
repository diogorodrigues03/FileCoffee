use thiserror::Error;
use warp::reject::Reject;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Room not found: {0}")]
    RoomNotFound(String),

    #[error("Invalid password")]
    InvalidPassword,

    #[error("Room capacity exceeded")]
    RoomCapacityExceeded,

    #[error("Rate limit exceeded")]
    RateLimitExceeded,

    #[error("Not in a room")]
    NotInRoom,

    #[error("Internal error: {0}")]
    InternalError(String),
}

// Make AppError compatible with Warp rejections
impl Reject for AppError {}

// Convert AppError to HTTP status + message
impl AppError {
    pub fn status_code(&self) -> warp::http::StatusCode {
        use warp::http::StatusCode;
        match self {
            AppError::RoomNotFound(_) => StatusCode::NOT_FOUND,
            AppError::InvalidPassword => StatusCode::UNAUTHORIZED,
            AppError::RoomCapacityExceeded => StatusCode::CONFLICT,
            AppError::RateLimitExceeded => StatusCode::TOO_MANY_REQUESTS,
            AppError::NotInRoom => StatusCode::BAD_REQUEST,
            AppError::InternalError(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}