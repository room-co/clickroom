//! Shared application state injected into every handler.

use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::config::Config;

/// Handles to every backing service, cheaply clonable (all fields are
/// reference-counted / pooled connections).
#[derive(Clone)]
pub struct AppState {
    /// Postgres pool (write-key fallback lookups).
    pub pg: sqlx::PgPool,
    /// Redis connection manager (key cache + rate-limit buckets).
    pub redis: redis::aio::ConnectionManager,
    /// JetStream publish context.
    pub jetstream: async_nats::jetstream::Context,
    /// Core NATS client (the connection JetStream is layered on).
    ///
    /// Used only by the support webhook path: the delivery's
    /// durable record is the `SupportWebhookDelivery` row, and this
    /// notification just saves the ingest worker a sweep interval. Core NATS
    /// (fire-and-forget, no stream, no ack) is the right fit — a JetStream
    /// publish would need its own stream purely to carry a hint that is safe
    /// to lose.
    pub nats_core: async_nats::Client,
    /// Immutable runtime config.
    pub config: Arc<Config>,
    /// Process-wide cap on concurrent in-flight NATS publish+ack pairs.
    /// Sized from `config.nats_max_concurrent_publishes`. Shared (not
    /// per-request) so it bounds saturation of the single shared JetStream
    /// connection across *all* concurrent `/capture` requests, not just
    /// within one batch.
    pub nats_publish_semaphore: Arc<Semaphore>,
}
