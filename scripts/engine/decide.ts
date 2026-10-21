/**
 * Step 8: monitors → DecisionMaker → ActionExecutor, end to end.
 *
 *   npx tsx scripts/engine/decide.ts                      # simulated cluster, settings from .env (OBSERVE by default)
 *   npx tsx scripts/engine/decide.ts --mode ASSISTED      # simulated, as if ENGINE_MODE=ASSISTED
 *   npx tsx scripts/engine/decide.ts --mode AUTO --spent 4800   # simulated, ₹4,800 already spent this month
 *   npx tsx scripts/engine/decide.ts --live --once        # real Proxmox + database: one poll, decide, exit (sowsi-mgmt-01)
 *   npx tsx scripts/engine/decide.ts --live               # keep running: poll every 30 s, process approvals every minute
 *
 * Simulated runs change nothing anywhere (in-memory approvals, printed actions).
 * Live runs obey ENGINE_MODE / ENGINE_ACTION_* exactly like the engine: in
 * OBSERVE every decision is only written to EngineLog (dryRun = true).
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
const live = flag("--live");
const once = flag("--once");

(async () => {
  const { EventBus } = await import("../../src/engine/core/EventBus");
  const { loadEngineConfig } = await import("../../src/engine/config");
  const { loadEngineSettings } = await import("../../src/engine/core/policy");
  const { ContainerMonitor } = await import("../../src/engine/monitors/ContainerMonitor");
  const { ServerMonitor } = await import("../../src/engine/monitors/ServerMonitor");
  type ActionExecutor = import("../../src/engine/core/ActionExecutor").ActionExecutor;
  type DecisionMaker = import("../../src/engine/core/DecisionMaker").DecisionMaker;

  const config = loadEngineConfig();
  const env = { ...process.env, ...(value("--mode") ? { ENGINE_MODE: value("--mode") } : {}) };
  const settings = () => loadEngineSettings(env);
  const s = settings();
  const bus = new EventBus();
  const lines: string[] = [];
  const mails: string[] = [];

  let containerDeps, serverDeps;
  let executor: ActionExecutor;
  let decisionMaker: DecisionMaker;
  let advance = () => {};

  if (live) {
    const { prismaContainerDeps } = await import("../../src/engine/data/containerDeps");
    const { prismaServerDeps } = await import("../../src/engine/data/serverDeps");
    const { buildDecisionEngine } = await import("../../src/engine/data/decisionDeps");
    containerDeps = prismaContainerDeps();
    serverDeps = prismaServerDeps();
    ({ executor, decisionMaker } = buildDecisionEngine(config, settings));
  } else {
    ({ containerDeps, serverDeps, executor, decisionMaker, advance } = await simulated(config, settings, (line) => mails.push(line)));
  }

  const containerMonitor = new ContainerMonitor(bus, containerDeps, config);
  const serverMonitor = new ServerMonitor(bus, serverDeps, config);
  decisionMaker.attach(bus, (event, results) => {
    const d = event.data as { pct: number };
    lines.push(`  ⚡ ${event.type} ${event.subject} (${d.pct}%)${results.length ? "" : "  → no action"}`);
    for (const { decision, outcome } of results) lines.push(`      ${describe(decision, outcome)}`);
    lines.push(...mails.splice(0));
  });

  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
  console.log(
    `Decisions ${live ? "LIVE" : "SIMULATED"} · ENGINE_MODE=${s.mode} · cap ${rupees(s.spendCapPaise)}/month\n` +
      `  actions: ${Object.entries(s.actions).map(([k, v]) => `${k}=${v}`).join(" ")}`
  );

  const cycle = async (label: string) => {
    await serverMonitor.pollOnce(); // node RAM first, the RAM rules depend on it
    await containerMonitor.pollOnce();
    await bus.drain();
    const approvals = await executor.processApprovals();
    console.log(`\n── ${label}`);
    console.log(lines.length ? lines.splice(0).join("\n") : "  (no events)");
    if (approvals.expired || approvals.executed || approvals.failed) {
      console.log(`  approvals: ${approvals.expired} expired, ${approvals.executed} executed, ${approvals.failed} failed`);
    }
    advance();
  };

  if (!live) {
    for (let i = 1; i <= 5; i++) await cycle(`poll ${i}`);
    console.log(`\n${JSON.stringify(decisionMaker.stats())} — simulated: nothing was changed anywhere.`);
    return;
  }

  const { prisma } = await import("../../src/lib/prisma");
  if (once) {
    await cycle(new Date().toLocaleTimeString("en-IN"));
    console.log(`\n${JSON.stringify(decisionMaker.stats())} — every decision is in EngineLog (action DECISION_*).`);
    await prisma.$disconnect();
    return;
  }

  await cycle(new Date().toLocaleTimeString("en-IN"));
  const pollTimer = setInterval(() => void cycle(new Date().toLocaleTimeString("en-IN")).catch((e) => console.error("✗ cycle:", e)), config.containerPollMs);
  process.on("SIGINT", () => {
    clearInterval(pollTimer);
    void prisma.$disconnect().finally(() => process.exit(0));
  });
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});

function describe(d: import("../../src/engine/core/decisions").Decision, o: import("../../src/engine/core/ActionExecutor").ExecutionOutcome): string {
  const what: Record<string, string> = {
    LOG_ONLY: "logged only",
    BLOCKED: "blocked",
    RECOMMEND: "recommended to admin",
    REQUEST_APPROVAL: `approval requested${o.approvalId ? ` (${o.approvalId})` : ""}`,
    EXECUTE: `EXECUTED → ${o.result}`,
  };
  return `${d.kind.padEnd(15)} ${d.summary}\n        ${what[o.verdict]} — ${o.reason}`;
}

/** A simulated node whose RAM climbs to an emergency, with three client containers in trouble. */
async function simulated(
  config: import("../../src/engine/config").EngineConfig,
  settings: () => import("../../src/engine/core/policy").EngineSettings,
  print: (line: string) => void
) {
  const { SimulatedCluster, SimulatedServers, steps, flat } = await import("../../src/engine/testing/simulatedProxmox");
  const { ActionExecutor } = await import("../../src/engine/core/ActionExecutor");
  const { DecisionMaker } = await import("../../src/engine/core/DecisionMaker");
  type Decision = import("../../src/engine/core/decisions").Decision;
  type ApprovalStore = import("../../src/engine/core/ActionExecutor").ApprovalStore;

  const node = { id: "sim_node", name: "sowsi-proxmox-01 (sim)", ip: "203.0.113.10" };
  const nodeRam = steps(55, 72, 78, 86, 93);
  const cluster = new SimulatedCluster([
    {
      ...node,
      containers: [
        { vmid: 101, name: "ram-hungry", serviceId: "svc_ram", ramMB: 2048, diskGB: 40, cores: 2, ramPct: steps(70, 88, 88, 90, 97), diskPct: flat(30), cpuPct: flat(20) },
        { vmid: 102, name: "disk-overage", serviceId: "svc_overage", ramMB: 4096, diskGB: 80, cores: 2, ramPct: flat(40), diskPct: steps(70, 80, 88, 88, 88), cpuPct: flat(10) },
        { vmid: 103, name: "disk-no-overage", serviceId: "svc_plain", ramMB: 2048, diskGB: 20, cores: 1, ramPct: flat(30), diskPct: steps(80, 90, 99, 99, 99), cpuPct: flat(5) },
      ],
    },
  ]);
  const servers = new SimulatedServers([
    {
      ...node,
      hetznerServerId: "168392011",
      volumes: [],
      ramTotalMB: 8192,
      diskTotalGB: 150,
      cores: 4,
      ramPct: nodeRam,
      diskPct: flat(60),
      cpuPct: flat(30),
      allocatedDiskGB: 140,
      containers: [101, 102, 103].map((vmid) => ({ vmid, running: true, ramMB: 2048 })),
    },
  ]);
  const targets = Object.fromEntries(
    cluster.nodes[0].containers.map((c) => [c.serviceId!, { node, vmid: c.vmid, serviceId: c.serviceId, planRamMB: c.ramMB, planDiskGB: c.diskGB }])
  );
  const ram = new Map<string, number>(Object.entries(targets).map(([id, t]) => [id, t.planRamMB]));

  const rows: { id: string; kind: string; subject: string; status: string }[] = [];
  const approvals: ApprovalStore = {
    findOpen: async (kind, subject) => rows.find((r) => r.kind === kind && r.subject === subject && r.status === "PENDING") ?? null,
    create: async ({ decision }) => (rows.push({ id: `sim_appr_${rows.length + 1}`, kind: decision.kind, subject: decision.subject, status: "PENDING" }), { id: `sim_appr_${rows.length}` }),
    expireDue: async () => [],
    claimApproved: async () => [],
    finish: async () => {},
  };
  const would = (what: string) => async () => `[sim] would ${what}`;
  const executor = new ActionExecutor({
    settings,
    spentThisMonthPaise: async () => Math.round(Number(value("--spent") ?? 0) * 100),
    handlers: {
      RAM_SCALE: async (p) => {
        const { serviceId, addMB } = p as Extract<Decision["payload"], { kind: "RAM_SCALE" }>;
        ram.set(serviceId, ram.get(serviceId)! + addMB);
        return `[sim] RAM of ${serviceId} now ${ram.get(serviceId)} MB`;
      },
      DISK_EXPAND: would("add disk at /data"),
      VOLUME_PURCHASE: async (_p, ctx) => {
        if (!ctx.approval) throw new Error("admin approval required to buy a Volume");
        return "[sim] would buy a Volume";
      },
      NOTIFY_CLIENT: would("email the client"),
      ALERT_ADMIN: would("email the admins"),
      STOP_SIGNUPS: would("stop new signups on the node"),
    },
    approvals,
    alertAdmin: async (title) => print(`        ✉ [sim] admin email: ${title}`),
    log: async () => {},
    approveHint: () => "",
  });

  const decisionMaker = new DecisionMaker(
    {
      nodeState: async () => ({ name: node.name, ramPct: nodeRam(servers.tick), acceptNewClients: true, monthlyCostPaise: 330_000 }),
      target: async (id) => targets[id],
      ramScaler: {
        plan: async (t, req) => {
          const before = ram.get(t.serviceId!)!;
          const after = Math.min(t.planRamMB * config.ramMaxMultiplier, before + ("addMB" in req && req.addMB ? req.addMB : config.ramExpandChunkMB));
          if (after === before) return { ok: false, code: "AT_RAM_CEILING", reason: `already at the maximum ${after} MB` };
          return { ok: true, summary: `raise RAM of container ${t.vmid} from ${before} MB to ${after} MB` } as never;
        },
      },
      diskExpander: {
        plan: async (t) =>
          t.serviceId === "svc_overage"
            ? ({ ok: true, summary: `container ${t.vmid}: add ${config.diskExpandChunkGB} GB at /data from free pool`, monthlyCostPaise: 0, addGB: config.diskExpandChunkGB } as never)
            : { ok: false, code: "OVERAGE_NOT_ENABLED", reason: "client hasn't enabled paid overage" },
      },
      submit: (d) => executor.handle(d),
    },
    config
  );

  return {
    containerDeps: cluster.deps(),
    serverDeps: servers.deps(),
    executor,
    decisionMaker,
    advance: () => {
      cluster.advance();
      servers.advance();
    },
  };
}
