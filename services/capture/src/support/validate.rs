//! Validating a submitted ticket payload against the form's stored
//! `definition`.
//!
//! Pure functions over `serde_json` values — no database, no I/O — so the
//! policy is unit-testable in isolation and the handler stays a thin
//! orchestration layer.
//!
//! The rule that matters most: **unknown fields are rejected.** The endpoint is
//! internet-facing and the `fields` object is persisted verbatim into a jsonb
//! column, so accepting keys the form never declared would let any caller with
//! a (public, embedded-in-the-page) write key stuff arbitrary payloads into the
//! agent inbox.
//!
//! Every key read out of a `definition` here MUST match
//! `packages/trpc-router/src/trpc/routers/support.schema.ts`, which is
//! the only thing that writes the column, and the SDK's mirror of it in
//! `packages/sdk-js/src/support.ts`. A misspelt key does not fail loudly — it
//! silently reads as absent, which for an allow-list means "unconstrained".
//! That is exactly how the `choices` field was missed once already: this module
//! read `options`, found nothing, and waved every dropdown answer through.

use serde_json::{Map, Value};

/// Hard ceiling on a `short_text` answer. A field's own `maxLength` can lower
/// this but never raise it.
const MAX_SHORT_TEXT: usize = 500;
/// Hard ceiling on a `long_text` answer, same rule.
const MAX_LONG_TEXT: usize = 5_000;
/// Max accepted length of the always-present `subject`.
pub const MAX_SUBJECT: usize = 300;
/// Max accepted length of the always-present first message `body`.
pub const MAX_BODY: usize = 10_000;

/// One field declared by a form's `definition.fields[]`, reduced to the parts
/// validation cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDef {
    /// The answer key clients submit under `fields`.
    pub id: String,
    /// `short_text | long_text | dropdown | email | file`.
    pub field_type: String,
    /// Whether an answer must be present and non-empty.
    pub required: bool,
    /// The allow-list for a `dropdown` (schema key `choices`, `string[]`, min
    /// 1). Empty means the definition declared none, which is **rejected** for
    /// a dropdown rather than treated as unconstrained — see
    /// [`validate_answer_type`].
    pub choices: Vec<String>,
    /// The field's own `maxLength`, when it declares one.
    pub max_length: Option<usize>,
}

/// Read the `fields[]` array out of a parsed `definition`.
///
/// Tolerant by design: a definition with no `fields` key yields an empty list
/// (a form with only subject/body is valid), and an entry missing an id is
/// skipped rather than failing the whole submission — a malformed definition is
/// a dashboard bug, and it must not become an outage on the public write path.
/// Skipping is safe precisely because unknown keys are rejected downstream: a
/// skipped field simply cannot be answered.
pub fn parse_field_defs(definition: &Value) -> Vec<FieldDef> {
    definition
        .get("fields")
        .and_then(Value::as_array)
        .map(|fields| fields.iter().filter_map(parse_field_def).collect())
        .unwrap_or_default()
}

/// Parse a single `fields[]` entry, or `None` when it has no usable id.
///
/// Key names are fixed by `support.schema.ts`'s `fieldBase` + per-type
/// variants: `id`, `label`, `required`, `type`, and — for a dropdown —
/// `choices`. No aliases are accepted: the schema is `.strict()`, so an
/// alternate spelling cannot reach the column, and tolerating one here would
/// only create a second, untested shape to reason about.
fn parse_field_def(raw: &Value) -> Option<FieldDef> {
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| !id.is_empty())?;
    Some(FieldDef {
        id,
        field_type: raw
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("short_text")
            .to_string(),
        required: raw
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        choices: raw
            .get("choices")
            .and_then(Value::as_array)
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        max_length: raw
            .get("maxLength")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0),
    })
}

/// Whether an answer counts as "absent" for a required-field check.
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// Validate the submitted `fields` answers against the form's declared fields.
///
/// Returns a human-readable reason on the first violation (the handler maps it
/// to `400`). Checks, in order:
/// 1. every submitted key is declared by the form (**unknown key → reject**);
/// 2. every required field has a non-blank answer;
/// 3. each answer matches its declared type.
pub fn validate_answers(defs: &[FieldDef], answers: &Map<String, Value>) -> Result<(), String> {
    for key in answers.keys() {
        if !defs.iter().any(|def| &def.id == key) {
            return Err(format!("unknown field {key:?}"));
        }
    }

    for def in defs {
        match answers.get(&def.id) {
            None => {
                if def.required {
                    return Err(format!("missing required field {:?}", def.id));
                }
            }
            Some(value) if is_blank(value) => {
                if def.required {
                    return Err(format!("missing required field {:?}", def.id));
                }
            }
            Some(value) => validate_answer_type(def, value)?,
        }
    }

    Ok(())
}

/// Type/shape check for one non-blank answer.
fn validate_answer_type(def: &FieldDef, value: &Value) -> Result<(), String> {
    match def.field_type.as_str() {
        "short_text" => expect_text(def, value, MAX_SHORT_TEXT),
        "long_text" => expect_text(def, value, MAX_LONG_TEXT),
        "email" => {
            let text = expect_str(def, value)?;
            looks_like_email(text)
                .then_some(())
                .ok_or_else(|| format!("field {:?} is not a valid email address", def.id))
        }
        "dropdown" => {
            let text = expect_str(def, value)?;
            // Fails CLOSED on a choice-less dropdown. `support.schema.ts`
            // requires `choices` to have at least one entry, so an empty list
            // means the definition is malformed or the key drifted again —
            // and for an allow-list, "I could not read the list" must never
            // resolve to "allow anything".
            if def.choices.is_empty() {
                return Err(format!("field {:?} declares no choices", def.id));
            }
            if def.choices.iter().any(|choice| choice == text) {
                Ok(())
            } else {
                Err(format!(
                    "field {:?} has a value outside its choices",
                    def.id
                ))
            }
        }
        // A `file` answer is an attachment storage key (or a list of them)
        // handed back by `POST /v1/support/attachments/presign`.
        "file" => match value {
            Value::String(_) => Ok(()),
            Value::Array(items) if items.iter().all(Value::is_string) => Ok(()),
            _ => Err(format!(
                "field {:?} expects an attachment key or a list of keys",
                def.id
            )),
        },
        // Unknown/future field types (e.g. the deferred bot channel) still have
        // to be a string — never an arbitrary nested object.
        _ => expect_text(def, value, MAX_LONG_TEXT),
    }
}

/// Require a string answer.
fn expect_str<'a>(def: &FieldDef, value: &'a Value) -> Result<&'a str, String> {
    value
        .as_str()
        .ok_or_else(|| format!("field {:?} expects a string", def.id))
}

/// Require a string answer within the effective length cap: the field's own
/// declared `maxLength` when it has one, bounded by the hard `ceiling`. A
/// definition can tighten the limit, never loosen it.
fn expect_text(def: &FieldDef, value: &Value, ceiling: usize) -> Result<(), String> {
    let text = expect_str(def, value)?;
    let max = def
        .max_length
        .map_or(ceiling, |declared| declared.min(ceiling));
    if text.chars().count() > max {
        return Err(format!("field {:?} exceeds {max} characters", def.id));
    }
    Ok(())
}

/// Deliberately loose email shape check: exactly one `@`, non-empty on both
/// sides, a dot in the domain, no whitespace. Anything stricter rejects valid
/// addresses; anything looser accepts obvious junk.
fn looks_like_email(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.chars().any(char::is_whitespace) {
        return false;
    }
    match text.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && !domain.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        }
        None => false,
    }
}

/// Validate the always-present `subject` / `body` pair that every ticket
/// carries regardless of the form's custom fields.
pub fn validate_subject_and_body(subject: &str, body: &str) -> Result<(), String> {
    if subject.trim().is_empty() {
        return Err("subject is empty".to_string());
    }
    if subject.chars().count() > MAX_SUBJECT {
        return Err(format!("subject exceeds {MAX_SUBJECT} characters"));
    }
    if body.trim().is_empty() {
        return Err("body is empty".to_string());
    }
    if body.chars().count() > MAX_BODY {
        return Err(format!("body exceeds {MAX_BODY} characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Shaped exactly like a definition `support.schema.ts` would emit —
    /// `label` on every field, `choices` (not `options`) on the dropdown.
    /// Keep it that way: the whole point of these tests is that the Rust
    /// validator agrees with the zod schema that writes the column.
    fn definition() -> Value {
        json!({
            "version": 1,
            "channel": "contact",
            "fields": [
                { "id": "email", "label": "Email", "type": "email", "required": true },
                { "id": "details", "label": "Details", "type": "long_text", "required": true },
                { "id": "severity", "label": "Severity", "type": "dropdown", "required": false,
                  "choices": ["low", "high"] },
                { "id": "screenshot", "label": "Screenshot", "type": "file", "required": false },
                { "id": "nickname", "label": "Nickname", "type": "short_text", "required": false }
            ]
        })
    }

    fn answers(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn parses_declared_fields() {
        let defs = parse_field_defs(&definition());
        assert_eq!(defs.len(), 5);
        assert_eq!(defs[0].id, "email");
        assert!(defs[0].required);
        assert_eq!(defs[2].choices, vec!["low".to_string(), "high".to_string()]);
    }

    #[test]
    fn dropdown_choices_are_read_from_the_schemas_key() {
        // Regression: this module used to read `options`, which
        // `support.schema.ts` never emits. The list came back empty, an empty
        // list read as "unconstrained", and every dropdown answer was
        // accepted. Assert both halves — the key is `choices`, and the wrong
        // key yields nothing (so the fail-closed branch below is what runs).
        let defs = parse_field_defs(&json!({
            "fields": [{ "id": "sev", "label": "S", "type": "dropdown", "choices": ["low"] }]
        }));
        assert_eq!(defs[0].choices, vec!["low".to_string()]);

        let legacy = parse_field_defs(&json!({
            "fields": [{ "id": "sev", "label": "S", "type": "dropdown", "options": ["low"] }]
        }));
        assert!(legacy[0].choices.is_empty());
    }

    #[test]
    fn definition_without_fields_yields_no_defs() {
        assert!(parse_field_defs(&json!({ "version": 1 })).is_empty());
        assert!(parse_field_defs(&json!({ "fields": "nope" })).is_empty());
    }

    #[test]
    fn field_entry_without_id_is_skipped() {
        let defs = parse_field_defs(&json!({ "fields": [{ "type": "short_text" }] }));
        assert!(defs.is_empty());
    }

    #[test]
    fn accepts_a_valid_submission() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({
            "email": "user@example.com",
            "details": "it broke",
            "severity": "high",
            "screenshot": ["proj/tkt/01ARZ3-shot.png"]
        }));
        assert_eq!(validate_answers(&defs, &submitted), Ok(()));
    }

    #[test]
    fn rejects_unknown_field() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({
            "email": "user@example.com",
            "details": "it broke",
            "isAdmin": true
        }));
        let err = validate_answers(&defs, &submitted).unwrap_err();
        assert!(err.contains("unknown field"), "{err}");
        assert!(err.contains("isAdmin"), "{err}");
    }

    #[test]
    fn rejects_missing_required_field() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({ "email": "user@example.com" }));
        assert!(validate_answers(&defs, &submitted)
            .unwrap_err()
            .contains("details"));
    }

    #[test]
    fn rejects_blank_required_field() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({ "email": "user@example.com", "details": "   " }));
        assert!(validate_answers(&defs, &submitted)
            .unwrap_err()
            .contains("details"));
    }

    #[test]
    fn omitting_an_optional_field_is_fine() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({ "email": "u@e.com", "details": "x" }));
        assert_eq!(validate_answers(&defs, &submitted), Ok(()));
    }

    #[test]
    fn rejects_bad_email() {
        let defs = parse_field_defs(&definition());
        for bad in ["not-an-email", "a@b", "a b@c.com", "@example.com", "a@.com"] {
            let submitted = answers(json!({ "email": bad, "details": "x" }));
            assert!(
                validate_answers(&defs, &submitted).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_dropdown_value_outside_declared_choices() {
        let defs = parse_field_defs(&definition());
        // Declared choices are ["low", "high"]. Matching is exact — no case
        // folding, no trimming — because the stored value feeds the inbox's
        // category/severity filters verbatim.
        for bad in ["catastrophic", "LOW", " low"] {
            let submitted = answers(json!({
                "email": "u@e.com", "details": "x", "severity": bad
            }));
            assert!(
                validate_answers(&defs, &submitted).is_err(),
                "{bad:?} is not a declared choice and must be rejected"
            );
        }

        let submitted = answers(json!({
            "email": "u@e.com", "details": "x", "severity": "catastrophic"
        }));
        assert!(validate_answers(&defs, &submitted)
            .unwrap_err()
            .contains("choices"));
    }

    #[test]
    fn blank_answer_to_an_optional_dropdown_is_treated_as_omitted() {
        // A widget that renders the select with an empty placeholder selected
        // posts `""`. That is "no answer", not "an answer outside the
        // choices" — the required-field check already owns the empty case, and
        // the field here is optional.
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({ "email": "u@e.com", "details": "x", "severity": "" }));
        assert_eq!(validate_answers(&defs, &submitted), Ok(()));
    }

    #[test]
    fn blank_answer_to_a_required_dropdown_is_rejected() {
        let defs = parse_field_defs(&json!({
            "fields": [{ "id": "sev", "label": "S", "type": "dropdown",
                         "required": true, "choices": ["low"] }]
        }));
        assert!(validate_answers(&defs, &answers(json!({ "sev": "" }))).is_err());
        assert!(validate_answers(&defs, &answers(json!({}))).is_err());
    }

    #[test]
    fn accepts_every_declared_choice() {
        let defs = parse_field_defs(&definition());
        for good in ["low", "high"] {
            let submitted = answers(json!({
                "email": "u@e.com", "details": "x", "severity": good
            }));
            assert_eq!(validate_answers(&defs, &submitted), Ok(()), "{good}");
        }
    }

    #[test]
    fn dropdown_without_choices_fails_closed() {
        // An allow-list that could not be read must reject, not wave through.
        for malformed in [
            json!({ "id": "sev", "label": "S", "type": "dropdown" }),
            json!({ "id": "sev", "label": "S", "type": "dropdown", "choices": [] }),
            json!({ "id": "sev", "label": "S", "type": "dropdown", "options": ["low"] }),
        ] {
            let defs = parse_field_defs(&json!({ "fields": [malformed] }));
            let submitted = answers(json!({ "sev": "low" }));
            assert!(
                validate_answers(&defs, &submitted).is_err(),
                "a dropdown with no readable choices must reject every answer"
            );
        }
    }

    #[test]
    fn rejects_wrong_answer_types() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({ "email": "u@e.com", "details": 42 }));
        assert!(validate_answers(&defs, &submitted).is_err());

        let submitted = answers(json!({
            "email": "u@e.com", "details": "x", "screenshot": { "key": "x" }
        }));
        assert!(validate_answers(&defs, &submitted).is_err());
    }

    #[test]
    fn rejects_oversize_text() {
        let defs = parse_field_defs(&definition());
        let submitted = answers(json!({
            "email": "u@e.com",
            "details": "x",
            "nickname": "n".repeat(MAX_SHORT_TEXT + 1)
        }));
        assert!(validate_answers(&defs, &submitted).is_err());
    }

    #[test]
    fn a_declared_max_length_tightens_but_cannot_loosen_the_ceiling() {
        let defs = parse_field_defs(&json!({
            "fields": [
                { "id": "tight", "label": "T", "type": "short_text", "maxLength": 5 },
                { "id": "greedy", "label": "G", "type": "short_text", "maxLength": 10_000 }
            ]
        }));

        assert!(validate_answers(&defs, &answers(json!({ "tight": "12345" }))).is_ok());
        assert!(validate_answers(&defs, &answers(json!({ "tight": "123456" }))).is_err());

        // The field asks for 10_000; the hard `short_text` ceiling still wins.
        let over = answers(json!({ "greedy": "g".repeat(MAX_SHORT_TEXT + 1) }));
        assert!(validate_answers(&defs, &over).is_err());
    }

    #[test]
    fn subject_and_body_are_required_and_bounded() {
        assert!(validate_subject_and_body("hi", "there").is_ok());
        assert!(validate_subject_and_body("  ", "there").is_err());
        assert!(validate_subject_and_body("hi", "  ").is_err());
        assert!(validate_subject_and_body(&"s".repeat(MAX_SUBJECT + 1), "b").is_err());
        assert!(validate_subject_and_body("s", &"b".repeat(MAX_BODY + 1)).is_err());
    }

    #[test]
    fn form_with_no_custom_fields_rejects_any_answer() {
        let defs = parse_field_defs(&json!({ "fields": [] }));
        assert!(validate_answers(&defs, &answers(json!({}))).is_ok());
        assert!(validate_answers(&defs, &answers(json!({ "anything": "x" }))).is_err());
    }
}
