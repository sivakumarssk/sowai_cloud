-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "dataDiskGB" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dataDiskStorage" TEXT,
ADD COLUMN     "overageOptIn" BOOLEAN NOT NULL DEFAULT false;

