//! Runtime configuration for ingest-rs, loaded from the process environment.
//!
//! Required vars fail fast on boot. Optional tuning knobs (batch size/wait, DLQ
//! delivery cap) fall back to sane defaults. ClickHouse connection vars mirror
//! the TS `packages/clickhouse` client defaults.

use anyhow::anyhow;

/// Fully-resolved ingest configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// NATS server URL (JetStream enabled).
    pub nats_url: String,
    /// ClickHouse HTTP endpoint (e.g. `http://localhost:8123`).
    pub clickhouse_url: String,
    /// ClickHouse user.
    pub clickhouse_user: String,
    /// ClickHouse password.
    pub clickhouse_password: String,
    /// ClickHouse database bound for inserts.
    pub clickhouse_database: String,
    /// Durable pull-consumer name on the events stream.
    pub durable_name: String,
    /// JetStream stream name (default `EVENTS`, provisioned by capture-rs).
    /// Overridable so a separate e2e test environment can run its own
    /// isolated stream alongside the dev one without any code change.
    pub stream_name: String,
    /// Subject filter the durable pull consumer drains off the stream
    /// (default `events.raw.>`).
    pub subject_filter: String,
    /// Max messages drained into a single ClickHouse INSERT.
    pub batch_max_size: usize,
    /// Max time (ms) to wait filling a batch before flushing a partial one.
    pub batch_max_wait_ms: u64,
    /// JetStream redelivery cap. Parse-failure poison messages never reach
    /// this (DLQ'd on first delivery); insert-failure NAKs (ClickHouse
    /// down/degraded) redeliver up to this many times before DLQ'ing as a
    /// last resort. Default is large-finite (not unlimited) so a genuinely
    /// permanently-un-insertable batch eventually escapes the stream head,
    /// while comfortably outlasting a realistic ClickHouse outage (default ×
    /// `ack_wait_secs` ≈ 100 × 30s ≈ 50min).
    pub max_deliver: i64,
    /// Ack-wait (seconds): how long the server waits for an ack before redelivery.
    pub ack_wait_secs: u64,
    /// DLQ subject prefix; the poison message is published to
    /// `<prefix>.<project_id>` (falling back to `<prefix>.unknown`).
    pub dlq_subject_prefix: String,
    /// Retention (seconds) for the DLQ stream (`events.dlq.>`). Longer than the
    /// primary stream so poison messages survive for inspection (default 7d).
    pub dlq_stream_max_age_secs: u64,
    /// Name of the dead-letter stream (default `EVENTS_DLQ`).
    pub dlq_stream_name: String,
    /// Postgres connection string (Prisma-style query params stripped). Used by
    /// taxonomy discovery + the volume job.
    pub database_url: String,
    /// Redis URL used as the taxonomy discovery guard (`tax:seen:<project_id>`).
    pub redis_url: String,
    /// Interval (seconds) between volume/last-seen job runs (default 1h).
    pub volume_job_interval_secs: u64,
    /// Whether the background volume/last-seen job is enabled (default true).
    pub volume_job_enabled: bool,
    /// Whether the support webhook delivery worker is enabled (default true).
    pub webhook_job_enabled: bool,
    /// Interval (seconds) between webhook sweeps of due `pending` deliveries.
    /// The sweep is the durable path; the NATS notification below only makes
    /// the *first* attempt prompt (default 30s).
    pub webhook_job_interval_secs: u64,
    /// Max delivery attempts before a delivery is marked `failed` (default 5,
    /// on the 30s/2m/10m/1h/6h schedule — see
    /// `webhook_job::BACKOFF_SCHEDULE_SECS`).
    pub webhook_max_attempts: i32,
    /// Per-request HTTP timeout (seconds) when POSTing to a customer endpoint.
    pub webhook_request_timeout_secs: u64,
    /// Max deliveries claimed per sweep, so one backlog burst can't monopolise
    /// the worker or the Postgres pool (default 100).
    pub webhook_sweep_batch_size: i64,
    /// Core-NATS subject capture publishes delivery hints on. Must match
    /// capture's `CAPTURE_SUPPORT_WEBHOOK_SUBJECT`.
    pub webhook_subject: String,
    /// Hex-encoded AES-256-GCM key used by Node's `encryptApiKey`
    /// (`packages/ai/src/crypto.ts`) to encrypt `SupportWebhook.secret`.
    /// Optional at boot: absent only disables webhook delivery, and the worker
    /// says so loudly rather than the process refusing to ingest events.
    pub webhook_encryption_key_hex: Option<String>,
    /// Whether the support webhook retention purge job is enabled (default true).
    pub webhook_retention_enabled: bool,
    /// Interval (seconds) between retention purge runs (default 1h).
    pub webhook_retention_interval_secs: u64,
    /// Age (days) past which attempt bodies/headers and delivery payloads are
    /// nulled. Statistics (latency, response code, status) always survive.
    pub webhook_retention_days: i32,
    /// Age (days) past which non-pending delivery rows are hard-deleted.
    /// `0` (the default) disables the tier entirely.
    pub webhook_delivery_delete_days: i32,
    /// Whether the outbound SSRF guard (`webhook_url::admit_webhook_url`) is
    /// allowed to POST to a private/loopback/link-local address.
    ///
    /// **Default false**, so production is safe without anyone setting it. It
    /// exists purely for local development, where the webhook receiver is on
    /// `localhost`: with the guard on, every dev delivery would fail fatally
    /// with "resolves to a private or loopback address". It relaxes *only* the
    /// address check — an unparseable or non-HTTPS URL is still refused — so a
    /// dev box never runs a materially different guard. Never set it in an
    /// environment that can reach an internal network.
    pub webhook_allow_private_targets: bool,
    /// Core-NATS subject the worker publishes on when an endpoint is
    /// auto-disabled after too many consecutive terminal failures.
    /// Nothing consumes it today; it exists so a future mailer is a consumer
    /// rather than a worker change.
    pub webhook_autodisable_subject: String,
}

fn required(key: &str) -> anyhow::Result<String> {
    std::env::var(key).map_err(|_| anyhow!("required env var {key} is not set"))
}

/// True only when `NODE_ENV` is explicitly `development` or `test`. The committed dev
/// credential defaults below are usable ONLY then; production containers (NODE_ENV unset or
/// `production`) must supply real secrets or refuse to start.
fn dev_defaults_allowed() -> bool {
    matches!(
        std::env::var("NODE_ENV").as_deref(),
        Ok("development") | Ok("test")
    )
}

/// Resolve a credential: the env var when set and non-empty, else `dev_default` iff
/// [`dev_defaults_allowed`], else a hard error (fail closed).
fn secret_or_dev(key: &str, dev_default: &str) -> anyhow::Result<String> {
    resolve_secret(
        std::env::var(key).ok(),
        key,
        dev_default,
        dev_defaults_allowed(),
    )
}

fn resolve_secret(
    value: Option<String>,
    key: &str,
    dev_default: &str,
    dev_allowed: bool,
) -> anyhow::Result<String> {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => Ok(v),
        None if dev_allowed => Ok(dev_default.to_string()),
        None => Err(anyhow!(
            "required env var {key} is not set (the dev default is only usable when NODE_ENV is development or test)"
        )),
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Strip Prisma-style query params (e.g. `?schema=public`) that libpq/sqlx
/// do not understand from a Postgres connection string. Mirrors capture-rs.
fn sanitize_db_url(url: &str) -> String {
    match url.split_once('?') {
        Some((base, _)) => base.to_string(),
        None => url.to_string(),
    }
}

/// Resolve the Redis connection URL. Prefers a literal `REDIS_URL` (local
/// dev), else assembles one from discrete ElastiCache-style vars. Mirrors
/// capture-rs's `resolve_redis_url`.
fn resolve_redis_url() -> anyhow::Result<String> {
    if let Ok(url) = std::env::var("REDIS_URL") {
        return Ok(url);
    }
    let host = required("REDIS_HOST")?;
    let port = env_or("REDIS_PORT", "6379");
    let scheme = if parse_or("REDIS_TLS", false)? {
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
/// (local dev), else assembles one from discrete RDS-style vars. Mirrors
/// capture-rs's `resolve_database_url`.
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

impl Config {
    /// Load configuration from the environment, failing fast on missing
    /// required variables.
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            nats_url: required("NATS_URL")?,
            clickhouse_url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_user: env_or("CLICKHOUSE_USER", "clickroom"),
            clickhouse_password: secret_or_dev("CLICKHOUSE_PASSWORD", "clickroom")?,
            clickhouse_database: env_or("CLICKHOUSE_DATABASE", "clickroom"),
            durable_name: env_or("INGEST_DURABLE_NAME", "ingest"),
            stream_name: env_or("INGEST_STREAM_NAME", "EVENTS"),
            subject_filter: env_or("INGEST_SUBJECT_FILTER", "events.raw.>"),
            batch_max_size: parse_or("INGEST_BATCH_MAX_SIZE", 1000)?,
            batch_max_wait_ms: parse_or("INGEST_BATCH_MAX_WAIT_MS", 500)?,
            max_deliver: parse_or("INGEST_MAX_DELIVER", 100)?,
            ack_wait_secs: parse_or("INGEST_ACK_WAIT_SECS", 30)?,
            dlq_subject_prefix: env_or("INGEST_DLQ_SUBJECT_PREFIX", "events.dlq"),
            dlq_stream_max_age_secs: parse_or("INGEST_DLQ_STREAM_MAX_AGE_SECS", 7 * 24 * 60 * 60)?,
            dlq_stream_name: env_or("INGEST_DLQ_STREAM_NAME", "EVENTS_DLQ"),
            database_url: resolve_database_url()?,
            redis_url: resolve_redis_url()?,
            volume_job_interval_secs: parse_or("INGEST_VOLUME_JOB_INTERVAL_SECS", 3600)?,
            volume_job_enabled: parse_or("INGEST_VOLUME_JOB_ENABLED", true)?,
            webhook_job_enabled: parse_or("INGEST_WEBHOOK_JOB_ENABLED", true)?,
            webhook_job_interval_secs: parse_or("INGEST_WEBHOOK_JOB_INTERVAL_SECS", 30)?,
            webhook_max_attempts: parse_or("INGEST_WEBHOOK_MAX_ATTEMPTS", 5)?,
            webhook_request_timeout_secs: parse_or("INGEST_WEBHOOK_REQUEST_TIMEOUT_SECS", 10)?,
            webhook_sweep_batch_size: parse_or("INGEST_WEBHOOK_SWEEP_BATCH_SIZE", 100)?,
            webhook_subject: env_or("INGEST_SUPPORT_WEBHOOK_SUBJECT", "support.webhook.delivery"),
            webhook_encryption_key_hex: std::env::var("AI_ENCRYPTION_KEY").ok(),
            webhook_retention_enabled: parse_or("INGEST_WEBHOOK_RETENTION_ENABLED", true)?,
            webhook_retention_interval_secs: parse_or(
                "INGEST_WEBHOOK_RETENTION_INTERVAL_SECS",
                3600,
            )?,
            webhook_retention_days: parse_or("INGEST_WEBHOOK_RETENTION_DAYS", 30)?,
            webhook_delivery_delete_days: parse_or("INGEST_WEBHOOK_DELIVERY_DELETE_DAYS", 0)?,
            webhook_allow_private_targets: parse_or("INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS", false)?,
            webhook_autodisable_subject: env_or(
                "INGEST_WEBHOOK_AUTODISABLE_SUBJECT",
                "support.webhook.autodisabled",
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_secret, sanitize_db_url};

    #[test]
    fn strips_prisma_schema_param() {
        assert_eq!(
            sanitize_db_url("postgresql://u:p@localhost:5433/db?schema=public"),
            "postgresql://u:p@localhost:5433/db"
        );
    }

    #[test]
    fn leaves_plain_url_untouched() {
        assert_eq!(
            sanitize_db_url("postgresql://u:p@localhost:5433/db"),
            "postgresql://u:p@localhost:5433/db"
        );
    }

    #[test]
    fn resolve_secret_fails_closed_outside_dev() {
        assert_eq!(
            resolve_secret(Some("real".into()), "K", "dev", false).unwrap(),
            "real"
        );
        assert_eq!(resolve_secret(None, "K", "dev", true).unwrap(), "dev");
        assert_eq!(
            resolve_secret(Some(String::new()), "K", "dev", true).unwrap(),
            "dev"
        );
        assert!(resolve_secret(None, "K", "dev", false).is_err());
        assert!(resolve_secret(Some(String::new()), "K", "dev", false).is_err());
    }
}
