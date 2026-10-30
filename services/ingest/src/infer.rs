//! Property type inference for taxonomy discovery.
//!
//! Maps a first-seen JSON property value to one of the four Prisma
//! `PropertyType` enum variants. Inference is only ever applied on *discovery*
//! (the first time a `(project, name, scope)` is seen); the discovery path uses
//! `ON CONFLICT DO NOTHING`, so an existing definition is never overwritten and
//! `typeLocked` is therefore a no-op here — type changes only happen via the
//! tRPC update path. [`PropertyType::is_locked_noop`] documents that contract.
//!
//! ## Inference order — Numeric → Boolean → DateTime → String
//!
//! - JSON number (`serde_json::Value::Number`) → `Numeric`.
//! - JSON bool, OR a string exactly `"true"` / `"false"` (case-insensitive) →
//!   `Boolean`.
//! - String parseable as an RFC-3339 / ISO-8601 date-time → `DateTime`.
//! - Everything else (including numeric-looking strings like `"42"`) → `String`.
//!
//! ### Numeric-string decision (documented)
//!
//! A numeric-looking *string* such as `"42"` is inferred as **`String`, not
//! `Numeric`** — only a genuine JSON number is `Numeric`. This keeps inference
//! honest to the wire type (a producer that sends a quoted number chose a
//! string) and avoids surprising coercions; an operator can always override the
//! type via the tRPC update path.

use serde_json::Value;

/// The Prisma `PropertyType` enum, mirrored in Rust. The string form (via
/// [`PropertyType::as_db`]) is bound as text and cast to the Postgres
/// `"PropertyType"` enum in SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropertyType {
    /// Genuine JSON number.
    Numeric,
    /// JSON bool or a `"true"`/`"false"` string.
    Boolean,
    /// A string parseable as an RFC-3339 date-time.
    DateTime,
    /// Anything else (the default).
    String,
}

impl PropertyType {
    /// The exact Postgres enum label for this variant.
    pub fn as_db(self) -> &'static str {
        match self {
            PropertyType::Numeric => "Numeric",
            PropertyType::Boolean => "Boolean",
            PropertyType::DateTime => "DateTime",
            PropertyType::String => "String",
        }
    }

    /// Whether this inferred type should be treated as numerical (drives the
    /// `isNumerical` flag on `PropertyDefinition`).
    pub fn is_numerical(self) -> bool {
        matches!(self, PropertyType::Numeric)
    }

    /// Discovery never overwrites an existing definition, so `typeLocked` has no
    /// effect on the inference path. This helper exists to document that: a
    /// locked property keeps its type regardless of a later value's inference.
    #[allow(dead_code)]
    pub fn is_locked_noop(_type_locked: bool) -> bool {
        true
    }
}

/// Infer the [`PropertyType`] of a first-seen property value.
///
/// See the module docs for the full rule set and the numeric-string decision.
pub fn infer_type(value: &Value) -> PropertyType {
    match value {
        // 1. Numeric — only genuine JSON numbers.
        Value::Number(_) => PropertyType::Numeric,
        // 2. Boolean — JSON bool.
        Value::Bool(_) => PropertyType::Boolean,
        Value::String(s) => {
            let trimmed = s.trim();
            // 2. Boolean — "true"/"false" string (case-insensitive).
            if trimmed.eq_ignore_ascii_case("true") || trimmed.eq_ignore_ascii_case("false") {
                PropertyType::Boolean
            }
            // 3. DateTime — RFC-3339 / ISO-8601 date-time string.
            else if is_rfc3339(trimmed) {
                PropertyType::DateTime
            }
            // 4. String — everything else, incl. numeric strings like "42".
            else {
                PropertyType::String
            }
        }
        // null, arrays, objects → String.
        _ => PropertyType::String,
    }
}

/// Whether `s` parses as an RFC-3339 date-time (e.g. `2026-07-04T12:00:00Z`).
fn is_rfc3339(s: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(s).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_number_is_numeric() {
        assert_eq!(infer_type(&json!(42)), PropertyType::Numeric);
        assert_eq!(infer_type(&json!(3.5)), PropertyType::Numeric);
        assert_eq!(infer_type(&json!(-7)), PropertyType::Numeric);
        assert_eq!(infer_type(&json!(0)), PropertyType::Numeric);
    }

    #[test]
    fn json_bool_is_boolean() {
        assert_eq!(infer_type(&json!(true)), PropertyType::Boolean);
        assert_eq!(infer_type(&json!(false)), PropertyType::Boolean);
    }

    #[test]
    fn true_false_strings_are_boolean() {
        assert_eq!(infer_type(&json!("true")), PropertyType::Boolean);
        assert_eq!(infer_type(&json!("false")), PropertyType::Boolean);
        assert_eq!(infer_type(&json!("TRUE")), PropertyType::Boolean);
        assert_eq!(infer_type(&json!("False")), PropertyType::Boolean);
    }

    #[test]
    fn rfc3339_strings_are_datetime() {
        assert_eq!(
            infer_type(&json!("2026-07-04T12:00:00Z")),
            PropertyType::DateTime
        );
        assert_eq!(
            infer_type(&json!("2026-07-04T12:00:00+02:00")),
            PropertyType::DateTime
        );
        assert_eq!(
            infer_type(&json!("2026-07-04T12:00:00.123Z")),
            PropertyType::DateTime
        );
    }

    #[test]
    fn numeric_string_is_string_not_numeric() {
        // Documented decision: only a genuine JSON number is Numeric.
        assert_eq!(infer_type(&json!("42")), PropertyType::String);
        assert_eq!(infer_type(&json!("3.14")), PropertyType::String);
        assert_eq!(infer_type(&json!("-7")), PropertyType::String);
    }

    #[test]
    fn plain_strings_are_string() {
        assert_eq!(infer_type(&json!("hello")), PropertyType::String);
        assert_eq!(infer_type(&json!("")), PropertyType::String);
        // A bare date (no time) is not a full RFC-3339 date-time.
        assert_eq!(infer_type(&json!("2026-07-04")), PropertyType::String);
        // Not-quite-ISO garbage.
        assert_eq!(infer_type(&json!("not-a-date")), PropertyType::String);
    }

    #[test]
    fn null_array_object_are_string() {
        assert_eq!(infer_type(&json!(null)), PropertyType::String);
        assert_eq!(infer_type(&json!([1, 2, 3])), PropertyType::String);
        assert_eq!(infer_type(&json!({"a": 1})), PropertyType::String);
    }

    #[test]
    fn as_db_labels_match_postgres_enum() {
        assert_eq!(PropertyType::Numeric.as_db(), "Numeric");
        assert_eq!(PropertyType::Boolean.as_db(), "Boolean");
        assert_eq!(PropertyType::DateTime.as_db(), "DateTime");
        assert_eq!(PropertyType::String.as_db(), "String");
    }

    #[test]
    fn only_numeric_is_numerical() {
        assert!(PropertyType::Numeric.is_numerical());
        assert!(!PropertyType::Boolean.is_numerical());
        assert!(!PropertyType::DateTime.is_numerical());
        assert!(!PropertyType::String.is_numerical());
    }
}
