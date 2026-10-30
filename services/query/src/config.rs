//! Runtime configuration for query-rs, loaded from the process environment.
//!
//! `INTERNAL_QUERY_SECRET` is the only hard-required var (it gates the whole
//! `/query` API — there is no safe default for it). Everything else falls
//! back to sane dev defaults, mirroring `services/capture`/`services/ingest`.

use anyhow::anyhow;

/// Fully-resolved query-rs configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// TCP port for the HTTP listener.
    pub port: u16,
    /// Shared secret the caller (apps/api) must present as
    /// `Authorization: Bearer <secret>`. Required — this is the only thing
    /// standing between the internal network and an unauthenticated tenant
    /// SQL executor.
    pub internal_query_secret: String,
    /// ClickHouse HTTP endpoint (e.g. `http://localhost:8123`).
    pub clickhouse_url: String,
    /// ClickHouse user — the restricted `clickroom_query` readonly user
    /// provisioned by migration 007, never the ingest/admin user.
    pub clickhouse_user: String,
    /// ClickHouse password for `clickhouse_user`.
    pub clickhouse_password: String,
    /// ClickHouse database queries run against.
    pub clickhouse_database: String,
    /// Hard cap on rows returned to the caller, regardless of the caller's
    /// requested `limit`. Mirrors the ClickHouse profile's `max_result_rows`.
    pub max_rows: u64,
    /// Client-side request timeout (seconds). Set a little above ClickHouse's
    /// own `max_execution_time` so a slow/stuck connection doesn't hang
    /// forever if the server-side cap doesn't kick in first.
    pub timeout_secs: u64,
    /// Max number of `/query` requests allowed to run concurrently. Extra
    /// requests are rejected with `429` rather than queued, so a burst can't
    /// pile up connections against ClickHouse (029 Part A2).
    pub max_concurrency: usize,
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
            port: parse_or("QUERY_PORT", 3002)?,
            internal_query_secret: required("INTERNAL_QUERY_SECRET")?,
            clickhouse_url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_user: env_or("CLICKHOUSE_QUERY_USER", "clickroom_query"),
            clickhouse_password: secret_or_dev("CLICKHOUSE_QUERY_PASSWORD", "clickroom_query_dev")?,
            clickhouse_database: env_or("CLICKHOUSE_DATABASE", "clickroom"),
            max_rows: parse_or("QUERY_MAX_ROWS", 10_000)?,
            timeout_secs: parse_or("QUERY_TIMEOUT_SECS", 30)?,
            max_concurrency: parse_or("QUERY_MAX_CONCURRENCY", 6)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_errors_when_unset() {
        std::env::remove_var("QUERY_TEST_REQUIRED_UNSET");
        assert!(required("QUERY_TEST_REQUIRED_UNSET").is_err());
    }

    #[test]
    fn env_or_falls_back_to_default() {
        std::env::remove_var("QUERY_TEST_ENV_OR_UNSET");
        assert_eq!(env_or("QUERY_TEST_ENV_OR_UNSET", "fallback"), "fallback");
    }

    #[test]
    fn parse_or_parses_set_value() {
        std::env::set_var("QUERY_TEST_PARSE_OR", "42");
        assert_eq!(parse_or("QUERY_TEST_PARSE_OR", 0u16).unwrap(), 42);
        std::env::remove_var("QUERY_TEST_PARSE_OR");
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
