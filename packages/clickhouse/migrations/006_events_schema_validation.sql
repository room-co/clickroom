-- 006_events_schema_validation.sql — warn-mode taxonomy schema validation
-- (services/schema-validate + ingest-rs `consumer.rs`/`schema.rs`).
--
-- ingest-rs validates every event's `properties` against the project's cached
-- taxonomy schema (Redis `capture:schema:<project_id>`, mirrored from
-- Postgres by the control plane). `strict`-mode violations are already
-- rejected synchronously by capture-rs (400, never reach NATS/ClickHouse);
-- `warn`-mode violations are tagged here rather than dropped.
--
-- `schema_valid` defaults to 1 (valid/unenforced) so existing rows and any
-- insert that skips validation read as valid. `schema_errors` is a compact
-- JSON array of `schema_validate::Violation` (empty string when valid).
-- Idempotent: safe to re-run.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS schema_valid UInt8 DEFAULT 1,
    ADD COLUMN IF NOT EXISTS schema_errors String DEFAULT '' CODEC(ZSTD(3));
