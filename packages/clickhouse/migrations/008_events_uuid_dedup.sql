-- 008_events_uuid_dedup.sql — uuid-aware ORDER BY for `events`
--
-- Bug: `events` is `ReplacingMergeTree(created_at)` with
-- `ORDER BY (project_id, toDate(timestamp), event, cityHash64(distinct_id))` — no uuid (or
-- uuid-derived value) in the key. Two genuinely distinct events sharing
-- (project, same calendar day, same event name, same distinct_id) collapse into one row, both
-- instantly at query time (FINAL) and permanently once ClickHouse's background merge physically
-- drops the "duplicate." Fix: append `sipHash64(uuid)` as the last ORDER BY term, matching
-- PostHog's real production schema shape for this exact table.
--
-- Migration shape: this is a destructive `DROP TABLE` + `CREATE TABLE`, NOT an `ALTER ... MODIFY
-- ORDER BY` (which only applies going forward and can't fix already-merged data). This is safe
-- ONLY because dev/e2e/test ClickHouse databases hold disposable seed/test data pre-production —
-- there is no real customer data to lose. A real production rollout (post-launch) MUST NOT use
-- this drop+recreate pattern; it must instead be: create a new table with the fixed ORDER BY,
-- `INSERT INTO new SELECT * FROM old`, then an atomic rename swap (e.g. `RENAME TABLE events TO
-- events_old, events_new TO events`). Do not copy this file's DROP TABLE approach once real
-- customer data exists.
--
-- Column list/materialized expressions copied verbatim from 001_events.sql, plus the
-- session_id column added by 003_events_session.sql and the schema_valid/schema_errors
-- columns added by 006_events_schema_validation.sql (both via ALTER TABLE ADD COLUMN),
-- since this migration replaces the whole table and must not lose that schema.

DROP TABLE IF EXISTS events;

CREATE TABLE IF NOT EXISTS events (
    uuid            UUID,
    project_id      String,
    event           String,
    distinct_id     String,
    timestamp       DateTime64(6, 'UTC'),
    properties      String CODEC(ZSTD(3)),          -- JSON blob
    elements_chain  String CODEC(ZSTD(3)),          -- serialized DOM path ($autocapture)
    created_at      DateTime64(6, 'UTC') DEFAULT now64(),

    -- Materialized columns for fast click breakdowns.
    -- The original data model listed these as extractElementText()/extractElementHref(), which are NOT
    -- builtin ClickHouse functions. We implement them with real CH regex extraction so the DDL
    -- applies cleanly. ingest-rs may later precompute/override these as plain columns.
    elements_chain_text  String MATERIALIZED extract(elements_chain, 'text="([^"]*)"'),
    elements_chain_href  String MATERIALIZED extract(elements_chain, 'href="([^"]*)"'),
    current_url          String MATERIALIZED JSONExtractString(properties, '$current_url'),

    -- Session timeline support (003_events_session.sql).
    session_id      String MATERIALIZED JSONExtractString(properties, '$session_id'),

    -- Warn-mode taxonomy schema validation (006_events_schema_validation.sql).
    schema_valid   UInt8 DEFAULT 1,
    schema_errors  String DEFAULT '' CODEC(ZSTD(3))
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, toDate(timestamp), event, cityHash64(distinct_id), sipHash64(uuid))
SETTINGS index_granularity = 8192;
