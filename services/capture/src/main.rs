//! capture-rs — Axum hot path.
//!
//! `GET /health`  — liveness probe (unversioned).
//! `GET /static/clickroom.js` — the browser SDK bundle (unversioned; see `sdk.rs`
//! for why the capture service, of all things, serves static JavaScript).
//! `POST /v1/capture` — authenticate write key, rate-limit, validate, and durably
//! publish events to NATS JetStream. Returns `202 { "accepted": N }` only after
//! the JetStream persist ack (durability boundary, AC-2).

mod auth;
mod bootstrap;
mod capture;
mod config;
mod error;
mod flags;
mod models;
mod nats;
mod quota;
mod ratelimit;
mod schema;
mod sdk;
mod state;
mod support;
mod surveys;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::DefaultBodyLimit,
    http::Method,
    routing::{get, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::{config::Config, state::AppState};

/// 1 MB request body cap (contract: over -> 413).
const MAX_BODY_BYTES: usize = 1024 * 1024;

async fn health() -> &'static str {
    "ok"
}

fn app(state: AppState) -> Router {
    let v1 = Router::new()
        .route("/capture", post(capture::capture))
        .route("/flags", post(flags::endpoint_flags::flags_endpoint))
        // Support writes. Registered inside this block so
        // they inherit the same oversize-body rejection as `/capture` —
        // `Router::layer` applies only to routes added *before* it.
        // POST creates a ticket; GET lists the identified user's own tickets
        // (project-key scoped by distinctId). Chained on one path so
        // both share this block's oversize-body rejection.
        .route(
            "/support/tickets",
            post(support::endpoint::create_ticket_endpoint)
                .get(support::endpoint::list_tickets_endpoint),
        )
        .route(
            "/support/tickets/:id/messages",
            post(support::endpoint::append_message_endpoint),
        )
        // End-user "mark solved", token-scoped.
        .route(
            "/support/tickets/:id/solve",
            post(support::endpoint::solve_ticket_endpoint),
        )
        .route(
            "/support/attachments/presign",
            post(support::endpoint::presign_endpoint),
        )
        // 413 on oversize bodies before the handler runs.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .route(
            "/flag-definitions",
            get(flags::endpoint_defs::flag_definitions_endpoint),
        )
        .route(
            "/flags/version",
            get(flags::endpoint_version::flags_version_endpoint),
        )
        // Static survey config read (write-key auth, same as POST /flags).
        .route("/surveys", get(surveys::endpoint::surveys_endpoint))
        // Static support form config read, plus the widget's ticket-token
        // scoped thread read.
        .route("/support", get(support::endpoint::support_config_endpoint))
        .route(
            "/support/tickets/:id",
            get(support::endpoint::get_ticket_endpoint),
        )
        // Token-scoped SSE for the widget. One-way
        // server->widget refetch ping; see support/stream.rs.
        .route(
            "/support/tickets/:id/stream",
            get(support::stream::ticket_stream_endpoint),
        );

    // Public endpoint, arbitrary customer domains as callers — cannot use a
    // fixed allowlist. `CorsLayer::permissive()` sends a literal
    // `Access-Control-Allow-Origin: *`, which browsers reject outright for
    // any credentialed request (`fetch(..., { credentials: 'include' })`,
    // and — critically — `navigator.sendBeacon()`, which is *always*
    // credentialed per spec with no way for the SDK to opt out). Mirroring
    // the request's own `Origin` back (same posture PostHog/Segment/Amplitude
    // ingestion endpoints use) satisfies both credentialed and
    // non-credentialed callers and is exactly as permissive as `*` for a
    // token-authenticated, cookie-free endpoint like this one. Not paired
    // with `allow_credentials(true)` — auth is the `?token=`/Bearer write
    // key, not cookies.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any);

    Router::new()
        .nest("/v1", v1)
        .route("/health", get(health))
        // Root-level, inside the `cors` layer below: the loader stub injects
        // `<script src="{api_host}/static/clickroom.js">` with no version segment,
        // and a cross-origin <script> fetch needs the mirrored Origin header the
        // CORS layer adds. Not under `/v1` — this is an asset, not an API.
        .route("/static/clickroom.js", get(sdk::sdk_bundle))
        .layer(cors)
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Two rustls 0.23 crypto backends end up enabled in this binary — `aws-lc-rs`
    // via the AWS SDK crates (S3 presigning for support attachments) and `ring`
    // via sqlx's `tls-rustls-ring-webpki`. With both on, rustls refuses to guess a
    // process-level provider and panics inside the first `ClientConfig::builder()`
    // — for us the Redis TLS connect. `ingest` took this exact panic in prod (exit
    // 101, ECS circuit breaker, full rollback); capture has only been spared
    // because the running image predates the AWS SDK dependency. `ring` is picked
    // to match the backend sqlx already links. Must be the very first statement:
    // anything that awaits or builds a TLS client before this wins the race.
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
    tracing::info!(port = config.port, "capture-rs starting");

    // A binary compiled without packages/sdk-js/dist/clickroom.js still boots and
    // still answers /static/clickroom.js — with a placeholder. That would silently
    // break every customer's install snippet, so say so at boot rather than making
    // someone diff the served bytes to find out. See sdk.rs / build.rs.
    if sdk::bundle_is_real() {
        tracing::info!("SDK bundle embedded; serving GET /static/clickroom.js");
    } else {
        tracing::warn!(
            "SDK bundle MISSING from this build — GET /static/clickroom.js will serve a \
             placeholder and customer installs will not work. The image must be built with \
             the SDK build stage (services/capture/Dockerfile)."
        );
    }

    // Postgres pool (write-key fallback).
    let pg = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await?;
    tracing::info!("connected to Postgres");

    // Redis (key cache + rate-limit buckets).
    let redis_client = redis::Client::open(config.redis_url.clone())?;
    let redis = redis::aio::ConnectionManager::new(redis_client).await?;
    tracing::info!("connected to Redis");

    // NATS JetStream.
    let nats_client = async_nats::connect(&config.nats_url).await?;
    let jetstream = async_nats::jetstream::new(nats_client.clone());
    tracing::info!("connected to NATS JetStream");

    // Ensure the events stream exists.
    bootstrap::ensure_stream(&jetstream, &config).await?;

    let nats_publish_semaphore = Arc::new(tokio::sync::Semaphore::new(
        config.nats_max_concurrent_publishes,
    ));

    let state = AppState {
        pg,
        redis,
        jetstream,
        nats_core: nats_client,
        config: Arc::new(config),
        nats_publish_semaphore,
    };

    let port = state.config.port;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("capture-rs listening on {addr}");
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
