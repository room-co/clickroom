//! Per-project event-schema fetch + warn-mode validation.
//!
//! Mirrors `taxonomy.rs`'s shape: a small handle built once in `main` around
//! the same shared Redis `ConnectionManager`, invoked from the consumer loop
//! alongside the other post-map side-lookups. Unlike taxonomy discovery this
//! is a read-only path — nothing is ever written back to Redis here.
//!
//! The control plane (`apps/api`) mirrors taxonomy schema mutations into a
//! per-project Redis key `capture:schema:<project_id>`: a JSON object keyed
//! by event name, value shaped like [`schema_validate::EventSchema`]. Only
//! events with `mode != none` appear — an absent event name means
//! "unenforced". `services/capture` reads the same key to reject `strict`
//! violations synchronously (HTTP 400) before the event ever reaches NATS, so
//! by the time a message reaches ingest its schema (if any) is normally
//! `warn`, `none`, or unenforced. Defensively, a `strict` entry that slips
//! through anyway (e.g. a race where capture read `strict` and ingest reads a
//! since-relaxed schema, or vice versa) is treated exactly like `warn`: tag,
//! never drop — ingest's async path never rejects anything.
//!
//! Best-effort: any Redis failure or unparseable cache value is logged and
//! treated as "no schema for this project" (silence -> unenforced). This must
//! never gate the batch insert/ack.

use std::collections::{HashMap, HashSet};

use redis::aio::ConnectionManager;
use schema_validate::{EnforcementMode, EventSchema};

use crate::models::RawEvent;

/// Redis handle for per-batch event-schema lookups.
#[derive(Clone)]
pub struct SchemaLookup {
    redis: ConnectionManager,
}

impl SchemaLookup {
    /// Build a lookup handle from the shared Redis connection manager (the
    /// same one `Taxonomy` uses — cloned in `main`, not a second connection).
    pub fn new(redis: ConnectionManager) -> Self {
        Self { redis }
    }

    /// Fetch + parse `capture:schema:<project_id>` into an event-name ->
    /// schema map. A missing key, Redis error, or unparseable JSON all
    /// collapse to "no schema for this project" (an empty map) rather than an
    /// error — schema lookup must never gate the insert.
    pub async fn fetch_project_schema(&self, project_id: &str) -> HashMap<String, EventSchema> {
        let key = format!("capture:schema:{project_id}");
        let mut conn = self.redis.clone();

        let raw: Option<String> = match redis::cmd("GET").arg(&key).query_async(&mut conn).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    project_id,
                    error = %e,
                    "schema lookup: redis GET failed (treating as unenforced)"
                );
                return HashMap::new();
            }
        };

        let Some(raw) = raw else {
            return HashMap::new();
        };

        match serde_json::from_str::<HashMap<String, EventSchema>>(&raw) {
            Ok(map) => map,
            Err(e) => {
                tracing::warn!(
                    project_id,
                    error = %e,
                    "schema lookup: malformed cache value (treating as unenforced)"
                );
                HashMap::new()
            }
        }
    }

    /// Build a per-drain-batch cache: fetch each *distinct* project id's
    /// schema map exactly once, regardless of how many events in the batch
    /// belong to it.
    pub async fn build_batch_cache<'a>(
        &self,
        project_ids: impl Iterator<Item = &'a str>,
    ) -> HashMap<String, HashMap<String, EventSchema>> {
        let distinct: HashSet<&str> = project_ids.collect();
        let mut cache = HashMap::with_capacity(distinct.len());
        for project_id in distinct {
            let schema = self.fetch_project_schema(project_id).await;
            cache.insert(project_id.to_string(), schema);
        }
        cache
    }
}

/// Validate one event against its project's schema cache (as built by
/// [`SchemaLookup::build_batch_cache`]). Returns `(schema_valid,
/// schema_errors)` ready to drop straight into the ClickHouse row:
///
/// - No schema entry for the event's name, or `mode == None`: unenforced ->
///   `(1, "")`.
/// - `mode == Warn` (or a `Strict` entry that slipped past capture's
///   synchronous gate, see module docs): run [`schema_validate::validate`].
///   Any violations set `schema_valid = 0` and `schema_errors` to a compact
///   JSON array of the violations; no violations is `(1, "")`.
///
/// Never drops or blocks the event either way — this only decides what two
/// extra column values the row carries.
pub fn validate_event(
    ev: &RawEvent,
    project_schema: &HashMap<String, EventSchema>,
) -> (u8, String) {
    let Some(schema) = project_schema.get(&ev.event) else {
        return (1, String::new());
    };

    if schema.mode == EnforcementMode::None {
        return (1, String::new());
    }

    let violations = schema_validate::validate(&ev.properties_object(), schema);
    if violations.is_empty() {
        (1, String::new())
    } else {
        let errors = serde_json::to_string(&violations).unwrap_or_else(|_| "[]".to_string());
        (0, errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use schema_validate::PropType;
    use serde_json::json;

    fn raw_event(event: &str, properties: serde_json::Value) -> RawEvent {
        RawEvent {
            uuid: "u".into(),
            project_id: "proj_1".into(),
            event: event.into(),
            distinct_id: "d".into(),
            timestamp: "2026-07-04T12:00:00Z".into(),
            properties,
            elements_chain: String::new(),
            created_at: "2026-07-04T12:00:00Z".into(),
        }
    }

    fn schema(mode: EnforcementMode, required: &[&str], types: &[(&str, PropType)]) -> EventSchema {
        EventSchema {
            mode,
            required: required.iter().map(|s| s.to_string()).collect(),
            types: types.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn no_schema_entry_is_unenforced() {
        let cache = HashMap::new();
        let (valid, errors) = validate_event(&raw_event("signup", json!({})), &cache);
        assert_eq!(valid, 1);
        assert_eq!(errors, "");
    }

    #[test]
    fn mode_none_is_unenforced_even_with_would_be_violations() {
        let mut cache = HashMap::new();
        cache.insert(
            "signup".to_string(),
            schema(EnforcementMode::None, &["email"], &[]),
        );
        let (valid, errors) = validate_event(&raw_event("signup", json!({})), &cache);
        assert_eq!(valid, 1);
        assert_eq!(errors, "");
    }

    #[test]
    fn warn_mode_tags_violations_without_signaling_drop() {
        let mut cache = HashMap::new();
        cache.insert(
            "signup".to_string(),
            schema(EnforcementMode::Warn, &["email"], &[]),
        );
        let (valid, errors) = validate_event(&raw_event("signup", json!({})), &cache);
        assert_eq!(valid, 0);
        assert!(errors.contains("missing_required"));
        assert!(errors.contains("email"));
    }

    #[test]
    fn warn_mode_no_violations_is_valid() {
        let mut cache = HashMap::new();
        cache.insert(
            "signup".to_string(),
            schema(EnforcementMode::Warn, &[], &[("age", PropType::Numeric)]),
        );
        let (valid, errors) = validate_event(&raw_event("signup", json!({ "age": 30 })), &cache);
        assert_eq!(valid, 1);
        assert_eq!(errors, "");
    }

    #[test]
    fn strict_entry_that_slips_through_is_treated_like_warn() {
        let mut cache = HashMap::new();
        cache.insert(
            "signup".to_string(),
            schema(EnforcementMode::Strict, &["email"], &[]),
        );
        let (valid, errors) = validate_event(&raw_event("signup", json!({})), &cache);
        assert_eq!(valid, 0);
        assert!(errors.contains("email"));
    }
}
