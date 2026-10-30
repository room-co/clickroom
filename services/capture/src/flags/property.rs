//! Flag `filters` shape (canonical ) + property operators.
//!
//! Operator semantics mirror JS coercions (`String(x)`, `Number(x)`,
//! `toLowerCase`) so the Rust evaluator matches the SDK exactly.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A flag's targeting rules.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Filters {
    /// Ordered targeting groups; the first matching group decides the result.
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Present only for multivariate (non-boolean) flags.
    #[serde(default)]
    pub multivariate: Option<Multivariate>,
    /// Optional per-variant payloads, keyed by variant key.
    #[serde(default)]
    pub payloads: Option<Map<String, Value>>,
}

/// One targeting group: match all `properties`, then bucket by `rollout_percentage`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Group {
    /// Property filters (ALL must match). Empty targets everyone.
    #[serde(default)]
    pub properties: Vec<PropFilter>,
    /// Percentage `[0, 100]` of matched users the flag is enabled for.
    #[serde(default)]
    pub rollout_percentage: f64,
    /// Pin a matched user to a fixed variant (boolean flags: `null`).
    #[serde(default)]
    pub variant: Option<String>,
    /// Boolean served to a matched, in-rollout user. `None` means `true` (every
    /// group written before this field existed).
    #[serde(default)]
    pub serve: Option<bool>,
}

/// A single property predicate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropFilter {
    /// Person-property key to read.
    pub key: String,
    /// One of: `exact`, `is_not`, `icontains`, `gt`, `lt`, `is_set`.
    pub operator: String,
    /// Comparison operand.
    pub value: Value,
}

/// Multivariate variant distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Multivariate {
    /// Variants with cumulative rollout percentages (should sum to 100).
    pub variants: Vec<Variant>,
}

/// One multivariate variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Variant {
    /// Variant key (also the payload lookup key).
    pub key: String,
    /// Slice `[0, 100]` of the variant hash space assigned to this variant.
    pub rollout_percentage: f64,
}

/// JS `String(v)` for a JSON value: strings unquoted, numbers/bools/null as JS renders them.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// JS `String(actual)` where absent (`None`) renders as `"undefined"`.
fn js_string_opt(actual: Option<&Value>) -> String {
    match actual {
        None => "undefined".to_string(),
        Some(v) => js_string(v),
    }
}

/// JS `Number(v)`: numbers as-is, numeric strings parsed, empty string -> 0,
/// bools -> 0/1, everything else -> `NaN` (comparisons then yield false).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// Is `actual` present and non-null?
fn is_present(actual: Option<&Value>) -> bool {
    !matches!(actual, None | Some(Value::Null))
}

/// Evaluate one property operator (). `actual` is `person_properties[key]`.
pub fn prop_match(op: &str, actual: Option<&Value>, value: &Value) -> bool {
    match op {
        "exact" => js_string_opt(actual) == js_string(value),
        "is_not" => js_string_opt(actual) != js_string(value),
        "icontains" => {
            is_present(actual)
                && js_string_opt(actual)
                    .to_lowercase()
                    .contains(&js_string(value).to_lowercase())
        }
        "gt" => is_present(actual) && js_number(actual.unwrap()) > js_number(value),
        "lt" => is_present(actual) && js_number(actual.unwrap()) < js_number(value),
        "is_set" => is_present(actual),
        // Unknown operator: never matches.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exact_coerces_to_string() {
        assert!(prop_match("exact", Some(&json!("pro")), &json!("pro")));
        assert!(prop_match("exact", Some(&json!(30)), &json!("30")));
        assert!(!prop_match("exact", Some(&json!("free")), &json!("pro")));
    }

    #[test]
    fn is_not_negates_exact() {
        assert!(prop_match("is_not", Some(&json!("free")), &json!("pro")));
        assert!(!prop_match("is_not", Some(&json!("pro")), &json!("pro")));
    }

    #[test]
    fn icontains_is_case_insensitive() {
        assert!(prop_match(
            "icontains",
            Some(&json!("Alice@EXAMPLE.com")),
            &json!("example")
        ));
        assert!(!prop_match("icontains", None, &json!("x")));
    }

    #[test]
    fn gt_lt_numeric() {
        assert!(prop_match("gt", Some(&json!(40)), &json!(18)));
        assert!(!prop_match("gt", Some(&json!(10)), &json!(18)));
        assert!(prop_match("lt", Some(&json!(10)), &json!(18)));
        assert!(!prop_match("gt", None, &json!(18)));
    }

    #[test]
    fn is_set_checks_presence() {
        assert!(prop_match("is_set", Some(&json!("x")), &Value::Null));
        assert!(!prop_match("is_set", Some(&Value::Null), &Value::Null));
        assert!(!prop_match("is_set", None, &Value::Null));
    }

    /// `kind` is a pure UI-layer discriminator (string/number/boolean) added to
    /// the TS `.strict()` filters schema; the Rust struct has no dedicated field
    /// for it. Since `Filters` doesn't `deny_unknown_fields`, deserializing a
    /// blob with a top-level `kind` alongside `groups` must still succeed.
    #[test]
    fn filters_tolerates_unknown_kind_field() {
        let raw = r#"{
            "kind": "string",
            "groups": [
                { "properties": [], "rollout_percentage": 100, "variant": "open" }
            ],
            "payloads": { "open": "open" }
        }"#;
        let filters: Filters = serde_json::from_str(raw).expect("deserializes despite `kind`");
        assert_eq!(filters.groups.len(), 1);
        assert_eq!(filters.groups[0].variant.as_deref(), Some("open"));
    }
}
