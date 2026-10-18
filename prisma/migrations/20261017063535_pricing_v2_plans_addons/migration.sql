-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "isIntroPrice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renewalAmount" INTEGER;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "bandwidthTB" INTEGER,
ADD COLUMN     "isPopular" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceIntro1Year" INTEGER,
ADD COLUMN     "priceIntro2Year" INTEGER,
ADD COLUMN     "priceMonthly" INTEGER,
ADD COLUMN     "priceRenewal" INTEGER,
ADD COLUMN     "ramGB" INTEGER,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storageGB" INTEGER,
ADD COLUMN     "vcpu" INTEGER;

-- CreateTable
CREATE TABLE "Addon" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceMonthly" INTEGER NOT NULL,
    "categories" "PlanCategory"[],
    "exclusiveGroup" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Addon_slug_key" ON "Addon"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_slug_key" ON "Plan"("slug");

