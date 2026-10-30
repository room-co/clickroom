//! ClickHouse HTTP client for the SQL Explorer's restricted, read-only
//! query path.
//!
//! Adapted from `services/ingest/src/clickhouse.rs`'s reqwest-based pattern:
//! the SQL rides in the request body (a bodyless POST omits Content-Length
//! and ClickHouse rejects it with 411), basic auth carries the
//! `clickroom_query` credentials, and the response is parsed as ClickHouse's
//! `JSONCompact` envelope (`meta`/`data`/`rows`/`statistics`) rather than
//! ingest's `JSONEachRow`.

use std::time::Duration;

use serde::Serialize;

use crate::config::Config;

/// One column's name + ClickHouse type, as reported by `JSONCompact`'s `meta`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
}

/// A fully-parsed, already-executed query result, shaped for direct
/// serialization as the `/query` HTTP response body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub rows_read: u64,
    pub bytes_read: u64,
}

/// Errors executing an already-validated-and-rewritten query against
/// ClickHouse. The caller (`http.rs`) maps [`ClickHouseQueryError::Rejected`]
/// to a clean `400` and [`ClickHouseQueryError::Upstream`] to `502`.
#[derive(Debug, thiserror::Error)]
pub enum ClickHouseQueryError {
    /// ClickHouse itself rejected the query for a reason the caller can act
    /// on (execution timeout, row/byte/memory cap exceeded).
    #[error("{0}")]
    Rejected(String),
    /// Anything else — connection failure, unexpected response shape, a
    /// ClickHouse error that isn't an obvious resource-cap rejection.
    #[error("{0}")]
    Upstream(String),
}

/// Substrings ClickHouse's error text uses for the resource caps configured
/// on the `clickroom_query_profile` settings profile (029.1). Matched
/// case-insensitively against the response body.
const CAP_ERROR_MARKERS: [&str; 8] = [
    "timeout exceeded",
    "too_many_rows",
    "too many rows",
    "memory limit",
    "max_rows_to_read",
    "max_execution_time",
    "max_result_rows",
    "limit for rows or bytes to read exceeded",
];

fn is_cap_error(body: &str) -> bool {
    let lower = body.to_lowercase();
    CAP_ERROR_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// Mirrors `clickroom_query_profile`'s `max_threads = 2 READONLY` (migration
/// 007). Sent explicitly on every request as defense in depth — the profile
/// already pins this, but the outbound HTTP request should not depend solely
/// on that server-side pin.
const CH_MAX_THREADS: &str = "2";

/// Mirrors `clickroom_query_profile`'s `max_rows_to_read = 100000000
/// READONLY` (migration 007) — distinct from `max_result_rows`/`cfg.max_rows`,
/// which caps rows *returned*, not rows the query is allowed to *scan*.
const CH_MAX_ROWS_TO_READ: &str = "100000000";

/// `clickroom_query_profile` runs with `readonly = 1`, which forbids
/// changing *any* setting away from its current effective value (verified
/// manually against the dev ClickHouse instance — even brand-new settings
/// such as `max_bytes_before_external_group_by`/`_sort`, whose CH default is
/// `0`, are rejected the moment a non-zero value is requested, with
/// `Code: 164 … Cannot modify '<setting>' setting in readonly mode`). So the
/// settings sent here are deliberately limited to values that already equal
/// either the profile's own pin (`max_execution_time`, `max_threads`,
/// `max_rows_to_read`) or ClickHouse's own default (`timeout_overflow_mode`
/// defaults to `throw`) — anything else would make every query fail. Do not
/// add `max_bytes_before_external_group_by`/`max_bytes_before_external_sort`
/// here unless the profile's `readonly` level changes.
fn request_settings(cfg: &Config) -> [(&'static str, String); 4] {
    [
        ("max_execution_time", cfg.timeout_secs.to_string()),
        ("max_threads", CH_MAX_THREADS.to_string()),
        ("max_rows_to_read", CH_MAX_ROWS_TO_READ.to_string()),
        ("timeout_overflow_mode", "throw".to_string()),
    ]
}

/// HTTP client bound to a single ClickHouse endpoint, connected as the
/// restricted `clickroom_query` user (never the ingest/admin user).
#[derive(Clone)]
pub struct ClickHouseClient {
    http: reqwest::Client,
    url: String,
    user: String,
    password: String,
    database: String,
    /// Per-request ClickHouse HTTP-interface settings (029 Part A1) — sent as
    /// URL query params on every `execute` call. See [`request_settings`] for
    /// why this list is deliberately short.
    settings: Vec<(&'static str, String)>,
}

impl ClickHouseClient {
    /// Build the client from config. Errors only if the underlying HTTP
    /// client fails to build. The client timeout is set a little above
    /// ClickHouse's own `max_execution_time` so a stuck connection can't hang
    /// forever even if the server-side cap doesn't fire first.
    pub fn new(cfg: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(cfg.timeout_secs + 5))
            .build()?;
        Ok(Self {
            http,
            url: cfg.clickhouse_url.clone(),
            user: cfg.clickhouse_user.clone(),
            password: cfg.clickhouse_password.clone(),
            database: cfg.clickhouse_database.clone(),
            settings: request_settings(cfg).to_vec(),
        })
    }

    /// Liveness check — runs `SELECT 1`. Errors on connection failure or a
    /// non-2xx response.
    pub async fn ping(&self) -> anyhow::Result<()> {
        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&[("database", self.database.as_str())])
            .body("SELECT 1")
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("clickhouse ping failed: {status}: {body}"));
        }
        Ok(())
    }

    /// Execute an already-validated-and-rewritten, already row-limited
    /// SELECT and return its parsed result. `sql` must already be safe to
    /// run as-is (see `validate.rs` + `http.rs`'s `LIMIT` wrapping) — this
    /// method does not re-validate it.
    pub async fn execute(&self, sql: &str) -> Result<QueryResult, ClickHouseQueryError> {
        let full_sql = format!("{sql} FORMAT JSONCompact");

        let mut req = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&[("database", self.database.as_str())]);
        for (key, value) in &self.settings {
            req = req.query(&[(*key, value.as_str())]);
        }

        let resp = req
            .body(full_sql)
            .send()
            .await
            .map_err(|e| ClickHouseQueryError::Upstream(e.to_string()))?;

        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| ClickHouseQueryError::Upstream(e.to_string()))?;

        if !status.is_success() {
            if is_cap_error(&body) {
                return Err(ClickHouseQueryError::Rejected(clean_ch_error(&body)));
            }
            return Err(ClickHouseQueryError::Upstream(format!(
                "clickhouse query failed: {status}: {body}"
            )));
        }

        let raw: RawJsonCompact = serde_json::from_str(&body).map_err(|e| {
            ClickHouseQueryError::Upstream(format!("invalid clickhouse response: {e}: {body}"))
        })?;

        let columns = raw
            .meta
            .into_iter()
            .map(|m| ColumnMeta {
                name: m.name,
                type_: m.r#type,
            })
            .collect();

        let elapsed_ms = raw
            .statistics
            .as_ref()
            .map(|s| (s.elapsed * 1000.0).round() as u64)
            .unwrap_or(0);
        let rows_read = raw.statistics.as_ref().map(|s| s.rows_read).unwrap_or(0);
        let bytes_read = raw.statistics.as_ref().map(|s| s.bytes_read).unwrap_or(0);

        Ok(QueryResult {
            row_count: raw.rows,
            columns,
            rows: raw.data,
            elapsed_ms,
            rows_read,
            bytes_read,
        })
    }
}

/// Strip ClickHouse's verbose `Code: N. DB::Exception: ... (version x.y.z)`
/// wrapper down to just the exception message where possible, so the 400
/// body returned to the caller reads cleanly.
fn clean_ch_error(body: &str) -> String {
    body.lines()
        .next()
        .unwrap_or(body)
        .trim()
        .trim_start_matches("Code:")
        .split_once("DB::Exception:")
        .map(|(_, rest)| rest.trim().to_string())
        .unwrap_or_else(|| body.trim().to_string())
}

/// ClickHouse `FORMAT JSONCompact` response envelope.
#[derive(Debug, serde::Deserialize)]
struct RawJsonCompact {
    meta: Vec<RawMeta>,
    data: Vec<Vec<serde_json::Value>>,
    rows: usize,
    statistics: Option<RawStatistics>,
}

#[derive(Debug, serde::Deserialize)]
struct RawMeta {
    name: String,
    r#type: String,
}

#[derive(Debug, serde::Deserialize)]
struct RawStatistics {
    elapsed: f64,
    rows_read: u64,
    bytes_read: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            port: 3002,
            internal_query_secret: "test-secret".to_string(),
            clickhouse_url: "http://localhost:8123".to_string(),
            clickhouse_user: "clickroom_query".to_string(),
            clickhouse_password: "clickroom_query_dev".to_string(),
            clickhouse_database: "clickroom".to_string(),
            max_rows: 10_000,
            timeout_secs: 30,
            max_concurrency: 6,
        }
    }

    #[test]
    fn new_builds_client() {
        assert!(ClickHouseClient::new(&test_config()).is_ok());
    }

    #[test]
    fn request_settings_mirrors_timeout_and_pinned_profile_values() {
        let settings = request_settings(&test_config());
        assert_eq!(
            settings,
            [
                ("max_execution_time", "30".to_string()),
                ("max_threads", "2".to_string()),
                ("max_rows_to_read", "100000000".to_string()),
                ("timeout_overflow_mode", "throw".to_string()),
            ]
        );
    }

    #[test]
    fn parses_json_compact_envelope() {
        let raw = r#"{
            "meta": [{"name":"event","type":"String"}, {"name":"c","type":"UInt64"}],
            "data": [["click", "3"], ["view", "10"]],
            "rows": 2,
            "statistics": {"elapsed": 0.012, "rows_read": 100, "bytes_read": 2048}
        }"#;
        let parsed: RawJsonCompact = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.meta.len(), 2);
        assert_eq!(parsed.data.len(), 2);
        assert_eq!(parsed.rows, 2);
        assert_eq!(parsed.statistics.unwrap().rows_read, 100);
    }

    #[test]
    fn detects_cap_errors_case_insensitively() {
        assert!(is_cap_error(
            "Code: 159. DB::Exception: Timeout exceeded: elapsed 30.5 seconds"
        ));
        assert!(is_cap_error(
            "DB::Exception: Limit for rows or bytes to read exceeded"
        ));
        assert!(!is_cap_error(
            "Code: 60. DB::Exception: Table doesn't exist"
        ));
    }

    #[test]
    fn cleans_verbose_clickhouse_error() {
        let raw = "Code: 159. DB::Exception: Timeout exceeded: elapsed 30.5 seconds, maximum: 30. (TIMEOUT_EXCEEDED) (version 24.1.1)";
        assert_eq!(
            clean_ch_error(raw),
            "Timeout exceeded: elapsed 30.5 seconds, maximum: 30. (TIMEOUT_EXCEEDED) (version 24.1.1)"
        );
    }
}
