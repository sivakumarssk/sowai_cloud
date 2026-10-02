import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import CheckoutClient from "./CheckoutClient";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ orderId?: string }>;
}) {
  const { planId } = await params;
  const { orderId } = await searchParams;

  const session = await getSession();
  if (!session) {
    redirect(`/login?redirect=${encodeURIComponent(`/order/${planId}/checkout${orderId ? `?orderId=${orderId}` : ""}`)}`);
  }

  if (!orderId) redirect(`/order/${planId}`);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { plan: true },
  });

  if (!order || order.userId !== session.userId || order.planId !== planId) notFound();

  if (order.status === "PAID") {
    const service = await prisma.service.findUnique({ where: { orderId: order.id } });
    redirect(service ? `/order/${planId}/provisioning?orderId=${order.id}` : "/dashboard/services");
  }

  return (
    <CheckoutClient
      planId={planId}
      order={{
        id: order.id,
        planName: order.plan.name,
        billingCycle: order.billingCycle,
        hostname: order.hostname || "",
        region: order.region,
        amount: order.amount,
        gstAmount: order.gstAmount,
      }}
      razorpayKeyId={process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || ""}
    />
  );
}
