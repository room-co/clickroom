# ClickHouse migrations

Forward-only `.sql` files, applied in lexical filename order by `../src/migrate.ts` and recorded
in the `schema_migrations` table (keyed on **filename**, not content hash).

## The rule: every statement must be replay-safe

**Guard every statement.** `CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS`. `CREATE OR REPLACE` also
counts. `GRANT`/`REVOKE` need no guard — they are idempotent in ClickHouse.

This is enforced by `../src/migration-guards.test.ts`, which lints every file using the runner's
own statement splitter. It fails closed: an unrecognized statement kind is a failure until you add
a rule for it and justify why re-running it is safe.

**Why.** ClickHouse has no transactional DDL, and the runner records a file as applied only
*after* all of its statements succeed. So a migration that dies partway leaves its earlier
statements applied and the file **unrecorded** — and the next run replays it **from the top**.
Replay isn't an edge case; it's the normal recovery path. An unguarded statement turns a transient
failure into a permanently wedged migration (`CREATE TABLE` → "table already exists", forever).

## Destructive migrations

A guard makes a statement *survive* replay; it does not make it *harmless*. `DROP TABLE IF EXISTS
events` is replay-safe and still destroys data on every run.

`008_events_uuid_dedup.sql` is the one destructive migration (`DROP TABLE` + recreate to fix the
`ORDER BY`). It was only acceptable because it predates real data. Read its header comment before
copying its shape: **once real customer data exists, a table rebuild must be
create-new → `INSERT INTO new SELECT * FROM old` → `RENAME` swap**, never drop-and-recreate.

## Gotchas

- The splitter (`splitStatements`) splits naively on `;` and has no notion of string literals. A
  `;` inside a quoted value silently cuts a statement in half. This is why the
  `{{CLICKHOUSE_QUERY_PASSWORD}}` substituted into `007_query_user.sql`'s single-quoted literal
  must stay alphanumeric.
- `{{TOKEN}}` placeholders are substituted from the environment. A token with no value and no
  registered dev default throws; one *with* a dev default only warns — which is how
  `007_query_user.sql` could otherwise mint a prod user with the git-committed password
  `clickroom_query_dev`. `infra/docker/migrate-entrypoint.sh` hard-refuses to run when
  `CLICKHOUSE_QUERY_PASSWORD` is empty, precisely to close that hole.
- Editing an already-applied migration has **no effect on any database that already ran it** (the
  ledger keys on filename). It only changes what a *fresh* database gets. Never rely on editing a
  file to change deployed schema — write a new migration.
