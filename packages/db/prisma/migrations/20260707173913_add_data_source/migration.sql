-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataSource_projectId_idx" ON "DataSource"("projectId");

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Backfill: seed the default `clickhouse` DataSource for every existing ──
-- Project. New projects get this row via `bootstrapOrg`
-- going forward; projects created before this migration have none, so
-- `dataSources.list` would otherwise return empty for them. `createdBy` is
-- set to the org's earliest `org_admin` membership (fallback: earliest
-- membership of any role, for the theoretical case an org has none), mirroring
-- how the Environment backfill picked a deterministic fallback owner
-- per project when no natural "production" row existed.
INSERT INTO "DataSource" ("id", "projectId", "name", "type", "status", "isDefault", "config", "createdBy", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    p."id",
    'Clickroom ClickHouse',
    'clickhouse',
    'connected',
    true,
    '{}'::jsonb,
    owner."userId",
    now(),
    now()
FROM "Project" p
CROSS JOIN LATERAL (
    SELECT m."userId"
    FROM "OrgMembership" m
    WHERE m."orgId" = p."orgId"
    ORDER BY (m."role" = 'org_admin') DESC, m."createdAt" ASC, m."id" ASC
    LIMIT 1
) AS owner("userId");
