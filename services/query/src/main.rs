//! query-rs — Axum server for the SQL Explorer.
//!
//! `GET /health` — liveness probe (unversioned, unauthenticated).
//! `POST /query` — validate + rewrite tenant-authored SQL into a
//! project-scoped, read-only ClickHouse query and execute it. See
//! `validate.rs` for the security core and `http.rs` for the request
//! pipeline. Bound to the internal network — never exposed publicly.

mod clickhouse;
mod config;
mod http;
mod validate;

use std::{net::SocketAddr, sync::Arc};

use crate::{clickhouse::ClickHouseClient, config::Config, http::AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Must be the first statement: rustls panics on the first `ClientConfig::builder()`
    // when more than one crypto backend is compiled in and no process-level provider has
    // been installed. The Dockerfile runs `cargo chef prepare` at the workspace root, so
    // deps are built with workspace-unified features — both `ring` (ours, via reqwest)
    // and `aws-lc-rs` (pulled in by the AWS SDK crates for S3 support attachments) end up
    // enabled. `ingest` already died this way in prod (exit 101 → ECS circuit breaker →
    // full rollback). Pinning it explicitly makes the binary immune to feature unification.
    // `ring` matches the backend the other services get from sqlx (`tls-rustls-ring-webpki`).
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

    let config = Config::from_env()?;
    tracing::info!(port = config.port, "query-rs starting");

    let clickhouse = ClickHouseClient::new(&config)?;
    clickhouse.ping().await?;
    tracing::info!(url = %config.clickhouse_url, user = %config.clickhouse_user, "connected to ClickHouse");

    let query_semaphore = Arc::new(tokio::sync::Semaphore::new(config.max_concurrency));
    let state = AppState {
        config: Arc::new(config),
        clickhouse,
        query_semaphore,
    };

    let port = state.config.port;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("query-rs listening on {addr}");
    axum::serve(listener, http::app(state)).await?;
    Ok(())
}
