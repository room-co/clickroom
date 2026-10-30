-- 002_flag_events.sql — dedicated feature-flag-call sink.
-- The events RMT sort key omits the flag key, collapsing multi-flag same-day rows.
-- This table's sort key includes flag_key, so per-flag counts are exact. Plain
-- MergeTree; queries dedup at-least-once redeliveries via uniqExact(uuid).
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS flag_events (
    uuid         UUID,
    project_id   String,
    flag_key     String,
    distinct_id  String,
    response     String,
    timestamp    DateTime64(6, 'UTC'),
    created_at   DateTime64(6, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, toDate(timestamp), flag_key, cityHash64(distinct_id))
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS flag_events_mv TO flag_events AS
SELECT
    uuid,
    project_id,
    JSONExtractString(properties, '$feature_flag') AS flag_key,
    distinct_id,
    JSONExtractString(properties, '$feature_flag_response') AS response,
    timestamp
FROM events
WHERE event = '$feature_flag_called';
