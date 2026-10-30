//! JetStream publish helper.
//!
//! Publishing AWAITS the JetStream ack so that a returned `Ok` guarantees the
//! message is persisted to the events stream — this is the durability
//! boundary behind the `202` response (AC-2).

use std::future::{Future, IntoFuture};
use std::sync::Arc;
use std::time::Duration;

use async_nats::jetstream::Context;
use tokio::sync::Semaphore;

/// Publish a single event payload to `<subject_prefix>.<project_id>` and
/// await the JetStream persist ack.
pub async fn publish_event(
    js: &Context,
    project_id: &str,
    payload: Vec<u8>,
    subject_prefix: &str,
) -> anyhow::Result<()> {
    let subject = format!("{subject_prefix}.{project_id}");
    // First await: message accepted by the server. Second await: persist ack.
    let ack = js.publish(subject, payload.into()).await?;
    ack.await?;
    Ok(())
}

/// Abstraction over "publish one payload and await its persist ack", so
/// `publish_batch` can be exercised in tests against a fake with a
/// controllable delay — `async_nats::jetstream::Context`/`PublishAckFuture`
/// have no built-in mocking seam. The real `Context` impl below is the only
/// production implementation.
pub trait AckPublisher: Send + Sync + 'static {
    fn publish_ack(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}

impl AckPublisher for Context {
    async fn publish_ack(&self, subject: String, payload: Vec<u8>) -> anyhow::Result<()> {
        // First await: message accepted by the server. Second await: persist ack.
        let ack = self.publish(subject, payload.into()).await?;
        ack.into_future().await?;
        Ok(())
    }
}

/// Distinguishes "one event's publish+ack didn't finish within its own
/// timeout budget" from any other NATS/serialization failure, so
/// `capture.rs` can map the two to different status codes (503 vs 500)
/// instead of collapsing them into one generic error.
#[derive(Debug)]
pub enum PublishBatchError {
    /// At least one event's publish+ack did not complete within
    /// `publish_timeout`.
    Timeout,
    Nats(anyhow::Error),
}

impl std::fmt::Display for PublishBatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PublishBatchError::Timeout => write!(f, "NATS publish_batch timed out"),
            PublishBatchError::Nats(e) => write!(f, "NATS publish_batch failed: {e}"),
        }
    }
}

/// Publish a batch of event payloads to `<subject_prefix>.<project_id>`,
/// pipelining the publishes: every event's publish+ack lives in its own
/// future and all of them are polled concurrently via `try_join_all` — this
/// avoids paying N sequential JetStream round-trips for a batch of N events.
///
/// Two invariants that a previous version of this function got wrong (see
/// Spec):
/// - The permit for `semaphore` is acquired **lazily inside each event's own
///   future** (via `acquire_owned`), not in a sequential pre-loop before
///   `try_join_all` starts polling. This lets `try_join_all` begin polling
///   every event immediately, so one event blocked on `acquire()` can never
///   delay a sibling event's own acquire+publish+ack — no permit-convoy /
///   head-of-line blocking across a batch.
/// - `publish_timeout` wraps **only** the publish+ack await for that one
///   event, not its permit acquisition. Every held permit is therefore
///   guaranteed to free within `publish_timeout`, which in turn bounds how
///   long any `acquire()` anywhere can possibly wait — without needing a
///   second, separate acquire-timeout.
///
/// All-or-nothing: same as the sequential version, the first event error
/// (timeout, publish, or ack failure) fails the whole batch/request.
pub async fn publish_batch<P: AckPublisher>(
    publisher: &P,
    project_id: &str,
    payloads: Vec<Vec<u8>>,
    subject_prefix: &str,
    semaphore: Arc<Semaphore>,
    publish_timeout: Duration,
) -> Result<(), PublishBatchError> {
    let subject = format!("{subject_prefix}.{project_id}");
    let futures = payloads.into_iter().map(|payload| {
        let semaphore = Arc::clone(&semaphore);
        let subject = subject.clone();
        async move {
            tokio::time::timeout(publish_timeout, async {
                // Acquired here, inside this event's own future, so
                // `try_join_all` below is already polling every event
                // concurrently by the time any of them starts waiting for a
                // permit — no sequential pre-acquire pinning permits held by
                // earlier events in the batch.
                let permit = semaphore
                    .acquire_owned()
                    .await
                    .expect("nats_publish_semaphore is never closed");
                let result = publisher.publish_ack(subject, payload).await;
                drop(permit);
                result
            })
            .await
        }
    });
    let results = futures::future::join_all(futures).await;
    let mut timed_out = false;
    for result in results {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(PublishBatchError::Nats(e)),
            Err(_elapsed) => timed_out = true,
        }
    }
    if timed_out {
        return Err(PublishBatchError::Timeout);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::Notify;

    use super::*;

    /// Test double for `AckPublisher`: each payload's "ack" resolves after
    /// `delay`, except payloads listed in `never_resolve` (by index) which
    /// wait on a `Notify` that the test never fires — simulating a stuck
    /// JetStream ack. Tracks peak concurrent in-flight `publish_ack` calls so
    /// tests can assert on actual concurrency, not just final outcomes.
    struct FakePublisher {
        delay: Duration,
        stuck: Arc<Notify>,
        in_flight: Arc<AtomicUsize>,
        peak_in_flight: Arc<AtomicUsize>,
    }

    impl AckPublisher for FakePublisher {
        async fn publish_ack(&self, subject: String, _payload: Vec<u8>) -> anyhow::Result<()> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_in_flight.fetch_max(now, Ordering::SeqCst);
            if subject.contains("stuck") {
                self.stuck.notified().await;
            } else {
                tokio::time::sleep(self.delay).await;
            }
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_event_does_not_block_siblings_in_same_batch() {
        let peak_in_flight = Arc::new(AtomicUsize::new(0));
        let publisher = FakePublisher {
            delay: Duration::from_millis(10),
            stuck: Arc::new(Notify::new()),
            in_flight: Arc::new(AtomicUsize::new(0)),
            peak_in_flight: Arc::clone(&peak_in_flight),
        };
        // Subject is shared per-batch (project_id-scoped), so drive the
        // stuck event via a dedicated single-event batch run concurrently
        // with a normal batch, and prove they don't serialize.
        let semaphore = Arc::new(Semaphore::new(10));

        let stuck_fut = publish_batch(
            &publisher,
            "stuck",
            vec![b"ev".to_vec()],
            "events.raw",
            Arc::clone(&semaphore),
            Duration::from_millis(50),
        );
        let fast_fut = publish_batch(
            &publisher,
            "proj",
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()],
            "events.raw",
            Arc::clone(&semaphore),
            Duration::from_millis(50),
        );

        let (stuck_result, fast_result) = tokio::join!(stuck_fut, fast_fut);

        assert!(matches!(stuck_result, Err(PublishBatchError::Timeout)));
        assert!(
            fast_result.is_ok(),
            "fast batch must succeed independently of the stuck one"
        );
        assert!(
            peak_in_flight.load(Ordering::SeqCst) >= 2,
            "fast events must run concurrently with the stuck event, not wait behind it"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn semaphore_cap_is_enforced_process_wide() {
        let peak_in_flight = Arc::new(AtomicUsize::new(0));
        let publisher = FakePublisher {
            delay: Duration::from_millis(20),
            stuck: Arc::new(Notify::new()),
            in_flight: Arc::new(AtomicUsize::new(0)),
            peak_in_flight: Arc::clone(&peak_in_flight),
        };
        let cap = 4;
        let semaphore = Arc::new(Semaphore::new(cap));

        // 3 batches of 5 events each = 15 concurrent publish attempts against
        // a 4-permit cap.
        let project_ids: Vec<String> = (0..3).map(|i| format!("proj{i}")).collect();
        let batches = project_ids.iter().map(|project_id| {
            publish_batch(
                &publisher,
                project_id,
                vec![b"e".to_vec(); 5],
                "events.raw",
                Arc::clone(&semaphore),
                Duration::from_secs(5),
            )
        });
        let results = futures::future::join_all(batches).await;
        for result in results {
            assert!(result.is_ok());
        }

        assert!(
            peak_in_flight.load(Ordering::SeqCst) <= cap,
            "observed concurrency {} exceeded semaphore cap {}",
            peak_in_flight.load(Ordering::SeqCst),
            cap
        );
    }
}
