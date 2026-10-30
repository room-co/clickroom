-- 013_support_events.sql — dedicated support-interaction sink
--
-- The support widget emits `$support_shown` / `$support_opened` / `$support_deflected` /
-- `$support_ticket_created` / `$support_ticket_resolved` / `$support_csat` events carrying
-- `$support_form_id`, `$support_ticket_id`, `$support_category` and `$support_score` in
-- `properties`. These flow through capture-rs → NATS → ingest-rs → `events` unchanged (the capture
-- loop is event-name-agnostic). A ClickHouse MV then forks those rows into this purpose-built
-- table.
--
-- Why a separate table (same reason as 002_flag_events.sql:2-4 and 012_survey_events.sql): the
-- `events` RMT sort key is `(project, toDate(timestamp), event, cityHash64(distinct_id))`, so two
-- interactions from one user on one day under the same `$support_*` event name collapse. Deflection
-- rate (`uniq(deflected)/uniq(opened)`), per-form volume and CSAT need EXACT per-form aggregation,
-- so the sort key here INCLUDES `form_id`. Plain MergeTree; queries dedup at-least-once
-- redeliveries via uniqExact(uuid). Idempotent: safe to re-run — additive only, NOT 008's
-- drop-and-recreate shape.
--
-- Postgres remains the source of truth for tickets themselves (mutable, threaded, assignable).
-- This table is telemetry only: open counts and first-reply medians are ticket-state reads and come
-- from Postgres, not from here.
--
-- NOTE: like every retrofitted MV/MATERIALIZED sink here, this only populates from rows inserted
-- AFTER the migration applies — ClickHouse does not backfill existing parts (same caveat as
-- 009_web_analytics_cols.sql / 011_events_window_id.sql / 012_survey_events.sql). Support metrics
-- scope to "data available from install date."
CREATE TABLE IF NOT EXISTS support_events (
    uuid         UUID,
    project_id   String,
    form_id      String,
    ticket_id    String,
    distinct_id  String,
    -- shown | opened | deflected | ticket_created | ticket_resolved | csat
    interaction  LowCardinality(String),
    category     LowCardinality(String),
    -- CSAT rating, only present on `csat` interactions
    score        Nullable(Int8),
    timestamp    DateTime64(6, 'UTC'),
    created_at   DateTime64(6, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, form_id, toDate(timestamp), cityHash64(distinct_id))
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS support_events_mv TO support_events AS
SELECT
    uuid,
    project_id,
    JSONExtractString(properties, '$support_form_id') AS form_id,
    JSONExtractString(properties, '$support_ticket_id') AS ticket_id,
    distinct_id,
    multiIf(
        event = '$support_shown', 'shown',
        event = '$support_opened', 'opened',
        event = '$support_deflected', 'deflected',
        event = '$support_ticket_created', 'ticket_created',
        event = '$support_ticket_resolved', 'ticket_resolved',
        'csat'
    ) AS interaction,
    JSONExtractString(properties, '$support_category') AS category,
    toInt8OrNull(JSONExtractString(properties, '$support_score')) AS score,
    timestamp
FROM events
WHERE event IN ('$support_shown', '$support_opened', '$support_deflected', '$support_ticket_created', '$support_ticket_resolved', '$support_csat');
