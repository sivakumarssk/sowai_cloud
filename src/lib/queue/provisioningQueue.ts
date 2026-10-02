import { prisma } from "@/lib/prisma";
import { SimulatedProvider } from "@/lib/provisioning/SimulatedProvider";
import type { ProvisioningProvider } from "@/lib/provisioning/ProvisioningProvider";
import { sendCredentialsEmail } from "@/lib/email";
import { encrypt } from "@/lib/crypto";
import { provisionVPS } from "@/lib/provisioning/provisionVPS";

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

const provider: ProvisioningProvider = new SimulatedProvider();

async function runProvisioningJob({ serviceId }: ProvisionJobData): Promise<void> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { plan: true, user: true },
  });
  if (!service) return;

  // Real Proxmox provisioning for VPS plans once PROVISIONER=proxmox is set;
  // every other plan (and VPS until then) still goes through the simulator.
  if (process.env.PROVISIONER === "proxmox" && service.plan.category === "VPS") {
    await provisionVPS(serviceId);
    return;
  }

  try {
    await prisma.service.update({
      where: { id: serviceId },
      data: { status: "PROVISIONING" },
    });

    const result = await provider.provision({
      serviceId: service.id,
      hostname: service.hostname || `${service.plan.category.toLowerCase()}-${service.id.slice(0, 8)}`,
      region: service.region,
      osImage: service.osImage || "ubuntu-22.04",
      stackPreset: service.stackPreset || "plain",
      planName: service.plan.name,
    });

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "ACTIVE",
        serverIp: result.serverIp,
        sshUsername: result.sshUsername,
        sshPassword: encrypt(result.sshPassword),
        panelUrl: result.panelUrl,
      },
    });

    await prisma.notification.create({
      data: {
        userId: service.userId,
        title: "Server is ready",
        message: `Your ${service.plan.name} server is now active. Login credentials have been emailed to you.`,
      },
    });

    await sendCredentialsEmail(service.user.email, service.user.name, {
      planName: service.plan.name,
      hostname: service.hostname || result.serverIp,
      serverIp: result.serverIp,
      sshUsername: result.sshUsername,
      sshPassword: result.sshPassword,
      panelUrl: result.panelUrl,
    }).catch(console.error);
  } catch (err) {
    console.error("[provisioning-job]", err);
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "FAILED",
        provisionError: err instanceof Error ? err.message : "Unknown provisioning error",
      },
    });
  }
}

/**
 * In-process stand-in for a real queue. Runs the job on the Node event loop
 * instead of a separate worker. Swap for a BullMQ-backed implementation
 * (same `add` signature) once Redis is available — no call-site changes needed.
 */
class InProcessQueue implements ProvisioningQueue {
  async add(data: ProvisionJobData): Promise<void> {
    // Fire and forget — the HTTP request that enqueued this doesn't wait on it.
    void runProvisioningJob(data);
  }
}

export const provisioningQueue: ProvisioningQueue = new InProcessQueue();
