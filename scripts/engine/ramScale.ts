/**
 * Step 5 live test: plan (and optionally apply) a RAM change on a container.
 *
 *   npx tsx scripts/engine/ramScale.ts --vmid 100 --plan-ram 2048                    # plan +512 MB, change nothing
 *   (with more than one node, add --node <name>: VM ids repeat across nodes)
 *   npx tsx scripts/engine/ramScale.ts --vmid 100 --plan-ram 2048 --execute          # apply (admin action)
 *   npx tsx scripts/engine/ramScale.ts --vmid 100 --plan-ram 2048 --to 2048 --execute # put it back to plan size
 *   npx tsx scripts/engine/ramScale.ts --service <serviceId> [--add 512 | --to <MB>] [--execute]
 *
 * --plan-ram is only needed for test containers without a service. Without
 * --execute nothing is changed or logged.
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
  const { RamScaler } = await import("../../src/engine/actions/RamScaler");
  const { prismaRamDeps, targetForService, targetForContainer } = await import("../../src/engine/data/actionDeps");
  const { prisma } = await import("../../src/lib/prisma");

  try {
    const serviceId = value("--service");
    const vmid = numberArg("--vmid");
    if (!serviceId && vmid === undefined) throw new Error("pass --vmid <id> (with --plan-ram) or --service <id>");
    const target = serviceId
      ? await targetForService(serviceId)
      : await targetForContainer({ nodeName: value("--node"), vmid: vmid!, planRamMB: numberArg("--plan-ram") ?? 0, planDiskGB: 0 });
    if (!target.planRamMB) throw new Error("unknown plan RAM: pass --plan-ram <MB> for a container without a service");

    const config = loadEngineConfig();
    const scaler = new RamScaler(prismaRamDeps(), config);
    const { floorMB, ceilingMB } = scaler.limits(target);
    console.log(
      `Container ${target.vmid} on ${target.node.name} · ${target.serviceId ? `service ${target.serviceId}` : "test container (no service)"} · plan ${target.planRamMB} MB · allowed ${floorMB}–${ceilingMB} MB`
    );

    const to = numberArg("--to");
    const plan = await scaler.plan(
      target,
      to !== undefined ? { toMB: to, reason: "manual test" } : { addMB: numberArg("--add"), reason: "manual test" }
    );
    if (!plan.ok) {
      console.log(`Plan: not possible — ${plan.reason}${plan.next ? ` (next: ${plan.next.detail})` : ""}`);
      return;
    }
    console.log(`Plan: ${plan.summary}${plan.clamped ? " — trimmed to the allowed range" : ""}`);

    const settings = loadEngineSettings();
    const verdict = gate({ kind: "RAM_SCALE", settings, monthlyCostPaise: 0, spentThisMonthPaise: 0, trigger: "AUTO_ENGINE" });
    console.log(`The engine on its own would: ${verdict.verdict} — ${verdict.reason} (ENGINE_MODE=${settings.mode}, RAM_SCALE=${settings.actions.RAM_SCALE})`);

    if (!flag("--execute")) {
      console.log("\nNothing changed. Add --execute to apply it as an admin action.");
      return;
    }
    const started = Date.now();
    const result = await scaler.execute(plan, "MANUAL");
    console.log(`\n✓ Applied in ${Date.now() - started} ms — container ${target.vmid} now has ${result.afterMB} MB (verified, logged to EngineLog)`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
