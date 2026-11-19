use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use rand::seq::SliceRandom;

const ADJECTIVES: &[&str] = &[
    "hot", "cold", "iced", "dark", "light", "sweet", "bitter", "frothy", "milky", "roasted",
    "decaf", "strong", "smooth", "creamy", "fresh", "bold", "rich", "steaming", "foamy", "tasty",
];

const NOUNS: &[&str] = &[
    "coffee",
    "bean",
    "espresso",
    "latte",
    "mocha",
    "cappuccino",
    "brew",
    "roast",
    "cup",
    "mug",
    "barista",
    "aroma",
    "steam",
    "filter",
    "press",
    "macchiato",
    "americano",
    "cortado",
    "grind",
    "pour",
];

/// Bytes of randomness in the room token. 16 bytes = 128 bits, which makes
/// guessing or enumerating room IDs infeasible.
const TOKEN_BYTES: usize = 16;

/// Generate a room ID such as `hot-espresso-q3X9vB0kT1mZpL8sWcYd2A`.
///
/// The `adjective-noun` prefix is only cosmetic. The security of the room ID
/// comes entirely from the 128-bit random token, drawn from the OS CSPRNG.
pub fn generate_slug() -> String {
    let mut rng = rand::thread_rng();
    let adj = ADJECTIVES.choose(&mut rng).unwrap_or(&"tasty");
    let noun = NOUNS.choose(&mut rng).unwrap_or(&"coffee");

    let mut token = [0u8; TOKEN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut token);

    format!("{}-{}-{}", adj, noun, URL_SAFE_NO_PAD.encode(token))
}

/// Cheap sanity check for room IDs coming from clients, so obviously invalid
/// input is rejected before touching the store.
pub fn is_valid_room_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn slug_has_128_bit_token() {
        let slug = generate_slug();
        // base64url without padding: 16 bytes -> 22 chars. The token may itself
        // contain '-', so take the part after the second separator.
        let token = slug.splitn(3, '-').nth(2).unwrap();
        assert_eq!(token.len(), 22);
        assert_eq!(URL_SAFE_NO_PAD.decode(token).unwrap().len(), TOKEN_BYTES);
        assert!(is_valid_room_id(&slug));
    }

    #[test]
    fn slugs_are_unique() {
        let slugs: HashSet<_> = (0..10_000).map(|_| generate_slug()).collect();
        assert_eq!(slugs.len(), 10_000);
    }

    #[test]
    fn rejects_bad_room_ids() {
        assert!(!is_valid_room_id(""));
        assert!(!is_valid_room_id("../etc/passwd"));
        assert!(!is_valid_room_id("a b"));
        assert!(!is_valid_room_id(&"a".repeat(129)));
        // Legacy UUID-style IDs are still valid
        assert!(is_valid_room_id("550e8400-e29b-41d4-a716-446655440000"));
    }
}
