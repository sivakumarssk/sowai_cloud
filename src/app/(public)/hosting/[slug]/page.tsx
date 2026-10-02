import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { HOSTING_STACKS, getStackBySlug } from "@/lib/hostingStacks";
import StackClient from "./StackClient";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return HOSTING_STACKS.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const stack = getStackBySlug(slug);
  if (!stack) return {};
  return {
    title: stack.metaTitle,
    description: stack.metaDescription,
    keywords: stack.keywords.join(", "),
    openGraph: {
      title: stack.metaTitle,
      description: stack.metaDescription,
      url: `https://sowsicloud.com/hosting/${stack.slug}`,
      siteName: "Sowsi Cloud",
      locale: "en_IN",
      type: "website",
    },
  };
}

async function getPlans(category: string) {
  try {
    return await prisma.plan.findMany({
      where: { isActive: true, category: category as never, tier: "STANDARD" },
      orderBy: [{ price: "asc" }],
    });
  } catch {
    return [];
  }
}

async function getDedicatedPlans() {
  try {
    return await prisma.plan.findMany({
      where: { isActive: true, category: "DEDICATED" },
      orderBy: [{ price: "asc" }],
    });
  } catch {
    return [];
  }
}

export default async function HostingStackPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const stack = getStackBySlug(slug);
  if (!stack) notFound();

  const plans = stack.category === "DEDICATED" ? await getDedicatedPlans() : await getPlans(stack.category);

  return <StackClient stack={stack} plans={plans} />;
}
