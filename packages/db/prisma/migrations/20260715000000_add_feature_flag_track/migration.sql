-- AlterTable
ALTER TABLE "FeatureFlag" ADD COLUMN     "track" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every flag currently referenced by an experiment
-- must keep emitting exposures, otherwise existing experiments silently stop
-- tracking on deploy. Experiment links to its flag via Experiment."featureFlagId".
UPDATE "FeatureFlag" AS f
SET "track" = true
FROM "Experiment" AS e
WHERE e."featureFlagId" = f."id";
