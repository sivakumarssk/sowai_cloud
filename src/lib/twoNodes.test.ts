// Two nodes that both have a container 100, belonging to different customers.
import { cluster, db, requestsTo, writesTo, type Ct } from "./testing/twoNodes"; // first: replaces the database and transport
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { encrypt } from "./crypto";
import { resumeAfterPayment, suspendForNonPayment, BILLING_SUSPEND_REASON } from "./billing/suspension";
import { runBillingJob } from "./billing/billingJob";
import { deprovisionVPS } from "./provisioning/provisionVPS";
import { prismaReprovisionDeps } from "./billing/reprovisionDeps";
import type { ReprovisionSnapshot } from "./billing/reprovision";
import { containerNode } from "./provisioning/nodeTarget";
import { prismaRamDeps, targetForContainer, targetForService } from "@/engine/data/actionDeps";
import { prismaContainerDeps } from "@/engine/data/containerDeps";
import { ContainerMonitor } from "@/engine/monitors/ContainerMonitor";
import { EventBus } from "@/engine/core/EventBus";
import { loadEngineConfig } from "@/engine/config";
import type { EngineEvent } from "@/engine/core/events";
import { silentLogger } from "@/engine/log";

const NODE_1 = "10.0.0.1";
const NODE_2 = "10.0.0.2";
const FUTURE = new Date("2099-01-01");
const PAST = new Date("2020-01-01");

const ct = (name: string, over: Partial<Ct> = {}): Ct => ({ status: "running", onboot: true, name, memoryMB: 2048, memUsedMB: 200, ...over });

const service = (id: string, nodeId: string | null, over: Record<string, unknown> = {}) => ({
  id,
  userId: `user_${id}`,
  nodeId,
  status: "ACTIVE",
  serverSource: "PROXMOX",
  proxmoxVmId: "100",
  hetznerFloatingIpId: null,
  sshVerifiedAt: new Date(),
  billingHold: false,
  suspendReason: null,
  suspendedAt: null,
  nextBillingDate: FUTURE,
  hostname: null,
  plan: { name: "VPS Basic", ramGB: 2, storageGB: 40, vcpu: 1 },
  user: { name: id, email: `${id}@example.com` },
  subscriptions: [],
  ...over,
});

beforeEach(() => {
  db.nodes.length = 0;
  db.nodes.push(
    // Node 1 has no token of its own: .env. Node 2 generated its own secret.
    { id: "n1", name: "node-1", ip: NODE_1, status: "READY", apiTokenId: null, apiTokenSecret: null },
    { id: "n2", name: "node-2", ip: NODE_2, status: "READY", apiTokenId: "root@pam!sowsi", apiTokenSecret: encrypt("node-2-secret") }
  );
  db.services.length = 0;
  db.services.push(service("svc_on_1", "n1"), service("svc_on_2", "n2"));
  db.metrics.length = 0;
  db.logs.length = 0;
  cluster.requests.length = 0;
  cluster.containers.clear();
  cluster.containers.set("node-1", new Map([[100, ct("sowsi-svc_on_1")]]));
  cluster.containers.set("node-2", new Map([[100, ct("sowsi-svc_on_2")]]));
  cluster.tokens.clear();
  cluster.tokens.set(NODE_1, "root@pam!first=node-1-env-secret");
  cluster.tokens.set(NODE_2, "root@pam!sowsi=node-2-secret");
});

const on = (node: string) => cluster.containers.get(node)!.get(100);
const row = (id: string) => db.services.find((s) => s.id === id)!;

// ── Suspend and resume ───────────────────────────────────────────────

test("suspending a node-2 customer stops their container and never touches node 1's container 100", async () => {
  assert.equal(await suspendForNonPayment("svc_on_2", "test"), true);
  assert.deepEqual([on("node-2")!.status, on("node-2")!.onboot], ["stopped", false]);
  assert.deepEqual([on("node-1")!.status, on("node-1")!.onboot], ["running", true]);
  assert.deepEqual(requestsTo(NODE_1), [], "no request reached node 1");
});

test("suspending a node-1 customer leaves node 2 alone, with node 1's .env token", async () => {
  await suspendForNonPayment("svc_on_1", "test");
  assert.equal(on("node-1")!.status, "stopped");
  assert.equal(on("node-2")!.status, "running");
  assert.deepEqual(requestsTo(NODE_2), []);
});

test("resuming a node-2 customer starts their container, not the stopped one with the same VM id on node 1", async () => {
  on("node-1")!.status = "stopped";
  on("node-1")!.onboot = false;
  on("node-2")!.status = "stopped";
  on("node-2")!.onboot = false;
  Object.assign(row("svc_on_1"), { status: "SUSPENDED", suspendReason: BILLING_SUSPEND_REASON, hetznerFloatingIpId: "1" });
  Object.assign(row("svc_on_2"), { status: "SUSPENDED", suspendReason: BILLING_SUSPEND_REASON, hetznerFloatingIpId: "2" });

  assert.equal(await resumeAfterPayment("svc_on_2"), true);
  assert.deepEqual([on("node-2")!.status, on("node-2")!.onboot], ["running", true]);
  assert.deepEqual([on("node-1")!.status, on("node-1")!.onboot], ["stopped", false], "another customer's suspended server stays down");
  assert.deepEqual(writesTo(NODE_1), []);
});

test("a service with no node recorded: nothing is suspended on any node, and billing state still moves", async () => {
  Object.assign(row("svc_on_2"), { nodeId: null });
  assert.equal(await suspendForNonPayment("svc_on_2", "test"), true);
  assert.equal(row("svc_on_2").status, "SUSPENDED");
  assert.deepEqual(cluster.requests, [], "no Proxmox call at all");
  assert.equal(on("node-1")!.status, "running");
});

// ── The billing job ──────────────────────────────────────────────────

test("the billing job suspends the overdue node-2 service only", async () => {
  Object.assign(row("svc_on_2"), { nextBillingDate: PAST });
  const summary = await runBillingJob();
  assert.equal(summary.suspended, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(on("node-2")!.status, "stopped");
  assert.equal(on("node-1")!.status, "running");
});

test("the billing job deletes the expired node-2 container, and node 1's container 100 survives", async () => {
  Object.assign(row("svc_on_2"), { status: "SUSPENDED", suspendReason: BILLING_SUSPEND_REASON, suspendedAt: PAST, hetznerFloatingIpId: null });
  const summary = await runBillingJob();
  assert.equal(summary.deleted, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(on("node-2"), undefined, "deleted");
  assert.ok(on("node-1"), "the other customer's container is still there");
  assert.deepEqual(writesTo(NODE_1), []);
  assert.equal(row("svc_on_2").status, "DELETED");
});

// ── Cancel ───────────────────────────────────────────────────────────

test("cancelling deletes the container on the service's own node", async () => {
  await deprovisionVPS("svc_on_2");
  assert.equal(on("node-2"), undefined);
  assert.ok(on("node-1"));
  assert.deepEqual(writesTo(NODE_1), []);
});

test("cancelling a service with no node recorded deletes nothing while several nodes exist; the VM id is kept for a person", async () => {
  Object.assign(row("svc_on_2"), { nodeId: null, hetznerFloatingIpId: "77" });
  await assert.rejects(deprovisionVPS("svc_on_2"), /has no node recorded and 2 nodes are registered/);
  assert.ok(on("node-1"));
  assert.ok(on("node-2"));
  assert.deepEqual(cluster.requests, []);
  assert.equal(row("svc_on_2").proxmoxVmId, "100");
  assert.equal(row("svc_on_2").hetznerFloatingIpId, "77", "its IP isn't released either");
  assert.equal(row("svc_on_2").status, "CANCELLED");
});

test("with one node, a row with no node recorded is safely that node's", async () => {
  db.nodes.splice(1, 1);
  Object.assign(row("svc_on_1"), { nodeId: null });
  await deprovisionVPS("svc_on_1");
  assert.equal(on("node-1"), undefined);
});

test("containerNode: the recorded node, the only node, or nothing", () => {
  const [a, b] = [{ name: "a" }, { name: "b" }];
  assert.equal(containerNode(b, [a, b]), b);
  assert.equal(containerNode(null, [a]), a);
  assert.equal(containerNode(null, [a, b]), null);
  assert.equal(containerNode(undefined, []), null);
});

// ── Reprovision ──────────────────────────────────────────────────────

const snapshot = (over: Partial<ReprovisionSnapshot>) => ({ id: "svc_x", proxmoxVmId: null, nodeName: null, ...over }) as ReprovisionSnapshot;

test("reprovision: another customer's container 100 on the other node doesn't count as this service's", async () => {
  cluster.containers.get("node-2")!.delete(100);
  const found = await prismaReprovisionDeps().findContainers(snapshot({ id: "svc_on_2", proxmoxVmId: "100", nodeName: "node-2" }));
  assert.deepEqual(found, []);
  assert.deepEqual(writesTo(NODE_1), []);
});

test("reprovision: finds it on its own node, and by name on any node", async () => {
  const deps = prismaReprovisionDeps();
  assert.deepEqual(await deps.findContainers(snapshot({ id: "other", proxmoxVmId: "100", nodeName: "node-2" })), ["vmid 100 on node-2 (running)"]);
  assert.deepEqual(await deps.findContainers(snapshot({ id: "svc_on_2" })), ['vmid 100 "sowsi-svc_on_2" on node-2 (running)']);
});

test("reprovision: a VM id with no node recorded is reported, not looked up on a guessed node", async () => {
  cluster.requests.length = 0;
  const found = await prismaReprovisionDeps().findContainers(snapshot({ id: "other", proxmoxVmId: "100" }));
  assert.deepEqual(found, ["vmid 100 with no node recorded and 2 nodes registered — can't tell which container that is"]);
  assert.ok(!cluster.requests.some((r) => r.path.endsWith("/status/current")));
});

// ── Engine: targets, RAM, monitors ───────────────────────────────────

test("--vmid without --node is refused with several nodes; with --node it's that node's service", async () => {
  await assert.rejects(targetForContainer({ vmid: 100, planRamMB: 0, planDiskGB: 0 }), /could be on any of node-1, node-2 — pass --node/);
  assert.equal((await targetForContainer({ nodeName: "node-2", vmid: 100, planRamMB: 0, planDiskGB: 0 })).serviceId, "svc_on_2");
  assert.equal((await targetForContainer({ nodeName: "node-1", vmid: 100, planRamMB: 0, planDiskGB: 0 })).serviceId, "svc_on_1");
  await assert.rejects(targetForContainer({ nodeName: "node-9", vmid: 100, planRamMB: 0, planDiskGB: 0 }), /node-9 is not registered/);
  db.nodes.splice(1, 1);
  assert.equal((await targetForContainer({ vmid: 100, planRamMB: 0, planDiskGB: 0 })).serviceId, "svc_on_1", "one node: nothing to choose");
});

test("RAM scaling acts on the service's own node", async () => {
  const deps = prismaRamDeps();
  const target = await targetForService("svc_on_2");
  on("node-1")!.memoryMB = 4096;
  assert.equal(await deps.readMemoryMB(target), 2048);
  await deps.writeMemoryMB(target, 3072);
  assert.equal(on("node-2")!.memoryMB, 3072);
  assert.equal(on("node-1")!.memoryMB, 4096);
  assert.deepEqual(requestsTo(NODE_1), []);
});

test("monitors: the same VM id on two nodes stays two containers, with the right service, metric and alert", async () => {
  on("node-2")!.memUsedMB = 2000; // 97%: an emergency on node 2 only
  const bus = new EventBus({ now: () => 1000, defaultDedupeMs: 1 });
  const events: EngineEvent[] = [];
  bus.subscribe("*", (e) => void events.push(e));
  const samples = await new ContainerMonitor(bus, prismaContainerDeps(), loadEngineConfig({}), { log: silentLogger, now: () => 1000 }).pollOnce();

  assert.deepEqual(samples.map((s) => [s.nodeName, s.vmid, s.serviceId]).sort(), [
    ["node-1", 100, "svc_on_1"],
    ["node-2", 100, "svc_on_2"],
  ]);
  assert.deepEqual(db.metrics.map((m) => [m.serviceId, m.ramUsedMB]).sort(), [
    ["svc_on_1", 200],
    ["svc_on_2", 2000],
  ]);
  assert.deepEqual([...new Set(events.map((e) => e.subject))], ["service:svc_on_2"], "the alert names the right customer");
  await bus.drain();
});
