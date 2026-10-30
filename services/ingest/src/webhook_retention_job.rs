//! Support webhook retention purge job.
//!
//! A background tokio task on a fixed interval, modelled on `volume_job`:
//! env-gated `spawn`, `tokio::time::interval`, one `run_once` per tick, errors
//! logged and never propagated so a transient Postgres fault retries on the
//! next tick rather than crashing the process.
//!
//! What it removes, and what it deliberately does not:
//!
//! * **Pass one** nulls the four body/header columns on `SupportWebhookAttempt`
//!   and stamps `bodiesPurgedAt`. `attempt`, `latencyMs`, `responseCode`,
//!   `outcome` and `createdAt` survive — which is precisely what makes the
//!   health rollup purge-invariant: an aged delivery still counts, with
//!   its real latency and status, it just no longer carries the customer's
//!   ticket body.
//! * **Pass two** replaces `SupportWebhookDelivery.payload` with `'{}'`. The
//!   payload is the source of the request body and carries the requester's
//!   email address.
//! * **Pass three** hard-deletes delivery rows outright. Built, but **off by
//!   default** (`INGEST_WEBHOOK_DELIVERY_DELETE_DAYS=0` = never).
//!
//! Rows with `status='pending'` are never touched by any pass
//! constraint 6): those bytes are what an in-flight retry is about to sign and
//! send, so purging them would corrupt a delivery rather than age it out.
//!
//! Every pass is batched at `PURGE_BATCH_SIZE` rows per statement and looped
//! until a statement matches nothing, so one tick never takes a lock over a
//! multi-million-row range while the delivery worker is trying to write.

use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;

use crate::config::Config;

/// Rows touched per statement. The loop repeats until a statement matches
/// nothing, so this bounds lock duration, not total work per tick.
const PURGE_BATCH_SIZE: i64 = 5000;

/// Ceiling on batches per pass per tick (25M rows). A runaway loop here would
/// hold the pool for the whole tick; the leftovers are simply purged on the
/// next one.
const MAX_BATCHES_PER_PASS: usize = 5_000;

/// Pass one: null the purgeable body/header columns on aged attempt rows and
/// stamp `bodiesPurgedAt`. `bodiesPurgedAt IS NULL` is both the "not yet done"
/// predicate and the loop's termination condition.
const PURGE_ATTEMPT_BODIES_SQL: &str = r#"
UPDATE "SupportWebhookAttempt"
   SET "requestBody" = NULL,
       "requestHeaders" = NULL,
       "responseBody" = NULL,
       "responseHeaders" = NULL,
       "bodiesPurgedAt" = now()
 WHERE "id" IN (
   SELECT "id" FROM "SupportWebhookAttempt"
    WHERE "createdAt" < now() - make_interval(days => $1)
      AND "bodiesPurgedAt" IS NULL
    LIMIT $2
 )
"#;

/// Pass two: blank the delivery payload. `status <> 'pending'` is constraint 6;
/// `payload <> '{}'::jsonb` is what terminates the loop (there is no
/// `payloadPurgedAt` column, so already-blanked rows must exclude themselves).
const PURGE_DELIVERY_PAYLOADS_SQL: &str = r#"
UPDATE "SupportWebhookDelivery"
   SET "payload" = '{}'::jsonb
 WHERE "id" IN (
   SELECT "id" FROM "SupportWebhookDelivery"
    WHERE "createdAt" < now() - make_interval(days => $1)
      AND "status" <> 'pending'
      AND "payload" <> '{}'::jsonb
    LIMIT $2
 )
"#;

/// Pass three (off by default): hard-delete aged, non-pending deliveries and
/// their attempts. One statement so the child rows can never outlive their
/// parent — `SupportWebhookAttempt.deliveryId` has no `ON DELETE CASCADE`.
const DELETE_DELIVERIES_SQL: &str = r#"
WITH doomed AS (
  SELECT "id" FROM "SupportWebhookDelivery"
   WHERE "createdAt" < now() - make_interval(days => $1)
     AND "status" <> 'pending'
   LIMIT $2
), deleted_attempts AS (
  DELETE FROM "SupportWebhookAttempt"
   WHERE "deliveryId" IN (SELECT "id" FROM doomed)
)
DELETE FROM "SupportWebhookDelivery"
 WHERE "id" IN (SELECT "id" FROM doomed)
"#;

/// Spawn the recurring retention job. Returns immediately; the task runs until
/// the process exits. A no-op (never spawns) when
/// `webhook_retention_enabled` is false.
pub fn spawn(pg: PgPool, cfg: Arc<Config>) {
    if !cfg.webhook_retention_enabled {
        tracing::info!("webhook retention job disabled (INGEST_WEBHOOK_RETENTION_ENABLED=false)");
        return;
    }

    let interval = Duration::from_secs(cfg.webhook_retention_interval_secs.max(1));
    let retention_days = cfg.webhook_retention_days;
    let delete_days = cfg.webhook_delivery_delete_days;
    tracing::info!(
        interval_secs = cfg.webhook_retention_interval_secs,
        retention_days,
        delete_days,
        "webhook retention job enabled"
    );

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            match run_once(&pg, retention_days, delete_days).await {
                Ok(summary) => tracing::info!(
                    attempt_bodies_purged = summary.attempt_bodies_purged,
                    delivery_payloads_purged = summary.delivery_payloads_purged,
                    deliveries_deleted = summary.deliveries_deleted,
                    "webhook retention run complete"
                ),
                // Guard: a job error must never crash the process.
                Err(e) => {
                    tracing::error!(error = %e, "webhook retention run failed (will retry)")
                }
            }
        }
    });
}

/// Row counts from a single retention run.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RetentionSummary {
    pub attempt_bodies_purged: u64,
    pub delivery_payloads_purged: u64,
    pub deliveries_deleted: u64,
}

/// Execute one full retention pass. `delete_days == 0` disables the hard-delete
/// tier entirely (the documented default), rather than meaning "delete
/// everything older than zero days".
pub async fn run_once(
    pg: &PgPool,
    retention_days: i32,
    delete_days: i32,
) -> anyhow::Result<RetentionSummary> {
    let attempt_bodies_purged = purge_batched(pg, PURGE_ATTEMPT_BODIES_SQL, retention_days).await?;
    let delivery_payloads_purged =
        purge_batched(pg, PURGE_DELIVERY_PAYLOADS_SQL, retention_days).await?;
    let deliveries_deleted = if delete_days > 0 {
        purge_batched(pg, DELETE_DELIVERIES_SQL, delete_days).await?
    } else {
        0
    };

    Ok(RetentionSummary {
        attempt_bodies_purged,
        delivery_payloads_purged,
        deliveries_deleted,
    })
}

/// Run one batched statement until it matches nothing, returning the total rows
/// affected. `sql` is `&'static str` because sqlx 0.9 rejects runtime query
/// strings; every caller passes one of the consts above.
async fn purge_batched(pg: &PgPool, sql: &'static str, days: i32) -> anyhow::Result<u64> {
    let mut total = 0u64;
    for _ in 0..MAX_BATCHES_PER_PASS {
        let affected = sqlx::query(sql)
            .bind(days)
            .bind(PURGE_BATCH_SIZE)
            .execute(pg)
            .await?
            .rows_affected();
        total += affected;
        if affected == 0 {
            return Ok(total);
        }
    }
    tracing::warn!(
        rows = total,
        "webhook retention hit the per-pass batch ceiling; remainder purged next tick"
    );
    Ok(total)
}

#[cfg(test)]
mod tests {
    //! Live-Postgres tests, following the skip-when-unreachable convention of
    //! `identity.rs` (there is no DB test harness in `services/ingest`; these
    //! skip rather than fail so `cargo test` stays green without docker infra).
    //! Requires the `20260726120000_add_support_webhook_attempts` migration.
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::Row;
    use uuid::Uuid;

    /// Strip Prisma-style query params sqlx does not understand, matching
    /// `config::sanitize_db_url`.
    fn test_database_url() -> String {
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://clickroom:clickroom@localhost:5433/clickroom".into());
        match url.split_once('?') {
            Some((base, _)) => base.to_string(),
            None => url,
        }
    }

    /// A pool only when Postgres is up *and* carries attempt table.
    async fn live_pool() -> Option<PgPool> {
        let pool = match PgPoolOptions::new()
            .max_connections(2)
            .connect(&test_database_url())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipping webhook retention test: Postgres not reachable ({e})");
                return None;
            }
        };
        let exists: Option<String> =
            sqlx::query_scalar(r#"SELECT to_regclass('public."SupportWebhookAttempt"')::text"#)
                .fetch_one(&pool)
                .await
                .ok()
                .flatten();
        if exists.is_none() {
            eprintln!("skipping webhook retention test: SupportWebhookAttempt not migrated");
            return None;
        }
        Some(pool)
    }

    struct Fixture {
        webhook_id: String,
        org_id: String,
        project_id: String,
    }

    /// Fresh org/project/webhook per test so parallel runs never collide.
    async fn seed_webhook(pg: &PgPool) -> anyhow::Result<Fixture> {
        let suffix = Uuid::now_v7().to_string();
        let org_id = format!("org_ret_{suffix}");
        let project_id = format!("proj_ret_{suffix}");
        let webhook_id = format!("whk_ret_{suffix}");

        sqlx::query(
            r#"INSERT INTO "Org" ("id", "name", "slug", "updatedAt")
               VALUES ($1, 'retention test', $2, now())"#,
        )
        .bind(&org_id)
        .bind(&org_id)
        .execute(pg)
        .await?;
        sqlx::query(
            r#"INSERT INTO "Project" ("id", "orgId", "name", "updatedAt")
               VALUES ($1, $2, 'retention test', now())"#,
        )
        .bind(&project_id)
        .bind(&org_id)
        .execute(pg)
        .await?;
        sqlx::query(
            r#"INSERT INTO "SupportWebhook" ("id", "projectId", "url", "secret", "updatedAt")
               VALUES ($1, $2, 'https://example.test/hook', 'enc', now())"#,
        )
        .bind(&webhook_id)
        .bind(&project_id)
        .execute(pg)
        .await?;

        Ok(Fixture {
            webhook_id,
            org_id,
            project_id,
        })
    }

    async fn cleanup(pg: &PgPool, fx: &Fixture) {
        let _ = sqlx::query(r#"DELETE FROM "SupportWebhookAttempt" WHERE "webhookId" = $1"#)
            .bind(&fx.webhook_id)
            .execute(pg)
            .await;
        let _ = sqlx::query(r#"DELETE FROM "SupportWebhookDelivery" WHERE "webhookId" = $1"#)
            .bind(&fx.webhook_id)
            .execute(pg)
            .await;
        let _ = sqlx::query(r#"DELETE FROM "SupportWebhook" WHERE "id" = $1"#)
            .bind(&fx.webhook_id)
            .execute(pg)
            .await;
        let _ = sqlx::query(r#"DELETE FROM "Project" WHERE "id" = $1"#)
            .bind(&fx.project_id)
            .execute(pg)
            .await;
        let _ = sqlx::query(r#"DELETE FROM "Org" WHERE "id" = $1"#)
            .bind(&fx.org_id)
            .execute(pg)
            .await;
    }

    /// One delivery plus one attempt, both aged `age_days` into the past.
    /// Timestamps go in as SQL expressions because the `chrono` sqlx feature is
    /// not enabled in this crate.
    async fn seed_delivery(
        pg: &PgPool,
        fx: &Fixture,
        status: &str,
        age_days: i32,
    ) -> anyhow::Result<(String, String)> {
        let suffix = Uuid::now_v7().to_string();
        let delivery_id = format!("dlv_{suffix}");
        let attempt_id = format!("att_{suffix}");

        sqlx::query(
            r#"INSERT INTO "SupportWebhookDelivery"
               ("id", "webhookId", "event", "payload", "status", "attempts",
                "nextAttemptAt", "createdAt", "updatedAt")
               VALUES ($1, $2, 'ticket.created', '{"email":"a@b.test"}'::jsonb, $3, 1,
                       now(), now() - make_interval(days => $4), now())"#,
        )
        .bind(&delivery_id)
        .bind(&fx.webhook_id)
        .bind(status)
        .bind(age_days)
        .execute(pg)
        .await?;

        sqlx::query(
            r#"INSERT INTO "SupportWebhookAttempt"
               ("id", "deliveryId", "webhookId", "attempt", "startedAt", "latencyMs",
                "responseCode", "outcome", "requestHeaders", "requestBody",
                "responseHeaders", "responseBody", "createdAt")
               VALUES ($1, $2, $3, 1, now(), 214, 200, 'delivered',
                       '{"x-clickroom-signature":"t=1,v1=abc"}'::jsonb, '{"email":"a@b.test"}',
                       '{"content-type":"application/json"}'::jsonb, 'ok',
                       now() - make_interval(days => $4))"#,
        )
        .bind(&attempt_id)
        .bind(&delivery_id)
        .bind(&fx.webhook_id)
        .bind(age_days)
        .execute(pg)
        .await?;

        Ok((delivery_id, attempt_id))
    }

    #[tokio::test]
    async fn purges_aged_bodies_and_keeps_the_statistics() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");
        let (delivery_id, attempt_id) = seed_delivery(&pg, &fx, "delivered", 40)
            .await
            .expect("seed delivery");

        // Assert on row state, not the purge counters: the passes are global, so
        // a concurrently-running test's `run_once` can be the one that credits
        // these rows. `deliveries_deleted` stays exact — at 0 days pass three
        // never runs at all.
        let summary = run_once(&pg, 30, 0).await.expect("run_once");
        assert_eq!(
            summary.deliveries_deleted, 0,
            "hard delete is off at 0 days"
        );

        // jsonb and timestamp columns are read as text / bool: neither the
        // `json` nor the `chrono` sqlx feature is enabled in this crate.
        let row = sqlx::query(
            r#"SELECT "requestBody", "responseBody",
                      "requestHeaders"::text  AS request_headers,
                      "responseHeaders"::text AS response_headers,
                      ("bodiesPurgedAt" IS NOT NULL) AS purged,
                      "latencyMs", "responseCode", "outcome", "attempt"
                 FROM "SupportWebhookAttempt" WHERE "id" = $1"#,
        )
        .bind(&attempt_id)
        .fetch_one(&pg)
        .await
        .expect("attempt row");

        assert_eq!(row.get::<Option<String>, _>("requestBody"), None);
        assert_eq!(row.get::<Option<String>, _>("responseBody"), None);
        assert_eq!(row.get::<Option<String>, _>("request_headers"), None);
        assert_eq!(row.get::<Option<String>, _>("response_headers"), None);
        assert!(row.get::<bool, _>("purged"));
        // The statistical columns are what makes health purge-invariant.
        assert_eq!(row.get::<i32, _>("latencyMs"), 214);
        assert_eq!(row.get::<Option<i32>, _>("responseCode"), Some(200));
        assert_eq!(row.get::<String, _>("outcome"), "delivered");
        assert_eq!(row.get::<i32, _>("attempt"), 1);

        let delivery = sqlx::query(
            r#"SELECT "payload"::text AS payload, "status", "attempts"
                 FROM "SupportWebhookDelivery" WHERE "id" = $1"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("delivery row");
        assert_eq!(delivery.get::<String, _>("payload"), "{}");
        assert_eq!(delivery.get::<String, _>("status"), "delivered");
        assert_eq!(delivery.get::<i32, _>("attempts"), 1);

        cleanup(&pg, &fx).await;
    }

    #[tokio::test]
    async fn never_touches_pending_payloads() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");
        // Aged well past every other test's fixtures: the passes are global, so
        // a shared `delete_days` window has to be one only this row falls into.
        let (delivery_id, _) = seed_delivery(&pg, &fx, "pending", 4000)
            .await
            .expect("seed delivery");

        // Hard delete on too, to prove pass three skips pending as well.
        run_once(&pg, 30, 3650).await.expect("run_once");

        let delivery = sqlx::query(
            r#"SELECT "payload"::text AS payload FROM "SupportWebhookDelivery" WHERE "id" = $1"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("pending delivery must still exist");
        assert_eq!(
            delivery.get::<String, _>("payload"),
            "{\"email\": \"a@b.test\"}",
            "an in-flight retry's payload must survive retention"
        );

        cleanup(&pg, &fx).await;
    }

    #[tokio::test]
    async fn leaves_rows_inside_the_window_alone() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");
        let (delivery_id, attempt_id) = seed_delivery(&pg, &fx, "delivered", 5)
            .await
            .expect("seed delivery");

        run_once(&pg, 30, 0).await.expect("run_once");

        let body: Option<String> = sqlx::query_scalar(
            r#"SELECT "requestBody" FROM "SupportWebhookAttempt" WHERE "id" = $1"#,
        )
        .bind(&attempt_id)
        .fetch_one(&pg)
        .await
        .expect("attempt row");
        assert!(body.is_some(), "a 5-day-old body is inside the 30d window");

        let payload: String = sqlx::query_scalar(
            r#"SELECT "payload"::text FROM "SupportWebhookDelivery" WHERE "id" = $1"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("delivery row");
        assert_ne!(payload, "{}");

        cleanup(&pg, &fx).await;
    }

    #[tokio::test]
    async fn hard_delete_removes_delivery_and_attempts_when_enabled() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");
        let (delivery_id, attempt_id) = seed_delivery(&pg, &fx, "failed", 400)
            .await
            .expect("seed delivery");

        let summary = run_once(&pg, 30, 365).await.expect("run_once");
        assert!(summary.deliveries_deleted >= 1);

        let deliveries: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM "SupportWebhookDelivery" WHERE "id" = $1"#)
                .bind(&delivery_id)
                .fetch_one(&pg)
                .await
                .expect("count");
        assert_eq!(deliveries, 0);

        let attempts: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM "SupportWebhookAttempt" WHERE "id" = $1"#)
                .bind(&attempt_id)
                .fetch_one(&pg)
                .await
                .expect("count");
        assert_eq!(
            attempts, 0,
            "child attempts must not outlive their delivery"
        );

        cleanup(&pg, &fx).await;
    }
}
