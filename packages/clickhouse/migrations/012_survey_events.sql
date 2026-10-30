-- 012_survey_events.sql — dedicated survey-interaction sink
--
-- The client emits `$survey_shown` / `$survey_dismissed` / `$survey_sent` events carrying
-- `$survey_id`, `$survey_question_id` and `$survey_response` in `properties`. These flow through
-- capture-rs → NATS → ingest-rs → `events` unchanged (the capture loop is event-name-agnostic). A
-- ClickHouse MV then forks those rows into this purpose-built table.
--
-- Why a separate table (same reason as 002_flag_events.sql:2-4): the `events` RMT sort key is
-- `(project, toDate(timestamp), event, cityHash64(distinct_id))`, so two responses from one user on
-- one day to the same `$survey_*` event name collapse. Survey response-rate
-- (`uniq(responded)/uniq(shown)`) and CSAT/CES/NPS scoring need EXACT per-survey aggregation, so
-- the sort key here includes `survey_id`. Plain MergeTree; queries dedup at-least-once
-- redeliveries via uniqExact(uuid). Idempotent: safe to re-run — additive only, NOT 008's
-- drop-and-recreate shape.
--
-- NOTE: like every retrofitted MV/MATERIALIZED sink here, this only populates from rows inserted
-- AFTER the migration applies — ClickHouse does not backfill existing parts (same caveat as
-- 009_web_analytics_cols.sql / 011_events_window_id.sql). Survey metrics scope to "data available
-- from install date."
CREATE TABLE IF NOT EXISTS survey_events (
    uuid         UUID,
    project_id   String,
    survey_id    String,
    distinct_id  String,
    interaction  LowCardinality(String),          -- shown | dismissed | sent
    question_id  String,
    response     String,
    timestamp    DateTime64(6, 'UTC'),
    created_at   DateTime64(6, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, survey_id, toDate(timestamp), cityHash64(distinct_id))
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS survey_events_mv TO survey_events AS
SELECT
    uuid,
    project_id,
    JSONExtractString(properties, '$survey_id') AS survey_id,
    distinct_id,
    multiIf(
        event = '$survey_shown', 'shown',
        event = '$survey_dismissed', 'dismissed',
        'sent'
    ) AS interaction,
    JSONExtractString(properties, '$survey_question_id') AS question_id,
    JSONExtractString(properties, '$survey_response') AS response,
    timestamp
FROM events
WHERE event IN ('$survey_shown', '$survey_dismissed', '$survey_sent');
