-- CreateEnum
CREATE TYPE "EnforcementMode" AS ENUM ('none', 'warn', 'strict');

-- AlterTable
ALTER TABLE "EventDefinition" ADD COLUMN     "enforcementMode" "EnforcementMode" NOT NULL DEFAULT 'none';

-- AlterTable
ALTER TABLE "EventProperty" ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT false;
