//! Deterministic bucketing hash (canonical ).
//!
//! `hash(key, distinct_id, salt) = int(SHA1_hex(key + "." + distinct_id + salt)[0:15])
//!  / 0xFFFFFFFFFFFFFFF` — a float in `[0, 1]`, CLOSED at both ends: the numerator
//! can reach the denominator (all-`f` prefix). MUST match the JS SDK and TS
//! server byte-for-byte or SDK↔server parity (AC-5/6/7) breaks.

use sha1::{Digest, Sha1};

/// Denominator: 15 hex `f`s = `1152921504606846975`.
const DENOM: u64 = 0xFFF_FFFF_FFFF_FFFF;

/// Bucket `key`/`distinct_id` into `[0, 1]` using `salt` (`""` for rollout,
/// `"variant"` for variant selection). NO separator is inserted before `salt`.
pub fn hash_flag(key: &str, distinct_id: &str, salt: &str) -> f64 {
    let input = format!("{key}.{distinct_id}{salt}");
    let digest = Sha1::digest(input.as_bytes());
    let hex = hex::encode(digest); // 40 lowercase hex chars
                                   // First 15 hex chars -> integer (up to 60 bits, fits u64).
    let n = u64::from_str_radix(&hex[..15], 16).expect("15 hex chars parse to u64");
    n as f64 / DENOM as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_in_unit_interval() {
        for id in ["u_1", "u_2", "alice@example.com", "", "🎯"] {
            let h = hash_flag("my-flag", id, "");
            assert!((0.0..=1.0).contains(&h), "hash {h} out of [0,1] for {id}");
        }
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            hash_flag("k", "d", "variant"),
            hash_flag("k", "d", "variant")
        );
    }

    #[test]
    fn salt_changes_bucket() {
        assert_ne!(hash_flag("k", "d", ""), hash_flag("k", "d", "variant"));
    }
}
