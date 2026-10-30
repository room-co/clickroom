-- AlterEnum
ALTER TYPE "ApiKeyType" ADD VALUE 'mcp';

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "selector" TEXT,
ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_selector_key" ON "ApiKey"("selector");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

