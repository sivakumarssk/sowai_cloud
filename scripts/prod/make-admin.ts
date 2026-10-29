/**
 * Makes an existing account an admin. Sign up on the site first (and verify the
 * email), then:
 *
 *   npx tsx scripts/prod/make-admin.ts you@example.com
 *
 * Changes only that user's role. Logged to EngineLog (ADMIN_GRANTED).
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const email = process.argv[2]?.trim().toLowerCase();

(async () => {
  const { prisma } = await import("../../src/lib/prisma");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");
  try {
    if (!email || email.startsWith("--") || !email.includes("@")) throw new Error("usage: make-admin.ts <email>");
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true, email: true, name: true, role: true, isVerified: true } });
    if (!user) throw new Error(`no account for ${email} — sign up on the site first, then run this again`);
    if (user.role === "ADMIN") {
      console.log(`${user.email} (${user.name}) is already an admin — nothing changed`);
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    await prismaEngineLog({ action: "ADMIN_GRANTED", before: { role: user.role }, after: { userId: user.id, email: user.email, role: "ADMIN", by: process.env.USER ?? process.env.USERNAME ?? "cli" }, trigger: "MANUAL" });
    console.log(`✓ ${user.email} (${user.name}) is now an admin${user.isVerified ? "" : " — note: the email isn't verified yet"}. Sign out and in again to load the admin role.`);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
