use crate::config::Config;
use base64::{Engine as _, engine::general_purpose};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const PUBLIC_STUN_URL: &str = "stun:stun.l.google.com:19302";

/// One entry of `RTCConfiguration.iceServers`, serialized in the shape the
/// browser expects.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct IceServer {
    pub urls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Build the ICE server list for one peer that has already been admitted to a
/// room. This is only sent over the WebSocket after a successful
/// `CreateRoom`/`JoinRoom`, so TURN credentials are never handed to anonymous
/// clients.
///
/// TURN credentials use coturn's `--use-auth-secret` (TURN REST API) scheme:
/// `username = "<expiry-unix-ts>:<peer-id>"`, `credential = base64(HMAC-SHA1(secret, username))`.
/// Embedding the peer ID makes relay usage traceable in coturn logs.
pub fn ice_servers_for_peer(config: &Config, peer_id: Uuid) -> Vec<IceServer> {
    let mut servers = vec![IceServer {
        urls: PUBLIC_STUN_URL.to_string(),
        username: None,
        credential: None,
    }];

    if let (Some(turn_url), Some(turn_secret)) = (&config.turn_url, &config.turn_secret) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let expiry = now + config.turn_credential_ttl_secs;
        let username = format!("{}:{}", expiry, peer_id);

        servers.push(IceServer {
            urls: turn_url.clone(),
            credential: Some(turn_credential(turn_secret, &username)),
            username: Some(username),
        });
    }

    servers
}

fn turn_credential(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC can take key of any size");
    mac.update(username.as_bytes());
    general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(turn: bool, ttl: u64) -> Config {
        let mut c = Config::from_env();
        c.turn_url = turn.then(|| "turn:example.test:3478".to_string());
        c.turn_secret = turn.then(|| "secret".to_string());
        c.turn_credential_ttl_secs = ttl;
        c
    }

    #[test]
    fn stun_only_without_turn_config() {
        let servers = ice_servers_for_peer(&config(false, 600), Uuid::new_v4());
        assert_eq!(servers.len(), 1);
        assert!(servers[0].username.is_none());
    }

    #[test]
    fn turn_credentials_are_peer_bound_and_use_configured_ttl() {
        let peer = Uuid::new_v4();
        let servers = ice_servers_for_peer(&config(true, 600), peer);
        let turn = &servers[1];
        let username = turn.username.as_deref().unwrap();

        let (expiry, id) = username.split_once(':').unwrap();
        assert_eq!(id, peer.to_string());

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let expiry: u64 = expiry.parse().unwrap();
        assert!((now + 590..=now + 610).contains(&expiry));

        assert_eq!(turn.credential.as_deref().unwrap(), turn_credential("secret", username));
    }

    #[test]
    fn known_hmac_vector() {
        // echo -n "1700000000:peer" | openssl dgst -sha1 -hmac secret -binary | base64
        assert_eq!(
            turn_credential("secret", "1700000000:peer"),
            "m9GnlZWvaZKjLjGseKws6UpgiA0="
        );
    }
}
