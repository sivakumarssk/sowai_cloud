import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor, APPROVAL_TTL_MS, type ActionHandler, type ApprovalRecord, type ApprovalStore } from "./ActionExecutor";
import { DecisionMaker, type DecisionMakerDeps, type NodeState } from "./DecisionMaker";
import { buildHandlers, type HandlerDeps } from "./handlers";
import { EventBus } from "./EventBus";
import { loadEngineSettings, type ActionKind } from "./policy";
import type { Decision } from "./decisions";
import type { EngineEvent } from "./events";
import type { ContainerTarget, EngineLogEntry } from "../actions/types";
import { silentLogger } from "../log";

// ── Fakes ─────────────────────────────────────────────────────────────

type Row = ApprovalRecord & { status: string; expiresAt: Date };

function memoryApprovals() {
  const rows: Row[] = [];
  const store: ApprovalStore = {
    findOpen: async (kind, subject) =>
      rows.find((r) => r.kind === kind && r.subject === subject && (r.status === "PENDING" || r.status === "APPROVED")) ?? null,
    create: async ({ decision, expiresAt, overCap }) => {
      const id = `appr_${rows.length + 1}`;
      rows.push({
        id,
        kind: decision.kind,
        subject: decision.subject,
        summary: decision.summary,
        payload: decision.payload,
        monthlyCostPaise: decision.monthlyCostPaise,
        overCapAtRequest: overCap,
        decidedBy: null,
        status: "PENDING",
        expiresAt,
      });
      return { id };
    },
    expireDue: async (now) => {
      const due = rows.filter((r) => r.status === "PENDING" && r.expiresAt <= now);
      for (const r of due) r.status = "EXPIRED";
      return due;
    },
    claimApproved: async () => {
      const ready = rows.filter((r) => r.status === "APPROVED");
      for (const r of ready) r.status = "RUNNING";
      return ready;
    },
    finish: async (id, status, result) => {
      const r = rows.find((x) => x.id === id)!;
      r.status = status;
      (r as Row & { result?: string }).result = result;
    },
  };
  const approve = (id: string, by: string) => {
    const r = rows.find((x) => x.id === id)!;
    r.status = "APPROVED";
    r.decidedBy = by;
  };
  return { store, rows, approve };
}

function harness(opts: { env?: Record<string, string>; spent?: number; handlers?: Partial<Record<ActionKind, ActionHandler>> } = {}) {
  let clock = Date.parse("2026-10-21T10:00:00Z");
  const ran: string[] = [];
  const alerts: string[] = [];
  const logs: EngineLogEntry[] = [];
  const approvals = memoryApprovals();
  const spend = { value: opts.spent ?? 0 };
  const record =
    (kind: string): ActionHandler =>
    async (p, ctx) => (ran.push(`${kind}${ctx.approval ? ` by ${ctx.approval.approvedBy}` : ""}`), `${kind} done (${p.kind})`);
  const executor = new ActionExecutor(
    {
      settings: () => loadEngineSettings(opts.env ?? {}),
      spentThisMonthPaise: async () => spend.value,
      handlers: opts.handlers ?? {
        RAM_SCALE: record("RAM_SCALE"),
        DISK_EXPAND: record("DISK_EXPAND"),
        VOLUME_PURCHASE: record("VOLUME_PURCHASE"),
        NOTIFY_CLIENT: record("NOTIFY_CLIENT"),
        ALERT_ADMIN: record("ALERT_ADMIN"),
        STOP_SIGNUPS: record("STOP_SIGNUPS"),
      },
      approvals: approvals.store,
      alertAdmin: async (title) => void alerts.push(title),
      log: async (e) => void logs.push(e),
      approveHint: (id) => `approve ${id}`,
    },
    { log: silentLogger, now: () => clock }
  );
  return { executor, ran, alerts, logs, approvals, spend, advance: (ms: number) => (clock += ms) };
}

const ramDecision: Decision = {
  kind: "RAM_SCALE",
  subject: "service:svc_1",
  summary: "raise RAM of container 100 from 2048 MB to 2560 MB",
  reason: "RAM_CRITICAL: 88%",
  monthlyCostPaise: 0,
  payload: { kind: "RAM_SCALE", serviceId: "svc_1", addMB: 512 },
};
const diskDecision: Decision = {
  kind: "DISK_EXPAND",
  subject: "service:svc_1",
  summary: "add 10 GB at /data",
  reason: "DISK_CRITICAL: 90%",
  monthlyCostPaise: 0,
  payload: { kind: "DISK_EXPAND", serviceId: "svc_1", purpose: "EXTRA_SPACE", addGB: 10 },
};
const volumeDecision: Decision = {
  kind: "VOLUME_PURCHASE",
  subject: "node:sowsi-proxmox-01",
  summary: "buy a 100 GB Hetzner Volume (₹530/month)",
  reason: "DISK_FULL; pool full",
  monthlyCostPaise: 53_000,
  payload: { kind: "VOLUME_PURCHASE", nodeName: "sowsi-proxmox-01", sizeGB: 100 },
};

// ── ActionExecutor: the policy gate in practice ───────────────────────

test("OBSERVE (the default) only logs: nothing runs, nobody is emailed, no approval", async () => {
  const h = harness();
  for (const d of [ramDecision, diskDecision, volumeDecision]) {
    const out = await h.executor.handle(d);
    assert.equal(out.verdict, "LOG_ONLY");
  }
  // OBSERVE wins even over an action set to AUTO.
  const h2 = harness({ env: { ENGINE_ACTION_RAM_SCALE: "AUTO", ENGINE_ACTION_ALERT_ADMIN: "AUTO" } });
  assert.equal((await h2.executor.handle(ramDecision)).verdict, "LOG_ONLY");

  assert.deepEqual([...h.ran, ...h.alerts, ...h.approvals.rows], []);
  assert.equal(h.logs.length, 3);
  assert.ok(h.logs.every((l) => l.dryRun === true && l.action.startsWith("DECISION_")));
  assert.equal((h.logs[0].after as { why: string }).why, "engine is in OBSERVE mode");
  assert.equal(h.logs[0].serviceId, "svc_1");
});

test("AUTO mode runs RAM scaling (RAM_SCALE defaults to AUTO)", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO" } });
  const out = await h.executor.handle(ramDecision);
  assert.equal(out.verdict, "EXECUTE");
  assert.deepEqual(h.ran, ["RAM_SCALE"]);
  assert.equal(h.logs[0].dryRun, false);
  assert.equal(h.logs[0].success, true);
});

test("ASSISTED: one approval request and one email per kind + subject", async () => {
  const h = harness({ env: { ENGINE_MODE: "ASSISTED" } });
  const first = await h.executor.handle(diskDecision);
  const again = await h.executor.handle(diskDecision);
  assert.equal(first.verdict, "REQUEST_APPROVAL");
  assert.equal(first.approvalId, "appr_1");
  assert.equal(again.approvalId, "appr_1");
  assert.match(again.reason, /already waiting/);
  assert.equal(h.approvals.rows.length, 1);
  assert.deepEqual(h.alerts, ["Approval needed: add 10 GB at /data"]);
  assert.deepEqual(h.ran, []);
  // RAM_SCALE is AUTO, but ASSISTED is stricter.
  assert.equal((await h.executor.handle(ramDecision)).verdict, "REQUEST_APPROVAL");
});

test("a Volume is never bought without approval — even with everything set to AUTO", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO", ENGINE_ACTION_VOLUME_PURCHASE: "AUTO" } });
  const out = await h.executor.handle(volumeDecision);
  assert.equal(out.verdict, "REQUEST_APPROVAL");
  assert.match(out.reason, /purchases always need admin approval/);
  assert.deepEqual(h.ran, []);

  // And the real handler refuses outright without an approval.
  const bought: string[] = [];
  const handlers = buildHandlers({
    volumeManager: {
      plan: async () => ({ ok: true, sizeGB: 100 }) as never,
      execute: async () => (bought.push("execute"), { id: "v", hetznerVolumeId: 1, storage: "s" }),
    },
    volumeNode: async () => ({}) as never,
  } as unknown as HandlerDeps);
  await assert.rejects(handlers.VOLUME_PURCHASE!(volumeDecision.payload, { trigger: "AUTO_ENGINE" }), /admin approval required/);
  await assert.rejects(handlers.VOLUME_PURCHASE!(volumeDecision.payload, { trigger: "MANUAL", approval: { approvedBy: " " } }), /admin approval required/);
  assert.deepEqual(bought, []);
  assert.match(await handlers.VOLUME_PURCHASE!(volumeDecision.payload, { trigger: "MANUAL", approval: { approvedBy: "sivakumar" } }), /Volume 1/);
});

test("Volume purchase default (MANUAL) only recommends, even in AUTO mode", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO" } });
  const out = await h.executor.handle(volumeDecision);
  assert.equal(out.verdict, "RECOMMEND");
  assert.deepEqual(h.alerts, ["Engine recommends: buy a 100 GB Hetzner Volume (₹530/month)"]);
  assert.deepEqual([...h.ran, ...h.approvals.rows], []);
});

test("spend over the ₹5,000 cap always asks for approval, and says why", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO", ENGINE_ACTION_VOLUME_PURCHASE: "ASSISTED" }, spent: 460_000 });
  const out = await h.executor.handle(volumeDecision);
  assert.equal(out.verdict, "REQUEST_APPROVAL");
  assert.match(out.reason, /₹5,130, over the ₹5,000 cap/);
  assert.equal(h.approvals.rows[0].overCapAtRequest, true);
});

test("approved requests run with the approver's name; expired ones never run", async () => {
  const h = harness({ env: { ENGINE_MODE: "ASSISTED", ENGINE_ACTION_VOLUME_PURCHASE: "ASSISTED" } });
  const a = await h.executor.handle(diskDecision);
  const b = await h.executor.handle(volumeDecision);
  h.approvals.approve(a.approvalId!, "sivakumar");

  let r = await h.executor.processApprovals();
  assert.deepEqual(r, { expired: 0, executed: 1, failed: 0 });
  assert.deepEqual(h.ran, ["DISK_EXPAND by sivakumar"]);
  assert.equal(h.approvals.rows[0].status, "EXECUTED");

  h.advance(APPROVAL_TTL_MS + 1);
  r = await h.executor.processApprovals();
  assert.equal(r.expired, 1);
  assert.equal(h.approvals.rows.find((x) => x.id === b.approvalId)!.status, "EXPIRED");
  assert.equal((await h.executor.processApprovals()).executed, 0);
  assert.deepEqual(h.ran, ["DISK_EXPAND by sivakumar"]);
  assert.ok(h.logs.some((l) => l.action === "APPROVAL_EXPIRED"));
});

test("an approved purchase re-checks the cap when it runs", async () => {
  const h = harness({ env: { ENGINE_MODE: "ASSISTED", ENGINE_ACTION_VOLUME_PURCHASE: "ASSISTED" }, spent: 0 });
  const req = await h.executor.handle(volumeDecision);
  h.approvals.approve(req.approvalId!, "sivakumar");
  h.spend.value = 470_000; // something else was bought meanwhile

  const r = await h.executor.processApprovals();
  assert.deepEqual(r, { expired: 0, executed: 0, failed: 1 });
  assert.deepEqual(h.ran, []);
  assert.match((h.approvals.rows[0] as { result?: string }).result ?? "", /over the ₹5,000 cap/);

  // If the request itself said it was over the cap, the approver accepted that.
  const h2 = harness({ env: { ENGINE_MODE: "ASSISTED", ENGINE_ACTION_VOLUME_PURCHASE: "ASSISTED" }, spent: 470_000 });
  const req2 = await h2.executor.handle(volumeDecision);
  h2.approvals.approve(req2.approvalId!, "sivakumar");
  assert.equal((await h2.executor.processApprovals()).executed, 1);
  assert.deepEqual(h2.ran, ["VOLUME_PURCHASE by sivakumar"]);
});

test("OFF beats an approval granted earlier", async () => {
  const env: Record<string, string> = { ENGINE_MODE: "ASSISTED" };
  const h = harness({ env });
  const req = await h.executor.handle(diskDecision);
  h.approvals.approve(req.approvalId!, "sivakumar");
  env.ENGINE_ACTION_DISK_EXPAND = "OFF";
  assert.equal((await h.executor.processApprovals()).failed, 1);
  assert.deepEqual(h.ran, []);
});

test("actions with no automation (migration, server purchase) are only recommended", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO", ENGINE_ACTION_MIGRATION: "AUTO" } });
  const out = await h.executor.handle({
    kind: "MIGRATION",
    subject: "service:svc_1",
    summary: "move service svc_1 tonight",
    reason: "RAM_EMERGENCY",
    monthlyCostPaise: 0,
    payload: { kind: "MIGRATION", serviceId: "svc_1", nodeName: "sowsi-proxmox-01", urgency: "TONIGHT", detail: "node full" },
  });
  assert.equal(out.verdict, "RECOMMEND");
  assert.match(out.reason, /isn't automated yet/);
  assert.deepEqual(h.alerts, ["Engine recommends: move service svc_1 tonight"]);
  assert.deepEqual(h.approvals.rows, []);
});

test("STOP_SIGNUPS runs on its own in AUTO mode; a failing handler is logged as a failure", async () => {
  const h = harness({ env: { ENGINE_MODE: "AUTO" } });
  const stop: Decision = { kind: "STOP_SIGNUPS", subject: "node:n1", summary: "stop new clients on n1", reason: "SERVER_FULL", monthlyCostPaise: 0, payload: { kind: "STOP_SIGNUPS", nodeName: "n1" } };
  assert.equal((await h.executor.handle(stop)).verdict, "EXECUTE");
  assert.deepEqual(h.ran, ["STOP_SIGNUPS"]);

  const broken = harness({ env: { ENGINE_MODE: "AUTO" }, handlers: { RAM_SCALE: async () => Promise.reject(new Error("proxmox 500")) } });
  const out = await broken.executor.handle(ramDecision);
  assert.equal(out.result, "failed: proxmox 500");
  assert.equal(broken.logs[0].success, false);
});

test("ASSISTED: an admin alert is sent as itself, not as an approval request; OBSERVE sends nothing", async () => {
  const alert: Decision = { kind: "ALERT_ADMIN", subject: "node:n1", summary: "alert admin: n1 full", reason: "SERVER_FULL", monthlyCostPaise: 0, payload: { kind: "ALERT_ADMIN", title: "n1: server full", detail: "RAM 86%" } };
  const h = harness({ env: { ENGINE_MODE: "ASSISTED" } });
  assert.equal((await h.executor.handle(alert)).verdict, "RECOMMEND");
  assert.deepEqual(h.alerts, ["n1: server full"]);
  assert.deepEqual(h.approvals.rows, []);

  const observe = harness();
  await observe.executor.handle(alert);
  assert.deepEqual(observe.alerts, []);
});

// ── DecisionMaker: the rules ──────────────────────────────────────────

const target: ContainerTarget = { node: { id: "node_1", name: "sowsi-proxmox-01", ip: "10.0.0.1" }, vmid: 100, serviceId: "svc_1", planRamMB: 2048, planDiskGB: 20 };

function maker(opts: { nodeRam?: number | null; acceptNewClients?: boolean; ram?: unknown; disk?: unknown } = {}) {
  const submitted: Decision[] = [];
  const ramRequests: number[] = [];
  const node: NodeState = { name: "sowsi-proxmox-01", ramPct: opts.nodeRam === undefined ? 50 : opts.nodeRam, acceptNewClients: opts.acceptNewClients ?? true, monthlyCostPaise: 330_000 };
  const deps: DecisionMakerDeps = {
    nodeState: async () => node,
    target: async () => target,
    ramScaler: {
      plan: async (_t, req) => {
        ramRequests.push((req as { addMB: number }).addMB);
        return (opts.ram ?? { ok: true, summary: `raise RAM by ${(req as { addMB: number }).addMB} MB` }) as never;
      },
    },
    diskExpander: { plan: async () => (opts.disk ?? { ok: true, summary: "add 10 GB at /data", monthlyCostPaise: 0, addGB: 10 }) as never },
    submit: async (d) => (submitted.push(d), { verdict: "LOG_ONLY", reason: "test" }),
  };
  return { dm: new DecisionMaker(deps, { ramExpandChunkMB: 512, diskExpandChunkGB: 10, volumeCostPerGbPaise: 530, volumeSizeGB: 100 }, { log: silentLogger }), submitted, ramRequests };
}

const containerEvent = (type: string, pct = 90): EngineEvent =>
  ({ id: "e1", type, subject: "service:svc_1", source: "test", at: 0, data: { vmid: 100, serviceId: "svc_1", nodeId: "node_1", pct, used: 1843, limit: 2048, unit: "MB" } }) as EngineEvent;
const serverEvent = (type: string, pct = 85): EngineEvent =>
  ({ id: "e2", type, subject: "node:sowsi-proxmox-01", source: "test", at: 0, data: { nodeId: "node_1", nodeName: "sowsi-proxmox-01", pct, resource: "RAM" } }) as EngineEvent;
const kinds = (ds: Decision[]) => ds.map((d) => d.kind);

test("warnings and CPU_HIGH are only watched", async () => {
  const { dm } = maker();
  for (const t of ["RAM_WARNING", "DISK_WARNING", "CPU_HIGH"]) assert.deepEqual(await dm.decide(containerEvent(t)), []);
  for (const t of ["SERVER_RAM_WARNING", "SERVER_DISK_WARNING"]) assert.deepEqual(await dm.decide(serverEvent(t)), []);
});

test("RAM_CRITICAL: RAM step depends on how busy the node is", async () => {
  const roomy = maker({ nodeRam: 50 });
  assert.deepEqual(kinds(await roomy.dm.decide(containerEvent("RAM_CRITICAL"))), ["RAM_SCALE"]);
  assert.deepEqual(roomy.ramRequests, [512]);

  const tight = maker({ nodeRam: 75 });
  const [d] = await tight.dm.decide(containerEvent("RAM_CRITICAL"));
  assert.deepEqual(d.payload, { kind: "RAM_SCALE", serviceId: "svc_1", addMB: 256 });

  const full = maker({ nodeRam: 85 });
  assert.deepEqual(kinds(await full.dm.decide(containerEvent("RAM_CRITICAL"))), ["NOTIFY_CLIENT", "ALERT_ADMIN"]);
  assert.deepEqual(full.ramRequests, [], "no RAM added on a full node");

  const unknown = maker({ nodeRam: null });
  assert.deepEqual(kinds(await unknown.dm.decide(containerEvent("RAM_CRITICAL"))), ["NOTIFY_CLIENT", "ALERT_ADMIN"]);
});

test("RAM at the 2× ceiling → ask the client to upgrade", async () => {
  const { dm } = maker({ ram: { ok: false, code: "AT_RAM_CEILING", reason: "already at the maximum 4096 MB (2× the 2048 MB plan)" } });
  const ds = await dm.decide(containerEvent("RAM_CRITICAL"));
  assert.deepEqual(kinds(ds), ["NOTIFY_CLIENT"]);
  assert.equal((ds[0].payload as { template: string }).template, "UPGRADE_RAM");
});

test("RAM_EMERGENCY on a full node → migration tonight + admin alert", async () => {
  const { dm } = maker({ nodeRam: 86 });
  const ds = await dm.decide(containerEvent("RAM_EMERGENCY", 97));
  assert.deepEqual(kinds(ds), ["MIGRATION", "ALERT_ADMIN"]);
  assert.equal((ds[0].payload as { urgency: string }).urgency, "TONIGHT");
  assert.deepEqual(kinds(await maker({ nodeRam: 75 }).dm.decide(containerEvent("RAM_EMERGENCY", 97))), ["RAM_SCALE"]);
});

test("disk: expand for opted-in clients, otherwise email them; Volume only as a proposal", async () => {
  assert.deepEqual(kinds(await maker().dm.decide(containerEvent("DISK_CRITICAL"))), ["DISK_EXPAND"]);

  const noOverage = maker({ disk: { ok: false, code: "OVERAGE_NOT_ENABLED", reason: "client hasn't enabled paid overage" } });
  const [notice] = await noOverage.dm.decide(containerEvent("DISK_FULL", 99));
  assert.equal((notice.payload as { template: string }).template, "STORAGE_FULL");

  const poolFull = maker({ disk: { ok: false, code: "NEEDS_VOLUME", reason: "free pool has 3 GB" } });
  const ds = await poolFull.dm.decide(containerEvent("DISK_CRITICAL"));
  assert.deepEqual(kinds(ds), ["VOLUME_PURCHASE", "ALERT_ADMIN"]);
  assert.equal(ds[0].monthlyCostPaise, 53_000);
  assert.equal(ds[0].subject, "node:sowsi-proxmox-01");
});

test("server events: stop signups (once), alert, and propose a server on emergency", async () => {
  assert.deepEqual(kinds(await maker().dm.decide(serverEvent("SERVER_RAM_CRITICAL"))), ["STOP_SIGNUPS", "ALERT_ADMIN"]);
  assert.deepEqual(kinds(await maker({ acceptNewClients: false }).dm.decide(serverEvent("SERVER_FULL"))), ["ALERT_ADMIN"]);
  const emergency = await maker().dm.decide(serverEvent("SERVER_RAM_EMERGENCY", 93));
  assert.deepEqual(kinds(emergency), ["SERVER_PURCHASE", "STOP_SIGNUPS", "MIGRATION", "ALERT_ADMIN"]);
  assert.equal(emergency[0].monthlyCostPaise, 330_000);
  assert.deepEqual(kinds(await maker().dm.decide(serverEvent("SERVER_OVERLOADED"))), ["ALERT_ADMIN"]);
});

test("on the bus: events become submitted decisions, one at a time per subject", async () => {
  const bus = new EventBus();
  const { dm, submitted } = maker();
  const seen: string[] = [];
  dm.attach(bus, (e, results) => seen.push(`${e.type}: ${results.map((r) => r.outcome.verdict).join(",")}`));
  bus.publish({ type: "RAM_CRITICAL", subject: "service:svc_1", source: "test", data: { vmid: 100, serviceId: "svc_1", nodeId: "node_1", pct: 90, used: 1843, limit: 2048, unit: "MB" } });
  await bus.drain();
  assert.deepEqual(kinds(submitted), ["RAM_SCALE"]);
  assert.deepEqual(seen, ["RAM_CRITICAL: LOG_ONLY"]);
});

test("two events for one node in the same poll are both handled, in order, never at the same time", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  let active = 0;
  const { dm } = maker();
  const slowSubmit = async (d: Decision) => {
    active++;
    assert.equal(active, 1, "never two at once for one subject");
    order.push(d.kind);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { verdict: "LOG_ONLY" as const, reason: "test" };
  };
  (dm as unknown as { deps: DecisionMakerDeps }).deps.submit = slowSubmit;
  dm.attach(bus);
  bus.publish({ type: "SERVER_RAM_CRITICAL", subject: "node:sowsi-proxmox-01", source: "test", data: { nodeId: "node_1", nodeName: "sowsi-proxmox-01", pct: 86, resource: "RAM" } });
  bus.publish({ type: "SERVER_OVERLOADED", subject: "node:sowsi-proxmox-01", source: "test", data: { nodeId: "node_1", nodeName: "sowsi-proxmox-01", pct: 95, resource: "CPU" } });
  await bus.drain();
  assert.deepEqual(order, ["STOP_SIGNUPS", "ALERT_ADMIN", "ALERT_ADMIN"]);
  assert.equal(dm.stats().skippedBusy, 0);
});
