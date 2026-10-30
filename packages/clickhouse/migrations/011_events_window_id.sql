-- 011_events_window_id.sql — window_id materialized column
--
-- Moves the session id to localStorage (origin-wide, shared across every tab of a visit)
-- and reserves sessionStorage for a new per-tab `$window_id`, matching posthog-js. The SDK now
-- attaches `$window_id` beside `$session_id` on every event, so a single visit is
-- one `session_id` with N `window_id`s — one per tab.
--
-- Promote it to a real column following the exact `session_id` (003_events_session.sql) /
-- web-analytics-cols (009_web_analytics_cols.sql) precedent: additive
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, idempotent, safe to re-run. Explicitly NOT the
-- drop-and-recreate shape of 008 — there is real data in `events` now.
--
-- NOTE: like every other retrofitted MATERIALIZED column here, this only populates rows inserted
-- after the migration applies — ClickHouse does not backfill existing parts on ALTER. Every event
-- written before this point reads the column default (empty string). Any future window-based
-- metric (e.g. windows-per-session engagement, explicitly out of scope here) must scope to
-- "data available from install date" and exclude `window_id = ''`, same as the earlier web-analytics columns.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS window_id String MATERIALIZED JSONExtractString(properties, '$window_id');
