-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'conversation';
ALTER TABLE "SupportTicket" ADD COLUMN "severity" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN "bugReport" JSONB;

-- CreateIndex
CREATE INDEX "SupportTicket_projectId_type_status_createdAt_idx"
  ON "SupportTicket"("projectId", "type", "status", "createdAt");

-- Backfill: the only pre-phase bug signals that ever existed are the form's channel
-- and the `category='Bug'` convention the widget wrote (support-render.ts:2199,:3110).
UPDATE "SupportTicket" t
   SET "type" = 'bug'
  FROM "SupportForm" f
 WHERE t."formId" = f."id"
   AND (f."definition"->>'channel' = 'bug' OR lower(t."category") = 'bug');

-- Backfill severity from the `bug` starter template's Severity dropdown, which stored
-- Blocker/Major/Minor in `category` (apps/web/src/pages/support/types.ts:288-301).
UPDATE "SupportTicket"
   SET "severity" = lower("category")
 WHERE "type" = 'bug' AND lower("category") IN ('blocker','major','minor');
