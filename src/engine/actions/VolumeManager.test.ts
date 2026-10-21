import { test } from "node:test";
import assert from "node:assert/strict";
import { VolumeManager, type VolumeManagerDeps, type VolumeNode, type VolumePlan } from "./VolumeManager";
import type { EngineLogEntry } from "./types";

const node: VolumeNode = { id: "node_1", name: "sowsi-proxmox-01", ip: "10.0.0.1", hetznerServerId: "168392011", location: "nbg1" };
const config = { volumeCostPerGbPaise: 530, defaultSizeGB: 100, spendCapPaise: 500_000 };

function fake(opts: { spent?: number; failMount?: boolean; failDelete?: boolean; disks?: string[] } = {}) {
  const calls: string[] = [];
  const logs: EngineLogEntry[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const deps: VolumeManagerDeps = {
    createVolume: async (i) => (calls.push(`create ${i.sizeGB}GB ${i.location}`), { id: 777 }),
    attachVolume: async (id, server) => void calls.push(`attach ${id} → ${server}`),
    deleteVolume: async (id) => {
      calls.push(`delete ${id}`);
      if (opts.failDelete) throw new Error("hetzner 503");
    },
    mountOnHost: async (_n, id) => {
      calls.push(`mount ${id}`);
      if (opts.failMount) throw new Error("device not found");
      return { storage: `sowsi-vol-${id}`, path: `/mnt/sowsi-vol-${id}` };
    },
    unmountOnHost: async (_n, id) => void calls.push(`unmount ${id}`),
    disksOnStorage: async () => opts.disks ?? [],
    insertVolume: async (row) => (rows.set("vol_db_1", { ...row }), "vol_db_1"),
    updateVolume: async (id, data) => void rows.set(id, { ...rows.get(id), ...data }),
    spentThisMonthPaise: async () => opts.spent ?? 0,
    log: async (e) => void logs.push(e),
  };
  return { manager: new VolumeManager(deps, config), calls, logs, rows };
}

const plan = async (m: VolumeManager, sizeGB?: number) => (await m.plan(node, { sizeGB, reason: "DISK_CRITICAL, pool full" })) as VolumePlan;

test("plan shows size, monthly cost and the cap — and buys nothing", async () => {
  const { manager, calls } = fake({ spent: 100_000 });
  const p = await plan(manager);
  assert.deepEqual([p.sizeGB, p.monthlyCostPaise, p.overCap], [100, 53_000, false]);
  assert.match(p.summary, /100 GB Hetzner Volume for sowsi-proxmox-01 \(₹530\/month\)/);
  assert.deepEqual(calls, []);

  const over = await plan(fake({ spent: 460_000 }).manager);
  assert.equal(over.overCap, true);
  assert.match(over.summary, /over the ₹5,000 cap/);

  assert.equal((await manager.plan(node, { sizeGB: 5, reason: "x" })).ok, false, "Hetzner minimum is 10 GB");
});

test("never buys a Volume without an admin's approval", async () => {
  const { manager, calls } = fake();
  const p = await plan(manager);
  for (const approval of [undefined, { approvedBy: "" }, { approvedBy: "   " }]) {
    await assert.rejects(manager.execute(p, approval as never), /admin approval required/);
  }
  assert.deepEqual(calls, [], "Hetzner was never called");
});

test("approved: create → record → attach → mount → ACTIVE, logged as spend", async () => {
  const { manager, calls, logs, rows } = fake();
  const result = await manager.execute(await plan(manager, 10), { approvedBy: "sivakumar", approvalId: "appr_1" });
  assert.deepEqual(result, { id: "vol_db_1", hetznerVolumeId: 777, storage: "sowsi-vol-777" });
  assert.deepEqual(calls, ["create 10GB nbg1", "attach 777 → 168392011", "mount 777"]);
  assert.deepEqual(rows.get("vol_db_1"), {
    hetznerVolumeId: "777",
    nodeId: "node_1",
    sizeGB: 10,
    costPerMonth: 5300,
    status: "ACTIVE",
    proxmoxStorage: "sowsi-vol-777",
    mountPath: "/mnt/sowsi-vol-777",
  });
  assert.equal(logs[0].action, "VOLUME_CREATED");
  assert.equal(logs[0].cost, 5300);
  assert.equal(logs[0].success, undefined);
  assert.equal((logs[0].after as { approvedBy: string }).approvedBy, "sivakumar");
});

test("a failed mount rolls back: Volume deleted, row DELETED, failure logged at no cost", async () => {
  const { manager, calls, logs, rows } = fake({ failMount: true });
  await assert.rejects(manager.execute(await plan(manager), { approvedBy: "sivakumar" }), /device not found/);
  assert.deepEqual(calls, ["create 100GB nbg1", "attach 777 → 168392011", "mount 777", "delete 777"]);
  assert.equal(rows.get("vol_db_1")?.status, "DELETED");
  assert.equal(logs[0].success, false);
  assert.equal(logs[0].cost, 0);
  assert.match(logs[0].error ?? "", /rolled back/);
});

test("if the rollback itself fails the Volume is marked ERROR and its cost logged", async () => {
  const { manager, logs, rows } = fake({ failMount: true, failDelete: true });
  await assert.rejects(manager.execute(await plan(manager), { approvedBy: "sivakumar" }));
  assert.equal(rows.get("vol_db_1")?.status, "ERROR");
  assert.equal(logs[0].cost, 53_000);
  assert.match(logs[0].error ?? "", /rollback FAILED, Volume 777 still exists and is billed/);
});

test("remove needs approval and refuses while disks are on the Volume", async () => {
  const stored = { id: "vol_db_1", hetznerVolumeId: "777", proxmoxStorage: "sowsi-vol-777", sizeGB: 10, node };
  const busy = fake({ disks: ["sowsi-vol-777:101/vm-101-disk-1.raw"] });
  await assert.rejects(busy.manager.remove(stored, { approvedBy: "" }), /admin approval required/);
  await assert.rejects(busy.manager.remove(stored, { approvedBy: "sivakumar" }), /still holds 1 disk/);
  assert.deepEqual(busy.calls, []);

  const empty = fake();
  await empty.manager.remove(stored, { approvedBy: "sivakumar" });
  assert.deepEqual(empty.calls, ["unmount 777", "delete 777"]);
  assert.equal(empty.rows.get("vol_db_1")?.status, "DELETED");
  assert.equal(empty.logs[0].action, "VOLUME_DELETED");
});

test("parses the node's mount-volume reply", async () => {
  const { parseMountOutput } = await import("../data/volumeDeps");
  assert.deepEqual(parseMountOutput("OK storage=sowsi-vol-777 path=/mnt/sowsi-vol-777\n"), { storage: "sowsi-vol-777", path: "/mnt/sowsi-vol-777" });
  assert.throws(() => parseMountOutput("device not found"), /unexpected mount-volume output/);
});
