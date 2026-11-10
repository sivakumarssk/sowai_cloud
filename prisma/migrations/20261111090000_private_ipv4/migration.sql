-- Stage A of the shared IPv4 gateway: a private IPv4 per service and shared mode.
-- See src/lib/provisioning/privateIpv4.ts and src/lib/provisioning/serverReady.ts.

-- CreateEnum
CREATE TYPE "Ipv4Mode" AS ENUM ('DEDICATED', 'SHARED');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "ipv4Mode" "Ipv4Mode" NOT NULL DEFAULT 'DEDICATED',
ADD COLUMN     "privateIpv4" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Service_privateIpv4_key" ON "Service"("privateIpv4");

-- Each private address is handed out once: a sequence never goes back, and the unique index above
-- refuses a second holder. 16383 blocks of 254 addresses (.1 to .254): 100.64.0.0 to 100.127.254.254.
-- 100.127.255.0/24 is kept for the installer's test containers.
CREATE SEQUENCE "service_private_ipv4_seq" AS INTEGER MINVALUE 1 MAXVALUE 4161282 NO CYCLE;

-- Only an address from the shared range, and never one from the test block.
ALTER TABLE "Service" ADD CONSTRAINT "Service_private_ipv4_shared_range" CHECK (
  "privateIpv4" IS NULL
  OR ("privateIpv4" ~ '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\.([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$'
      AND "privateIpv4" NOT LIKE '100.127.255.%')
);

-- ACTIVE still means a real server whose SSH login was checked. A Proxmox container now has either
-- its own Floating IP, or shared mode with its private address.
ALTER TABLE "Service" DROP CONSTRAINT "Service_active_requires_real_server";
ALTER TABLE "Service" ADD CONSTRAINT "Service_active_requires_real_server" CHECK (
  "status" <> 'ACTIVE'
  OR ("serverSource" = 'PROXMOX' AND "proxmoxVmId" IS NOT NULL AND "nodeId" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL
      AND ("hetznerFloatingIpId" IS NOT NULL OR ("ipv4Mode" = 'SHARED' AND "privateIpv4" IS NOT NULL)))
  OR ("serverSource" = 'MANUAL' AND "serverIp" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL)
);
