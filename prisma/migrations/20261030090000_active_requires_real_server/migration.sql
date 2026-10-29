-- A service may only be ACTIVE when it is a real server: a Proxmox container
-- (proxmoxVmId), the node it runs on, its Hetzner Floating IP, and a passed
-- SSH login check (sshVerifiedAt). See src/lib/provisioning/serverReady.ts.

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "sshVerifiedAt" TIMESTAMP(3);

-- Containers created before nodes were tracked all live on the single node, if there is only one.
UPDATE "Service"
SET "nodeId" = (SELECT "id" FROM "ProxmoxNode" LIMIT 1)
WHERE "nodeId" IS NULL
  AND "proxmoxVmId" IS NOT NULL
  AND (SELECT count(*) FROM "ProxmoxNode") = 1;

-- Real servers built before this column existed passed the same check: provisionVPS
-- only marks a service ACTIVE after the client's SSH login and sudo succeed.
UPDATE "Service"
SET "sshVerifiedAt" = "updatedAt"
WHERE "status" IN ('ACTIVE', 'SUSPENDED')
  AND "proxmoxVmId" IS NOT NULL
  AND "nodeId" IS NOT NULL
  AND "hetznerFloatingIpId" IS NOT NULL;

-- ACTIVE without a real server (e.g. "fulfilled" by the simulator) is shown as being set up
-- until it is rebuilt with scripts/billing/reprovision.ts. Payments and autopay are not touched.
UPDATE "Service"
SET "status" = 'INSTALLING',
    "provisioningStep" = 'Setting up — your server is being prepared'
WHERE "status" = 'ACTIVE'
  AND ("proxmoxVmId" IS NULL OR "nodeId" IS NULL OR "hetznerFloatingIpId" IS NULL OR "sshVerifiedAt" IS NULL);

-- AddCheckConstraint
ALTER TABLE "Service" ADD CONSTRAINT "Service_active_requires_real_server" CHECK (
  "status" <> 'ACTIVE'
  OR ("proxmoxVmId" IS NOT NULL AND "nodeId" IS NOT NULL AND "hetznerFloatingIpId" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL)
);
