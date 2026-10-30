//! `POST /capture` handler: auth -> rate-limit -> validate -> publish -> 202.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    auth::{resolve_write_key, AuthError},
    error::ApiError,
    models::{normalize_properties, CaptureRequest, CaptureResponse, EventMessage},
    nats, quota, ratelimit, schema,
    state::AppState,
};

/// Max events accepted in a single batch (contract).
const MAX_BATCH: usize = 100;

/// Beacon-style query param carrying the write key (`?token=`).
#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    /// `pub` so other endpoint modules (e.g. `support/endpoint.rs`, whose own
    /// query struct carries a second, ticket-scoped token) can build one to
    /// reuse [`extract_token`] rather than re-implementing credential
    /// extraction and drifting from `POST /capture`'s accepted shapes.
    pub token: Option<String>,
}

/// Extract the write key from the `Authorization: Bearer` header or `?token=`.
pub fn extract_token(headers: &HeaderMap, query: &TokenQuery) -> Option<String> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(s) = value.to_str() {
            if let Some(token) = s.strip_prefix("Bearer ") {
                let token = token.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    query.token.as_ref().and_then(|t| {
        let t = t.trim();
        (!t.is_empty()).then(|| t.to_string())
    })
}

/// Resolve the originating client IP for an event.
///
/// Precedence:
///   1. `X-Forwarded-For` — first comma-separated entry (original client
///      through a proxy chain), trimmed.
///   2. `X-Real-IP` — trimmed.
///   3. Direct socket peer address, if provided.
///
/// Returns `None` when nothing resolves. Empty strings are never accepted.
///
/// SECURITY: `X-Forwarded-For` / `X-Real-IP` are client-spoofable when the
/// service is not behind a trusted reverse proxy. For the MVP this is
/// acceptable (trusted-proxy allowlisting is deferred scope); do not treat the
/// resolved IP as authenticated.
fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    if let Some(value) = headers.get("x-forwarded-for") {
        if let Ok(s) = value.to_str() {
            if let Some(first) = s.split(',').next() {
                let first = first.trim();
                if !first.is_empty() {
                    return Some(first.to_string());
                }
            }
        }
    }
    if let Some(value) = headers.get("x-real-ip") {
        if let Ok(s) = value.to_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    peer.map(|addr| addr.ip().to_string())
}

/// Normalize a client timestamp to RFC3339 UTC (millis). Falls back to `now`
/// when absent or unparseable.
fn normalize_timestamp(input: Option<&str>, now: DateTime<Utc>) -> String {
    let resolved = input
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(now);
    resolved.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Validate a decoded batch against the contract limits.
///
/// - batch length in `1..=MAX_BATCH` (over -> 413, empty -> 400)
/// - each event has a non-empty `event` and `distinct_id` (-> 400)
fn validate_batch(req: &CaptureRequest) -> Result<(), ApiError> {
    if req.batch.len() > MAX_BATCH {
        return Err(ApiError::PayloadTooLarge(format!(
            "batch of {} exceeds limit of {MAX_BATCH}",
            req.batch.len()
        )));
    }
    if req.batch.is_empty() {
        return Err(ApiError::BadRequest("batch is empty".into()));
    }
    for (i, ev) in req.batch.iter().enumerate() {
        if ev.event.trim().is_empty() {
            return Err(ApiError::BadRequest(format!("event[{i}].event is empty")));
        }
        if ev.distinct_id.trim().is_empty() {
            return Err(ApiError::BadRequest(format!(
                "event[{i}].distinct_id is empty"
            )));
        }
    }
    Ok(())
}

/// `POST /capture`.
pub async fn capture(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<CaptureResponse>), ApiError> {
    // 1. Authenticate.
    let token = extract_token(&headers, &query).ok_or(ApiError::Unauthorized)?;
    let (project_id, env, org_id) = match resolve_write_key(&state, &token).await {
        Ok(resolved) => (resolved.project_id, resolved.env, resolved.org_id),
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    // 2. Rate limit (per project).
    let decision = ratelimit::check(&state, &project_id).await?;
    if !decision.allowed {
        return Err(ApiError::RateLimited {
            retry_after: decision.retry_after,
        });
    }

    // 3. Parse + validate.
    let req: CaptureRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid batch json: {e}")))?;
    validate_batch(&req)?;

    // 3.5 Quota (per-org, monthly): count the whole validated batch size
    // against the org's event quota before publishing anything. Counting
    // always happens inside `quota::check_events` regardless of
    // `QUOTA_ENFORCE` — only the reject decision is gated, so a disabled gate
    // still leaves the usage dashboard accurate. Rejects the whole
    // batch (no partial accept) to keep the accounting simple and match the
    // contract's all-or-nothing batch semantics.
    //
    // `quota_decision.allowed` already folds in the org's
    // overage policy: when the org is over its monthly limit but has opted
    // into `allow`, `allowed` is still `true` and this batch is accepted +
    // counted as overage (billed later, no invoicing this phase) — that's
    // the org's explicit opt-out of the hard block below, not a bug.
    let batch_len = req.batch.len() as i64;
    let quota_decision = quota::check_events(&state, &org_id, batch_len).await?;
    if !quota_decision.allowed {
        tracing::warn!(
            org_id,
            current = quota_decision.current,
            limit = quota_decision.limit,
            policy = ?quota_decision.policy,
            batch_len,
            "quota exceeded"
        );
        return Err(ApiError::QuotaExceeded);
    }

    // 3.6 Strict schema enforcement: check the *whole* batch up front,
    // before any event is published, so a single strict-mode violation
    // rejects the entire batch with nothing durably written — same
    // all-or-nothing batch semantics as the quota check above. Warn/none-mode
    // events (and events with no schema entry at all) are untouched: this
    // loop only ever calls `schema_validate::validate` for a `Strict` match.
    let schemas = schema::load_schemas(&state, &project_id).await;
    let schema_errors = schema::check_batch(&req.batch, &schemas);
    if !schema_errors.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(CaptureResponse {
                accepted: 0,
                errors: schema_errors,
            }),
        ));
    }

    // 4. Enrich every event, then publish the whole batch pipelined: all
    // `publish()` calls are issued before any JetStream persist ack is
    // awaited (see `nats::publish_batch`), instead of sequentially awaiting
    // a full publish+persist-ack round-trip per event. Enrichment (fresh
    // uuidv7 + created_at per event) still happens up front here, unchanged.
    let now = Utc::now();
    let created_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    // Resolve the client IP once for the whole batch (same connection).
    let ip = client_ip(&headers, Some(peer));
    let batch_size = req.batch.len();
    let mut payloads = Vec::with_capacity(batch_size);

    for ev in req.batch {
        let mut properties = normalize_properties(ev.properties);
        // Server-resolved IP is authoritative: overwrite any client-supplied
        // `$ip` (untrusted). Only inject when the server actually resolved one;
        // otherwise leave any existing value untouched.
        if let Some(ip) = &ip {
            if let Some(obj) = properties.as_object_mut() {
                obj.insert("$ip".to_string(), serde_json::Value::String(ip.clone()));
            }
        }
        // Server-authoritative env for flag-call exposures: overwrite any
        // client-supplied `$feature_flag_environment` (untrusted) with the env
        // resolved from the write key, same source `/flags` uses. Only
        // meaningful on `$feature_flag_called` events but harmless to set
        // unconditionally when present in properties.
        if ev.event == "$feature_flag_called" {
            if let Some(obj) = properties.as_object_mut() {
                obj.insert(
                    "$feature_flag_environment".to_string(),
                    serde_json::Value::String(env.clone()),
                );
            }
        }
        let msg = EventMessage {
            uuid: Uuid::now_v7().to_string(),
            project_id: project_id.clone(),
            timestamp: normalize_timestamp(ev.timestamp.as_deref(), now),
            event: ev.event,
            distinct_id: ev.distinct_id,
            properties,
            elements_chain: ev.elements_chain.unwrap_or_default(),
            created_at: created_at.clone(),
        };
        let payload = serde_json::to_vec(&msg)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize event: {e}")))?;
        payloads.push(payload);
    }

    // Each event's own publish+ack gets its own timeout budget (see
    // `nats::publish_batch`) — without this, a single stuck JetStream ack
    // (e.g. the shared connection saturated under high concurrency) hangs
    // forever with no error logged and no way to recover (see load-test
    // incident: capture-rs froze at 0% CPU with connections piling up). A
    // per-event timeout turns that into a bounded, observable `503` instead,
    // without letting one stuck event pin permits held by its batch-siblings.
    let publish_timeout = std::time::Duration::from_millis(state.config.nats_publish_timeout_ms);
    match nats::publish_batch(
        &state.jetstream,
        &project_id,
        payloads,
        &state.config.subject_prefix,
        Arc::clone(&state.nats_publish_semaphore),
        publish_timeout,
    )
    .await
    {
        Ok(()) => {}
        Err(nats::PublishBatchError::Timeout) => {
            tracing::error!(
                project_id = %project_id,
                batch_size,
                timeout_ms = state.config.nats_publish_timeout_ms,
                "capture: NATS publish_batch timed out waiting for JetStream acks"
            );
            return Err(ApiError::UpstreamTimeout);
        }
        Err(nats::PublishBatchError::Nats(e)) => {
            return Err(ApiError::Internal(e));
        }
    }

    // 202: durably persisted to JetStream (durability boundary, AC-2).
    Ok((
        StatusCode::ACCEPTED,
        Json(CaptureResponse {
            accepted: batch_size,
            errors: Vec::new(),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::InputEvent;
    use schema_validate::{EnforcementMode, EventSchema, PropType, Violation};
    use serde_json::json;
    use std::collections::HashMap;

    fn ev(event: &str, distinct_id: &str) -> InputEvent {
        InputEvent {
            event: event.into(),
            distinct_id: distinct_id.into(),
            timestamp: None,
            properties: None,
            elements_chain: None,
        }
    }

    fn ev_with_props(event: &str, distinct_id: &str, properties: serde_json::Value) -> InputEvent {
        InputEvent {
            event: event.into(),
            distinct_id: distinct_id.into(),
            timestamp: None,
            properties: Some(properties),
            elements_chain: None,
        }
    }

    // --- Strict schema enforcement (`schema::check_batch`, wired into
    // `capture()` at step 3.6) ---------------------------------------------

    #[test]
    fn strict_violation_rejects_with_correct_error_body_and_index() {
        let schemas: schema::SchemaMap = HashMap::from([(
            "signup".to_string(),
            EventSchema {
                mode: EnforcementMode::Strict,
                required: vec!["email".to_string()],
                types: HashMap::from([("age".to_string(), PropType::Numeric)]),
            },
        )]);
        let batch = vec![
            ev("click", "u1"),
            ev_with_props("signup", "u2", json!({ "age": "not-a-number" })),
        ];

        let errors = schema::check_batch(&batch, &schemas);

        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].index, 1);
        assert_eq!(errors[0].event, "signup");
        assert!(errors[0].violations.contains(&Violation::MissingRequired {
            property: "email".to_string()
        }));
        assert!(errors[0].violations.contains(&Violation::TypeMismatch {
            property: "age".to_string(),
            expected: PropType::Numeric,
            actual_json_type: "string".to_string(),
        }));
    }

    #[test]
    fn strict_violation_batch_rejects_as_whole_and_nothing_is_published() {
        // A capture() call whose schema check finds any violation returns
        // early (400) before the NATS-publish loop is ever reached — so the
        // number of `check_batch` errors being non-empty is exactly the
        // signal `capture()` uses to skip publishing entirely. This asserts
        // that signal fires even though only one of several events in the
        // batch is bad (whole-batch rejection, not partial-accept).
        let schemas: schema::SchemaMap = HashMap::from([(
            "signup".to_string(),
            EventSchema {
                mode: EnforcementMode::Strict,
                required: vec!["email".to_string()],
                types: HashMap::new(),
            },
        )]);
        let batch = vec![
            ev("click", "u1"),
            ev("purchase", "u2"),
            ev_with_props("signup", "u3", json!({})),
        ];

        let errors = schema::check_batch(&batch, &schemas);
        assert_eq!(errors.len(), 1, "only the signup event violates its schema");
        assert_eq!(errors[0].index, 2);
    }

    #[test]
    fn warn_mode_violations_do_not_reject_the_batch() {
        let schemas: schema::SchemaMap = HashMap::from([(
            "signup".to_string(),
            EventSchema {
                mode: EnforcementMode::Warn,
                required: vec!["email".to_string()],
                types: HashMap::new(),
            },
        )]);
        // Missing `email` would violate this schema under Strict mode, but
        // the mode is Warn, so `check_batch` must report no errors at all.
        let batch = vec![ev_with_props("signup", "u1", json!({}))];

        assert!(schema::check_batch(&batch, &schemas).is_empty());
    }

    #[test]
    fn none_mode_and_schemaless_events_are_never_checked() {
        let schemas: schema::SchemaMap = HashMap::from([(
            "signup".to_string(),
            EventSchema {
                mode: EnforcementMode::None,
                required: vec!["email".to_string()],
                types: HashMap::new(),
            },
        )]);
        let batch = vec![
            ev_with_props("signup", "u1", json!({})),
            ev_with_props(
                "totally_unconfigured_event",
                "u2",
                json!("not-even-an-object"),
            ),
        ];

        assert!(schema::check_batch(&batch, &schemas).is_empty());
    }

    #[test]
    fn empty_schema_map_never_rejects_any_batch() {
        // Regression check: a project with no schemas configured at all
        // (the common case) must leave `check_batch` a total no-op,
        // regardless of how malformed the properties look.
        let schemas: schema::SchemaMap = HashMap::new();
        let batch = vec![
            ev("click", "u1"),
            ev_with_props("signup", "u2", json!("not-an-object")),
            ev_with_props("purchase", "u3", json!({ "amount": "not-a-number" })),
        ];

        assert!(schema::check_batch(&batch, &schemas).is_empty());
    }

    #[test]
    fn accepts_valid_batch() {
        let req = CaptureRequest {
            batch: vec![ev("click", "u1")],
        };
        assert!(validate_batch(&req).is_ok());
    }

    #[test]
    fn rejects_empty_batch_as_bad_request() {
        let req = CaptureRequest { batch: vec![] };
        assert!(matches!(validate_batch(&req), Err(ApiError::BadRequest(_))));
    }

    #[test]
    fn rejects_oversize_batch_as_payload_too_large() {
        let req = CaptureRequest {
            batch: (0..MAX_BATCH + 1)
                .map(|i| ev("e", &format!("u{i}")))
                .collect(),
        };
        assert!(matches!(
            validate_batch(&req),
            Err(ApiError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn accepts_exactly_max_batch() {
        let req = CaptureRequest {
            batch: (0..MAX_BATCH).map(|i| ev("e", &format!("u{i}"))).collect(),
        };
        assert!(validate_batch(&req).is_ok());
    }

    #[test]
    fn rejects_empty_event_name() {
        let req = CaptureRequest {
            batch: vec![ev("  ", "u1")],
        };
        assert!(matches!(validate_batch(&req), Err(ApiError::BadRequest(_))));
    }

    #[test]
    fn rejects_empty_distinct_id() {
        let req = CaptureRequest {
            batch: vec![ev("click", "")],
        };
        assert!(matches!(validate_batch(&req), Err(ApiError::BadRequest(_))));
    }

    #[test]
    fn malformed_batch_type_is_bad_request() {
        // `{"batch":"nope"}` must not deserialize into CaptureRequest.
        let res: Result<CaptureRequest, _> = serde_json::from_slice(br#"{"batch":"nope"}"#);
        assert!(res.is_err());
    }

    #[test]
    fn timestamp_parses_client_rfc3339_to_utc() {
        let now = Utc::now();
        let out = normalize_timestamp(Some("2026-07-03T12:00:00.000Z"), now);
        assert_eq!(out, "2026-07-03T12:00:00.000Z");
    }

    #[test]
    fn timestamp_converts_offset_to_utc() {
        let now = Utc::now();
        // +02:00 -> 10:00:00Z
        let out = normalize_timestamp(Some("2026-07-03T12:00:00+02:00"), now);
        assert_eq!(out, "2026-07-03T10:00:00.000Z");
    }

    #[test]
    fn timestamp_falls_back_to_now_when_absent_or_invalid() {
        let now = Utc::now();
        let expected = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        assert_eq!(normalize_timestamp(None, now), expected);
        assert_eq!(normalize_timestamp(Some("not-a-date"), now), expected);
    }

    #[test]
    fn extract_token_prefers_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer ckw_live_abc".parse().unwrap(),
        );
        let q = TokenQuery { token: None };
        assert_eq!(extract_token(&headers, &q), Some("ckw_live_abc".into()));
    }

    #[test]
    fn extract_token_falls_back_to_query() {
        let headers = HeaderMap::new();
        let q = TokenQuery {
            token: Some("ckw_live_xyz".into()),
        };
        assert_eq!(extract_token(&headers, &q), Some("ckw_live_xyz".into()));
    }

    #[test]
    fn extract_token_none_when_missing() {
        let headers = HeaderMap::new();
        let q = TokenQuery { token: None };
        assert_eq!(extract_token(&headers, &q), None);
    }

    fn peer(s: &str) -> Option<SocketAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn client_ip_prefers_xff_over_real_ip() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.7".parse().unwrap());
        headers.insert("x-real-ip", "198.51.100.9".parse().unwrap());
        assert_eq!(
            client_ip(&headers, peer("10.0.0.1:5000")),
            Some("203.0.113.7".into())
        );
    }

    #[test]
    fn client_ip_xff_multi_hop_takes_first() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.7, 70.41.3.18, 150.172.238.178".parse().unwrap(),
        );
        assert_eq!(
            client_ip(&headers, peer("10.0.0.1:5000")),
            Some("203.0.113.7".into())
        );
    }

    #[test]
    fn client_ip_falls_back_to_real_ip() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", "198.51.100.9".parse().unwrap());
        assert_eq!(
            client_ip(&headers, peer("10.0.0.1:5000")),
            Some("198.51.100.9".into())
        );
    }

    #[test]
    fn client_ip_falls_back_to_peer_when_no_headers() {
        let headers = HeaderMap::new();
        assert_eq!(
            client_ip(&headers, peer("192.0.2.44:5000")),
            Some("192.0.2.44".into())
        );
    }

    #[test]
    fn client_ip_none_when_nothing_present() {
        let headers = HeaderMap::new();
        assert_eq!(client_ip(&headers, None), None);
    }

    #[test]
    fn client_ip_trims_whitespace() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "  203.0.113.7  , 70.41.3.18".parse().unwrap(),
        );
        assert_eq!(client_ip(&headers, None), Some("203.0.113.7".into()));

        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", "   198.51.100.9   ".parse().unwrap());
        assert_eq!(client_ip(&headers, None), Some("198.51.100.9".into()));
    }

    #[test]
    fn client_ip_skips_empty_xff_entry() {
        // Empty first entry should not be accepted; fall through to real-ip.
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "   ".parse().unwrap());
        headers.insert("x-real-ip", "198.51.100.9".parse().unwrap());
        assert_eq!(client_ip(&headers, None), Some("198.51.100.9".into()));
    }
}
