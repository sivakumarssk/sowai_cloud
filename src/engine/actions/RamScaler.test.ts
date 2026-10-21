import { test } from "node:test";
import assert from "node:assert/strict";
import { RamScaler, type RamPlan, type RamScalerDeps } from "./RamScaler";
import type { ContainerTarget, EngineLogEntry } from "./types";

const target = (over: Partial<ContainerTarget> = {}): ContainerTarget => ({
  node: { id: "node_1", name: "sowsi-proxmox-01", ip: "10.0.0.1" },
  vmid: 101,
  serviceId: "svc_a",
  planRamMB: 2048,
  planDiskGB: 40,
  ...over,
});

function fake(memoryMB: number, opts: { ignoreWrites?: boolean; failWrite?: boolean } = {}) {
  const state = { memoryMB, writes: [] as number[], recorded: [] as number[], logs: [] as EngineLogEntry[] };
  const deps: RamScalerDeps = {
    readMemoryMB: async () => state.memoryMB,
    writeMemoryMB: async (_t, mb) => {
      if (opts.failWrite) throw new Error("proxmox: 500");
      state.writes.push(mb);
      if (!opts.ignoreWrites) state.memoryMB = mb;
    },
    recordAllocation: async (_t, mb) => void state.recorded.push(mb),
    log: async (e) => void state.logs.push(e),
  };
  return { state, scaler: new RamScaler(deps, { ramExpandChunkMB: 512, ramMaxMultiplier: 2 }) };
}

test("plan adds the default 512 MB chunk and changes nothing", async () => {
  const { state, scaler } = fake(2048);
  const plan = (await scaler.plan(target(), { reason: "RAM_CRITICAL 88%" })) as RamPlan;
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.beforeMB, plan.afterMB, plan.deltaMB, plan.monthlyCostPaise], [2048, 2560, 512, 0]);
  assert.match(plan.summary, /raise RAM of container 101 .* 2048 MB to 2560 MB/);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.logs, []);
});

test("never above plan × 2: clamps, then reports the ceiling", async () => {
  const { scaler } = fake(3800);
  const clamped = (await scaler.plan(target(), { addMB: 512, reason: "x" })) as RamPlan;
  assert.equal(clamped.afterMB, 4096);
  assert.equal(clamped.clamped, true);
  assert.match(clamped.summary, /\(maximum\)/);

  const { scaler: atMax } = fake(4096);
  const blocked = await atMax.plan(target(), { addMB: 512, reason: "x" });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "AT_RAM_CEILING");
    assert.equal(blocked.next?.kind, "UPGRADE_PLAN");
  }
});

test("never below the plan size", async () => {
  const { scaler } = fake(3072);
  const plan = (await scaler.plan(target(), { toMB: 1024, reason: "usage dropped" })) as RamPlan;
  assert.equal(plan.afterMB, 2048, "floor is the paid plan");
  assert.match(plan.summary, /lower .* \(plan size\)/);

  const { scaler: atPlan } = fake(2048);
  const none = await atPlan.plan(target(), { toMB: 1024, reason: "x" });
  assert.deepEqual(none.ok ? null : none.code, "NO_CHANGE");
});

test("execute applies, verifies, records on the Service and logs", async () => {
  const { state, scaler } = fake(2048);
  const plan = (await scaler.plan(target(), { reason: "RAM_CRITICAL" })) as RamPlan;
  assert.deepEqual(await scaler.execute(plan, "AUTO_ENGINE"), { afterMB: 2560 });
  assert.deepEqual(state.writes, [2560]);
  assert.deepEqual(state.recorded, [2560]);
  assert.equal(state.logs.length, 1);
  assert.deepEqual(
    { action: state.logs[0].action, success: state.logs[0].success, dryRun: state.logs[0].dryRun, cost: state.logs[0].cost },
    { action: "RAM_SCALED_UP", success: undefined, dryRun: undefined, cost: 0 }
  );
});

test("an unmanaged test container is changed but nothing is written to Service", async () => {
  const { state, scaler } = fake(2048);
  const plan = (await scaler.plan(target({ serviceId: null }), { reason: "live test" })) as RamPlan;
  await scaler.execute(plan, "MANUAL");
  assert.deepEqual(state.recorded, []);
  assert.equal(state.logs[0].serviceId, null);
});

test("refuses if RAM changed since planning; logs failures and rethrows", async () => {
  const { state, scaler } = fake(2048);
  const plan = (await scaler.plan(target(), { reason: "x" })) as RamPlan;
  state.memoryMB = 3072; // someone changed it in between
  await assert.rejects(scaler.execute(plan, "AUTO_ENGINE"), /changed since planning/);
  assert.deepEqual(state.writes, []);
  assert.equal(state.logs[0].success, false);

  const failing = fake(2048, { failWrite: true });
  const p2 = (await failing.scaler.plan(target(), { reason: "x" })) as RamPlan;
  await assert.rejects(failing.scaler.execute(p2, "AUTO_ENGINE"), /500/);
  assert.match(failing.state.logs[0].error ?? "", /500/);
});

test("detects a write Proxmox didn't apply", async () => {
  const { scaler } = fake(2048, { ignoreWrites: true });
  const plan = (await scaler.plan(target(), { reason: "x" })) as RamPlan;
  await assert.rejects(scaler.execute(plan, "AUTO_ENGINE"), /reports 2048 MB after setting 2560 MB/);
});

test("logPlanOnly records a dry run with the reason it didn't run", async () => {
  const { state, scaler } = fake(2048);
  const plan = (await scaler.plan(target(), { reason: "RAM_CRITICAL" })) as RamPlan;
  await scaler.logPlanOnly(plan, "AUTO_ENGINE", "engine is in OBSERVE mode");
  assert.deepEqual(state.writes, []);
  assert.equal(state.logs[0].dryRun, true);
  assert.equal(state.logs[0].action, "RAM_SCALE_UP_PLANNED");
  assert.deepEqual((state.logs[0].after as { notExecutedBecause: string }).notExecutedBecause, "engine is in OBSERVE mode");
});
