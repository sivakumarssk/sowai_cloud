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

  // Plans
  const plans = [
    // Shared Hosting - Standard
    {
      name: "Shared Starter",
      category: "SHARED" as const,
      tier: "STANDARD" as const,
      price: 99,
      features: {
        websites: "1 Website",
        storage: "10 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificate",
        emails: "1 Email Account",
        backups: "Weekly Backup",
        support: "Email Support",
      },
    },
    {
      name: "Shared Business",
      category: "SHARED" as const,
      tier: "STANDARD" as const,
      price: 199,
      features: {
        websites: "5 Websites",
        storage: "30 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificate",
        emails: "10 Email Accounts",
        backups: "Daily Backup",
        support: "Priority Email Support",
        database: "Unlimited MySQL Databases",
      },
    },
    {
      name: "Shared Enterprise",
      category: "SHARED" as const,
      tier: "STANDARD" as const,
      price: 299,
      features: {
        websites: "Unlimited Websites",
        storage: "100 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificate",
        emails: "Unlimited Email Accounts",
        backups: "Daily Backup (7-day retention)",
        support: "24/7 Priority Support",
        database: "Unlimited MySQL Databases",
        staging: "Free Staging Environment",
      },
    },
    // VPS Hosting - Standard
    {
      name: "VPS Basic",
      category: "VPS" as const,
      tier: "STANDARD" as const,
      price: 799,
      features: {
        cpu: "2 vCPU Cores",
        ram: "4 GB RAM",
        storage: "80 GB NVMe SSD",
        bandwidth: "3 TB Bandwidth",
        os: "Choice of Linux OS",
        panel: "Coolify Panel Included",
        support: "Email Support",
        ip: "1 Dedicated IP",
      },
    },
    {
      name: "VPS Pro",
      category: "VPS" as const,
      tier: "STANDARD" as const,
      price: 1299,
      features: {
        cpu: "4 vCPU Cores",
        ram: "8 GB RAM",
        storage: "160 GB NVMe SSD",
        bandwidth: "6 TB Bandwidth",
        os: "Choice of Linux OS",
        panel: "Coolify Panel Included",
        support: "Priority Support",
        ip: "2 Dedicated IPs",
        backups: "Weekly Snapshots",
      },
    },
    {
      name: "VPS Elite",
      category: "VPS" as const,
      tier: "STANDARD" as const,
      price: 1999,
      features: {
        cpu: "8 vCPU Cores",
        ram: "16 GB RAM",
        storage: "320 GB NVMe SSD",
        bandwidth: "12 TB Bandwidth",
        os: "Choice of Linux OS",
        panel: "Coolify Panel Included",
        support: "24/7 Priority Support",
        ip: "3 Dedicated IPs",
        backups: "Daily Snapshots",
        monitoring: "Advanced Monitoring",
      },
    },
    // WordPress Hosting - Standard
    {
      name: "WordPress Starter",
      category: "WORDPRESS" as const,
      tier: "STANDARD" as const,
      price: 199,
      features: {
        websites: "1 WordPress Site",
        storage: "25 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificate",
        staging: "Staging Environment",
        updates: "Auto WordPress Updates",
        backups: "Daily Backup",
        support: "Email Support",
      },
    },
    {
      name: "WordPress Business",
      category: "WORDPRESS" as const,
      tier: "STANDARD" as const,
      price: 399,
      features: {
        websites: "5 WordPress Sites",
        storage: "75 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificates",
        staging: "Staging Environments",
        updates: "Auto WordPress Updates",
        backups: "Daily Backup (14-day retention)",
        support: "Priority Support",
        caching: "Built-in Redis Cache",
      },
    },
    {
      name: "WordPress Enterprise",
      category: "WORDPRESS" as const,
      tier: "STANDARD" as const,
      price: 599,
      features: {
        websites: "Unlimited WordPress Sites",
        storage: "200 GB NVMe SSD",
        bandwidth: "Unlimited Bandwidth",
        ssl: "Free SSL Certificates",
        staging: "Unlimited Staging Environments",
        updates: "Auto WordPress Updates",
        backups: "Daily Backup (30-day retention)",
        support: "24/7 Priority Support",
        caching: "Built-in Redis + Varnish Cache",
        cdn: "Free CDN Included",
      },
    },
    // Object Storage - Standard
    {
      name: "Storage Basic",
      category: "STORAGE" as const,
      tier: "STANDARD" as const,
      price: 299,
      features: {
        storage: "500 GB Object Storage",
        bandwidth: "1 TB Egress/month",
        api: "S3-Compatible API",
        redundancy: "3x Redundancy",
        access: "Public/Private Buckets",
        support: "Email Support",
      },
    },
    {
      name: "Storage Pro",
      category: "STORAGE" as const,
      tier: "STANDARD" as const,
      price: 599,
      features: {
        storage: "2 TB Object Storage",
        bandwidth: "5 TB Egress/month",
        api: "S3-Compatible API",
        redundancy: "3x Redundancy",
        access: "Public/Private Buckets",
        support: "Priority Support",
        versioning: "Object Versioning",
        cdn: "CDN Integration",
      },
    },
    {
      name: "Storage Max",
      category: "STORAGE" as const,
      tier: "STANDARD" as const,
      price: 999,
      features: {
        storage: "5 TB Object Storage",
        bandwidth: "Unlimited Egress",
        api: "S3-Compatible API",
        redundancy: "3x Redundancy + Cross-region",
        access: "Public/Private Buckets",
        support: "24/7 Priority Support",
        versioning: "Object Versioning",
        cdn: "Free CDN Included",
        lifecycle: "Lifecycle Policies",
      },
    },
    // Dedicated Server Plans
    {
      name: "Dedicated Server Basic",
      category: "DEDICATED" as const,
      tier: "PREMIUM" as const,
      price: 3000,
      features: {
        cpu: "8 Cores Dedicated CPU",
        ram: "16 GB RAM",
        storage: "1 TB NVMe SSD",
        bandwidth: "Unmetered Bandwidth",
        access: "Full Root Access",
        network: "1 Gbps Network Port",
        setup: "Free Setup & Migration",
        support: "24/7 Priority Support",
        sla: "99.9% Uptime SLA",
      },
    },
    {
      name: "Dedicated Server Pro",
      category: "DEDICATED" as const,
      tier: "PREMIUM" as const,
      price: 5000,
      features: {
        cpu: "16 Cores Dedicated CPU",
        ram: "64 GB RAM",
        storage: "2 TB NVMe SSD (RAID 1)",
        bandwidth: "Unmetered Bandwidth",
        access: "Full Root Access + IPMI/KVM",
        network: "10 Gbps Network Port",
        setup: "Free Setup & Migration",
        support: "Dedicated Account Manager",
        sla: "99.99% Uptime SLA",
      },
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

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: {
        id: `${plan.category}_${plan.name.replace(/\s+/g, "_").toUpperCase()}`,
      },
      update: plan,
      create: {
        id: `${plan.category}_${plan.name.replace(/\s+/g, "_").toUpperCase()}`,
        ...plan,
      },
    });
  }

  console.log(`Seeded ${plans.length} plans`);
  console.log("Done!");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
