-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('PROVISIONING', 'READY', 'WARNING', 'CRITICAL', 'DECOMMISSIONING');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "allocatedDiskGB" INTEGER,
ADD COLUMN     "allocatedRamMB" INTEGER,
ADD COLUMN     "lastDiskExpansionAt" TIMESTAMP(3),
ADD COLUMN     "lastMigratedAt" TIMESTAMP(3),
ADD COLUMN     "lastRamExpansionAt" TIMESTAMP(3),
ADD COLUMN     "nodeId" TEXT;

-- CreateTable
CREATE TABLE "ProxmoxNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "privateIp" TEXT,
    "hetznerServerId" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'nbg1',
    "ipv6Subnet" TEXT,
    "status" "NodeStatus" NOT NULL DEFAULT 'READY',
    "physicalRamMB" INTEGER NOT NULL DEFAULT 8192,
    "physicalDiskGB" INTEGER NOT NULL DEFAULT 160,
    "physicalCpu" INTEGER NOT NULL DEFAULT 4,
    "usedRamMB" INTEGER NOT NULL DEFAULT 0,
    "usedDiskGB" INTEGER NOT NULL DEFAULT 0,
    "usedCpuPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allocatedRamMB" INTEGER NOT NULL DEFAULT 0,
    "allocatedDiskGB" INTEGER NOT NULL DEFAULT 0,
    "containerCount" INTEGER NOT NULL DEFAULT 0,
    "maxContainers" INTEGER NOT NULL DEFAULT 6,
    "acceptNewClients" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "monthlyCost" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxmoxNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HetznerVolume" (
    "id" TEXT NOT NULL,
    "hetznerVolumeId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "sizeGB" INTEGER NOT NULL,
    "usedGB" INTEGER NOT NULL DEFAULT 0,
    "mountPath" TEXT NOT NULL,
    "proxmoxStorage" TEXT,
    "costPerMonth" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HetznerVolume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "serviceId" TEXT,
    "vmid" TEXT,
    "fromNode" TEXT,
    "toNode" TEXT,
    "before" JSONB,
    "after" JSONB,
    "cost" INTEGER,
    "trigger" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngineLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceMetric" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "vmid" TEXT NOT NULL,
    "ramUsedMB" INTEGER NOT NULL,
    "ramLimitMB" INTEGER NOT NULL,
    "diskUsedGB" DOUBLE PRECISION NOT NULL,
    "diskLimitGB" DOUBLE PRECISION NOT NULL,
    "cpuPct" DOUBLE PRECISION NOT NULL,
    "netInBytes" BIGINT,
    "netOutBytes" BIGINT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Overage" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "overageGB" DOUBLE PRECISION NOT NULL,
    "cost" INTEGER NOT NULL,
    "invoiced" BOOLEAN NOT NULL DEFAULT false,
    "invoicedAt" TIMESTAMP(3),
    "razorpayAddonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Overage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Migration" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "fromNode" TEXT NOT NULL,
    "toNode" TEXT NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "downtimeMinutes" INTEGER,
    "reason" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Migration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProxmoxNode_name_key" ON "ProxmoxNode"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProxmoxNode_hetznerServerId_key" ON "ProxmoxNode"("hetznerServerId");

-- CreateIndex
CREATE INDEX "ProxmoxNode_status_idx" ON "ProxmoxNode"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HetznerVolume_hetznerVolumeId_key" ON "HetznerVolume"("hetznerVolumeId");

-- CreateIndex
CREATE INDEX "HetznerVolume_nodeId_idx" ON "HetznerVolume"("nodeId");

-- CreateIndex
CREATE INDEX "EngineLog_createdAt_idx" ON "EngineLog"("createdAt");

-- CreateIndex
CREATE INDEX "EngineLog_serviceId_createdAt_idx" ON "EngineLog"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "EngineLog_action_createdAt_idx" ON "EngineLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "ResourceMetric_serviceId_recordedAt_idx" ON "ResourceMetric"("serviceId", "recordedAt");

-- CreateIndex
CREATE INDEX "ResourceMetric_recordedAt_idx" ON "ResourceMetric"("recordedAt");

-- CreateIndex
CREATE INDEX "Overage_month_invoiced_idx" ON "Overage"("month", "invoiced");

-- CreateIndex
CREATE UNIQUE INDEX "Overage_serviceId_type_month_key" ON "Overage"("serviceId", "type", "month");

-- CreateIndex
CREATE INDEX "Migration_status_scheduledFor_idx" ON "Migration"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Migration_serviceId_idx" ON "Migration"("serviceId");

-- CreateIndex
CREATE INDEX "Service_nodeId_idx" ON "Service"("nodeId");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ProxmoxNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HetznerVolume" ADD CONSTRAINT "HetznerVolume_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "ProxmoxNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceMetric" ADD CONSTRAINT "ResourceMetric_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Overage" ADD CONSTRAINT "Overage_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Migration" ADD CONSTRAINT "Migration_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

