-- CreateEnum
CREATE TYPE "OveragePolicy" AS ENUM ('block', 'allow');

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "overagePolicy" "OveragePolicy" NOT NULL DEFAULT 'block';
