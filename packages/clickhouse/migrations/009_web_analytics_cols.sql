-- 009_web_analytics_cols.sql — Web Analytics dashboard columns
--
-- The Web Analytics page needs referrer/channel/UTM/device/path breakdowns as plain column scans
-- instead of per-query JSONExtractString walks over `properties`. The SDK (31.2) computes
-- referring-domain/channel/UTM once at capture time and ships them as top-level `$`-prefixed
-- properties (device/browser/os are already captured); this migration promotes
-- all of them to real MATERIALIZED columns, following the exact `session_id`
-- (003_events_session.sql) / `schema_valid` (006_events_schema_validation.sql) precedent:
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, idempotent, safe to re-run.
--
-- `path`/`host` reference the existing `current_url` MATERIALIZED column (from 001_events.sql)
-- rather than re-deriving `$current_url` from `properties` themselves. ClickHouse computes a
-- table's MATERIALIZED columns in column-definition order at INSERT time, and `current_url`
-- already exists as a real column on `events` before this ALTER runs, so it's a valid input to a
-- new MATERIALIZED expression — no different from any other column reference. (No existing
-- migration in this repo chains one MATERIALIZED column off another, since session_id/schema_valid
-- both read straight from `properties`, but nothing about CH's column-order evaluation model rules
-- it out — only forward references, i.e. a column depending on one defined *after* it, are
-- unsupported.)
--
-- NOTE: like every other retrofitted MATERIALIZED column here, these only populate rows inserted
-- after this migration applies — ClickHouse doesn't backfill existing parts on ALTER. The page
-- surfaces this as "data available from install date."
--
-- Does NOT add a `country`/geo column — deferred (needs ingest-time IP→geo enrichment,
-- not just a properties re-shuffle).
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS referring_domain String MATERIALIZED domain(JSONExtractString(properties, '$referrer')),
    ADD COLUMN IF NOT EXISTS channel_type String MATERIALIZED JSONExtractString(properties, '$channel_type'),
    ADD COLUMN IF NOT EXISTS utm_source String MATERIALIZED JSONExtractString(properties, '$utm_source'),
    ADD COLUMN IF NOT EXISTS utm_medium String MATERIALIZED JSONExtractString(properties, '$utm_medium'),
    ADD COLUMN IF NOT EXISTS utm_campaign String MATERIALIZED JSONExtractString(properties, '$utm_campaign'),
    ADD COLUMN IF NOT EXISTS utm_term String MATERIALIZED JSONExtractString(properties, '$utm_term'),
    ADD COLUMN IF NOT EXISTS utm_content String MATERIALIZED JSONExtractString(properties, '$utm_content'),
    ADD COLUMN IF NOT EXISTS device_type String MATERIALIZED JSONExtractString(properties, '$device_type'),
    ADD COLUMN IF NOT EXISTS browser String MATERIALIZED JSONExtractString(properties, '$browser'),
    ADD COLUMN IF NOT EXISTS os String MATERIALIZED JSONExtractString(properties, '$os'),
    ADD COLUMN IF NOT EXISTS path String MATERIALIZED path(current_url),
    ADD COLUMN IF NOT EXISTS host String MATERIALIZED domain(current_url);
