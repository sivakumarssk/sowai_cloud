-- CreateEnum
CREATE TYPE "NodeInstallStatus" AS ENUM ('IN_PROGRESS', 'REGISTERED', 'FAILED', 'DESTROYED');

-- AlterTable
ALTER TABLE "ProxmoxNode" ADD COLUMN     "apiTokenId" TEXT,
ADD COLUMN     "apiTokenSecret" TEXT;

-- CreateTable
CREATE TABLE "NodeInstall" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverType" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "status" "NodeInstallStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "hetznerServerId" TEXT,
    "ipv4" TEXT,
    "ipv6Subnet" TEXT,
    "hostKeySha256" TEXT,
    "bootIdBeforeReboot" TEXT,
    "completedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apiTokenSecret" TEXT,
    "testFloatingIpId" TEXT,
    "monthlyCostPaise" INTEGER NOT NULL,
    "hourlyCostPaise" INTEGER NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NodeInstall_name_key" ON "NodeInstall"("name");

-- CreateIndex
CREATE UNIQUE INDEX "NodeInstall_hetznerServerId_key" ON "NodeInstall"("hetznerServerId");

