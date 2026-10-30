-- CreateEnum
CREATE TYPE "FlagEnv" AS ENUM ('production', 'staging', 'development');

-- AlterTable
ALTER TABLE "FeatureFlag" ADD COLUMN     "env" "FlagEnv" NOT NULL DEFAULT 'production',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
