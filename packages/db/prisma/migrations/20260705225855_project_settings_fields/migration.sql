-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "dataRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';
