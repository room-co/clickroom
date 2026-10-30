-- CreateTable
CREATE TABLE "SavedVisualization" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "savedQueryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SavedVisualization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedVisualization_projectId_idx" ON "SavedVisualization"("projectId");

-- CreateIndex
CREATE INDEX "SavedVisualization_savedQueryId_idx" ON "SavedVisualization"("savedQueryId");

-- AddForeignKey
ALTER TABLE "SavedVisualization" ADD CONSTRAINT "SavedVisualization_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedVisualization" ADD CONSTRAINT "SavedVisualization_savedQueryId_fkey" FOREIGN KEY ("savedQueryId") REFERENCES "SavedQuery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
