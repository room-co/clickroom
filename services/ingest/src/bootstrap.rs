//! JetStream provisioning owned by ingest-rs.
//!
//! ingest owns the dead-letter queue, so it idempotently ensures the DLQ stream
//! exists on boot. Poison messages (unparseable payloads, or events that exhaust
//! their redelivery budget against a persistently failing insert) are published
//! to `events.dlq.<project_id>`; without a stream capturing those subjects the
//! publish would be dropped and its persist-ack would error. This stream makes
//! the DLQ durable and inspectable.

use std::time::Duration;

use async_nats::jetstream::{
    stream::{Config as StreamConfig, RetentionPolicy, StorageType},
    Context,
};

use crate::config::Config;

/// Ensure the DLQ stream exists (get-or-create). Safe to call on every boot.
/// Stream name defaults to `EVENTS_DLQ` but is env-configurable
/// (`INGEST_DLQ_STREAM_NAME`) so a separate e2e environment can run its own
/// isolated DLQ stream alongside the dev one without any code change.
pub async fn ensure_dlq_stream(js: &Context, config: &Config) -> anyhow::Result<()> {
    let stream_name = &config.dlq_stream_name;
    let stream_config = StreamConfig {
        name: stream_name.clone(),
        subjects: vec![format!("{}.>", config.dlq_subject_prefix)],
        storage: StorageType::File,
        retention: RetentionPolicy::Limits,
        max_age: Duration::from_secs(config.dlq_stream_max_age_secs),
        // Age is the primary bound for the DLQ; size caps unbounded for MVP.
        max_bytes: -1,
        max_messages: -1,
        ..Default::default()
    };

    let info = js.get_or_create_stream(stream_config).await?;
    tracing::info!(
        stream = %stream_name,
        messages = info.cached_info().state.messages,
        max_age_secs = config.dlq_stream_max_age_secs,
        "DLQ JetStream stream ensured"
    );
    Ok(())
}
