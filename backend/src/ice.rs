use serde::Serialize;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use base64::{Engine as _, engine::general_purpose};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceConfig {
    pub ice_servers: Vec<IceServer>,
}

pub fn get_ice_servers() -> IceConfig {
    let mut servers = vec![
        // Always include Google's public STUN server as a fallback
        IceServer {
            urls: "stun:stun.l.google.com:19302".to_string(),
            username: None,
            credential: None,
        },
    ];

    // Check if TURN is configured
    if let (Ok(turn_url), Ok(turn_secret)) = (env::var("TURN_URL"), env::var("TURN_SECRET")) {
        // Generate ephemeral credentials
        // Username format: timestamp:random_id
        
        let expiration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() + 86400; // Valid for 24 hours

        let username = format!("{}:filecoffee", expiration);
        
        // HMAC-SHA1(secret, username)
        type HmacSha1 = Hmac<Sha1>;
        let mut mac = HmacSha1::new_from_slice(turn_secret.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(username.as_bytes());
        let result = mac.finalize();
        let password = general_purpose::STANDARD.encode(result.into_bytes());

        servers.push(IceServer {
            urls: turn_url,
            username: Some(username),
            credential: Some(password),
        });
    }

    IceConfig { ice_servers: servers }
}
