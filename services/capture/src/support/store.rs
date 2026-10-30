//! Every Postgres read/write behind the support endpoints.
//!
//! Runtime `sqlx::query_as` throughout (no compile-time DB / `SQLX_OFFLINE`
//! needed), mirroring `flags/store.rs` and `surveys/store.rs`. Two conventions
//! carried over from those modules:
//!
//! - jsonb columns are read as text (`::text`) and parsed by the caller, so the
//!   service does not need sqlx's `json` feature.
//! - timestamps are read as text for the same reason: sqlx is built without the
//!   `chrono` feature here, so `TIMESTAMP(3)` has no native decoder. They go
//!   through `to_char(...)` rather than a bare `::text` cast, because the cast
//!   yields Postgres' `2026-07-24 17:25:09.337` display form — not something
//!   `new Date(...)` in the widget parses reliably. Prisma stores these columns
//!   in UTC, so the literal `Z` suffix is accurate.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::{state::AppState, support::new_ulid};

/// Process-local TTL in front of the `SupportForm ⋈ FeatureFlag` read, for
/// exactly the reason `surveys/store.rs` documents: the SDK background-polls
/// `/v1/support`, so every live page turns into a periodic query. Only
/// successful reads are cached — an error propagates so the next request
/// retries Postgres instead of serving a cached failure.
const LOCAL_CACHE_TTL: Duration = Duration::from_secs(30);

/// One ACTIVE support form's static config, as read from Postgres.
#[derive(Debug, Clone)]
pub struct SupportFormRow {
    /// Form id (app ULID).
    pub id: String,
    /// The versioned `definition` jsonb, still serialized as text.
    pub definition: String,
    /// Bumped on every edit; the SDK caches config and short-circuits on it.
    pub version: i32,
    /// The linked `FeatureFlag.key` the SDK gates display on.
    pub flag_key: String,
}

struct CacheEntry {
    fetched_at: Instant,
    forms: Arc<Vec<SupportFormRow>>,
}

fn local_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Load every ACTIVE, non-deleted support form for `project_id`: process-local
/// cache (30s TTL) -> Postgres `SupportForm ⋈ FeatureFlag` read.
///
/// Draft and archived forms are excluded server-side so they can never reach
/// the SDK.
pub async fn load_active_forms(
    state: &AppState,
    project_id: &str,
) -> anyhow::Result<Arc<Vec<SupportFormRow>>> {
    // Scope the guard so the std Mutex is never held across the `.await` below.
    {
        if let Some(entry) = local_cache().lock().unwrap().get(project_id) {
            if entry.fetched_at.elapsed() < LOCAL_CACHE_TTL {
                return Ok(entry.forms.clone());
            }
        }
    }

    let forms = Arc::new(query_active_forms(state, project_id).await?);

    local_cache().lock().unwrap().insert(
        project_id.to_string(),
        CacheEntry {
            fetched_at: Instant::now(),
            forms: forms.clone(),
        },
    );

    Ok(forms)
}

/// Raw Postgres read of `project_id`'s ACTIVE forms — the uncached body.
async fn query_active_forms(
    state: &AppState,
    project_id: &str,
) -> anyhow::Result<Vec<SupportFormRow>> {
    let rows: Vec<(String, String, i32, String)> = sqlx::query_as(
        r#"SELECT s."id", s."definition"::text, s."version", f."key" AS flag_key
           FROM "SupportForm" s
           JOIN "FeatureFlag" f ON f."id" = s."featureFlagId"
           WHERE s."projectId" = $1 AND s."status" = 'active' AND s."deletedAt" IS NULL"#,
    )
    .bind(project_id)
    .fetch_all(&state.pg)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, definition, version, flag_key)| SupportFormRow {
            id,
            definition,
            version,
            flag_key,
        })
        .collect())
}

/// Load one ACTIVE form by id, scoped to `project_id`.
///
/// Deliberately **uncached**: this is the read a ticket submission validates
/// against, and validating against a definition up to 30s stale could accept a
/// field the form no longer declares (or reject one it just gained). The
/// config read above can tolerate that window; a write cannot.
///
/// Scoping by `projectId` here is what stops a write key for project A from
/// filing a ticket against project B's form by id.
pub async fn load_active_form(
    state: &AppState,
    project_id: &str,
    form_id: &str,
) -> anyhow::Result<Option<SupportFormRow>> {
    let row: Option<(String, String, i32, String)> = sqlx::query_as(
        r#"SELECT s."id", s."definition"::text, s."version", f."key" AS flag_key
           FROM "SupportForm" s
           JOIN "FeatureFlag" f ON f."id" = s."featureFlagId"
           WHERE s."id" = $1 AND s."projectId" = $2
             AND s."status" = 'active' AND s."deletedAt" IS NULL"#,
    )
    .bind(form_id)
    .bind(project_id)
    .fetch_optional(&state.pg)
    .await?;

    Ok(
        row.map(|(id, definition, version, flag_key)| SupportFormRow {
            id,
            definition,
            version,
            flag_key,
        }),
    )
}

/// Everything needed to create a ticket and its opening message.
#[derive(Debug, Clone)]
pub struct NewTicket {
    pub form_id: String,
    pub project_id: String,
    pub distinct_id: String,
    pub person_id: Option<String>,
    pub priority: String,
    pub category: String,
    pub subject: String,
    /// `conversation` | `bug` — discriminator.
    pub ticket_type: String,
    /// `blocker` | `major` | `minor`. Bug-only; `None` on a conversation.
    pub severity: Option<String>,
    /// Custom field answers, serialized JSON object.
    pub fields_json: String,
    /// Identity / recent events / active flags bundle, serialized JSON object.
    pub context_json: String,
    /// Sanitized bug payload, serialized JSON object. `None` — and therefore a
    /// SQL `NULL` — for conversations and for bugs filed without
    /// `tracking.bugContext`.
    pub bug_report_json: Option<String>,
    /// The opening message body.
    pub body: String,
}

/// The identifiers handed back to the widget after a successful create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedTicket {
    pub id: String,
    pub number: i32,
    /// Opaque read credential; the widget stores it and presents it to
    /// `GET /v1/support/tickets/:id`.
    pub token: String,
}

/// Create the ticket and its first message in ONE transaction.
///
/// The per-project `number` is allocated inside that same transaction, behind a
/// per-project transaction-scoped advisory lock. Without the lock, two
/// concurrent submissions both read the same `MAX(number)` and the second one
/// dies on the `(projectId, number)` unique index — a lost ticket on a public
/// endpoint. The lock is held only for the duration of the insert and is
/// released automatically on commit *or* rollback, so a failed transaction
/// cannot wedge a project's ticket numbering.
pub async fn create_ticket(
    state: &AppState,
    new_ticket: &NewTicket,
    token: &str,
) -> anyhow::Result<CreatedTicket> {
    let ticket_id = new_ulid();
    let message_id = new_ulid();

    let mut tx = state.pg.begin().await?;

    // Serialize number allocation per project (and only per project).
    sqlx::query(r#"SELECT pg_advisory_xact_lock(hashtextextended($1, 53))"#)
        .bind(&new_ticket.project_id)
        .execute(&mut *tx)
        .await?;

    let (number,): (i32,) = sqlx::query_as(
        r#"INSERT INTO "SupportTicket" (
               "id", "formId", "projectId", "number", "distinctId", "personId",
               "status", "priority", "category", "subject", "token",
               "fields", "context", "type", "severity", "bugReport",
               "createdAt", "updatedAt"
           ) VALUES (
               $1, $2, $3,
               (SELECT COALESCE(MAX("number"), 0) + 1
                  FROM "SupportTicket" WHERE "projectId" = $3),
               $4, $5, 'open', $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               $12, $13, $14::jsonb, now(), now()
           )
           RETURNING "number""#,
    )
    .bind(&ticket_id)
    .bind(&new_ticket.form_id)
    .bind(&new_ticket.project_id)
    .bind(&new_ticket.distinct_id)
    .bind(&new_ticket.person_id)
    .bind(&new_ticket.priority)
    .bind(&new_ticket.category)
    .bind(&new_ticket.subject)
    .bind(token)
    .bind(&new_ticket.fields_json)
    .bind(&new_ticket.context_json)
    .bind(&new_ticket.ticket_type)
    .bind(&new_ticket.severity)
    .bind(&new_ticket.bug_report_json)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        r#"INSERT INTO "SupportTicketMessage" ("id", "ticketId", "authorType", "body", "createdAt")
           VALUES ($1, $2, 'user', $3, now())"#,
    )
    .bind(&message_id)
    .bind(&ticket_id)
    .bind(&new_ticket.body)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(CreatedTicket {
        id: ticket_id,
        number,
        token: token.to_string(),
    })
}

/// A ticket as the widget is allowed to see it.
///
/// Note what is **absent**: `assigneeId` and `personId` are never selected, so
/// agent identity cannot leak through this path even by accident.
#[derive(Debug, Clone)]
pub struct TicketRow {
    pub id: String,
    pub project_id: String,
    pub form_id: String,
    pub number: i32,
    pub status: String,
    pub priority: String,
    pub category: String,
    pub subject: String,
    /// `conversation` | `bug`, so the end-user resolve path can stamp
    /// `$support_ticket_type` on `$support_ticket_resolved`.
    pub ticket_type: String,
    /// The stored token, for a constant-time compare against the presented one.
    pub token: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

/// The positional tuple `load_ticket`'s `SELECT` decodes into, in column order:
/// id, projectId, formId, number, status, priority, category, subject, type,
/// token, createdAt, resolvedAt.
type TicketTuple = (
    String,
    String,
    String,
    i32,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

/// Load a ticket by id. Returns `None` when it does not exist.
pub async fn load_ticket(state: &AppState, ticket_id: &str) -> anyhow::Result<Option<TicketRow>> {
    let row: Option<TicketTuple> = sqlx::query_as(
        r#"SELECT "id", "projectId", "formId", "number", "status", "priority",
                  "category", "subject", "type", "token",
                  to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  to_char("resolvedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           FROM "SupportTicket" WHERE "id" = $1"#,
    )
    .bind(ticket_id)
    .fetch_optional(&state.pg)
    .await?;

    Ok(row.map(
        |(
            id,
            project_id,
            form_id,
            number,
            status,
            priority,
            category,
            subject,
            ticket_type,
            token,
            created_at,
            resolved_at,
        )| TicketRow {
            id,
            project_id,
            form_id,
            number,
            status,
            priority,
            category,
            subject,
            ticket_type,
            token,
            created_at,
            resolved_at,
        },
    ))
}

/// One row of the identified user's ticket list (the widget's 2a "My
/// tickets" history). A summary — enough to render the list and its 2c unread
/// badge without opening each thread — plus a cheap snippet of the newest
/// end-user-visible message so the list can preview the latest activity.
///
/// Deliberately absent, exactly as [`TicketRow`]: `token`, `assigneeId` and
/// `personId`. The list is project + distinctId scoped, never token scoped, so
/// it must not carry a credential.
#[derive(Debug, Clone)]
pub struct TicketSummaryRow {
    pub id: String,
    pub number: i32,
    pub form_id: String,
    pub status: String,
    pub category: String,
    pub subject: String,
    /// `'conversation' | 'bug'` — discriminator, so the widget's
    /// ONE thread list can chip a bug row without forking the list.
    pub ticket_type: String,
    pub unread_for_user: i32,
    pub created_at: String,
    pub updated_at: String,
    /// Newest allow-listed message body, truncated. `None` when the ticket has
    /// no end-user-visible message yet.
    pub last_message: Option<String>,
    /// The `authorType` of `last_message`, so the list can badge "you" vs an
    /// agent/ai reply. `None` iff `last_message` is `None`.
    pub last_message_author_type: Option<String>,
}

/// The positional tuple `list_tickets_for_user`'s `SELECT` decodes into, in
/// column order: id, number, formId, status, category, subject, type,
/// unreadForUser, createdAt, updatedAt, lastMessageBody, lastMessageAuthorType.
type TicketSummaryTuple = (
    String,
    i32,
    String,
    String,
    String,
    String,
    String,
    i32,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// How many chars of the newest message ride along as the list preview. A
/// snippet, not the whole body — the widget lazy-loads the full thread.
const SNIPPET_CHARS: i32 = 280;

/// Cap on how many of the user's tickets the list returns, newest-activity
/// first. A returning user only ever needs their recent threads; an unbounded
/// list would grow with every ticket they ever filed.
const LIST_LIMIT: i64 = 20;

/// List the identified user's own tickets in `project_id`, newest-activity
/// first, capped at [`LIST_LIMIT`].
///
/// STRICTLY scoped to `(project_id, distinct_id)`: the `projectId` comes from
/// the authenticated write key and the `distinctId` from the query, so a widget
/// for project A can never see project B's tickets and distinct id X can never
/// see distinct id Y's — the cross-tenant / cross-user mirror of the per-ticket
/// token isolation `authorized_ticket` enforces.
///
/// The newest end-user-visible message is joined in via a `LATERAL` subquery
/// using the same author-type allow-list as [`load_public_messages`], so the
/// preview is drawn from exactly the messages the widget could open.
pub async fn list_tickets_for_user(
    state: &AppState,
    project_id: &str,
    distinct_id: &str,
) -> anyhow::Result<Vec<TicketSummaryRow>> {
    let rows: Vec<TicketSummaryTuple> = sqlx::query_as(
        r#"SELECT t."id", t."number", t."formId", t."status", t."category", t."subject",
                  t."type", t."unreadForUser",
                  to_char(t."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  to_char(t."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  left(m."body", $3), m."authorType"
           FROM "SupportTicket" t
           LEFT JOIN LATERAL (
               SELECT "body", "authorType"
               FROM "SupportTicketMessage"
               WHERE "ticketId" = t."id"
                 AND "authorType" IN ('user', 'agent', 'ai', 'system')
               ORDER BY "createdAt" DESC, "id" DESC
               LIMIT 1
           ) m ON true
           WHERE t."projectId" = $1 AND t."distinctId" = $2
           ORDER BY t."updatedAt" DESC, t."id" DESC
           LIMIT $4"#,
    )
    .bind(project_id)
    .bind(distinct_id)
    .bind(SNIPPET_CHARS)
    .bind(LIST_LIMIT)
    .fetch_all(&state.pg)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                number,
                form_id,
                status,
                category,
                subject,
                ticket_type,
                unread_for_user,
                created_at,
                updated_at,
                last_message,
                last_message_author_type,
            )| TicketSummaryRow {
                id,
                number,
                form_id,
                status,
                category,
                subject,
                ticket_type,
                unread_for_user,
                created_at,
                updated_at,
                last_message,
                last_message_author_type,
            },
        )
        .collect())
}

/// One message in the end-user-visible thread.
#[derive(Debug, Clone)]
pub struct ThreadMessage {
    pub author_type: String,
    pub body: String,
    pub created_at: String,
}

/// Load the end-user-visible thread for a ticket.
///
/// The `authorType` filter is an explicit **allow-list**, not a deny-list of
/// today's internal kinds: any author type added later (internal notes being
/// the obvious one) is invisible to the widget by default rather than leaking
/// until someone remembers to exclude it. `authorUserId` is never selected.
///
/// The list is `user`, `agent`, `ai`, and `system`: `ai` messages are a
/// first-class part of the end-user thread — an AI-drafted reply is shown to the
/// widget exactly as a human agent reply is — so it is on the allow-list, while
/// internal notes and any future internal kind stay invisible by default.
pub async fn load_public_messages(
    state: &AppState,
    ticket_id: &str,
) -> anyhow::Result<Vec<ThreadMessage>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        r#"SELECT "authorType", "body",
                  to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           FROM "SupportTicketMessage"
           WHERE "ticketId" = $1 AND "authorType" IN ('user', 'agent', 'ai', 'system')
           ORDER BY "createdAt" ASC, "id" ASC"#,
    )
    .bind(ticket_id)
    .fetch_all(&state.pg)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(author_type, body, created_at)| ThreadMessage {
            author_type,
            body,
            created_at,
        })
        .collect())
}

/// Append an end-user follow-up message and reopen the ticket if it had been
/// resolved or closed, in one transaction.
///
/// Returns the ticket's status after the append.
pub async fn append_user_message(
    state: &AppState,
    ticket_id: &str,
    body: &str,
) -> anyhow::Result<String> {
    let message_id = new_ulid();
    let mut tx = state.pg.begin().await?;

    sqlx::query(
        r#"INSERT INTO "SupportTicketMessage" ("id", "ticketId", "authorType", "body", "createdAt")
           VALUES ($1, $2, 'user', $3, now())"#,
    )
    .bind(&message_id)
    .bind(ticket_id)
    .bind(body)
    .execute(&mut *tx)
    .await?;

    // Reopening is done in SQL rather than read-modify-write so a concurrent
    // agent resolve cannot land between the read and the write. `unreadForAgent`
    // is incremented in the same statement: the end user just wrote, so
    // the agent side gains one unread — bumped here, inside the same transaction
    // as the message insert, so a reply can never appear without its unread
    // count moving.
    let (status,): (String,) = sqlx::query_as(
        r#"UPDATE "SupportTicket"
           SET "status" = CASE WHEN "status" IN ('resolved', 'closed') THEN 'open' ELSE "status" END,
               "resolvedAt" = CASE WHEN "status" IN ('resolved', 'closed') THEN NULL ELSE "resolvedAt" END,
               "unreadForAgent" = "unreadForAgent" + 1,
               "updatedAt" = now()
           WHERE "id" = $1
           RETURNING "status""#,
    )
    .bind(ticket_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(status)
}

/// Clear the end-user's unread counter for a ticket.
///
/// Called when the widget reads its own thread over the token-scoped
/// `GET /v1/support/tickets/:id`: the user has now seen everything, so
/// `unreadForUser` drops to 0. `updatedAt` is deliberately **not** touched — a
/// read is not a thread change, and the SSE refetch-ping keys off message
/// activity, not `updatedAt`, so clearing an unread badge must not itself look
/// like a new event.
pub async fn clear_unread_for_user(state: &AppState, ticket_id: &str) -> anyhow::Result<()> {
    sqlx::query(r#"UPDATE "SupportTicket" SET "unreadForUser" = 0 WHERE "id" = $1"#)
        .bind(ticket_id)
        .execute(&state.pg)
        .await?;
    Ok(())
}

/// Mark a ticket solved on the end user's own initiative.
///
/// The token-scoped mirror of the agent-side `setStatus('resolved')`: it stamps
/// the terminal state and `resolvedAt` the same way the reopen CASE in
/// [`append_user_message`] clears them. `resolvedAt` is only stamped when the
/// ticket is not already terminal, so a user re-solving an already-resolved
/// ticket does not move the resolution time. Returns the status after the write.
pub async fn mark_ticket_solved(state: &AppState, ticket_id: &str) -> anyhow::Result<String> {
    let (status,): (String,) = sqlx::query_as(
        r#"UPDATE "SupportTicket"
           SET "status" = 'resolved',
               "resolvedAt" = CASE
                   WHEN "status" IN ('resolved', 'closed') THEN "resolvedAt"
                   ELSE now()
               END,
               "updatedAt" = now()
           WHERE "id" = $1
           RETURNING "status""#,
    )
    .bind(ticket_id)
    .fetch_one(&state.pg)
    .await?;
    Ok(status)
}

/// The public-thread activity signature for a ticket: the count of
/// end-user-visible messages and the newest such message's timestamp.
///
/// The SSE stream (`support/stream.rs`) polls this on an interval and emits a
/// "thread changed, refetch" ping whenever it advances. Both fields move only
/// on a new allow-listed message, so a badge-clearing `unreadForUser` write or
/// an internal note never registers as activity. The allow-list mirrors
/// [`load_public_messages`] exactly, so the widget is pinged for precisely the
/// messages it can then read.
pub async fn load_thread_signature(
    state: &AppState,
    ticket_id: &str,
) -> anyhow::Result<(i64, Option<String>)> {
    let row: (i64, Option<String>) = sqlx::query_as(
        r#"SELECT COUNT(*),
                  to_char(MAX("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           FROM "SupportTicketMessage"
           WHERE "ticketId" = $1 AND "authorType" IN ('user', 'agent', 'ai', 'system')"#,
    )
    .bind(ticket_id)
    .fetch_one(&state.pg)
    .await?;
    Ok(row)
}

/// Insert a `pending` `SupportWebhookDelivery` row for every active webhook in
/// the project subscribed to `event`, and return the new delivery ids.
///
/// The row is the durable record — `services/ingest`'s worker sweeps
/// `status='pending' AND nextAttemptAt <= now()` — so this must succeed for the
/// webhook to be guaranteed. The NATS notification the caller publishes
/// afterwards only makes the first attempt prompt.
///
/// A webhook with an empty `events` array is treated as subscribed to
/// everything, matching the "no filter configured" reading of the column's
/// `DEFAULT ARRAY[]::TEXT[]`.
pub async fn enqueue_webhook_deliveries(
    state: &AppState,
    project_id: &str,
    ticket_id: &str,
    event: &str,
    payload_json: &str,
) -> anyhow::Result<Vec<String>> {
    let webhook_ids = subscribed_webhook_ids(state, project_id, event).await?;
    let mut delivery_ids = Vec::with_capacity(webhook_ids.len());

    for webhook_id in webhook_ids {
        let delivery_id = new_ulid();
        sqlx::query(
            r#"INSERT INTO "SupportWebhookDelivery" (
                   "id", "webhookId", "ticketId", "event", "payload", "status",
                   "attempts", "nextAttemptAt", "createdAt", "updatedAt"
               ) VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, now(), now(), now())"#,
        )
        .bind(&delivery_id)
        .bind(&webhook_id)
        .bind(ticket_id)
        .bind(event)
        .bind(payload_json)
        .execute(&state.pg)
        .await?;
        delivery_ids.push(delivery_id);
    }

    Ok(delivery_ids)
}

/// Active, non-deleted webhooks in the project subscribed to `event`.
async fn subscribed_webhook_ids(
    state: &AppState,
    project_id: &str,
    event: &str,
) -> anyhow::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"SELECT "id" FROM "SupportWebhook"
           WHERE "projectId" = $1 AND "active" = true AND "deletedAt" IS NULL
             AND ($2 = ANY("events") OR COALESCE(cardinality("events"), 0) = 0)"#,
    )
    .bind(project_id)
    .bind(event)
    .fetch_all(&state.pg)
    .await?;

    Ok(rows.into_iter().map(|(id,)| id).collect())
}

#[cfg(test)]
mod db_tests {
    //! Live-Postgres integration tests for the store writes.
    //!
    //! These hit the same dev infra the rest of the crate's integration tests
    //! assume (`make infra:up`): a real Postgres (`DATABASE_URL`), plus Redis and
    //! NATS only because [`AppState`] bundles their handles — the writes under
    //! test touch Postgres alone. Each test seeds its own FK chain under freshly
    //! minted ULIDs and tears it down, so runs never collide.

    use std::sync::Arc;

    use super::*;
    use crate::{
        auth::ResolvedKey,
        error::ApiError,
        support::{endpoint::authorized_ticket, new_ticket_token, new_ulid},
    };

    /// Build an [`AppState`] against the local dev infra. Panics with a pointed
    /// message if it cannot connect — same posture as `quota.rs`'s Redis helper.
    async fn test_state() -> AppState {
        let _ = dotenvy::dotenv();
        let config = crate::config::Config::from_env()
            .expect("Config::from_env (is repo-root .env present / `make infra:up` running?)");
        let pg = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&config.database_url)
            .await
            .expect("connect to test Postgres (is `make infra:up` running?)");
        let redis_client = redis::Client::open(config.redis_url.clone()).expect("valid REDIS_URL");
        let redis = redis::aio::ConnectionManager::new(redis_client)
            .await
            .expect("connect to test Redis");
        let nats_client = async_nats::connect(&config.nats_url)
            .await
            .expect("connect to test NATS");
        let jetstream = async_nats::jetstream::new(nats_client.clone());
        AppState {
            pg,
            redis,
            jetstream,
            nats_core: nats_client,
            config: Arc::new(config),
            nats_publish_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    /// The ids a seeded ticket hangs off of, so a test can reference the project
    /// and clean up afterward.
    struct Seed {
        org_id: String,
        project_id: String,
        form_id: String,
    }

    /// Seed the full Org -> Project -> Environment -> FeatureFlag -> SupportForm
    /// chain a `SupportTicket` requires.
    async fn seed_form(pg: &sqlx::PgPool) -> Seed {
        let org_id = new_ulid();
        let project_id = new_ulid();
        let env_id = new_ulid();
        let flag_id = new_ulid();
        let form_id = new_ulid();
        let slug = format!("t54-{}", new_ulid().to_lowercase());

        sqlx::query(
            r#"INSERT INTO "Org" ("id","name","slug","updatedAt") VALUES ($1,$2,$3,now())"#,
        )
        .bind(&org_id)
        .bind("T54 Test Org")
        .bind(&slug)
        .execute(pg)
        .await
        .expect("seed Org");

        sqlx::query(
            r#"INSERT INTO "Project" ("id","orgId","name","updatedAt") VALUES ($1,$2,$3,now())"#,
        )
        .bind(&project_id)
        .bind(&org_id)
        .bind("T54 Project")
        .execute(pg)
        .await
        .expect("seed Project");

        sqlx::query(
            r#"INSERT INTO "Environment" ("id","projectId","key","name","isDefault")
               VALUES ($1,$2,'production','Production',true)"#,
        )
        .bind(&env_id)
        .bind(&project_id)
        .execute(pg)
        .await
        .expect("seed Environment");

        sqlx::query(
            r#"INSERT INTO "FeatureFlag"
                 ("id","projectId","key","environmentId","filters","updatedAt")
               VALUES ($1,$2,$3,$4,'{}'::jsonb,now())"#,
        )
        .bind(&flag_id)
        .bind(&project_id)
        .bind(format!("support-{}", form_id.to_lowercase()))
        .bind(&env_id)
        .execute(pg)
        .await
        .expect("seed FeatureFlag");

        sqlx::query(
            r#"INSERT INTO "SupportForm"
                 ("id","projectId","name","status","definition","featureFlagId","createdBy","updatedAt")
               VALUES ($1,$2,'T54 Form','active','{}'::jsonb,$3,'seed',now())"#,
        )
        .bind(&form_id)
        .bind(&project_id)
        .bind(&flag_id)
        .execute(pg)
        .await
        .expect("seed SupportForm");

        Seed {
            org_id,
            project_id,
            form_id,
        }
    }

    /// Insert one `SupportTicket` and return its id + read token.
    async fn seed_ticket(
        pg: &sqlx::PgPool,
        seed: &Seed,
        number: i32,
        status: &str,
        unread_for_user: i32,
        unread_for_agent: i32,
    ) -> (String, String) {
        let ticket_id = new_ulid();
        let token = new_ticket_token();
        sqlx::query(
            r#"INSERT INTO "SupportTicket"
                 ("id","formId","projectId","number","distinctId","status","priority",
                  "category","subject","token","fields","context",
                  "unreadForUser","unreadForAgent","updatedAt")
               VALUES ($1,$2,$3,$4,'user-1',$5,'normal','general','Subject',$6,
                       '{}'::jsonb,'{}'::jsonb,$7,$8,now())"#,
        )
        .bind(&ticket_id)
        .bind(&seed.form_id)
        .bind(&seed.project_id)
        .bind(number)
        .bind(status)
        .bind(&token)
        .bind(unread_for_user)
        .bind(unread_for_agent)
        .execute(pg)
        .await
        .expect("seed SupportTicket");
        (ticket_id, token)
    }

    /// Insert one `SupportTicket` for an arbitrary distinct id (the default
    /// [`seed_ticket`] hardcodes `user-1`). Returns the ticket id.
    async fn seed_ticket_for(
        pg: &sqlx::PgPool,
        seed: &Seed,
        number: i32,
        distinct_id: &str,
        unread_for_user: i32,
    ) -> String {
        let ticket_id = new_ulid();
        let token = new_ticket_token();
        sqlx::query(
            r#"INSERT INTO "SupportTicket"
                 ("id","formId","projectId","number","distinctId","status","priority",
                  "category","subject","token","fields","context",
                  "unreadForUser","unreadForAgent","updatedAt")
               VALUES ($1,$2,$3,$4,$5,'open','normal','general','Subject',$6,
                       '{}'::jsonb,'{}'::jsonb,$7,0,now())"#,
        )
        .bind(&ticket_id)
        .bind(&seed.form_id)
        .bind(&seed.project_id)
        .bind(number)
        .bind(distinct_id)
        .bind(&token)
        .bind(unread_for_user)
        .execute(pg)
        .await
        .expect("seed SupportTicket");
        ticket_id
    }

    /// Insert one message of the given author type.
    async fn seed_message(pg: &sqlx::PgPool, ticket_id: &str, author_type: &str, body: &str) {
        sqlx::query(
            r#"INSERT INTO "SupportTicketMessage" ("id","ticketId","authorType","body","createdAt")
               VALUES ($1,$2,$3,$4,now())"#,
        )
        .bind(new_ulid())
        .bind(ticket_id)
        .bind(author_type)
        .bind(body)
        .execute(pg)
        .await
        .expect("seed SupportTicketMessage");
    }

    /// Best-effort teardown in reverse-FK order.
    async fn cleanup(pg: &sqlx::PgPool, seed: &Seed) {
        for stmt in [
            r#"DELETE FROM "SupportTicketMessage" WHERE "ticketId" IN
                 (SELECT "id" FROM "SupportTicket" WHERE "projectId" = $1)"#,
            r#"DELETE FROM "SupportTicket" WHERE "projectId" = $1"#,
            r#"DELETE FROM "SupportForm" WHERE "projectId" = $1"#,
            r#"DELETE FROM "FeatureFlag" WHERE "projectId" = $1"#,
            r#"DELETE FROM "Environment" WHERE "projectId" = $1"#,
            r#"DELETE FROM "Project" WHERE "id" = $1"#,
        ] {
            let _ = sqlx::query(stmt).bind(&seed.project_id).execute(pg).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "Org" WHERE "id" = $1"#)
            .bind(&seed.org_id)
            .execute(pg)
            .await;
    }

    #[tokio::test]
    async fn allow_list_read_includes_ai_and_excludes_internal() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 1, "open", 0, 0).await;

        seed_message(&state.pg, &ticket_id, "user", "hi").await;
        seed_message(&state.pg, &ticket_id, "agent", "human reply").await;
        seed_message(&state.pg, &ticket_id, "ai", "ai reply").await;
        seed_message(&state.pg, &ticket_id, "system", "reopened").await;
        // An internal kind that must stay invisible to the widget.
        seed_message(&state.pg, &ticket_id, "note", "internal only").await;

        let msgs = load_public_messages(&state, &ticket_id).await.unwrap();
        let kinds: Vec<&str> = msgs.iter().map(|m| m.author_type.as_str()).collect();

        assert!(
            kinds.contains(&"ai"),
            "ai messages must be visible: {kinds:?}"
        );
        assert!(
            !kinds.contains(&"note"),
            "internal notes must stay hidden: {kinds:?}"
        );
        assert_eq!(msgs.len(), 4, "user+agent+ai+system only");

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn append_user_message_bumps_unread_for_agent() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 2, "open", 0, 0).await;

        let status = append_user_message(&state, &ticket_id, "follow up")
            .await
            .unwrap();
        assert_eq!(status, "open");

        let (unread,): (i32,) =
            sqlx::query_as(r#"SELECT "unreadForAgent" FROM "SupportTicket" WHERE "id" = $1"#)
                .bind(&ticket_id)
                .fetch_one(&state.pg)
                .await
                .unwrap();
        assert_eq!(unread, 1, "an end-user reply must bump unreadForAgent");

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn append_user_message_reopens_and_still_bumps() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 3, "resolved", 0, 5).await;

        let status = append_user_message(&state, &ticket_id, "actually still broken")
            .await
            .unwrap();
        assert_eq!(status, "open", "a resolved ticket reopens on a user reply");

        let (unread, resolved_at): (i32, Option<String>) = sqlx::query_as(
            r#"SELECT "unreadForAgent",
                      to_char("resolvedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM "SupportTicket" WHERE "id" = $1"#,
        )
        .bind(&ticket_id)
        .fetch_one(&state.pg)
        .await
        .unwrap();
        assert_eq!(unread, 6, "reopen still increments unreadForAgent");
        assert!(resolved_at.is_none(), "reopen clears resolvedAt");

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn thread_read_clears_unread_for_user() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 4, "open", 3, 0).await;

        clear_unread_for_user(&state, &ticket_id).await.unwrap();

        let (unread,): (i32,) =
            sqlx::query_as(r#"SELECT "unreadForUser" FROM "SupportTicket" WHERE "id" = $1"#)
                .bind(&ticket_id)
                .fetch_one(&state.pg)
                .await
                .unwrap();
        assert_eq!(
            unread, 0,
            "reading the thread clears the user's unread badge"
        );

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn mark_solved_sets_terminal_state_and_stamps_resolved_at() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 5, "open", 0, 0).await;

        let status = mark_ticket_solved(&state, &ticket_id).await.unwrap();
        assert_eq!(status, "resolved");

        let (status, resolved_at): (String, Option<String>) = sqlx::query_as(
            r#"SELECT "status",
                      to_char("resolvedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM "SupportTicket" WHERE "id" = $1"#,
        )
        .bind(&ticket_id)
        .fetch_one(&state.pg)
        .await
        .unwrap();
        assert_eq!(status, "resolved");
        assert!(resolved_at.is_some(), "solving stamps resolvedAt");

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn thread_signature_advances_on_new_public_message_only() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_id, _token) = seed_ticket(&state.pg, &seed, 6, "open", 0, 0).await;

        let before = load_thread_signature(&state, &ticket_id).await.unwrap();
        assert_eq!(before.0, 0);

        seed_message(&state.pg, &ticket_id, "agent", "ping").await;
        let after_agent = load_thread_signature(&state, &ticket_id).await.unwrap();
        assert_eq!(after_agent.0, 1, "an agent reply advances the signature");
        assert_ne!(after_agent, before);

        // An internal note must NOT advance the signature (no false refetch ping).
        seed_message(&state.pg, &ticket_id, "note", "internal").await;
        let after_note = load_thread_signature(&state, &ticket_id).await.unwrap();
        assert_eq!(after_note, after_agent, "internal notes are not activity");

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn list_for_user_returns_only_that_distinct_ids_tickets() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        // Two tickets for alice, one for bob, all in the same project.
        let a1 = seed_ticket_for(&state.pg, &seed, 1, "alice", 0).await;
        let a2 = seed_ticket_for(&state.pg, &seed, 2, "alice", 0).await;
        let _b1 = seed_ticket_for(&state.pg, &seed, 3, "bob", 0).await;

        let rows = list_tickets_for_user(&state, &seed.project_id, "alice")
            .await
            .unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();

        assert_eq!(rows.len(), 2, "only alice's two tickets: {ids:?}");
        assert!(ids.contains(&a1.as_str()) && ids.contains(&a2.as_str()));

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn list_for_user_is_disjoint_across_distinct_ids() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let alice = seed_ticket_for(&state.pg, &seed, 1, "alice", 0).await;
        let bob = seed_ticket_for(&state.pg, &seed, 2, "bob", 0).await;

        let alice_rows = list_tickets_for_user(&state, &seed.project_id, "alice")
            .await
            .unwrap();
        let bob_rows = list_tickets_for_user(&state, &seed.project_id, "bob")
            .await
            .unwrap();

        assert_eq!(alice_rows.len(), 1);
        assert_eq!(alice_rows[0].id, alice);
        assert_eq!(bob_rows.len(), 1);
        assert_eq!(bob_rows[0].id, bob);
        // Bob's list must never surface alice's ticket, and vice versa.
        assert!(bob_rows.iter().all(|r| r.id != alice));
        assert!(alice_rows.iter().all(|r| r.id != bob));

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn list_for_user_never_crosses_the_project_boundary() {
        let state = test_state().await;
        let project_a = seed_form(&state.pg).await;
        let project_b = seed_form(&state.pg).await;
        // Same distinct id filed a ticket in EACH project.
        let in_a = seed_ticket_for(&state.pg, &project_a, 1, "alice", 0).await;
        let _in_b = seed_ticket_for(&state.pg, &project_b, 1, "alice", 0).await;

        let a_rows = list_tickets_for_user(&state, &project_a.project_id, "alice")
            .await
            .unwrap();
        assert_eq!(a_rows.len(), 1, "project A sees only its own ticket");
        assert_eq!(a_rows[0].id, in_a);

        // A project with no tickets for this user sees nothing.
        let unrelated = list_tickets_for_user(&state, &new_ulid(), "alice")
            .await
            .unwrap();
        assert!(unrelated.is_empty());

        cleanup(&state.pg, &project_a).await;
        cleanup(&state.pg, &project_b).await;
    }

    #[tokio::test]
    async fn list_for_user_includes_unread_and_last_message_snippet() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let ticket = seed_ticket_for(&state.pg, &seed, 1, "alice", 3).await;
        seed_message(&state.pg, &ticket, "user", "first").await;
        seed_message(&state.pg, &ticket, "agent", "latest reply").await;
        // An internal note must NOT become the previewed snippet.
        seed_message(&state.pg, &ticket, "note", "internal only").await;

        let rows = list_tickets_for_user(&state, &seed.project_id, "alice")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.unread_for_user, 3, "unreadForUser is on the row");
        assert_eq!(
            row.last_message.as_deref(),
            Some("latest reply"),
            "snippet is the newest allow-listed message, not the internal note"
        );
        assert_eq!(row.last_message_author_type.as_deref(), Some("agent"));

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn list_for_user_carries_the_ticket_type() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let convo = seed_ticket_for(&state.pg, &seed, 1, "alice", 0).await;
        let bug = seed_ticket_for(&state.pg, &seed, 2, "alice", 0).await;
        sqlx::query(r#"UPDATE "SupportTicket" SET "type" = 'bug' WHERE "id" = $1"#)
            .bind(&bug)
            .execute(&state.pg)
            .await
            .expect("mark ticket as a bug");

        let rows = list_tickets_for_user(&state, &seed.project_id, "alice")
            .await
            .unwrap();
        let type_of = |id: &str| {
            rows.iter()
                .find(|r| r.id == id)
                .map(|r| r.ticket_type.clone())
        };

        // The end-user list stays ONE list; the row just carries the discriminator.
        assert_eq!(rows.len(), 2);
        assert_eq!(type_of(&bug).as_deref(), Some("bug"));
        assert_eq!(
            type_of(&convo).as_deref(),
            Some("conversation"),
            "the column default rides through untouched"
        );

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn cross_ticket_token_cannot_read_another_ticket() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_a, token_a) = seed_ticket(&state.pg, &seed, 7, "open", 0, 0).await;
        let (_ticket_b, token_b) = seed_ticket(&state.pg, &seed, 8, "open", 0, 0).await;

        let resolved = ResolvedKey {
            project_id: seed.project_id.clone(),
            env: "production".into(),
            org_id: seed.org_id.clone(),
        };

        // The correct token reads ticket A.
        assert!(
            authorized_ticket(&state, &resolved, &ticket_a, Some(&token_a))
                .await
                .is_ok()
        );
        // Ticket B's token must NOT unlock ticket A.
        let wrong = authorized_ticket(&state, &resolved, &ticket_a, Some(&token_b)).await;
        assert!(matches!(wrong, Err(ApiError::Unauthorized)));
        // An anonymous caller (no token) is likewise refused.
        let anon = authorized_ticket(&state, &resolved, &ticket_a, None).await;
        assert!(matches!(anon, Err(ApiError::Unauthorized)));

        cleanup(&state.pg, &seed).await;
    }

    #[tokio::test]
    async fn cross_project_key_cannot_read_ticket() {
        let state = test_state().await;
        let seed = seed_form(&state.pg).await;
        let (ticket_a, token_a) = seed_ticket(&state.pg, &seed, 9, "open", 0, 0).await;

        // A write key resolved to a DIFFERENT project, even with the right ticket
        // token, must not read across the tenant boundary.
        let other_project = ResolvedKey {
            project_id: new_ulid(),
            env: "production".into(),
            org_id: seed.org_id.clone(),
        };
        let cross = authorized_ticket(&state, &other_project, &ticket_a, Some(&token_a)).await;
        assert!(matches!(cross, Err(ApiError::Unauthorized)));

        cleanup(&state.pg, &seed).await;
    }
}
