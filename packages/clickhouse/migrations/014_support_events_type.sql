-- 014_support_events_type.sql — bug/conversation split on support telemetry.
-- NOTE (mirrors 013's :22-25): an MV only populates from rows inserted AFTER it exists, so
-- pre-migration events keep an empty `ticket_type`. That is why the by-type ANALYTICS tile
-- reads Postgres; these columns exist so a later type-split FUNNEL has history.
ALTER TABLE support_events ADD COLUMN IF NOT EXISTS ticket_type LowCardinality(String) DEFAULT '';
ALTER TABLE support_events ADD COLUMN IF NOT EXISTS severity    LowCardinality(String) DEFAULT '';

-- `CREATE MATERIALIZED VIEW IF NOT EXISTS` does NOT update an existing view's SELECT, so the
-- view must be dropped and recreated. Safe: this is a `TO`-table MV — it stores no data of its
-- own, it only routes new inserts — so the drop loses at most the events inserted inside a
-- sub-second window. Both statements are guarded, so a replay is a no-op.
--
-- `DROP VIEW`, not `DROP MATERIALIZED VIEW`: ClickHouse's DROP grammar has no MATERIALIZED
-- keyword (it is a SYNTAX_ERROR — caught by migrate.test.ts against a real server); `DROP VIEW`
-- is how you drop an MV.
DROP VIEW IF EXISTS support_events_mv;
CREATE MATERIALIZED VIEW IF NOT EXISTS support_events_mv TO support_events AS
SELECT
    uuid,
    project_id,
    JSONExtractString(properties, '$support_form_id') AS form_id,
    JSONExtractString(properties, '$support_ticket_id') AS ticket_id,
    distinct_id,
    multiIf(
        event = '$support_shown', 'shown',
        event = '$support_opened', 'opened',
        event = '$support_deflected', 'deflected',
        event = '$support_ticket_created', 'ticket_created',
        event = '$support_ticket_resolved', 'ticket_resolved',
        'csat'
    ) AS interaction,
    JSONExtractString(properties, '$support_category') AS category,
    toInt8OrNull(JSONExtractString(properties, '$support_score')) AS score,
    timestamp,
    JSONExtractString(properties, '$support_ticket_type') AS ticket_type,
    JSONExtractString(properties, '$support_severity')    AS severity
FROM events
WHERE event IN ('$support_shown', '$support_opened', '$support_deflected', '$support_ticket_created', '$support_ticket_resolved', '$support_csat');
