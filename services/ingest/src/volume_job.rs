//! Periodic per-project event volume + last-seen job.
//!
//! A background tokio task on a fixed interval. Each run fetches every project
//! id from Postgres, runs the trailing-30-day ClickHouse aggregate
//! (`count()` + `max(timestamp)` grouped by event) per project, and writes the
//! result back into `EventDefinition.volume30d` / `lastSeenAt` with a single
//! batched UPDATE per project (existing rows only — creation is left to the
//! discovery path in `taxonomy.rs`).
//!
//! Entirely off the hot path: the ingest consumer never touches volume on a
//! per-event basis. The task is spawned from `main.rs` and its errors are
//! caught per run, so a transient Postgres/ClickHouse fault logs and retries on
//! the next tick rather than crashing the process.

use std::sync::Arc;
use std::time::Duration;

use sqlx::{PgPool, QueryBuilder};

use crate::clickhouse::{ClickHouseClient, EventVolume};
use crate::config::Config;

/// Spawn the recurring volume job. Returns immediately; the task runs until the
/// process exits. A no-op (never spawns) when `volume_job_enabled` is false.
pub fn spawn(pg: PgPool, ch: ClickHouseClient, cfg: Arc<Config>) {
    if !cfg.volume_job_enabled {
        tracing::info!("volume job disabled (INGEST_VOLUME_JOB_ENABLED=false)");
        return;
    }

    let interval = Duration::from_secs(cfg.volume_job_interval_secs.max(1));
    tracing::info!(
        interval_secs = cfg.volume_job_interval_secs,
        "volume job enabled"
    );

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            match run_once(&pg, &ch).await {
                Ok(summary) => tracing::info!(
                    projects = summary.projects,
                    events_updated = summary.events_updated,
                    "volume job run complete"
                ),
                // Guard: a job error must never crash the process.
                Err(e) => tracing::error!(error = %e, "volume job run failed (will retry)"),
            }
        }
    });
}

/// Summary of a single volume-job run.
#[derive(Debug, Default)]
struct RunSummary {
    projects: usize,
    events_updated: u64,
}

/// Execute one full pass over all projects. A failure aggregating or updating a
/// single project is logged and skipped so one bad project can't sink the run.
async fn run_once(pg: &PgPool, ch: &ClickHouseClient) -> anyhow::Result<RunSummary> {
    let project_ids: Vec<String> = sqlx::query_scalar(r#"SELECT "id" FROM "Project""#)
        .fetch_all(pg)
        .await?;

    let mut summary = RunSummary {
        projects: project_ids.len(),
        events_updated: 0,
    };

    for project_id in &project_ids {
        let volumes = match ch.event_volumes(project_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(project_id, error = %e, "volume aggregate failed (skipped)");
                continue;
            }
        };
        if volumes.is_empty() {
            continue;
        }
        match update_event_defs(pg, project_id, &volumes).await {
            Ok(n) => summary.events_updated += n,
            Err(e) => {
                tracing::warn!(project_id, error = %e, "volume update failed (skipped)");
            }
        }
    }

    Ok(summary)
}

/// Batched UPDATE of `volume30d` + `lastSeenAt` for one project's events.
/// Updates existing `EventDefinition` rows only (matched by projectId+name);
/// unknown events are ignored (discovery creates them). Returns rows affected.
async fn update_event_defs(
    pg: &PgPool,
    project_id: &str,
    volumes: &[EventVolume],
) -> anyhow::Result<u64> {
    if volumes.is_empty() {
        return Ok(0);
    }

    let mut qb = QueryBuilder::new(
        r#"UPDATE "EventDefinition" AS d SET "volume30d" = v.vol, "lastSeenAt" = v.ls::timestamp, "updatedAt" = now() FROM ( "#,
    );
    qb.push_values(volumes, |mut b, vol| {
        b.push_bind(vol.event.as_str())
            .push_bind(vol.count)
            .push_bind(vol.last_seen.as_str());
    });
    qb.push(r#" ) AS v(name, vol, ls) WHERE d."projectId" = "#);
    qb.push_bind(project_id);
    qb.push(r#" AND d."name" = v.name"#);

    let result = qb.build().execute(pg).await?;
    Ok(result.rows_affected())
}
