import type { ServiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { proxmox, ProxmoxError } from "@/lib/proxmox";
import { hetzner } from "@/lib/hetzner";
import { vmSetup, type SetupStep } from "@/lib/vmSetup";
import { encrypt } from "@/lib/crypto";
import { razorpay } from "@/lib/razorpay";
import { sendCredentialsEmail, sendProvisioningFailedEmail, sendAdminAlertEmail } from "@/lib/email";

export type PlanResources = { cores: number; memory: number; disk: number };

/**
 * Reads cores / RAM (MB) / disk (GB) from the plan's advertised features
 * ("2 vCPU Cores", "4 GB RAM", "80 GB NVMe SSD"), so the container always matches
 * what the customer paid for.
 */
export function getPlanResources(features: unknown): PlanResources {
  const f = (features ?? {}) as Record<string, unknown>;
  const num = (key: string, pattern: RegExp) => {
    const match = String(f[key] ?? "").match(pattern);
    if (!match) throw new Error(`Plan feature "${key}" is missing or unparseable: ${JSON.stringify(f[key])}`);
    return Number(match[1]);
  };
  return {
    cores: num("cpu", /(\d+)\s*vCPU/i),
    memory: num("ram", /(\d+)\s*GB/i) * 1024,
    disk: num("storage", /(\d+)\s*GB/i),
  };
}

/** "2a01:4f8:1c16:5f1d" + vmid 100 → "2a01:4f8:1c16:5f1d::100" */
export function ipv6ForVmid(vmid: number): string {
  const subnet = process.env.PROXMOX_IPV6_SUBNET;
  if (!subnet) throw new Error("PROXMOX_IPV6_SUBNET is not set");
  // The VMID's decimal digits are used as the final hextet, which only fits up to 4 digits.
  if (vmid > 9999) throw new Error(`VMID ${vmid} doesn't fit the ::{vmid} IPv6 scheme`);
  return `${subnet.replace(/:+$/, "")}::${vmid}`;
}

async function updateStatus(serviceId: string, status: ServiceStatus, step: string, pct: number) {
  await prisma.service.update({
    where: { id: serviceId },
    data: { status, provisioningStep: step, provisioningPct: pct },
  });
}

const SETUP_PROGRESS: Record<SetupStep, [string, number]> = {
  connecting: ["Connecting to your server...", 50],
  updating: ["Installing system updates...", 58],
  firewall: ["Configuring security & firewall...", 65],
  user: ["Creating your login...", 72],
  coolify: ["Installing Coolify panel...", 80],
  hardening: ["Running final configuration...", 90],
};

/**
 * Turns a paid PENDING VPS service into a running, configured server.
 * Never throws: failures roll back the container and IP, refund the payment, and
 * alert admins.
 */
export async function provisionVPS(serviceId: string): Promise<void> {
  // Claim the job atomically so a duplicate enqueue can't provision twice.
  const claimed = await prisma.service.updateMany({
    where: { id: serviceId, status: "PENDING" },
    data: { status: "PROVISIONING", provisioningPct: 0, provisioningStep: "Queued", provisionError: null },
  });
  if (claimed.count === 0) return;

  let floatingIpId: number | null = null;
  let vmid: number | null = null;

  try {
    const service = await prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      include: { user: true, plan: true },
    });
    const resources = getPlanResources(service.plan.features);
    const panelFeature = String((service.plan.features as Record<string, unknown>)?.panel ?? "");
    const hasCoolify = service.hasCoolify || /coolify/i.test(panelFeature);
    const osImage = service.osImage || "ubuntu-22.04";
    // Fail before buying an IP if the OS can't be installed.
    if (!(await proxmox.hasOSTemplate(osImage))) {
      throw new Error(`LXC template for OS "${osImage}" is not available on the Proxmox host`);
    }

    await updateStatus(serviceId, "PROVISIONING", "Allocating server resources...", 10);

    const ip = await hetzner.buyFloatingIP(`sowsi-${serviceId}`);
    floatingIpId = ip.id;
    // Persist immediately so the IP can be found and released even if we crash.
    await prisma.service.update({
      where: { id: serviceId },
      data: { hetznerFloatingIpId: String(ip.id), serverIp: ip.ip, hasCoolify },
    });
    await hetzner.assignFloatingIP(ip.id);

    await updateStatus(serviceId, "PROVISIONING", "Creating your server...", 20);

    // /cluster/nextid isn't reserved, so a concurrent provision can grab the
    // same ID first — retry with a fresh one if that happens.
    for (let attempt = 1; ; attempt++) {
      const candidate = await proxmox.getNextVMID();
      const ipv6 = ipv6ForVmid(candidate);
      try {
        await proxmox.createLXC({
          vmid: candidate,
          hostname: `sowsi-${serviceId}`,
          cores: resources.cores,
          memory: resources.memory,
          diskSize: resources.disk,
          osTemplate: osImage,
          ipv4: ip.ip,
          ipv6,
          start: true,
        });
      } catch (err) {
        if (attempt < 3 && err instanceof ProxmoxError && /already exists/i.test(err.message)) continue;
        throw err;
      }
      vmid = candidate;
      await prisma.service.update({
        where: { id: serviceId },
        data: { proxmoxVmId: String(candidate), ipv6Address: ipv6 },
      });
      break;
    }

    await updateStatus(serviceId, "INSTALLING", "Starting your server...", 35);
    await proxmox.waitForLXC(vmid);

    await updateStatus(serviceId, "INSTALLING", "Configuring network...", 45);
    await vmSetup.syncHostRoutes();

    const credentials = await vmSetup.setupVM({
      ipAddress: ip.ip,
      hasCoolify,
      clientEmail: service.user.email,
      onStep: (step) => updateStatus(serviceId, "INSTALLING", ...SETUP_PROGRESS[step]),
    });

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "ACTIVE",
        provisioningPct: 100,
        provisioningStep: "Server is ready!",
        sshUsername: credentials.sshUsername,
        sshPassword: encrypt(credentials.sshPassword),
        panelUrl: credentials.coolifyUrl,
        panelPassword: credentials.coolifyPassword ? encrypt(credentials.coolifyPassword) : null,
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
      hostname: service.hostname || ip.ip,
      serverIp: ip.ip,
      sshUsername: credentials.sshUsername,
      sshPassword: credentials.sshPassword,
      panelUrl: credentials.coolifyUrl ?? undefined,
      panelLogin: credentials.coolifyPassword
        ? { email: service.user.email, password: credentials.coolifyPassword }
        : undefined,
    }).catch((err) => console.error("[provisioning] credentials email failed:", err));
  } catch (error) {
    await handleFailure(serviceId, error, { vmid, floatingIpId });
  }
}

/**
 * Destroys the container, removes its host routes, then releases its Floating
 * IP. The IP is kept if the container couldn't be deleted, so it can't be
 * handed to a new customer while the old container still has it configured.
 * Returns errors instead of throwing.
 */
async function releaseResources(vmid: number | null, floatingIpId: number | null): Promise<string[]> {
  if (vmid !== null) {
    try {
      await proxmox.deleteLXC(vmid);
    } catch (err) {
      return [
        `Delete container ${vmid}: ${errorMessage(err)}`,
        ...(floatingIpId !== null ? [`Floating IP ${floatingIpId} kept because the container still exists`] : []),
      ];
    }
    // A leftover route to a deleted container is harmless, so this doesn't block the IP release.
    await vmSetup
      .syncHostRoutes()
      .catch((err) => console.error(`[provisioning] route sync after deleting ${vmid} failed:`, err));
  }
  if (floatingIpId !== null) {
    try {
      await hetzner.releaseFloatingIP(floatingIpId);
    } catch (err) {
      return [`Release Floating IP ${floatingIpId}: ${errorMessage(err)}`];
    }
  }
  return [];
}

async function handleFailure(
  serviceId: string,
  error: unknown,
  { vmid, floatingIpId }: { vmid: number | null; floatingIpId: number | null }
) {
  console.error(`[provisioning] service ${serviceId} failed:`, error);

  const cleanupErrors = await releaseResources(vmid, floatingIpId);
  const cleanedUp = cleanupErrors.length === 0;

  const service = await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: "FAILED",
      provisioningStep: "Provisioning failed",
      provisionError: errorMessage(error),
      // Keep the IDs when cleanup failed so an admin can find the leftovers.
      ...(cleanedUp && { proxmoxVmId: null, hetznerFloatingIpId: null, serverIp: null, ipv6Address: null }),
    },
    include: { user: true, plan: true },
  });

  let refundError: string | null = null;
  const payment = await prisma.payment.findFirst({
    where: { serviceId, status: "SUCCESS", razorpayPaymentId: { not: null } },
  });
  if (payment?.razorpayPaymentId) {
    try {
      await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: (payment.amount + payment.gstAmount) * 100, // paise
        speed: "normal",
        notes: { reason: "provisioning_failed", serviceId },
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
    } catch (err) {
      refundError = errorMessage(err);
    }
  } else {
    refundError = "No successful payment found for this service";
  }
  const refunded = refundError === null;

  await prisma.notification
    .create({
      data: {
        userId: service.userId,
        title: "Server setup failed",
        message: refunded
          ? `We couldn't set up your ${service.plan.name} server. Your payment has been refunded.`
          : `We couldn't set up your ${service.plan.name} server. Our team has been notified and will contact you.`,
      },
    })
    .catch(console.error);

  await sendProvisioningFailedEmail(service.user.email, service.user.name, service.plan.name, refunded).catch(
    console.error
  );

  await sendAdminAlert(
    serviceId,
    [
      `Service: ${serviceId}`,
      `Client: ${service.user.name} <${service.user.email}>`,
      `Plan: ${service.plan.name}`,
      `Error: ${errorMessage(error)}`,
      `Refund: ${refunded ? "issued" : `NOT issued — ${refundError}`}`,
      cleanedUp
        ? "Cleanup: container and IP released"
        : `Cleanup FAILED — remove manually:\n  ${cleanupErrors.join("\n  ")}`,
      error instanceof Error && error.stack ? `\n${error.stack}` : "",
    ].join("\n")
  );
}

async function sendAdminAlert(serviceId: string, details: string) {
  try {
    const configured = process.env.ADMIN_ALERT_EMAIL?.split(",").map((e) => e.trim()).filter(Boolean);
    const recipients =
      configured && configured.length > 0
        ? configured
        : (await prisma.user.findMany({ where: { role: "ADMIN" }, select: { email: true } })).map((u) => u.email);
    await sendAdminAlertEmail(recipients, `Service ${serviceId} needs attention`, details);
  } catch (err) {
    console.error("[provisioning] admin alert failed:", err);
  }
}

// Statuses a service can be cancelled from. PROVISIONING/INSTALLING are
// excluded so teardown can't race a running provisioning job; CANCELLED is
// included so a teardown that failed part-way can be retried.
const CANCELLABLE: ServiceStatus[] = ["PENDING", "ACTIVE", "SUSPENDED", "FAILED", "CANCELLED"];

export class CancelNotAllowedError extends Error {}

/**
 * Client cancellation: deletes the container on Proxmox, releases the Floating IP on
 * Hetzner, then marks the service DELETED. While teardown is in progress (or
 * if it fails) the service stays CANCELLED and admins are alerted.
 */
export async function deprovisionVPS(serviceId: string): Promise<void> {
  const claimed = await prisma.service.updateMany({
    where: { id: serviceId, status: { in: CANCELLABLE } },
    data: { status: "CANCELLED", provisionError: null },
  });
  if (claimed.count === 0) {
    throw new CancelNotAllowedError("This service can't be cancelled right now (it's being set up or already deleted).");
  }

  const service = await prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
  const errors = await releaseResources(
    service.proxmoxVmId ? Number(service.proxmoxVmId) : null,
    service.hetznerFloatingIpId ? Number(service.hetznerFloatingIpId) : null
  );

  if (errors.length > 0) {
    // Only clear what's actually gone, so an admin (or a retry) can finish the job.
    const vmGone = !errors.some((e) => e.startsWith("Delete container"));
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        provisionError: `Cancellation incomplete: ${errors.join("; ")}`,
        ...(vmGone && { proxmoxVmId: null, ipv6Address: null }),
      },
    });
    await sendAdminAlert(serviceId, [`Cancellation of service ${serviceId} is incomplete:`, ...errors].join("\n"));
    throw new Error(errors.join("; "));
  }

  await prisma.service.update({
    where: { id: serviceId },
    data: {
      status: "DELETED",
      provisioningStep: "Server deleted",
      proxmoxVmId: null,
      hetznerFloatingIpId: null,
      serverIp: null,
      ipv6Address: null,
      sshPassword: null,
      panelPassword: null,
    },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Razorpay SDK rejects with plain objects: { statusCode, error: { description } }
  const desc = (err as { error?: { description?: string } })?.error?.description;
  return desc ?? String(err);
}
