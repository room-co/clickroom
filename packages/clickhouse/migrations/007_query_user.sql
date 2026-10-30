-- 007_query_user.sql — restricted read-only ClickHouse user for the SQL Explorer
--
-- services/query (Rust) executes tenant-authored SELECT/WITH queries after
-- AST-rewriting every tenant-table reference to a `WHERE project_id = '<pid>'`-scoped
-- subquery. That service connects as the `clickroom_query` user created here — never as
-- the app's own `clickroom` user (packages/clickhouse/src/client.ts) — so a bug in the
-- rewrite/validation layer still can't escalate past ClickHouse's own grants:
--   * `clickroom_query_profile` hard-caps resources (readonly, execution time, rows/bytes
--     read, memory, threads, result size) as READONLY settings so a session/query cannot
--     override them (e.g. via a `SETTINGS` clause smuggled through validation).
--   * SELECT is granted on exactly the three tenant-data tables the query service is
--     allowed to touch — no `system.*`, no other database, no INSERT/ALTER/DROP.
--   * `clickroom_query_quota` bounds total query volume/execution time per minute so a
--     runaway or abusive query can't starve the ingest/analytics hot path.
--
-- The user's password is supplied via the `{{CLICKHOUSE_QUERY_PASSWORD}}` template token,
-- substituted by packages/clickhouse/src/migrate.ts before this file is split/executed —
-- never hardcoded here. See CLICKHOUSE_QUERY_PASSWORD in .env.example.
--
-- The GRANT targets use the `{{CLICKHOUSE_DATABASE}}` template token (same substitution
-- mechanism) rather than a hardcoded `clickroom` database name, so this migration grants
-- against whichever database migrate.ts is actually applying migrations to (`clickroom` in
-- dev, `clickroom_e2e` when run for the isolated e2e stack) instead of silently granting on
-- a database the target ClickHouse user has no rows in.
--
-- Idempotent: safe to re-run. `migrate.ts` has no schema_migrations/version table and
-- replays every *.sql file on every run, so every statement below is IF NOT EXISTS.
-- CREATE USER's password can't be conditionally updated via IF NOT EXISTS alone, but
-- CREATE USER IF NOT EXISTS is a no-op once the user exists, matching the runner's model.

CREATE SETTINGS PROFILE IF NOT EXISTS clickroom_query_profile SETTINGS
    readonly = 1 READONLY,
    max_execution_time = 30 READONLY,
    max_result_rows = 10000 READONLY,
    max_rows_to_read = 100000000 READONLY,
    max_bytes_to_read = 10000000000 READONLY,
    max_memory_usage = 2000000000 READONLY,
    max_threads = 2 READONLY,
    max_result_bytes = 100000000 READONLY;

CREATE USER IF NOT EXISTS clickroom_query IDENTIFIED BY '{{CLICKHOUSE_QUERY_PASSWORD}}'
    SETTINGS PROFILE clickroom_query_profile;

GRANT SELECT ON {{CLICKHOUSE_DATABASE}}.events TO clickroom_query;
GRANT SELECT ON {{CLICKHOUSE_DATABASE}}.flag_events TO clickroom_query;
GRANT SELECT ON {{CLICKHOUSE_DATABASE}}.person_distinct_ids TO clickroom_query;

CREATE QUOTA IF NOT EXISTS clickroom_query_quota
    FOR INTERVAL 1 minute MAX QUERIES 60, MAX EXECUTION TIME 300
    TO clickroom_query;
