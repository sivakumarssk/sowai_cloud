-- Data migration: VPS plan features now match what provisionVPS actually
-- creates (PLAN_RESOURCES in src/lib/provisioning/provisionVPS.ts).
UPDATE "Plan" SET "features" = "features"::jsonb || '{"cpu": "1 vCPU Core",  "ram": "2 GB RAM", "storage": "40 GB NVMe SSD",  "ip": "1 Dedicated IPv4 + IPv6"}'::jsonb WHERE "id" = 'VPS_VPS_BASIC';
UPDATE "Plan" SET "features" = "features"::jsonb || '{"cpu": "2 vCPU Cores", "ram": "4 GB RAM", "storage": "80 GB NVMe SSD",  "ip": "1 Dedicated IPv4 + IPv6"}'::jsonb WHERE "id" = 'VPS_VPS_PRO';
UPDATE "Plan" SET "features" = "features"::jsonb || '{"cpu": "4 vCPU Cores", "ram": "8 GB RAM", "storage": "160 GB NVMe SSD", "ip": "1 Dedicated IPv4 + IPv6"}'::jsonb WHERE "id" = 'VPS_VPS_ELITE';
