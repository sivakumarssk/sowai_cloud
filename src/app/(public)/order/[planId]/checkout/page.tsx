import type { Order } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { type PriceQuote, cycleKeyFromMonths, gstOn, processingFeeOn } from "@/lib/pricing";
import { getOsImage, getPreset, getRegion } from "@/lib/provisioning/catalog";
import { configureStepHref, planStepHref } from "@/lib/orderFlow";
import CheckoutClient from "./CheckoutClient";

export const dynamic = "force-dynamic";

/**
 * The quote saved with the order, or one rebuilt from its stored amounts for
 * older orders. Either way it matches what create-order charges.
 */
function orderQuote(order: Order): PriceQuote {
  const saved = order.quote as PriceQuote | null;
  if (saved && typeof saved.total === "number" && saved.renewal) return saved;

  const months = order.billingCycle;
  const renewalSubtotal = order.renewalAmount ?? order.amount;
  return {
    cycle: cycleKeyFromMonths(months),
    months,
    isIntro: order.isIntroPrice,
    planRate: Math.round(order.amount / months),
    planTotal: order.amount,
    addons: [],
    subtotal: order.amount,
    processingFee: order.processingFee,
    gst: order.gstAmount,
    total: order.amount + order.processingFee + order.gstAmount,
    renewal: {
      planRate: renewalSubtotal,
      monthlySubtotal: renewalSubtotal,
      processingFee: processingFeeOn(renewalSubtotal),
      gst: gstOn(renewalSubtotal),
      monthlyTotal: renewalSubtotal + processingFeeOn(renewalSubtotal) + gstOn(renewalSubtotal),
      startsAfterMonths: months,
    },
  };
}

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

  // The URL carries the plan slug (from the configure step) or, for older links, the plan id.
  if (!order || order.userId !== session.userId || (order.planId !== planId && order.plan.slug !== planId)) notFound();

  if (order.status === "PAID") {
    const service = await prisma.service.findUnique({ where: { orderId: order.id } });
    redirect(service ? `/order/${planId}/provisioning?orderId=${order.id}` : "/dashboard/services");
  }

  const quote = orderQuote(order);
  const slug = order.plan.slug ?? order.plan.id;
  const addons = Array.isArray(order.addons) ? order.addons.map(String) : [];
  const choices = {
    cycle: quote.cycle,
    addons,
    hostname: order.hostname ?? undefined,
    stack: order.stackPreset ?? undefined,
    os: order.osImage ?? undefined,
  };
  const preset = order.stackPreset ? getPreset(order.stackPreset) : undefined;

  return (
    <CheckoutClient
      planSlug={slug}
      order={{
        id: order.id,
        planName: order.plan.name,
        category: order.plan.category,
        hostname: order.hostname || "",
        region: getRegion(order.region)?.label || order.region,
        os: order.osImage ? (getOsImage(order.osImage)?.label ?? order.osImage) ?? order.osImage : null,
        stack: preset && preset.value !== "plain" ? preset.label : null,
      }}
      quote={quote}
      planHref={planStepHref(slug, choices)}
      configureHref={configureStepHref(slug, choices)}
      razorpayKeyId={process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || ""}
    />
  );
}
