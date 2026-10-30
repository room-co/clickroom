//! The public support surface served by capture-rs.
//!
//! The widget runs on customer sites with a project write key and no user
//! session, so the *write* side of support lives here rather than on the
//! NestJS control plane: capture already owns project-key auth (`auth.rs`),
//! per-project rate limiting (`ratelimit.rs`), per-org quota accounting
//! (`quota.rs`) and a `sqlx::PgPool` (`state.rs`). Putting these routes on
//! `apps/api` would mean re-implementing all four.
//!
//! Layout mirrors `surveys/` and `flags/`:
//! - [`endpoint`] — Axum handlers (auth → rate limit → validate → act).
//! - [`bug`] — pure allow-listing, bounding and redaction of the
//!   bug-report payload before it reaches a `jsonb` column.
//! - [`store`] — every Postgres read/write, including the ticket-create
//!   transaction.
//! - [`validate`] — pure validation of a submitted payload against a form's
//!   stored `definition`.
//! - [`presign`] — pure S3 attachment policy (MIME allow-list, size cap, key
//!   derivation) plus the presigning client.
//!
//! Shared, dependency-free helpers (id/token generation, constant-time token
//! comparison) live in this file because every submodule needs them.

pub mod bug;
pub mod endpoint;
pub mod presign;
pub mod store;
pub mod stream;
pub mod validate;

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Crockford base32 alphabet (ULID spec) — no `I`, `L`, `O`, `U`.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 128 random bits from the OS CSPRNG.
///
/// The `uuid` crate's v4 constructor is backed by `getrandom`, so this avoids
/// pulling a second RNG crate into the service just for tokens and ULIDs.
fn random_u128() -> u128 {
    Uuid::new_v4().as_u128()
}

/// A fresh app ULID, byte-compatible with `newId()` in `packages/db`
/// (`ulid` npm): 48-bit millisecond timestamp + 80 random bits, rendered as
/// 26 Crockford base32 characters.
///
/// Every Prisma id column in this repo is an app-supplied ULID (there is no
/// database default), so capture must mint them the same way the Node side
/// does or ids written here would sort and read differently from every other
/// row in the table.
pub fn new_ulid() -> String {
    let ms = chrono::Utc::now().timestamp_millis().max(0) as u128;
    let value = (ms << 80) | (random_u128() & ((1u128 << 80) - 1));
    let mut out = String::with_capacity(26);
    for i in 0..26u32 {
        let shift = 5 * (25 - i);
        let index = ((value >> shift) & 0x1f) as usize;
        out.push(CROCKFORD[index] as char);
    }
    out
}

/// A ticket's opaque read credential: 32 random bytes, hex-encoded.
///
/// This is the *only* thing the widget holds to read its own thread back
/// (`GET /v1/support/tickets/:id`), so it is generated server-side from the
/// CSPRNG and never derived from the ticket id, the distinct id, or anything
/// else a caller can guess or enumerate.
pub fn new_ticket_token() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(&random_u128().to_be_bytes());
    bytes[16..].copy_from_slice(&random_u128().to_be_bytes());
    hex::encode(bytes)
}

/// Constant-time comparison of a presented ticket token against the stored one.
///
/// Both sides are hashed first and the fixed-width digests are compared with a
/// branchless XOR accumulation. Hashing matters as much as the branchless
/// compare: a naive `a == b` leaks the length of the stored token and returns
/// early on the first differing byte, which is enough to walk a token out one
/// byte at a time. Comparing digests makes the work identical for every input
/// regardless of the presented value's length.
pub fn ticket_token_matches(presented: &str, stored: &str) -> bool {
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(stored.as_bytes());
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_is_26_crockford_chars() {
        let id = new_ulid();
        assert_eq!(id.len(), 26);
        assert!(id
            .bytes()
            .all(|b| CROCKFORD.contains(&b) && b.is_ascii_alphanumeric()));
    }

    #[test]
    fn ulids_are_unique_and_time_sortable() {
        let a = new_ulid();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_ulid();
        assert_ne!(a, b);
        // The 10-char timestamp prefix is monotonic, so lexicographic order
        // matches creation order — the property the whole repo's ULID ids rely
        // on for `ORDER BY id`.
        assert!(a[..10] < b[..10], "{a} should sort before {b}");
    }

    #[test]
    fn ticket_token_is_64_hex_chars_and_unique() {
        let a = new_ticket_token();
        let b = new_ticket_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn token_compare_accepts_exact_match() {
        let token = new_ticket_token();
        assert!(ticket_token_matches(&token, &token));
    }

    #[test]
    fn token_compare_rejects_wrong_token() {
        let stored = new_ticket_token();
        let other = new_ticket_token();
        assert!(!ticket_token_matches(&other, &stored));
    }

    #[test]
    fn token_compare_rejects_prefix_and_empty() {
        let stored = new_ticket_token();
        // A correct prefix must not pass: the classic early-return bug would
        // let an attacker confirm a byte at a time.
        assert!(!ticket_token_matches(&stored[..63], &stored));
        assert!(!ticket_token_matches("", &stored));
        assert!(!ticket_token_matches(&format!("{stored}x"), &stored));
    }

    #[test]
    fn token_compare_is_case_sensitive() {
        let stored = "abcdef0123456789";
        assert!(!ticket_token_matches("ABCDEF0123456789", stored));
    }
}
