import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseNode,
  fitCount,
  fitsWhenEmpty,
  hostRamMB,
  nodeFit,
  placeOrder,
  resumeWaitingOrders,
  usableRamMB,
  REMINDER_EVERY_MS,
  WAITING_STEP,
  type Need,
  type NodeLoad,
  type PendingOrder,
  type PlacementDeps,
  type SweepDeps,
} from "./placement";
import { ipv6ForVmid, nodeTarget } from "./nodeTarget";

const config = { ramOvercommit: 1, diskPoolReserveGB: 20, hostRamReserveMB: 0 };
const reserved = { ...config, hostRamReserveMB: 1536 };
const empty = { ramMB: 0, diskGB: 0, count: 0 };

/** Two CPX32-like nodes in different locations, each with its own server, IP and /64. */
function node(name: "A" | "B", over: Partial<NodeLoad> = {}): NodeLoad {
  const n = name === "A" ? 1 : 2;
  return {
    id: `node_${name}`,
    name: `sowsi-proxmox-0${n}`,
    ip: `203.0.113.${n}`,
    hetznerServerId: `16839201${n}`,
    location: name === "A" ? "nbg1" : "fsn1",
    ipv6Subnet: `2a01:4f8:1c16:5f1${n}`,
    acceptNewClients: true,
    status: "READY",
    physicalRamMB: 8192,
    physicalDiskGB: 160,
    maxContainers: 6,
    monitor: null,
    settled: { ...empty },
    inFlight: { ...empty },
    ...over,
  };
}

const plan4G: Need = { ramMB: 4096, diskGB: 40 };

// ── Capacity ──────────────────────────────────────────────────────────

test("chooses the open node with the most free RAM", () => {
  const a = node("A", { settled: { ramMB: 4096, diskGB: 40, count: 2 } });
  const b = node("B", { settled: { ramMB: 2048, diskGB: 20, count: 1 } });
  assert.equal(chooseNode([a, b], plan4G, config).node?.name, "sowsi-proxmox-02");
  assert.equal(chooseNode([b, a], plan4G, config).node?.name, "sowsi-proxmox-02", "order of rows doesn't matter");
});

test("skips a node that's closed, full on RAM, disk or container count, or has no IPv6 subnet", () => {
  const b = node("B");
  const cases: [NodeLoad, RegExp][] = [
    [node("A", { acceptNewClients: false }), /closed to new clients/],
    [node("A", { status: "DECOMMISSIONING" }), /DECOMMISSIONING/],
    [node("A", { settled: { ramMB: 6144, diskGB: 40, count: 2 } }), /2048 MB RAM free, needs 4096 MB/],
    [node("A", { settled: { ramMB: 1024, diskGB: 110, count: 2 } }), /30 GB disk free \(after 20 GB reserve\), needs 40 GB/],
    [node("A", { settled: { ramMB: 0, diskGB: 0, count: 6 } }), /6\/6 containers/],
    [node("A", { ipv6Subnet: null }), /no IPv6 subnet/],
  ];
  for (const [a, why] of cases) {
    const choice = chooseNode([a, b], plan4G, config);
    assert.equal(choice.node?.name, "sowsi-proxmox-02");
    assert.match(choice.reasons[0], why);
  }
});

test("a plan bigger than any node even when empty says it needs a larger server", () => {
  const choice = chooseNode([node("A"), node("B")], { ramMB: 8192, diskGB: 160 }, config);
  assert.equal(choice.node, null);
  assert.match(choice.reasons[0], /no registered node is big enough for this plan even when empty.*needs a larger server/);
  const full = chooseNode([node("A", { acceptNewClients: false })], plan4G, config);
  assert.ok(!full.reasons.some((r) => /big enough/.test(r)), "a merely full node doesn't claim that");
});

test("CRITICAL health is not closure; RAM overcommit is configurable", () => {
  assert.ok(nodeFit(node("A", { status: "CRITICAL" }), plan4G, config).ok);
  const busy = node("A", { settled: { ramMB: 6144, diskGB: 40, count: 2 } });
  assert.equal(nodeFit(busy, plan4G, config).ok, false);
  assert.ok(nodeFit(busy, plan4G, { ...config, ramOvercommit: 1.5 }).ok, "8192 × 1.5 − 6144 = 6144 MB free");
});

test("committed load: the larger of monitor and database, plus orders still being set up", () => {
  // The monitor also sees a 3 GB test container the database doesn't know about.
  const a = node("A", { monitor: { allocatedRamMB: 3072, allocatedDiskGB: 20, containerCount: 1, hostUsedRamMB: null }, settled: { ramMB: 1024, diskGB: 20, count: 1 }, inFlight: { ramMB: 2048, diskGB: 20, count: 1 } });
  const fit = nodeFit(a, { ramMB: 1024, diskGB: 10 }, config);
  assert.deepEqual(fit, { ok: true, freeRamMB: 8192 - 3072 - 2048, freeDiskGB: 160 - 20 - 20 - 20 });
});

// ── Placing orders (two simulated nodes) ─────────────────────────────

type Svc = { status: string; pct: number; need: Need; nodeId: string | null; waitingSince: Date | null };

function cluster(nodes: NodeLoad[], services: Record<string, Need>) {
  const svc = new Map<string, Svc>(Object.entries(services).map(([id, need]) => [id, { status: "PROVISIONING", pct: 0, need, nodeId: null, waitingSince: null }]));
  const alerts: string[] = [];
  const customer: string[] = [];
  let lock = Promise.resolve();
  const withInFlight = (): NodeLoad[] =>
    nodes.map((n) => {
      const mine = [...svc.values()].filter((s) => s.nodeId === n.id && s.pct > 0);
      return { ...n, inFlight: { ramMB: mine.reduce((a, s) => a + s.need.ramMB, 0), diskGB: mine.reduce((a, s) => a + s.need.diskGB, 0), count: mine.length } };
    });
  const deps: PlacementDeps = {
    // A real mutex, like the Postgres advisory lock: placements run one at a time.
    locked: (fn) => {
      const run = lock.then(() =>
        fn({
          order: async (id) => {
            await new Promise((r) => setTimeout(r, 1)); // let concurrent calls interleave if they could
            const s = svc.get(id);
            return s ? { status: s.status, provisioningPct: s.pct, need: s.need } : null;
          },
          nodes: async () => withInFlight(),
          claim: async (id, nodeId) => {
            const s = svc.get(id)!;
            if (s.status !== "PROVISIONING" || s.pct !== 0) return false;
            Object.assign(s, { pct: 10, nodeId, waitingSince: null });
            return true;
          },
          markWaiting: async (id) => {
            const s = svc.get(id)!;
            if (s.waitingSince) return false;
            s.waitingSince = new Date();
            return true;
          },
        })
      );
      lock = run.then(() => undefined, () => undefined);
      return run;
    },
    config,
    orderInfo: async (serviceId) => ({ serviceId, planName: "VPS Pro", customer: "Asha", waitingSince: null }),
    alertAdmin: async (subject) => void alerts.push(subject),
    notifyCustomer: async (_id, message) => void customer.push(message),
    log: async () => {},
  };
  return { deps, svc, alerts, customer };
}

test("an order goes to the node with room, and is claimed there", async () => {
  const c = cluster([node("A", { settled: { ramMB: 6144, diskGB: 60, count: 3 } }), node("B")], { svc_1: plan4G });
  const r = await placeOrder("svc_1", c.deps);
  assert.equal(r.status, "PLACED");
  if (r.status === "PLACED") assert.equal(r.node.name, "sowsi-proxmox-02");
  assert.deepEqual({ pct: c.svc.get("svc_1")!.pct, nodeId: c.svc.get("svc_1")!.nodeId }, { pct: 10, nodeId: "node_B" });
});

test("orders fill both nodes, then the next one waits — never failed or refunded, admin alerted once", async () => {
  const c = cluster([node("A"), node("B")], { o1: plan4G, o2: plan4G, o3: plan4G, o4: plan4G, o5: plan4G });
  const placed: string[] = [];
  for (const id of ["o1", "o2", "o3", "o4"]) {
    const r = await placeOrder(id, c.deps);
    assert.equal(r.status, "PLACED", id);
    if (r.status === "PLACED") placed.push(r.node.id);
  }
  assert.deepEqual(placed.sort(), ["node_A", "node_A", "node_B", "node_B"], "two 4 GB containers per 8 GB node");

  const r5 = await placeOrder("o5", c.deps);
  assert.equal(r5.status, "WAIT");
  if (r5.status === "WAIT") assert.match(r5.reason, /sowsi-proxmox-01 has 0 MB RAM free.*sowsi-proxmox-02 has 0 MB RAM free/);
  const o5 = c.svc.get("o5")!;
  assert.deepEqual({ status: o5.status, pct: o5.pct, nodeId: o5.nodeId }, { status: "PROVISIONING", pct: 0, nodeId: null });
  assert.ok(o5.waitingSince);
  assert.deepEqual(c.alerts, ["Paid order waiting for a server: VPS Pro"]);
  assert.equal(c.customer.length, 1);

  assert.equal((await placeOrder("o5", c.deps)).status, "WAIT");
  assert.equal(c.alerts.length, 1, "no second alert while it keeps waiting");
});

test("two orders at once can't both take the last slot", async () => {
  const c = cluster([node("A", { acceptNewClients: false }), node("B", { settled: { ramMB: 4096, diskGB: 40, count: 1 } })], { x: plan4G, y: plan4G });
  const results = await Promise.all([placeOrder("x", c.deps), placeOrder("y", c.deps)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["PLACED", "WAIT"]);
});

test("an order that's already claimed (or not paid/provisioning) is skipped", async () => {
  const c = cluster([node("A")], { svc_1: plan4G });
  await placeOrder("svc_1", c.deps);
  assert.equal((await placeOrder("svc_1", c.deps)).status, "SKIP", "duplicate call doesn't provision twice");
  assert.equal((await placeOrder("missing", c.deps)).status, "SKIP");
});

// ── The node's own network settings ──────────────────────────────────

test("each node brings its own Hetzner server, location, IP and IPv6 subnet", () => {
  const a = nodeTarget(node("A"));
  const b = nodeTarget(node("B"));
  assert.deepEqual(a, { name: "sowsi-proxmox-01", ip: "203.0.113.1", hetznerServerId: 168392011, location: "nbg1", ipv6Subnet: "2a01:4f8:1c16:5f11" });
  assert.deepEqual(b, { name: "sowsi-proxmox-02", ip: "203.0.113.2", hetznerServerId: 168392012, location: "fsn1", ipv6Subnet: "2a01:4f8:1c16:5f12" });
  assert.equal(ipv6ForVmid(a.ipv6Subnet, 100), "2a01:4f8:1c16:5f11::100");
  assert.equal(ipv6ForVmid(b.ipv6Subnet, 100), "2a01:4f8:1c16:5f12::100", "same vmid on another node, different address");
  assert.throws(() => nodeTarget(node("A", { ipv6Subnet: null })), /no ipv6Subnet/);
  assert.throws(() => nodeTarget(node("A", { hetznerServerId: "abc" })), /invalid hetznerServerId/);
  assert.throws(() => ipv6ForVmid(a.ipv6Subnet, 10000), /doesn't fit/);
});

// ── Sweep ─────────────────────────────────────────────────────────────

const now = new Date("2026-10-21T16:00:00Z");
const waiting = (id: string, need = plan4G): PendingOrder => ({ serviceId: id, planName: "VPS Pro", customer: "Asha", waitingSince: new Date("2026-10-21T10:00:00Z"), need });

function sweep(nodes: NodeLoad[], orders: PendingOrder[], lastReminder: Date | null = null) {
  const started: string[] = [];
  const alerts: string[] = [];
  let last = lastReminder;
  const deps: SweepDeps = {
    pendingOrders: async () => orders,
    nodes: async () => nodes.map((n) => ({ ...n, inFlight: { ...n.inFlight } })),
    config,
    start: async (id) => void started.push(id),
    alertAdmin: async (subject) => void alerts.push(subject),
    lastReminderAt: async () => last,
    recordReminder: async () => void (last = now),
  };
  return { deps, started, alerts };
}

test("sweep: waiting orders start on whichever node has room; the rest keep waiting", async () => {
  const s = sweep([node("A", { settled: { ramMB: 4096, diskGB: 40, count: 1 } }), node("B", { settled: { ramMB: 4096, diskGB: 40, count: 1 } })], [waiting("w1"), waiting("w2"), waiting("w3")]);
  assert.deepEqual(await resumeWaitingOrders(s.deps, now), { started: 2, waiting: 1 });
  assert.deepEqual(s.started, ["w1", "w2"], "oldest first; each counted before the next");
  assert.deepEqual(s.alerts, ["1 paid order still waiting for a server"]);
});

test("sweep: reminders at most every 6 hours while nothing fits", async () => {
  const full = [node("A", { acceptNewClients: false }), node("B", { acceptNewClients: false })];
  const s = sweep(full, [waiting("w1")]);
  await resumeWaitingOrders(s.deps, now);
  await resumeWaitingOrders(s.deps, new Date(now.getTime() + 15 * 60_000));
  assert.equal(s.alerts.length, 1);
  const later = sweep(full, [waiting("w1")], new Date(now.getTime() - REMINDER_EVERY_MS));
  await resumeWaitingOrders(later.deps, now);
  assert.equal(later.alerts.length, 1);
});

test("sweep: an order that never started (lost in a restart) is always started, so it gets placed or parked properly", async () => {
  const s = sweep([node("A", { acceptNewClients: false })], [{ ...waiting("lost"), waitingSince: null }]);
  await resumeWaitingOrders(s.deps, now);
  assert.deepEqual(s.started, ["lost"]);
  assert.deepEqual(s.alerts, []);
});

test("the waiting step tells the customer what's happening", () => {
  assert.match(WAITING_STEP, /waiting for server capacity/);
});

// ── RAM kept for the host ─────────────────────────────────────────

const basic = { ramMB: 2048, diskGB: 40 };
const seen = { allocatedRamMB: 0, allocatedDiskGB: 0, containerCount: 0 };

test("the reserve comes off a node's RAM when nothing has been measured", () => {
  const n = node("A", { physicalRamMB: 3817, physicalDiskGB: 74 });
  assert.equal(hostRamMB(n, reserved), 1536);
  assert.equal(usableRamMB(n, reserved), 2281);
  const fit = nodeFit(n, basic, reserved);
  assert.ok(fit.ok && fit.freeRamMB === 2281);
  assert.ok(!nodeFit(n, { ramMB: 2282, diskGB: 0 }, reserved).ok, "one MB over");
});

test("a measured host figure replaces the reserve, higher or lower", () => {
  const measured = (hostUsedRamMB: number | null) => node("A", { monitor: { ...seen, hostUsedRamMB } });
  assert.equal(usableRamMB(measured(2500), reserved), 8192 - 2500);
  assert.equal(usableRamMB(measured(700), reserved), 8192 - 700);
  assert.equal(usableRamMB(measured(null), reserved), 8192 - 1536, "seen, but the reading was no use");
  assert.equal(usableRamMB(node("A", { monitor: null }), reserved), 8192 - 1536, "stale monitor");
});

test("the host's share is real memory, so it comes off before any overcommit", () => {
  assert.equal(usableRamMB(node("A"), { ...reserved, ramOvercommit: 1.5 }), Math.floor((8192 - 1536) * 1.5));
  assert.equal(usableRamMB(node("A", { physicalRamMB: 1024 }), reserved), 0, "never below zero");
});

test("a plan that only fits by eating the host's RAM isn't offered, and a paid order for it waits", () => {
  const n = node("A", { physicalRamMB: 3817, physicalDiskGB: 150 });
  const fourGig = { ramMB: 3072, diskGB: 40 };
  assert.ok(fitsWhenEmpty(n, fourGig, config));
  assert.ok(!fitsWhenEmpty(n, fourGig, reserved));
  assert.equal(chooseNode([n], fourGig, reserved).node, null);
});

test("fitCount counts what a node would really take, without changing it", () => {
  const n = node("A", { physicalRamMB: 3817, physicalDiskGB: 74 });
  assert.equal(fitCount(n, basic, reserved), 1);
  assert.deepEqual(n.inFlight, empty, "the node is untouched");
  assert.equal(fitCount(node("A"), basic, reserved), 3, "(8192 − 1536) ÷ 2048");
  assert.equal(fitCount(node("A", { settled: { ramMB: 2048, diskGB: 40, count: 1 } }), basic, reserved), 2, "what's already there counts");
  assert.equal(fitCount(node("A", { acceptNewClients: false }), basic, reserved), 0);
  assert.equal(fitCount(node("A", { physicalRamMB: 64000, physicalDiskGB: 2000 }), basic, reserved), 6, "maxContainers");
});
