import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { razorpay } from "@/lib/razorpay";
import { apiSuccess, apiError } from "@/lib/types";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { orderId } = await req.json();
  if (!orderId) return apiError("Order ID is required");

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { plan: true },
  });

  if (!order || order.userId !== session.userId) {
    return apiError("Order not found", 404);
  }
  if (order.status === "PAID") return apiError("This order has already been paid for");

  const totalAmount = order.amount + order.gstAmount;

  const rpOrder = await razorpay.orders.create({
    amount: totalAmount * 100, // paise
    currency: "INR",
    receipt: `sowsi_${order.id}`,
    notes: { orderId: order.id, planId: order.planId, userId: session.userId },
  });

  await prisma.payment.create({
    data: {
      userId: session.userId,
      orderId: order.id,
      amount: order.amount,
      gstAmount: order.gstAmount,
      currency: "INR",
      razorpayOrderId: rpOrder.id,
      status: "PENDING",
    },
  });

  return apiSuccess({
    razorpayOrderId: rpOrder.id,
    amount: totalAmount * 100,
    currency: "INR",
    planName: order.plan.name,
    orderId: order.id,
  });
}
