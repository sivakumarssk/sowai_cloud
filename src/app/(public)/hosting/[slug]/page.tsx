import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { toPublicPlans } from "@/lib/plans";
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
    const plans = await prisma.plan.findMany({
      where: { isActive: true, isDedicated: false, category: category as never },
      orderBy: [{ sortOrder: "asc" }],
    });
    return await toPublicPlans(plans);
  } catch {
    return [];
  }
}

export default async function HostingStackPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const stack = getStackBySlug(slug);
  if (!stack) notFound();

  const plans = await getPlans(stack.category);

  return <StackClient stack={stack} plans={plans} />;
}
