//! ingest-rs — NATS JetStream pull consumer → batched ClickHouse insert.
//!
//! Drains the `EVENTS` stream (subjects `events.raw.>`) via a durable pull
//! consumer, batches messages by size or max-wait, maps each event to the
//! ClickHouse `events` schema, and does one batched INSERT per batch. Messages
//! are acked only after a successful insert (at-least-once); repeated insert
//! failures redeliver, and poison messages route to the DLQ after `max_deliver`
//! attempts. Dedup on redelivery is handled by ReplacingMergeTree.

mod bootstrap;
mod clickhouse;
mod config;
mod consumer;
mod enrich;
mod health;
mod identity;
mod infer;
mod models;
mod schema;
mod taxonomy;
mod volume_job;
mod webhook_job;
mod webhook_retention_job;
mod webhook_url;

use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;

use crate::{
    clickhouse::ClickHouseClient, config::Config, identity::Identity, schema::SchemaLookup,
    taxonomy::Taxonomy,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // The binary links a rustls 0.23 with *both* the `ring` and `aws-lc-rs`
    // backends enabled: the Dockerfile runs `cargo chef prepare` at the workspace
    // root, so the cooked deps carry the workspace-unified feature set. With two
    // backends compiled in, rustls refuses to guess and panics on the first
    // `ClientConfig::builder()` — in prod that was the Redis TLS connect, exit
    // 101, which tripped the ECS circuit breaker and rolled the deploy back.
    // Pick one explicitly, before anything can open a TLS connection. `ring` to
    // match the backend sqlx already uses (`tls-rustls-ring-webpki`).
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("failed to install rustls CryptoProvider");

    // Load repo-root .env for local dev (silently ignored in prod containers).
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    tracing::info!(
        batch_max_size = config.batch_max_size,
        batch_max_wait_ms = config.batch_max_wait_ms,
        "ingest-rs starting"
    );

    // ClickHouse HTTP client.
    let ch = ClickHouseClient::new(&config)?;
    ch.ping().await?;
    tracing::info!(url = %config.clickhouse_url, "connected to ClickHouse");

    // Postgres pool (taxonomy discovery + volume job).
    let pg = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;
    tracing::info!("connected to Postgres");

    // Redis: shared connection manager, reused by both the taxonomy discovery
    // guard (`tax:seen:<project_id>`) and warn-mode schema lookup
    // (`capture:schema:<project_id>`).
    let redis_client = redis::Client::open(config.redis_url.clone())?;
    let redis = redis::aio::ConnectionManager::new(redis_client).await?;
    tracing::info!("connected to Redis");

    // NATS JetStream.
    let nats_client = async_nats::connect(&config.nats_url).await?;
    // The webhook worker listens on a *core* subject, so keep a handle before
    // the client is wrapped for JetStream.
    let nats_core = nats_client.clone();
    let jetstream = async_nats::jetstream::new(nats_client);
    tracing::info!("connected to NATS JetStream");

    // Ensure the DLQ stream exists so poison messages durably land somewhere.
    bootstrap::ensure_dlq_stream(&jetstream, &config).await?;

    // Background per-project volume/last-seen job (off the hot path).
    volume_job::spawn(pg.clone(), ch.clone(), config.clone());

    // Support webhook delivery worker: durable sweep of pending deliveries plus
    // a core-NATS hint subscription for first-attempt latency.
    webhook_job::spawn(pg.clone(), nats_core, config.clone());

    // Support webhook retention purge: nulls aged attempt bodies and delivery
    // payloads, never touching `pending` rows.
    webhook_retention_job::spawn(pg.clone(), config.clone());

    // Redis-guarded taxonomy auto-discovery, run per batch after the CH insert.
    let taxonomy = Taxonomy::new(pg, redis.clone());

    // ClickHouse-only identity merge on `$identify` events,
    // run in the same best-effort pass as taxonomy discovery.
    let identity = Identity::new(ch.clone());

    // Warn-mode schema validation lookup, run per batch just before the CH
    // insert (see `schema.rs` / `consumer.rs`).
    let schema_lookup = SchemaLookup::new(redis);

    // Everything is connected: expose /health for container healthchecks.
    health::spawn().await?;

    // Run the consumer loop until fatal error / shutdown.
    let stream_name = config.stream_name.clone();
    consumer::run(
        jetstream,
        ch,
        taxonomy,
        identity,
        schema_lookup,
        config,
        &stream_name,
    )
    .await
}
