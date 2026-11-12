-- Stage C of the shared IPv4 gateway: shared mode in provisioning, behind a per-node flag.
-- See src/lib/provisioning/publicName.ts, src/lib/provisioning/serviceNetwork.ts and
-- src/lib/nodes/gatewaySync.ts.

-- AlterTable
ALTER TABLE "ProxmoxNode" ADD COLUMN     "gatewayRoutesIssued" BIGINT,
ADD COLUMN     "sharedIpv4" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "publicName" TEXT,
ADD COLUMN     "routeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Service_publicName_key" ON "Service"("publicName");

-- CreateIndex
CREATE UNIQUE INDEX "Service_routeKey_key" ON "Service"("routeKey");

-- One DNS label: lowercase letters, digits and single hyphens inside, at most 63 characters.
ALTER TABLE "Service" ADD CONSTRAINT "Service_public_name_label" CHECK (
  "publicName" IS NULL
  OR ("publicName" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' AND "publicName" NOT LIKE '%--%')
);

-- The key sowsi-gateway accepts.
ALTER TABLE "Service" ADD CONSTRAINT "Service_route_key_format" CHECK (
  "routeKey" IS NULL OR "routeKey" ~ '^[a-z0-9]{16}$'
);

-- ACTIVE in shared mode also needs the name and key the gateway routes it by.
ALTER TABLE "Service" DROP CONSTRAINT "Service_active_requires_real_server";
ALTER TABLE "Service" ADD CONSTRAINT "Service_active_requires_real_server" CHECK (
  "status" <> 'ACTIVE'
  OR ("serverSource" = 'PROXMOX' AND "proxmoxVmId" IS NOT NULL AND "nodeId" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL
      AND ("hetznerFloatingIpId" IS NOT NULL
           OR ("ipv4Mode" = 'SHARED' AND "privateIpv4" IS NOT NULL AND "publicName" IS NOT NULL AND "routeKey" IS NOT NULL)))
  OR ("serverSource" = 'MANUAL' AND "serverIp" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL)
);
