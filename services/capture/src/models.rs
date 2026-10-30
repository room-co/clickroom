//! Request/response structs and the NATS message schema.
//!
//! # NATS message schema (`events.raw.<project_id>` on stream `EVENTS`)
//!
//! Each captured event is published as a standalone JSON message. ingest-rs
//! MUST decode messages in exactly this shape:
//!
//! ```jsonc
//! {
//!   "uuid":           "0198f...-v7",       // string, UUIDv7 assigned by capture-rs
//!   "project_id":     "01KWNKK2...",       // string, resolved from the write key
//!   "event":          "$autocapture",      // string, non-empty
//!   "distinct_id":    "u_123",             // string, non-empty
//!   "timestamp":      "2026-07-03T12:00:00.000Z", // RFC3339 UTC (client-supplied or server now)
//!   "properties":     { "$current_url": "..." },  // JSON object, defaults to {}
//!   "elements_chain": "a:href=...;",       // string, defaults to ""
//!   "created_at":     "2026-07-04T04:30:00.000Z"  // RFC3339 UTC, server ingest time
//! }
//! ```
//!
//! All timestamps are RFC3339 with millisecond precision in UTC (`Z` suffix).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Top-level `POST /capture` request body.
#[derive(Debug, Deserialize)]
pub struct CaptureRequest {
    /// Events in this batch (contract limit: 1..=100).
    pub batch: Vec<InputEvent>,
}

/// A single client-supplied event prior to enrichment.
#[derive(Debug, Deserialize)]
pub struct InputEvent {
    /// Event name (required, must be non-empty).
    pub event: String,
    /// Stable user/device identifier (required, must be non-empty).
    pub distinct_id: String,
    /// Optional client timestamp (RFC3339/ISO-8601); server fills if absent/invalid.
    #[serde(default)]
    pub timestamp: Option<String>,
    /// Arbitrary event properties; coerced to `{}` when absent or non-object.
    #[serde(default)]
    pub properties: Option<Value>,
    /// Optional autocapture DOM chain; defaults to "".
    #[serde(default)]
    pub elements_chain: Option<String>,
}

/// The enriched event exactly as published to JetStream. See module docs for
/// the wire contract consumed by ingest-rs.
#[derive(Debug, Serialize)]
pub struct EventMessage {
    /// UUIDv7 assigned at capture time.
    pub uuid: String,
    /// Owning project id (from the write key).
    pub project_id: String,
    /// Event name.
    pub event: String,
    /// Distinct id.
    pub distinct_id: String,
    /// Event timestamp, RFC3339 UTC.
    pub timestamp: String,
    /// Event properties (always a JSON object).
    pub properties: Value,
    /// Autocapture elements chain (always a string).
    pub elements_chain: String,
    /// Server-side ingest time, RFC3339 UTC.
    pub created_at: String,
}

/// The `202 Accepted` (or `400` schema-rejected) response body.
///
/// On success `errors` is omitted from the serialized JSON entirely (via
/// `skip_serializing_if`), so the wire shape for an accepted batch is
/// unchanged: `{"accepted": N}`. On a strict-schema rejection the handler
/// returns this with `accepted: 0` and one entry per violating event.
#[derive(Debug, Serialize)]
pub struct CaptureResponse {
    /// Number of events durably persisted to JetStream.
    pub accepted: usize,
    /// Per-event strict-schema violations that caused the whole batch to be
    /// rejected. Empty (and omitted from the JSON) on a normal accept.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<SchemaEventError>,
}

/// One batch event that failed strict schema enforcement.
#[derive(Debug, Serialize)]
pub struct SchemaEventError {
    /// The event's position in the submitted `batch` array.
    pub index: usize,
    /// The event name (`InputEvent::event`).
    pub event: String,
    /// The specific violations `schema_validate::validate` found.
    pub violations: Vec<schema_validate::Violation>,
}

/// Coerce optional client-supplied properties into a guaranteed JSON object.
pub fn normalize_properties(props: Option<Value>) -> Value {
    match props {
        Some(v) if v.is_object() => v,
        _ => json!({}),
    }
}
