//! Server-side sanitizer for the bug-report payload.
//!
//! `POST /v1/support/tickets` is internet-facing and authenticated only by a
//! page-embedded write key, and whatever survives this module lands **verbatim**
//! in a `jsonb` column that the agent inbox renders. Same reasoning as
//! `validate.rs`: nothing undeclared is ever persisted.
//!
//! Three independent jobs, all pure (no I/O, no clock, no allocation of ids):
//!
//! 1. **Structural allow-listing.** Top-level keys are `capturedAt` /
//!    `environment` / `consoleErrors` / `networkErrors`; each nested object has
//!    its own key allow-list. Everything else is dropped *silently* — a bug
//!    report is best-effort telemetry, so an unknown key must not 400 a ticket
//!    the user is trying to file.
//! 2. **Bounding.** Every string is truncated to the zod cap and both
//!    arrays are truncated to 20 entries, keeping the NEWEST (the client appends
//!    chronologically, so the tail is what matters when something just broke).
//! 3. **Redaction, as the last line of defence.** The SDK redacts too, but
//!    client-side redaction is UX and bandwidth — never trust it.
//!    Query-string *values* whose key looks credential-shaped are stripped, and
//!    `Bearer …` / JWT-shaped runs are stripped from free-text messages.
//!
//! The payload shape is hand-maintained in three places (zod, the SDK, here).
//! The zod↔SDK edge has a `satisfies` guard; **this edge is covered only by the
//! tests at the bottom of this file**, so they are deliberately exhaustive.
//!
//! Entries that cannot satisfy the *required* half of the zod schema are dropped
//! whole rather than stored partial: the read path `safeParse`s the column and
//! returns `null` on failure, so one malformed console line would otherwise blank
//! the entire bug panel.

use serde_json::{Map, Value};

/// caps, mirrored from `supportBugReportSchema`.
const MAX_URL_CHARS: usize = 2048;
const MAX_MESSAGE_CHARS: usize = 2000;
const MAX_SOURCE_CHARS: usize = 512;
const MAX_ERROR_CHARS: usize = 512;
const MAX_METHOD_CHARS: usize = 10;
/// zod leaves timestamps unbounded; bound them here anyway — they are attacker
/// controlled and an ISO-8601 instant is 24 characters.
const MAX_TIMESTAMP_CHARS: usize = 64;

/// Both rings are capped at 20 client-side; re-enforced here.
const MAX_ENTRIES: usize = 20;

/// Substrings that make a query-string key credential-shaped. Matches the
/// `(?i)(token|key|secret|password|auth|session|signature|sig|code|email)` the
/// spec calls for; `sig` subsumes `signature` but both are listed for grep-ability.
const REDACT_KEY_NEEDLES: [&str; 10] = [
    "token",
    "key",
    "secret",
    "password",
    "auth",
    "session",
    "signature",
    "sig",
    "code",
    "email",
];

const REDACTED: &str = "[redacted]";

/// String caps for the flat `environment` keys, in `(key, max_chars)` pairs.
const ENVIRONMENT_STRINGS: [(&str, usize); 6] = [
    ("browser", 64),
    ("browserVersion", 32),
    ("os", 64),
    ("deviceType", 32),
    ("locale", 32),
    ("timezone", 64),
];

/// Non-negative integer keys on `environment`.
const ENVIRONMENT_NUMBERS: [&str; 4] = [
    "viewportWidth",
    "viewportHeight",
    "screenWidth",
    "screenHeight",
];

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/// Sanitize a client-supplied bug report into the value stored in
/// `SupportTicket."bugReport"`.
///
/// Returns `None` for a missing value, a non-object, or an object with nothing
/// left after allow-listing — the column is then `NULL` rather than `{}`, so
/// readers can branch on presence alone.
pub fn sanitize_bug_report(raw: Option<&Value>) -> Option<Value> {
    let raw = raw?.as_object()?;
    let mut out = Map::new();

    if let Some(captured_at) = raw.get("capturedAt").and_then(Value::as_str) {
        out.insert(
            "capturedAt".to_string(),
            Value::String(truncate(captured_at.trim(), MAX_TIMESTAMP_CHARS)),
        );
    }

    if let Some(environment) = raw.get("environment").and_then(Value::as_object) {
        let environment = sanitize_environment(environment);
        if !environment.is_empty() {
            out.insert("environment".to_string(), Value::Object(environment));
        }
    }

    if let Some(entries) = raw.get("consoleErrors").and_then(Value::as_array) {
        let entries = sanitize_entries(entries, sanitize_console_entry);
        if !entries.is_empty() {
            out.insert("consoleErrors".to_string(), Value::Array(entries));
        }
    }

    if let Some(entries) = raw.get("networkErrors").and_then(Value::as_array) {
        let entries = sanitize_entries(entries, sanitize_network_entry);
        if !entries.is_empty() {
            out.insert("networkErrors".to_string(), Value::Array(entries));
        }
    }

    (!out.is_empty()).then_some(Value::Object(out))
}

// ---------------------------------------------------------------------------
// per-section allow-lists
// ---------------------------------------------------------------------------

/// `environment` — every key optional, so an unusable value simply drops out.
fn sanitize_environment(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();

    for key in ["url", "referrer"] {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            out.insert(
                key.to_string(),
                Value::String(truncate(&redact_url(value), MAX_URL_CHARS)),
            );
        }
    }

    for key in ENVIRONMENT_NUMBERS {
        if let Some(value) = raw.get(key).and_then(Value::as_i64).filter(|v| *v >= 0) {
            out.insert(key.to_string(), Value::from(value));
        }
    }

    for (key, max) in ENVIRONMENT_STRINGS {
        if let Some(value) = raw.get(key).and_then(Value::as_str) {
            out.insert(key.to_string(), Value::String(truncate(value, max)));
        }
    }

    out
}

/// Sanitize every entry, then keep the newest [`MAX_ENTRIES`].
///
/// Sanitize-then-trim (rather than trim-then-sanitize) means a dropped malformed
/// entry does not cost a slot a good entry could have used.
fn sanitize_entries(raw: &[Value], sanitize: fn(&Value) -> Option<Value>) -> Vec<Value> {
    let mut entries: Vec<Value> = raw.iter().filter_map(sanitize).collect();
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries
}

/// One `consoleErrors` entry. `level` / `message` / `timestamp` are required by
/// `bugConsoleEntrySchema`, so an entry missing any of them is dropped.
fn sanitize_console_entry(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;

    let level = raw.get("level").and_then(Value::as_str)?;
    if level != "error" && level != "warn" {
        return None;
    }
    let message = raw.get("message").and_then(Value::as_str)?;
    let timestamp = raw.get("timestamp").and_then(Value::as_str)?;

    let mut out = Map::new();
    out.insert("level".to_string(), Value::String(level.to_string()));
    out.insert(
        "message".to_string(),
        Value::String(truncate(&redact_text(message), MAX_MESSAGE_CHARS)),
    );
    out.insert(
        "timestamp".to_string(),
        Value::String(truncate(timestamp, MAX_TIMESTAMP_CHARS)),
    );
    if let Some(source) = raw.get("source").and_then(Value::as_str) {
        // A `source` is `file:line:col`, and in the browser that "file" is a
        // URL — so it gets the query-string pass as well as the free-text one.
        out.insert(
            "source".to_string(),
            Value::String(truncate(
                &redact_text(&redact_url(source)),
                MAX_SOURCE_CHARS,
            )),
        );
    }
    Some(Value::Object(out))
}

/// One `networkErrors` entry. `method` / `url` / `status` / `timestamp` are
/// required by `bugNetworkEntrySchema`; `status` is nullable-but-present
/// (`null` = the request never reached a status).
fn sanitize_network_entry(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;

    let method = raw.get("method").and_then(Value::as_str)?;
    let url = raw.get("url").and_then(Value::as_str)?;
    let timestamp = raw.get("timestamp").and_then(Value::as_str)?;
    let status = match raw.get("status") {
        Some(Value::Null) => Value::Null,
        Some(value) => Value::from(value.as_i64()?),
        None => return None,
    };

    let mut out = Map::new();
    out.insert(
        "method".to_string(),
        Value::String(truncate(method, MAX_METHOD_CHARS)),
    );
    out.insert(
        "url".to_string(),
        Value::String(truncate(&redact_url(url), MAX_URL_CHARS)),
    );
    out.insert("status".to_string(), status);
    out.insert(
        "timestamp".to_string(),
        Value::String(truncate(timestamp, MAX_TIMESTAMP_CHARS)),
    );
    if let Some(duration) = raw
        .get("durationMs")
        .and_then(Value::as_f64)
        .filter(|d| *d >= 0.0)
    {
        if let Some(duration) = serde_json::Number::from_f64(duration) {
            out.insert("durationMs".to_string(), Value::Number(duration));
        }
    }
    if let Some(error) = raw.get("error").and_then(Value::as_str) {
        out.insert(
            "error".to_string(),
            Value::String(truncate(&redact_text(error), MAX_ERROR_CHARS)),
        );
    }
    Some(Value::Object(out))
}

// ---------------------------------------------------------------------------
// bounding + redaction primitives
// ---------------------------------------------------------------------------

/// Truncate to `max` **characters** (not bytes), matching zod's `.max()` and
/// `resolve_category`'s existing `chars().count()` posture.
fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

/// Does a query-string key look credential-shaped?
fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    REDACT_KEY_NEEDLES.iter().any(|needle| key.contains(needle))
}

/// Replace the *values* of credential-shaped query params, keeping the key (the
/// fact that `?token=` was present is useful signal; its value never is).
///
/// The path is left alone: a secret in a path segment is indistinguishable from
/// an id, and blanking ids would make every failed request unreadable.
pub fn redact_url(url: &str) -> String {
    let Some(mark) = url.find('?') else {
        return url.to_string();
    };
    let (base, rest) = url.split_at(mark);
    let rest = &rest[1..];

    // Keep any fragment out of the pair-splitting — `#` ends the query.
    let (query, fragment) = match rest.find('#') {
        Some(hash) => (&rest[..hash], &rest[hash..]),
        None => (rest, ""),
    };

    let redacted = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if is_secret_key(key) => format!("{key}={REDACTED}"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&");

    format!("{base}?{redacted}{fragment}")
}

/// Strip credentials from a free-text string: `Bearer <token>` and any
/// JWT-shaped run.
pub fn redact_text(text: &str) -> String {
    redact_jwts(&redact_bearer(text))
}

/// Characters a JWT / opaque bearer token is made of.
fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

/// Replace the run following a case-insensitive `Bearer` (optionally separated
/// by spaces/tabs/colons) with [`REDACTED`].
fn redact_bearer(text: &str) -> String {
    let lower = text.to_ascii_lowercase(); // ASCII-only fold: byte offsets stay aligned
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;

    while i < bytes.len() {
        if lower[i..].starts_with("bearer") {
            let mut cursor = i + "bearer".len();
            while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | b':') {
                cursor += 1;
            }
            let start = cursor;
            while cursor < bytes.len() && is_token_byte(bytes[cursor]) {
                cursor += 1;
            }
            if cursor > start {
                out.push_str(&text[i..start]);
                out.push_str(REDACTED);
                i = cursor;
                continue;
            }
        }
        // Advance one *character* so multi-byte UTF-8 is never split.
        let ch = text[i..].chars().next().expect("index is a char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// Replace JWT-shaped runs with [`REDACTED`].
fn redact_jwts(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;

    while i < bytes.len() {
        if is_token_byte(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_token_byte(bytes[i]) {
                i += 1;
            }
            let run = &text[start..i];
            out.push_str(if looks_like_jwt(run) { REDACTED } else { run });
            continue;
        }
        let ch = text[i..].chars().next().expect("index is a char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

/// Three dot-separated base64url segments whose header starts with `ey` (i.e.
/// a base64url-encoded `{"…`).
///
/// The `ey` + length floors matter: without them `app.min.js` and
/// `foo.bar.baz` would be redacted out of every stack trace.
fn looks_like_jwt(run: &str) -> bool {
    let mut parts = run.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    header.starts_with("ey") && header.len() >= 8 && payload.len() >= 8 && !signature.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn console_entry(index: usize) -> Value {
        json!({
            "level": "error",
            "message": format!("boom {index}"),
            "timestamp": "2026-07-25T10:00:00.000Z",
        })
    }

    fn network_entry(index: usize) -> Value {
        json!({
            "method": "GET",
            "url": format!("https://api.example.com/{index}"),
            "status": 500,
            "timestamp": "2026-07-25T10:00:00.000Z",
        })
    }

    // --- shape gating ------------------------------------------------------

    #[test]
    fn non_object_and_absent_payloads_are_none() {
        assert!(sanitize_bug_report(None).is_none());
        assert!(sanitize_bug_report(Some(&json!(null))).is_none());
        assert!(sanitize_bug_report(Some(&json!("nope"))).is_none());
        assert!(sanitize_bug_report(Some(&json!([1, 2, 3]))).is_none());
        assert!(sanitize_bug_report(Some(&json!(42))).is_none());
    }

    #[test]
    fn an_empty_result_is_none_so_the_column_stays_null() {
        // Object, but nothing survives the allow-list.
        assert!(sanitize_bug_report(Some(&json!({}))).is_none());
        assert!(sanitize_bug_report(Some(&json!({ "cookies": "a=b" }))).is_none());
        // Present-but-empty sections do not manufacture keys either.
        assert!(sanitize_bug_report(Some(&json!({
            "environment": {},
            "consoleErrors": [],
            "networkErrors": [],
        })))
        .is_none());
    }

    // --- key allow-lists ---------------------------------------------------

    #[test]
    fn unknown_top_level_keys_are_dropped_silently() {
        let out = sanitize_bug_report(Some(&json!({
            "capturedAt": "2026-07-25T10:00:00.000Z",
            "cookies": "session=abc",
            "localStorage": { "token": "abc" },
            "screenshot": "data:image/png;base64,AAAA",
        })))
        .unwrap();

        let out = out.as_object().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out["capturedAt"], json!("2026-07-25T10:00:00.000Z"));
    }

    #[test]
    fn unknown_nested_keys_are_dropped_from_every_section() {
        let out = sanitize_bug_report(Some(&json!({
            "environment": {
                "url": "https://app.example.com/settings",
                "browser": "Chrome",
                "cookies": "session=abc",
                "userAgent": "Mozilla/5.0",
            },
            "consoleErrors": [
                { "level": "warn", "message": "hi", "timestamp": "t", "stack": "secret" },
            ],
            "networkErrors": [
                {
                    "method": "POST", "url": "https://x.test/a", "status": 500,
                    "timestamp": "t", "requestBody": "password=hunter2",
                    "responseHeaders": { "set-cookie": "x" },
                },
            ],
        })))
        .unwrap();

        let environment = out["environment"].as_object().unwrap();
        assert_eq!(environment.len(), 2);
        assert!(environment.contains_key("url") && environment.contains_key("browser"));

        let console = out["consoleErrors"][0].as_object().unwrap();
        assert_eq!(console.len(), 3);
        assert!(!console.contains_key("stack"));

        let network = out["networkErrors"][0].as_object().unwrap();
        assert_eq!(network.len(), 4);
        assert!(!network.contains_key("requestBody"));
        assert!(!network.contains_key("responseHeaders"));

        // Nothing dropped leaks through the serialized form either.
        let encoded = out.to_string();
        assert!(!encoded.contains("hunter2"));
        assert!(!encoded.contains("set-cookie"));
    }

    #[test]
    fn environment_numbers_must_be_non_negative_integers() {
        let out = sanitize_bug_report(Some(&json!({
            "environment": {
                "viewportWidth": 1280,
                "viewportHeight": -1,
                "screenWidth": "1920",
                "screenHeight": 1080,
            },
        })))
        .unwrap();

        let environment = out["environment"].as_object().unwrap();
        assert_eq!(environment["viewportWidth"], json!(1280));
        assert_eq!(environment["screenHeight"], json!(1080));
        assert!(!environment.contains_key("viewportHeight"));
        assert!(!environment.contains_key("screenWidth"));
    }

    // --- array bounding ----------------------------------------------------

    #[test]
    fn arrays_are_truncated_to_twenty_keeping_the_newest() {
        let console: Vec<Value> = (0..50).map(console_entry).collect();
        let network: Vec<Value> = (0..35).map(network_entry).collect();

        let out = sanitize_bug_report(Some(&json!({
            "consoleErrors": console,
            "networkErrors": network,
        })))
        .unwrap();

        let console = out["consoleErrors"].as_array().unwrap();
        assert_eq!(console.len(), MAX_ENTRIES);
        // The client appends chronologically, so the TAIL is what we keep.
        assert_eq!(console[0]["message"], json!("boom 30"));
        assert_eq!(console[19]["message"], json!("boom 49"));

        let network = out["networkErrors"].as_array().unwrap();
        assert_eq!(network.len(), MAX_ENTRIES);
        assert_eq!(network[0]["url"], json!("https://api.example.com/15"));
        assert_eq!(network[19]["url"], json!("https://api.example.com/34"));
    }

    #[test]
    fn malformed_entries_are_dropped_without_costing_a_slot() {
        let mut entries = vec![
            json!({ "level": "info", "message": "m", "timestamp": "t" }), // bad level
            json!({ "level": "error", "timestamp": "t" }),                // no message
            json!({ "level": "error", "message": "m" }),                  // no timestamp
            json!("not an object"),
        ];
        entries.extend((0..MAX_ENTRIES).map(console_entry));

        let out = sanitize_bug_report(Some(&json!({ "consoleErrors": entries }))).unwrap();
        let console = out["consoleErrors"].as_array().unwrap();
        assert_eq!(console.len(), MAX_ENTRIES);
        assert_eq!(console[0]["message"], json!("boom 0"));

        // A network entry with no `status` key at all is dropped: `status` is
        // nullable but present in the zod schema.
        let out = sanitize_bug_report(Some(&json!({
            "networkErrors": [
                { "method": "GET", "url": "https://x.test/a", "timestamp": "t" },
                { "method": "GET", "url": "https://x.test/b", "status": null, "timestamp": "t" },
            ],
        })))
        .unwrap();
        let network = out["networkErrors"].as_array().unwrap();
        assert_eq!(network.len(), 1);
        assert_eq!(network[0]["status"], json!(null));
    }

    // --- string bounding ---------------------------------------------------

    #[test]
    fn strings_are_truncated_to_the_zod_caps() {
        let out = sanitize_bug_report(Some(&json!({
            "capturedAt": "z".repeat(500),
            "environment": {
                "url": format!("https://x.test/{}", "a".repeat(4000)),
                "browser": "b".repeat(200),
                "timezone": "t".repeat(200),
            },
            "consoleErrors": [{
                "level": "error",
                "message": "m".repeat(9000),
                "timestamp": "2026-07-25T10:00:00.000Z",
                "source": "s".repeat(4000),
            }],
            "networkErrors": [{
                "method": "PROPFINDX".repeat(4),
                "url": format!("https://x.test/{}", "u".repeat(4000)),
                "status": 500,
                "timestamp": "2026-07-25T10:00:00.000Z",
                "error": "e".repeat(4000),
            }],
        })))
        .unwrap();

        assert_eq!(
            out["capturedAt"].as_str().unwrap().len(),
            MAX_TIMESTAMP_CHARS
        );
        assert_eq!(
            out["environment"]["url"].as_str().unwrap().len(),
            MAX_URL_CHARS
        );
        assert_eq!(out["environment"]["browser"].as_str().unwrap().len(), 64);
        assert_eq!(out["environment"]["timezone"].as_str().unwrap().len(), 64);

        let console = &out["consoleErrors"][0];
        assert_eq!(
            console["message"].as_str().unwrap().len(),
            MAX_MESSAGE_CHARS
        );
        assert_eq!(console["source"].as_str().unwrap().len(), MAX_SOURCE_CHARS);

        let network = &out["networkErrors"][0];
        assert_eq!(network["method"].as_str().unwrap().len(), MAX_METHOD_CHARS);
        assert_eq!(network["url"].as_str().unwrap().len(), MAX_URL_CHARS);
        assert_eq!(network["error"].as_str().unwrap().len(), MAX_ERROR_CHARS);
    }

    #[test]
    fn truncation_counts_characters_not_bytes_and_never_splits_one() {
        // 3-byte characters: a byte-based cut would panic or emit a replacement
        // character.
        let out = sanitize_bug_report(Some(&json!({
            "environment": { "browser": "☃".repeat(200) },
        })))
        .unwrap();
        let browser = out["environment"]["browser"].as_str().unwrap();
        assert_eq!(browser.chars().count(), 64);
        assert!(browser.chars().all(|c| c == '☃'));
    }

    // --- redaction: urls ---------------------------------------------------

    #[test]
    fn query_string_secrets_are_redacted_by_key() {
        assert_eq!(
            redact_url("https://x.test/a?token=abc123&page=2"),
            "https://x.test/a?token=[redacted]&page=2"
        );
        assert_eq!(
            redact_url("https://x.test/a?ACCESS_TOKEN=abc&Api-Key=def&password=p&sig=z"),
            "https://x.test/a?ACCESS_TOKEN=[redacted]&Api-Key=[redacted]&password=[redacted]&sig=[redacted]"
        );
        assert_eq!(
            redact_url("https://x.test/a?email=u@example.com&auth=1&session_id=s&code=c"),
            "https://x.test/a?email=[redacted]&auth=[redacted]&session_id=[redacted]&code=[redacted]"
        );
        // Benign params survive; a URL with no query is untouched.
        assert_eq!(
            redact_url("https://x.test/a?page=2&sort=desc"),
            "https://x.test/a?page=2&sort=desc"
        );
        assert_eq!(redact_url("https://x.test/a/b"), "https://x.test/a/b");
        // The fragment is not pair-split into the query.
        assert_eq!(
            redact_url("https://x.test/a?token=abc#/deep/link"),
            "https://x.test/a?token=[redacted]#/deep/link"
        );
    }

    #[test]
    fn urls_are_redacted_everywhere_a_url_can_appear() {
        let out = sanitize_bug_report(Some(&json!({
            "environment": {
                "url": "https://app.test/x?session=abc",
                "referrer": "https://app.test/y?apiKey=zzz",
            },
            "networkErrors": [{
                "method": "GET",
                "url": "https://api.test/v1?access_token=leak",
                "status": 401,
                "timestamp": "t",
            }],
        })))
        .unwrap()
        .to_string();

        assert!(!out.contains("abc"), "{out}");
        assert!(!out.contains("zzz"), "{out}");
        assert!(!out.contains("leak"), "{out}");
        assert_eq!(out.matches("[redacted]").count(), 3);
    }

    // --- redaction: free text ----------------------------------------------

    #[test]
    fn bearer_tokens_are_stripped_from_free_text() {
        assert_eq!(
            redact_text("401 for Bearer sk_live_deadbeef99"),
            "401 for Bearer [redacted]"
        );
        assert_eq!(
            redact_text("authorization: bearer abc.def"),
            "authorization: bearer [redacted]"
        );
        assert_eq!(
            redact_text("header was Bearer:tok_123 today"),
            "header was Bearer:[redacted] today"
        );
        // A bare mention with nothing following it is left alone.
        assert_eq!(redact_text("expected a Bearer"), "expected a Bearer");
    }

    #[test]
    fn jwt_shaped_runs_are_stripped_from_free_text() {
        let jwt =
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            redact_text(&format!("verify failed for {jwt} at login")),
            "verify failed for [redacted] at login"
        );
        // Ordinary dotted identifiers must survive — otherwise every stack
        // trace turns into `[redacted]`.
        assert_eq!(
            redact_text("TypeError at app.min.js:12 in foo.bar.baz"),
            "TypeError at app.min.js:12 in foo.bar.baz"
        );
        assert_eq!(redact_text("a.b.c"), "a.b.c");
    }

    #[test]
    fn free_text_redaction_applies_to_messages_sources_and_errors() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJlX2hlcmU";
        let out = sanitize_bug_report(Some(&json!({
            "consoleErrors": [{
                "level": "error",
                "message": format!("failed with Bearer sk_live_leak and {jwt}"),
                "timestamp": "t",
                "source": format!("https://cdn.test/a.js?token=sourcesecret#{jwt}"),
            }],
            "networkErrors": [{
                "method": "GET",
                "url": "https://api.test/v1",
                "status": null,
                "timestamp": "t",
                "error": "TypeError: rejected Bearer sk_live_other",
            }],
        })))
        .unwrap()
        .to_string();

        assert!(!out.contains("sk_live_leak"), "{out}");
        assert!(!out.contains("sk_live_other"), "{out}");
        assert!(!out.contains("sourcesecret"), "{out}");
        assert!(!out.contains(jwt), "{out}");
    }

    #[test]
    fn redaction_preserves_multibyte_text() {
        assert_eq!(
            redact_text("échec ☃ Bearer sk_live_x ☃ fin"),
            "échec ☃ Bearer [redacted] ☃ fin"
        );
        assert_eq!(redact_text("日本語のメッセージ"), "日本語のメッセージ");
    }

    // --- happy path --------------------------------------------------------

    #[test]
    fn a_well_formed_payload_round_trips_intact() {
        let raw = json!({
            "capturedAt": "2026-07-25T10:00:00.000Z",
            "environment": {
                "url": "https://app.test/settings",
                "referrer": "https://app.test/",
                "viewportWidth": 1280,
                "viewportHeight": 800,
                "screenWidth": 1920,
                "screenHeight": 1080,
                "browser": "Chrome",
                "browserVersion": "141.0",
                "os": "macOS",
                "deviceType": "desktop",
                "locale": "en-US",
                "timezone": "America/Sao_Paulo",
            },
            "consoleErrors": [
                { "level": "error", "message": "boom", "timestamp": "t", "source": "a.js:1:2" },
                { "level": "warn", "message": "meh", "timestamp": "t" },
            ],
            "networkErrors": [
                {
                    "method": "POST", "url": "https://api.test/v1/save", "status": 500,
                    "durationMs": 812.5, "timestamp": "t",
                },
                {
                    "method": "GET", "url": "https://api.test/v1/me", "status": null,
                    "timestamp": "t", "error": "NetworkError",
                },
            ],
        });

        assert_eq!(sanitize_bug_report(Some(&raw)).unwrap(), raw);
    }
}
