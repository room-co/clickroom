//! HTTP error type mapping to the capture API contract status codes.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Errors returned by the `/capture` handler, each mapping to a contract
/// status code.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Missing, invalid, or revoked write key -> `401`.
    #[error("invalid or missing write key")]
    Unauthorized,
    /// Body or batch exceeds the configured limits -> `413`.
    #[error("payload too large: {0}")]
    PayloadTooLarge(String),
    /// Malformed JSON or failing schema validation -> `400`.
    #[error("bad request: {0}")]
    BadRequest(String),
    /// Per-project rate limit exceeded -> `429` with `Retry-After`.
    #[error("rate limited")]
    RateLimited {
        /// Seconds the client should wait before retrying.
        retry_after: u64,
    },
    /// Org's monthly usage quota exceeded — `QUOTA_ENFORCE` on)
    /// -> `402`.
    #[error("quota exceeded")]
    QuotaExceeded,
    /// Unexpected backend failure (PG/Redis/NATS) -> `500`.
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
    /// Upstream (NATS JetStream publish/ack) did not complete within the
    /// configured timeout -> `503`. Distinct from `Internal` so a client can
    /// tell "the upstream is slow/stuck, retry" apart from "the request
    /// itself is broken".
    #[error("upstream publish timed out")]
    UpstreamTimeout,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            ApiError::PayloadTooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, self.to_string()),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::RateLimited { .. } => (StatusCode::TOO_MANY_REQUESTS, self.to_string()),
            ApiError::QuotaExceeded => (StatusCode::PAYMENT_REQUIRED, self.to_string()),
            ApiError::Internal(e) => {
                tracing::error!(error = %e, "capture internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
            }
            ApiError::UpstreamTimeout => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
        };

        let body = Json(json!({ "error": message }));

        if let ApiError::RateLimited { retry_after } = self {
            let mut resp = (status, body).into_response();
            resp.headers_mut().insert(
                header::RETRY_AFTER,
                retry_after
                    .to_string()
                    .parse()
                    .expect("retry_after is always a valid header value"),
            );
            return resp;
        }

        (status, body).into_response()
    }
}
