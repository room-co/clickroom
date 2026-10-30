//! `GET /flags/version` — cheap version-check for SDK poll (A).
//!
//! Auth: write key, same as `POST /flags` — this endpoint gates the
//! customer SDK's poll loop, which already authenticates with a write key.
//! Unlike `POST /flags`, this does NOT evaluate any flag or record an
//! exposure: it exists so the SDK can cheaply check "has anything changed?"
//! before paying for a full evaluate + exposure-capture round trip.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::{json, Value};

use crate::{
    auth::{resolve_write_key, AuthError},
    capture::{extract_token, TokenQuery},
    error::ApiError,
    flags::store::{load_defs, Blob},
    state::AppState,
};

/// Build the `{ "version": N }` response body from a loaded [`Blob`].
///
/// Factored out from the handler so it's unit-testable without needing a
/// real Redis/Postgres/auth stack (this crate has no integration-test
/// harness for full Axum handlers — see `capture.rs`'s `mod tests`).
fn version_response(blob: &Blob) -> Value {
    json!({ "version": blob.version })
}

/// `GET /flags/version`.
pub async fn flags_version_endpoint(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // 1. Authenticate (write key — matches POST /flags, not read key).
    let token = extract_token(&headers, &query).ok_or(ApiError::Unauthorized)?;
    let resolved = match resolve_write_key(&state, &token).await {
        Ok(resolved) => resolved,
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    // 2. Load defs and return only the version — no evaluate, no exposure
    // capture, no NATS publish.
    let blob = load_defs(&state, &resolved.project_id, &resolved.env).await?;
    Ok(Json(version_response(&blob)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flags::eval::FlagDef;
    use crate::flags::property::Filters;

    fn blob_with_version(version: i64) -> Blob {
        Blob {
            version,
            flags: vec![FlagDef {
                key: "k".into(),
                active: true,
                track: false,
                filters: Filters::default(),
                version,
            }],
        }
    }

    #[test]
    fn version_response_returns_only_version() {
        let blob = blob_with_version(42);
        let value = version_response(&blob);
        assert_eq!(value, json!({ "version": 42 }));
    }

    #[test]
    fn version_response_omits_flags() {
        let blob = blob_with_version(7);
        let value = version_response(&blob);
        assert!(value.get("flags").is_none());
    }
}
