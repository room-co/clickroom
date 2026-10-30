-- 001_events.sql — Clickroom `events` table
-- Append-only event store; dedup via ReplacingMergeTree on the ORDER BY key.
-- Idempotent: safe to re-run.
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
    current_url          String MATERIALIZED JSONExtractString(properties, '$current_url')
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, toDate(timestamp), event, cityHash64(distinct_id))
SETTINGS index_granularity = 8192;
