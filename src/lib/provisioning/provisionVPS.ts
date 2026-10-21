import type { Plan, ServiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { proxmox, proxmoxForNode, ProxmoxError, type ProxmoxService } from "@/lib/proxmox";
import { destroyContainerAndDisks } from "@/lib/containerDisks";
import { prismaEngineLog } from "@/engine/data/engineLog";
import { hetzner } from "@/lib/hetzner";
import { vmSetup, type SetupStep } from "@/lib/vmSetup";
import { encrypt } from "@/lib/crypto";
import { razorpay } from "@/lib/razorpay";
import { getOsImage } from "@/lib/provisioning/catalog";
import { planFeatures } from "@/lib/plans";
import { sendCredentialsEmail, sendProvisioningFailedEmail } from "@/lib/email";
import { alertAdmins } from "@/lib/adminAlert";
import { cancelAutopayForService } from "@/lib/billing/subscriptions";

export type PlanResources = { cores: number; memory: number; disk: number };

/** Container size from the plan's spec fields (memory in MB, disk in GB). */
export function getPlanResources(plan: Pick<Plan, "name" | "vcpu" | "ramGB" | "storageGB">): PlanResources {
  if (!plan.vcpu || !plan.ramGB || !plan.storageGB) {
    throw new Error(`Plan "${plan.name}" is missing vcpu / ramGB / storageGB`);
  }
  return { cores: plan.vcpu, memory: plan.ramGB * 1024, disk: plan.storageGB };
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
  connecting: ["Configuring security...", 60],
  updating: ["Installing system updates...", 62],
  firewall: ["Configuring firewall...", 65],
  user: ["Creating your login...", 68],
  coolify: ["Installing Coolify...", 70],
  hardening: ["Final configuration...", 90],
};

/**
 * Turns a paid VPS service (created by fulfillPayment with status
 * PROVISIONING, 0%) into a running, configured LXC container.
 * Never throws: on failure it deletes the container, releases the Floating
 * IP, marks the service FAILED, refunds the payment and alerts admins.
 */
export async function provisionVPS(serviceId: string): Promise<void> {
  // Claim the job atomically (0% = not started) so a duplicate call can't provision twice.
  const claimed = await prisma.service.updateMany({
    where: { id: serviceId, status: "PROVISIONING", provisioningPct: 0 },
    data: { provisioningPct: 10, provisioningStep: "Allocating resources...", provisionError: null },
  });
  if (claimed.count === 0) return;

  let floatingIpId: number | null = null;
  let vmid: number | null = null;

  try {
    const service = await prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      include: { user: true, plan: true },
    });
    const resources = getPlanResources(service.plan);
    // Included in the plan (VPS Pro/Elite) or bought as an addon (set on the service at checkout).
    const hasCoolify = service.hasCoolify || planFeatures(service.plan).some((f) => /coolify/i.test(f));
    const osImage = service.osImage || "ubuntu-22.04";
    const osLabel = getOsImage(osImage)?.label.replace(/\s*\(.*\)$/, "") ?? osImage;
    // Fail before buying an IP if the OS can't be installed.
    if (!(await proxmox.hasOSTemplate(osImage))) {
      throw new Error(`LXC template for OS "${osImage}" is not available on the Proxmox host`);
    }

    // b. Buy the Floating IP — saved immediately so it can be released even if we crash.
    const ip = await hetzner.buyFloatingIP(`sowsi-${serviceId}`);
    floatingIpId = ip.id;
    await prisma.service.update({
      where: { id: serviceId },
      data: { hetznerFloatingIpId: String(ip.id), serverIp: ip.ip, hasCoolify },
    });

    // c–d. Route it to the Proxmox server.
    await updateStatus(serviceId, "PROVISIONING", "Assigning IP address...", 20);
    await hetzner.assignFloatingIP(ip.id);

    // e–f. Create the container — this is where the OS is installed from the template.
    await updateStatus(serviceId, "INSTALLING", `Installing ${osLabel}...`, 40);

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
        data: {
          proxmoxVmId: String(candidate),
          ipv6Address: ipv6,
          // The resource engine finds containers by node.
          nodeId: (await prisma.proxmoxNode.findUnique({ where: { name: process.env.PROXMOX_NODE ?? "" }, select: { id: true } }))?.id ?? null,
        },
      });
      break;
    }

    // g. Wait for it to run, then route its IPs on the host.
    await proxmox.waitForLXC(vmid);
    await vmSetup.syncHostRoutes();

    // h–k. SSH in: updates, UFW, client user, Coolify, SSH hardening.
    await updateStatus(serviceId, "INSTALLING", ...SETUP_PROGRESS.connecting);
    const credentials = await vmSetup.setupVM({
      ipAddress: ip.ip,
      hasCoolify,
      clientEmail: service.user.email,
      onStep: (step) => updateStatus(serviceId, "INSTALLING", ...SETUP_PROGRESS[step]),
    });

    // l. Save everything.
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "ACTIVE",
        provisioningPct: 100,
        provisioningStep: "Server is ready!",
        sshUsername: encrypt(credentials.sshUsername),
        sshPassword: encrypt(credentials.sshPassword),
        panelUrl: credentials.coolifyUrl,
        panelPassword: credentials.coolifyPassword ? encrypt(credentials.coolifyPassword) : null,
      },
    });

    // m. Welcome email with credentials.
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

    // n. In-app notification.
    await prisma.notification
      .create({
        data: {
          userId: service.userId,
          title: "Server is ready",
          message: `Your ${service.plan.name} server is now active. Login credentials have been emailed to you.`,
        },
      })
      .catch((err) => console.error("[provisioning] notification failed:", err));
  } catch (error) {
    await handleFailure(serviceId, error, { vmid, floatingIpId });
  }
}

/** Prefix of the error reported when a container's disks couldn't all be removed. */
const LEFTOVER_DISKS = "Leftover disks";

/**
 * Destroys the container and every disk it had (verified against the storage
 * listings), removes its host routes, then releases its Floating IP. The IP
 * is kept if the container couldn't be deleted, so it can't be handed to a
 * new customer while the old container still has it configured. Leftover
 * disks don't block the IP release (the container is gone) but are reported
 * and logged as a failure. Returns errors instead of throwing.
 */
async function releaseResources(
  vmid: number | null,
  floatingIpId: number | null,
  ctx: { client?: ProxmoxService; serviceId?: string; nodeName?: string } = {}
): Promise<string[]> {
  const errors: string[] = [];
  if (vmid !== null) {
    const client = ctx.client ?? proxmox;
    try {
      const disks = await destroyContainerAndDisks(client, vmid);
      if (disks.leftover.length > 0) {
        const message = `${LEFTOVER_DISKS} after deleting container ${vmid}: ${disks.leftover.join(", ")}${disks.errors.length ? ` (${disks.errors.join("; ")})` : ""}`;
        errors.push(message);
        await prismaEngineLog({
          action: "CONTAINER_DISKS_LEFT_OVER",
          serviceId: ctx.serviceId ?? null,
          vmid,
          fromNode: ctx.nodeName,
          after: { leftover: disks.leftover, freed: disks.freed },
          trigger: "AUTO_ENGINE",
          success: false,
          error: message,
        });
      }
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
      errors.push(`Release Floating IP ${floatingIpId}: ${errorMessage(err)}`);
    }
  }
  return errors;
}

/** Proxmox client for the node a service's container is on (falls back to the default node). */
async function clientForService(serviceId: string): Promise<{ client: ProxmoxService; nodeName?: string }> {
  const service = await prisma.service.findUnique({ where: { id: serviceId }, select: { node: { select: { name: true, ip: true } } } });
  return service?.node ? { client: proxmoxForNode(service.node), nodeName: service.node.name } : { client: proxmox };
}

async function handleFailure(
  serviceId: string,
  error: unknown,
  { vmid, floatingIpId }: { vmid: number | null; floatingIpId: number | null }
) {
  console.error(`[provisioning] service ${serviceId} failed:`, error);

  const cleanupErrors = await releaseResources(vmid, floatingIpId, { ...(await clientForService(serviceId)), serviceId });
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

  // Stop autopay before refunding, so the customer isn't charged again for a server that doesn't exist.
  const autopayError = await cancelAutopayForService(serviceId).then(
    () => null,
    (err) => errorMessage(err)
  );

  let refundError: string | null = null;
  const payment = await prisma.payment.findFirst({
    where: { serviceId, status: "SUCCESS", razorpayPaymentId: { not: null } },
  });
  if (payment?.razorpayPaymentId) {
    try {
      await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: payment.amount + payment.gstAmount + payment.processingFee, // paise
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
      `Autopay: ${autopayError ? `NOT cancelled — ${autopayError} (cancel it in the Razorpay dashboard!)` : "cancelled"}`,
      cleanedUp
        ? "Cleanup: container and IP released"
        : `Cleanup FAILED — remove manually:\n  ${cleanupErrors.join("\n  ")}`,
      error instanceof Error && error.stack ? `\n${error.stack}` : "",
    ].join("\n")
  );
}

function sendAdminAlert(serviceId: string, details: string) {
  return alertAdmins(`Service ${serviceId} needs attention`, details);
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

  // Stop billing first: if autopay can't be cancelled, keep the server rather
  // than keep charging for one that no longer exists. Retrying is safe.
  try {
    await cancelAutopayForService(serviceId);
  } catch (err) {
    const message = `Cancellation incomplete: could not cancel autopay — ${errorMessage(err)}`;
    await prisma.service.update({ where: { id: serviceId }, data: { provisionError: message } });
    await sendAdminAlert(serviceId, `${message}\nThe server was NOT deleted.`);
    throw new Error(message);
  }

  const service = await prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
  const errors = await releaseResources(
    service.proxmoxVmId ? Number(service.proxmoxVmId) : null,
    service.hetznerFloatingIpId ? Number(service.hetznerFloatingIpId) : null,
    { ...(await clientForService(serviceId)), serviceId }
  );

  if (errors.length > 0) {
    // Only clear what's actually gone, so an admin (or a retry) can finish the job.
    // Keep the vmid while its container or any of its disks still exist, so a retry can finish the cleanup.
    const vmGone = !errors.some((e) => e.startsWith("Delete container") || e.startsWith(LEFTOVER_DISKS));
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
