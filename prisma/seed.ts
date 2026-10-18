import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

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

  // ── Plans — all prices in PAISE per month (₹599 = 59900) ──
  // Standard plans: intro rate for a prepaid first term, then monthly at priceRenewal.
  // Dedicated plans: flat monthly price (= renewal), plus 1/2-year term prices
  // (~10% / ~20% off) that every customer gets, not just new ones.
  type SeedPlan = {
    slug: string;
    name: string;
    category: "VPS" | "STORAGE";
    sortOrder: number;
    isPopular?: boolean;
    isDedicated?: boolean;
    priceMonthly: number;
    priceIntro1Year?: number;
    priceIntro2Year?: number;
    priceRenewal: number;
    vcpu?: number;
    ramGB?: number;
    storageGB: number;
    bandwidthTB?: number;
    features: string[];
  };

  const plans: SeedPlan[] = [
    {
      slug: "VPS_BASIC",
      name: "VPS Basic",
      category: "VPS",
      sortOrder: 1,
      priceMonthly: 149900,
      priceIntro1Year: 59900,
      priceIntro2Year: 79900,
      priceRenewal: 129900,
      vcpu: 1,
      ramGB: 2,
      storageGB: 40,
      bandwidthTB: 3,
      features: [
        "1 vCPU Core",
        "2 GB RAM",
        "40 GB NVMe SSD",
        "3 TB Bandwidth",
        "1 Dedicated IP",
        "Full Root SSH Access",
        "Choice of OS",
        "Email Support",
        "Free SSL Certificate",
      ],
    },
    {
      slug: "VPS_PRO",
      name: "VPS Pro",
      category: "VPS",
      sortOrder: 2,
      isPopular: true,
      priceMonthly: 229900,
      priceIntro1Year: 99900,
      priceIntro2Year: 129900,
      priceRenewal: 199900,
      vcpu: 2,
      ramGB: 4,
      storageGB: 80,
      bandwidthTB: 6,
      features: [
        "2 vCPU Cores",
        "4 GB RAM",
        "80 GB NVMe SSD",
        "6 TB Bandwidth",
        "2 Dedicated IPs",
        "Full Root SSH Access",
        "Choice of OS",
        "Coolify Panel Included",
        "Priority Support",
        "Free SSL Certificate",
        "Weekly Snapshots",
      ],
    },
    {
      slug: "VPS_ELITE",
      name: "VPS Elite",
      category: "VPS",
      sortOrder: 3,
      priceMonthly: 399900,
      priceIntro1Year: 179900,
      priceIntro2Year: 229900,
      priceRenewal: 349900,
      vcpu: 4,
      ramGB: 8,
      storageGB: 160,
      bandwidthTB: 12,
      features: [
        "4 vCPU Cores",
        "8 GB RAM",
        "160 GB NVMe SSD",
        "12 TB Bandwidth",
        "3 Dedicated IPs",
        "Full Root SSH Access",
        "Choice of OS",
        "Coolify Panel Included",
        "24/7 Priority Support",
        "Free SSL Certificate",
        "Daily Snapshots",
        "Advanced Monitoring",
      ],
    },
    {
      slug: "S4_STARTER",
      name: "S4 Starter",
      category: "STORAGE",
      sortOrder: 1,
      priceMonthly: 44900,
      priceIntro1Year: 9900,
      priceRenewal: 39900,
      storageGB: 100,
      features: ["100 GB Storage", "S3 Compatible API", "Unlimited Bandwidth", "UPI Payment", "Email Support"],
    },
    {
      slug: "S4_BASIC",
      name: "S4 Basic",
      category: "STORAGE",
      sortOrder: 2,
      priceMonthly: 79900,
      priceIntro1Year: 24900,
      priceRenewal: 69900,
      storageGB: 250,
      features: [
        "250 GB Storage",
        "S3 Compatible API",
        "Unlimited Bandwidth",
        "UPI Payment",
        "Email Support",
        "Versioning Support",
      ],
    },
    {
      slug: "S4_PRO",
      name: "S4 Pro",
      category: "STORAGE",
      sortOrder: 3,
      isPopular: true,
      priceMonthly: 149900,
      priceIntro1Year: 44900,
      priceRenewal: 129900,
      storageGB: 500,
      features: [
        "500 GB Storage",
        "S3 Compatible API",
        "Unlimited Bandwidth",
        "UPI Payment",
        "Priority Support",
        "Versioning Support",
        "CDN Ready",
      ],
    },
    {
      slug: "S4_BUSINESS",
      name: "S4 Business",
      category: "STORAGE",
      sortOrder: 4,
      priceMonthly: 299900,
      priceIntro1Year: 79900,
      priceRenewal: 249900,
      storageGB: 1024,
      features: [
        "1 TB Storage",
        "S3 Compatible API",
        "Unlimited Bandwidth",
        "UPI Payment",
        "24/7 Priority Support",
        "Versioning Support",
        "CDN Ready",
        "Dedicated Bucket",
        "SLA Support",
      ],
    },
    // ── Dedicated VPS — guaranteed resources, flat monthly price ──
    // TODO(confirm): Starter and Pro specs are placeholders (2/4/80 and 8/16/320).
    {
      slug: "DEDICATED_STARTER",
      name: "Dedicated Starter",
      category: "VPS",
      isDedicated: true,
      sortOrder: 11,
      priceMonthly: 249900,
      priceIntro1Year: 219900,
      priceIntro2Year: 199900,
      priceRenewal: 249900,
      vcpu: 2,
      ramGB: 4,
      storageGB: 80,
      bandwidthTB: 4,
      features: [
        "2 vCPU (Guaranteed)",
        "4 GB RAM",
        "80 GB NVMe SSD",
        "Daily Backups Included",
        "Coolify Panel Included",
        "24/7 Priority Support",
        "99.9% SLA Uptime",
        "Managed Setup",
      ],
    },
    {
      slug: "DEDICATED_BUSINESS",
      name: "Dedicated Business",
      category: "VPS",
      isDedicated: true,
      isPopular: true,
      sortOrder: 12,
      priceMonthly: 499900,
      priceIntro1Year: 449900,
      priceIntro2Year: 399900,
      priceRenewal: 499900,
      vcpu: 4,
      ramGB: 8,
      storageGB: 160,
      bandwidthTB: 8,
      features: [
        "4 vCPU (Guaranteed)",
        "8 GB RAM",
        "160 GB NVMe SSD",
        "Daily Backups Included",
        "Coolify Panel Included",
        "24/7 Priority Support",
        "99.9% SLA Uptime",
        "Managed Setup",
      ],
    },
    {
      slug: "DEDICATED_PRO",
      name: "Dedicated Pro",
      category: "VPS",
      isDedicated: true,
      sortOrder: 13,
      priceMonthly: 899900,
      priceIntro1Year: 799900,
      priceIntro2Year: 719900,
      priceRenewal: 899900,
      vcpu: 8,
      ramGB: 16,
      storageGB: 320,
      bandwidthTB: 16,
      features: [
        "8 vCPU (Guaranteed)",
        "16 GB RAM",
        "320 GB NVMe SSD",
        "Daily Backups Included",
        "Coolify Panel Included",
        "24/7 Priority Support",
        "99.9% SLA Uptime",
        "Managed Setup",
      ],
    },

    // ── Dedicated S4 — flat monthly price ──
    {
      slug: "S4_DEDICATED_500GB",
      name: "S4 Dedicated 500GB",
      category: "STORAGE",
      isDedicated: true,
      sortOrder: 10,
      priceMonthly: 199900,
      priceIntro1Year: 179900,
      priceIntro2Year: 159900,
      priceRenewal: 199900,
      storageGB: 500,
      features: [
        "500 GB Dedicated Storage",
        "Dedicated Bucket",
        "Guaranteed Throughput",
        "Priority Egress",
        "S3 Compatible API",
        "Versioning Support",
        "SLA Backed",
        "24/7 Priority Support",
      ],
    },
    {
      slug: "S4_DEDICATED_1TB",
      name: "S4 Dedicated 1TB",
      category: "STORAGE",
      isDedicated: true,
      sortOrder: 11,
      priceMonthly: 299900,
      priceIntro1Year: 269900,
      priceIntro2Year: 239900,
      priceRenewal: 299900,
      storageGB: 1024,
      features: [
        "1 TB Dedicated Storage",
        "Dedicated Bucket",
        "Guaranteed Throughput",
        "Priority Egress",
        "S3 Compatible API",
        "Versioning Support",
        "SLA Backed",
        "24/7 Priority Support",
      ],
    },
    {
      slug: "S4_DEDICATED_5TB",
      name: "S4 Dedicated 5TB",
      category: "STORAGE",
      isDedicated: true,
      isPopular: true,
      sortOrder: 12,
      priceMonthly: 799900,
      priceIntro1Year: 719900,
      priceIntro2Year: 639900,
      priceRenewal: 799900,
      storageGB: 5120,
      features: [
        "5 TB Dedicated Storage",
        "Dedicated Bucket",
        "Guaranteed Throughput",
        "Priority Egress",
        "S3 Compatible API",
        "Versioning Support",
        "SLA Backed",
        "24/7 Priority Support",
      ],
    },
    {
      slug: "S4_DEDICATED_10TB",
      name: "S4 Dedicated 10TB",
      category: "STORAGE",
      isDedicated: true,
      sortOrder: 13,
      priceMonthly: 1399900,
      priceIntro1Year: 1259900,
      priceIntro2Year: 1119900,
      priceRenewal: 1399900,
      storageGB: 10240,
      features: [
        "10 TB Dedicated Storage",
        "Dedicated Bucket",
        "Guaranteed Throughput",
        "Priority Egress",
        "S3 Compatible API",
        "Versioning Support",
        "SLA Backed",
        "24/7 Priority Support",
      ],
    },
  ];

  // Old ids no longer seeded: pre-DEDICATED-category ids, and the retired
  // Managed VPS / Dedicated Object Storage dedicated-server plans.
  const staleIds = [
    "VPS_MANAGED_VPS",
    "STORAGE_DEDICATED_OBJECT_STORAGE",
    "DEDICATED_MANAGED_VPS",
    "DEDICATED_DEDICATED_OBJECT_STORAGE",
  ];
  await prisma.plan.deleteMany({ where: { id: { in: staleIds } } });

  const currentIds: string[] = [];
  for (const plan of plans) {
    const id = `${plan.category}_${plan.name.replace(/\s+/g, "_").toUpperCase()}`;
    currentIds.push(id);
    const data = {
      ...plan,
      tier: plan.isDedicated ? ("PREMIUM" as const) : ("STANDARD" as const),
      isActive: true,
      isPopular: plan.isPopular ?? false,
      isDedicated: plan.isDedicated ?? false,
      priceIntro1Year: plan.priceIntro1Year ?? null,
      priceIntro2Year: plan.priceIntro2Year ?? null,
      vcpu: plan.vcpu ?? null,
      ramGB: plan.ramGB ?? null,
      bandwidthTB: plan.bandwidthTB ?? null,
      // Legacy column, kept in sync with the headline rate.
      price: plan.priceIntro1Year ?? plan.priceMonthly,
    };
    await prisma.plan.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  // Shared / WordPress / Dedicated / old Storage plans: hidden, not deleted,
  // because old orders and services may still reference them.
  const retired = await prisma.plan.updateMany({
    where: { id: { notIn: currentIds }, isActive: true },
    data: { isActive: false },
  });

  console.log(`Seeded ${plans.length} plans, retired ${retired.count}`);

  // ── Addons — monthly prices in PAISE ──
  const addons = [
    {
      slug: "dailyBackup",
      name: "Daily Backup",
      description: "Automatic daily backups with 7-day retention",
      priceMonthly: 19900,
      categories: ["VPS" as const],
      exclusiveGroup: "backup",
      sortOrder: 1,
    },
    {
      slug: "weeklyBackup",
      name: "Weekly Backup",
      description: "Automatic weekly backups with 4-week retention",
      priceMonthly: 9900,
      categories: ["VPS" as const],
      exclusiveGroup: "backup",
      sortOrder: 2,
    },
    {
      slug: "coolify",
      name: "Coolify Panel",
      description: "Deploy apps with a GUI — no command line needed",
      priceMonthly: 9900,
      categories: ["VPS" as const],
      exclusiveGroup: null,
      sortOrder: 3,
    },
    {
      slug: "extraIp",
      name: "Extra IP",
      description: "Additional dedicated IP address for your server",
      priceMonthly: 14900,
      categories: ["VPS" as const],
      exclusiveGroup: null,
      sortOrder: 4,
    },
    {
      slug: "s4Versioning",
      name: "S4 Versioning",
      description: "Keep previous versions of every object",
      priceMonthly: 9900,
      categories: ["STORAGE" as const],
      exclusiveGroup: null,
      sortOrder: 5,
    },
  ];
  for (const addon of addons) {
    await prisma.addon.upsert({ where: { slug: addon.slug }, update: addon, create: addon });
  }
  console.log(`Seeded ${addons.length} addons`);

  // ── Resource engine: register the existing Proxmox host from .env ──
  const nodeName = process.env.PROXMOX_NODE;
  const nodeHost = process.env.PROXMOX_HOST;
  const hetznerServerId = process.env.HETZNER_SERVER_ID;
  if (nodeName && nodeHost && hetznerServerId) {
    const nodeData = {
      ip: nodeHost,
      hetznerServerId,
      location: process.env.HETZNER_LOCATION || "nbg1",
      ipv6Subnet: process.env.PROXMOX_IPV6_SUBNET || null,
      // Hetzner CPX32: 4 vCPU, 8 GB RAM, 160 GB disk, ~₹3,300/month.
      physicalRamMB: 8192,
      physicalDiskGB: 160,
      physicalCpu: 4,
      monthlyCost: Number(process.env.PROXMOX_NODE_MONTHLY_COST_PAISE || 330000),
    };
    const node = await prisma.proxmoxNode.upsert({
      where: { name: nodeName },
      update: nodeData,
      create: { name: nodeName, ...nodeData },
    });
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
