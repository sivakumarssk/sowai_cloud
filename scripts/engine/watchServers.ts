/**
 * Step 4 test harness: runs the ServerMonitor and prints node health + events.
 *
 *   npx tsx scripts/engine/watchServers.ts                 # simulated node (local)
 *   npx tsx scripts/engine/watchServers.ts --live --once   # real Proxmox, one poll (sowsi-mgmt-01)
 *   npx tsx scripts/engine/watchServers.ts --live          # every 30 s until Ctrl+C
 *   add --no-save to skip updating the ProxmoxNode row
 *
 * Read-only towards Proxmox.
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
  const { EventBus } = await import("../../src/engine/core/EventBus");
  const { loadEngineConfig } = await import("../../src/engine/config");
  const { ServerMonitor } = await import("../../src/engine/monitors/ServerMonitor");
  type Sample = import("../../src/engine/monitors/ServerMonitor").ServerSample;

  const config = loadEngineConfig();
  const bus = new EventBus();
  const pending: string[] = [];
  bus.subscribe("*", (e) => {
    const d = e.data as { pct: number; resource?: string; sustainedSeconds?: number };
    pending.push(`  ⚡ ${e.type.padEnd(22)} ${e.subject}  ${d.resource ?? ""} ${d.pct}%${d.sustainedSeconds ? ` for ${d.sustainedSeconds}s` : ""}`);
  });

  let deps;
  let advance = () => {};
  if (live) {
    const { prismaServerDeps } = await import("../../src/engine/data/serverDeps");
    deps = prismaServerDeps();
    if (!save) deps.saveNode = async () => {};
  } else {
    const { SimulatedServers, flat, steps } = await import("../../src/engine/testing/simulatedProxmox");
    const sim = new SimulatedServers([
      {
        id: "sim_node",
        name: "sowsi-proxmox-01 (simulated)",
        ip: "203.0.113.10",
        hetznerServerId: "168392011",
        volumes: [],
        ramTotalMB: 8192,
        diskTotalGB: 150,
        cores: 4,
        ramPct: steps(45, 66, 74, 83, 88),
        diskPct: steps(40, 55, 72, 72, 72),
        cpuPct: flat(25),
        allocatedDiskGB: 80,
        containers: [
          { vmid: 100, running: true, ramMB: 2048 },
          { vmid: 101, running: true, ramMB: 4096 },
          { vmid: 102, running: false, ramMB: 2048 },
        ],
      },
    ]);
    deps = sim.deps();
    advance = () => sim.advance();
  }

  const monitor = new ServerMonitor(bus, deps, config);
  const print = (samples: Sample[]) => {
    const stats = monitor.stats();
    console.log(`\n── poll #${stats.polls} · ${new Date().toLocaleTimeString("en-IN")} · ${stats.lastPollMs} ms`);
    for (const [node, error] of Object.entries(stats.nodeErrors)) console.log(`  ✗ ${node}: ${error}`);
    if (samples.length === 0) return console.log("  (no nodes — run npm run db:seed to register sowsi-proxmox-01)");
    console.table(
      samples.map((s) => ({
        node: s.nodeName,
        health: s.status,
        ram: `${Math.round(s.physicalRamUsed / MB)}/${Math.round(s.physicalRam / MB)} MB (${s.physicalRamPct}%)`,
        disk: `${(s.physicalDiskUsed / GB).toFixed(1)}/${(s.physicalDisk / GB).toFixed(0)} GB (${s.physicalDiskPct}%)`,
        "disk promised": `${(s.allocatedDisk / GB).toFixed(0)} GB`,
        "free pool": `${(s.freePoolBytes / GB).toFixed(0)} GB`,
        cpu: `${s.physicalCpuPct}% of ${s.physicalCpu}`,
        containers: `${s.activeContainers}/${s.totalContainers} running`,
        "RAM promised": `${Math.round(s.allocatedRam / MB)} MB`,
        volumes: s.volumes.length ? `${s.volumes.length} (${(s.volumeUsedSpace / GB).toFixed(0)}/${(s.volumeTotalSpace / GB).toFixed(0)} GB)` : "none",
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

  console.log(
    `ServerMonitor ${live ? "LIVE (Proxmox)" : "SIMULATED"} · thresholds ${config.serverWarningPct}/${config.serverCriticalPct}/${config.serverEmergencyPct}% · full ${config.serverFullPct}% · reserve ${config.diskPoolReserveGB} GB${live && save ? " · updating ProxmoxNode" : ""}`
  );

  if (!live) for (let i = 0; i < 5; i++) await runPoll();
  else if (once) await runPoll();
  else {
    await runPoll();
    const timer = setInterval(() => void runPoll(), config.serverPollMs);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
    return;
  }

  console.log(`\nEvents: ${bus.stats().published} published, ${bus.stats().deduplicated} suppressed as repeats`);
  if (live) await (await import("../../src/lib/prisma")).prisma.$disconnect();
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
