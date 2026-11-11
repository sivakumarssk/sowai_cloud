-- Shared IPv4 gateway, Stage B: each node's gateway container and its own Floating IP.
-- Additive only: nullable columns, nothing existing changes.

ALTER TABLE "ProxmoxNode" ADD COLUMN "gatewayIpv4" TEXT,
ADD COLUMN "gatewayFloatingIpId" TEXT,
ADD COLUMN "gatewayVmId" INTEGER,
ADD COLUMN "gatewayRoutesVersion" BIGINT;

CREATE UNIQUE INDEX "ProxmoxNode_gatewayFloatingIpId_key" ON "ProxmoxNode"("gatewayFloatingIpId");

ALTER TABLE "NodeInstall" ADD COLUMN "gatewayFloatingIpId" TEXT,
ADD COLUMN "gatewayIpv4" TEXT,
ADD COLUMN "gatewayPurchasedAt" TIMESTAMP(3),
ADD COLUMN "gatewayMonthlyPaise" INTEGER;
