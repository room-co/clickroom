//! Durable JetStream pull-consumer loop: drain → insert → ack/nack → DLQ.
//!
//! Owns the at-least-once delivery contract for ingest-rs. A durable pull
//! consumer on the `EVENTS` stream is drained in batches bounded by size or a
//! max-wait window; each batch is mapped to ClickHouse rows and written with a
//! single INSERT. Messages are acked only after a successful insert, so a
//! ClickHouse outage redelivers rather than drops (ReplacingMergeTree dedups on
//! redelivery). Poison messages — payloads that fail to parse, or events that
//! exhaust `max_deliver` redelivery attempts against a persistently failing
//! insert — are routed to the DLQ and acked so they can't stall the stream.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use futures::StreamExt;

use async_nats::jetstream::consumer::{pull, AckPolicy};
use async_nats::jetstream::{AckKind, Context, Message};

use crate::{
    clickhouse::ClickHouseClient, config::Config, enrich, identity::Identity, models::RawEvent,
    schema::SchemaLookup, taxonomy::Taxonomy,
};

/// Run the durable pull-consumer loop forever: drain a batch, insert to
/// ClickHouse, ack on success, nack/redeliver on failure, route poison
/// messages to the DLQ after `max_deliver` attempts. Only returns on a fatal
/// (unrecoverable) error.
pub async fn run(
    js: Context,
    ch: ClickHouseClient,
    tax: Taxonomy,
    identity: Identity,
    schema: SchemaLookup,
    cfg: Arc<Config>,
    stream_name: &str,
) -> anyhow::Result<()> {
    let stream = js
        .get_stream(stream_name)
        .await
        .with_context(|| format!("get JetStream stream {stream_name}"))?;

    // Create-or-get the durable pull consumer. `..Default::default()` fills the
    // remaining (unused for MVP) knobs; explicit fields pin the delivery
    // contract.
    let consumer = stream
        .get_or_create_consumer(
            &cfg.durable_name,
            pull::Config {
                durable_name: Some(cfg.durable_name.clone()),
                filter_subject: cfg.subject_filter.clone(),
                ack_policy: AckPolicy::Explicit,
                max_deliver: cfg.max_deliver,
                ack_wait: Duration::from_secs(cfg.ack_wait_secs),
                // NATS defaults max_ack_pending to 1000, hard-capping in-flight
                // unacked messages far below INGEST_BATCH_MAX_SIZE and bottlenecking
                // sustained throughput; raise it explicitly.
                max_ack_pending: 20_000,
                ..Default::default()
            },
        )
        .await
        .context("create/get durable pull consumer")?;

    // Subject prefix events are published under (`<prefix>.<project_id>`),
    // derived from the configured filter (`<prefix>.>`) so it always tracks
    // `cfg.subject_filter` without a second env var.
    let subject_prefix = cfg.subject_filter.trim_end_matches(".>");

    tracing::info!(
        durable = %cfg.durable_name,
        stream = stream_name,
        filter = %cfg.subject_filter,
        "durable pull consumer ready"
    );

    // Consecutive batch-stream errors since the last good message. Drives the
    // backoff and log sampling below so a persistently failing stream (e.g.
    // NATS answering 503) can't turn this loop into a hot, log-flooding spin.
    let mut drain_errors: u32 = 0;

    loop {
        // Drain one batch, bounded by size OR the max-wait window. The
        // `expires` window doubles as the idle wait, so an empty batch simply
        // loops again — no separate sleep needed.
        let mut batch = consumer
            .batch()
            .max_messages(cfg.batch_max_size)
            .expires(Duration::from_millis(cfg.batch_max_wait_ms))
            .messages()
            .await
            .context("open consumer batch")?;

        // Successfully-parsed events paired with their message handle so we can
        // ack/nack them after the insert resolves.
        let mut parsed: Vec<(Message, RawEvent)> = Vec::new();

        let mut drain_failed = false;

        while let Some(item) = batch.next().await {
            let msg = match item {
                Ok(msg) => {
                    drain_errors = 0;
                    msg
                }
                Err(e) => {
                    // Per-message stream error (heartbeat/pull hiccup, or a
                    // 503 while the server is unavailable). A persistent
                    // failure yields this error again immediately, so don't
                    // `continue`: abandon this pull and back off before the
                    // next one. JetStream redelivers anything left unacked.
                    drain_errors = drain_errors.saturating_add(1);
                    if should_log_drain_error(drain_errors) {
                        tracing::warn!(
                            error = %e,
                            consecutive = drain_errors,
                            "error draining batch message"
                        );
                    }
                    drain_failed = true;
                    break;
                }
            };

            match serde_json::from_slice::<RawEvent>(&msg.payload) {
                Ok(event) => parsed.push((msg, event)),
                Err(e) => {
                    // Malformed payload: it will never parse, so redelivery is
                    // pointless. The payload is undecodable, but the NATS subject
                    // (`events.raw.<project_id>`) still carries the owning project
                    // — recover it so the DLQ stays partitioned by tenant.
                    let project_id = project_from_subject(&msg.subject, subject_prefix);
                    tracing::warn!(error = %e, "poison message: parse failure → DLQ");
                    to_dlq(&js, &cfg, project_id, &msg.payload).await;
                    if let Err(e) = msg.ack().await {
                        tracing::warn!(error = %e, "failed to ack poison message");
                    }
                }
            }
        }

        // Batch empty (idle window) or fully poisoned: nothing to insert.
        if parsed.is_empty() {
            if drain_failed {
                tokio::time::sleep(drain_error_backoff(drain_errors)).await;
            }
            continue;
        }

        // Warn-mode schema validation: fetch each distinct project's cached
        // schema map once per drain-batch (not once per event), then tag each
        // row with the validation outcome. Never gates the insert/ack below —
        // a lookup/parse failure or any violation simply sets/leaves
        // `schema_valid`/`schema_errors`, the row is still inserted.
        let project_ids = parsed.iter().map(|(_, ev)| ev.project_id.as_str());
        let schema_cache = schema.build_batch_cache(project_ids).await;

        let rows: Vec<serde_json::Value> = parsed
            .iter()
            .map(|(_, ev)| {
                let (schema_valid, schema_errors) = schema_cache
                    .get(&ev.project_id)
                    .map(|project_schema| crate::schema::validate_event(ev, project_schema))
                    .unwrap_or((1, String::new()));
                enrich::to_insert_row(ev, schema_valid, &schema_errors)
            })
            .collect();

        match ch.insert_events(&rows).await {
            Ok(()) => {
                let count = parsed.len();
                for (msg, _) in &parsed {
                    if let Err(e) = msg.ack().await {
                        // Ack loss re-delivers a persisted row; dedup absorbs it.
                        tracing::warn!(error = %e, "failed to ack after insert");
                    }
                }
                tracing::info!(inserted = count, "batch inserted");

                // Best-effort taxonomy discovery + identity merge: the CH
                // insert + ack above are authoritative, so a failure in either
                // is logged internally and never gates the ack or crashes the
                // loop.
                let events: Vec<RawEvent> = parsed.into_iter().map(|(_, ev)| ev).collect();
                tax.discover(&events).await;
                identity.resolve(&events).await;
            }
            Err(insert_err) => {
                // Insert failure means ClickHouse is down/degraded, not that
                // these specific payloads are poison — the same batch would
                // succeed once ClickHouse recovers. Unlike a parse failure
                // (unconditionally poison, DLQ'd above), NAK unconditionally
                // here so nothing is dropped during an outage; `cfg.max_deliver`
                // is a large-but-finite backstop (not literal-unlimited) so a
                // batch that is genuinely permanently un-insertable (e.g. one
                // row ClickHouse will never accept) eventually escapes to the
                // DLQ instead of blocking the stream head forever. The NAK
                // carries an explicit `cfg.ack_wait_secs` delay (not a bare
                // `-NAK`, which JetStream redelivers near-instantly) so
                // `max_deliver` actually represents ≈ `max_deliver ×
                // ack_wait_secs` of wall-clock outage survival instead of
                // burning the whole redelivery budget in milliseconds.
                tracing::error!(
                    error = %insert_err,
                    batch_size = parsed.len(),
                    "insert failed; NAKing batch for redelivery"
                );

                for (msg, event) in &parsed {
                    let delivered = match msg.info() {
                        Ok(info) => info.delivered,
                        Err(e) => {
                            tracing::warn!(error = %e, "could not read message info; will NAK");
                            0 // preserves old fallback behavior: treat as under budget → NAK
                        }
                    };

                    match decide_insert_failure_ack(delivered, cfg.max_deliver, cfg.ack_wait_secs) {
                        AckAction::Dlq => {
                            tracing::error!(
                                uuid = %event.uuid,
                                project_id = %event.project_id,
                                max_deliver = cfg.max_deliver,
                                "insert failure redelivery budget exhausted → DLQ (permanent loss)"
                            );
                            to_dlq(&js, &cfg, Some(&event.project_id), &msg.payload).await;
                            if let Err(e) = msg.ack().await {
                                tracing::warn!(error = %e, "failed to ack exhausted message");
                            }
                        }
                        AckAction::Nak(delay) => {
                            if let Err(e) = msg.ack_with(AckKind::Nak(Some(delay))).await {
                                tracing::warn!(error = %e, "failed to NAK message for redelivery");
                            }
                        }
                    }
                }
            }
        }
    }
}

const DRAIN_BACKOFF_BASE: Duration = Duration::from_millis(250);
const DRAIN_BACKOFF_MAX: Duration = Duration::from_secs(10);

/// Delay before re-opening the pull after `consecutive` back-to-back stream
/// errors: 250ms doubling up to a 10s cap. Pure, so it is unit-testable.
fn drain_error_backoff(consecutive: u32) -> Duration {
    let exp = consecutive.saturating_sub(1).min(16);
    DRAIN_BACKOFF_BASE
        .saturating_mul(1u32 << exp)
        .min(DRAIN_BACKOFF_MAX)
}

/// Log only the 1st, 2nd, 4th, 8th… consecutive drain error. An outage that
/// lasts hours then produces a few dozen lines instead of billions (a prior
/// outage wrote a ~680 GB log this way).
fn should_log_drain_error(consecutive: u32) -> bool {
    consecutive.is_power_of_two()
}

/// What to do with a message after a failed ClickHouse insert, given its
/// current redelivery count. Pure — no I/O — so the exact `AckKind`/delay
/// choice is unit-testable without a live NATS server. This exists because a
/// prior bug called `Nak(None)` (JetStream's immediate-redelivery signal)
/// instead of `Nak(Some(delay))`, silently burning the whole `max_deliver`
/// budget in seconds during a real outage instead of the intended
/// `max_deliver × ack_wait_secs` survival window.
#[derive(Debug, PartialEq)]
enum AckAction {
    /// Redelivery budget exhausted: DLQ + ack (permanent, last resort).
    Dlq,
    /// Redeliver after this delay. Must carry an explicit delay — see the
    /// bug this type guards against, described above.
    Nak(Duration),
}

/// Decide the `AckAction` for one message after a failed ClickHouse insert.
/// `delivered >= max_deliver` exhausts the budget → `Dlq`; otherwise `Nak`
/// with an explicit `ack_wait_secs` delay (never a bare immediate-redeliver
/// NAK).
fn decide_insert_failure_ack(delivered: i64, max_deliver: i64, ack_wait_secs: u64) -> AckAction {
    if delivered >= max_deliver {
        AckAction::Dlq
    } else {
        AckAction::Nak(Duration::from_secs(ack_wait_secs))
    }
}

/// Build the DLQ subject for a payload: `<prefix>.<project_id>`, falling back to
/// `<prefix>.unknown` when the project id is unavailable (e.g. an unparseable
/// message). Pure; unit-tested below.
fn dlq_subject(prefix: &str, project_id: Option<&str>) -> String {
    format!("{}.{}", prefix, project_id.unwrap_or("unknown"))
}

/// Recover the project id from a raw-event subject `<prefix>.<project_id>`.
/// Returns `None` when the subject doesn't carry a non-empty project token.
fn project_from_subject<'a>(subject: &'a str, prefix: &str) -> Option<&'a str> {
    subject
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('.'))
        .filter(|p| !p.is_empty())
}

/// Publish a poison payload to the DLQ and await the JetStream persist ack.
///
/// Best-effort: a DLQ publish failure is logged (never propagated) so it can't
/// crash the drain loop — the originating message is acked regardless.
async fn to_dlq(js: &Context, cfg: &Config, project_id: Option<&str>, payload: &[u8]) {
    let subject = dlq_subject(&cfg.dlq_subject_prefix, project_id);
    tracing::warn!(subject = %subject, bytes = payload.len(), "routing message to DLQ");

    // First await: server accepts. Second await: persist ack.
    let published = js.publish(subject.clone(), payload.to_vec().into()).await;
    match published {
        Ok(ack) => {
            if let Err(e) = ack.await {
                tracing::warn!(subject = %subject, error = %e, "DLQ persist ack failed");
            }
        }
        Err(e) => tracing::warn!(subject = %subject, error = %e, "DLQ publish failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dlq_subject_with_project_id() {
        assert_eq!(
            dlq_subject("events.dlq", Some("proj_123")),
            "events.dlq.proj_123"
        );
    }

    #[test]
    fn dlq_subject_without_project_id_falls_back_to_unknown() {
        assert_eq!(dlq_subject("events.dlq", None), "events.dlq.unknown");
    }

    #[test]
    fn dlq_subject_respects_custom_prefix() {
        assert_eq!(dlq_subject("custom.prefix", Some("p")), "custom.prefix.p");
    }

    #[test]
    fn project_from_subject_extracts_tenant() {
        assert_eq!(
            project_from_subject("events.raw.01KWNKK2", "events.raw"),
            Some("01KWNKK2")
        );
    }

    #[test]
    fn project_from_subject_none_for_prefix_only_or_foreign() {
        assert_eq!(project_from_subject("events.raw.", "events.raw"), None);
        assert_eq!(project_from_subject("other.subject", "events.raw"), None);
    }

    #[test]
    fn project_from_subject_respects_custom_prefix() {
        assert_eq!(
            project_from_subject("e2e.raw.proj_1", "e2e.raw"),
            Some("proj_1")
        );
        // A subject under a different prefix must not match.
        assert_eq!(project_from_subject("events.raw.proj_1", "e2e.raw"), None);
    }

    #[test]
    fn drain_error_backoff_doubles_then_caps() {
        assert_eq!(drain_error_backoff(1), Duration::from_millis(250));
        assert_eq!(drain_error_backoff(2), Duration::from_millis(500));
        assert_eq!(drain_error_backoff(3), Duration::from_secs(1));
        assert_eq!(drain_error_backoff(6), Duration::from_secs(8));
        assert_eq!(drain_error_backoff(7), Duration::from_secs(10));
        assert_eq!(drain_error_backoff(u32::MAX), Duration::from_secs(10));
    }

    #[test]
    fn drain_error_backoff_is_never_zero() {
        assert!(drain_error_backoff(0) >= DRAIN_BACKOFF_BASE);
    }

    #[test]
    fn drain_error_logging_is_sampled_logarithmically() {
        let logged = (1..=1_000_000u32)
            .filter(|n| should_log_drain_error(*n))
            .count();
        assert!(logged <= 21, "logged {logged} of 1,000,000");
        assert!(should_log_drain_error(1));
        assert!(!should_log_drain_error(3));
        assert!(!should_log_drain_error(0));
    }

    #[test]
    fn decide_insert_failure_ack_naks_with_explicit_delay_when_under_budget() {
        assert_eq!(
            decide_insert_failure_ack(1, 100, 30),
            AckAction::Nak(Duration::from_secs(30))
        );
    }

    #[test]
    fn decide_insert_failure_ack_dlqs_at_exact_boundary() {
        assert_eq!(decide_insert_failure_ack(100, 100, 30), AckAction::Dlq);
    }

    #[test]
    fn decide_insert_failure_ack_dlqs_when_over_budget() {
        assert_eq!(decide_insert_failure_ack(101, 100, 30), AckAction::Dlq);
    }

    #[test]
    fn decide_insert_failure_ack_naks_just_under_boundary() {
        assert_eq!(
            decide_insert_failure_ack(99, 100, 30),
            AckAction::Nak(Duration::from_secs(30))
        );
    }
}
