/**
 * Step 7: Hetzner Volumes for a node. Buying or deleting needs --approved-by.
 *
 *   npx tsx scripts/engine/volume.ts                                     # plan a Volume (default size) — buys nothing
 *   npx tsx scripts/engine/volume.ts --size 10                           # plan a 10 GB Volume
 *   npx tsx scripts/engine/volume.ts --size 10 --execute --approved-by NAME   # buy, attach, mount, register as storage
 *   npx tsx scripts/engine/volume.ts --list                              # Volumes in the database + what's on them
 *   npx tsx scripts/engine/volume.ts --remove <id> --approved-by NAME    # unmount + delete (refused while disks are on it)
 *   add --node <name> for a node other than PROXMOX_NODE
 *
 * Every purchase is checked against this month's ₹5,000 engine spend cap;
 * going over it needs --allow-over-cap as well.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

(async () => {
  const { loadEngineConfig } = await import("../../src/engine/config");
  const { loadEngineSettings } = await import("../../src/engine/core/policy");
  const { VolumeManager } = await import("../../src/engine/actions/VolumeManager");
  const { prismaVolumeDeps, volumeNode } = await import("../../src/engine/data/volumeDeps");
  const { proxmoxForNode } = await import("../../src/lib/proxmox");
  const { prisma } = await import("../../src/lib/prisma");

  const config = loadEngineConfig();
  const settings = loadEngineSettings();
  const manager = new VolumeManager(prismaVolumeDeps(), {
    volumeCostPerGbPaise: config.volumeCostPerGbPaise,
    defaultSizeGB: config.volumeSizeGB,
    spendCapPaise: settings.spendCapPaise,
  });
  const approvedBy = value("--approved-by");

  try {
    if (flag("--list")) {
      const rows = await prisma.hetznerVolume.findMany({ include: { node: { select: { name: true, ip: true } } }, orderBy: { createdAt: "desc" } });
      if (rows.length === 0) return console.log("No Volumes recorded.");
      for (const v of rows) {
        let disks = "";
        if (v.status === "ACTIVE" && v.proxmoxStorage) {
          const list = await proxmoxForNode(v.node).listStorageVolumes(v.proxmoxStorage).catch((e: Error) => [{ volid: `(error: ${e.message})` }]);
          disks = list.length ? list.map((d) => d.volid).join(", ") : "empty";
        }
        console.log(
          `${v.id}  hetzner ${v.hetznerVolumeId}  ${v.sizeGB} GB  ${v.status.padEnd(9)} ${v.node.name}  ${v.proxmoxStorage ?? "-"}  ${rupees(v.costPerMonth)}/mo${disks ? `  disks: ${disks}` : ""}`
        );
      }
      return;
    }

    const removeId = value("--remove");
    if (removeId) {
      const v = await prisma.hetznerVolume.findUniqueOrThrow({ where: { id: removeId } });
      if (v.status === "DELETED") throw new Error(`${removeId} is already deleted`);
      const node = await volumeNode((await prisma.proxmoxNode.findUniqueOrThrow({ where: { id: v.nodeId } })).name);
      console.log(`Removing Volume ${v.hetznerVolumeId} (${v.sizeGB} GB, ${v.proxmoxStorage ?? "not registered"}) from ${node.name}…`);
      await manager.remove({ id: v.id, hetznerVolumeId: v.hetznerVolumeId, proxmoxStorage: v.proxmoxStorage, sizeGB: v.sizeGB, node }, { approvedBy: approvedBy ?? "" });
      console.log("✓ unmounted, detached and deleted at Hetzner; row marked DELETED");
      return;
    }

    const size = value("--size");
    const node = await volumeNode(value("--node"));
    const plan = await manager.plan(node, { sizeGB: size ? Number(size) : undefined, reason: "admin request (scripts/engine/volume.ts)" });
    if (!plan.ok) throw new Error(plan.reason);

    console.log(`Plan: ${plan.summary}`);
    console.log(`  engine spend this month: ${rupees(plan.spentThisMonthPaise)} → ${rupees(plan.spentThisMonthPaise + plan.monthlyCostPaise)} (cap ${rupees(settings.spendCapPaise)})`);
    if (!flag("--execute")) return console.log("\nNothing bought. Add --execute --approved-by <your name> to buy it.");
    if (plan.overCap && !flag("--allow-over-cap")) throw new Error("over the monthly spend cap — add --allow-over-cap to approve that too");

    console.log(`\nBuying (approved by ${approvedBy ?? "nobody"})…`);
    const v = await manager.execute(plan, { approvedBy: approvedBy ?? "" });
    console.log(`✓ Volume ${v.hetznerVolumeId} attached to ${node.name} and registered as Proxmox storage ${v.storage} (row ${v.id})`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
