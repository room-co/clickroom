//! Axum handlers for the public support surface.
//!
//! Every route runs the same preamble as `POST /capture`: project write-key
//! auth (`auth.rs`) then per-project rate limiting (`ratelimit.rs`). Ticket
//! creation additionally counts against the org's monthly quota (`quota.rs`).
//!
//! Routes:
//! - `GET  /v1/support` — ACTIVE form configs (no eligibility eval; the SDK
//!   already holds evaluated flags).
//! - `POST /v1/support/tickets` — create a ticket. Doubles as the server-side
//!   inbound REST API.
//! - `GET  /v1/support/tickets?distinctId=<id>` — the identified user's own
//!   tickets (the widget's "My tickets" list), project-key scoped by distinctId
//!   (NOT ticket-token: it lists across tickets).
//! - `GET  /v1/support/tickets/:id` — read one thread, ticket-token scoped.
//! - `POST /v1/support/tickets/:id/messages` — end-user follow-up.
//! - `POST /v1/support/tickets/:id/solve` — end-user "mark solved", ticket-token
//!   scoped.
//! - `GET  /v1/support/tickets/:id/stream` — ticket-token scoped SSE; see
//!   `support/stream.rs`.
//! - `POST /v1/support/attachments/presign` — presigned S3 `PUT`.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::{
    auth::{resolve_write_key, AuthError, ResolvedKey},
    capture::{extract_token, TokenQuery},
    error::ApiError,
    models::EventMessage,
    nats, quota, ratelimit,
    state::AppState,
    support::{
        bug::sanitize_bug_report,
        new_ticket_token, new_ulid, presign, store, ticket_token_matches,
        validate::{parse_field_defs, validate_answers, validate_subject_and_body},
    },
};

/// Header the widget presents its per-ticket read credential in.
const TICKET_TOKEN_HEADER: &str = "x-clickroom-ticket-token";

/// One ticket creation counts as one event against the org's monthly quota —
/// it is one `$support_ticket_created` on the same ingest path as any other
/// event, so it is billed the same way.
const TICKET_QUOTA_UNITS: i64 = 1;

/// Cap on the serialized `context` bundle (identity, recent events, active
/// flags). Public endpoint writing to a jsonb column: without a ceiling a
/// caller with a page-embedded write key could push arbitrarily large blobs
/// into Postgres.
const MAX_CONTEXT_BYTES: usize = 64 * 1024;

/// Cap on the serialized custom-field answers, same reasoning.
const MAX_FIELDS_BYTES: usize = 32 * 1024;

/// Accepted ticket priorities.
const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];

/// Accepted ticket types — discriminator.
const TICKET_TYPES: [&str; 2] = ["conversation", "bug"];

/// Accepted bug severities. Bug-only; `NULL` on a conversation.
const SEVERITIES: [&str; 3] = ["blocker", "major", "minor"];

/// Cap on the serialized bug payload — its OWN budget, deliberately NOT sharing
/// `MAX_CONTEXT_BYTES`: `context` and `bugReport` are two independent growth
/// vectors and one ceiling would let a 20-entry console ring crowd out the
/// identity/recent-events bundle.
const MAX_BUG_REPORT_BYTES: usize = 32 * 1024;

/// Query params accepted by the support routes: the project write key
/// (`?token=`, the beacon-friendly fallback `capture.rs` defines) and the
/// per-ticket read credential (`?ticket_token=`).
#[derive(Debug, Default, Deserialize)]
pub struct SupportQuery {
    token: Option<String>,
    ticket_token: Option<String>,
    /// The identified end-user's distinct id, for `GET /v1/support/tickets` —
    /// the widget's "My tickets" list. Ignored by every other route.
    ///
    /// The SDK sends `?distinctId=` (`support.ts`'s `listForUser`), but this
    /// struct has no `rename_all = "camelCase"`, so the *default* field name is
    /// the snake_case `distinct_id`. Without the camelCase alias the param
    /// never binds, `distinct_id` is `None`, and the endpoint answers every
    /// identified user with `{"tickets": []}` — the widget then silently falls
    /// back to its localStorage rows and the server-side history looks empty
    /// rather than broken. Both spellings are accepted deliberately.
    #[serde(default, alias = "distinct_id", alias = "distinctId")]
    distinct_id: Option<String>,
}

/// Authenticate the project write key and spend a rate-limit token.
///
/// Shared by every support route so no handler can accidentally skip one half
/// of the preamble.
pub(super) async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    query: &SupportQuery,
) -> Result<ResolvedKey, ApiError> {
    let token = extract_token(
        headers,
        &TokenQuery {
            token: query.token.clone(),
        },
    )
    .ok_or(ApiError::Unauthorized)?;

    let resolved = match resolve_write_key(state, &token).await {
        Ok(resolved) => resolved,
        Err(AuthError::Unauthorized) => return Err(ApiError::Unauthorized),
        Err(AuthError::Backend(e)) => return Err(ApiError::Internal(e)),
    };

    let decision = ratelimit::check(state, &resolved.project_id).await?;
    if !decision.allowed {
        return Err(ApiError::RateLimited {
            retry_after: decision.retry_after,
        });
    }

    Ok(resolved)
}

/// Extract the per-ticket read credential from the header or the query string.
pub(super) fn extract_ticket_token(headers: &HeaderMap, query: &SupportQuery) -> Option<String> {
    if let Some(value) = headers.get(TICKET_TOKEN_HEADER) {
        if let Ok(s) = value.to_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    query.ticket_token.as_ref().and_then(|t| {
        let t = t.trim();
        (!t.is_empty()).then(|| t.to_string())
    })
}

/// Map a quota decision to the `402` the contract specifies.
fn quota_gate(decision: &quota::QuotaDecision, org_id: &str) -> Result<(), ApiError> {
    if decision.allowed {
        return Ok(());
    }
    tracing::warn!(
        org_id,
        current = decision.current,
        limit = decision.limit,
        "support: quota exceeded on ticket create"
    );
    Err(ApiError::QuotaExceeded)
}

// ---------------------------------------------------------------------------
// GET /v1/support
// ---------------------------------------------------------------------------

/// One form in the `/v1/support` response.
#[derive(Debug, Serialize)]
struct FormOut {
    id: String,
    definition: Value,
    version: i32,
    #[serde(rename = "linkedFlagKey")]
    linked_flag_key: String,
}

/// `GET /v1/support` — the project's ACTIVE support form configs.
///
/// No eligibility evaluation happens here: the SDK already holds evaluated
/// flags and gates display on `linkedFlagKey` itself, exactly as `/v1/surveys`
/// does.
pub async fn support_config_endpoint(
    State(state): State<AppState>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;
    let rows = store::load_active_forms(&state, &resolved.project_id).await?;

    // A row whose definition somehow fails to parse is skipped rather than
    // failing the whole fetch — one bad config must not blank support for the
    // entire project.
    let forms: Vec<FormOut> = rows
        .iter()
        .filter_map(|row| match serde_json::from_str::<Value>(&row.definition) {
            Ok(definition) => Some(FormOut {
                id: row.id.clone(),
                definition,
                version: row.version,
                linked_flag_key: row.flag_key.clone(),
            }),
            Err(e) => {
                tracing::warn!(
                    "skipping support form {} with unparseable definition: {e}",
                    row.id
                );
                None
            }
        })
        .collect();

    Ok(Json(json!({ "forms": forms })))
}

// ---------------------------------------------------------------------------
// POST /v1/support/tickets
// ---------------------------------------------------------------------------

/// Ticket creation payload. `deny_unknown_fields` on the envelope pairs with
/// the per-form check on `fields` so nothing undeclared is ever persisted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTicketRequest {
    #[serde(alias = "form_id")]
    form_id: String,
    #[serde(alias = "distinct_id")]
    distinct_id: String,
    subject: String,
    body: String,
    #[serde(default, alias = "person_id")]
    person_id: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    fields: Option<Map<String, Value>>,
    #[serde(default)]
    context: Option<Value>,
    /// `conversation` | `bug`. `type` is a Rust keyword and the
    /// struct is `rename_all = "camelCase"`, so the rename is explicit.
    #[serde(default, rename = "type")]
    ticket_type: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default, alias = "bug_report")]
    bug_report: Option<Value>,
}

/// Normalize + bound the optional `priority`.
fn resolve_priority(raw: Option<&str>) -> Result<String, String> {
    let value = raw.unwrap_or("normal").trim().to_ascii_lowercase();
    if PRIORITIES.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("priority must be one of {PRIORITIES:?}"))
    }
}

/// Resolve the ticket's `type` — back-compat lever.
///
/// An explicit client value wins (allow-listed, never free-form). When it is
/// absent we fall back to the form's `channel`, which is what makes
/// `supportChannelSchema`'s `bug` value load-bearing for the first time: an
/// **unmodified 0.8.0 widget** filing against a `channel: "bug"` form produces a
/// typed bug with no client change at all.
fn resolve_ticket_type(raw: Option<&str>, definition: &Value) -> Result<String, String> {
    if let Some(v) = raw {
        let v = v.trim().to_ascii_lowercase();
        return if TICKET_TYPES.contains(&v.as_str()) {
            Ok(v)
        } else {
            Err(format!("type must be one of {TICKET_TYPES:?}"))
        };
    }
    Ok(match definition.get("channel").and_then(Value::as_str) {
        Some("bug") => "bug",
        _ => "conversation",
    }
    .to_string())
}

/// Normalize + bound the optional `severity`.
///
/// Absent is `None` (a conversation has no severity, and a bug may be filed
/// without one). A severity on a **non-bug is a 400**, not a silent drop —
/// unlike `bugReport`, severity is a lifecycle claim the agent will filter and
/// sort on, so a caller that gets it wrong should hear about it. Same loud
/// allow-list posture as [`resolve_priority`].
fn resolve_severity(raw: Option<&str>, ticket_type: &str) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    if ticket_type != "bug" {
        return Err(format!(
            "severity is only valid on a bug ticket (got type {ticket_type:?})"
        ));
    }
    if SEVERITIES.contains(&value.as_str()) {
        Ok(Some(value))
    } else {
        Err(format!("severity must be one of {SEVERITIES:?}"))
    }
}

/// Normalize + bound the optional `category`. Free-form (forms define their own
/// taxonomy) but length-capped and never empty.
fn resolve_category(raw: Option<&str>) -> Result<String, String> {
    let value = raw.unwrap_or("general").trim();
    if value.is_empty() {
        return Ok("general".to_string());
    }
    if value.chars().count() > 64 {
        return Err("category exceeds 64 characters".to_string());
    }
    Ok(value.to_string())
}

/// Serialize an optional JSON object for a jsonb column, enforcing a byte cap.
///
/// Rejects a non-object body outright: both `fields` and `context` are objects
/// by contract, and accepting a bare scalar or array would make every reader
/// downstream defensive.
fn encode_json_object(
    value: Option<&Value>,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let Some(value) = value else {
        return Ok("{}".to_string());
    };
    if !value.is_object() {
        return Err(format!("{label} must be an object"));
    }
    let encoded = value.to_string();
    if encoded.len() > max_bytes {
        return Err(format!("{label} exceeds {max_bytes} bytes"));
    }
    Ok(encoded)
}

/// Validate the request against the form's stored definition and normalize
/// everything the store layer needs. Pure orchestration of the checks in
/// `validate.rs`; no I/O.
fn build_new_ticket(
    req: &CreateTicketRequest,
    project_id: &str,
    definition: &Value,
) -> Result<store::NewTicket, String> {
    validate_subject_and_body(&req.subject, &req.body)?;
    if req.distinct_id.trim().is_empty() {
        return Err("distinctId is empty".to_string());
    }

    let empty = Map::new();
    let answers = req.fields.as_ref().unwrap_or(&empty);
    validate_answers(&parse_field_defs(definition), answers)?;

    let fields_json = encode_json_object(
        Some(&Value::Object(answers.clone())),
        MAX_FIELDS_BYTES,
        "fields",
    )?;
    let context_json = encode_json_object(req.context.as_ref(), MAX_CONTEXT_BYTES, "context")?;

    let ticket_type = resolve_ticket_type(req.ticket_type.as_deref(), definition)?;
    let severity = resolve_severity(req.severity.as_deref(), &ticket_type)?;

    // A bug payload on a conversation is dropped **silently**, not 400'd: the
    // payload is best-effort telemetry, so discarding it costs the reporter
    // nothing, whereas rejecting the ticket costs them the report.
    let bug_report_json = if ticket_type == "bug" {
        sanitize_bug_report(req.bug_report.as_ref())
            .map(|sanitized| {
                encode_json_object(Some(&sanitized), MAX_BUG_REPORT_BYTES, "bugReport")
            })
            .transpose()?
    } else {
        None
    };

    Ok(store::NewTicket {
        form_id: req.form_id.clone(),
        project_id: project_id.to_string(),
        distinct_id: req.distinct_id.trim().to_string(),
        person_id: req
            .person_id
            .as_ref()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty()),
        priority: resolve_priority(req.priority.as_deref())?,
        category: resolve_category(req.category.as_deref())?,
        subject: req.subject.trim().to_string(),
        ticket_type,
        severity,
        fields_json,
        context_json,
        bug_report_json,
        body: req.body.clone(),
    })
}

/// `POST /v1/support/tickets`.
pub async fn create_ticket_endpoint(
    State(state): State<AppState>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;

    let req: CreateTicketRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid ticket json: {e}")))?;

    // The form read is project-scoped, so a write key for one project cannot
    // file against another project's form.
    let form = store::load_active_form(&state, &resolved.project_id, &req.form_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest(format!("unknown support form {:?}", req.form_id)))?;
    let definition: Value = serde_json::from_str(&form.definition)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("form {} definition: {e}", form.id)))?;

    let new_ticket =
        build_new_ticket(&req, &resolved.project_id, &definition).map_err(ApiError::BadRequest)?;

    // Quota before the write: a rejected ticket must not consume a ticket
    // number or leave a row behind.
    let decision = quota::check_events(&state, &resolved.org_id, TICKET_QUOTA_UNITS).await?;
    quota_gate(&decision, &resolved.org_id)?;

    let created = store::create_ticket(&state, &new_ticket, &new_ticket_token()).await?;

    // Everything past this point is best-effort: the ticket is committed and
    // is the source of truth, so a NATS hiccup must not turn a stored ticket
    // into a 500 the widget will retry (and thereby duplicate).
    publish_ticket_created(&state, &resolved, &new_ticket, &created).await;
    enqueue_and_notify(
        &state,
        &resolved.project_id,
        &created.id,
        "ticket.created",
        ticket_webhook_payload("ticket.created", &new_ticket, &created, &req.body),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": created.id,
            "number": created.number,
            "token": created.token,
        })),
    ))
}

/// Publish `$support_ticket_created` on the normal capture path so it lands in
/// `events` and, via the materialized view, in `support_events`.
///
/// Failures are logged, not surfaced: see the caller's comment.
async fn publish_ticket_created(
    state: &AppState,
    resolved: &ResolvedKey,
    new_ticket: &store::NewTicket,
    created: &store::CreatedTicket,
) {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let message = EventMessage {
        uuid: Uuid::now_v7().to_string(),
        project_id: resolved.project_id.clone(),
        timestamp: now.clone(),
        event: "$support_ticket_created".to_string(),
        distinct_id: new_ticket.distinct_id.clone(),
        properties: json!({
            "$support_form_id": new_ticket.form_id,
            "$support_ticket_id": created.id,
            "$support_ticket_number": created.number,
            "$support_category": new_ticket.category,
            "$support_priority": new_ticket.priority,
            "$support_ticket_type": new_ticket.ticket_type,
            // Empty string, not null: the ClickHouse column is a
            // `LowCardinality(String) DEFAULT ''`.
            "$support_severity": new_ticket.severity.clone().unwrap_or_default(),
        }),
        elements_chain: String::new(),
        created_at: now,
    };

    let payload = match serde_json::to_vec(&message) {
        Ok(payload) => payload,
        Err(e) => {
            tracing::error!(error = %e, "support: serializing $support_ticket_created failed");
            return;
        }
    };

    if let Err(e) = nats::publish_event(
        &state.jetstream,
        &resolved.project_id,
        payload,
        &state.config.subject_prefix,
    )
    .await
    {
        tracing::error!(
            error = %e,
            ticket_id = %created.id,
            "support: publishing $support_ticket_created failed; ticket is still stored"
        );
    }
}

/// The JSON body a `ticket.*` webhook delivers.
fn ticket_webhook_payload(
    event: &str,
    new_ticket: &store::NewTicket,
    created: &store::CreatedTicket,
    body: &str,
) -> Value {
    json!({
        "event": event,
        "ticket": {
            "id": created.id,
            "number": created.number,
            "projectId": new_ticket.project_id,
            "formId": new_ticket.form_id,
            "status": "open",
            "type": new_ticket.ticket_type,
            "severity": new_ticket.severity,
            "priority": new_ticket.priority,
            "category": new_ticket.category,
            "subject": new_ticket.subject,
            "distinctId": new_ticket.distinct_id,
        },
        "message": { "authorType": "user", "body": body },
    })
}

/// Write the delivery rows and nudge the ingest worker.
///
/// The row is what makes delivery durable (the worker sweeps `pending` rows on
/// an interval); the NATS notification only makes the first attempt prompt, so
/// it is published on core NATS and its failure is logged rather than
/// propagated.
async fn enqueue_and_notify(
    state: &AppState,
    project_id: &str,
    ticket_id: &str,
    event: &str,
    payload: Value,
) {
    let delivery_ids = match store::enqueue_webhook_deliveries(
        state,
        project_id,
        ticket_id,
        event,
        &payload.to_string(),
    )
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            tracing::error!(error = %e, ticket_id, event, "support: enqueueing webhook deliveries failed");
            return;
        }
    };

    for delivery_id in delivery_ids {
        let notification = json!({ "deliveryId": delivery_id, "event": event }).to_string();
        if let Err(e) = state
            .nats_core
            .publish(
                state.config.support_webhook_subject.clone(),
                notification.into(),
            )
            .await
        {
            tracing::warn!(
                error = %e,
                delivery_id,
                "support: webhook delivery notify failed; the ingest sweep will still pick it up"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// GET /v1/support/tickets  (the identified user's "My tickets" list)
// ---------------------------------------------------------------------------

/// Shape one ticket summary for the widget's 2a list. Field names mirror the
/// SDK's `SupportTicketSummary` (`packages/sdk-js/src/support.ts`); the extra
/// `category` / `type` / `updatedAt` / `lastMessage*` fields are additive and ignored by
/// an older SDK. Never carries `token`, `assigneeId` or `personId`.
fn summary_out(row: &store::TicketSummaryRow) -> Value {
    json!({
        "id": row.id,
        "number": row.number,
        "formId": row.form_id,
        "status": row.status,
        "category": row.category,
        "subject": row.subject,
        // The ONE thread list chips a bug row off this. Emitted as
        // `type` (the wire name everywhere else — zod, Prisma, the SDK); the
        // Rust-side `ticket_type` rename only exists because `type` is a keyword.
        "type": row.ticket_type,
        "unreadForUser": row.unread_for_user,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "lastMessage": row.last_message,
        "lastMessageAuthorType": row.last_message_author_type,
    })
}

/// `GET /v1/support/tickets?distinctId=<id>` — the identified end-user's own
/// tickets, most-recent-activity first, for the widget's "My tickets" history.
///
/// Project-key authed (NOT per-ticket-token): the widget lists ACROSS the
/// user's tickets, so it presents only the project write key and names the user
/// by `distinctId`. Scoping is strict — `projectId` from the authenticated key,
/// `distinctId` from the query — so it can never cross a project or a user
/// boundary (see [`store::list_tickets_for_user`]).
///
/// Anonymous users are out of scope by design: they have no server-side history
/// (only the SDK's local token store). A missing/empty `distinctId` therefore
/// returns an empty list rather than erroring — the SDK only calls this for an
/// identified user, and a graceful empty keeps the list view from breaking.
pub async fn list_tickets_endpoint(
    State(state): State<AppState>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;

    let distinct_id = query
        .distinct_id
        .as_ref()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty());
    let Some(distinct_id) = distinct_id else {
        return Ok(Json(json!({ "tickets": [] })));
    };

    let tickets: Vec<Value> =
        store::list_tickets_for_user(&state, &resolved.project_id, distinct_id)
            .await?
            .iter()
            .map(summary_out)
            .collect();

    Ok(Json(json!({ "tickets": tickets })))
}

// ---------------------------------------------------------------------------
// GET /v1/support/tickets/:id
// ---------------------------------------------------------------------------

/// One message as the widget sees it. `authorUserId` is deliberately absent:
/// the end user learns that an agent replied, never which one.
#[derive(Debug, Serialize)]
struct MessageOut {
    #[serde(rename = "authorType")]
    author_type: String,
    body: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

/// Load a ticket and authorize the presented ticket token against it.
///
/// Every failure — unknown id, wrong project, missing token, wrong token —
/// collapses to `401`. Distinguishing them would turn this route into an
/// existence oracle for ticket ids across projects.
pub(super) async fn authorized_ticket(
    state: &AppState,
    resolved: &ResolvedKey,
    ticket_id: &str,
    presented: Option<&str>,
) -> Result<store::TicketRow, ApiError> {
    let presented = presented.ok_or(ApiError::Unauthorized)?;
    let ticket = store::load_ticket(state, ticket_id)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if ticket.project_id != resolved.project_id {
        return Err(ApiError::Unauthorized);
    }
    if !ticket_token_matches(presented, &ticket.token) {
        return Err(ApiError::Unauthorized);
    }
    Ok(ticket)
}

/// Shape a ticket for the widget. Never includes `token`, `assigneeId` or
/// `personId`.
fn ticket_out(ticket: &store::TicketRow, messages: Vec<MessageOut>) -> Value {
    json!({
        "id": ticket.id,
        "number": ticket.number,
        "formId": ticket.form_id,
        "status": ticket.status,
        "priority": ticket.priority,
        "category": ticket.category,
        "subject": ticket.subject,
        "createdAt": ticket.created_at,
        "resolvedAt": ticket.resolved_at,
        "messages": messages,
    })
}

/// `GET /v1/support/tickets/:id`.
pub async fn get_ticket_endpoint(
    State(state): State<AppState>,
    Path(ticket_id): Path<String>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;
    let presented = extract_ticket_token(&headers, &query);
    let ticket = authorized_ticket(&state, &resolved, &ticket_id, presented.as_deref()).await?;

    // The widget is reading its own thread, so nothing is unread for the user
    // anymore. Best-effort: a failed badge-clear must not fail the thread read
    // the user actually asked for.
    if let Err(e) = store::clear_unread_for_user(&state, &ticket.id).await {
        tracing::warn!(error = %e, ticket_id = %ticket.id, "support: clearing unreadForUser failed");
    }

    let messages = store::load_public_messages(&state, &ticket.id)
        .await?
        .into_iter()
        .map(|m| MessageOut {
            author_type: m.author_type,
            body: m.body,
            created_at: m.created_at,
        })
        .collect();

    Ok(Json(ticket_out(&ticket, messages)))
}

// ---------------------------------------------------------------------------
// POST /v1/support/tickets/:id/messages
// ---------------------------------------------------------------------------

/// End-user follow-up payload. The ticket token may travel in the body as well
/// as the header/query, because the widget posts JSON and a body field is the
/// one place it never has to fight a CORS preflight over a custom header.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendMessageRequest {
    body: String,
    #[serde(default, alias = "ticket_token")]
    ticket_token: Option<String>,
}

/// `POST /v1/support/tickets/:id/messages`.
pub async fn append_message_endpoint(
    State(state): State<AppState>,
    Path(ticket_id): Path<String>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;

    let req: AppendMessageRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid message json: {e}")))?;

    let presented = extract_ticket_token(&headers, &query).or_else(|| {
        req.ticket_token
            .as_ref()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    });
    let ticket = authorized_ticket(&state, &resolved, &ticket_id, presented.as_deref()).await?;

    validate_subject_and_body(&ticket.subject, &req.body).map_err(ApiError::BadRequest)?;

    let status = store::append_user_message(&state, &ticket.id, &req.body).await?;
    let reopened = matches!(ticket.status.as_str(), "resolved" | "closed");

    enqueue_and_notify(
        &state,
        &resolved.project_id,
        &ticket.id,
        "ticket.updated",
        json!({
            "event": "ticket.updated",
            "ticket": {
                "id": ticket.id,
                "number": ticket.number,
                "projectId": ticket.project_id,
                "formId": ticket.form_id,
                "status": status,
                "priority": ticket.priority,
                "category": ticket.category,
                "subject": ticket.subject,
                "reopened": reopened,
            },
            "message": { "authorType": "user", "body": req.body },
        }),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "status": status, "reopened": reopened })),
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/support/tickets/:id/solve
// ---------------------------------------------------------------------------

/// End-user "mark solved" payload. Carries only the optional ticket token in the
/// body, for the same CORS-preflight reason `AppendMessageRequest` does.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SolveTicketRequest {
    #[serde(default, alias = "ticket_token")]
    ticket_token: Option<String>,
}

/// `POST /v1/support/tickets/:id/solve` — the end user resolves their own
/// ticket from the widget.
///
/// Token-scoped exactly like the thread read: the same constant-time compare
/// gates it, so only the holder of the ticket's read credential can close it and
/// a write key alone can never resolve another anonymous user's ticket. It is
/// the mirror of the agent-side `setStatus('resolved')`, and — like ticket
/// creation and resolution generally — the `$support_ticket_resolved` analytics
/// event is emitted here on the capture path, not from the control plane.
pub async fn solve_ticket_endpoint(
    State(state): State<AppState>,
    Path(ticket_id): Path<String>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;

    // The body is optional: the widget may send an empty request and carry the
    // ticket token in the header/query instead.
    let req: SolveTicketRequest = if body.is_empty() {
        SolveTicketRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|e| ApiError::BadRequest(format!("invalid solve json: {e}")))?
    };

    let presented = extract_ticket_token(&headers, &query).or_else(|| {
        req.ticket_token
            .as_ref()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    });
    let ticket = authorized_ticket(&state, &resolved, &ticket_id, presented.as_deref()).await?;

    let status = store::mark_ticket_solved(&state, &ticket.id).await?;

    // Best-effort, past the committed write: analytics event on the capture path
    // plus the outbound `ticket.resolved` webhook, same posture as create.
    publish_ticket_resolved(&state, &resolved, &ticket, &status).await;
    enqueue_and_notify(
        &state,
        &resolved.project_id,
        &ticket.id,
        "ticket.resolved",
        json!({
            "event": "ticket.resolved",
            "ticket": {
                "id": ticket.id,
                "number": ticket.number,
                "projectId": ticket.project_id,
                "formId": ticket.form_id,
                "status": status,
                "priority": ticket.priority,
                "category": ticket.category,
                "subject": ticket.subject,
                "resolvedBy": "end_user",
            },
        }),
    )
    .await;

    Ok((StatusCode::OK, Json(json!({ "status": status }))))
}

/// Publish `$support_ticket_resolved` on the normal capture path when the end
/// user resolves their own ticket, so deflection/resolution analytics see it the
/// same way they see an agent resolution. Failures are logged, not surfaced —
/// the ticket is already resolved in Postgres.
async fn publish_ticket_resolved(
    state: &AppState,
    resolved: &ResolvedKey,
    ticket: &store::TicketRow,
    status: &str,
) {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let message = EventMessage {
        uuid: Uuid::now_v7().to_string(),
        project_id: resolved.project_id.clone(),
        timestamp: now.clone(),
        event: "$support_ticket_resolved".to_string(),
        // No end-user distinct id is carried on the read path, so attribute the
        // resolution to the ticket itself.
        distinct_id: ticket.id.clone(),
        properties: json!({
            "$support_form_id": ticket.form_id,
            "$support_ticket_id": ticket.id,
            "$support_ticket_number": ticket.number,
            "$support_category": ticket.category,
            "$support_priority": ticket.priority,
            // Type only: severity is agent-mutable after create, so snapshotting
            // it a second time here would just record a stale value.
            "$support_ticket_type": ticket.ticket_type,
            "$support_status": status,
            "$support_resolved_by": "end_user",
        }),
        elements_chain: String::new(),
        created_at: now,
    };

    let payload = match serde_json::to_vec(&message) {
        Ok(payload) => payload,
        Err(e) => {
            tracing::error!(error = %e, "support: serializing $support_ticket_resolved failed");
            return;
        }
    };

    if let Err(e) = nats::publish_event(
        &state.jetstream,
        &resolved.project_id,
        payload,
        &state.config.subject_prefix,
    )
    .await
    {
        tracing::error!(
            error = %e,
            ticket_id = %ticket.id,
            "support: publishing $support_ticket_resolved failed; ticket is still resolved"
        );
    }
}

// ---------------------------------------------------------------------------
// POST /v1/support/attachments/presign
// ---------------------------------------------------------------------------

/// Presign request. `sizeBytes` is declared by the client and validated here;
/// it is also signed into the URL, so the actual upload cannot exceed it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresignRequest {
    filename: String,
    #[serde(alias = "content_type")]
    content_type: String,
    #[serde(alias = "size_bytes")]
    size_bytes: i64,
    #[serde(default, alias = "ticket_id")]
    ticket_id: Option<String>,
}

/// Resolve the `{ticket}` key segment.
///
/// The widget presigns while the user is still filling the form, before a
/// ticket exists, so an absent id is normal and lands under `unassigned`. A
/// supplied id is validated as a single safe segment — never interpolated raw.
fn resolve_ticket_segment(ticket_id: Option<&str>) -> Result<String, String> {
    match ticket_id.map(str::trim).filter(|t| !t.is_empty()) {
        None => Ok(presign::UNASSIGNED_TICKET_SEGMENT.to_string()),
        Some(id) if presign::is_safe_key_segment(id) => Ok(id.to_string()),
        Some(_) => Err("ticketId is not a valid id".to_string()),
    }
}

/// `POST /v1/support/attachments/presign`.
pub async fn presign_endpoint(
    State(state): State<AppState>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    let resolved = authorize(&state, &headers, &query).await?;

    let req: PresignRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid presign json: {e}")))?;

    let upload = presign::validate_upload(&req.filename, &req.content_type, req.size_bytes)
        .map_err(ApiError::BadRequest)?;
    let segment = resolve_ticket_segment(req.ticket_id.as_deref()).map_err(ApiError::BadRequest)?;

    // Project segment comes from the authenticated key, never the request.
    let key =
        presign::build_attachment_key(&resolved.project_id, &segment, &new_ulid(), &req.filename);
    let url = presign::presign_put(&state.config, &key, &upload).await?;

    Ok(Json(json!({
        "url": url,
        "key": key,
        "contentType": upload.content_type,
        "expiresIn": presign::PRESIGN_TTL_SECONDS,
        "maxBytes": presign::MAX_BYTES,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{OveragePolicy, QuotaDecision};

    fn query(token: Option<&str>, ticket_token: Option<&str>) -> SupportQuery {
        SupportQuery {
            token: token.map(str::to_string),
            ticket_token: ticket_token.map(str::to_string),
            distinct_id: None,
        }
    }

    // --- query-param binding ------------------------------------------------

    /// The SDK spells this param `distinctId`. `SupportQuery` has no
    /// `rename_all = "camelCase"`, so without the explicit alias the camelCase
    /// spelling silently fails to bind and `GET /v1/support/tickets` answers
    /// every identified user with an empty list instead of their history.
    #[test]
    fn distinct_id_binds_from_both_camel_case_and_snake_case() {
        // Go through axum's own `Query` extractor, i.e. the exact path the
        // running handler uses — not a hand-rolled parser that could agree
        // with the struct while the real router disagrees.
        let bind = |qs: &str| {
            let uri: axum::http::Uri = format!("http://x/v1/support/tickets?{qs}").parse().unwrap();
            Query::<SupportQuery>::try_from_uri(&uri)
                .expect("should deserialize")
                .0
                .distinct_id
        };

        assert_eq!(bind("distinctId=alice").as_deref(), Some("alice"));
        assert_eq!(bind("distinct_id=alice").as_deref(), Some("alice"));
        assert_eq!(bind("token=ckw_live_abc"), None);
    }

    // --- auth preamble -----------------------------------------------------

    #[test]
    fn write_key_is_read_from_bearer_or_query() {
        // `authorize` funnels through `capture::extract_token`, so the support
        // routes accept exactly the same credential shapes as `POST /capture`.
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer ckw_live_abc".parse().unwrap(),
        );
        assert_eq!(
            extract_token(
                &headers,
                &TokenQuery {
                    token: query(None, None).token
                }
            ),
            Some("ckw_live_abc".into())
        );

        let headers = HeaderMap::new();
        assert_eq!(
            extract_token(
                &headers,
                &TokenQuery {
                    token: query(Some("ckw_live_xyz"), None).token
                }
            ),
            Some("ckw_live_xyz".into())
        );
    }

    #[test]
    fn missing_write_key_is_unauthorized() {
        let headers = HeaderMap::new();
        let resolved = extract_token(&headers, &TokenQuery { token: None });
        assert!(
            resolved.is_none(),
            "no credential -> 401 before any DB read"
        );
    }

    // --- ticket token extraction ------------------------------------------

    #[test]
    fn ticket_token_comes_from_header_first() {
        let mut headers = HeaderMap::new();
        headers.insert(TICKET_TOKEN_HEADER, "from-header".parse().unwrap());
        assert_eq!(
            extract_ticket_token(&headers, &query(None, Some("from-query"))),
            Some("from-header".into())
        );
    }

    #[test]
    fn ticket_token_falls_back_to_query_and_trims() {
        let headers = HeaderMap::new();
        assert_eq!(
            extract_ticket_token(&headers, &query(None, Some("  tok  "))),
            Some("tok".into())
        );
        assert_eq!(
            extract_ticket_token(&headers, &query(None, Some("   "))),
            None
        );
        assert_eq!(extract_ticket_token(&headers, &query(None, None)), None);
    }

    // --- quota accounting --------------------------------------------------

    fn decision(allowed: bool, current: i64, limit: i64) -> QuotaDecision {
        QuotaDecision {
            allowed,
            current,
            limit,
            over: current > limit,
            policy: OveragePolicy::Block,
        }
    }

    #[test]
    fn ticket_create_counts_exactly_one_event() {
        assert_eq!(TICKET_QUOTA_UNITS, 1);
    }

    #[test]
    fn quota_gate_rejects_over_limit_with_402() {
        let err = quota_gate(&decision(false, 101, 100), "org1").unwrap_err();
        assert!(matches!(err, ApiError::QuotaExceeded));
    }

    #[test]
    fn quota_gate_allows_when_under_limit_or_overage_permitted() {
        assert!(quota_gate(&decision(true, 5, 100), "org1").is_ok());
        // Over the limit but the org opted into `allow` overage: `allowed` is
        // still true and the ticket must go through.
        let mut over = decision(true, 101, 100);
        over.policy = OveragePolicy::Allow;
        assert!(quota_gate(&over, "org1").is_ok());
    }

    // --- payload normalization + definition validation ---------------------

    fn definition() -> Value {
        json!({
            "version": 1,
            "channel": "contact",
            "fields": [
                { "id": "email", "label": "Email", "type": "email", "required": true },
                { "id": "details", "label": "Details", "type": "long_text", "required": false }
            ]
        })
    }

    fn request(fields: Value) -> CreateTicketRequest {
        CreateTicketRequest {
            form_id: "01FORM".into(),
            distinct_id: "user-1".into(),
            subject: "Cannot log in".into(),
            body: "It fails on submit".into(),
            person_id: None,
            category: None,
            priority: None,
            fields: fields.as_object().cloned(),
            context: None,
            ticket_type: None,
            severity: None,
            bug_report: None,
        }
    }

    /// A form whose `channel` is fallback discriminator.
    fn bug_definition() -> Value {
        json!({ "version": 1, "channel": "bug", "fields": [] })
    }

    #[test]
    fn builds_a_ticket_from_a_valid_payload() {
        let req = request(json!({ "email": "u@example.com" }));
        let ticket = build_new_ticket(&req, "01PROJECT", &definition()).unwrap();
        assert_eq!(ticket.project_id, "01PROJECT");
        assert_eq!(ticket.priority, "normal");
        assert_eq!(ticket.category, "general");
        assert_eq!(ticket.context_json, "{}");
        assert!(ticket.fields_json.contains("u@example.com"));
    }

    #[test]
    fn rejects_an_unknown_field_against_the_stored_definition() {
        let req = request(json!({ "email": "u@example.com", "isAdmin": true }));
        let err = build_new_ticket(&req, "01PROJECT", &definition()).unwrap_err();
        assert!(err.contains("unknown field"), "{err}");
    }

    #[test]
    fn rejects_missing_required_field_and_empty_subject_body() {
        let req = request(json!({}));
        assert!(build_new_ticket(&req, "p", &definition()).is_err());

        let mut req = request(json!({ "email": "u@example.com" }));
        req.subject = "  ".into();
        assert!(build_new_ticket(&req, "p", &definition()).is_err());

        let mut req = request(json!({ "email": "u@example.com" }));
        req.body = "".into();
        assert!(build_new_ticket(&req, "p", &definition()).is_err());
    }

    #[test]
    fn rejects_blank_distinct_id() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.distinct_id = "   ".into();
        assert!(build_new_ticket(&req, "p", &definition()).is_err());
    }

    #[test]
    fn envelope_rejects_unknown_top_level_keys() {
        let raw =
            br#"{"formId":"01F","distinctId":"u","subject":"s","body":"b","status":"resolved"}"#;
        let parsed: Result<CreateTicketRequest, _> = serde_json::from_slice(raw);
        assert!(
            parsed.is_err(),
            "client-supplied `status` must not be accepted"
        );
    }

    #[test]
    fn envelope_accepts_snake_case_aliases_for_the_server_side_api() {
        let raw = br#"{"form_id":"01F","distinct_id":"u","subject":"s","body":"b"}"#;
        let parsed: CreateTicketRequest = serde_json::from_slice(raw).unwrap();
        assert_eq!(parsed.form_id, "01F");
        assert_eq!(parsed.distinct_id, "u");
    }

    #[test]
    fn priority_is_allow_listed() {
        assert_eq!(resolve_priority(None).unwrap(), "normal");
        assert_eq!(resolve_priority(Some("URGENT")).unwrap(), "urgent");
        assert!(resolve_priority(Some("p0")).is_err());
    }

    #[test]
    fn category_is_bounded_and_defaulted() {
        assert_eq!(resolve_category(None).unwrap(), "general");
        assert_eq!(resolve_category(Some("  ")).unwrap(), "general");
        assert_eq!(resolve_category(Some(" billing ")).unwrap(), "billing");
        assert!(resolve_category(Some(&"c".repeat(65))).is_err());
    }

    #[test]
    fn context_must_be_a_bounded_object() {
        assert_eq!(encode_json_object(None, 100, "context").unwrap(), "{}");
        assert!(encode_json_object(Some(&json!([1, 2])), 100, "context").is_err());
        assert!(encode_json_object(Some(&json!("x")), 100, "context").is_err());
        let big = json!({ "blob": "x".repeat(200) });
        assert!(encode_json_object(Some(&big), 100, "context").is_err());
    }

    // ── type / severity / bugReport ----------------------------

    #[test]
    fn ticket_type_prefers_an_explicit_client_value() {
        // An explicit value wins over the form's channel in BOTH directions —
        // a bug filed from a contact form and a conversation filed from a bug
        // form are both legitimate.
        assert_eq!(
            resolve_ticket_type(Some("bug"), &definition()).unwrap(),
            "bug"
        );
        assert_eq!(
            resolve_ticket_type(Some("conversation"), &bug_definition()).unwrap(),
            "conversation"
        );
        // Normalized the same way `priority` is.
        assert_eq!(
            resolve_ticket_type(Some("  BUG  "), &definition()).unwrap(),
            "bug"
        );
    }

    #[test]
    fn ticket_type_falls_back_to_the_form_channel() {
        // This is the whole back-compat lever: an unmodified 0.8.0 widget sends
        // no `type` at all, and a `channel: "bug"` form still produces a bug.
        assert_eq!(resolve_ticket_type(None, &bug_definition()).unwrap(), "bug");
        assert_eq!(
            resolve_ticket_type(None, &definition()).unwrap(),
            "conversation"
        );
        // `bot` behaves exactly like `contact`, and a definition with no
        // channel at all (or a non-string one) is a conversation.
        assert_eq!(
            resolve_ticket_type(None, &json!({ "channel": "bot" })).unwrap(),
            "conversation"
        );
        assert_eq!(
            resolve_ticket_type(None, &json!({})).unwrap(),
            "conversation"
        );
        assert_eq!(
            resolve_ticket_type(None, &json!({ "channel": 7 })).unwrap(),
            "conversation"
        );
    }

    #[test]
    fn ticket_type_is_allow_listed() {
        assert!(resolve_ticket_type(Some("incident"), &definition()).is_err());
        assert!(resolve_ticket_type(Some(""), &bug_definition()).is_err());
        assert!(resolve_ticket_type(Some("BUGS"), &definition()).is_err());
    }

    #[test]
    fn severity_is_allow_listed_on_a_bug() {
        assert_eq!(
            resolve_severity(Some("blocker"), "bug").unwrap(),
            Some("blocker".to_string())
        );
        assert_eq!(
            resolve_severity(Some("  MAJOR "), "bug").unwrap(),
            Some("major".to_string())
        );
        assert_eq!(
            resolve_severity(Some("minor"), "bug").unwrap(),
            Some("minor".to_string())
        );
        assert!(resolve_severity(Some("p0"), "bug").is_err());
    }

    #[test]
    fn severity_is_none_when_absent_and_rejected_on_a_conversation() {
        assert_eq!(resolve_severity(None, "bug").unwrap(), None);
        assert_eq!(resolve_severity(None, "conversation").unwrap(), None);
        // Blank is indistinguishable from absent, on either type.
        assert_eq!(resolve_severity(Some("   "), "conversation").unwrap(), None);
        // Loud, unlike `bugReport`: severity is a lifecycle claim.
        assert!(resolve_severity(Some("blocker"), "conversation").is_err());
    }

    #[test]
    fn builder_threads_type_and_severity_through() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.ticket_type = Some("bug".into());
        req.severity = Some("Blocker".into());
        let ticket = build_new_ticket(&req, "p", &definition()).unwrap();
        assert_eq!(ticket.ticket_type, "bug");
        assert_eq!(ticket.severity.as_deref(), Some("blocker"));

        // Default posture: no client keys, contact form.
        let ticket = build_new_ticket(
            &request(json!({ "email": "u@example.com" })),
            "p",
            &definition(),
        )
        .unwrap();
        assert_eq!(ticket.ticket_type, "conversation");
        assert_eq!(ticket.severity, None);
        assert_eq!(ticket.bug_report_json, None);
    }

    #[test]
    fn builder_sanitizes_and_stores_a_bug_report_on_a_bug() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.ticket_type = Some("bug".into());
        req.bug_report = Some(json!({
            "capturedAt": "2026-07-25T10:00:00.000Z",
            "environment": { "url": "https://app.test/x?token=leak", "browser": "Chrome" },
            "cookies": "session=abc",
        }));

        let ticket = build_new_ticket(&req, "p", &definition()).unwrap();
        let stored = ticket.bug_report_json.unwrap();
        assert!(stored.contains("Chrome"));
        assert!(!stored.contains("leak"), "{stored}");
        assert!(!stored.contains("cookies"), "{stored}");
    }

    #[test]
    fn a_bug_report_on_a_conversation_is_dropped_not_rejected() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.bug_report = Some(json!({
            "capturedAt": "2026-07-25T10:00:00.000Z",
            "environment": { "url": "https://app.test/x" },
        }));

        // Contact form, no explicit type -> conversation, and the payload is
        // best-effort telemetry so it is silently discarded rather than 400'd.
        let ticket = build_new_ticket(&req, "p", &definition()).unwrap();
        assert_eq!(ticket.ticket_type, "conversation");
        assert_eq!(ticket.bug_report_json, None);

        // Same when a bug-channel form is overridden to a conversation
        // explicitly: the explicit type wins and the payload still drops.
        let mut req = request(json!({}));
        req.ticket_type = Some("conversation".into());
        req.bug_report = Some(json!({ "capturedAt": "2026-07-25T10:00:00.000Z" }));
        let ticket = build_new_ticket(&req, "p", &bug_definition()).unwrap();
        assert_eq!(ticket.ticket_type, "conversation");
        assert_eq!(ticket.bug_report_json, None);
    }

    #[test]
    fn an_unsanitizable_bug_report_leaves_the_column_null() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.ticket_type = Some("bug".into());

        for raw in [json!("nope"), json!([1, 2]), json!({}), json!({ "x": 1 })] {
            req.bug_report = Some(raw.clone());
            let ticket = build_new_ticket(&req, "p", &definition()).unwrap();
            assert_eq!(ticket.bug_report_json, None, "{raw}");
        }
    }

    #[test]
    fn an_oversized_bug_report_is_rejected_by_the_cap() {
        // 20 console entries at the 2000-char message cap blow past 32KB even
        // AFTER sanitizing — the cap is the backstop the SDK's own 24KB budget
        // is meant to keep us away from.
        let entries: Vec<Value> = (0..20)
            .map(|i| {
                json!({
                    "level": "error",
                    "message": format!("{i}{}", "x".repeat(4000)),
                    "timestamp": "2026-07-25T10:00:00.000Z",
                })
            })
            .collect();

        let mut req = request(json!({ "email": "u@example.com" }));
        req.ticket_type = Some("bug".into());
        req.bug_report = Some(json!({ "consoleErrors": entries }));

        let err = build_new_ticket(&req, "p", &definition()).unwrap_err();
        assert!(err.contains("bugReport"), "{err}");
        assert!(err.contains(&MAX_BUG_REPORT_BYTES.to_string()), "{err}");
    }

    #[test]
    fn envelope_accepts_the_phase_56_keys_and_the_snake_case_alias() {
        let raw = br#"{"formId":"01F","distinctId":"u","subject":"s","body":"b",
                       "type":"bug","severity":"major","bugReport":{"capturedAt":"t"}}"#;
        let parsed: CreateTicketRequest = serde_json::from_slice(raw).unwrap();
        assert_eq!(parsed.ticket_type.as_deref(), Some("bug"));
        assert_eq!(parsed.severity.as_deref(), Some("major"));
        assert!(parsed.bug_report.is_some());

        let raw = br#"{"form_id":"01F","distinct_id":"u","subject":"s","body":"b",
                       "bug_report":{"capturedAt":"t"}}"#;
        let parsed: CreateTicketRequest = serde_json::from_slice(raw).unwrap();
        assert!(parsed.bug_report.is_some());

        // `deny_unknown_fields` is still the posture: `ticketType` is not a key.
        let raw =
            br#"{"formId":"01F","distinctId":"u","subject":"s","body":"b","ticketType":"bug"}"#;
        let parsed: Result<CreateTicketRequest, _> = serde_json::from_slice(raw);
        assert!(parsed.is_err());
    }

    #[test]
    fn oversize_context_is_rejected_by_the_builder() {
        let mut req = request(json!({ "email": "u@example.com" }));
        req.context = Some(json!({ "blob": "x".repeat(MAX_CONTEXT_BYTES) }));
        assert!(build_new_ticket(&req, "p", &definition()).is_err());
    }

    // --- presign key derivation -------------------------------------------

    #[test]
    fn ticket_segment_defaults_to_unassigned_and_rejects_traversal() {
        assert_eq!(
            resolve_ticket_segment(None).unwrap(),
            presign::UNASSIGNED_TICKET_SEGMENT
        );
        assert_eq!(resolve_ticket_segment(Some("  ")).unwrap(), "unassigned");
        assert_eq!(
            resolve_ticket_segment(Some("01TICKET")).unwrap(),
            "01TICKET"
        );
        assert!(resolve_ticket_segment(Some("../other")).is_err());
        assert!(resolve_ticket_segment(Some("a/b")).is_err());
    }

    #[test]
    fn presign_envelope_rejects_unknown_keys_and_accepts_aliases() {
        let raw = br#"{"filename":"a.png","content_type":"image/png","size_bytes":10}"#;
        let parsed: PresignRequest = serde_json::from_slice(raw).unwrap();
        assert_eq!(parsed.size_bytes, 10);

        let raw = br#"{"filename":"a.png","contentType":"image/png","sizeBytes":10,"key":"mine"}"#;
        let parsed: Result<PresignRequest, _> = serde_json::from_slice(raw);
        assert!(parsed.is_err(), "client must not choose the storage key");
    }

    // --- response shaping (no internal leakage) ---------------------------

    #[test]
    fn ticket_response_never_exposes_the_token_or_agent_identity() {
        let ticket = store::TicketRow {
            id: "01TICKET".into(),
            project_id: "01PROJECT".into(),
            form_id: "01FORM".into(),
            number: 4821,
            status: "open".into(),
            priority: "normal".into(),
            category: "billing".into(),
            subject: "Cannot log in".into(),
            ticket_type: "conversation".into(),
            token: "super-secret-token".into(),
            created_at: "2026-07-24T10:00:00".into(),
            resolved_at: None,
        };
        let out = ticket_out(
            &ticket,
            vec![MessageOut {
                author_type: "agent".into(),
                body: "looking into it".into(),
                created_at: "2026-07-24T10:05:00".into(),
            }],
        )
        .to_string();

        assert!(!out.contains("super-secret-token"));
        assert!(!out.contains("assignee"));
        assert!(!out.contains("authorUserId"));
        assert!(out.contains("4821"));
        assert!(out.contains("looking into it"));
    }
}
