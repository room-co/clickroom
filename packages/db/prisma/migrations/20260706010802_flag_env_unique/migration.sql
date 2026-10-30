-- Feature flags are keyed per environment: the same `key` may now have an
-- independent config (active/filters/version) in production, staging, and
-- development. Widens the uniqueness constraint from (projectId, key) to
-- (projectId, key, env). No data migration needed — existing rows already
-- default env='production' from 20260705000000_flag_env_tags.

-- DropIndex
DROP INDEX "FeatureFlag_projectId_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_projectId_key_env_key" ON "FeatureFlag"("projectId", "key", "env");
