import { test } from "node:test";
import assert from "node:assert/strict";
import { DiskExpander, type DiskExpanderDeps, type DiskPlan, type VolumeSpace } from "./DiskExpander";
import { readContainerDisks } from "./lxcConfig";
import type { Blocked, ContainerTarget, EngineLogEntry } from "./types";

const GB = 1024 ** 3;
const config = { containerStorage: "local", diskPoolReserveGB: 20, diskExpandChunkGB: 10, volumeCostPerGbPaise: 530 };

const target = (over: Partial<ContainerTarget> = {}): ContainerTarget => ({
  node: { id: "node_1", name: "sowsi-proxmox-01", ip: "10.0.0.1" },
  vmid: 101,
  serviceId: "svc_a",
  planRamMB: 2048,
  planDiskGB: 40,
  ...over,
});

/** In-memory container + node. Pool: 150 GB storage with `allocatedGB` promised. */
function fake(opts: { rootGB?: number; data?: { storage: string; gb: number }; allocatedGB?: number; volumes?: VolumeSpace[]; optIn?: boolean; failGrow?: boolean } = {}) {
  const config_: Record<string, string> = { rootfs: `local:101/vm-101-disk-0.raw,size=${opts.rootGB ?? 40}G` };
  if (opts.data) config_.mp0 = `${opts.data.storage}:101/vm-101-disk-1.raw,mp=/data,backup=1,size=${opts.data.gb}G`;
  const state = { config: config_, logs: [] as EngineLogEntry[], recorded: [] as unknown[], calls: [] as string[] };
  const setSize = (key: string, gb: number) => (state.config[key] = state.config[key].replace(/size=\d+G/, `size=${gb}G`));
  const deps: DiskExpanderDeps = {
    readDisks: async () => readContainerDisks(state.config),
    poolStatus: async () => ({ totalBytes: 150 * GB, allocatedBytes: (opts.allocatedGB ?? 60) * GB }),
    volumes: async () => opts.volumes ?? [],
    overageOptIn: async () => opts.optIn ?? false,
    createMount: async (_t, key, storage, gb, path) => {
      state.calls.push(`create ${key} ${storage} ${gb}G ${path}`);
      state.config[key] = `${storage}:101/vm-101-disk-9.raw,mp=${path},backup=1,size=${gb}G`;
    },
    growDisk: async (_t, key, size) => {
      if (opts.failGrow) throw new Error("resize failed");
      state.calls.push(`grow ${key} ${size}`);
      const cur = readContainerDisks(state.config);
      const disk = key === "rootfs" ? cur.root : cur.data!;
      setSize(key, size.startsWith("+") ? disk.sizeGB + Number(size.slice(1, -1)) : Number(size.slice(0, -1)));
    },
    recordRoot: async (_t, gb) => void state.recorded.push({ root: gb }),
    recordData: async (_t, d) => void state.recorded.push(d),
    log: async (e) => void state.logs.push(e),
  };
  return { state, expander: new DiskExpander(deps, config) };
}

const blocked = (r: DiskPlan | Blocked) => (r.ok ? null : r.code);

test("free pool = storage − allocated − 20 GB reserve", async () => {
  const { expander } = fake({ allocatedGB: 60 });
  assert.equal(await expander.poolFreeGB(target().node), 70);
});

test("extra space is refused unless the client opted in to overage — disk stops at the plan", async () => {
  const { expander, state } = fake({ optIn: false });
  const r = await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "DISK_CRITICAL" });
  assert.equal(blocked(r), "OVERAGE_NOT_ENABLED");
  if (!r.ok) assert.equal(r.next?.kind, "NOTIFY_CLIENT");
  assert.deepEqual(state.calls, []);
});

test("opted in, no /data yet: creates /data on the free pool at no new cost", async () => {
  const { expander, state } = fake({ optIn: true });
  const plan = (await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "DISK_CRITICAL 88%" })) as DiskPlan;
  assert.deepEqual(
    { op: plan.operation, src: plan.source, key: plan.diskKey, add: plan.addGB, cost: plan.monthlyCostPaise, after: plan.after },
    { op: "CREATE_DATA", src: "FREE_POOL", key: "mp0", add: 10, cost: 0, after: { rootGB: 40, dataGB: 10 } }
  );
  assert.deepEqual(state.calls, [], "plan changes nothing");

  assert.deepEqual(await expander.execute(plan, "MANUAL"), { rootGB: 40, dataGB: 10 });
  assert.deepEqual(state.calls, ["create mp0 local 10G /data"]);
  assert.deepEqual(state.recorded, [{ sizeGB: 10, storage: "local", volumeId: null, addedGB: 10 }]);
  assert.equal(state.logs[0].action, "DISK_CREATE_DATA");
});

test("the root disk is never grown past the plan for extra space", async () => {
  const { expander } = fake({ optIn: true, rootGB: 40 });
  const plan = (await expander.plan(target(), { purpose: "EXTRA_SPACE", addGB: 25, reason: "x" })) as DiskPlan;
  assert.equal(plan.after.rootGB, 40);
  assert.equal(plan.after.dataGB, 25);
});

test("pool too small → uses an attached Volume (existing spend, cost tracked)", async () => {
  const vol: VolumeSpace = { id: "vol_1", storage: "hcloud-vol-1", sizeGB: 100, allocatedGB: 40 };
  // pool free = 150 − 125 − 20 = 5 GB < 10 × 1.2
  const { expander, state } = fake({ optIn: true, allocatedGB: 125, volumes: [vol] });
  const plan = (await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })) as DiskPlan;
  assert.deepEqual(
    { op: plan.operation, src: plan.source, storage: plan.storage, vol: plan.volumeId, newSpend: plan.monthlyCostPaise, attributed: plan.attributedCostPaise },
    { op: "CREATE_DATA", src: "VOLUME", storage: "hcloud-vol-1", vol: "vol_1", newSpend: 0, attributed: 5300 }
  );
  await expander.execute(plan, "MANUAL");
  assert.deepEqual(state.calls, ["create mp0 hcloud-vol-1 10G /data"]);
});

test("no pool room and no Volume → NEEDS_VOLUME with the purchase cost", async () => {
  const { expander } = fake({ optIn: true, allocatedGB: 125 });
  const r = await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" });
  assert.equal(blocked(r), "NEEDS_VOLUME");
  if (!r.ok) assert.deepEqual(r.next, { kind: "VOLUME_PURCHASE", detail: "attach a 100 GB Hetzner Volume", monthlyCostPaise: 53_000 });
});

test("an existing /data grows only on its own storage", async () => {
  const onPool = fake({ optIn: true, data: { storage: "local", gb: 10 } });
  const p1 = (await onPool.expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })) as DiskPlan;
  assert.deepEqual([p1.operation, p1.source, p1.diskKey, p1.after.dataGB], ["RESIZE_DATA", "FREE_POOL", "mp0", 20]);
  await onPool.expander.execute(p1, "MANUAL");
  assert.deepEqual(onPool.state.calls, ["grow mp0 +10G"]);

  // /data on a full Volume, even with pool space free → can't move it, needs Volume space
  const onFullVolume = fake({
    optIn: true,
    data: { storage: "hcloud-vol-1", gb: 95 },
    volumes: [{ id: "vol_1", storage: "hcloud-vol-1", sizeGB: 100, allocatedGB: 95 }],
  });
  assert.equal(blocked(await onFullVolume.expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })), "NEEDS_VOLUME");
});

test("GROW_TO_PLAN raises the root disk to exactly the plan size, from the pool", async () => {
  const { expander, state } = fake({ rootGB: 20 });
  const plan = (await expander.plan(target(), { purpose: "GROW_TO_PLAN", reason: "plan upgraded" })) as DiskPlan;
  assert.deepEqual([plan.operation, plan.addGB, plan.after.rootGB], ["RESIZE_ROOT", 20, 40]);
  await expander.execute(plan, "MANUAL");
  assert.deepEqual(state.calls, ["grow rootfs 40G"]);
  assert.deepEqual(state.recorded, [{ root: 40 }]);

  const atPlan = fake({ rootGB: 40 });
  assert.equal(blocked(await atPlan.expander.plan(target(), { purpose: "GROW_TO_PLAN", reason: "x" })), "ROOT_AT_PLAN");
});

test("execute refuses if disks changed since planning; failures are logged and rethrown", async () => {
  const { expander, state } = fake({ optIn: true, data: { storage: "local", gb: 10 } });
  const plan = (await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })) as DiskPlan;
  state.config.mp0 = state.config.mp0.replace("size=10G", "size=15G");
  await assert.rejects(expander.execute(plan, "AUTO_ENGINE"), /changed since planning/);
  assert.deepEqual(state.calls, []);
  assert.equal(state.logs[0].success, false);

  const failing = fake({ optIn: true, data: { storage: "local", gb: 10 }, failGrow: true });
  const p2 = (await failing.expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })) as DiskPlan;
  await assert.rejects(failing.expander.execute(p2, "AUTO_ENGINE"), /resize failed/);
  assert.match(failing.state.logs[0].error ?? "", /resize failed/);
});

test("logPlanOnly records a dry run", async () => {
  const { expander, state } = fake({ optIn: true });
  const plan = (await expander.plan(target(), { purpose: "EXTRA_SPACE", reason: "x" })) as DiskPlan;
  await expander.logPlanOnly(plan, "AUTO_ENGINE", "DISK_EXPAND is set to ASSISTED");
  assert.equal(state.logs[0].dryRun, true);
  assert.equal(state.logs[0].action, "DISK_CREATE_DATA_PLANNED");
  assert.deepEqual(state.calls, []);
});
