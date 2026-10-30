//! Loading ACTIVE survey configs for a project from Postgres.
//!
//! Mirrors `flags/store.rs`: a runtime `sqlx::query_as` (no compile-time DB /
//! `SQLX_OFFLINE` needed), reading the jsonb `definition` as text (`::text`) to
//! avoid the sqlx `json` feature — the endpoint parses it back to a JSON value.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::state::AppState;

/// Process-local TTL in front of the Postgres `Survey ⋈ FeatureFlag` read.
///
/// The SDK background-polls `/v1/surveys` (~every 5 min) so a long-lived page
/// picks up newly-published surveys without a reload. That turns a page open
/// into a *periodic* request from every live client, and each one would
/// otherwise re-run the `Survey ⋈ FeatureFlag` join. Survey config is
/// low-churn and the SDK version-gates its own client cache, so ~30s of
/// staleness between a dashboard edit and clients observing it is acceptable —
/// the same write-then-read convergence-window trade already made in
/// `schema.rs` and `auth.rs`.
///
/// CRUCIAL DIFFERENCE from `schema.rs`: that cache's source of truth is Redis
/// and it fails *open* to an empty map, so caching a lookup failure is a safe
/// default. Here the source of truth IS Postgres, so a query ERROR must NOT be
/// cached — it propagates to the caller and the next request retries the DB.
/// Only successful reads populate this cache.
const LOCAL_CACHE_TTL: Duration = Duration::from_secs(30);

/// One ACTIVE survey's static config, as read from Postgres.
#[derive(Debug, Clone)]
pub struct SurveyRow {
    /// Survey id (app ULID).
    pub id: String,
    /// The versioned `definition` jsonb, still serialized as text.
    pub definition: String,
    /// Bumped on every edit; the SDK caches config and short-circuits on it.
    pub version: i32,
    /// The linked `FeatureFlag.key` the SDK gates display on.
    pub flag_key: String,
}

struct CacheEntry {
    fetched_at: Instant,
    surveys: Arc<Vec<SurveyRow>>,
}

fn local_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Load every ACTIVE, non-deleted survey for `project_id`: process-local cache
/// (30s TTL) -> Postgres `Survey ⋈ FeatureFlag` read.
///
/// Draft/archived surveys are excluded server-side: `/v1/surveys`
/// returns active only) so a draft never reaches the SDK. `deletedAt IS NULL`
/// drops soft-deleted surveys.
///
/// A query error propagates rather than populating the cache, so the next
/// request retries Postgres instead of serving a cached failure.
pub async fn load_active_surveys(
    state: &AppState,
    project_id: &str,
) -> anyhow::Result<Arc<Vec<SurveyRow>>> {
    // Scope the guard so the std Mutex is never held across the `.await` below.
    {
        if let Some(entry) = local_cache().lock().unwrap().get(project_id) {
            if entry.fetched_at.elapsed() < LOCAL_CACHE_TTL {
                return Ok(entry.surveys.clone());
            }
        }
    }

    let surveys = Arc::new(query_active_surveys(state, project_id).await?);

    local_cache().lock().unwrap().insert(
        project_id.to_string(),
        CacheEntry {
            fetched_at: Instant::now(),
            surveys: surveys.clone(),
        },
    );

    Ok(surveys)
}

/// Raw Postgres read of `project_id`'s ACTIVE surveys — the uncached body,
/// split out of [`load_active_surveys`] the same way `schema.rs` splits its
/// raw fetch from the cached wrapper.
async fn query_active_surveys(
    state: &AppState,
    project_id: &str,
) -> anyhow::Result<Vec<SurveyRow>> {
    let rows: Vec<(String, String, i32, String)> = sqlx::query_as(
        r#"SELECT s."id", s."definition"::text, s."version", f."key" AS flag_key
           FROM "Survey" s
           JOIN "FeatureFlag" f ON f."id" = s."featureFlagId"
           WHERE s."projectId" = $1 AND s."status" = 'active' AND s."deletedAt" IS NULL"#,
    )
    .bind(project_id)
    .fetch_all(&state.pg)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, definition, version, flag_key)| SurveyRow {
            id,
            definition,
            version,
            flag_key,
        })
        .collect())
}
