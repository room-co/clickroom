-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxSeats" INTEGER NOT NULL,
    "maxFlags" INTEGER NOT NULL,
    "maxEventsPerMonth" BIGINT NOT NULL,
    "maxFlagCallsPerMonth" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "maxSeatsOverride" INTEGER,
ADD COLUMN     "maxFlagsOverride" INTEGER,
ADD COLUMN     "maxEventsPerMonthOverride" BIGINT,
ADD COLUMN     "maxFlagCallsPerMonthOverride" BIGINT;

-- CreateIndex
CREATE INDEX "Org_planId_idx" ON "Org"("planId");

-- AddForeignKey
ALTER TABLE "Org" ADD CONSTRAINT "Org_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
