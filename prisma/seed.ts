import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { ADDONS, PLANS, upsertNode, upsertPlans } from "./catalog";

// Development only: it creates a demo admin with a known password.
// Production uses scripts/prod/seed.ts (plans and the node, no users).
if (process.env.APP_ENV?.trim() !== "development") {
  console.error(`Refusing to run the development seed with APP_ENV=${process.env.APP_ENV?.trim() || "unset"} — it creates admin@sowsicloud.com with a known password. Production: npx tsx scripts/prod/seed.ts`);
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create admin user
  const adminPassword = await bcrypt.hash("Admin@123456", 12);
  const admin = await prisma.user.upsert({
    where: { email: "admin@sowsicloud.com" },
    update: {},
    create: {
      email: "admin@sowsicloud.com",
      password: adminPassword,
      name: "Sowsi Admin",
      phone: "9999999999",
      role: "ADMIN",
      isVerified: true,
    },
  });
  console.log("Admin created:", admin.email);

  // ── Plans (prisma/catalog.ts) ──
  // Old ids no longer seeded: pre-DEDICATED-category ids, and the retired
  // Managed VPS / Dedicated Object Storage dedicated-server plans.
  const staleIds = [
    "VPS_MANAGED_VPS",
    "STORAGE_DEDICATED_OBJECT_STORAGE",
    "DEDICATED_MANAGED_VPS",
    "DEDICATED_DEDICATED_OBJECT_STORAGE",
  ];
  await prisma.plan.deleteMany({ where: { id: { in: staleIds } } });

  const currentIds = await upsertPlans(prisma);

  // Shared / WordPress / Dedicated / old Storage plans: hidden, not deleted,
  // because old orders and services may still reference them.
  const retired = await prisma.plan.updateMany({
    where: { id: { notIn: currentIds }, isActive: true },
    data: { isActive: false },
  });

  console.log(`Seeded ${PLANS.length} plans, retired ${retired.count}`);

  // ── Addons (prisma/catalog.ts) ──
  for (const addon of ADDONS) {
    await prisma.addon.upsert({ where: { slug: addon.slug }, update: addon, create: addon });
  }
  console.log(`Seeded ${ADDONS.length} addons`);

  // ── Resource engine: register the existing Proxmox host from .env ──
  const node = await upsertNode(prisma);
  if (node) {
    // Containers created before the engine existed all live on this node.
    const linked = await prisma.service.updateMany({
      where: { proxmoxVmId: { not: null }, nodeId: null },
      data: { nodeId: node.id },
    });
    console.log(`Registered node ${node.name} (${node.ip}); linked ${linked.count} existing containers`);
  } else {
    console.log("PROXMOX_NODE / PROXMOX_HOST / HETZNER_SERVER_ID not set — skipped node registration");
  }

  console.log("Done!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
