import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { isRealServer } from "@/lib/provisioning/serverReady";

/** Live provisioning progress for the progress page (polled every few seconds). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const service = await prisma.service.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      provisioningStep: true,
      provisioningPct: true,
      serverIp: true,
      ipv6Address: true,
      proxmoxVmId: true,
      nodeId: true,
      hetznerFloatingIpId: true,
      sshVerifiedAt: true,
    },
  });
  if (!service || (service.userId !== session.userId && session.role !== "ADMIN")) {
    return apiError("Service not found", 404);
  }

  // Only a real server (container, node, Floating IP, SSH check) is shown as running with its IPs.
  const active = isRealServer(service) && service.status === "ACTIVE";
  return apiSuccess({
    status: service.status === "ACTIVE" && !active ? "INSTALLING" : service.status,
    provisioningStep: service.provisioningStep,
    provisioningPct: service.provisioningPct,
    serverIp: active ? service.serverIp : null,
    ipv6Address: active ? service.ipv6Address : null,
  });
}
