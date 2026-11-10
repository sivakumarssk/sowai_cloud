import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNodeState, planNodeState, type NodeRow, type NodeStateDeps } from "./nodeState";

const NODE1: NodeRow = { id: "n1", name: "sowsi-proxmox-01", status: "READY", acceptNewClients: true, hetznerServerId: "168392011", ipv6Subnet: "2a01:4f8:1c1c:1", hasOwnToken: false };
const NEW: NodeRow = { id: "n2", name: "sowsi-proxmox-02", status: "PROVISIONING", acceptNewClients: false, hetznerServerId: "200", ipv6Subnet: "2a01:4f8:1c1c:2", hasOwnToken: true };

function world(over: { node?: NodeRow | null; services?: number; volumes?: number; migrations?: number; approvals?: number; applyFails?: boolean } = {}) {
  const applied: { node: string; change: unknown; log: { action: string; approvedBy: string } }[] = [];
  const deps: NodeStateDeps = {
    findNode: async () => (over.node === undefined ? NODE1 : over.node),
    liveServices: async () => Array.from({ length: over.services ?? 0 }, (_, i) => ({ id: `svc_${i}`, status: "ACTIVE" })),
    liveVolumes: async () => Array.from({ length: over.volumes ?? 0 }, (_, i) => ({ id: `vol_${i}`, status: "ACTIVE" })),
    openMigrations: async () => over.migrations ?? 0,
    openApprovals: async () => over.approvals ?? 0,
    async apply(node, change, log) {
      if (over.applyFails) throw new Error("database down");
      applied.push({ node: node.name, change, log });
    },
  };
  return { deps, applied };
}

test("retire: an empty node becomes DECOMMISSIONING and closed, with a log row, only with --apply", async () => {
  const w = world();
  const plan = await planNodeState(w.deps, "sowsi-proxmox-01", "retire");
  assert.equal(plan.ok, true, plan.problems.join());
  assert.deepEqual(plan.change, { status: "DECOMMISSIONING", acceptNewClients: false });
  assert.match(plan.lines.join("\n"), /the row and its history stay/);
  assert.deepEqual(w.applied, [], "planning changes nothing");
  assert.equal(await applyNodeState(w.deps, plan, "retire", "sivakumar"), "sowsi-proxmox-01: DECOMMISSIONING, closed for new clients");
  assert.deepEqual(w.applied, [{ node: "sowsi-proxmox-01", change: { status: "DECOMMISSIONING", acceptNewClients: false }, log: { action: "NODE_RETIRED", approvedBy: "sivakumar" } }]);
});

test("retire refuses while anything still depends on the node", async () => {
  for (const [over, why] of [
    [{ services: 2 }, /still has 2 service\(s\): svc_0 ACTIVE, svc_1 ACTIVE/],
    [{ volumes: 1 }, /still has 1 volume\(s\): vol_0 ACTIVE/],
    [{ migrations: 1 }, /1 migration\(s\) from or to it are scheduled or running/],
    [{ approvals: 3 }, /3 engine approval\(s\) for it are pending or approved/],
  ] as const) {
    const w = world(over);
    const plan = await planNodeState(w.deps, "sowsi-proxmox-01", "retire");
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join(), why);
    await assert.rejects(applyNodeState(w.deps, plan, "retire", "sivakumar"), /refused/);
    assert.deepEqual(w.applied, [], "nothing changed");
  }
});

test("retire: a node that's already retired, or doesn't exist", async () => {
  const done = world({ node: { ...NODE1, status: "DECOMMISSIONING", acceptNewClients: false } });
  const plan = await planNodeState(done.deps, "sowsi-proxmox-01", "retire");
  assert.equal(plan.ok, true);
  assert.equal(plan.change, null);
  assert.equal(await applyNodeState(done.deps, plan, "retire", "sivakumar"), "nothing to change");
  assert.deepEqual(done.applied, []);
  const none = await planNodeState(world({ node: null }).deps, "sowsi-proxmox-09", "retire");
  assert.equal(none.ok, false);
  assert.match(none.problems.join(), /no ProxmoxNode named sowsi-proxmox-09/);
});

test("open: a new node goes PROVISIONING → READY and open; --approved-by is required", async () => {
  const w = world({ node: NEW });
  const plan = await planNodeState(w.deps, "sowsi-proxmox-02", "open");
  assert.equal(plan.ok, true, plan.problems.join());
  assert.deepEqual(plan.change, { status: "READY", acceptNewClients: true });
  await assert.rejects(applyNodeState(w.deps, plan, "open", " "), /--approved-by/);
  assert.equal(await applyNodeState(w.deps, plan, "open", "sivakumar"), "sowsi-proxmox-02: READY, open for new clients");
  assert.equal(w.applied[0].log.action, "NODE_OPENED");
  const closedByEngine = await planNodeState(world({ node: { ...NEW, status: "WARNING" } }).deps, "sowsi-proxmox-02", "open");
  assert.deepEqual(closedByEngine.change, { status: "WARNING", acceptNewClients: true }, "health status is the monitor's; only the door opens");
  const open = await planNodeState(world({ node: { ...NEW, status: "READY", acceptNewClients: true } }).deps, "sowsi-proxmox-02", "open");
  assert.equal(open.change, null);
});

test("open refuses a retired node, and one nothing could reach", async () => {
  for (const [node, why] of [
    [{ ...NODE1, status: "DECOMMISSIONING", acceptNewClients: false }, /it's retired \(DECOMMISSIONING\)/],
    [NODE1, /no API token of its own/],
    [{ ...NEW, ipv6Subnet: null }, /no ipv6Subnet/],
  ] as const) {
    const w = world({ node });
    const plan = await planNodeState(w.deps, node.name, "open");
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join(), why);
    await assert.rejects(applyNodeState(w.deps, plan, "open", "sivakumar"));
    assert.deepEqual(w.applied, []);
  }
});

test("a failed write is reported, not claimed done", async () => {
  const w = world({ applyFails: true });
  const plan = await planNodeState(w.deps, "sowsi-proxmox-01", "retire");
  await assert.rejects(applyNodeState(w.deps, plan, "retire", "sivakumar"), /database down/);
});
