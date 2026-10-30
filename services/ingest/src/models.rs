//! Wire schema for messages consumed off the `EVENTS` JetStream.
//!
//! This MUST match exactly what capture-rs publishes to `events.raw.<project_id>`
//! (see `services/capture/src/models.rs` module docs). Every field is present on
//! the wire; `properties` is always a JSON object and `elements_chain` always a
//! string, but we tolerate absence defensively.

use serde::Deserialize;
use serde_json::{json, Value};

/// A single event decoded from a NATS message, prior to ClickHouse mapping.
#[derive(Debug, Clone, Deserialize)]
pub struct RawEvent {
    /// UUIDv7 assigned by capture-rs (dedup identity).
    pub uuid: String,
    /// Owning project id.
    pub project_id: String,
    /// Event name.
    pub event: String,
    /// Distinct id.
    pub distinct_id: String,
    /// Event timestamp, RFC3339 UTC.
    pub timestamp: String,
    /// Event properties; coerced to `{}` when absent/non-object via [`Self::properties_object`].
    #[serde(default)]
    pub properties: Value,
    /// Autocapture DOM chain; defaults to "".
    #[serde(default)]
    pub elements_chain: String,
    /// Server-side ingest time from capture-rs, RFC3339 UTC.
    pub created_at: String,
}

impl RawEvent {
    /// The `properties` value guaranteed to be a JSON object (`{}` fallback).
    pub fn properties_object(&self) -> Value {
        if self.properties.is_object() {
            self.properties.clone()
        } else {
            json!({})
        }
    }
}
