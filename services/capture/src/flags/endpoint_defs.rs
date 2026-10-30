//! `GET /flag-definitions` — return the project's flag blob ().
//!
//! Auth: read key. Response: `{ "flags": [{ key, active, filters }...],
//! "version": N }` (per-flag `version` dropped; top-level kept).

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::{json, Value};

use crate::{
    auth::{resolve_read_key, AuthError},
    capture::{extract_token, TokenQuery},
    error::ApiError,
    flags::store::load_defs,
    quota,
    state::AppState,
};

/// `GET /flag-definitions`.
pub async fn flag_definitions_endpoint(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // 1. Authenticate (read key).
    let token = extract_token(&headers, &query).ok_or(ApiError::Unauthorized)?;
    let resolved = match resolve_read_key(&state, &token).await {
        Ok(resolved) => resolved,
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    // 2. Load defs; project to { key, active, filters }.
    let blob = load_defs(&state, &resolved.project_id, &resolved.env).await?;
    let flags: Vec<Value> = blob
        .flags
        .iter()
        .map(|f| {
            json!({
                "key": f.key,
                "active": f.active,
                "filters": f.filters,
            })
        })
        .collect();

    // 3. Enforce the org's monthly flag-eval quota, counting one per flag
    // returned. Hard-blocking flag reads can degrade a consuming app that
    // fails closed on evaluation — `QUOTA_ENFORCE` is the deliberate,
    // default-on-but-flippable escape hatch for that risk.
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

    Ok(Json(json!({
        "flags": flags,
        "version": blob.version,
    })))
}
