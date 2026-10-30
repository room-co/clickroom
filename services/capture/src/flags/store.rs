//! Flag-definition loading (canonical ): Redis blob first, Postgres
//! fallback on miss. The TS server writes `flags:def:<project_id>:<env>` on
//! every flag write; Rust only reads it here.

use serde::{Deserialize, Serialize};

use super::eval::FlagDef;
use crate::flags::property::Filters;
use crate::state::AppState;

/// The per-project flag blob stored at `flags:def:<project_id>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blob {
    /// Sum of every included flag's `version` (changes on any write).
    pub version: i64,
    /// All non-deleted flags for the project (active AND inactive).
    pub flags: Vec<FlagDef>,
}

/// Load a project's flag definitions for a given env: Redis cache -> Postgres
/// fallback.
///
/// On a cache miss the blob is rebuilt from `FeatureFlag` rows with
/// `version = sum(version)`; the same shape the TS writer produces. A flag
/// simply not yet configured for `env` is not an error — an empty blob
/// (`version: 0, flags: []`) is returned, which evaluates as "doesn't exist"
/// (disabled) for every flag.
pub async fn load_defs(state: &AppState, project_id: &str, env: &str) -> anyhow::Result<Blob> {
    let cache_key = format!("flags:def:{project_id}:{env}");
    let mut redis = state.redis.clone();

    let cached: Option<String> = redis::cmd("GET")
        .arg(&cache_key)
        .query_async(&mut redis)
        .await?;

    if let Some(raw) = cached {
        return Ok(serde_json::from_str::<Blob>(&raw)?);
    }

    // Cache miss: rebuild from Postgres. `filters` is jsonb; read it as text
    // (`::text`) to avoid the sqlx `json` feature, then parse.
    let rows: Vec<(String, bool, String, i32, bool)> = sqlx::query_as(
        r#"SELECT f."key", f."active", f."filters"::text, f."version", f."track"
           FROM "FeatureFlag" f
           JOIN "Environment" e ON e.id = f."environmentId"
           WHERE f."projectId" = $1 AND e."key" = $2 AND f."deletedAt" IS NULL"#,
    )
    .bind(project_id)
    .bind(env)
    .fetch_all(&state.pg)
    .await?;

    let mut version: i64 = 0;
    let mut flags = Vec::with_capacity(rows.len());
    for (key, active, filters, ver, track) in rows {
        let filters: Filters = serde_json::from_str(&filters).unwrap_or_default();
        version += ver as i64;
        flags.push(FlagDef {
            key,
            active,
            track,
            filters,
            version: ver as i64,
        });
    }

    Ok(Blob { version, flags })
}
