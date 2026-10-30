-- 005_flag_events_env.sql — add `env` dimension to flag_events (flag env-scoping
-- follow-up). Flag definitions became env-scoped (projectId, key, env) but
-- evaluation metrics stayed cross-env; this adds env so metrics can be filtered
-- per environment. `env` is NOT part of ORDER BY (cheap to add, no re-sort of
-- existing parts needed). Idempotent: safe to re-run.
ALTER TABLE flag_events ADD COLUMN IF NOT EXISTS env String DEFAULT 'production';

-- MVs can't have a column added in place — recreate it. Dropping the MV does
-- NOT touch flag_events data, only the insert trigger going forward.
DROP TABLE IF EXISTS flag_events_mv;

-- `env` is sourced from `$feature_flag_environment`, which the server stamps
-- authoritatively from the resolved write key's env (capture.rs / endpoint_flags.rs)
-- — never trusted from client-supplied properties. Rows from before this property
-- existed (or any gap) fall back to 'production' so they don't disappear from the
-- default env filter.
CREATE MATERIALIZED VIEW IF NOT EXISTS flag_events_mv TO flag_events AS
SELECT
    uuid,
    project_id,
    JSONExtractString(properties, '$feature_flag') AS flag_key,
    distinct_id,
    JSONExtractString(properties, '$feature_flag_response') AS response,
    timestamp,
    if(JSONExtractString(properties, '$feature_flag_environment') = '', 'production',
       JSONExtractString(properties, '$feature_flag_environment')) AS env
FROM events
WHERE event = '$feature_flag_called';
