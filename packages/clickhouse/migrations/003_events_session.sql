-- 003_events_session.sql — session_id materialized column.
-- The SDK writes `$session_id` into every event's properties (sessionStorage +
-- idle rotation). Materialize it as a real column so the event-detail page can
-- query a true session timeline and count distinct sessions per user.
--
-- NOTE: a MATERIALIZED column added via ALTER is computed on INSERT — existing
-- rows read the column default (empty string) until a `MATERIALIZE COLUMN`
-- mutation runs. New events carry a real id; queries that filter/aggregate on
-- session_id therefore only reflect post-migration data (empty ids excluded).
-- Idempotent: safe to re-run.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS session_id String MATERIALIZED JSONExtractString(properties, '$session_id');
