# Capture API (`POST /v1/capture`)

Public REST ingest endpoint for clickroom, served by `services/capture` (Rust/Axum). Use this
directly if you don't want an SDK — otherwise see [`@clickroom/sdk-js`](../packages/sdk-js/README.md)
(browser) or [`@clickroom/sdk-node`](../packages/sdk-node/README.md) (server).

## Base URL & versioning

```
POST {api_host}/v1/capture
```

`{api_host}` is wherever `capture-rs` is deployed for your environment (locally, `http://localhost:3001`).
All routes except `GET /health` are nested under `/v1` — treat the prefix as a stable contract
version; breaking changes will bump it.

## Auth

Every request must carry a **write key** (`ckw_live_<hex>`), scoped to a project + environment. Get
one from your project's API Keys page in the clickroom dashboard.

Two ways to supply it, checked in this order:

1. **`Authorization: Bearer <write_key>`** header — preferred for all server-to-server and
   XHR/fetch calls.
2. **`?token=<write_key>` query param** — fallback for contexts that can't set headers, e.g.
   `navigator.sendBeacon()` on page unload.

A missing, malformed, revoked, or non-write key returns `401`.

## Request body

```jsonc
{
  "batch": [
    {
      "event": "signup_completed",       // required, non-empty string
      "distinct_id": "u_123",            // required, non-empty string
      "timestamp": "2026-07-06T12:00:00.000Z", // optional, RFC3339/ISO8601; server fills `now()` if absent/unparseable
      "properties": { "plan": "pro" },   // optional object; non-object/absent normalizes to `{}`
      "elements_chain": "a:href=..."     // optional string; defaults to ""
    }
  ]
}
```

**Batch limits (contract):**

- `batch` must contain **1 to 100 events** inclusive.
  - Empty batch -> `400`.
  - More than 100 events -> `413`.
- Total request body is capped at **1 MB** -> oversize body is rejected with `413` before your
  batch is even parsed.

## Responses

### Success — `202 Accepted`

```json
{ "accepted": 3 }
```

`accepted` is the number of events durably persisted to JetStream. On a normal accept the response
never includes an `errors` field (it's omitted from the JSON entirely, not `null` or `[]`).

### Strict-schema rejection — `400 Bad Request`

If any event in the batch violates a `strict`-mode schema declared for its event name, the **whole
batch** is rejected — nothing in it is published, including the events that were individually
valid:

```json
{
  "accepted": 0,
  "errors": [
    {
      "index": 1,
      "event": "signup_completed",
      "violations": [
        { "kind": "missing_required", "property": "email" },
        {
          "kind": "type_mismatch",
          "property": "age",
          "expected": "Numeric",
          "actual_json_type": "string"
        }
      ]
    }
  ]
}
```

- `index` is the event's zero-based position in the `batch` array you sent.
- `violations[].kind` is one of:
  - `missing_required` — a required property is absent (`property` names it).
  - `type_mismatch` — a declared property has the wrong runtime JSON type. `expected` is one of
    `"String" | "Numeric" | "Boolean" | "DateTime"`; `actual_json_type` is the JSON type actually
    received (`"string" | "number" | "boolean" | "null" | "array" | "object"`).

`400` is also returned for malformed JSON, an empty `batch`, or any event missing/blank `event`/
`distinct_id` — those come back as `{ "error": "<message>" }` (not the `errors` array shape above,
which is specific to schema violations).

### Other status codes

| Status | Meaning |
| --- | --- |
| `401` | Missing, invalid, or revoked write key. |
| `400` | Malformed JSON, empty batch, blank `event`/`distinct_id`, or strict-schema violation (see above). |
| `413` | Body over 1 MB, or `batch.length` over 100. |
| `429` | Per-project rate limit exceeded. Response includes a `Retry-After` header (seconds). |
| `402` | Org's monthly event quota exceeded. |
| `500` | Unexpected backend failure. |

## Example — accepted batch

```sh
curl -i https://your-host/v1/capture \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      { "event": "signup_completed", "distinct_id": "u_123", "properties": { "plan": "pro" } }
    ]
  }'
```

```
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted":1}
```

## Example — strict-mode rejection

Assume the project has declared a `strict`-mode schema for `signup_completed` requiring an
`email` string property and a numeric `age` property:

```sh
curl -i https://your-host/v1/capture \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      { "event": "signup_completed", "distinct_id": "u_123", "properties": { "age": "not-a-number" } }
    ]
  }'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "accepted": 0,
  "errors": [
    {
      "index": 0,
      "event": "signup_completed",
      "violations": [
        { "kind": "missing_required", "property": "email" },
        { "kind": "type_mismatch", "property": "age", "expected": "Numeric", "actual_json_type": "string" }
      ]
    }
  ]
}
```

## Enforcement modes: `none` / `warn` / `strict`

Enforcement mode is configured **per event name, per project**, in the dashboard's event schema
settings — it's not something the caller sets on the request. Three modes:

- **`none`** (default) — no schema declared, or schema explicitly off. Events pass through
  unchecked regardless of shape.
- **`warn`** — violations do **not** reject the batch. The event is accepted (`202`), published,
  and stored, but flagged `schema_valid=0` server-side. This flag is not present in the capture
  response — check the dashboard or query ClickHouse directly to see which events failed
  validation.
- **`strict`** — any violating event rejects the **entire batch** with `400` (see above), before
  anything is published. No partial accept: fix the reported violations and resend.

If you're integrating against a `strict`-mode event, treat a `400` with the `errors` shape above as
retryable-after-fix, not a transient failure — resending the same payload will fail the same way.
