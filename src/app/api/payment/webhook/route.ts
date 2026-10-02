import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyRazorpayWebhookSignature, generateInvoiceNumber } from "@/lib/razorpay";
import { sendInvoiceEmail } from "@/lib/email";
import { provisioningQueue } from "@/lib/queue/provisioningQueue";

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id: string;
        notes?: Record<string, string>;
      };
    };
  };
}

function monthsToMs(months: number): number {
  return months * 30 * 24 * 60 * 60 * 1000;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature || !verifyRazorpayWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const body: RazorpayWebhookPayload = JSON.parse(rawBody);

  // Only act on a successful capture; ignore all other event types.
  if (body.event !== "payment.captured") {
    return NextResponse.json({ received: true });
  }

  const paymentEntity = body.payload.payment?.entity;
  if (!paymentEntity) return NextResponse.json({ received: true });

  const razorpayOrderId = paymentEntity.order_id;
  const razorpayPaymentId = paymentEntity.id;

  const payment = await prisma.payment.findFirst({
    where: { razorpayOrderId },
    include: { order: { include: { plan: true } } },
  });

  if (!payment || !payment.order) {
    console.error("[razorpay-webhook] payment or order not found for", razorpayOrderId);
    return NextResponse.json({ received: true });
  }

  // Idempotency: webhooks can be delivered more than once.
  if (payment.status === "SUCCESS") {
    return NextResponse.json({ received: true });
  }

  const order = payment.order;
  const invoiceNumber = generateInvoiceNumber();
  const nextBillingDate = new Date(Date.now() + monthsToMs(order.billingCycle));

  const [, service] = await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCESS", razorpayPaymentId, invoiceNumber },
    }),
    prisma.service.create({
      data: {
        userId: order.userId,
        planId: order.planId,
        orderId: order.id,
        status: "PENDING",
        hostname: order.hostname,
        region: order.region,
        osImage: order.osImage,
        stackPreset: order.stackPreset,
        nextBillingDate,
      },
    }),
    prisma.order.update({
      where: { id: order.id },
      data: { status: "PAID" },
    }),
  ]);

  await prisma.payment.update({
    where: { id: payment.id },
    data: { serviceId: service.id },
  });

  const user = await prisma.user.findUnique({ where: { id: order.userId } });
  if (user) {
    sendInvoiceEmail(
      user.email,
      user.name,
      invoiceNumber,
      order.plan.name,
      payment.amount,
      payment.gstAmount
    ).catch(console.error);

    await prisma.notification.create({
      data: {
        userId: order.userId,
        title: "Payment received",
        message: `Payment confirmed for ${order.plan.name}. We're setting up your server now.`,
      },
    });
  }

  await provisioningQueue.add({ serviceId: service.id });

  return NextResponse.json({ received: true });
}
