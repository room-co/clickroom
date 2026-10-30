//! `POST /flags` — evaluate every project flag for a user ().
//!
//! Auth: write key. Body: `{ distinct_id, person_properties? }`.
//! Response: `{ "flags": { "<key>": { enabled, variant, payload, track } } }`
//! for every flag (including `enabled:false`). `track` lets the
//! browser SDK gate exposure emission on the flag's tracked-ness.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    auth::{resolve_write_key, AuthError},
    capture::{extract_token, TokenQuery},
    error::ApiError,
    flags::{eval::evaluate, eval::EvalResult, eval::FlagDef, store::load_defs},
    models::EventMessage,
    nats, quota,
    state::AppState,
};

/// Dedup window for server-side exposure recording: repeat evaluations of the
/// same (project, env, distinct_id, key, response) within this window do not
/// re-emit an exposure. Mirrors sdk-js's "once per (key, response) per
/// identity" behavior (`packages/sdk-js/src/index.ts` `maybeEmitFlagCall`),
/// except sdk-js dedups for the lifetime of the page load while this dedups
/// on a rolling window (a long-lived server process has no natural "session"
/// boundary to reset on).
const EXPOSURE_DEDUP_TTL_SECS: usize = 3600;

/// The stringified response an exposure event records — a flag's variant when
/// set, else its boolean enabled state. Matches sdk-js's `getFeatureFlag`
/// convention (`result.variant ?? result.enabled`).
fn exposure_response(result: &EvalResult) -> String {
    result
        .variant
        .clone()
        .unwrap_or_else(|| result.enabled.to_string())
}

/// Whether evaluating `def` should emit a `$feature_flag_called` exposure.
/// Only tracked flags (experiment/adoption) are exposed; operational gates
/// (`track = false`) are evaluated and returned but never exposed, so
/// server-side gate checks don't mint phantom users.
fn should_expose(def: &FlagDef) -> bool {
    def.track
}

/// The Redis dedup key for one exposure identity.
fn exposure_dedup_key(
    project_id: &str,
    env: &str,
    distinct_id: &str,
    flag_key: &str,
    response: &str,
) -> String {
    format!("fxp:{project_id}:{env}:{distinct_id}:{flag_key}:{response}")
}

/// Claim the exposure dedup slot for `dedup_key`. Returns `Ok(true)` when this
/// is the first claim within the TTL window (caller should publish), `Ok(false)`
/// when an exposure for the same identity was already recorded (skip).
async fn claim_exposure_slot(
    redis: &mut redis::aio::ConnectionManager,
    dedup_key: &str,
    ttl_secs: usize,
) -> anyhow::Result<bool> {
    let newly_set: Option<String> = redis::cmd("SET")
        .arg(dedup_key)
        .arg(1)
        .arg("NX")
        .arg("EX")
        .arg(ttl_secs)
        .query_async(redis)
        .await?;
    Ok(newly_set.is_some())
}

/// Best-effort: record that `distinct_id` was exposed to `flag_key` with
/// `response`, publishing a `$feature_flag_called` event exactly once per
/// (project, env, distinct_id, flag_key, response) per `EXPOSURE_DEDUP_TTL_SECS`.
/// Never propagates an error to the caller — a missed exposure is a metrics
/// gap, not a correctness bug (the evaluation result was already returned).
async fn record_exposure(
    state: &AppState,
    project_id: &str,
    env: &str,
    distinct_id: &str,
    flag_key: &str,
    response: &str,
) {
    let dedup_key = exposure_dedup_key(project_id, env, distinct_id, flag_key, response);
    let mut redis = state.redis.clone();
    match claim_exposure_slot(&mut redis, &dedup_key, EXPOSURE_DEDUP_TTL_SECS).await {
        Ok(true) => {}       // first claim within the window -> publish below
        Ok(false) => return, // already recorded within the window
        Err(e) => {
            tracing::warn!("exposure dedup check failed for {dedup_key}: {e}");
            return;
        }
    }

    let now = Utc::now();
    let msg = EventMessage {
        uuid: Uuid::now_v7().to_string(),
        project_id: project_id.to_string(),
        event: "$feature_flag_called".to_string(),
        distinct_id: distinct_id.to_string(),
        timestamp: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        properties: json!({
            "$feature_flag": flag_key,
            "$feature_flag_response": response,
            "$feature_flag_environment": env,
            // Mark as a server-side exposure (caller-supplied distinct_id, no
            // browser session) so analytics can exclude it from user/visitor
            // counts. See EXCLUDE_SYNTHETIC in packages/clickhouse/src/queries.ts.
            "$lib": "clickroom-server",
        }),
        elements_chain: String::new(),
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let payload = match serde_json::to_vec(&msg) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("failed to serialize exposure event for {flag_key}: {e}");
            return;
        }
    };
    if let Err(e) = nats::publish_event(
        &state.jetstream,
        project_id,
        payload,
        &state.config.subject_prefix,
    )
    .await
    {
        tracing::warn!("failed to publish exposure event for {flag_key}: {e}");
    }
}

/// `POST /flags` request body.
#[derive(Debug, Deserialize)]
struct FlagsRequest {
    /// User identity to bucket on.
    distinct_id: String,
    /// Person properties for targeting (defaults to `{}`).
    #[serde(default)]
    person_properties: Map<String, Value>,
}

/// `POST /flags`.
pub async fn flags_endpoint(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    // 1. Authenticate (write key).
    let token = extract_token(&headers, &query).ok_or(ApiError::Unauthorized)?;
    let resolved = match resolve_write_key(&state, &token).await {
        Ok(resolved) => resolved,
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    // 2. Parse body.
    let req: FlagsRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid flags json: {e}")))?;
    if req.distinct_id.trim().is_empty() {
        return Err(ApiError::BadRequest("distinct_id is empty".into()));
    }

    // 3. Load defs + evaluate every flag.
    let blob = load_defs(&state, &resolved.project_id, &resolved.env).await?;
    let mut flags = Map::new();
    for def in &blob.flags {
        let result = evaluate(def, &req.distinct_id, &req.person_properties);
        // Record the evaluation as a metrics exposure only for flags marked
        // `track` (experiment/adoption flags). Operational gates have
        // `track = false` and are evaluated + returned but never exposed —
        // this is what keeps server-side gate checks from minting phantom
        // users. The evaluation result below is returned for every
        // flag regardless; only the exposure write is gated.
        if should_expose(def) {
            record_exposure(
                &state,
                &resolved.project_id,
                &resolved.env,
                &req.distinct_id,
                &def.key,
                &exposure_response(&result),
            )
            .await;
        }
        flags.insert(
            def.key.clone(),
            serde_json::to_value(&result)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize flag result: {e}")))?,
        );
    }

    // 4. Enforce the org's monthly flag-eval quota, counting one per flag
    // returned (not per request). Hard-blocking flag reads can degrade a
    // consuming app that fails closed on evaluation — `QUOTA_ENFORCE` is the
    // deliberate, default-on-but-flippable escape hatch for that risk.
    //
    // `decision.allowed` also folds in the org's overage policy:
    // over-limit + policy `allow` still yields `allowed = true`, so this
    // request proceeds and is counted as overage — the org explicitly opted
    // out of this mid-request break, same escape hatch as `QUOTA_ENFORCE`
    // but per-org instead of global.
    let decision = quota::check_flags(&state, &resolved.org_id, flags.len() as i64).await?;
    if !decision.allowed {
        tracing::warn!(
            org_id = resolved.org_id,
            current = decision.current,
            limit = decision.limit,
            policy = ?decision.policy,
            flags_len = flags.len(),
            "quota exceeded"
        );
        return Err(ApiError::QuotaExceeded);
    }

    Ok(Json(Value::Object({
        let mut m = Map::new();
        m.insert("flags".into(), Value::Object(flags));
        m
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn flag_def(key: &str, track: bool) -> FlagDef {
        serde_json::from_value(json!({
            "key": key, "active": true, "track": track, "filters": { "groups": [] }
        }))
        .unwrap()
    }

    /// A tracked flag is exposed; an untracked operational gate is evaluated and
    /// returned (that path is unchanged) but never emits an exposure — its
    /// `record_exposure` call is skipped by the `should_expose` gate.
    #[test]
    fn only_tracked_flags_are_exposed() {
        assert!(
            should_expose(&flag_def("experiment-flag", true)),
            "track=true flag must be exposed"
        );
        assert!(
            !should_expose(&flag_def("operational-gate", false)),
            "track=false flag must not be exposed"
        );
    }

    /// `track` defaults to false when the blob omits it (legacy earlier
    /// rows), so old flags stay silent until explicitly opted in.
    #[test]
    fn track_defaults_false_when_absent() {
        let def: FlagDef =
            serde_json::from_value(json!({ "key": "legacy", "active": true })).unwrap();
        assert!(!should_expose(&def));
    }

    /// A fresh `ConnectionManager` against the local dev/test Redis
    /// (`docker-compose.yml`'s `redis:6380`). Mirrors `quota.rs`'s test setup;
    /// each test scopes its own randomly-suffixed keys so tests never collide.
    async fn test_redis() -> redis::aio::ConnectionManager {
        let url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
        let client = redis::Client::open(url).expect("valid REDIS_URL");
        redis::aio::ConnectionManager::new(client)
            .await
            .expect("connect to test Redis (is `make infra:up` running?)")
    }

    fn unique_id(name: &str) -> String {
        format!("test-{name}-{}", Uuid::now_v7())
    }

    /// A tracked flag exposes once per (distinct_id, key, response) within the
    /// dedup window: the first claim publishes, repeats inside the window skip.
    #[tokio::test]
    async fn exposure_deduped_once_per_identity_within_window() {
        let mut redis = test_redis().await;
        let distinct_id = unique_id("did");
        let key = exposure_dedup_key("proj", "prod", &distinct_id, "flag-a", "true");

        // First evaluation for this identity -> claim succeeds -> would publish.
        assert!(
            claim_exposure_slot(&mut redis, &key, EXPOSURE_DEDUP_TTL_SECS)
                .await
                .unwrap(),
            "first exposure should claim the slot"
        );
        // Repeat within the window -> already recorded -> skipped.
        assert!(
            !claim_exposure_slot(&mut redis, &key, EXPOSURE_DEDUP_TTL_SECS)
                .await
                .unwrap(),
            "second exposure within window must be deduped"
        );
    }

    /// The dedup slot is keyed on the response, so a changed variant/enabled
    /// value re-exposes (distinct (key, response) pair).
    #[tokio::test]
    async fn distinct_response_reexposes() {
        let mut redis = test_redis().await;
        let distinct_id = unique_id("did");
        let key_a = exposure_dedup_key("proj", "prod", &distinct_id, "flag-a", "control");
        let key_b = exposure_dedup_key("proj", "prod", &distinct_id, "flag-a", "treatment");

        assert!(
            claim_exposure_slot(&mut redis, &key_a, EXPOSURE_DEDUP_TTL_SECS)
                .await
                .unwrap()
        );
        assert!(
            claim_exposure_slot(&mut redis, &key_b, EXPOSURE_DEDUP_TTL_SECS)
                .await
                .unwrap(),
            "a different response is a different exposure identity"
        );
    }
}
