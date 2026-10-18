import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../core/EventBus";
import type { EngineEvent } from "../core/events";
import { loadEngineConfig } from "../config";
import { silentLogger } from "../log";
import { ContainerMonitor, nextLevel } from "./ContainerMonitor";
import { SimulatedCluster, flat, steps, type SimContainer } from "../testing/simulatedProxmox";

const POLL_MS = 30_000;
const config = loadEngineConfig({}); // defaults: RAM 75/85/95, disk 75/85/98, CPU 85% for 300 s, hysteresis 5

function setup(containers: SimContainer[], extraNodes: SimulatedCluster["nodes"] = []) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const cluster = new SimulatedCluster([{ id: "node_1", name: "sowsi-proxmox-01", ip: "10.0.0.1", containers }, ...extraNodes]);
  // 1-hour de-dup window: anything published twice within the test is a real repeat.
  const bus = new EventBus({ now: clock, defaultDedupeMs: 3_600_000 });
  const events: EngineEvent[] = [];
  bus.subscribe("*", (e) => void events.push(e));
  const monitor = new ContainerMonitor(bus, cluster.deps(), config, { log: silentLogger, now: clock });

  /** Run n polls, advancing the simulation and the clock by one interval each. */
  const poll = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await monitor.pollOnce();
      cluster.advance();
      now += POLL_MS;
    }
    await bus.drain();
  };
  const types = () => events.map((e) => e.type);
  return { cluster, bus, monitor, events, types, poll };
}

const vps = (overrides: Partial<SimContainer> = {}): SimContainer => ({
  vmid: 101,
  name: "sowsi-svc_a",
  serviceId: "svc_a",
  ramMB: 2048,
  diskGB: 40,
  cores: 1,
  ramPct: flat(40),
  diskPct: flat(30),
  cpuPct: flat(10),
  ...overrides,
});

test("nextLevel rises immediately and only falls past the hysteresis band", () => {
  const t = [75, 85, 95] as const;
  assert.equal(nextLevel(50, 0, t, 5), 0);
  assert.equal(nextLevel(76, 0, t, 5), 1);
  assert.equal(nextLevel(96, 0, t, 5), 3, "jumps straight to the highest level crossed");
  assert.equal(nextLevel(75, 0, t, 5), 0, "thresholds are exclusive (> 75%)");
  assert.equal(nextLevel(82, 2, t, 5), 2, "82% stays CRITICAL (needs < 80%)");
  assert.equal(nextLevel(79, 2, t, 5), 1);
  assert.equal(nextLevel(40, 3, t, 5), 0, "big drop clears every level");
});

test("samples carry plan limits; only managed running containers are saved", async () => {
  const { monitor, cluster, poll } = setup([
    vps({ ramPct: flat(50), diskPct: flat(25) }),
    vps({ vmid: 900, name: "leftover-test", serviceId: null }),
    vps({ vmid: 102, serviceId: "svc_b", running: () => false }),
  ]);
  await poll();
  const [a, b, unmanaged] = monitor.snapshot();
  assert.equal(a.serviceId, "svc_a");
  assert.equal(a.memPct, 50);
  assert.equal(a.diskPct, 25);
  assert.equal(a.memPlanLimit, 2048 * 1024 ** 2);
  assert.equal(a.diskPlanLimit, 40 * 1024 ** 3);
  assert.equal(a.cpuPlanLimit, 1);
  assert.equal(b.status, "stopped");
  assert.equal(unmanaged.serviceId, null);
  assert.deepEqual(
    cluster.saved.map((s) => s.vmid),
    [101],
    "unmanaged and stopped containers are not stored as metrics"
  );
  assert.deepEqual(monitor.stats().containers, 3);
  assert.deepEqual(monitor.stats().managed, 2);
});

test("RAM escalates WARNING → CRITICAL → EMERGENCY, one event per level", async () => {
  const { types, events, poll } = setup([vps({ ramPct: steps(50, 80, 80, 90, 90, 97, 97) })]);
  await poll(7);
  assert.deepEqual(types(), ["RAM_WARNING", "RAM_CRITICAL", "RAM_EMERGENCY"]);
  const emergency = events[2];
  assert.equal(emergency.subject, "service:svc_a");
  assert.equal(emergency.source, "ContainerMonitor");
  assert.deepEqual(emergency.data, { vmid: 101, serviceId: "svc_a", nodeId: "node_1", pct: 97, used: 1987, limit: 2048, unit: "MB" });
});

test("recovering below the hysteresis band re-arms, so the next spike fires at once", async () => {
  // 90 → 83 (still CRITICAL) → 78 (WARNING, re-arms CRITICAL) → 90 (CRITICAL again)
  const { types, poll } = setup([vps({ ramPct: steps(90, 83, 78, 90) })]);
  await poll(4);
  assert.deepEqual(types(), ["RAM_CRITICAL", "RAM_WARNING", "RAM_CRITICAL"]);
});

test("disk events, including DISK_FULL", async () => {
  const { types, events, poll } = setup([vps({ diskPct: steps(70, 80, 88, 99) })]);
  await poll(4);
  assert.deepEqual(types(), ["DISK_WARNING", "DISK_CRITICAL", "DISK_FULL"]);
  assert.equal(events[2].data.pct, 99);
  assert.equal((events[2].data as { unit: string }).unit, "GB");
});

test("CPU_HIGH only after usage stays above the threshold for the full duration", async () => {
  // 95% for 12 polls (6 minutes), then 50%, then high again.
  const cpu = (tick: number) => (tick < 12 ? 95 : tick < 14 ? 50 : 95);
  const { types, events, poll } = setup([vps({ cpuPct: cpu })]);

  await poll(10); // ticks 0–9: 270 s above threshold
  assert.deepEqual(types(), [], "4.5 minutes is not sustained yet");
  await poll(1); // tick 10: 300 s
  assert.deepEqual(types(), ["CPU_HIGH"]);
  assert.equal((events[0].data as { sustainedSeconds: number }).sustainedSeconds, 300);

  await poll(3); // high, then two low polls clear and re-arm it
  await poll(11); // high again from tick 14: fires after another 300 s
  assert.deepEqual(types(), ["CPU_HIGH", "CPU_HIGH"]);
});

test("unmanaged and stopped containers never produce events", async () => {
  const { types, poll } = setup([
    vps({ vmid: 900, serviceId: null, ramPct: flat(99), diskPct: flat(99) }),
    vps({ vmid: 102, serviceId: "svc_b", ramPct: flat(99), running: () => false }),
  ]);
  await poll(3);
  assert.deepEqual(types(), []);
});

test("a container that stops and restarts alerts again straight away", async () => {
  const { types, poll } = setup([vps({ ramPct: flat(90), running: (t) => t !== 1 })]);
  await poll(3); // running at 90%, stopped, running at 90% again (well inside the 1 h window)
  assert.deepEqual(types(), ["RAM_CRITICAL", "RAM_CRITICAL"]);
});

test("one unreachable node doesn't stop the others; its last samples are kept", async () => {
  const { monitor, types, poll } = setup(
    [vps({ ramPct: flat(90) })],
    [
      {
        id: "node_2",
        name: "sowsi-proxmox-02",
        ip: "10.0.0.2",
        down: (t) => t >= 1,
        containers: [vps({ vmid: 101, serviceId: "svc_c", ramPct: flat(50) })],
      },
    ]
  );
  await poll(2);
  assert.deepEqual(types(), ["RAM_CRITICAL"]);
  assert.match(monitor.stats().nodeErrors["sowsi-proxmox-02"], /ETIMEDOUT/);
  assert.equal(monitor.snapshot().length, 2, "same vmid on two nodes are two containers; node_2's stays visible");
});

test("containers that disappear are dropped from the snapshot", async () => {
  const { monitor, cluster, poll } = setup([vps(), vps({ vmid: 102, serviceId: "svc_b" })]);
  await poll();
  cluster.nodes[0].containers.pop();
  await poll();
  assert.deepEqual(
    monitor.snapshot().map((s) => s.vmid),
    [101]
  );
});

test("concurrent pollOnce calls share one poll", async () => {
  const { cluster, monitor } = setup([vps()]);
  let calls = 0;
  const deps = cluster.deps();
  const original = deps.listNodes;
  Object.assign(monitor as unknown as { deps: typeof deps }, {
    deps: { ...deps, listNodes: () => (calls++, original()) },
  });
  const [a, b] = await Promise.all([monitor.pollOnce(), monitor.pollOnce()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

test("config rejects thresholds that don't increase", () => {
  assert.throws(() => loadEngineConfig({ RAM_WARNING_PCT: "90", RAM_CRITICAL_PCT: "85" }), /must increase/);
  assert.throws(() => loadEngineConfig({ DISK_FULL_PCT: "120" }), /≤ 100/);
  assert.equal(loadEngineConfig({ CPU_ALERT_DURATION: "300  # 5 minutes" }).cpuAlertDurationMs, 300_000);
});
