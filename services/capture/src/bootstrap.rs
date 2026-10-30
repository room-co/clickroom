//! JetStream stream provisioning.
//!
//! Idempotently ensures the events stream exists on boot: file storage,
//! `WorkQueue` retention (a message is evicted once ingest's single durable
//! consumer acks it — no unbounded accumulation regardless of consumption),
//! bounded by `max_bytes`/`max_age` as a real backpressure ceiling if
//! ingest/ClickHouse falls behind for long enough to fill it, `<subject_prefix>.>`
//! subjects. The stream name and subject prefix default to `EVENTS` /
//! `events.raw` but are env-configurable (`CAPTURE_STREAM_NAME`,
//! `CAPTURE_SUBJECT_PREFIX`) so a separate e2e environment can run its own
//! isolated stream alongside dev.
//!
//! `WorkQueue` retention requires a single non-overlapping consumer view —
//! `services/ingest` is the only durable consumer on this stream, so it's
//! safe. JetStream cannot change `retention` on an existing stream in place
//! (`get_or_create_stream` won't update it either), so a retention change
//! here requires deleting and recreating the stream: stop capture-rs and
//! ingest-rs, delete `EVENTS` (e.g. `$JS.API.STREAM.DELETE.EVENTS`), restart
//! capture-rs (recreates the stream with the new config), then restart
//! ingest-rs (recreates its consumer against it). A fresh `make infra:reset`
//! sidesteps this since it wipes the NATS volume outright.

use std::time::Duration;

use async_nats::jetstream::{
    stream::{Config as StreamConfig, RetentionPolicy, StorageType},
    Context,
};

use crate::config::Config;

/// Ensure the events stream exists (get-or-create). Safe to call on every boot.
pub async fn ensure_stream(js: &Context, config: &Config) -> anyhow::Result<()> {
    let stream_name = &config.stream_name;
    let subjects = vec![format!("{}.>", config.subject_prefix)];

    let stream_config = StreamConfig {
        name: stream_name.clone(),
        subjects: subjects.clone(),
        storage: StorageType::File,
        retention: RetentionPolicy::WorkQueue,
        max_age: Duration::from_secs(config.stream_max_age_secs),
        // Real backpressure ceiling (was unbounded -1): if ingest/ClickHouse
        // falls behind long enough to fill this, further publishes fail and
        // capture returns 503 rather than growing memory unbounded.
        max_bytes: config.stream_max_bytes,
        max_messages: -1,
        ..Default::default()
    };

    let info = js.get_or_create_stream(stream_config).await?;
    tracing::info!(
        stream = %stream_name,
        subjects = ?subjects,
        messages = info.cached_info().state.messages,
        max_age_secs = config.stream_max_age_secs,
        max_bytes = config.stream_max_bytes,
        "JetStream stream ensured (WorkQueue retention)"
    );
    Ok(())
}
