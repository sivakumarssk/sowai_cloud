import { NextRequest, NextResponse } from "next/server";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import { fulfillPayment } from "@/lib/fulfillPayment";
import { handleSubscriptionEvent, SUBSCRIPTION_EVENTS } from "@/lib/billing/webhookEvents";
import type { Subscriptions } from "razorpay/dist/types/subscriptions";

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        status: string;
        /** Set when the payment belongs to a subscription invoice. */
        invoice_id?: string | null;
      };
    };
    subscription?: { entity: Subscriptions.RazorpaySubscription };
  };
}

/**
 * Razorpay webhook. Subscribe to: payment.captured and all subscription.*
 * events (authenticated, activated, charged, pending, halted, cancelled,
 * completed, paused, resumed).
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature || !verifyRazorpayWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const body: RazorpayWebhookPayload = JSON.parse(rawBody);

  try {
    if (SUBSCRIPTION_EVENTS.has(body.event)) {
      await handleSubscriptionEvent(body.event, body.payload);
    } else if (body.event === "payment.captured") {
      const paymentEntity = body.payload.payment?.entity;
      // Subscription charges also fire payment.captured (with an invoice) —
      // those are handled by subscription.charged instead.
      if (paymentEntity && !paymentEntity.invoice_id) {
        const result = await fulfillPayment(paymentEntity.order_id, paymentEntity.id);
        if (!result) console.error("[razorpay-webhook] payment or order not found for", paymentEntity.order_id);
      }
    }
  } catch (err) {
    // A 5xx makes Razorpay retry the delivery, which is what we want for
    // transient failures (DB, Razorpay API). Handlers are idempotent.
    console.error(`[razorpay-webhook] ${body.event} failed:`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
