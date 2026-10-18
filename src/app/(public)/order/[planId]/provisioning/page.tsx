import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import ProvisioningClient from "./ProvisioningClient";

export const dynamic = "force-dynamic";

export default async function ProvisioningPage({
  params,
  searchParams,
}: {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ orderId?: string; serviceId?: string }>;
}) {
  const { planId } = await params;
  const { orderId, serviceId } = await searchParams;

  const session = await getSession();
  if (!session) {
    const query = new URLSearchParams({ ...(orderId && { orderId }), ...(serviceId && { serviceId }) }).toString();
    redirect(`/login?redirect=${encodeURIComponent(`/order/${planId}/provisioning${query ? `?${query}` : ""}`)}`);
  }
  if (!orderId) redirect("/dashboard/services");

  return <ProvisioningClient orderId={orderId} initialServiceId={serviceId ?? null} />;
}
