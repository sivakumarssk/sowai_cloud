/**
 * Step 3 test harness: runs the ContainerMonitor and prints metrics + events.
 *
 *   npx tsx scripts/engine/watchContainers.ts                 # simulated containers (local)
 *   npx tsx scripts/engine/watchContainers.ts --live --once   # real Proxmox, one poll (sowsi-mgmt-01)
 *   npx tsx scripts/engine/watchContainers.ts --live          # real Proxmox, every 30 s until Ctrl+C
 *   add --no-save to skip writing ResourceMetric rows
 *
 * Read-only: the monitor never changes containers.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const once = args.has("--once");
const save = !args.has("--no-save");

const GB = 1024 ** 3;
const MB = 1024 ** 2;

(async () => {
  // Imported after the env is loaded: Prisma reads DATABASE_URL at import time.
  const { EventBus } = await import("../../src/engine/core/EventBus");
  const { loadEngineConfig } = await import("../../src/engine/config");
  const { ContainerMonitor } = await import("../../src/engine/monitors/ContainerMonitor");
  type Sample = import("../../src/engine/monitors/ContainerMonitor").ContainerSample;

  const config = loadEngineConfig();
  const bus = new EventBus();
  // Handlers can run while the poll is still saving metrics; buffer and print under that poll's table.
  const pending: string[] = [];
  bus.subscribe("*", (e) => {
    const d = e.data as { pct: number; used: number; limit: number; unit: string; vmid?: number };
    pending.push(`  ⚡ ${e.type.padEnd(14)} ${e.subject}  vmid ${d.vmid}  ${d.pct}%  (${d.used} / ${d.limit} ${d.unit})`);
  });

  let deps;
  let advance = () => {};
  if (live) {
    const { prismaContainerDeps } = await import("../../src/engine/data/containerDeps");
    deps = prismaContainerDeps();
    if (!save) deps.saveSamples = async () => {};
  } else {
    const { SimulatedCluster, flat, steps } = await import("../../src/engine/testing/simulatedProxmox");
    const cluster = new SimulatedCluster([
      {
        id: "sim_node",
        name: "sowsi-proxmox-01 (simulated)",
        ip: "203.0.113.10",
        containers: [
          { vmid: 101, name: "client-a", serviceId: "svc_aaaa", ramMB: 2048, diskGB: 40, cores: 1, ramPct: steps(40, 60, 78, 88, 96), diskPct: flat(35), cpuPct: flat(12) },
          { vmid: 102, name: "client-b", serviceId: "svc_bbbb", ramMB: 4096, diskGB: 80, cores: 2, ramPct: flat(45), diskPct: steps(70, 80, 88, 93, 99), cpuPct: flat(30) },
          { vmid: 103, name: "client-c", serviceId: "svc_cccc", ramMB: 8192, diskGB: 160, cores: 4, ramPct: flat(20), diskPct: flat(10), cpuPct: flat(3) },
          { vmid: 900, name: "test-ct (no service)", serviceId: null, ramMB: 2048, diskGB: 20, cores: 1, ramPct: flat(97), diskPct: flat(50), cpuPct: flat(90) },
        ],
      },
    ]);
    deps = cluster.deps();
    advance = () => cluster.advance();
  }

  const monitor = new ContainerMonitor(bus, deps, config);
  const print = (samples: Sample[]) => {
    const stats = monitor.stats();
    console.log(
      `\n── poll #${stats.polls} · ${new Date().toLocaleTimeString("en-IN")} · ${stats.containers} containers (${stats.managed} managed) · ${stats.lastPollMs} ms`
    );
    for (const [node, error] of Object.entries(stats.nodeErrors)) console.log(`  ✗ ${node}: ${error}`);
    if (samples.length === 0) return console.log("  (no containers)");
    console.table(
      samples.map((s) => ({
        node: s.nodeName,
        vmid: s.vmid,
        name: s.name ?? "",
        service: s.serviceId ? s.serviceId.slice(0, 10) : "— unmanaged",
        status: s.status,
        ram: `${Math.round(s.memUsed / MB)}/${Math.round(s.memLimit / MB)} MB (${s.memPct}%)`,
        disk: `${(s.diskUsed / GB).toFixed(1)}/${(s.diskLimit / GB).toFixed(0)} GB (${s.diskPct}%)`,
        cpu: `${(s.cpuUsed * 100).toFixed(1)}% of ${s.cpuCores}`,
      }))
    );
  };

  const runPoll = async () => {
    const samples = await monitor.pollOnce();
    await bus.drain();
    print(samples);
    for (const line of pending.splice(0)) console.log(line);
    advance();
  };

  console.log(`ContainerMonitor ${live ? "LIVE (Proxmox)" : "SIMULATED"} · thresholds RAM ${config.ramWarningPct}/${config.ramCriticalPct}/${config.ramEmergencyPct}% · disk ${config.diskWarningPct}/${config.diskCriticalPct}/${config.diskFullPct}%${live && save ? " · saving metrics" : ""}`);

  if (!live) {
    for (let i = 0; i < 5; i++) await runPoll();
  } else if (once) {
    await runPoll();
  } else {
    await runPoll();
    const timer = setInterval(() => void runPoll(), config.containerPollMs);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
    return;
  }

  const { counts } = { counts: bus.stats() };
  console.log(`\nEvents: ${counts.published} published, ${counts.deduplicated} suppressed as repeats`);
  if (live) {
    const { prisma } = await import("../../src/lib/prisma");
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
