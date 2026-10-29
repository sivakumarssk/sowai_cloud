import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";
import { prismaEngineLog } from "@/engine/data/engineLog";

/** Sets or releases a service's billing hold (no automatic suspension or deletion). Audited. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (typeof body?.hold !== "boolean") return apiError("hold (true or false) is required", 400);

  const before = await prisma.service.findUnique({ where: { id }, select: { billingHold: true, status: true, nextBillingDate: true } });
  if (!before) return apiError("Service not found", 404);
  if (before.billingHold === body.hold) return apiSuccess({ billingHold: body.hold, changed: false });

  await prisma.service.update({ where: { id }, data: { billingHold: body.hold } });
  await prismaEngineLog({
    action: body.hold ? "BILLING_HOLD_SET" : "BILLING_HOLD_RELEASED",
    serviceId: id,
    before: { billingHold: before.billingHold },
    after: { billingHold: body.hold, by: session.email, status: before.status, nextBillingDate: before.nextBillingDate },
    trigger: "MANUAL",
  });
  return apiSuccess({ billingHold: body.hold, changed: true });
}
