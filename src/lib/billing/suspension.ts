import { prisma } from "@/lib/prisma";
import { proxmox } from "@/lib/proxmox";
import { sendBillingNoticeEmail } from "@/lib/email";
import { alertAdmins } from "@/lib/adminAlert";
import { DELETE_AFTER_SUSPENDED_DAYS, BILLING_SUSPEND_REASON } from "./constants";

export { DELETE_AFTER_SUSPENDED_DAYS, BILLING_SUSPEND_REASON };

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://sowsicloud.com";
const DAY_MS = 24 * 60 * 60 * 1000;

const formatDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export function deletionDate(suspendedAt: Date): Date {
  return new Date(suspendedAt.getTime() + DELETE_AFTER_SUSPENDED_DAYS * DAY_MS);
}

/**
 * Stops an ACTIVE service for non-payment. The container is shut down and
 * removed from start-on-boot; data is kept until the deletion date.
 */
export async function suspendForNonPayment(serviceId: string, why: string): Promise<boolean> {
  const suspendedAt = new Date();
  // Claim atomically so the webhook and the billing job can't both suspend.
  const claimed = await prisma.service.updateMany({
    where: { id: serviceId, status: "ACTIVE" },
    data: { status: "SUSPENDED", suspendedAt, suspendReason: BILLING_SUSPEND_REASON },
  });
  if (claimed.count === 0) return false;

  const service = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { user: true, plan: true } });

  if (service.proxmoxVmId) {
    const vmid = Number(service.proxmoxVmId);
    try {
      await proxmox.setLXCOnboot(vmid, false);
      const { status } = await proxmox.getLXCStatus(vmid);
      if (status === "running") await proxmox.shutdownLXC(vmid);
    } catch (err) {
      // Billing state is already SUSPENDED; an admin can stop the container by hand.
      await alertAdmins(
        `Could not stop suspended service ${serviceId}`,
        `Service ${serviceId} (container ${vmid}) was suspended for non-payment but the container could not be stopped:\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const deleteOn = deletionDate(suspendedAt);
  await prisma.notification
    .create({
      data: {
        userId: service.userId,
        title: "Server suspended — payment required",
        message: `Your ${service.plan.name} server has been suspended (${why}). Restart autopay before ${formatDate(deleteOn)} or it will be deleted.`,
      },
    })
    .catch(console.error);
  await sendBillingNoticeEmail(service.user.email, service.user.name, {
    subject: `Action needed: your ${service.plan.name} server is suspended`,
    heading: "Your server has been suspended",
    tone: "danger",
    paragraphs: [
      `Your <strong>${service.plan.name}</strong> server${service.hostname ? ` (${service.hostname})` : ""} has been suspended because ${why}.`,
      `Your data is safe for now. Restart autopay from your dashboard and the server will start again automatically once the payment goes through.`,
      `<strong>If no payment is received by ${formatDate(deleteOn)}, the server and all its data will be permanently deleted.</strong>`,
    ],
    cta: { label: "Restart autopay", url: `${APP_URL}/dashboard/services` },
  }).catch(console.error);

  return true;
}

/** Restarts a service that was suspended for non-payment. Admin suspensions are left alone. */
export async function resumeAfterPayment(serviceId: string): Promise<boolean> {
  const claimed = await prisma.service.updateMany({
    where: { id: serviceId, status: "SUSPENDED", suspendReason: BILLING_SUSPEND_REASON },
    data: { status: "ACTIVE", suspendedAt: null, suspendReason: null },
  });
  if (claimed.count === 0) return false;

  const service = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { user: true, plan: true } });

  if (service.proxmoxVmId) {
    const vmid = Number(service.proxmoxVmId);
    try {
      await proxmox.setLXCOnboot(vmid, true);
      const { status } = await proxmox.getLXCStatus(vmid);
      if (status !== "running") {
        await proxmox.startLXC(vmid);
        await proxmox.waitForLXC(vmid);
      }
    } catch (err) {
      await alertAdmins(
        `Could not restart paid service ${serviceId}`,
        `Service ${serviceId} (container ${vmid}) was paid for and marked ACTIVE but the container could not be started:\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await prisma.notification
    .create({
      data: {
        userId: service.userId,
        title: "Server reactivated",
        message: `Payment received — your ${service.plan.name} server is running again.`,
      },
    })
    .catch(console.error);
  await sendBillingNoticeEmail(service.user.email, service.user.name, {
    subject: `Your ${service.plan.name} server is running again`,
    heading: "Payment received — server reactivated",
    paragraphs: [`Thanks! Your payment went through and your <strong>${service.plan.name}</strong> server is running again.`],
    cta: { label: "View your server", url: `${APP_URL}/dashboard/services` },
  }).catch(console.error);

  return true;
}
