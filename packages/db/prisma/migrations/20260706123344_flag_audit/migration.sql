-- CreateEnum
CREATE TYPE "FlagAuditAction" AS ENUM ('created', 'updated', 'toggled', 'deleted');

-- CreateTable
CREATE TABLE "FlagAudit" (
    "id" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "action" "FlagAuditAction" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlagAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlagAudit_projectId_flagId_createdAt_idx" ON "FlagAudit"("projectId", "flagId", "createdAt");

-- AddForeignKey
ALTER TABLE "FlagAudit" ADD CONSTRAINT "FlagAudit_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "FeatureFlag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlagAudit" ADD CONSTRAINT "FlagAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
