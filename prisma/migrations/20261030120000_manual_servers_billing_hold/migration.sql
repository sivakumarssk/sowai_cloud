-- Manual servers (assigned by an admin after an SSH check) and the billing hold
-- for clients imported from another database. See src/lib/provisioning/serverReady.ts.

-- CreateEnum
CREATE TYPE "ServerSource" AS ENUM ('PROXMOX', 'MANUAL');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "billingHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serverSource" "ServerSource" NOT NULL DEFAULT 'PROXMOX';

-- ACTIVE still means a real server whose SSH login was checked: a Proxmox
-- container with its node and Floating IP, or a manual server with its IP.
ALTER TABLE "Service" DROP CONSTRAINT "Service_active_requires_real_server";
ALTER TABLE "Service" ADD CONSTRAINT "Service_active_requires_real_server" CHECK (
  "status" <> 'ACTIVE'
  OR ("serverSource" = 'PROXMOX' AND "proxmoxVmId" IS NOT NULL AND "nodeId" IS NOT NULL AND "hetznerFloatingIpId" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL)
  OR ("serverSource" = 'MANUAL' AND "serverIp" IS NOT NULL AND "sshVerifiedAt" IS NOT NULL)
);
