-- AlterTable
ALTER TABLE "SupportWebhook" ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "previousSecret" TEXT,
ADD COLUMN     "secretRotatedAt" TIMESTAMP(3),
ADD COLUMN     "previousSecretExpiresAt" TIMESTAMP(3),
ADD COLUMN     "secretHint" TEXT,
ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastDeliveryAt" TIMESTAMP(3),
ADD COLUMN     "autoDisabledAt" TIMESTAMP(3);

-- Backfill: existing rows have no name; derive one from the URL host.
UPDATE "SupportWebhook"
   SET "name" = split_part(regexp_replace("url", '^https?://', ''), '/', 1)
 WHERE "name" = '';

-- AlterTable
ALTER TABLE "SupportWebhookDelivery" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SupportWebhookAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "responseCode" INTEGER,
    "outcome" TEXT NOT NULL,
    "errorMessage" TEXT,
    "requestHeaders" JSONB,
    "requestBody" TEXT,
    "responseHeaders" JSONB,
    "responseBody" TEXT,
    "bodyTruncated" BOOLEAN NOT NULL DEFAULT false,
    "bodiesPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportWebhookAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportWebhookAttempt_webhookId_createdAt_idx" ON "SupportWebhookAttempt"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SupportWebhookAttempt_createdAt_idx" ON "SupportWebhookAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportWebhookAttempt_deliveryId_attempt_key" ON "SupportWebhookAttempt"("deliveryId", "attempt");

-- AddForeignKey
ALTER TABLE "SupportWebhookAttempt" ADD CONSTRAINT "SupportWebhookAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "SupportWebhookDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
