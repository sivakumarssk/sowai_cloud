-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "hetznerFloatingIpId" TEXT,
ADD COLUMN     "ipv6Address" TEXT;
