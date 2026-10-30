//! Shared event-schema validation logic for the capture and ingest services.
//!
//! This crate is intentionally pure: no async, no network, no DB clients. It
//! takes a [`serde_json::Value`] (the event's `properties`) and an
//! [`EventSchema`] (typically loaded from a Redis cache that mirrors
//! Postgres's `EventDefinition`/`PropertyDefinition` tables) and returns a
//! list of [`Violation`]s.
//!
//! Callers own the policy decision of *what to do* with violations:
//! - `capture` (synchronous path) is expected to look up the schema, and when
//!   `mode == Strict` and `validate()` returns any violations, reject the
//!   request (e.g. HTTP 400) using the violations as the response body.
//! - `ingest` (async path) is expected to run `validate()` regardless of mode,
//!   and when `mode == Warn` (or `Strict`, if it ever needs to double-check)
//!   persist the violations into a `schema_errors` column rather than
//!   rejecting the event.
//!
//! `validate()` itself is mode-agnostic — it doesn't look at
//! [`EventSchema::mode`] at all. Deciding *whether* to call it, and what to do
//! with an empty vs. non-empty result, is the caller's job. This keeps the one
//! piece of logic that must stay identical between the two services (the
//! actual comparison of a JSON value's runtime shape against a declared type)
//! in exactly one place.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Mirrors the Prisma `EnforcementMode` enum (`EventDefinition.enforcementMode`).
///
/// Serialized/deserialized in lowercase to match the Postgres enum labels
/// (`none` / `warn` / `strict`) as they appear in JSON coming out of Redis or
/// Postgres.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnforcementMode {
    None,
    Warn,
    Strict,
}

/// Mirrors the Prisma `PropertyType` enum (`PropertyDefinition.propertyType`).
///
/// Serialized/deserialized as the PascalCase Postgres enum labels (`String` /
/// `Numeric` / `Boolean` / `DateTime`), matching the `as_db()` convention
/// already used for this enum in `services/ingest/src/infer.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum PropType {
    String,
    Numeric,
    Boolean,
    DateTime,
}

impl PropType {
    /// A short label for the *actual* runtime JSON type, used in
    /// [`Violation::TypeMismatch`] so callers/consumers can report what was
    /// received without needing to inspect the JSON value themselves.
    fn json_type_name(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    /// Whether `value`'s runtime JSON shape satisfies this declared type.
    fn matches(self, value: &Value) -> bool {
        match self {
            PropType::String => value.is_string(),
            PropType::Numeric => value.is_number(),
            PropType::Boolean => value.is_boolean(),
            // A DateTime property must be a JSON string that parses as an
            // RFC-3339 date-time. Reuses the same parsing approach as
            // `normalize_timestamp` in `services/capture/src/capture.rs` and
            // `infer.rs`'s `is_rfc3339`, so the notion of "looks like a
            // timestamp" stays identical across all three call sites.
            PropType::DateTime => value
                .as_str()
                .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s.trim()).is_ok()),
        }
    }
}

/// A cached event schema: which properties are required, and the declared
/// type for any property the taxonomy has assigned one to.
///
/// Deserializable from JSON as-is (the expected shape of a Redis cache value
/// built from `EventDefinition` + its `EventProperty`/`PropertyDefinition`
/// rows).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSchema {
    pub mode: EnforcementMode,
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default)]
    pub types: HashMap<String, PropType>,
}

/// A single schema violation for one property.
///
/// Serializes cleanly to JSON: an internally-tagged enum keyed by `kind`, so
/// this can be dropped directly into a capture-rs 400 response body or an
/// ingest-rs `schema_errors` column without any bespoke mapping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Violation {
    /// A property declared in `required` is absent from `properties` (or
    /// `properties` isn't a JSON object at all).
    MissingRequired { property: String },
    /// A property present in `properties` and declared in `types` has a
    /// runtime JSON shape that doesn't match the declared [`PropType`].
    TypeMismatch {
        property: String,
        expected: PropType,
        actual_json_type: String,
    },
}

/// Validate `properties` (an event's JSON properties payload) against
/// `schema`.
///
/// - Every name in `schema.required` must be present as a key in
///   `properties`; if `properties` isn't a JSON object, every required name
///   is reported missing.
/// - For every name in `schema.types` that *is* present in `properties`, the
///   value's runtime JSON shape must match the declared [`PropType`].
/// - Properties present in `properties` but not declared in `schema.types`
///   are ignored (undeclared/extra properties are out of scope for this
///   function).
///
/// This function is mode-agnostic: it does not consult `schema.mode`. The
/// caller decides whether/how to invoke it based on the enforcement mode.
pub fn validate(properties: &Value, schema: &EventSchema) -> Vec<Violation> {
    let mut violations = Vec::new();
    let obj = properties.as_object();

    for name in &schema.required {
        let present = obj.is_some_and(|o| o.contains_key(name));
        if !present {
            violations.push(Violation::MissingRequired {
                property: name.clone(),
            });
        }
    }

    if let Some(obj) = obj {
        for (name, expected) in &schema.types {
            if let Some(value) = obj.get(name) {
                if !expected.matches(value) {
                    violations.push(Violation::TypeMismatch {
                        property: name.clone(),
                        expected: *expected,
                        actual_json_type: PropType::json_type_name(value).to_string(),
                    });
                }
            }
        }
    }

    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema(required: &[&str], types: &[(&str, PropType)]) -> EventSchema {
        EventSchema {
            mode: EnforcementMode::Strict,
            required: required.iter().map(|s| s.to_string()).collect(),
            types: types.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn all_required_present_and_typed_passes_with_no_violations() {
        let s = schema(
            &["email", "age"],
            &[("email", PropType::String), ("age", PropType::Numeric)],
        );
        let props = json!({ "email": "a@b.com", "age": 30 });
        assert_eq!(validate(&props, &s), vec![]);
    }

    #[test]
    fn missing_required_property_is_reported() {
        let s = schema(&["email", "age"], &[]);
        let props = json!({ "email": "a@b.com" });
        assert_eq!(
            validate(&props, &s),
            vec![Violation::MissingRequired {
                property: "age".to_string()
            }]
        );
    }

    #[test]
    fn non_object_properties_marks_every_required_as_missing() {
        let s = schema(&["email", "age"], &[]);
        let props = json!("not-an-object");
        let violations = validate(&props, &s);
        assert_eq!(violations.len(), 2);
        assert!(violations.contains(&Violation::MissingRequired {
            property: "email".to_string()
        }));
        assert!(violations.contains(&Violation::MissingRequired {
            property: "age".to_string()
        }));
    }

    #[test]
    fn wrong_type_produces_type_mismatch() {
        let s = schema(&[], &[("age", PropType::Numeric)]);
        let props = json!({ "age": "thirty" });
        assert_eq!(
            validate(&props, &s),
            vec![Violation::TypeMismatch {
                property: "age".to_string(),
                expected: PropType::Numeric,
                actual_json_type: "string".to_string(),
            }]
        );
    }

    #[test]
    fn datetime_type_accepts_rfc3339_and_rejects_non_datetime_strings() {
        let s = schema(&[], &[("seen_at", PropType::DateTime)]);

        let ok = json!({ "seen_at": "2026-07-04T12:00:00Z" });
        assert_eq!(validate(&ok, &s), vec![]);

        let bad = json!({ "seen_at": "not-a-date" });
        assert_eq!(
            validate(&bad, &s),
            vec![Violation::TypeMismatch {
                property: "seen_at".to_string(),
                expected: PropType::DateTime,
                actual_json_type: "string".to_string(),
            }]
        );

        // A non-string value can never satisfy DateTime.
        let wrong_shape = json!({ "seen_at": 12345 });
        assert_eq!(
            validate(&wrong_shape, &s),
            vec![Violation::TypeMismatch {
                property: "seen_at".to_string(),
                expected: PropType::DateTime,
                actual_json_type: "number".to_string(),
            }]
        );
    }

    #[test]
    fn undeclared_extra_properties_are_ignored() {
        let s = schema(&["email"], &[("email", PropType::String)]);
        let props = json!({ "email": "a@b.com", "extra_field": 123, "another": true });
        assert_eq!(validate(&props, &s), vec![]);
    }

    #[test]
    fn boolean_type_matches_json_bool_only() {
        let s = schema(&[], &[("active", PropType::Boolean)]);
        assert_eq!(validate(&json!({ "active": true }), &s), vec![]);
        assert_eq!(
            validate(&json!({ "active": "true" }), &s),
            vec![Violation::TypeMismatch {
                property: "active".to_string(),
                expected: PropType::Boolean,
                actual_json_type: "string".to_string(),
            }]
        );
    }

    #[test]
    fn enforcement_mode_and_prop_type_serde_labels_match_prisma() {
        assert_eq!(
            serde_json::to_string(&EnforcementMode::None).unwrap(),
            "\"none\""
        );
        assert_eq!(
            serde_json::to_string(&EnforcementMode::Warn).unwrap(),
            "\"warn\""
        );
        assert_eq!(
            serde_json::to_string(&EnforcementMode::Strict).unwrap(),
            "\"strict\""
        );
        assert_eq!(
            serde_json::to_string(&PropType::DateTime).unwrap(),
            "\"DateTime\""
        );
        assert_eq!(
            serde_json::to_string(&PropType::String).unwrap(),
            "\"String\""
        );
    }

    #[test]
    fn event_schema_deserializes_from_expected_redis_shape() {
        let raw = json!({
            "mode": "warn",
            "required": ["email"],
            "types": { "email": "String", "age": "Numeric" }
        });
        let schema: EventSchema = serde_json::from_value(raw).unwrap();
        assert_eq!(schema.mode, EnforcementMode::Warn);
        assert_eq!(schema.required, vec!["email".to_string()]);
        assert_eq!(schema.types.get("age"), Some(&PropType::Numeric));
    }
}
