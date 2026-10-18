-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "processingFee" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "processingFee" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "processingFee" INTEGER NOT NULL DEFAULT 0;

