-- 004_person_distinct_ids.sql — identity mapping table.
-- Many `distinct_id` rows resolve to one `person_id`; `events`/`flag_events` are never rewritten —
-- identity resolution happens at query time via `LEFT JOIN ... coalesce(person_id, distinct_id)`
-- (mirrors PostHog's `person_distinct_id` table). `person_id` is always a freshly minted UUIDv7,
-- never a pre-existing `distinct_id`, so merges never collide with a real id. Populated by
-- ingest-rs on `$identify` events carrying `properties.$anon_distinct_id` 
-- (see ingest-rs `identity.rs` for the merge-policy branches).
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS person_distinct_ids (
    project_id  String,
    distinct_id String,
    person_id   String,          -- fresh UUIDv7, never a real distinct_id
    created_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (project_id, distinct_id)
SETTINGS index_granularity = 8192;
