//! Axum HTTP surface for query-rs.
//!
//! `GET /health` — unauthenticated liveness probe.
//! `POST /query` — the whole SQL Explorer pipeline: authenticate the
//! internal caller, validate + rewrite the tenant SQL (`validate.rs`), wrap
//! it in a caller-scoped `LIMIT`, execute against ClickHouse
//! (`clickhouse.rs`), and return a clean JSON result.
//!
//! This endpoint is never public — it's bound to the internal network and
//! gated by `Authorization: Bearer <INTERNAL_QUERY_SECRET>`, called only by
//! `apps/api`'s `sqlExplorer.run` tRPC procedure (which itself asserts
//! tenant ownership of `projectId` before ever reaching here).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{
    clickhouse::{ClickHouseClient, ClickHouseQueryError, QueryResult},
    config::Config,
    validate::{self, ValidationError},
};

/// Shared application state handed to every handler.
#[derive(Clone)]
pub struct AppState {
    pub config: std::sync::Arc<Config>,
    pub clickhouse: ClickHouseClient,
    /// Caps the number of `/query` requests executing concurrently
    /// (`QUERY_MAX_CONCURRENCY`, 029 Part A2). A request that can't acquire a
    /// permit is rejected with `429` rather than queued, so a burst of
    /// concurrent tenant queries can't pile up connections/load against
    /// ClickHouse.
    pub query_semaphore: std::sync::Arc<Semaphore>,
}

/// `POST /query` request body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryRequest {
    /// Server-authorized project id — the caller (apps/api) has already
    /// asserted the requesting user owns this project. Never taken from
    /// `sql` itself.
    project_id: String,
    /// Tenant-authored SQL text (`SELECT`/`WITH` only — see `validate.rs`).
    sql: String,
    /// Optional caller-requested row cap; always clamped to
    /// `QUERY_MAX_ROWS`.
    limit: Option<u64>,
}

/// Errors surfaced by the `/query` handler, each mapped to a specific HTTP
/// status.
#[derive(Debug)]
enum ApiError {
    /// Missing/invalid `Authorization` header -> `401`.
    Unauthorized,
    /// SQL failed validation, or ClickHouse rejected it for a caller-facing
    /// reason (timeout/row cap) -> `400`.
    BadRequest(String),
    /// Anything else ClickHouse-side -> `502`.
    BadGateway(String),
    /// The concurrent-query semaphore is exhausted -> `429`.
    TooManyRequests(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::BadGateway(msg) => (StatusCode::BAD_GATEWAY, msg),
            ApiError::TooManyRequests(msg) => (StatusCode::TOO_MANY_REQUESTS, msg),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<ValidationError> for ApiError {
    fn from(e: ValidationError) -> Self {
        ApiError::BadRequest(e.to_string())
    }
}

impl From<ClickHouseQueryError> for ApiError {
    fn from(e: ClickHouseQueryError) -> Self {
        match e {
            ClickHouseQueryError::Rejected(msg) => ApiError::BadRequest(msg),
            ClickHouseQueryError::Upstream(msg) => ApiError::BadGateway(msg),
        }
    }
}

async fn health() -> &'static str {
    "ok"
}

/// Constant-time comparison of two byte strings — deliberately not `==` on
/// the raw bytes, so a timing side-channel can't help an attacker guess
/// `INTERNAL_QUERY_SECRET` byte-by-byte. Unequal lengths short-circuit to
/// `false` (this only leaks that a length mismatch occurred, not which byte
/// differed, and the secret is a fixed-length internal token, not a
/// user-facing password).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the bearer token from `Authorization: Bearer <token>` and check it
/// against the configured internal secret in constant time.
fn authorize(headers: &HeaderMap, expected_secret: &str) -> Result<(), ApiError> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;

    let token = header
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;

    if constant_time_eq(token.as_bytes(), expected_secret.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

/// Try to acquire a permit from the concurrent-query semaphore, mapping
/// exhaustion to a caller-facing `429`. The returned permit is tied to
/// `semaphore`'s lifetime and must be held for the duration of the request —
/// it's released (returning the slot to the pool) when dropped.
fn acquire_permit(semaphore: &Semaphore) -> Result<SemaphorePermit<'_>, ApiError> {
    semaphore.try_acquire().map_err(|_| {
        ApiError::TooManyRequests("too many concurrent queries, try again shortly".to_string())
    })
}

async fn query_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<QueryRequest>,
) -> Result<Json<QueryResult>, ApiError> {
    authorize(&headers, &state.config.internal_query_secret)?;
    let _permit = acquire_permit(&state.query_semaphore)?;

    let rewritten = validate::validate_and_rewrite(&req.sql, &req.project_id)?;

    let limit = req
        .limit
        .unwrap_or(state.config.max_rows)
        .min(state.config.max_rows);
    let wrapped = format!("SELECT * FROM ({rewritten}) AS _explorer_result LIMIT {limit}");

    let result = state.clickhouse.execute(&wrapped).await?;
    Ok(Json(result))
}

/// Build the router. Split out from `main.rs` so it can be exercised
/// directly in tests without booting a real ClickHouse connection.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/query", post(query_handler))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_equal_slices() {
        assert!(constant_time_eq(b"secret123", b"secret123"));
    }

    #[test]
    fn constant_time_eq_rejects_different_slices() {
        assert!(!constant_time_eq(b"secret123", b"secret124"));
    }

    #[test]
    fn constant_time_eq_rejects_different_lengths() {
        assert!(!constant_time_eq(b"short", b"much longer value"));
    }

    #[test]
    fn authorize_rejects_missing_header() {
        let headers = HeaderMap::new();
        assert!(authorize(&headers, "expected-secret").is_err());
    }

    #[test]
    fn authorize_rejects_wrong_secret() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer wrong-secret".parse().unwrap(),
        );
        assert!(authorize(&headers, "expected-secret").is_err());
    }

    #[test]
    fn authorize_accepts_correct_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer expected-secret".parse().unwrap(),
        );
        assert!(authorize(&headers, "expected-secret").is_ok());
    }

    #[test]
    fn acquire_permit_succeeds_while_capacity_remains() {
        let semaphore = Semaphore::new(2);
        assert!(acquire_permit(&semaphore).is_ok());
        assert!(acquire_permit(&semaphore).is_ok());
    }

    #[test]
    fn acquire_permit_returns_too_many_requests_when_exhausted() {
        let semaphore = Semaphore::new(1);
        let _held = acquire_permit(&semaphore).expect("first acquire should succeed");

        let err = acquire_permit(&semaphore).expect_err("semaphore should be exhausted");
        assert!(matches!(err, ApiError::TooManyRequests(_)));
    }

    #[test]
    fn acquire_permit_succeeds_again_after_permit_is_dropped() {
        let semaphore = Semaphore::new(1);
        {
            let _held = acquire_permit(&semaphore).expect("first acquire should succeed");
            assert!(acquire_permit(&semaphore).is_err());
        }
        assert!(acquire_permit(&semaphore).is_ok());
    }
}
