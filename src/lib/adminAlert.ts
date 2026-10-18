import { prisma } from "@/lib/prisma";
import { sendAdminAlertEmail } from "@/lib/email";

/** Emails ADMIN_ALERT_EMAIL (comma-separated) or, if unset, every ADMIN user. Never throws. */
export async function alertAdmins(subject: string, details: string): Promise<void> {
  try {
    const configured = process.env.ADMIN_ALERT_EMAIL?.split(",").map((e) => e.trim()).filter(Boolean);
    const recipients =
      configured && configured.length > 0
        ? configured
        : (await prisma.user.findMany({ where: { role: "ADMIN" }, select: { email: true } })).map((u) => u.email);
    await sendAdminAlertEmail(recipients, subject, details);
  } catch (err) {
    console.error("[admin-alert] failed:", subject, err);
  }
}
