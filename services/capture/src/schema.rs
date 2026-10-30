//! Strict-mode event schema enforcement (hot path).
//!
//! `apps/api` mirrors every project's per-event taxonomy schema into Redis at
//! `capture:schema:<project_id>` whenever taxonomy schema mutations happen:
//!
//! ```jsonc
//! {
//!   "<eventName>": {
//!     "mode": "warn" | "strict",   // events with mode "none" are absent entirely
//!     "required": ["propA", ...],
//!     "types": { "propA": "String" | "Numeric" | "Boolean" | "DateTime" }
//!   }
//! }
//! ```
//!
//! This module loads that blob and lets `capture.rs` reject a batch
//! synchronously when a `Strict`-mode event fails validation. `Warn`/`None`
//! events (or an event absent from the map entirely) are unenforced here —
//! warn-mode async validation is `services/ingest`'s job, not this hot path's.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use schema_validate::{EnforcementMode, EventSchema};

use crate::{
    models::{normalize_properties, InputEvent, SchemaEventError},
    state::AppState,
};

/// A project's parsed per-event schema map, keyed by event name.
pub type SchemaMap = HashMap<String, EventSchema>;

/// Process-local TTL in front of the Redis read.
///
/// Unlike `auth.rs`'s write-key cache (an auth boundary — a miss there MUST
/// fall back to Postgres) or `flags::store::load_defs` (also DB-backed),
/// a missing or stale schema cache here has a safe, correct default: "no
/// enforcement configured". `apps/api` is the sole writer of
/// `capture:schema:<project_id>` and always keeps it fresh on schema writes,
/// so there is no Postgres fallback to duplicate here — an empty map is
/// exactly right whether the key is genuinely absent (no strict/warn schemas
/// for this project) or just not observed yet.
///
/// The cache exists so the common case (a project with no strict schemas at
/// all) doesn't pay a Redis round trip on every single capture request: most
/// calls hit this process-local map instead. A few seconds of staleness is
/// an acceptable trade for that, on the same order as other write-then-read
/// convergence windows already accepted elsewhere in this system (e.g. the
/// write-key positive cache TTL in `auth.rs`).
const LOCAL_CACHE_TTL: Duration = Duration::from_secs(5);

struct CacheEntry {
    fetched_at: Instant,
    schemas: Arc<SchemaMap>,
}

fn local_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Load `project_id`'s schema map: process-local cache (few-second TTL) ->
/// Redis `capture:schema:<project_id>` -> empty map on a missing key, a
/// parse failure, or a Redis error.
///
/// Fails open: any backend hiccup here means "treat this batch as
/// unenforced", never "reject the batch because the schema cache lookup
/// failed" — schema enforcement is a taxonomy-quality feature, not an auth
/// boundary.
pub async fn load_schemas(state: &AppState, project_id: &str) -> Arc<SchemaMap> {
    if let Some(entry) = local_cache().lock().unwrap().get(project_id) {
        if entry.fetched_at.elapsed() < LOCAL_CACHE_TTL {
            return entry.schemas.clone();
        }
    }

    let mut redis = state.redis.clone();
    let schemas = fetch_from_redis(&mut redis, project_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                error = %e,
                project_id,
                "schema cache lookup failed; treating batch as unenforced"
            );
            HashMap::new()
        });
    let schemas = Arc::new(schemas);

    local_cache().lock().unwrap().insert(
        project_id.to_string(),
        CacheEntry {
            fetched_at: Instant::now(),
            schemas: schemas.clone(),
        },
    );

    schemas
}

/// `GET capture:schema:<project_id>` and parse it into a [`SchemaMap`]. A
/// missing key is not an error — it means no schemas are configured for this
/// project yet, which is `Ok(HashMap::new())`.
///
/// Split out from [`load_schemas`] so it can be unit-tested against a real
/// Redis without needing a full `AppState` (Postgres pool, JetStream, etc.) —
/// same shape as `quota.rs`'s `increment_and_check`.
async fn fetch_from_redis(
    redis: &mut redis::aio::ConnectionManager,
    project_id: &str,
) -> anyhow::Result<SchemaMap> {
    let raw: Option<String> = redis::cmd("GET")
        .arg(format!("capture:schema:{project_id}"))
        .query_async(redis)
        .await?;

    match raw {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(HashMap::new()),
    }
}

/// Look up `event`'s schema in `schemas`, returning it only when its mode is
/// [`EnforcementMode::Strict`]. `Warn`/`None` entries and events absent from
/// the map entirely all resolve to `None` — indistinguishable to a
/// strict-only caller like `capture::capture`.
pub fn strict_schema_for<'a>(schemas: &'a SchemaMap, event: &str) -> Option<&'a EventSchema> {
    schemas
        .get(event)
        .filter(|s| s.mode == EnforcementMode::Strict)
}

/// Validate an entire batch against `schemas`, collecting one
/// [`SchemaEventError`] per event that fails `Strict`-mode validation.
///
/// A pure, synchronous function — mirrors `capture.rs`'s `validate_batch` in
/// spirit — so the batch-rejection shape is fully unit-testable without a
/// live Redis/Postgres/NATS stack. `capture::capture` calls this once, up
/// front, and rejects the whole batch (publishing nothing) when it returns
/// anything non-empty.
pub fn check_batch(batch: &[InputEvent], schemas: &SchemaMap) -> Vec<SchemaEventError> {
    let mut errors = Vec::new();
    for (i, ev) in batch.iter().enumerate() {
        if let Some(event_schema) = strict_schema_for(schemas, &ev.event) {
            let properties = normalize_properties(ev.properties.clone());
            let violations = schema_validate::validate(&properties, event_schema);
            if !violations.is_empty() {
                errors.push(SchemaEventError {
                    index: i,
                    event: ev.event.clone(),
                    violations,
                });
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_validate::PropType;
    use uuid::Uuid;

    async fn test_redis() -> redis::aio::ConnectionManager {
        let url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
        let client = redis::Client::open(url).expect("valid REDIS_URL");
        redis::aio::ConnectionManager::new(client)
            .await
            .expect("connect to test Redis (is `make infra:up` running?)")
    }

    fn schema(mode: EnforcementMode) -> EventSchema {
        EventSchema {
            mode,
            required: vec!["email".to_string()],
            types: HashMap::from([("age".to_string(), PropType::Numeric)]),
        }
    }

    #[test]
    fn strict_schema_for_returns_strict_only() {
        let mut map = SchemaMap::new();
        map.insert("signup".to_string(), schema(EnforcementMode::Strict));
        map.insert("login".to_string(), schema(EnforcementMode::Warn));

        assert!(strict_schema_for(&map, "signup").is_some());
        assert!(strict_schema_for(&map, "login").is_none());
        assert!(strict_schema_for(&map, "unknown_event").is_none());
    }

    #[tokio::test]
    async fn fetch_from_redis_returns_empty_map_on_missing_key() {
        let mut redis = test_redis().await;
        let project_id = format!("test-schema-missing-{}", Uuid::now_v7());
        // Ensure no stale key from a prior run.
        let _: () = redis::cmd("DEL")
            .arg(format!("capture:schema:{project_id}"))
            .query_async(&mut redis)
            .await
            .unwrap();

        let map = fetch_from_redis(&mut redis, &project_id).await.unwrap();
        assert!(map.is_empty());
    }

    #[tokio::test]
    async fn fetch_from_redis_parses_the_expected_shape() {
        let mut redis = test_redis().await;
        let project_id = format!("test-schema-parse-{}", Uuid::now_v7());
        let key = format!("capture:schema:{project_id}");
        let value = serde_json::json!({
            "signup": {
                "mode": "strict",
                "required": ["email"],
                "types": { "age": "Numeric" }
            }
        })
        .to_string();
        let _: () = redis::cmd("SET")
            .arg(&key)
            .arg(&value)
            .query_async(&mut redis)
            .await
            .unwrap();

        let map = fetch_from_redis(&mut redis, &project_id).await.unwrap();
        let signup = map.get("signup").expect("signup schema present");
        assert_eq!(signup.mode, EnforcementMode::Strict);
        assert_eq!(signup.required, vec!["email".to_string()]);
        assert_eq!(signup.types.get("age"), Some(&PropType::Numeric));

        let _: () = redis::cmd("DEL")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
    }
}
