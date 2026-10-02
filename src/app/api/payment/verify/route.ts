import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyRazorpaySignature } from "@/lib/razorpay";
import { apiSuccess, apiError } from "@/lib/types";

/**
 * Client-side confirmation only. The Razorpay checkout widget calls this
 * right after payment so the browser can move on to a waiting screen — but
 * the source of truth for "payment succeeded, provision the server" is the
 * server-to-server webhook (/api/payment/webhook), not this route. A user
 * closing the tab before this fires must not skip provisioning.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json();

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return apiError("Missing payment verification data");
  }

  const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!isValid) return apiError("Payment verification failed. Please contact support.", 400);

  const payment = await prisma.payment.findFirst({
    where: { razorpayOrderId: razorpay_order_id },
    include: { order: true },
  });

  if (!payment || payment.userId !== session.userId) {
    return apiError("Payment record not found", 404);
  }

  return apiSuccess({
    orderId: payment.orderId,
    // The webhook may not have landed yet — the frontend should poll
    // /api/orders/[id]/status rather than assume the service exists here.
  });
}
