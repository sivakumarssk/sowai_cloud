-- AlterEnum
ALTER TYPE "ServiceStatus" ADD VALUE 'INSTALLING';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "hasCoolify" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "panelPassword" TEXT,
ADD COLUMN     "provisioningPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "provisioningStep" TEXT,
ADD COLUMN     "proxmoxVmId" TEXT;
