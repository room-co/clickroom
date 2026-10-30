-- CreateEnum
CREATE TYPE "ApiKeyEnv" AS ENUM ('production', 'staging', 'development');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "env" "ApiKeyEnv" NOT NULL DEFAULT 'production',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
