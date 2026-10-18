-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "isDedicated" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Plan_isDedicated_idx" ON "Plan"("isDedicated");

