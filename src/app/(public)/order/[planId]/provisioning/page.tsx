import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import ProvisioningClient from "./ProvisioningClient";

export const dynamic = "force-dynamic";

export default async function ProvisioningPage({
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
    redirect(`/login?redirect=${encodeURIComponent(`/order/${planId}/provisioning${orderId ? `?orderId=${orderId}` : ""}`)}`);
  }
  if (!orderId) redirect("/dashboard/services");

  return <ProvisioningClient orderId={orderId} />;
}
