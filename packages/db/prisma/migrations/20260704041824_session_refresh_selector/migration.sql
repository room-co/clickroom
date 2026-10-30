-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "activeOrgId" TEXT,
ADD COLUMN     "refreshTokenSelector" TEXT;

-- CreateIndex
CREATE INDEX "Session_refreshTokenSelector_idx" ON "Session"("refreshTokenSelector");
