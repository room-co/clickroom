//! Runtime configuration loaded from the process environment.
//!
//! Required vars fail fast on boot with a clear error. Optional tuning knobs
//! (rate-limit, cache TTLs, stream retention) fall back to sane defaults.

use anyhow::{anyhow, Context as _};

/// Fully-resolved service configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// TCP port for the HTTP listener.
    pub port: u16,
    /// NATS server URL (JetStream enabled).
    pub nats_url: String,
    /// Redis URL used for the key cache + rate-limit buckets.
    pub redis_url: String,
    /// Postgres connection string (Prisma-style query params stripped).
    pub database_url: String,
    /// TTL (seconds) for a positive `capture:key:<hash>` -> project_id cache entry.
    pub key_cache_ttl_secs: u64,
    /// TTL (seconds) for a negative (unknown/revoked) key cache entry.
    pub key_neg_cache_ttl_secs: u64,
    /// Token-bucket capacity (max burst) per project.
    pub rate_limit_burst: u64,
    /// Token-bucket refill rate (tokens per second) per project.
    pub rate_limit_refill_per_sec: u64,
    /// JetStream `EVENTS` stream max-age retention in seconds (secondary bound
    /// under `WorkQueue` retention — the primary bound is consumption: a
    /// message is evicted once ingest's durable consumer acks it).
    pub stream_max_age_secs: u64,
    /// JetStream `EVENTS` stream byte-size ceiling. Under `WorkQueue`
    /// retention this is the real backpressure mechanism: if ingest/ClickHouse
    /// falls behind for long enough to fill this, further `capture::publish`
    /// calls fail and the endpoint returns 503 rather than letting the stream
    /// (and the shared Docker VM's memory) grow unbounded.
    pub stream_max_bytes: i64,
    /// JetStream stream name (default `EVENTS`). Overridable so a separate
    /// e2e test environment can provision its own isolated stream alongside
    /// the dev one without any code change.
    pub stream_name: String,
    /// JetStream subject prefix events are published under (default
    /// `events.raw`); the stream's wildcard subject is `<prefix>.>` and each
    /// event is published to `<prefix>.<project_id>`.
    pub subject_prefix: String,
    /// Usage tracking + quotas: whether `quota::check_*` rejects
    /// over-limit requests. Counting always happens regardless of this flag;
    /// it only gates the reject decision, so it can flip to track-only
    /// without a code change (same env read on the `apps/api` tRPC side).
    /// Read by `quota.rs`, reachable now via `capture.rs`'s `check_events`
    /// call.
    pub quota_enforce: bool,
    /// Max time (ms) to wait for a batch's JetStream publish acks before
    /// giving up and returning a `503` instead of hanging the request task
    /// forever. See `nats::publish_batch` / `capture.rs`.
    pub nats_publish_timeout_ms: u64,
    /// Max number of concurrent in-flight NATS publish+ack pairs allowed
    /// across the whole process at once (bounded via a shared `Semaphore` on
    /// `AppState`), to avoid saturating the single shared JetStream
    /// connection under high concurrency.
    pub nats_max_concurrent_publishes: usize,
    /// S3 bucket support-ticket attachments are presigned
    /// against. `None` when unset: every other route still works and only
    /// `POST /v1/support/attachments/presign` fails, rather than the whole
    /// service refusing to boot on a deployment that does not use support.
    pub support_attachments_bucket: Option<String>,
    /// AWS region used for presigning.
    pub aws_region: String,
    /// S3 endpoint override — set to LocalStack in dev, UNSET in prod (which
    /// is what makes the SDK resolve real S3).
    pub s3_endpoint: Option<String>,
    /// Browser-reachable S3 endpoint used for presigning specifically. The
    /// signed URL is followed by the *browser*, not by capture-rs, so when the
    /// two differ (capture inside compose, browser on the host) this is the
    /// one that must be baked into the signature. UNSET in prod.
    pub s3_public_endpoint: Option<String>,
    /// Path-style S3 addressing — required against LocalStack, which has no
    /// per-bucket virtual host.
    pub s3_force_path_style: bool,
    /// Core-NATS subject the support webhook delivery notification is
    /// published to; `services/ingest`'s delivery worker consumes it.
    /// The notification is a latency optimization only — durability comes from
    /// the `SupportWebhookDelivery` row and the worker's sweep — so a publish
    /// failure here is logged, never fatal.
    pub support_webhook_subject: String,
}

fn required(key: &str) -> anyhow::Result<String> {
    std::env::var(key).map_err(|_| anyhow!("required env var {key} is not set"))
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Read an optional env var, treating an empty/whitespace value as unset.
///
/// Distinguishing "unset" from "set to empty string" matters for the S3
/// endpoint overrides: an empty `S3_ENDPOINT` in a prod task definition must
/// resolve to real S3, not to an endpoint URL of `""`.
fn optional(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_or<T: std::str::FromStr>(key: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Ok(v) => v
            .parse::<T>()
            .map_err(|e| anyhow!("env var {key} is invalid: {e}")),
        Err(_) => Ok(default),
    }
}

/// Strip Prisma-style query params (e.g. `?schema=public`) that libpq/sqlx
/// do not understand from a Postgres connection string.
fn sanitize_db_url(url: &str) -> String {
    match url.split_once('?') {
        Some((base, _)) => base.to_string(),
        None => url.to_string(),
    }
}

/// Resolve the Redis connection URL. Prefers a literal `REDIS_URL` (local
/// dev via docker-compose), else assembles one from discrete ElastiCache-style
/// vars: `REDIS_HOST`/`REDIS_PORT` as plain env, `REDIS_AUTH_TOKEN` via the ECS
/// `secrets` field so the token is resolved by the ECS agent at container
/// start and never appears in the CloudFormation-managed task definition
/// (same pattern apps/api uses for DB_USER/DB_PASSWORD).
fn resolve_redis_url() -> anyhow::Result<String> {
    if let Ok(url) = std::env::var("REDIS_URL") {
        return Ok(url);
    }
    let host = required("REDIS_HOST")?;
    let port = env_or("REDIS_PORT", "6379");
    let scheme = if parse_bool_or("REDIS_TLS", false)? {
        "rediss"
    } else {
        "redis"
    };
    match std::env::var("REDIS_AUTH_TOKEN") {
        Ok(token) => Ok(format!("{scheme}://:{token}@{host}:{port}")),
        Err(_) => Ok(format!("{scheme}://{host}:{port}")),
    }
}

/// Resolve the Postgres connection URL. Prefers a literal `DATABASE_URL`
/// (local dev), else assembles one from discrete RDS-style vars — mirrors
/// `resolve_redis_url` above.
fn resolve_database_url() -> anyhow::Result<String> {
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return Ok(sanitize_db_url(&url));
    }
    let host = required("DB_HOST")?;
    let port = env_or("DB_PORT", "5432");
    let user = required("DB_USER")?;
    let password = required("DB_PASSWORD")?;
    let name = env_or("DB_NAME", "clickroom");
    Ok(format!("postgres://{user}:{password}@{host}:{port}/{name}"))
}

/// Parse a boolean env var accepting the common truthy/falsy spellings
/// (`true`/`false`, `1`/`0`, `on`/`off`), case-insensitively. Falls back to
/// `default` when unset; an unrecognized value is a hard config error rather
/// than a silent fallback (a mistyped `QUOTA_ENFORCE` should fail loudly, not
/// quietly disable enforcement).
fn parse_bool_or(key: &str, default: bool) -> anyhow::Result<bool> {
    match std::env::var(key) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "on" => Ok(true),
            "false" | "0" | "off" => Ok(false),
            other => Err(anyhow!("env var {key} is invalid: {other:?}")),
        },
        Err(_) => Ok(default),
    }
}

impl Config {
    /// Load configuration from the environment, failing fast on missing
    /// required variables.
    pub fn from_env() -> anyhow::Result<Self> {
        let port: u16 = parse_or("CAPTURE_PORT", 3001).context("CAPTURE_PORT")?;
        let nats_url = required("NATS_URL")?;
        let redis_url = resolve_redis_url()?;
        let database_url = resolve_database_url()?;

        Ok(Self {
            port,
            nats_url,
            redis_url,
            database_url,
            key_cache_ttl_secs: parse_or("CAPTURE_KEY_CACHE_TTL_SECS", 60)?,
            key_neg_cache_ttl_secs: parse_or("CAPTURE_KEY_NEG_CACHE_TTL_SECS", 10)?,
            rate_limit_burst: parse_or("CAPTURE_RATE_LIMIT_BURST", 1000)?,
            rate_limit_refill_per_sec: parse_or("CAPTURE_RATE_LIMIT_REFILL_PER_SEC", 500)?,
            stream_max_age_secs: parse_or("CAPTURE_STREAM_MAX_AGE_SECS", 72 * 60 * 60)?,
            // 4GiB default: generous headroom for a realistic ClickHouse
            // outage on this dev box's shared ~8.3GB Docker VM budget, while
            // still bounding worst-case growth (vs the prior unbounded -1).
            stream_max_bytes: parse_or("CAPTURE_STREAM_MAX_BYTES", 4 * 1024 * 1024 * 1024)?,
            stream_name: env_or("CAPTURE_STREAM_NAME", "EVENTS"),
            subject_prefix: env_or("CAPTURE_SUBJECT_PREFIX", "events.raw"),
            quota_enforce: parse_bool_or("QUOTA_ENFORCE", true)?,
            nats_publish_timeout_ms: parse_or("CAPTURE_NATS_PUBLISH_TIMEOUT_MS", 5000)?,
            nats_max_concurrent_publishes: parse_or("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES", 500)?,
            support_attachments_bucket: optional("SUPPORT_ATTACHMENTS_BUCKET"),
            aws_region: env_or("AWS_REGION", "us-east-1"),
            s3_endpoint: optional("S3_ENDPOINT"),
            s3_public_endpoint: optional("S3_PUBLIC_ENDPOINT"),
            s3_force_path_style: parse_bool_or("S3_FORCE_PATH_STYLE", false)?,
            support_webhook_subject: env_or(
                "CAPTURE_SUPPORT_WEBHOOK_SUBJECT",
                "support.webhook.delivery",
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_bool_or, sanitize_db_url};

    #[test]
    fn strips_prisma_schema_param() {
        assert_eq!(
            sanitize_db_url("postgresql://u:p@localhost:5432/db?schema=public"),
            "postgresql://u:p@localhost:5432/db"
        );
    }

    #[test]
    fn leaves_plain_url_untouched() {
        assert_eq!(
            sanitize_db_url("postgresql://u:p@localhost:5432/db"),
            "postgresql://u:p@localhost:5432/db"
        );
    }

    /// The process environment is global, but `cargo test` runs tests on parallel threads. Any
    /// two tests that touch the SAME key race: `nats_max_concurrent_publishes_defaults_when_unset`
    /// would `remove_var` and assert the 500 default while
    /// `nats_max_concurrent_publishes_reads_configured_value` had just `set_var`'d it to 42 —
    /// giving an intermittent `left: 42, right: 500`. Every env-mutating test in this module takes
    /// this lock, so they serialize against each other while the rest of the suite still runs in
    /// parallel.
    ///
    /// Poisoning is ignored: a panic in one test (i.e. a normal test failure) must not cascade into
    /// spurious failures in every other env test.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn parse_bool_or_defaults_when_unset() {
        let _guard = env_guard();
        std::env::remove_var("CAPTURE_TEST_BOOL_UNSET");
        assert!(parse_bool_or("CAPTURE_TEST_BOOL_UNSET", true).unwrap());
        assert!(!parse_bool_or("CAPTURE_TEST_BOOL_UNSET", false).unwrap());
    }

    #[test]
    fn parse_bool_or_accepts_common_spellings() {
        let _guard = env_guard();
        for (raw, expected) in [
            ("true", true),
            ("TRUE", true),
            ("1", true),
            ("on", true),
            ("On", true),
            ("false", false),
            ("FALSE", false),
            ("0", false),
            ("off", false),
        ] {
            std::env::set_var("CAPTURE_TEST_BOOL_VALUE", raw);
            assert_eq!(
                parse_bool_or("CAPTURE_TEST_BOOL_VALUE", !expected).unwrap(),
                expected,
                "input {raw:?}"
            );
        }
        std::env::remove_var("CAPTURE_TEST_BOOL_VALUE");
    }

    #[test]
    fn parse_bool_or_rejects_unrecognized_value() {
        let _guard = env_guard();
        std::env::set_var("CAPTURE_TEST_BOOL_BAD", "maybe");
        assert!(parse_bool_or("CAPTURE_TEST_BOOL_BAD", true).is_err());
        std::env::remove_var("CAPTURE_TEST_BOOL_BAD");
    }

    #[test]
    fn nats_publish_timeout_ms_defaults_when_unset() {
        let _guard = env_guard();
        std::env::remove_var("CAPTURE_NATS_PUBLISH_TIMEOUT_MS");
        assert_eq!(
            super::parse_or::<u64>("CAPTURE_NATS_PUBLISH_TIMEOUT_MS", 5000).unwrap(),
            5000
        );
    }

    #[test]
    fn nats_publish_timeout_ms_reads_configured_value() {
        let _guard = env_guard();
        std::env::set_var("CAPTURE_NATS_PUBLISH_TIMEOUT_MS", "1234");
        assert_eq!(
            super::parse_or::<u64>("CAPTURE_NATS_PUBLISH_TIMEOUT_MS", 5000).unwrap(),
            1234
        );
        std::env::remove_var("CAPTURE_NATS_PUBLISH_TIMEOUT_MS");
    }

    #[test]
    fn nats_max_concurrent_publishes_defaults_when_unset() {
        let _guard = env_guard();
        std::env::remove_var("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES");
        assert_eq!(
            super::parse_or::<usize>("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES", 500).unwrap(),
            500
        );
    }

    #[test]
    fn nats_max_concurrent_publishes_reads_configured_value() {
        let _guard = env_guard();
        std::env::set_var("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES", "42");
        assert_eq!(
            super::parse_or::<usize>("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES", 500).unwrap(),
            42
        );
        std::env::remove_var("CAPTURE_NATS_MAX_CONCURRENT_PUBLISHES");
    }
}
