-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "quote" JSONB;


-- Data: every money column was in rupees; store paise from now on.
UPDATE "Plan"         SET "price" = "price" * 100;
UPDATE "Order"        SET "amount" = "amount" * 100, "gstAmount" = "gstAmount" * 100, "renewalAmount" = "renewalAmount" * 100;
UPDATE "Payment"      SET "amount" = "amount" * 100, "gstAmount" = "gstAmount" * 100;
UPDATE "Subscription" SET "amount" = "amount" * 100, "gstAmount" = "gstAmount" * 100;
