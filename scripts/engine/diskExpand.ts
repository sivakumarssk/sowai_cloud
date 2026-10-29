/**
 * Step 6 live test: plan (and optionally apply) a disk expansion.
 *
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20                          # plan /data +10 GB
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20 --opt-in --execute       # create /data (test container)
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --plan-disk 20 --opt-in --add 5 --execute  # grow /data by 5 GB
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --remove-data                          # test cleanup: remove /data (running → queued until restart, nothing destroyed)
 *   npx tsx scripts/engine/diskExpand.ts --vmid 100 --free-orphans                         # destroy detached vm-100-* disks (unusedN entries + stray files)
 *   npx tsx scripts/engine/diskExpand.ts --service <id> [--purpose grow|extra] [--add N] [--execute]
 *
 * --opt-in pretends a TEST container's client enabled overage (refused for
 * real services — their consent comes from the database). --purpose grow
 * raises the root disk to the plan size instead. Without --execute nothing changes.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

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
  const { prismaDiskDeps, targetForService, targetForContainer } = await import("../../src/engine/data/actionDeps");
  const { proxmoxForNode } = await import("../../src/lib/proxmox");
  const { detachDataDisk, freeContainerDisks } = await import("../../src/lib/containerDisks");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");
  const { prisma } = await import("../../src/lib/prisma");

  try {
    const serviceId = value("--service");
    const vmid = numberArg("--vmid");
    if (!serviceId && vmid === undefined) throw new Error("pass --vmid <id> (with --plan-disk) or --service <id>");
    const target = serviceId
      ? await targetForService(serviceId)
      : await targetForContainer({ nodeName: value("--node"), vmid: vmid!, planRamMB: 0, planDiskGB: numberArg("--plan-disk") ?? 0 });
    const pve = proxmoxForNode(target.node);

    // ── Test cleanup (test containers only). Disks are destroyed through the
    // storage API and verified against the storage listing — never the
    // container config, which can forget a disk that still exists. ──
    const report = async (action: string, freed: string[], leftover: string[], errors: string[]) => {
      for (const v of freed) console.log(`✓ destroyed ${v} (gone from storage listing and config)`);
      if (leftover.length === 0) return;
      const error = `still on storage after delete: ${leftover.join(", ")}${errors.length ? ` (${errors.join("; ")})` : ""}`;
      await prismaEngineLog({ action, vmid: target.vmid, fromNode: target.node.name, after: { leftover, freed }, trigger: "MANUAL", success: false, error });
      console.log(`✗ ${error} — logged to EngineLog. Retry: npx tsx scripts/engine/diskExpand.ts --vmid ${target.vmid} --free-orphans`);
      process.exitCode = 1;
    };

    if (flag("--remove-data") || flag("--free-orphans")) {
      if (target.serviceId) throw new Error("cleanup flags are only for test containers; this one belongs to a client service");
    }

    if (flag("--remove-data")) {
      const r = await detachDataDisk(pve, target.vmid);
      if (r.status === "NO_DATA") {
        console.log(`Container ${target.vmid} has no /data mount.`);
        if (r.unused.length) console.log(`Detached disks still in its config: ${r.unused.join(", ")} — run --free-orphans to destroy them.`);
        return;
      }
      if (r.status === "PENDING_RESTART") {
        // Never restart the container ourselves (downtime) and never destroy a disk it still has mounted.
        await prismaEngineLog({
          action: "DATA_DISK_DETACH_PENDING",
          vmid: target.vmid,
          fromNode: target.node.name,
          after: { key: r.key, volume: r.volume, detail: r.detail },
          trigger: "MANUAL",
        });
        console.log(`… pending restart: ${r.detail}.`);
        console.log(`  Nothing destroyed — ${r.volume ?? "the disk"} stays on storage and mounted until the container restarts.`);
        console.log(`  After the next restart run: npx tsx scripts/engine/diskExpand.ts --vmid ${target.vmid} --free-orphans`);
        return;
      }
      console.log(`✓ /data (${r.key}) detached — container was stopped, so it applied immediately`);
      await report("DATA_DISK_LEFT_OVER", r.cleanup.freed, r.cleanup.leftover, r.cleanup.errors);
      return;
    }

    if (flag("--free-orphans")) {
      // Every vm-<vmid>-* disk not attached by rootfs/mpN (now or after restart): unusedN entries and stray files.
      const result = await freeContainerDisks(pve, target.vmid);
      const kept = result.kept.filter((k) => !k.keys.includes("rootfs"));
      for (const k of kept) console.log(`• kept ${k.volid} — still attached as ${k.keys.join(", ")}`);
      if (result.freed.length === 0 && result.leftover.length === 0) {
        console.log(`No orphaned vm-${target.vmid}-* disks (storage listings and config unusedN entries checked).`);
      }
      await report("ORPHAN_DISK_LEFT_OVER", result.freed, result.leftover, result.errors);
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
    if (result.queuedUntilRestart) {
      console.log(`
… queued until restart: ${result.queuedUntilRestart}. Proxmox applies it when the container next restarts (the engine never restarts it). Logged to EngineLog.`);
      return;
    }
    console.log(`\n✓ Applied in ${Date.now() - started} ms — root ${result.rootGB} GB, /data ${result.dataGB} GB (verified, logged to EngineLog)`);
    if (plan.operation === "CREATE_DATA") console.log(`  Check inside the container: pct exec ${target.vmid} -- df -h /data`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
