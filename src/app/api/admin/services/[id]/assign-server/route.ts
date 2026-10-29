import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { decryptNullable } from "@/lib/crypto";
import { assignManualServer, assignRefusal } from "@/lib/provisioning/manualServer";
import { prismaAssignDeps } from "@/lib/provisioning/manualServerDeps";
import { isActiveConstraintError } from "@/lib/provisioning/serverReady";

/** Audit trail shown on the Assign server page. */
const AUDIT_ACTIONS = ["CLIENT_IMPORTED", "SERVER_ASSIGNED", "SERVER_ASSIGN_SSH_FAILED", "SERVER_ASSIGN_REFUSED", "BILLING_HOLD_SET", "BILLING_HOLD_RELEASED", "PAID_NO_CONTAINER"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const s = await prisma.service.findUnique({
    where: { id },
    include: {
      user: { select: { name: true, email: true } },
      plan: { select: { name: true, category: true } },
      subscriptions: { orderBy: { createdAt: "desc" }, take: 1, select: { razorpaySubscriptionId: true, status: true } },
    },
  });
  if (!s) return apiError("Service not found", 404);
  const audit = await prisma.engineLog.findMany({
    where: { serviceId: id, action: { in: AUDIT_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, action: true, after: true, success: true, error: true, createdAt: true },
  });

  return apiSuccess({
    service: {
      id: s.id,
      status: s.status,
      serverSource: s.serverSource,
      billingHold: s.billingHold,
      provisioningStep: s.provisioningStep,
      nextBillingDate: s.nextBillingDate,
      serverIp: s.serverIp,
      ipv6Address: s.ipv6Address,
      sshUsername: decryptNullable(s.sshUsername),
      panelUrl: s.panelUrl,
      sshVerifiedAt: s.sshVerifiedAt,
      proxmoxVmId: s.proxmoxVmId,
      user: s.user,
      plan: s.plan,
      subscription: s.subscriptions[0] ?? null,
      refusal: assignRefusal({ ...s, planName: s.plan.name, customer: s.user.email }),
    },
    audit,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.serverIp !== "string" || typeof body.sshUsername !== "string" || typeof body.sshPassword !== "string") {
    return apiError("serverIp, sshUsername and sshPassword are required", 400);
  }

  const result = await assignManualServer(
    id,
    {
      serverIp: body.serverIp,
      ipv6Address: typeof body.ipv6Address === "string" ? body.ipv6Address : null,
      sshPort: body.sshPort === undefined || body.sshPort === "" ? 22 : Number(body.sshPort),
      sshUsername: body.sshUsername,
      sshPassword: body.sshPassword,
      panelUrl: typeof body.panelUrl === "string" ? body.panelUrl : null,
      panelPassword: typeof body.panelPassword === "string" ? body.panelPassword : null,
      notifyCustomer: body.notifyCustomer === true,
    },
    session.email,
    prismaAssignDeps()
  ).catch((err: unknown) => {
    if (isActiveConstraintError(err)) return { ok: false as const, httpStatus: 409, error: "The database refused ACTIVE for this server (needs an IP and a passed SSH check)." };
    throw err;
  });

  if (!result.ok) return apiError(result.error, result.httpStatus);
  return apiSuccess(result);
}
