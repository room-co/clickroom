-- CreateTable
CREATE TABLE "SegmentSnapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SegmentSnapshot_projectId_idx" ON "SegmentSnapshot"("projectId");

-- CreateIndex
CREATE INDEX "SegmentSnapshot_segmentId_idx" ON "SegmentSnapshot"("segmentId");

-- AddForeignKey
ALTER TABLE "SegmentSnapshot" ADD CONSTRAINT "SegmentSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentSnapshot" ADD CONSTRAINT "SegmentSnapshot_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
