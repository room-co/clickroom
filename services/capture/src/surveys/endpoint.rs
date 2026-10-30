//! `GET /v1/surveys` — return the project's ACTIVE survey configs (//!.
//!
//! Auth: write key (same path as `POST /flags`). Response:
//! `{ "surveys": [{ id, definition, version, linkedFlagKey }] }` — `definition`
//! is the parsed JSON value, `linkedFlagKey` is camelCase to match the SDK
//! parse shape. Static Postgres read; **no eval logic**.

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Serialize;
use serde_json::Value;

use crate::{
    auth::{resolve_write_key, AuthError},
    capture::{extract_token, TokenQuery},
    error::ApiError,
    state::AppState,
    surveys::store::load_active_surveys,
};

/// One survey in the `/v1/surveys` response.
#[derive(Debug, Serialize)]
struct SurveyOut {
    /// Survey id (app ULID).
    id: String,
    /// The parsed `definition` config (questions/appearance/triggers).
    definition: Value,
    /// Config version; the SDK caches on it and short-circuits unchanged fetches.
    version: i32,
    /// The linked `FeatureFlag.key` the SDK gates display on.
    #[serde(rename = "linkedFlagKey")]
    linked_flag_key: String,
}

/// `GET /v1/surveys`.
pub async fn surveys_endpoint(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // 1. Authenticate (write key — same as POST /flags).
    let token = extract_token(&headers, &query).ok_or(ApiError::Unauthorized)?;
    let resolved = match resolve_write_key(&state, &token).await {
        Ok(resolved) => resolved,
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    // 2. Static Postgres read of the project's ACTIVE surveys.
    let rows = load_active_surveys(&state, &resolved.project_id).await?;

    // 3. Parse each stored `definition` text back to a JSON value. A row whose
    // definition somehow fails to parse is skipped rather than failing the whole
    // fetch — one bad config must not blank every survey for the project.
    let surveys: Vec<SurveyOut> = rows
        .iter()
        .filter_map(|row| match serde_json::from_str::<Value>(&row.definition) {
            Ok(definition) => Some(SurveyOut {
                id: row.id.clone(),
                definition,
                version: row.version,
                linked_flag_key: row.flag_key.clone(),
            }),
            Err(e) => {
                tracing::warn!(
                    "skipping survey {} with unparseable definition: {e}",
                    row.id
                );
                None
            }
        })
        .collect();

    Ok(Json(serde_json::json!({ "surveys": surveys })))
}
