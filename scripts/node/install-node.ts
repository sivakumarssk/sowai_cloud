/**
 * Stage 2: turn a fresh Debian 12 Hetzner Cloud server into a Proxmox node.
 * Runs only in production, on sowsi-mgmt-01. Not wired to the engine or approvals.
 *
 *   npx tsx scripts/node/install-node.ts --name sowsi-proxmox-02 --type cpx22 [--ipv4]          # plan: cost + checks, buys nothing
 *   npx tsx scripts/node/install-node.ts --name sowsi-proxmox-02 --type cpx22 --execute --approved-by <name> [--ipv4] [--keep-on-failure]
 *   npx tsx scripts/node/install-node.ts --destroy <hetznerServerId>                              # plan
 *   npx tsx scripts/node/install-node.ts --destroy <hetznerServerId> --execute --approved-by <name>
 *
 * --execute buys the server (hourly billing starts) and runs every step; a re-run with the same
 * --name resumes at the first step that didn't finish. A failure before registration deletes the
 * server (unless --keep-on-failure). The node is registered closed: status PROVISIONING,
 * acceptNewClients false. Every step is logged to EngineLog (NODE_INSTALL_*, SERVER_PURCHASED).
 *
 * A node that doesn't come back from the reboot is recovered once through the Hetzner rescue
 * system: power cycle, diagnostics saved to /root/node-diagnostics, network repaired, install
 * resumed. A node holding customers is refused unless --allow-downtime is given.
 *
 * .env: MGMT_PUBLIC_IP, NODE_ADMIN_SSH_PUBLIC_KEY, HETZNER_API_TOKEN, PROVISIONING_SSH_* ;
 * optional NODE_INSTALL_KEY_PATH [~/.ssh/sowsi_install_ed25519], HETZNER_EUR_TO_INR [100].
 */
import { config as loadEnv } from "dotenv";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment("the node installer");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

/** One install at a time on this machine (they share the install key). */
function lock(): () => void {
  const dir = path.join(homedir(), ".sowsi");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "install-node.lock");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error(`another install-node is running (pid ${pid}, ${file})`);
    unlinkSync(file);
  }
  const fd = openSync(file, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

(async () => {
  const { prisma } = await import("../../src/lib/prisma");
  const N = await import("../../src/lib/nodes/installNode");
  const { prismaInstallDeps, installSettings, installKeyPath } = await import("../../src/lib/nodes/installNodeDeps");
  const deps = prismaInstallDeps();
  const settings = installSettings();
  const execute = flag("--execute");
  const approvedBy = value("--approved-by") ?? null;
  let unlock = () => {};

  try {
    // ── --destroy ──
    const destroyId = value("--destroy");
    if (flag("--destroy")) {
      if (!destroyId) throw new Error("usage: --destroy <hetznerServerId> [--execute --approved-by <name>]");
      const plan = await N.planDestroy(deps, destroyId, settings);
      console.log(`Destroy Hetzner server ${destroyId}:`);
      for (const l of plan.lines) console.log(`  · ${l}`);
      if (!plan.ok) {
        for (const p of plan.problems) console.log(`  ✗ ${p}`);
        process.exitCode = 1;
        return;
      }
      if (!execute) {
        console.log("\nPlan only — nothing changed. Add --execute --approved-by <name> to destroy.");
        return;
      }
      unlock = lock();
      const r = await N.executeDestroy(deps, destroyId, approvedBy, settings);
      for (const l of r.lines) console.log(`  ${r.ok ? "✓" : "✗"} ${l}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }

    // ── install ──
    const options = { name: value("--name") ?? "", serverType: value("--type") ?? "", ipv4Test: flag("--ipv4"), approvedBy, keepOnFailure: flag("--keep-on-failure"), allowDowntime: flag("--allow-downtime") };
    const plan = await N.planInstall(deps, options, settings);

    console.log(`Install node ${options.name || "?"} (${options.serverType || "?"}, ${settings.location}, ${settings.image})`);
    const resuming = plan.install?.status === "IN_PROGRESS";
    if (resuming) for (const l of N.resumeSummary(plan.install!)) console.log(l);
    for (const n of plan.notes ?? []) console.log(`  ! ${n}`);
    if (plan.cost) for (const l of plan.cost.lines) console.log(`  € ${l}`);
    if (plan.cost && plan.resumeFrom === "server") {
      const spent = await deps.db.spentThisMonthPaise();
      const r = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;
      console.log(`  spend this month ${r(spent)} + ${r(plan.cost.monthlyPaise)} = ${r(spent + plan.cost.monthlyPaise)} of the ${r(settings.spendCapPaise)} cap`);
    }
    console.log(`  install key: ${existsSync(`${installKeyPath()}.pub`) ? installKeyPath() : `${installKeyPath()} (created on --execute)`}`);
    console.log(`  test container: IPv6 only${options.ipv4Test ? " + a Floating IPv4 (--ipv4)" : ""}; sowsi-mgmt-01 IPv6: ${settings.mgmtHasIpv6 ? "yes" : "NO"}`);
    console.log("\nSteps:");
    for (const st of N.STEPS) {
      const done = plan.install?.status === "IN_PROGRESS" && plan.install.completedSteps.includes(st);
      console.log(`  ${done ? "✓" : st === plan.resumeFrom ? "→" : " "} ${N.STEP_TITLES[st]}`);
    }

    if (!plan.ok) {
      console.log("");
      for (const p of plan.problems) console.log(`✗ ${p}`);
      process.exitCode = 1;
      if (!execute) return;
    }
    if (!execute) {
      await deps.log({ action: "NODE_INSTALL_PLANNED", toNode: options.name, dryRun: true, after: { serverType: options.serverType, cost: plan.cost, resumeFrom: plan.resumeFrom } });
      console.log("\nPlan only — nothing bought. Add --execute --approved-by <your name> to buy and install.");
      return;
    }

    unlock = lock();
    console.log("");
    const result = await N.executeInstall(deps, options, settings);
    console.log(result.ok ? `\n✓ ${result.summary}` : `\n✗ ${result.error}`);
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    unlock();
    await prisma.$disconnect();
  }
})();
