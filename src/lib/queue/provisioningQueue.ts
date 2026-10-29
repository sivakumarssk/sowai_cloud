import { prisma } from "@/lib/prisma";
import { alertAdmins } from "@/lib/adminAlert";
import { prismaEngineLog } from "@/engine/data/engineLog";
import { provisionVPS } from "@/lib/provisioning/provisionVPS";
import { isLiveEnvironment, usesRealProvisioner } from "@/lib/provisioning/guard";

export type ProvisionJobData = {
  serviceId: string;
};

/**
 * Queue-shaped interface so the call sites (webhook handler, verify route)
 * don't change when this is swapped for a real BullMQ + Redis queue later.
 */
export interface ProvisioningQueue {
  add(data: ProvisionJobData): Promise<void>;
}

/** Where a paid order goes. Nothing here ever invents an IP, credentials or an ACTIVE status. */
export function provisioningRoute(category: string, env: Record<string, string | undefined> = process.env): "PROXMOX" | "HOLD" | "SIMULATE" {
  if (category === "VPS" && usesRealProvisioner(env)) return "PROXMOX";
  // Live payments are never "fulfilled" by the simulator: the order waits for a person.
  if (isLiveEnvironment(env)) return "HOLD";
  return "SIMULATE";
}

async function runProvisioningJob({ serviceId }: ProvisionJobData): Promise<void> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { plan: true, user: true },
  });
  if (!service) return;

  const route = provisioningRoute(service.plan.category);
  if (route === "PROXMOX") return provisionVPS(serviceId);

  if (route === "HOLD") {
    // Paid, no automated provisioner for it: stays PROVISIONING (not failed, not refunded).
    const { count } = await prisma.service.updateMany({
      where: { id: serviceId, status: "PROVISIONING", provisioningPct: 0 },
      data: { provisioningStep: "Queued — our team is preparing your server" },
    });
    if (count === 0) return;
    const reason =
      service.plan.category === "VPS"
        ? `PROVISIONER is "${process.env.PROVISIONER ?? ""}", not "proxmox"`
        : `there is no automated provisioning for ${service.plan.category} plans`;
    await prismaEngineLog({ action: "PROVISION_HELD_NO_PROVISIONER", serviceId, after: { reason, plan: service.plan.name }, trigger: "AUTO_ENGINE" });
    await alertAdmins(
      `Paid order can't be built automatically: ${service.plan.name}`,
      [
        `Service ${serviceId} (${service.plan.name}) for ${service.user.name} <${service.user.email}> is paid, but ${reason}.`,
        "It stays PROVISIONING — not failed, not refunded, nothing fake shown to the customer.",
        service.plan.category === "VPS" ? "Fix PROVISIONER, then: npx tsx scripts/billing/reprovision.ts --service " + serviceId : "Set it up by hand.",
      ].join("\n")
    );
    return;
  }

  // Development only: shows the flow without pretending a server exists.
  await new Promise((r) => setTimeout(r, 4000));
  await prisma.service.updateMany({
    where: { id: serviceId, status: "PROVISIONING" },
    data: { status: "INSTALLING", provisioningPct: 100, provisioningStep: "Simulated (development) — no real server was created" },
  });
}

/**
 * In-process stand-in for a real queue. Runs the job on the Node event loop
 * instead of a separate worker. Swap for a BullMQ-backed implementation
 * (same `add` signature) once Redis is available — no call-site changes needed.
 */
class InProcessQueue implements ProvisioningQueue {
  async add(data: ProvisionJobData): Promise<void> {
    // Fire and forget — the HTTP request that enqueued this doesn't wait on it.
    void runProvisioningJob(data).catch((err) => console.error("[provisioning-job]", data.serviceId, err));
  }
}

export const provisioningQueue: ProvisioningQueue = new InProcessQueue();
