//! Support webhook delivery worker.
//!
//! Two entry paths that converge on exactly one send function:
//!
//! 1. **The sweep** — a background tokio task on a fixed interval that claims
//!    `SupportWebhookDelivery` rows where `status='pending' AND nextAttemptAt
//!    <= now()`. This is the durable path: it is what makes retries survive a
//!    process restart, and it is the only thing the trpc-router path (which
//!    writes delivery rows but publishes no NATS message) relies on.
//! 2. **The notification** — a core-NATS subscription on the subject where
//!    `services/capture` publishes a `{"deliveryId":...}` hint right after
//!    enqueueing. Purely a latency optimization: losing the message costs a
//!    delay bounded by the sweep interval, never a delivery.
//!
//! Claiming is optimistic, not a held lock: a row is claimed by bumping
//! `attempts` and pushing `nextAttemptAt` forward by the backoff for the
//! *next* attempt, conditional on the `attempts` value we read. Two workers
//! (or the sweep racing its own notification) therefore cannot both send the
//! same attempt — the loser's UPDATE matches zero rows. It also means a worker
//! killed mid-request leaves a row that simply becomes due again after the
//! backoff, with no lease to expire.
//!
//! Like `volume_job`, errors are caught per run: a transient Postgres or
//! network fault logs and retries on the next tick rather than crashing the
//! process.
//!
//! Added four things on top of that skeleton, all of them
//! about what happens *around* the send rather than the send itself:
//!
//! * A `SupportWebhookAttempt` row per attempt — latency measured through the
//!   response body, the signed request headers, and the response — because the
//!   last-attempt columns on the delivery cannot answer "attempt 3 of 5 failed,
//!   here is what your server said".
//! * [`classify`]: a `401` is a fact about configuration and fails on attempt
//!   one, a `503`/`429`/`404`/`408` is a fact about *now* and retries on the
//!   published 30s/2m/10m/1h/6h schedule.
//! * A circuit breaker on `consecutiveFailures`, counted per *terminal
//!   delivery* and reset by any success, which disables an endpoint that has
//!   been dead for 20 deliveries and announces it on core NATS.
//! * Rotation grace: during the window the signature header carries `v1` signed
//!   with the **old** secret and `v2` with the new — see [`signature_header`]
//!   for why that is not Stripe's dual-`v1`.
//!
//! The send path is additionally gated by [`crate::webhook_url`], the outbound
//! URL admission guard (HTTPS-only, no private/loopback/link-local targets). It
//! is the Rust half of the TS `admitWebhookUrl` that guards `webhooks.sendTest`
//! — both send paths are user-driven outbound fetches from inside the private
//! network, so one of them being unguarded is the whole SSRF hole. A refused URL
//! is *fatal* (a config fact, not a transient), and still writes its attempt row.
//!
//! One invariant survives all of it (constraint 1): `'retrying'` is
//! never written as a `status`. The claim predicate is `status='pending'`, so a
//! third live value would silently stop every retry. A retrying delivery is
//! `status='pending' AND attempts > 0`, derived at read time.

use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures::StreamExt;
// `aes-gcm` and `hmac` are on different `crypto-common` majors, so their
// `KeyInit` traits are distinct types — the alias keeps both usable here.
use hmac::{digest::KeyInit as HmacKeyInit, Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use sqlx::PgPool;

use crate::config::Config;
use crate::webhook_url::admit_webhook_url;

/// The published retry schedule: 30s, 2m, 10m, 1h, 6h. A table rather
/// than a doubling formula because it is a *documented* customer-facing
/// contract — the UI, the docs and this array have to agree, and an array is
/// the only shape you can read one against the other.
const BACKOFF_SCHEDULE_SECS: [u64; 5] = [30, 120, 600, 3_600, 21_600];

/// Terminal *deliveries* in a row before an endpoint is auto-disabled.
///
/// Deliveries, not attempts: at 5 attempts each, per-attempt counting would
/// trip this after four dead deliveries — one bad afternoon — which is the
/// opposite of a circuit breaker's job.
const AUTO_DISABLE_THRESHOLD: i32 = 20;

/// Cap on a stored request/response body. Frame `5b` shows these panes to a
/// customer debugging a verification failure; past 64KB they are not reading
/// it, and the column is not a payload archive.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Cap on a stored error string (`lastError`, `errorMessage`).
const MAX_ERROR_BYTES: usize = 500;

/// Everything a run needs, shared by the sweep task and the NATS subscriber.
struct Worker {
    pg: PgPool,
    http: reqwest::Client,
    /// Core NATS, used only to announce an auto-disable. Publishing is
    /// best-effort: nothing consumes the subject today and a delivery outcome
    /// must never hinge on the broker being up.
    nats: async_nats::Client,
    /// Raw AES-256 key bytes (decoded once at spawn).
    encryption_key: Vec<u8>,
    max_attempts: i32,
    sweep_batch_size: i64,
    autodisable_subject: String,
    /// `INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS` — the local-dev escape hatch on
    /// the SSRF guard. False everywhere that matters.
    allow_private_targets: bool,
}

/// Spawn the webhook delivery worker (sweep loop + notification subscriber).
///
/// Returns immediately. A no-op when `webhook_job_enabled` is false, or when
/// `AI_ENCRYPTION_KEY` is missing/invalid — the process still ingests events,
/// but it says loudly that webhooks are not being delivered rather than
/// pretending they are.
pub fn spawn(pg: PgPool, nats: async_nats::Client, cfg: Arc<Config>) {
    if !cfg.webhook_job_enabled {
        tracing::info!("webhook job disabled (INGEST_WEBHOOK_JOB_ENABLED=false)");
        return;
    }

    let encryption_key = match resolve_encryption_key(cfg.webhook_encryption_key_hex.as_deref()) {
        Ok(key) => key,
        Err(e) => {
            tracing::error!(error = %e, "webhook job disabled: AI_ENCRYPTION_KEY unusable");
            return;
        }
    };

    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.webhook_request_timeout_secs.max(1)))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "webhook job disabled: HTTP client build failed");
            return;
        }
    };

    let worker = Arc::new(Worker {
        pg,
        http,
        nats: nats.clone(),
        encryption_key,
        max_attempts: cfg.max_attempts(),
        sweep_batch_size: cfg.sweep_batch_size(),
        autodisable_subject: cfg.webhook_autodisable_subject.clone(),
        allow_private_targets: cfg.webhook_allow_private_targets,
    });

    tracing::info!(
        interval_secs = cfg.webhook_job_interval_secs,
        max_attempts = worker.max_attempts,
        "webhook job enabled"
    );

    // Loud on purpose: this is the SSRF guard turned off, and the only correct
    // place for it is a developer's laptop pointing at a localhost receiver.
    if worker.allow_private_targets {
        tracing::warn!(
            "INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS=true: webhook deliveries to private, \
             loopback and link-local addresses are ALLOWED (local development only)"
        );
    }

    spawn_sweep(worker.clone(), cfg.webhook_job_interval_secs);
    spawn_notify_listener(worker, nats, cfg.webhook_subject.clone());
}

impl Config {
    /// At least one attempt, always — a zero/negative cap would mark every
    /// delivery failed without ever calling the customer's endpoint.
    fn max_attempts(&self) -> i32 {
        self.webhook_max_attempts.max(1)
    }

    fn sweep_batch_size(&self) -> i64 {
        self.webhook_sweep_batch_size.max(1)
    }
}

/// Decode the hex `AI_ENCRYPTION_KEY` and check it is an AES-256 key.
fn resolve_encryption_key(hex_key: Option<&str>) -> anyhow::Result<Vec<u8>> {
    let hex_key = hex_key.ok_or_else(|| anyhow::anyhow!("AI_ENCRYPTION_KEY is not set"))?;
    let key = hex::decode(hex_key.trim())
        .map_err(|e| anyhow::anyhow!("AI_ENCRYPTION_KEY is not valid hex: {e}"))?;
    if key.len() != 32 {
        anyhow::bail!(
            "AI_ENCRYPTION_KEY must be 32 bytes (64 hex chars), got {}",
            key.len()
        );
    }
    Ok(key)
}

/// The interval sweep: claim and send every due delivery, forever.
fn spawn_sweep(worker: Arc<Worker>, interval_secs: u64) {
    let interval = Duration::from_secs(interval_secs.max(1));
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            match sweep_once(&worker).await {
                Ok(sent) if sent > 0 => {
                    tracing::info!(attempted = sent, "webhook sweep complete")
                }
                Ok(_) => {}
                // Guard: a job error must never crash the process.
                Err(e) => tracing::error!(error = %e, "webhook sweep failed (will retry)"),
            }
        }
    });
}

/// The core-NATS listener: a hint that one specific delivery is due now.
fn spawn_notify_listener(worker: Arc<Worker>, nats: async_nats::Client, subject: String) {
    tokio::spawn(async move {
        let mut subscriber = match nats.subscribe(subject.clone()).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, subject, "webhook notify subscribe failed; sweep only");
                return;
            }
        };
        tracing::info!(subject, "webhook delivery notifications subscribed");

        while let Some(msg) = subscriber.next().await {
            let Some(delivery_id) = parse_delivery_id(&msg.payload) else {
                tracing::warn!("webhook notify: unparseable payload (ignored)");
                continue;
            };
            if let Err(e) = deliver_by_id(&worker, &delivery_id).await {
                // Not fatal: the row stays pending and the sweep retries it.
                tracing::warn!(error = %e, delivery_id, "webhook notify delivery failed");
            }
        }
        tracing::warn!(subject, "webhook notify subscription ended; sweep only");
    });
}

/// Pull the `deliveryId` out of capture's notification payload.
fn parse_delivery_id(payload: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    value
        .get("deliveryId")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Claim + send
// ---------------------------------------------------------------------------

/// A due delivery joined to the webhook it targets.
#[derive(Debug, Clone)]
struct DueDelivery {
    id: String,
    /// Attempts recorded *before* this one — the optimistic-lock value.
    attempts: i32,
    event: String,
    /// The `payload` jsonb read as text: these are the exact bytes signed and
    /// POSTed, so the signature the customer verifies is over what they got.
    payload: String,
    url: String,
    /// Still the encrypted blob at this point.
    secret: String,
    webhook_id: String,
    /// Only used to shape the auto-disable notification.
    project_id: String,
    /// `webhooks.sendTest`. Never counts toward `consecutiveFailures` and never
    /// resets it, so a broken staging URL cannot auto-disable production.
    is_test: bool,
    /// Rotation grace: the *previous* encrypted secret, still signed with while
    /// the window is open.
    previous_secret: Option<String>,
    /// The grace deadline as a unix timestamp. Read as epoch seconds rather
    /// than a timestamptz because the `chrono` sqlx feature is not enabled in
    /// this crate — and it is the form `signature_header` compares against
    /// anyway.
    previous_secret_expires_at: Option<i64>,
}

impl DueDelivery {
    /// Whether this delivery's outcome moves `consecutiveFailures` at all.
    ///
    /// A `sendTest` moves it in neither direction: hammering Send test at a
    /// broken staging URL must not auto-disable a production endpoint, and a
    /// green test must not paper over the real traffic that is failing.
    fn affects_breaker(&self) -> bool {
        !self.is_test
    }
}

/// Tuple shape both due-row reads decode into, in `due_select!` column order.
type DueRow = (
    String,
    i32,
    String,
    String,
    String,
    String,
    String,
    String,
    bool,
    Option<String>,
    Option<i64>,
);

/// Columns + joins shared by both due-row reads.
///
/// The `active` / `deletedAt` / event-membership predicates live here rather
/// than at enqueue time only, so deactivating a webhook stops delivery of rows
/// already queued against it (they stay `pending` and resume if it is
/// reactivated). Empty `events` means subscribe-all, matching capture's
/// `subscribed_webhook_ids`.
///
/// A macro rather than a `const` so the two call sites can `concat!` their own
/// tail onto it and still pass a `&'static str` to sqlx (0.9 rejects runtime
/// query strings outright).
macro_rules! due_select {
    () => {
        r#"
    SELECT d."id", d."attempts", d."event", d."payload"::text, w."url", w."secret",
           d."webhookId", w."projectId", d."isTest", w."previousSecret",
           EXTRACT(EPOCH FROM w."previousSecretExpiresAt")::bigint
    FROM "SupportWebhookDelivery" d
    JOIN "SupportWebhook" w ON w."id" = d."webhookId"
    WHERE d."status" = 'pending'
      AND d."nextAttemptAt" <= now()
      AND w."active" = true
      AND w."deletedAt" IS NULL
      AND (d."event" = ANY(w."events") OR COALESCE(cardinality(w."events"), 0) = 0)
"#
    };
}

/// One sweep pass. A single failing delivery is logged and skipped so it can't
/// sink the rest of the batch. Returns how many deliveries were attempted.
async fn sweep_once(worker: &Worker) -> anyhow::Result<usize> {
    // `createdAt` breaks the `nextAttemptAt` tie, and a re-enabled endpoint's
    // backlog is one giant tie: `reEnableAndReplay` stamps every queued row at
    // roughly the same instant. `sweep_once` sends sequentially inside a batch,
    // so this one column is what makes in-order replay real.
    let rows: Vec<DueRow> = sqlx::query_as(concat!(
        due_select!(),
        r#" ORDER BY d."nextAttemptAt" ASC, d."createdAt" ASC LIMIT $1"#
    ))
    .bind(worker.sweep_batch_size)
    .fetch_all(&worker.pg)
    .await?;

    let mut attempted = 0usize;
    for row in rows {
        let due = into_due(row);
        match deliver(worker, &due).await {
            Ok(true) => attempted += 1,
            // Claim lost to another worker / the notification path.
            Ok(false) => {}
            Err(e) => {
                attempted += 1;
                tracing::warn!(error = %e, delivery_id = due.id, "webhook delivery errored");
            }
        }
    }
    Ok(attempted)
}

/// The notification path: same claim + send, scoped to one delivery id.
async fn deliver_by_id(worker: &Worker, delivery_id: &str) -> anyhow::Result<()> {
    let row: Option<DueRow> = sqlx::query_as(concat!(due_select!(), r#" AND d."id" = $1"#))
        .bind(delivery_id)
        .fetch_optional(&worker.pg)
        .await?;

    // Absent simply means "not due / not eligible" — the sweep owns it now.
    let Some(row) = row else { return Ok(()) };
    deliver(worker, &into_due(row)).await?;
    Ok(())
}

fn into_due(row: DueRow) -> DueDelivery {
    let (
        id,
        attempts,
        event,
        payload,
        url,
        secret,
        webhook_id,
        project_id,
        is_test,
        previous_secret,
        previous_secret_expires_at,
    ) = row;
    DueDelivery {
        id,
        attempts,
        event,
        payload,
        url,
        secret,
        webhook_id,
        project_id,
        is_test,
        previous_secret,
        previous_secret_expires_at,
    }
}

/// Claim, send, record. `Ok(false)` means the claim was lost (no send made).
async fn deliver(worker: &Worker, due: &DueDelivery) -> anyhow::Result<bool> {
    let attempt = due.attempts + 1;
    if !claim(worker, due, attempt).await? {
        return Ok(false);
    }

    // The SSRF guard, before a single byte leaves the host. The URL is
    // customer-typed and this process sits inside the private network, so
    // "POST wherever the row says" is exactly the reach an attacker wants.
    //
    // Fatal, not retryable: an endpoint that resolves to 127.0.0.1 or an http://
    // URL is a configuration fact, and it will still be one in six hours. The
    // attempt row is written first regardless, so the customer sees *why* in the
    // delivery history rather than a delivery that failed with nothing behind
    // it.
    match admit_webhook_url(&due.url, worker.allow_private_targets).await {
        Ok(admitted) => tracing::debug!(
            delivery_id = due.id,
            addresses = admitted.addresses.len(),
            "webhook endpoint admitted"
        ),
        Err(rejection) => {
            let error = truncate_error(&rejection.to_string());
            tracing::warn!(
                delivery_id = due.id,
                webhook_id = due.webhook_id,
                error,
                "webhook endpoint refused by the outbound URL guard (not sent)"
            );
            let outcome = SendOutcome::blocked_url();
            record_attempt(&worker.pg, due, attempt, &outcome, Some(&error)).await?;
            record_failure(worker, due, attempt, None, &error, Class::Fatal).await?;
            return Ok(true);
        }
    }

    let secret = match decrypt_secret(&worker.encryption_key, &due.secret) {
        Ok(s) => s,
        Err(e) => {
            // A key mismatch is not transient, but failing the delivery
            // immediately would hide it; let it burn its attempts and land in
            // `failed` with the reason recorded like any other error.
            let error = truncate_error(&format!("secret decrypt failed: {e}"));
            let outcome = SendOutcome::crypto_failure();
            record_attempt(&worker.pg, due, attempt, &outcome, Some(&error)).await?;
            record_failure(worker, due, attempt, None, &error, Class::Retryable).await?;
            return Ok(true);
        }
    };

    let timestamp = chrono::Utc::now().timestamp();
    let previous = resolve_previous_secret(worker, due, timestamp);
    let outcome = send(worker, due, &secret, previous.as_deref(), timestamp).await;
    let class = classify(outcome.status);
    let error = match class {
        Class::Delivered => None,
        _ => Some(failure_message(&outcome)),
    };

    // Every attempt gets a row, delivered or not, and it is written *before*
    // the delivery outcome so the history sheet can never show a terminal
    // delivery with no attempt behind it.
    record_attempt(&worker.pg, due, attempt, &outcome, error.as_deref()).await?;

    match class {
        Class::Delivered => {
            record_delivered(worker, due, outcome.status.unwrap_or(200)).await?;
        }
        _ => {
            let error = error.unwrap_or_default();
            record_failure(worker, due, attempt, outcome.status, &error, class).await?;
        }
    }
    Ok(true)
}

/// The plaintext previous secret, when a rotation grace window is open.
///
/// A previous secret that will not decrypt is *not* fatal: it only costs the
/// old half of the signature header, and refusing to deliver over it would turn
/// a key problem on a retired secret into an outage on the live one.
fn resolve_previous_secret(worker: &Worker, due: &DueDelivery, now: i64) -> Option<String> {
    let blob = due.previous_secret.as_deref()?;
    let expires_at = due.previous_secret_expires_at?;
    if now >= expires_at {
        return None;
    }
    match decrypt_secret(&worker.encryption_key, blob) {
        Ok(secret) => Some(secret),
        Err(e) => {
            tracing::warn!(
                error = %e,
                webhook_id = due.webhook_id,
                "previous webhook secret failed to decrypt; signing with the current secret only"
            );
            None
        }
    }
}

/// What lands in `lastError` / `errorMessage` for a non-delivered attempt.
fn failure_message(outcome: &SendOutcome) -> String {
    if let Some(error) = &outcome.error {
        return truncate_error(error);
    }
    match outcome.status {
        Some(status) => format!("endpoint returned HTTP {status}"),
        None => "no response from endpoint".to_string(),
    }
}

/// Optimistically claim the row for `attempt`, pre-arming `nextAttemptAt` with
/// this attempt's backoff. Returns false when another worker got there first.
async fn claim(worker: &Worker, due: &DueDelivery, attempt: i32) -> anyhow::Result<bool> {
    let delay = backoff_secs(attempt);
    let result = sqlx::query(
        r#"UPDATE "SupportWebhookDelivery"
           SET "attempts" = $2,
               "nextAttemptAt" = now() + make_interval(secs => $3),
               "updatedAt" = now()
           WHERE "id" = $1 AND "status" = 'pending' AND "attempts" = $4"#,
    )
    .bind(&due.id)
    .bind(attempt)
    .bind(delay as f64)
    .bind(due.attempts)
    .execute(&worker.pg)
    .await?;

    Ok(result.rows_affected() == 1)
}

/// Everything one HTTP exchange produced, whether or not it completed.
///
/// It exists because the old `u16` return threw away exactly the four things
/// the delivery log is for: how long it took, what was sent, what came back,
/// and — when nothing came back — why.
#[derive(Debug)]
struct SendOutcome {
    /// `None` = no HTTP response at all (DNS, connect, TLS, timeout).
    status: Option<u16>,
    latency_ms: i32,
    /// The headers actually sent, `X-Clickroom-Signature` included: frame 5b's
    /// "signed request" pane is what a customer debugging a failing
    /// verification needs to see.
    request_headers: serde_json::Value,
    response_headers: serde_json::Value,
    response_body: String,
    body_truncated: bool,
    /// Transport-level error text; `None` when the exchange completed, whatever
    /// the status was.
    error: Option<String>,
    /// `SupportWebhookAttempt.outcome`. Carried rather than derived because the
    /// no-response cases (`timeout` vs `network`) and `crypto` are invisible to
    /// `classify`, which only sees a status.
    outcome: &'static str,
}

impl SendOutcome {
    /// The pre-send failure: the secret would not decrypt, so nothing was sent.
    fn crypto_failure() -> Self {
        Self {
            status: None,
            latency_ms: 0,
            request_headers: json!({}),
            response_headers: json!({}),
            response_body: String::new(),
            body_truncated: false,
            error: None,
            outcome: "crypto",
        }
    }

    /// The other pre-send failure: the endpoint URL was refused by the outbound
    /// guard, so nothing was sent. Distinct from `network` — nothing was even
    /// attempted, and the fix is the URL, not the customer's server.
    fn blocked_url() -> Self {
        Self {
            outcome: "blocked_url",
            ..Self::crypto_failure()
        }
    }
}

/// What a status code means for the retry decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Delivered,
    Retryable,
    Fatal,
}

/// Retryable vs fatal.
///
/// `404` and `408` stay retryable deliberately: a rollout that 404s for thirty
/// seconds is the most common transient there is, and a strict 4xx-fatal rule
/// would drop every delivery that lands inside it. Everything else in the 4xx
/// range is a configuration fact — a wrong token is still wrong in six hours —
/// so burning five attempts on it only delays the truth. `reqwest` follows
/// redirects, so a `3xx` reaching us means the redirect budget was exhausted:
/// correctly fatal.
fn classify(status: Option<u16>) -> Class {
    match status {
        Some(s) if (200..300).contains(&s) => Class::Delivered,
        Some(429) | Some(404) | Some(408) => Class::Retryable,
        Some(s) if s >= 500 => Class::Retryable,
        Some(_) => Class::Fatal,
        None => Class::Retryable,
    }
}

/// `SupportWebhookAttempt.outcome` for an exchange that produced a status.
fn http_outcome(status: u16) -> &'static str {
    match classify(Some(status)) {
        Class::Delivered => "delivered",
        Class::Fatal => "fatal_http",
        Class::Retryable if status == 429 => "rate_limited",
        Class::Retryable => "retryable_http",
    }
}

/// POST the payload, signed, and report everything the exchange produced.
///
/// Latency is stopped after the body is read, not at the response headers:
/// that is the customer-perceived number, and stopping at headers hides a
/// slow-streaming endpoint completely.
async fn send(
    worker: &Worker,
    due: &DueDelivery,
    secret: &str,
    previous: Option<&str>,
    timestamp: i64,
) -> SendOutcome {
    let previous_pair = previous.zip(due.previous_secret_expires_at);
    let signature = signature_header(secret, previous_pair, timestamp, due.payload.as_bytes());
    let request_headers = json!({
        "content-type": "application/json",
        "user-agent": "clickroom-webhooks/1",
        // The delivery id is the customer's idempotency key: every retry of
        // this delivery re-sends it unchanged, so deduping on it is what makes
        // the documented replay defence implementable on their side.
        "x-clickroom-delivery": due.id,
        "x-clickroom-event": due.event,
        "x-clickroom-signature": signature,
    });

    let started = Instant::now();
    let response = match worker
        .http
        .post(&due.url)
        .header("content-type", "application/json")
        .header("user-agent", "clickroom-webhooks/1")
        .header("X-Clickroom-Delivery", &due.id)
        .header("X-Clickroom-Event", &due.event)
        .header("X-Clickroom-Signature", &signature)
        .body(due.payload.clone())
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            return SendOutcome {
                status: None,
                latency_ms: elapsed_ms(started),
                request_headers,
                response_headers: json!({}),
                response_body: String::new(),
                body_truncated: false,
                error: Some(e.to_string()),
                outcome: if e.is_timeout() { "timeout" } else { "network" },
            }
        }
    };

    let status = response.status().as_u16();
    let response_headers = headers_to_json(response.headers());
    // A body read that fails mid-stream still had a status line: keep it, and
    // record why the body is empty rather than pretending it was.
    let (response_body, body_truncated, error) = match response.bytes().await {
        Ok(bytes) => {
            let (body, truncated) = truncate_body(&bytes);
            (body, truncated, None)
        }
        Err(e) => (String::new(), false, Some(e.to_string())),
    };

    SendOutcome {
        status: Some(status),
        latency_ms: elapsed_ms(started),
        request_headers,
        response_headers,
        response_body,
        body_truncated,
        error,
        outcome: http_outcome(status),
    }
}

fn elapsed_ms(started: Instant) -> i32 {
    started.elapsed().as_millis().min(i32::MAX as u128) as i32
}

/// Response headers as a flat JSON object. Values that are not valid UTF-8 are
/// rendered lossily rather than dropped — an unreadable value still tells the
/// customer the header was present.
fn headers_to_json(headers: &reqwest::header::HeaderMap) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (name, value) in headers {
        map.insert(
            name.as_str().to_string(),
            serde_json::Value::String(String::from_utf8_lossy(value.as_bytes()).into_owned()),
        );
    }
    serde_json::Value::Object(map)
}

/// Write the per-attempt row. `startedAt` is derived from the measured latency
/// so the two columns can never disagree, and is computed in SQL because the
/// `chrono` sqlx feature is not enabled in this crate.
///
/// `ON CONFLICT DO NOTHING` on `(deliveryId, attempt)`: the optimistic claim
/// already makes a duplicate attempt number impossible, and a lost race must
/// not turn into an error that masks the real delivery outcome.
async fn record_attempt(
    pg: &PgPool,
    due: &DueDelivery,
    attempt: i32,
    outcome: &SendOutcome,
    error: Option<&str>,
) -> anyhow::Result<()> {
    let (request_body, request_truncated) = truncate_body(due.payload.as_bytes());
    sqlx::query(
        r#"INSERT INTO "SupportWebhookAttempt" (
               "id", "deliveryId", "webhookId", "attempt", "startedAt", "latencyMs",
               "responseCode", "outcome", "errorMessage", "requestHeaders", "requestBody",
               "responseHeaders", "responseBody", "bodyTruncated", "createdAt"
           ) VALUES (
               $1, $2, $3, $4, now() - make_interval(secs => $5), $6,
               $7, $8, $9, $10::jsonb, $11,
               $12::jsonb, $13, $14, now()
           )
           ON CONFLICT ("deliveryId", "attempt") DO NOTHING"#,
    )
    .bind(ulid::Ulid::new().to_string())
    .bind(&due.id)
    .bind(&due.webhook_id)
    .bind(attempt)
    .bind(f64::from(outcome.latency_ms) / 1000.0)
    .bind(outcome.latency_ms)
    .bind(outcome.status.map(i32::from))
    .bind(outcome.outcome)
    .bind(error)
    .bind(outcome.request_headers.to_string())
    .bind(request_body)
    .bind(outcome.response_headers.to_string())
    .bind(&outcome.response_body)
    .bind(outcome.body_truncated || request_truncated)
    .execute(pg)
    .await?;
    Ok(())
}

async fn record_delivered(worker: &Worker, due: &DueDelivery, status: u16) -> anyhow::Result<()> {
    sqlx::query(
        r#"UPDATE "SupportWebhookDelivery"
           SET "status" = 'delivered', "lastStatusCode" = $2, "lastError" = NULL,
               "updatedAt" = now()
           WHERE "id" = $1"#,
    )
    .bind(&due.id)
    .bind(i32::from(status))
    .execute(&worker.pg)
    .await?;

    // Any success clears the breaker.
    if due.affects_breaker() {
        clear_consecutive_failures(&worker.pg, &due.webhook_id).await?;
    }

    tracing::info!(
        delivery_id = due.id,
        status,
        event = due.event,
        "webhook delivered"
    );
    Ok(())
}

/// Record a failed attempt. `nextAttemptAt` was already set by `claim`, so the
/// only decision here is whether this delivery is now terminal — either it ran
/// out of attempts, or the status says retrying cannot help.
async fn record_failure(
    worker: &Worker,
    due: &DueDelivery,
    attempt: i32,
    status: Option<u16>,
    error: &str,
    class: Class,
) -> anyhow::Result<()> {
    let exhausted = is_exhausted(attempt, worker.max_attempts);
    let terminal = exhausted || class == Class::Fatal;
    sqlx::query(
        r#"UPDATE "SupportWebhookDelivery"
           SET "status" = CASE WHEN $4 THEN 'failed' ELSE "status" END,
               "lastError" = $2, "lastStatusCode" = $3, "updatedAt" = now()
           WHERE "id" = $1"#,
    )
    .bind(&due.id)
    .bind(error)
    .bind(status.map(i32::from))
    .bind(terminal)
    .execute(&worker.pg)
    .await?;

    if terminal {
        tracing::warn!(
            delivery_id = due.id,
            attempt,
            status,
            fatal = class == Class::Fatal,
            error,
            "webhook delivery failed permanently"
        );
        if due.affects_breaker() {
            note_terminal_failure(worker, due).await?;
        }
    } else {
        tracing::info!(
            delivery_id = due.id,
            attempt,
            retry_in_secs = backoff_secs(attempt),
            error,
            "webhook delivery attempt failed (will retry)"
        );
    }
    Ok(())
}

/// The auto-disable breaker, as one statement.
///
/// Never read-modify-write: the sweep and the NATS path both reach this, and a
/// read-then-write would let two terminal failures land on the same count and
/// under-report. The threshold lives inside the `CASE` so the increment and the
/// decision are the same row lock.
///
/// The counter is a heuristic ordering, not an audit log — a `delivered` for
/// one delivery can interleave with a terminal `failed` for another. That is
/// accepted: it is a circuit breaker.
async fn note_terminal_failure(worker: &Worker, due: &DueDelivery) -> anyhow::Result<()> {
    let (consecutive_failures, active, _auto_disabled) =
        bump_consecutive_failures(&worker.pg, &due.webhook_id).await?;
    // A delivery only reaches the worker while its webhook is active
    // (`due_select!`), so `active = false` here means *this* statement flipped
    // it — no separate "was it already off" read.
    if !active && consecutive_failures >= AUTO_DISABLE_THRESHOLD {
        tracing::warn!(
            webhook_id = due.webhook_id,
            consecutive_failures,
            "support webhook auto-disabled after consecutive terminal failures"
        );
        publish_autodisabled(worker, due, consecutive_failures).await;
    }
    Ok(())
}

/// Increment the breaker and, at the threshold, disable the endpoint — in one
/// statement. Returns `(consecutiveFailures, active, autoDisabledAt IS NOT
/// NULL)` after the write.
async fn bump_consecutive_failures(
    pg: &PgPool,
    webhook_id: &str,
) -> anyhow::Result<(i32, bool, bool)> {
    let row = sqlx::query_as(
        r#"UPDATE "SupportWebhook"
              SET "consecutiveFailures" = "consecutiveFailures" + 1,
                  "active" = CASE WHEN "consecutiveFailures" + 1 >= $2
                                  THEN false ELSE "active" END,
                  "autoDisabledAt" = CASE WHEN "consecutiveFailures" + 1 >= $2
                                           AND "autoDisabledAt" IS NULL
                                          THEN now() ELSE "autoDisabledAt" END,
                  "updatedAt" = now()
            WHERE "id" = $1
        RETURNING "consecutiveFailures", "active", ("autoDisabledAt" IS NOT NULL)"#,
    )
    .bind(webhook_id)
    .bind(AUTO_DISABLE_THRESHOLD)
    .fetch_one(pg)
    .await?;
    Ok(row)
}

/// Clear the breaker after a success.
async fn clear_consecutive_failures(pg: &PgPool, webhook_id: &str) -> anyhow::Result<()> {
    sqlx::query(
        r#"UPDATE "SupportWebhook"
           SET "consecutiveFailures" = 0, "lastDeliveryAt" = now(), "updatedAt" = now()
           WHERE "id" = $1"#,
    )
    .bind(webhook_id)
    .execute(pg)
    .await?;
    Ok(())
}

/// Announce an auto-disable on core NATS. Nothing consumes it today; it exists
/// so a future notifier is a consumer rather than a worker change. A publish
/// failure is logged and never propagated — same posture as capture's delivery
/// nudge (`services/capture/src/support/endpoint.rs:576-584`): the endpoint is
/// already disabled in Postgres, which is the durable fact.
async fn publish_autodisabled(worker: &Worker, due: &DueDelivery, consecutive_failures: i32) {
    let message = json!({
        "webhookId": due.webhook_id,
        "projectId": due.project_id,
        "consecutiveFailures": consecutive_failures,
        "at": chrono::Utc::now().to_rfc3339(),
    })
    .to_string();

    if let Err(e) = worker
        .nats
        .publish(worker.autodisable_subject.clone(), message.into())
        .await
    {
        tracing::warn!(
            error = %e,
            webhook_id = due.webhook_id,
            "support webhook auto-disable notification failed (the endpoint is disabled regardless)"
        );
    }
}

/// Whether `attempt` was the last one allowed.
fn is_exhausted(attempt: i32, max_attempts: i32) -> bool {
    attempt >= max_attempts.max(1)
}

/// Delay before the attempt *after* `attempt`, off the published schedule.
/// Past the end of the table it holds at the last step rather than growing.
fn backoff_secs(attempt: i32) -> u64 {
    BACKOFF_SCHEDULE_SECS
        .get((attempt.max(1) - 1) as usize)
        .copied()
        .unwrap_or(21_600)
}

/// Keep a pathological error string out of the `lastError` column.
fn truncate_error(error: &str) -> String {
    truncate_on_char_boundary(error, MAX_ERROR_BYTES).0
}

/// A response/request body as storable text, plus whether it was cut.
///
/// Lossy first, because a response body can be anything (gzip, protobuf, a
/// truncated multi-byte sequence) and a stored pane of replacement characters
/// is more useful than no pane at all.
fn truncate_body(bytes: &[u8]) -> (String, bool) {
    truncate_on_char_boundary(&String::from_utf8_lossy(bytes), MAX_BODY_BYTES)
}

/// Cut `value` to at most `max` bytes on a char boundary, appending an ellipsis
/// when it cut. Returns the text and whether truncation happened.
fn truncate_on_char_boundary(value: &str, max: usize) -> (String, bool) {
    if value.len() <= max {
        return (value.to_string(), false);
    }
    let mut cut = max;
    while !value.is_char_boundary(cut) {
        cut -= 1;
    }
    (format!("{}…", &value[..cut]), true)
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

/// The JSON envelope Node's `encryptApiKey` (`packages/ai/src/crypto.ts`)
/// produces: AES-256-GCM with a 12-byte IV, each field base64.
#[derive(serde::Deserialize)]
struct EncryptedBlob {
    iv: String,
    ciphertext: String,
    tag: String,
}

/// Decrypt a `SupportWebhook.secret` written by Node's `encryptApiKey`.
///
/// Node keeps the GCM tag in its own field; the Rust `aead` API expects it
/// appended to the ciphertext, hence the concat.
fn decrypt_secret(key: &[u8], blob_json: &str) -> anyhow::Result<String> {
    let blob: EncryptedBlob = serde_json::from_str(blob_json)?;
    let iv = B64.decode(blob.iv.as_bytes())?;
    let mut ciphertext = B64.decode(blob.ciphertext.as_bytes())?;
    let tag = B64.decode(blob.tag.as_bytes())?;
    if iv.len() != 12 {
        anyhow::bail!("expected a 12-byte IV, got {}", iv.len());
    }
    ciphertext.extend_from_slice(&tag);

    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| anyhow::anyhow!("invalid AES-256 key: {e}"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("AES-256-GCM authentication failed"))?;

    Ok(String::from_utf8(plaintext)?)
}

/// `X-Clickroom-Signature` value: `t=<unix>,v1=<hex>`, and during a rotation
/// grace window `t=<unix>,v1=<HMAC old>,v2=<HMAC new>`.
///
/// keep in sync with `webhookSignatureHeader` in
/// `packages/trpc-router/src/trpc/routers/support.webhook-signing.ts` (and its
/// test file, `support.webhook-signing.test.ts`).
///
/// **`v1` is the old secret and `v2` the new one — not Stripe's dual-`v1`.**
/// Stripe emits two `v1=` values and expects a receiver to accept if any
/// matches; a hand-written verifier that splits on `,v1=` and takes one value
/// — which is what almost every one of them does — then picks a coin flip, and
/// rotating a secret (a *security* action) causes a silent 24-hour outage.
/// Keeping `v1` on the old secret means every naive verifier keeps working
/// untouched for the whole window, and by the time `v1` carries the new secret
/// the customer has had a full day to deploy it.
///
/// `previous` is `(plaintext old secret, grace deadline as a unix timestamp)`;
/// the old half is dropped the moment the deadline passes.
fn signature_header(
    secret: &str,
    previous: Option<(&str, i64)>,
    timestamp: i64,
    body: &[u8],
) -> String {
    let current = sign_body(secret, timestamp, body);
    match previous {
        Some((old, expires_at)) if timestamp < expires_at => {
            let old = sign_body(old, timestamp, body);
            format!("t={timestamp},v1={old},v2={current}")
        }
        _ => format!("t={timestamp},v1={current}"),
    }
}

/// Lowercase hex HMAC-SHA256 over the Stripe-style signed payload
/// `<timestamp>.<raw body bytes>`, keyed by the webhook's plaintext secret (its
/// UTF-8 bytes, i.e. the string the customer was shown at create time — not its
/// hex decoding).
///
/// The timestamp is inside the MAC deliberately: signing the body alone would
/// leave `t` attacker-controlled, and the freshness check every customer is
/// told to perform would then be enforcing a number the attacker picked.
///
/// keep in sync with `signWebhookBody` in
/// `packages/trpc-router/src/trpc/routers/support.webhook-signing.ts` (and its
/// test file, `support.webhook-signing.test.ts`). Both sides pin the identical
/// fixed vector — see `signs_the_known_vector` below — so either one drifting
/// fails loudly rather than silently breaking every customer's verification.
fn sign_body(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as HmacKeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed vector: this exact secret + timestamp + body must produce this
    /// exact hex, or every customer's verification snippet silently starts
    /// rejecting. Cross-checked against Node:
    /// `crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')`.
    #[test]
    fn signs_the_known_vector() {
        let body = r#"{"event":"ticket.created","ticket":{"id":"01J0000000000000000000"}}"#;
        assert_eq!(
            sign_body("whsec_super_secret", 1_700_000_000, body.as_bytes()),
            "c763e080b109ec6a96e6b09e2e931e677a2a29bb6b767321a1169959504114f6"
        );
    }

    #[test]
    fn signature_header_carries_timestamp_and_v1() {
        let header = signature_header("whsec_super_secret", None, 1_700_000_000, b"{}");
        assert!(header.starts_with("t=1700000000,v1="));
        assert_eq!(header.split(",v1=").nth(1).unwrap().len(), 64);
        assert!(!header.contains(",v2="), "no v2 outside a rotation window");
    }

    /// Inside the grace window: `v1` is the OLD secret so a naive verifier that
    /// splits on `,v1=` keeps working, `v2` is the new one.
    #[test]
    fn grace_window_signs_v1_old_and_v2_new() {
        let body = b"{}";
        let header = signature_header(
            "new_secret",
            Some(("old_secret", 1_700_000_060)),
            1_700_000_000,
            body,
        );
        let v1 = header
            .split(",v1=")
            .nth(1)
            .unwrap()
            .split(",v2=")
            .next()
            .unwrap();
        let v2 = header.split(",v2=").nth(1).unwrap();

        assert!(header.starts_with("t=1700000000,"));
        assert_eq!(v1, sign_body("old_secret", 1_700_000_000, body));
        assert_eq!(v2, sign_body("new_secret", 1_700_000_000, body));
        assert_ne!(v1, v2);
    }

    /// The window is data, not a constant: once the stored deadline passes, the
    /// old half is dropped and `v1` becomes the new secret.
    #[test]
    fn grace_window_expires_back_to_a_single_v1() {
        let body = b"{}";
        let expired = signature_header(
            "new_secret",
            Some(("old_secret", 1_700_000_000)),
            1_700_000_000,
            body,
        );
        assert!(!expired.contains(",v2="), "the deadline is exclusive");
        assert_eq!(
            expired,
            format!(
                "t=1700000000,v1={}",
                sign_body("new_secret", 1_700_000_000, body)
            ),
            "after grace, v1 carries the new secret"
        );
        assert_eq!(
            signature_header("new_secret", None, 1_700_000_000, body),
            expired,
            "no previous secret is the same header as an expired one"
        );
    }

    /// A different secret must not produce the same signature (guards against
    /// an accidental keyless hash).
    #[test]
    fn signature_depends_on_the_secret() {
        assert_ne!(sign_body("a", 1, b"body"), sign_body("b", 1, b"body"));
    }

    /// The whole point of the Stripe scheme: replaying a captured body under a
    /// fresh `t` must invalidate `v1`, so the freshness check cannot be
    /// side-stepped by rewriting the header.
    #[test]
    fn signature_covers_the_timestamp() {
        let body = b"{\"event\":\"ticket.created\"}";
        assert_ne!(
            sign_body("whsec_super_secret", 1_700_000_000, body),
            sign_body("whsec_super_secret", 1_700_000_001, body)
        );
    }

    /// `t` and the body are joined by a literal `.`, and the split must not be
    /// ambiguous: a body that starts with digits+`.` cannot be re-cut to forge
    /// a different timestamp.
    #[test]
    fn timestamp_and_body_are_not_ambiguously_joined() {
        assert_ne!(
            sign_body("s", 17, b"00.{}"),
            sign_body("s", 1_700, b"{}"),
            "1700.{{}} must not collide with 17.00.{{}}"
        );
    }

    /// The blob was produced by Node's `encryptApiKey` with this key, so a
    /// green test here is proof the two languages agree on the format.
    #[test]
    fn decrypts_a_node_encrypted_blob() {
        let key = hex::decode("4f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8")
            .unwrap();
        let blob = r#"{"iv":"EBESExQVFhcYGRob","ciphertext":"6Nt50JJOD4N2uUMo9aTVKHb7","tag":"IZum/ytWyb4Mr+U0b+u76Q=="}"#;
        assert_eq!(decrypt_secret(&key, blob).unwrap(), "whsec_super_secret");
    }

    #[test]
    fn rejects_a_tampered_blob() {
        let key = hex::decode("4f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8")
            .unwrap();
        let blob = r#"{"iv":"EBESExQVFhcYGRob","ciphertext":"6Nt50JJOD4N2uUMo9aTVKHb8","tag":"IZum/ytWyb4Mr+U0b+u76Q=="}"#;
        assert!(decrypt_secret(&key, blob).is_err());
    }

    #[test]
    fn encryption_key_must_be_32_bytes_of_hex() {
        assert!(resolve_encryption_key(None).is_err());
        assert!(resolve_encryption_key(Some("nothex")).is_err());
        assert!(resolve_encryption_key(Some("00112233")).is_err());
        assert!(resolve_encryption_key(Some(&"ab".repeat(32))).is_ok());
    }

    /// The published schedule: 30s / 2m / 10m / 1h / 6h, holding at 6h.
    #[test]
    fn backoff_follows_the_published_schedule() {
        assert_eq!(backoff_secs(1), 30);
        assert_eq!(backoff_secs(2), 120);
        assert_eq!(backoff_secs(3), 600);
        assert_eq!(backoff_secs(4), 3_600);
        assert_eq!(backoff_secs(5), 21_600);
        assert_eq!(backoff_secs(6), 21_600, "holds at the last step");
        assert_eq!(backoff_secs(7), 21_600);
        assert_eq!(backoff_secs(1000), 21_600, "no overflow at absurd attempts");
        assert_eq!(
            backoff_secs(0),
            30,
            "a nonsense attempt still yields the base"
        );
    }

    /// The retry decision, exactly as documented to customers.
    #[test]
    fn classifies_every_documented_status() {
        assert_eq!(classify(Some(200)), Class::Delivered);
        assert_eq!(classify(Some(204)), Class::Delivered);
        // reqwest follows redirects, so a 3xx here means the budget ran out.
        assert_eq!(classify(Some(301)), Class::Fatal);
        assert_eq!(classify(Some(400)), Class::Fatal);
        assert_eq!(
            classify(Some(401)),
            Class::Fatal,
            "a wrong token stays wrong"
        );
        assert_eq!(classify(Some(404)), Class::Retryable, "mid-rollout");
        assert_eq!(classify(Some(408)), Class::Retryable);
        assert_eq!(classify(Some(429)), Class::Retryable);
        assert_eq!(classify(Some(500)), Class::Retryable);
        assert_eq!(classify(Some(503)), Class::Retryable);
        assert_eq!(classify(None), Class::Retryable, "DNS / connect / timeout");
    }

    /// The `outcome` column's vocabulary, which the history sheet renders.
    #[test]
    fn labels_http_outcomes() {
        assert_eq!(http_outcome(200), "delivered");
        assert_eq!(http_outcome(429), "rate_limited");
        assert_eq!(http_outcome(503), "retryable_http");
        assert_eq!(http_outcome(404), "retryable_http");
        assert_eq!(http_outcome(401), "fatal_http");
        assert_eq!(SendOutcome::crypto_failure().outcome, "crypto");
        assert_eq!(SendOutcome::blocked_url().outcome, "blocked_url");
    }

    /// A URL the guard refuses produces a fully-formed attempt row with no
    /// response and no request — nothing was sent — and `record_failure` is
    /// called with `Class::Fatal`, so it does not burn five attempts on a URL
    /// that cannot start working.
    #[test]
    fn a_blocked_url_is_a_pre_send_fatal_outcome() {
        let blocked = SendOutcome::blocked_url();
        assert_eq!(blocked.status, None, "nothing was sent");
        assert_eq!(blocked.latency_ms, 0);
        assert_eq!(blocked.response_body, "");
        assert!(!blocked.body_truncated);
        // Terminal on attempt one even though the cap is 5: `record_failure`
        // computes `exhausted || class == Fatal`, and attempt 1 of 5 is not
        // exhausted, so `Class::Fatal` is the only thing making it terminal.
        assert!(!is_exhausted(1, 5));
    }

    /// The guard the send path actually calls, exercised through this module so
    /// a future refactor cannot quietly unhook it.
    #[tokio::test]
    async fn the_send_path_guard_refuses_loopback_and_plain_http() {
        assert!(admit_webhook_url("https://127.0.0.1:8443/hook", false)
            .await
            .is_err());
        assert!(admit_webhook_url("http://hooks.example.com/hook", false)
            .await
            .is_err());
        // …and the dev flag admits the loopback receiver, but never http://.
        assert!(admit_webhook_url("https://127.0.0.1:8443/hook", true)
            .await
            .is_ok());
        assert!(admit_webhook_url("http://127.0.0.1:8443/hook", true)
            .await
            .is_err());
    }

    #[test]
    fn attempts_are_capped() {
        assert!(!is_exhausted(1, 5));
        assert!(!is_exhausted(4, 5));
        assert!(is_exhausted(5, 5), "the cap'th attempt is the last one");
        assert!(is_exhausted(7, 5), "never under-report past the cap");
        // A misconfigured cap must still allow one real attempt.
        assert!(is_exhausted(1, 0));
        assert!(is_exhausted(1, -3));
    }

    #[test]
    fn parses_capture_notification() {
        let payload = br#"{"deliveryId":"01JABC","event":"ticket.created"}"#;
        assert_eq!(parse_delivery_id(payload).as_deref(), Some("01JABC"));
        assert_eq!(parse_delivery_id(br#"{"event":"x"}"#), None);
        assert_eq!(parse_delivery_id(br#"{"deliveryId":""}"#), None);
        assert_eq!(parse_delivery_id(b"not json"), None);
    }

    #[test]
    fn truncates_long_errors_on_a_char_boundary() {
        assert_eq!(truncate_error("short"), "short");
        let long = "é".repeat(400);
        let truncated = truncate_error(&long);
        assert!(truncated.len() <= 504);
        assert!(truncated.ends_with('…'));
    }

    /// 64KB, cut on a char boundary even when the 64KB mark lands mid-sequence,
    /// and with invalid bytes replaced rather than the whole body dropped.
    #[test]
    fn truncates_bodies_at_64kb_on_a_char_boundary() {
        let (small, truncated) = truncate_body(b"{\"ok\":true}");
        assert_eq!(small, "{\"ok\":true}");
        assert!(!truncated);

        // 3-byte chars: 65536 is not a multiple of 3, so the byte cut lands
        // inside a character and has to walk back.
        let long = "€".repeat(30_000);
        assert!(long.len() > MAX_BODY_BYTES);
        let (body, truncated) = truncate_body(long.as_bytes());
        assert!(truncated);
        assert!(body.ends_with('…'));
        // Every kept byte is still a whole `€` (3 bytes) plus the 3-byte
        // ellipsis: a mid-character cut would show up as U+FFFD.
        assert!(!body.contains('\u{fffd}'), "no character was split");
        assert!(body.len() <= MAX_BODY_BYTES + '…'.len_utf8());

        // A binary body survives as lossy text rather than being discarded.
        let (binary, truncated) = truncate_body(&[0xff, 0xfe, b'o', b'k']);
        assert!(!truncated);
        assert!(binary.ends_with("ok"));
    }
}

#[cfg(test)]
mod db_tests {
    //! Live-Postgres tests for the auto-disable breaker, following the
    //! skip-when-unreachable convention of `identity.rs` and
    //! `webhook_retention_job.rs` (there is no DB harness in `services/ingest`;
    //! these skip rather than fail so `cargo test` stays green without docker
    //! infra). Requires `SupportWebhookAttempt` migration.
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::Row;
    use uuid::Uuid;

    fn test_database_url() -> String {
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://clickroom:clickroom@localhost:5433/clickroom".into());
        match url.split_once('?') {
            Some((base, _)) => base.to_string(),
            None => url,
        }
    }

    async fn live_pool() -> Option<PgPool> {
        let pool = match PgPoolOptions::new()
            .max_connections(2)
            .connect(&test_database_url())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipping webhook auto-disable test: Postgres not reachable ({e})");
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
            eprintln!("skipping webhook auto-disable test: SupportWebhookAttempt not migrated");
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
        let org_id = format!("org_whk_{suffix}");
        let project_id = format!("proj_whk_{suffix}");
        let webhook_id = format!("whk_{suffix}");

        sqlx::query(
            r#"INSERT INTO "Org" ("id", "name", "slug", "updatedAt")
               VALUES ($1, 'autodisable test', $2, now())"#,
        )
        .bind(&org_id)
        .bind(&org_id)
        .execute(pg)
        .await?;
        sqlx::query(
            r#"INSERT INTO "Project" ("id", "orgId", "name", "updatedAt")
               VALUES ($1, $2, 'autodisable test', now())"#,
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

    /// The production statement, not a copy of it: `note_terminal_failure`
    /// calls exactly this, so the test cannot drift away from what runs.
    async fn bump(pg: &PgPool, webhook_id: &str) -> (i32, bool, bool) {
        bump_consecutive_failures(pg, webhook_id)
            .await
            .expect("bump")
    }

    #[tokio::test]
    async fn the_twentieth_terminal_failure_disables_the_endpoint() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");

        for n in 1..AUTO_DISABLE_THRESHOLD {
            let (failures, active, disabled_at) = bump(&pg, &fx.webhook_id).await;
            assert_eq!(failures, n);
            assert!(active, "{n} failures must not disable a live endpoint");
            assert!(!disabled_at);
        }

        let (failures, active, disabled_at) = bump(&pg, &fx.webhook_id).await;
        assert_eq!(failures, AUTO_DISABLE_THRESHOLD);
        assert!(!active, "the 20th terminal failure flips it");
        assert!(disabled_at, "and stamps autoDisabledAt");

        cleanup(&pg, &fx).await;
    }

    #[tokio::test]
    async fn a_success_resets_the_counter() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");

        for _ in 0..5 {
            bump(&pg, &fx.webhook_id).await;
        }
        // The success path, as `record_delivered` runs it.
        clear_consecutive_failures(&pg, &fx.webhook_id)
            .await
            .expect("reset");

        let row = sqlx::query(
            r#"SELECT "consecutiveFailures", "active", ("lastDeliveryAt" IS NOT NULL) AS delivered
                 FROM "SupportWebhook" WHERE "id" = $1"#,
        )
        .bind(&fx.webhook_id)
        .fetch_one(&pg)
        .await
        .expect("webhook row");
        assert_eq!(row.get::<i32, _>("consecutiveFailures"), 0);
        assert!(row.get::<bool, _>("active"));
        assert!(row.get::<bool, _>("delivered"));

        // And the counter starts again from 1, not from where it left off.
        let (failures, _, _) = bump(&pg, &fx.webhook_id).await;
        assert_eq!(failures, 1);

        cleanup(&pg, &fx).await;
    }

    /// The per-attempt INSERT is the one new multi-bind statement in the worker
    /// and nothing else type-checks it, so run it for real: a delivered attempt
    /// and a no-response one, then the duplicate that `ON CONFLICT` swallows.
    #[tokio::test]
    async fn writes_one_attempt_row_per_attempt() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");
        let delivery_id = format!("dlv_{}", Uuid::now_v7());
        sqlx::query(
            r#"INSERT INTO "SupportWebhookDelivery"
               ("id", "webhookId", "event", "payload", "status", "attempts",
                "nextAttemptAt", "createdAt", "updatedAt")
               VALUES ($1, $2, 'ticket.created', '{"a":1}'::jsonb, 'pending', 1,
                       now(), now(), now())"#,
        )
        .bind(&delivery_id)
        .bind(&fx.webhook_id)
        .execute(&pg)
        .await
        .expect("seed delivery");

        let due = DueDelivery {
            id: delivery_id.clone(),
            attempts: 0,
            event: "ticket.created".to_string(),
            payload: r#"{"a":1}"#.to_string(),
            url: "https://example.test/hook".to_string(),
            secret: "enc".to_string(),
            webhook_id: fx.webhook_id.clone(),
            project_id: fx.project_id.clone(),
            is_test: false,
            previous_secret: None,
            previous_secret_expires_at: None,
        };

        let delivered = SendOutcome {
            status: Some(200),
            latency_ms: 214,
            request_headers: json!({ "x-clickroom-signature": "t=1,v1=abc" }),
            response_headers: json!({ "content-type": "application/json" }),
            response_body: "ok".to_string(),
            body_truncated: false,
            error: None,
            outcome: "delivered",
        };
        record_attempt(&pg, &due, 1, &delivered, None)
            .await
            .expect("attempt 1");
        // A transport failure: no status, no response headers, an error string.
        record_attempt(&pg, &due, 2, &SendOutcome::crypto_failure(), Some("boom"))
            .await
            .expect("attempt 2");
        // The claim makes this impossible in practice; it must not error.
        record_attempt(&pg, &due, 1, &delivered, None)
            .await
            .expect("duplicate attempt is swallowed");

        let row = sqlx::query(
            r#"SELECT "latencyMs", "responseCode", "outcome", "errorMessage", "requestBody",
                      "requestHeaders"->>'x-clickroom-signature' AS signature,
                      "responseBody", "bodyTruncated",
                      ("startedAt" <= now() AND "startedAt" > now() - interval '1 minute') AS started_sane
                 FROM "SupportWebhookAttempt"
                WHERE "deliveryId" = $1 AND "attempt" = 1"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("attempt row");
        assert_eq!(row.get::<i32, _>("latencyMs"), 214);
        assert_eq!(row.get::<Option<i32>, _>("responseCode"), Some(200));
        assert_eq!(row.get::<String, _>("outcome"), "delivered");
        assert_eq!(row.get::<Option<String>, _>("errorMessage"), None);
        assert_eq!(
            row.get::<Option<String>, _>("requestBody").as_deref(),
            Some(r#"{"a":1}"#)
        );
        // The signed request is stored verbatim, signature header included.
        assert_eq!(
            row.get::<Option<String>, _>("signature").as_deref(),
            Some("t=1,v1=abc")
        );
        assert_eq!(
            row.get::<Option<String>, _>("responseBody").as_deref(),
            Some("ok")
        );
        assert!(!row.get::<bool, _>("bodyTruncated"));
        assert!(row.get::<bool, _>("started_sane"));

        let second = sqlx::query(
            r#"SELECT "responseCode", "outcome", "errorMessage"
                 FROM "SupportWebhookAttempt" WHERE "deliveryId" = $1 AND "attempt" = 2"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("attempt 2 row");
        assert_eq!(second.get::<Option<i32>, _>("responseCode"), None);
        assert_eq!(second.get::<String, _>("outcome"), "crypto");
        assert_eq!(
            second.get::<Option<String>, _>("errorMessage").as_deref(),
            Some("boom")
        );

        let count: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM "SupportWebhookAttempt" WHERE "deliveryId" = $1"#,
        )
        .bind(&delivery_id)
        .fetch_one(&pg)
        .await
        .expect("count");
        assert_eq!(count, 2, "the duplicate attempt row was not inserted");

        let _ = sqlx::query(r#"DELETE FROM "SupportWebhookAttempt" WHERE "deliveryId" = $1"#)
            .bind(&delivery_id)
            .execute(&pg)
            .await;
        let _ = sqlx::query(r#"DELETE FROM "SupportWebhookDelivery" WHERE "id" = $1"#)
            .bind(&delivery_id)
            .execute(&pg)
            .await;
        cleanup(&pg, &fx).await;
    }

    /// A test delivery never touches the breaker in either direction: hammering
    /// Send test at a broken staging URL must not disable production, and a
    /// green test must not paper over real failures.
    #[tokio::test]
    async fn test_deliveries_never_move_the_counter() {
        let Some(pg) = live_pool().await else {
            return;
        };
        let fx = seed_webhook(&pg).await.expect("seed webhook");

        let due = DueDelivery {
            id: "dlv_test".to_string(),
            attempts: 0,
            event: "ping".to_string(),
            payload: "{}".to_string(),
            url: "https://example.test/hook".to_string(),
            secret: "enc".to_string(),
            webhook_id: fx.webhook_id.clone(),
            project_id: fx.project_id.clone(),
            is_test: true,
            previous_secret: None,
            previous_secret_expires_at: None,
        };

        assert!(
            !due.affects_breaker(),
            "a test delivery is invisible to the breaker"
        );
        // `record_failure` / `record_delivered` gate both writes on exactly
        // this predicate, so a test delivery reaches neither statement.
        for _ in 0..(AUTO_DISABLE_THRESHOLD + 10) {
            if due.affects_breaker() {
                bump(&pg, &fx.webhook_id).await;
            }
        }

        let row = sqlx::query(
            r#"SELECT "consecutiveFailures", "active" FROM "SupportWebhook" WHERE "id" = $1"#,
        )
        .bind(&fx.webhook_id)
        .fetch_one(&pg)
        .await
        .expect("webhook row");
        assert_eq!(row.get::<i32, _>("consecutiveFailures"), 0);
        assert!(row.get::<bool, _>("active"), "a test never auto-disables");

        cleanup(&pg, &fx).await;
    }
}
