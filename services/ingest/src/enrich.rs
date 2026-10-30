//! Mapping from a decoded [`RawEvent`] into the JSON row used for a ClickHouse
//! `INSERT ... FORMAT JSONEachRow` against the `events` table.
//!
//! Only the explicit, writable columns are emitted:
//! `uuid, project_id, event, distinct_id, timestamp, properties, elements_chain,
//! created_at, schema_valid, schema_errors`. The `properties` column is a
//! ClickHouse `String` holding a JSON blob, so in the row object it is
//! serialized to a JSON *string* rather than a nested object.
//!
//! `schema_valid`/`schema_errors` are pure inputs here — this module stays a
//! plain mapping function and does not itself look up or run schema
//! validation. The caller (`consumer.rs`, via `schema.rs`) decides those two
//! values per event and passes them in.
//!
//! The `elements_chain_text`, `elements_chain_href`, and `current_url` columns
//! are `MATERIALIZED` (computed by ClickHouse from `elements_chain`/`properties`)
//! and MUST NOT be present in the insert row. The [`parse_element_text`] and
//! [`parse_element_href`] helpers mirror ClickHouse's `extract(...)` regexes and
//! exist primarily to pin the extraction contract in unit tests.

use serde_json::{json, Value};

use crate::models::RawEvent;

/// Build the JSONEachRow object for one ClickHouse `events` insert.
///
/// `properties` is serialized to a JSON string via [`serde_json::to_string`]
/// (falling back to `"{}"` on the practically-impossible serialization error);
/// materialized columns are omitted. `timestamp` and `created_at` are passed
/// through as the RFC3339 strings from `ev` — ClickHouse parses them with
/// `date_time_input_format=best_effort`, set by the caller.
///
/// `schema_valid`/`schema_errors` carry the outcome of warn-mode schema
/// validation (`schema.rs`'s `validate_event`): `1`/`""` when the event is
/// valid, unenforced, or has no applicable schema; `0`/a compact JSON array of
/// `schema_validate::Violation` when validation found problems. Warn mode
/// never drops the event — these are only ever tags on an inserted row.
pub fn to_insert_row(ev: &RawEvent, schema_valid: u8, schema_errors: &str) -> Value {
    let properties = serde_json::to_string(&ev.properties_object()).unwrap_or_else(|_| "{}".into());

    json!({
        "uuid": ev.uuid,
        "project_id": ev.project_id,
        "event": ev.event,
        "distinct_id": ev.distinct_id,
        "timestamp": ev.timestamp,
        "properties": properties,
        "elements_chain": ev.elements_chain,
        "created_at": ev.created_at,
        "schema_valid": schema_valid,
        "schema_errors": schema_errors,
    })
}

/// Extract the autocapture element text (`text="..."`) from an elements_chain,
/// if present. Mirrors ClickHouse's `extract(elements_chain, 'text="([^"]*)"')`.
///
/// The `events` table currently derives `elements_chain_text`/`_href` as
/// MATERIALIZED columns, so ingest does not compute them on the hot path today.
/// Kept (with tests) as the parity contract and for a future move to precomputed
/// plain columns (see `001_events.sql`).
#[allow(dead_code)]
pub fn parse_element_text(chain: &str) -> Option<String> {
    extract_quoted(chain, "text=\"")
}

/// Extract the autocapture element href (`href="..."`) from an elements_chain,
/// if present. Mirrors ClickHouse's `extract(elements_chain, 'href="([^"]*)"')`.
#[allow(dead_code)]
pub fn parse_element_href(chain: &str) -> Option<String> {
    extract_quoted(chain, "href=\"")
}

/// Find `<attr>"..."` in `haystack` and return the contents up to the next `"`.
///
/// `needle` is the attribute prefix including the opening quote (e.g. `text="`).
/// Regex-free to avoid a dependency; matches the `([^"]*)` capture semantics of
/// the ClickHouse `extract` calls.
#[allow(dead_code)]
fn extract_quoted(haystack: &str, needle: &str) -> Option<String> {
    let start = haystack.find(needle)? + needle.len();
    let rest = &haystack[start..];
    let end = rest.find('"').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_event(properties: Value) -> RawEvent {
        RawEvent {
            uuid: "018f7f00-0000-7000-8000-000000000000".into(),
            project_id: "proj_1".into(),
            event: "$autocapture".into(),
            distinct_id: "user_1".into(),
            timestamp: "2026-07-04T12:00:00Z".into(),
            properties,
            elements_chain: "a:href=\"https://x.com/y\";text=\"Buy now\"".into(),
            created_at: "2026-07-04T12:00:01Z".into(),
        }
    }

    #[test]
    fn properties_is_a_json_string_that_round_trips() {
        let props = json!({ "$current_url": "https://x.com/y", "n": 42 });
        let row = to_insert_row(&sample_event(props.clone()), 1, "");

        let properties = &row["properties"];
        assert!(properties.is_string(), "properties must be a JSON string");

        let parsed: Value = serde_json::from_str(properties.as_str().unwrap()).unwrap();
        assert_eq!(parsed, props);
    }

    #[test]
    fn includes_all_ten_columns() {
        let row = to_insert_row(&sample_event(json!({})), 1, "");
        let obj = row.as_object().unwrap();

        for col in [
            "uuid",
            "project_id",
            "event",
            "distinct_id",
            "timestamp",
            "properties",
            "elements_chain",
            "created_at",
            "schema_valid",
            "schema_errors",
        ] {
            assert!(obj.contains_key(col), "missing column {col}");
        }
        assert_eq!(obj.len(), 10, "exactly the 10 writable columns");
    }

    #[test]
    fn omits_materialized_columns() {
        let row = to_insert_row(
            &sample_event(json!({ "$current_url": "https://x.com/y" })),
            1,
            "",
        );
        let obj = row.as_object().unwrap();

        assert!(!obj.contains_key("elements_chain_text"));
        assert!(!obj.contains_key("elements_chain_href"));
        assert!(!obj.contains_key("current_url"));
    }

    #[test]
    fn passes_through_timestamps_and_ids() {
        let row = to_insert_row(&sample_event(json!({})), 1, "");
        assert_eq!(row["uuid"], "018f7f00-0000-7000-8000-000000000000");
        assert_eq!(row["timestamp"], "2026-07-04T12:00:00Z");
        assert_eq!(row["created_at"], "2026-07-04T12:00:01Z");
    }

    #[test]
    fn non_object_properties_serialize_to_empty_object() {
        for props in [json!(null), json!("a string"), json!(7), json!([1, 2, 3])] {
            let row = to_insert_row(&sample_event(props.clone()), 1, "");
            assert_eq!(row["properties"], json!("{}"), "for {props:?}");
        }
    }

    #[test]
    fn schema_valid_and_errors_pass_through_as_given() {
        let row = to_insert_row(&sample_event(json!({})), 1, "");
        assert_eq!(row["schema_valid"], 1);
        assert_eq!(row["schema_errors"], "");

        let violation_json = r#"[{"kind":"missing_required","property":"email"}]"#;
        let invalid_row = to_insert_row(&sample_event(json!({})), 0, violation_json);
        assert_eq!(invalid_row["schema_valid"], 0);
        assert_eq!(invalid_row["schema_errors"], violation_json);
    }

    #[test]
    fn parses_element_text() {
        let chain = "a:href=\"https://x.com/y\";text=\"Buy now\"";
        assert_eq!(parse_element_text(chain), Some("Buy now".to_string()));
    }

    #[test]
    fn parses_element_href() {
        let chain = "a:href=\"https://x.com/y\";text=\"Buy now\"";
        assert_eq!(
            parse_element_href(chain),
            Some("https://x.com/y".to_string())
        );
    }

    #[test]
    fn returns_none_when_attribute_absent() {
        assert_eq!(parse_element_text("div:nth-child=\"1\""), None);
        assert_eq!(parse_element_href("span;text=\"hi\""), None);
    }

    #[test]
    fn extracts_empty_string_for_empty_attribute() {
        assert_eq!(parse_element_text("a;text=\"\""), Some(String::new()));
    }
}
