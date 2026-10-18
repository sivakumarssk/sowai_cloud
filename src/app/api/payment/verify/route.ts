import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyRazorpaySignature } from "@/lib/razorpay";
import { apiSuccess, apiError } from "@/lib/types";
import { fulfillPayment, fulfillSubscriptionPayment } from "@/lib/fulfillPayment";
import { verifySubscriptionSignature } from "@/lib/billing/subscriptions";

/**
 * Called by the Razorpay checkout widget right after payment. Once the
 * signature checks out it creates the Service and starts provisioning in the
 * background, then returns immediately. The webhook (/api/payment/webhook)
 * runs the same idempotent fulfilment, so a customer closing the tab before
 * this fires still gets their server.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { razorpay_payment_id, razorpay_signature, razorpay_subscription_id, razorpay_order_id } = await req.json();
  if (!razorpay_payment_id || !razorpay_signature || !(razorpay_subscription_id || razorpay_order_id)) {
    return apiError("Missing payment verification data");
  }

  let result: Awaited<ReturnType<typeof fulfillPayment>>;

  if (razorpay_subscription_id) {
    // Autopay checkout (the normal path).
    if (!verifySubscriptionSignature(razorpay_payment_id, razorpay_subscription_id, razorpay_signature)) {
      return apiError("Payment verification failed. Please contact support.", 400);
    }
    const subscription = await prisma.subscription.findUnique({
      where: { razorpaySubscriptionId: razorpay_subscription_id },
      select: { userId: true },
    });
    if (!subscription || subscription.userId !== session.userId) return apiError("Payment record not found", 404);
    result = await fulfillSubscriptionPayment(razorpay_subscription_id, razorpay_payment_id);
  } else {
    // One-time order checkout started before autopay was introduced.
    if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return apiError("Payment verification failed. Please contact support.", 400);
    }
    const payment = await prisma.payment.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
      select: { userId: true },
    });
    if (!payment || payment.userId !== session.userId) return apiError("Payment record not found", 404);
    result = await fulfillPayment(razorpay_order_id, razorpay_payment_id);
  }

  if (!result) return apiError("Order not found for this payment", 404);
  return apiSuccess({ orderId: result.orderId, serviceId: result.serviceId });
}
