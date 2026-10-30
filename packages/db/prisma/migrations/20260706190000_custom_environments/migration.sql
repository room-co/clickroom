-- Custom environments: `env` moves from a fixed global enum
-- (`FlagEnv` / `ApiKeyEnv`) to a per-project `Environment` entity, FK'd from
-- `FeatureFlag` and `ApiKey`. Hand-authored (not `prisma migrate dev` diff)
-- because it needs a data-preserving backfill:
--   1. create Environment table
--   2. backfill one row per distinct (projectId, env) actually referenced
--   3. ensure the standard defaults exist per project (the legacy org keeps its
--      3 historical envs; every other project gets 2)
--   4. mark each project's `production` row isDefault (fallback: earliest)
--   5. add + backfill environmentId on FeatureFlag/ApiKey
--   6. tighten to NOT NULL, add FKs/uniques, drop the old env columns + enums
--
-- Zero data loss: every existing FeatureFlag/ApiKey keeps its original env
-- slug via the Environment row backfilled for it in step 2 before step 3's
-- ON CONFLICT DO NOTHING defaults are applied.

-- ── 1. CreateTable ──────────────────────────────────────────────────────────

CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Environment_projectId_key_key" ON "Environment"("projectId", "key");
CREATE INDEX "Environment_projectId_idx" ON "Environment"("projectId");

ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. Backfill one Environment row per (projectId, env) actually in use ────
-- Guarantees zero data loss regardless of what envs are present today, even
-- if some project only ever used e.g. 'staging'.

INSERT INTO "Environment" ("id", "projectId", "key", "name", "isDefault", "createdAt")
SELECT gen_random_uuid()::text, used."projectId", used.env::text, initcap(used.env::text), false, now()
FROM (
    SELECT DISTINCT "projectId", "env"::text AS "env" FROM "FeatureFlag"
    UNION
    SELECT DISTINCT "projectId", "env"::text AS "env" FROM "ApiKey"
) AS used("projectId", "env")
ON CONFLICT ("projectId", "key") DO NOTHING;

-- ── 3. Ensure the standard defaults exist per project ───────────────────────
-- legacy 3-env org projects: production/staging/development (preserves today's 3
-- envs exactly). Every other project: production/development.

INSERT INTO "Environment" ("id", "projectId", "key", "name", "isDefault", "createdAt")
SELECT gen_random_uuid()::text, p."id", d."key", d."name", false, now()
FROM "Project" p
JOIN "Org" o ON o."id" = p."orgId"
CROSS JOIN (
    VALUES ('production', 'Production'), ('staging', 'Staging'), ('development', 'Development')
) AS d("key", "name")
WHERE o."slug" = 'legacy-3-env'
ON CONFLICT ("projectId", "key") DO NOTHING;

INSERT INTO "Environment" ("id", "projectId", "key", "name", "isDefault", "createdAt")
SELECT gen_random_uuid()::text, p."id", d."key", d."name", false, now()
FROM "Project" p
JOIN "Org" o ON o."id" = p."orgId"
CROSS JOIN (
    VALUES ('production', 'Production'), ('development', 'Development')
) AS d("key", "name")
WHERE o."slug" <> 'legacy-3-env'
ON CONFLICT ("projectId", "key") DO NOTHING;

-- ── 4. Mark each project's `production` row isDefault ───────────────────────
-- Fallback: the project's earliest-created row, for the (theoretical) case
-- where a project has environments but none keyed 'production'.

UPDATE "Environment"
SET "isDefault" = true
WHERE "key" = 'production';

WITH "no_prod_projects" AS (
    SELECT "projectId"
    FROM "Environment"
    GROUP BY "projectId"
    HAVING NOT bool_or("key" = 'production')
),
"earliest" AS (
    SELECT DISTINCT ON (e."projectId") e."id"
    FROM "Environment" e
    JOIN "no_prod_projects" np ON np."projectId" = e."projectId"
    ORDER BY e."projectId", e."createdAt" ASC, e."id" ASC
)
UPDATE "Environment" e
SET "isDefault" = true
FROM "earliest"
WHERE e."id" = "earliest"."id";

-- ── 5. Add nullable environmentId to FeatureFlag/ApiKey; backfill ──────────

ALTER TABLE "FeatureFlag" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "environmentId" TEXT;

UPDATE "FeatureFlag" f
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."projectId" = f."projectId" AND e."key" = f."env"::text;

UPDATE "ApiKey" k
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."projectId" = k."projectId" AND e."key" = k."env"::text;

-- ── 6. Tighten to NOT NULL, add FKs/uniques, drop old env columns + enums ──

ALTER TABLE "FeatureFlag" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "ApiKey" ALTER COLUMN "environmentId" SET NOT NULL;

ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "FeatureFlag_projectId_key_environmentId_key"
    ON "FeatureFlag"("projectId", "key", "environmentId");

DROP INDEX "FeatureFlag_projectId_key_env_key";

ALTER TABLE "FeatureFlag" DROP COLUMN "env";
ALTER TABLE "ApiKey" DROP COLUMN "env";

DROP TYPE "FlagEnv";
DROP TYPE "ApiKeyEnv";
