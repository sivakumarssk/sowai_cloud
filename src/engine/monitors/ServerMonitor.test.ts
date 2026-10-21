import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../core/EventBus";
import type { EngineEvent } from "../core/events";
import { loadEngineConfig } from "../config";
import { silentLogger } from "../log";
import { ServerMonitor, freePoolBytes } from "./ServerMonitor";
import { SimulatedServers, flat, steps, type SimServer } from "../testing/simulatedProxmox";

const GB = 1024 ** 3;
const POLL_MS = 30_000;
// Defaults: warning 70, critical 80, emergency 90, full 85, CPU 90% for 600 s, reserve 20 GB, hysteresis 5
const config = loadEngineConfig({});

const node = (over: Partial<SimServer> = {}): SimServer => ({
  id: "node_1",
  name: "sowsi-proxmox-01",
  ip: "10.0.0.1",
  hetznerServerId: "168392011",
  volumes: [],
  ramTotalMB: 8192,
  diskTotalGB: 150,
  cores: 4,
  ramPct: flat(40),
  diskPct: flat(30),
  cpuPct: flat(20),
  allocatedDiskGB: 60,
  containers: [
    { vmid: 100, running: true, ramMB: 2048 },
    { vmid: 101, running: false, ramMB: 4096 },
  ],
  ...over,
});

function setup(nodes: SimServer[]) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const sim = new SimulatedServers(nodes);
  const bus = new EventBus({ now: clock, defaultDedupeMs: 3_600_000 });
  const events: EngineEvent[] = [];
  bus.subscribe("*", (e) => void events.push(e));
  const monitor = new ServerMonitor(bus, sim.deps(), config, { log: silentLogger, now: clock });
  const poll = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await monitor.pollOnce();
      sim.advance();
      now += POLL_MS;
    }
    await bus.drain();
  };
  return { sim, monitor, events, types: () => events.map((e) => e.type), poll };
}

test("free pool = storage − allocated − reserve, never negative", () => {
  assert.equal(freePoolBytes(150 * GB, 60 * GB, 20), 70 * GB);
  assert.equal(freePoolBytes(150 * GB, 140 * GB, 20), 0);
});

test("sample: physical usage, allocation, containers, volumes", async () => {
  const { monitor, sim, poll } = setup([
    node({
      volumes: [{ id: "vol_1", storage: "hcloud-vol-1", sizeGB: 100 }],
      volumeAllocatedGB: { "hcloud-vol-1": 30 },
    }),
  ]);
  await poll();
  const [s] = monitor.snapshot();
  assert.equal(s.physicalRamPct, 40);
  assert.equal(s.physicalDiskPct, 30);
  assert.equal(s.allocatedDisk, 60 * GB);
  assert.equal(s.freePoolBytes, 70 * GB);
  assert.equal(s.physicalCpu, 4);
  assert.equal(s.physicalCpuPct, 20);
  assert.equal(s.totalContainers, 2);
  assert.equal(s.activeContainers, 1);
  assert.equal(s.allocatedRam, 6144 * 1024 ** 2);
  assert.equal(s.volumeTotalSpace, 100 * GB);
  assert.equal(s.volumeUsedSpace, 30 * GB);
  assert.equal(s.status, "healthy");

  const saved = sim.saved[0];
  assert.deepEqual(
    { ram: saved.usedRamMB, alloc: saved.allocatedRamMB, disk: saved.allocatedDiskGB, count: saved.containerCount, health: saved.health, vols: saved.volumes },
    { ram: 3277, alloc: 6144, disk: 60, count: 2, health: "healthy", vols: [{ id: "vol_1", usedGB: 30 }] }
  );
});

test("RAM escalates through warning, critical, full and emergency; health follows", async () => {
  const { monitor, types, events, poll } = setup([node({ ramPct: steps(60, 72, 82, 87, 92) })]);
  const health: string[] = [];
  for (let i = 0; i < 5; i++) {
    await poll();
    health.push(monitor.snapshot()[0].status);
  }
  assert.deepEqual(types(), ["SERVER_RAM_WARNING", "SERVER_RAM_CRITICAL", "SERVER_FULL", "SERVER_RAM_EMERGENCY"]);
  assert.deepEqual(health, ["healthy", "warning", "critical", "critical", "critical"]);
  const full = events.find((e) => e.type === "SERVER_FULL")!;
  assert.equal(full.subject, "node:sowsi-proxmox-01");
  assert.deepEqual(full.data, { nodeId: "node_1", nodeName: "sowsi-proxmox-01", pct: 87, resource: "RAM" });
});

test("disk has warning and critical; SERVER_FULL names the fuller resource", async () => {
  const { types, events, poll } = setup([node({ diskPct: steps(50, 75, 83, 88) })]);
  await poll(4);
  assert.deepEqual(types(), ["SERVER_DISK_WARNING", "SERVER_DISK_CRITICAL", "SERVER_FULL"]);
  assert.equal((events[2].data as { resource: string }).resource, "DISK");
});

test("SERVER_OVERLOADED only after CPU stays above 90% for 10 minutes", async () => {
  const { types, events, poll } = setup([node({ cpuPct: flat(95) })]);
  await poll(20); // 0 … 570 s
  assert.deepEqual(types(), []);
  await poll(1); // 600 s
  assert.deepEqual(types(), ["SERVER_OVERLOADED"]);
  assert.equal((events[0].data as { sustainedSeconds: number }).sustainedSeconds, 600);
});

test("recovery below the hysteresis band re-arms the event", async () => {
  // 82 → 78 (still CRITICAL: needs < 75) → 74 (WARNING) → 82 (CRITICAL again)
  const { types, poll } = setup([node({ ramPct: steps(82, 78, 74, 82) })]);
  await poll(4);
  assert.deepEqual(types(), ["SERVER_RAM_CRITICAL", "SERVER_RAM_WARNING", "SERVER_RAM_CRITICAL"]);
});

test("an unreachable node is reported; others still polled; a failed save doesn't stop the poll", async () => {
  const { monitor, poll } = setup([
    node({ failSave: true }),
    node({ id: "node_2", name: "sowsi-proxmox-02", ip: "10.0.0.2", hetznerServerId: "2", down: () => true }),
  ]);
  await poll();
  assert.equal(monitor.snapshot().length, 1);
  assert.match(monitor.stats().nodeErrors["sowsi-proxmox-02"], /ETIMEDOUT/);
  assert.equal(monitor.stats().polls, 1);
});

test("server CPU is clamped to 0–100%", async () => {
  const { monitor, poll } = setup([node({ cpuPct: flat(-0.4) })]);
  await poll();
  assert.equal(monitor.snapshot()[0].physicalCpuPct, 0);
  const high = setup([node({ cpuPct: flat(140) })]);
  await high.poll();
  assert.equal(high.monitor.snapshot()[0].physicalCpuPct, 100);
});
