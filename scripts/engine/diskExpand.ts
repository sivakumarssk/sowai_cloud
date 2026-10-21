/**
 * Step 6 live test: plan (and optionally apply) a disk expansion.
 *
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20                          # plan /data +10 GB
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20 --opt-in --execute       # create /data (test container)
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20 --opt-in --add 5 --execute  # grow /data by 5 GB
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --remove-data                          # test cleanup: remove /data + its disk
 *   npx tsx scripts/engine/diskExpand.ts --service <id> [--purpose grow|extra] [--add N] [--execute]
 *
 * --opt-in pretends a TEST container's client enabled overage (refused for
 * real services — their consent comes from the database). --purpose grow
 * raises the root disk to the plan size instead. Without --execute nothing changes.
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
const numberArg = (name: string) => {
  const v = value(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

(async () => {
  const { loadEngineConfig } = await import("../../src/engine/config");
  const { loadEngineSettings, gate } = await import("../../src/engine/core/policy");
  const { DiskExpander } = await import("../../src/engine/actions/DiskExpander");
  const { readContainerDisks } = await import("../../src/engine/actions/lxcConfig");
  const { prismaDiskDeps, targetForService, targetForContainer } = await import("../../src/engine/data/actionDeps");
  const { proxmoxForNode } = await import("../../src/lib/proxmox");
  const { prisma } = await import("../../src/lib/prisma");

  try {
    const serviceId = value("--service");
    const vmid = numberArg("--vmid");
    if (!serviceId && vmid === undefined) throw new Error("pass --vmid <id> (with --plan-disk) or --service <id>");
    const target = serviceId
      ? await targetForService(serviceId)
      : await targetForContainer({ nodeName: value("--node"), vmid: vmid!, planRamMB: 0, planDiskGB: numberArg("--plan-disk") ?? 0 });
    const pve = proxmoxForNode(target.node);

    // ── Test cleanup: remove /data and destroy its disk (test containers only) ──
    if (flag("--remove-data")) {
      if (target.serviceId) throw new Error("--remove-data is only for test containers; this one belongs to a client service");
      const before = readContainerDisks(await pve.getLXCConfig(target.vmid));
      if (!before.data) return console.log(`Container ${target.vmid} has no /data mount. Nothing to remove.`);
      await pve.updateLXCConfig(target.vmid, { delete: before.data.key });
      const after = await pve.getLXCConfig(target.vmid);
      if (before.data.key in after) {
        return console.log(`Removal of ${before.data.key} is pending until the container restarts. Run: pct reboot ${target.vmid}, then this command again.`);
      }
      const unused = Object.entries(after).find(([k, v]) => /^unused\d+$/.test(k) && String(v) === before.data!.volume);
      if (unused) await pve.updateLXCConfig(target.vmid, { delete: unused[0] });
      const left = (await pve.listStorageVolumes(before.data.storage)).some((v) => v.volid === before.data!.volume);
      console.log(left ? `✗ /data unmounted but ${before.data.volume} still exists — remove it in the Proxmox UI` : `✓ /data removed and ${before.data.volume} destroyed`);
      return;
    }

    if (!target.planDiskGB) throw new Error("unknown plan disk: pass --plan-disk <GB> for a container without a service");
    const config = loadEngineConfig();
    const deps = prismaDiskDeps(config);
    if (flag("--opt-in")) {
      if (target.serviceId) throw new Error("--opt-in is only for test containers; a client's overage consent comes from the database");
      deps.overageOptIn = async () => true;
    }
    const expander = new DiskExpander(deps, config);

    const disks = await deps.readDisks(target);
    const volumes = await deps.volumes(target.node);
    console.log(
      `Container ${target.vmid} on ${target.node.name} · ${target.serviceId ? `service ${target.serviceId}` : "test container (no service)"} · plan ${target.planDiskGB} GB`
    );
    console.log(
      `Now: root ${disks.root.sizeGB} GB on ${disks.root.storage} · /data ${disks.data ? `${disks.data.sizeGB} GB on ${disks.data.storage} (${disks.data.key})` : "none"} · free pool ${Math.floor(await expander.poolFreeGB(target.node))} GB (after ${config.diskPoolReserveGB} GB reserve) · Volumes: ${volumes.length ? volumes.map((v) => `${v.storage} ${Math.round(v.allocatedGB)}/${v.sizeGB} GB`).join(", ") : "none"}`
    );

    const purpose = value("--purpose") === "grow" ? "GROW_TO_PLAN" : "EXTRA_SPACE";
    const plan = await expander.plan(target, { purpose, addGB: numberArg("--add"), reason: "manual test" });
    if (!plan.ok) {
      console.log(`Plan: not possible — ${plan.reason}${plan.next ? ` (next: ${plan.next.detail}${plan.next.monthlyCostPaise ? `, ₹${plan.next.monthlyCostPaise / 100}/mo` : ""})` : ""}`);
      return;
    }
    console.log(`Plan: ${plan.summary} · new monthly spend ₹${plan.monthlyCostPaise / 100}${plan.attributedCostPaise ? ` · uses ₹${plan.attributedCostPaise / 100}/mo of an existing Volume` : ""}`);

    const settings = loadEngineSettings();
    const verdict = gate({ kind: "DISK_EXPAND", settings, monthlyCostPaise: plan.monthlyCostPaise, spentThisMonthPaise: 0, trigger: "AUTO_ENGINE" });
    console.log(`The engine on its own would: ${verdict.verdict} — ${verdict.reason} (ENGINE_MODE=${settings.mode}, DISK_EXPAND=${settings.actions.DISK_EXPAND})`);

    if (!flag("--execute")) {
      console.log("\nNothing changed. Add --execute to apply it as an admin action.");
      return;
    }
    const started = Date.now();
    const result = await expander.execute(plan, "MANUAL");
    console.log(`\n✓ Applied in ${Date.now() - started} ms — root ${result.rootGB} GB, /data ${result.dataGB} GB (verified, logged to EngineLog)`);
    if (plan.operation === "CREATE_DATA") console.log(`  Check inside the container: pct exec ${target.vmid} -- df -h /data`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
