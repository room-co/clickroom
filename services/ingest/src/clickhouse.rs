//! ClickHouse HTTP client for batched event inserts.
//!
//! Talks to ClickHouse over its HTTP interface: the SQL statement rides in the
//! `query` URL param while the row data is streamed in the request body as
//! newline-delimited `JSONEachRow`. A single [`reqwest::Client`] is reused
//! across calls (internally `Arc`-shared, so the struct is cheaply `Clone`).

use std::collections::HashMap;

use crate::config::Config;
use anyhow::anyhow;
use serde_json::json;

/// Columns of the `events` table, in the order the INSERT statement expects.
/// `schema_valid`/`schema_errors` (006_events_schema_validation.sql) carry the
/// warn-mode taxonomy schema validation outcome computed per event in
/// `consumer.rs`/`schema.rs`.
const INSERT_QUERY: &str = "INSERT INTO events (uuid,project_id,event,distinct_id,timestamp,properties,elements_chain,created_at,schema_valid,schema_errors) FORMAT JSONEachRow";

/// HTTP client bound to a single ClickHouse endpoint and database.
#[derive(Clone)]
pub struct ClickHouseClient {
    http: reqwest::Client,
    url: String,
    user: String,
    password: String,
    database: String,
}

impl ClickHouseClient {
    /// Build the client from config. Errors only if the underlying HTTP client
    /// fails to build.
    pub fn new(cfg: &Config) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder().build()?;
        Ok(Self {
            http,
            url: cfg.clickhouse_url.clone(),
            user: cfg.clickhouse_user.clone(),
            password: cfg.clickhouse_password.clone(),
            database: cfg.clickhouse_database.clone(),
        })
    }

    /// Liveness check — runs `SELECT 1`. Errors on connection failure or a
    /// non-2xx response.
    pub async fn ping(&self) -> anyhow::Result<()> {
        // Send the query in the body (not just the `query` param): a bodyless
        // POST omits Content-Length and ClickHouse rejects it with 411.
        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .body("SELECT 1")
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("clickhouse ping failed: {status}: {body}"));
        }
        Ok(())
    }

    /// Insert a batch of pre-built `JSONEachRow` objects into `events`.
    ///
    /// Each [`serde_json::Value`] is an object whose keys are `events` column
    /// names. Each row is serialized to one line and the batch is POSTed in a
    /// single request. On any non-2xx status this returns an error carrying the
    /// ClickHouse response body, so the caller can nack/redeliver the batch.
    pub async fn insert_events(&self, rows: &[serde_json::Value]) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }

        let payload = rows_to_body(rows);

        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&[
                ("database", self.database.as_str()),
                ("query", INSERT_QUERY),
                ("date_time_input_format", "best_effort"),
            ])
            .body(payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("clickhouse insert failed: {status}: {body}"));
        }

        tracing::debug!(count = rows.len(), "inserted events into clickhouse");
        Ok(())
    }
}

/// `person_distinct_ids` access (identity merge). The table
/// is `ReplacingMergeTree(created_at) ORDER BY (project_id, distinct_id)`, so
/// stale rows aren't physically removed until a background merge — every read
/// here aggregates over the raw rows itself (`argMax`/`min`/`HAVING`) rather
/// than relying on `FINAL`, so results are correct immediately after a write.
impl ClickHouseClient {
    /// Resolve the *current* `person_id` mapping for a set of `distinct_id`s
    /// within a project. Ids with no row at all are simply absent from the
    /// returned map (never mapped, not an error).
    pub async fn person_current_mapping(
        &self,
        project_id: &str,
        distinct_ids: &[&str],
    ) -> anyhow::Result<HashMap<String, String>> {
        if distinct_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let placeholders: Vec<String> = (0..distinct_ids.len())
            .map(|i| format!("{{d{i}:String}}"))
            .collect();
        let sql = format!(
            "SELECT distinct_id, argMax(person_id, created_at) AS person_id \
             FROM person_distinct_ids \
             WHERE project_id = {{pid:String}} AND distinct_id IN ({}) \
             GROUP BY distinct_id \
             FORMAT JSONEachRow",
            placeholders.join(",")
        );

        let mut params: Vec<(String, &str)> = vec![("pid".to_string(), project_id)];
        for (i, id) in distinct_ids.iter().enumerate() {
            params.push((format!("d{i}"), id));
        }
        let param_refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), *v)).collect();

        let rows = self.query_rows(&sql, &param_refs).await?;
        let mut out = HashMap::new();
        for row in rows {
            let distinct_id = row
                .get("distinct_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let person_id = row
                .get("person_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !distinct_id.is_empty() && !person_id.is_empty() {
                out.insert(distinct_id, person_id);
            }
        }
        Ok(out)
    }

    /// Earliest `created_at` observed across all rows of each `person_id`
    /// (used to pick the canonical/older person on a merge collision).
    pub async fn person_earliest_created_at(
        &self,
        project_id: &str,
        person_ids: &[&str],
    ) -> anyhow::Result<HashMap<String, String>> {
        if person_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let placeholders: Vec<String> = (0..person_ids.len())
            .map(|i| format!("{{p{i}:String}}"))
            .collect();
        let sql = format!(
            "SELECT person_id, min(created_at) AS first_seen \
             FROM person_distinct_ids \
             WHERE project_id = {{pid:String}} AND person_id IN ({}) \
             GROUP BY person_id \
             FORMAT JSONEachRow",
            placeholders.join(",")
        );

        let mut params: Vec<(String, &str)> = vec![("pid".to_string(), project_id)];
        for (i, id) in person_ids.iter().enumerate() {
            params.push((format!("p{i}"), id));
        }
        let param_refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), *v)).collect();

        let rows = self.query_rows(&sql, &param_refs).await?;
        let mut out = HashMap::new();
        for row in rows {
            let person_id = row
                .get("person_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let first_seen = row
                .get("first_seen")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !person_id.is_empty() {
                out.insert(person_id, first_seen);
            }
        }
        Ok(out)
    }

    /// Every `distinct_id` *currently* (post-argMax) mapped to `person_id`
    /// within a project.
    pub async fn person_distinct_ids_for_person(
        &self,
        project_id: &str,
        person_id: &str,
    ) -> anyhow::Result<Vec<String>> {
        const SQL: &str = "SELECT distinct_id \
             FROM person_distinct_ids \
             WHERE project_id = {pid:String} \
             GROUP BY distinct_id \
             HAVING argMax(person_id, created_at) = {person:String} \
             FORMAT JSONEachRow";

        let rows = self
            .query_rows(SQL, &[("pid", project_id), ("person", person_id)])
            .await?;
        Ok(rows
            .iter()
            .filter_map(|row| row.get("distinct_id").and_then(|v| v.as_str()))
            .map(str::to_string)
            .collect())
    }

    /// Insert `(distinct_id, person_id, created_at)` rows into
    /// `person_distinct_ids` for one project. `created_at` must be a
    /// ClickHouse-parseable timestamp string (e.g. `chrono`'s
    /// `%Y-%m-%d %H:%M:%S%.3f`).
    pub async fn insert_person_distinct_ids(
        &self,
        project_id: &str,
        rows: &[(&str, &str, &str)],
    ) -> anyhow::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }

        const INSERT_PERSON_QUERY: &str = "INSERT INTO person_distinct_ids \
             (project_id,distinct_id,person_id,created_at) FORMAT JSONEachRow";

        let json_rows: Vec<serde_json::Value> = rows
            .iter()
            .map(|(distinct_id, person_id, created_at)| {
                json!({
                    "project_id": project_id,
                    "distinct_id": distinct_id,
                    "person_id": person_id,
                    "created_at": created_at,
                })
            })
            .collect();
        let payload = rows_to_body(&json_rows);

        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&[
                ("database", self.database.as_str()),
                ("query", INSERT_PERSON_QUERY),
                ("date_time_input_format", "best_effort"),
            ])
            .body(payload)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!(
                "clickhouse person_distinct_ids insert failed: {status}: {body}"
            ));
        }

        tracing::debug!(count = rows.len(), "inserted person_distinct_ids rows");
        Ok(())
    }

    /// Generic parameterized SELECT expecting a `FORMAT JSONEachRow`-shaped
    /// response body. `sql` uses ClickHouse `{name:Type}` bound-parameter
    /// syntax; `params` supplies each `name` → value (sent as `param_name`).
    async fn query_rows(
        &self,
        sql: &str,
        params: &[(&str, &str)],
    ) -> anyhow::Result<Vec<serde_json::Value>> {
        let param_keys: Vec<String> = params.iter().map(|(k, _)| format!("param_{k}")).collect();
        let mut query_params: Vec<(&str, &str)> = vec![("database", self.database.as_str())];
        for (key, (_, v)) in param_keys.iter().zip(params.iter()) {
            query_params.push((key.as_str(), v));
        }

        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&query_params)
            .body(sql.to_string())
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("clickhouse query failed: {status}: {body}"));
        }

        let mut out = Vec::new();
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            out.push(serde_json::from_str(line)?);
        }
        Ok(out)
    }
}

/// One row of the per-project event volume/last-seen aggregate.
#[derive(Debug, Clone)]
pub struct EventVolume {
    /// Event name.
    pub event: String,
    /// Number of events in the trailing 30-day window.
    pub count: i64,
    /// Most recent event timestamp, as ClickHouse renders it
    /// (`YYYY-MM-DD HH:MM:SS`); Postgres parses it with a `::timestamp` cast.
    pub last_seen: String,
}

impl ClickHouseClient {
    /// Aggregate the trailing-30-day event volume + last-seen timestamp per
    /// event for one project. Used by the off-hot-path volume job.
    ///
    /// `project_id` is passed as a bound ClickHouse query param (`{pid:String}`)
    /// so it can never break out of the SQL.
    pub async fn event_volumes(&self, project_id: &str) -> anyhow::Result<Vec<EventVolume>> {
        const SQL: &str = "SELECT event, count() AS c, max(timestamp) AS ls \
             FROM events \
             WHERE project_id = {pid:String} AND timestamp > now() - INTERVAL 30 DAY \
             GROUP BY event \
             FORMAT JSONEachRow";

        // The SQL goes in the request body (not a URL `query` param): a POST with
        // no body omits Content-Length and ClickHouse rejects it with 411. Bound
        // params + database stay as URL query params.
        let resp = self
            .http
            .post(format!("{}/", self.url))
            .basic_auth(&self.user, Some(&self.password))
            .query(&[
                ("database", self.database.as_str()),
                ("param_pid", project_id),
            ])
            .body(SQL)
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("clickhouse volume query failed: {status}: {body}"));
        }

        let mut out = Vec::new();
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let row: serde_json::Value = serde_json::from_str(line)?;
            let event = row
                .get("event")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // ClickHouse quotes 64-bit ints by default, so `c` may be a JSON
            // string or number — accept either.
            let count = row.get("c").map(json_to_i64).unwrap_or(0);
            let last_seen = row
                .get("ls")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            out.push(EventVolume {
                event,
                count,
                last_seen,
            });
        }
        Ok(out)
    }
}

/// Coerce a ClickHouse count value (JSON number or quoted 64-bit string) to i64.
fn json_to_i64(v: &serde_json::Value) -> i64 {
    match v {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

/// Serialize a batch of rows into a newline-delimited `JSONEachRow` body.
fn rows_to_body(rows: &[serde_json::Value]) -> String {
    rows.iter()
        .map(|r| r.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_config() -> Config {
        Config {
            nats_url: "nats://localhost:4222".to_string(),
            clickhouse_url: "http://localhost:8123".to_string(),
            clickhouse_user: "clickroom".to_string(),
            clickhouse_password: "clickroom".to_string(),
            clickhouse_database: "clickroom".to_string(),
            durable_name: "ingest".to_string(),
            stream_name: "EVENTS".to_string(),
            subject_filter: "events.raw.>".to_string(),
            batch_max_size: 1000,
            batch_max_wait_ms: 500,
            max_deliver: 5,
            ack_wait_secs: 30,
            dlq_subject_prefix: "events.dlq".to_string(),
            dlq_stream_max_age_secs: 604_800,
            dlq_stream_name: "EVENTS_DLQ".to_string(),
            database_url: "postgresql://clickroom:clickroom@localhost:5433/clickroom".to_string(),
            redis_url: "redis://localhost:6380".to_string(),
            volume_job_interval_secs: 3600,
            volume_job_enabled: true,
            webhook_job_enabled: true,
            webhook_job_interval_secs: 30,
            webhook_max_attempts: 6,
            webhook_request_timeout_secs: 10,
            webhook_sweep_batch_size: 100,
            webhook_subject: "support.webhook.delivery".to_string(),
            webhook_encryption_key_hex: None,
            webhook_retention_enabled: true,
            webhook_retention_interval_secs: 3600,
            webhook_retention_days: 30,
            webhook_delivery_delete_days: 0,
            webhook_allow_private_targets: false,
            webhook_autodisable_subject: "support.webhook.autodisabled".to_string(),
        }
    }

    #[test]
    fn new_builds_client() {
        let client = ClickHouseClient::new(&test_config());
        assert!(client.is_ok());
    }

    #[test]
    fn rows_to_body_joins_rows_with_newlines() {
        let rows = vec![
            json!({"uuid": "a", "event": "click"}),
            json!({"uuid": "b", "event": "view"}),
        ];
        let body = rows_to_body(&rows);
        let expected = format!("{}\n{}", rows[0], rows[1]);
        assert_eq!(body, expected);
        assert_eq!(body.lines().count(), 2);
    }

    #[test]
    fn rows_to_body_empty_is_empty_string() {
        assert_eq!(rows_to_body(&[]), "");
    }
}
