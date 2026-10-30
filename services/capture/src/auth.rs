//! Write-key authentication: `token -> (project_id, env)`.
//!
//! Hot path stays off Postgres via a Redis cache:
//! `capture:key:<sha256hex>` -> `<project_id>:<env>` (positive) or a sentinel
//! (negative). Misses fall back to a Postgres `"ApiKey"` lookup and populate
//! the cache.

use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Sentinel value stored for unknown/revoked keys (negative cache).
const NEG_SENTINEL: &str = "-";

/// A resolved API key: the project it belongs to, the environment (a
/// per-project `Environment.key` slug) it was minted for, and the owning org
/// — usage quotas are counted per-org, summed across all of an
/// org's projects).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedKey {
    /// Owning project id (ULID).
    pub project_id: String,
    /// Environment the key is scoped to.
    pub env: String,
    /// The project's owning org id (ULID) — `Project.orgId`.
    pub org_id: String,
}

/// Reasons a write key fails to resolve.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// Key is unknown, revoked, or not a write key.
    #[error("unauthorized")]
    Unauthorized,
    /// A backend (Redis/Postgres) failed.
    #[error(transparent)]
    Backend(#[from] anyhow::Error),
}

/// Lowercase hex sha256 of `token` — must match `@clickroom/auth` `hashApiKey`.
pub fn sha256_hex(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

/// Resolve a plaintext write key to its owning project id and env.
///
/// Order: Redis cache -> Postgres fallback -> populate cache. Unknown, revoked,
/// or non-write keys resolve to [`AuthError::Unauthorized`].
pub async fn resolve_write_key(state: &AppState, token: &str) -> Result<ResolvedKey, AuthError> {
    resolve_key(state, token, "write", "capture:key").await
}

/// Resolve a plaintext read key to its owning project id and env.
///
/// Identical to [`resolve_write_key`] but matches `"type" = 'read'` in Postgres
/// and uses a distinct Redis cache prefix (`capture:rkey:<hash>`) so read and
/// write caches never collide.
pub async fn resolve_read_key(state: &AppState, token: &str) -> Result<ResolvedKey, AuthError> {
    resolve_key(state, token, "read", "capture:rkey").await
}

/// Shared resolver: Redis cache -> Postgres fallback -> populate cache.
async fn resolve_key(
    state: &AppState,
    token: &str,
    key_type: &str,
    cache_prefix: &str,
) -> Result<ResolvedKey, AuthError> {
    let hash = sha256_hex(token);
    let cache_key = format!("{cache_prefix}:{hash}");
    let mut redis = state.redis.clone();

    // 1. Cache lookup. Positive entries are `<project_id>:<env>:<org_id>` —
    // project/org ids are ULIDs (no colons) and `env` is a per-project
    // free-form slug (`Environment.key`, `[a-z0-9-]`, still colon-free), so
    // splitting on ':' is unambiguous. Entries written by a pre
    // build only have `<project_id>:<env>` (two parts) — a rolling deploy may
    // still have those live in Redis; treat that shape as a miss so it falls
    // through and gets repopulated in the new 3-part form.
    let cached: Option<String> = redis::cmd("GET")
        .arg(&cache_key)
        .query_async(&mut redis)
        .await
        .map_err(|e| AuthError::Backend(e.into()))?;

    match cached.as_deref() {
        Some(NEG_SENTINEL) => return Err(AuthError::Unauthorized),
        Some(joined) => {
            let parts: Vec<&str> = joined.split(':').collect();
            if let [project_id, env, org_id] = parts[..] {
                return Ok(ResolvedKey {
                    project_id: project_id.to_string(),
                    env: env.to_string(),
                    org_id: org_id.to_string(),
                });
            }
            // Malformed or stale (legacy 2-part) cache entry — treat as
            // a miss and fall through to the Postgres fallback below.
        }
        None => {}
    }

    // 2. Postgres fallback (runtime query — no compile-time DB needed).
    // Join `Project` to resolve the owning org for per-org quota counting
    // — `quota::check_events`/`check_flags`).
    let row: Option<(String, String, String)> = sqlx::query_as(
        r#"SELECT k."projectId", e."key", p."orgId"
           FROM "ApiKey" k
           JOIN "Project" p ON p.id = k."projectId"
           JOIN "Environment" e ON e.id = k."environmentId"
           WHERE k."keyHash" = $1 AND k."type"::text = $2 AND k."revokedAt" IS NULL"#,
    )
    .bind(&hash)
    .bind(key_type)
    .fetch_optional(&state.pg)
    .await
    .map_err(|e| AuthError::Backend(e.into()))?;

    match row {
        Some((project_id, env, org_id)) => {
            // Positive cache.
            let joined = format!("{project_id}:{env}:{org_id}");
            let _: () = redis::cmd("SET")
                .arg(&cache_key)
                .arg(&joined)
                .arg("EX")
                .arg(state.config.key_cache_ttl_secs)
                .query_async(&mut redis)
                .await
                .map_err(|e| AuthError::Backend(e.into()))?;
            Ok(ResolvedKey {
                project_id,
                env,
                org_id,
            })
        }
        None => {
            // Negative cache to blunt invalid-key floods.
            let _: () = redis::cmd("SET")
                .arg(&cache_key)
                .arg(NEG_SENTINEL)
                .arg("EX")
                .arg(state.config.key_neg_cache_ttl_secs)
                .query_async(&mut redis)
                .await
                .map_err(|e| AuthError::Backend(e.into()))?;
            Err(AuthError::Unauthorized)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn hash_matches_clickroom_auth_sha256() {
        // Seeded Default-project write key -> its keyHash row in Postgres.
        let token = "ckw_live_a2987d751bd5c7ed4c7d9d603a1dc1b5fb910a5fd82cce3d";
        assert_eq!(
            sha256_hex(token),
            "7281b94d0b9a12325ddc62fe2c33487f510bc1c6297e9b1dd5ff3b07403a1e5d"
        );
    }

    #[test]
    fn hash_is_64_hex_chars() {
        let h = sha256_hex("ckw_live_deadbeef");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
