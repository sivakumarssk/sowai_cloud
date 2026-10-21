import { test } from "node:test";
import assert from "node:assert/strict";
import { destroyContainerAndDisks, detachDataDisk, freeContainerDisks, isContainerDisk, type ContainerCleanupClient } from "./containerDisks";
import { diskVolumes, type LXCPendingEntry } from "./proxmox";

/**
 * A fake Proxmox node that behaves like the real one where it matters:
 *  - removing a mount point from a RUNNING container is only queued (pending)
 *    until restart, and the disk stays mounted;
 *  - when a removal is applied (stopped container or restart), the disk is
 *    remembered as unusedN; removing unusedN destroys the disk;
 *  - a new mount point on a running container whose key is still in use is
 *    queued; at restart it's allocated with the lowest free disk name;
 *  - the storage delete (pvesm free) does NOT check whether the disk is in use;
 *  - deleteLXC destroys every disk the config references plus unreferenced
 *    vm-<vmid>-* disks (destroy-unreferenced-disks).
 */
class FakeNode {
  readonly files = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  readonly cts = new Map<number, { running: boolean; current: Record<string, string>; pending: Record<string, string>; deletes: Set<string>; mounted: Set<string> }>();
  failUnusedDelete = false;
  silentDeleteFail = new Set<string>();
  throwOnDelete = new Set<string>();

  constructor(files: Record<string, string[]>) {
    for (const [s, v] of Object.entries(files)) this.files.set(s, new Set(v));
  }

  ct(vmid: number, running: boolean, config: Record<string, string>) {
    const mounted = new Set(running ? Object.entries(config).filter(([k]) => /^(rootfs|mp\d+)$/.test(k)).map(([, v]) => v.split(",")[0]) : []);
    this.cts.set(vmid, { running, current: { ...config }, pending: {}, deletes: new Set(), mounted });
    return this;
  }

  remaining = () => [...this.files.values()].flatMap((s) => [...s]).sort();
  config = (vmid: number) => this.cts.get(vmid)?.current;

  private unlink(volid: string) {
    this.files.get(volid.split(":")[0])?.delete(volid);
  }

  private allocate(vmid: number, spec: string): string {
    const [storage, size] = spec.split(",")[0].split(":");
    const set = this.files.get(storage)!;
    let n = 0;
    while (set.has(`${storage}:${vmid}/vm-${vmid}-disk-${n}.raw`)) n++;
    const volid = `${storage}:${vmid}/vm-${vmid}-disk-${n}.raw`;
    set.add(volid);
    return `${volid},${spec.split(",").slice(1).join(",")},size=${size}G`;
  }

  private addUnused(ct: { current: Record<string, string> }, volid: string) {
    let i = 0;
    while (`unused${i}` in ct.current) i++;
    ct.current[`unused${i}`] = volid;
  }

  /** Applies queued changes, like a container restart does. */
  restart(vmid: number) {
    const ct = this.cts.get(vmid)!;
    for (const key of ct.deletes) {
      const volid = ct.current[key].split(",")[0];
      delete ct.current[key];
      this.addUnused(ct, volid); // Proxmox doesn't check the file still exists
    }
    ct.deletes.clear();
    for (const [key, spec] of Object.entries(ct.pending)) ct.current[key] = this.allocate(vmid, spec);
    ct.pending = {};
    ct.mounted = new Set(Object.entries(ct.current).filter(([k]) => /^(rootfs|mp\d+)$/.test(k)).map(([, v]) => v.split(",")[0]));
  }

  client(): ContainerCleanupClient {
    return {
      listContainerStorages: async () => [...this.files.keys()],
      listStorageVolumes: async (s) =>
        [...(this.files.get(s) ?? [])].map((volid) => ({ volid, vmid: Number(volid.match(/-(\d+)-disk-/)?.[1]), size: 10 * 1024 ** 3, used: null })),
      deleteStorageVolume: async (_s, volid) => {
        this.calls.push(`free ${volid}`);
        if (this.throwOnDelete.has(volid)) throw new Error("volume is busy");
        if (this.silentDeleteFail.has(volid)) return; // API says OK, file stays
        this.unlink(volid); // no in-use check — exactly like Proxmox
      },
      getLXCPending: async (vmid) => {
        const ct = this.cts.get(vmid);
        if (!ct) throw new Error(`Configuration file 'nodes/n1/lxc/${vmid}.conf' does not exist`);
        const keys = new Set([...Object.keys(ct.current), ...Object.keys(ct.pending), ...ct.deletes]);
        return [...keys].map((key): LXCPendingEntry => ({ key, value: ct.current[key], pending: ct.pending[key], delete: ct.deletes.has(key) ? 1 : undefined }));
      },
      updateLXCConfig: async (vmid, params) => {
        const ct = this.cts.get(vmid)!;
        for (const key of String(params.delete ?? "").split(",").filter(Boolean)) {
          this.calls.push(`delete ${key}`);
          if (/^unused\d+$/.test(key)) {
            if (this.failUnusedDelete) throw new Error("unable to remove unused volume");
            const volid = ct.current[key];
            delete ct.current[key];
            const stillUsed = Object.values(ct.current).some((v) => v.split(",")[0] === volid);
            if (!stillUsed) this.unlink(volid);
          } else if (ct.running) {
            ct.deletes.add(key); // can't unmount from a running container: queued
          } else {
            const volid = ct.current[key].split(",")[0];
            delete ct.current[key];
            this.addUnused(ct, volid);
          }
        }
        for (const [key, value] of Object.entries(params)) {
          if (key === "delete" || value === undefined) continue;
          this.calls.push(`set ${key}`);
          if (ct.running && (key in ct.current || ct.deletes.has(key))) ct.pending[key] = String(value);
          else ct.current[key] = this.allocate(vmid, String(value));
        }
      },
      deleteLXC: async (vmid) => {
        this.calls.push(`destroy ct ${vmid}`);
        if (!this.cts.has(vmid)) return;
        for (const set of this.files.values()) for (const v of [...set]) if (isContainerDisk(v, vmid)) set.delete(v);
        this.cts.delete(vmid);
      },
    };
  }
}

const ROOT = "local:100/vm-100-disk-0.raw";
const DATA = "local:100/vm-100-disk-1.raw";
const withData = (running: boolean) =>
  new FakeNode({ local: [ROOT, DATA] }).ct(100, running, { rootfs: `${ROOT},size=20G`, mp0: `${DATA},mp=/data,backup=1,size=10G` });

test("isContainerDisk matches only this vmid's images", () => {
  assert.ok(isContainerDisk("local:100/vm-100-disk-1.raw", 100));
  assert.ok(isContainerDisk("sowsi-vol-7:100/vm-100-disk-0.raw", 100));
  assert.ok(isContainerDisk("local-zfs:subvol-100-disk-0", 100));
  assert.ok(!isContainerDisk("local:1000/vm-1000-disk-0.raw", 100));
  assert.ok(!isContainerDisk("local:10/vm-10-disk-0.raw", 100));
  assert.ok(!isContainerDisk("local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst", 100));
});

test("storage listing keeps orphans of deleted containers (labelled 'images'), drops ISOs/templates/backups", () => {
  const vols = diskVolumes([
    { volid: "local:100/vm-100-disk-0.raw", content: "rootdir", vmid: 100 },
    { volid: "local:100/vm-100-disk-1.raw", content: "images", vmid: 100 }, // container 100 no longer exists
    { volid: "local:vztmpl/ubuntu.tar.zst", content: "vztmpl" },
    { volid: "local:backup/vzdump-lxc-100.tar.zst", content: "backup", vmid: 100 },
  ]);
  assert.deepEqual(vols.map((v) => v.volid), ["local:100/vm-100-disk-0.raw", "local:100/vm-100-disk-1.raw"]);
});

// ── Bug 1: never destroy a disk the running container still has mounted ──

test("bug 1: removing /data from a RUNNING container only queues it — nothing is destroyed, the disk stays mounted", async () => {
  const node = withData(true);
  const result = await detachDataDisk(node.client(), 100);
  assert.equal(result.status, "PENDING_RESTART");
  if (result.status === "PENDING_RESTART") assert.match(result.detail, /queued until the container restarts/);
  assert.ok(!node.calls.some((c) => c.startsWith("free")), "no storage delete");
  assert.deepEqual(node.remaining(), [ROOT, DATA], "disk still on storage");
  assert.ok(node.cts.get(100)!.mounted.has(DATA), "still mounted in the container");
  assert.equal(node.config(100)!.mp0.split(",")[0], DATA, "still in the running config");

  // Running it again doesn't change anything either.
  assert.equal((await detachDataDisk(node.client(), 100)).status, "PENDING_RESTART");
  assert.ok(!node.calls.some((c) => c.startsWith("free")));
});

test("bug 1: freeContainerDisks refuses a disk whose removal is only queued (still current)", async () => {
  const node = withData(true);
  await node.client().updateLXCConfig(100, { delete: "mp0" }); // queued
  const result = await freeContainerDisks(node.client(), 100, [DATA]);
  assert.deepEqual(result.kept, [{ volid: DATA, keys: ["mp0"] }]);
  assert.deepEqual([result.freed, result.leftover], [[], []]);
  assert.ok(!node.calls.some((c) => c.startsWith("free")));
  assert.deepEqual(node.remaining(), [ROOT, DATA]);
});

test("removing /data from a STOPPED container destroys its disk and verifies it in config and storage", async () => {
  const node = withData(false);
  const result = await detachDataDisk(node.client(), 100);
  assert.equal(result.status, "REMOVED");
  if (result.status === "REMOVED") assert.deepEqual([result.cleanup.freed, result.cleanup.leftover], [[DATA], []]);
  assert.deepEqual(node.remaining(), [ROOT]);
  assert.deepEqual(Object.keys(node.config(100)!), ["rootfs"], "no mp0, no unused0");
});

// ── Bug 2: "gone" disk back after restart ──

test("bug 2 replay: the old flow's destroyed disk name gets reused by the queued /data — the new flow never gets there", async () => {
  // What happened live: delete mp0 was queued, the old code read the *pending* config (no mp0),
  // destroyed the still-mounted file, then re-adding /data was queued as "local:10". At restart
  // Proxmox moved the old volid to unused0 and allocated the new /data under the free name
  // vm-100-disk-1 — so unused0 and mp0 named the same file, which "came back" in pvesm list.
  const old = withData(true);
  const c = old.client();
  await c.updateLXCConfig(100, { delete: "mp0" });
  await c.deleteStorageVolume("local", DATA); // the old, unsafe destroy
  await c.updateLXCConfig(100, { mp0: "local:10,mp=/data,backup=1" });
  old.restart(100);
  assert.equal(old.config(100)!.unused0, DATA);
  assert.equal(old.config(100)!.mp0.split(",")[0], DATA, "same name, brand-new disk");

  // That aliased unused0 must never be "cleaned": it would destroy the live /data.
  const cleanup = await freeContainerDisks(c, 100);
  assert.deepEqual(cleanup.kept.map((k) => k.volid).sort(), [ROOT, DATA]);
  assert.ok(!old.calls.includes("delete unused0"));
  assert.ok(old.remaining().includes(DATA));
});

test("bug 2: after the restart, the detached disk sits in unused0 — cleanup removes the entry AND the file, and checks both", async () => {
  const node = withData(true);
  await detachDataDisk(node.client(), 100); // queued
  node.restart(100); // admin restarts later → mp0 gone, unused0 = old disk
  assert.equal(node.config(100)!.unused0, DATA);

  const status = await detachDataDisk(node.client(), 100);
  assert.deepEqual(status, { status: "NO_DATA", unused: [`unused0: ${DATA}`] });

  const result = await freeContainerDisks(node.client(), 100);
  assert.deepEqual([result.freed, result.leftover], [[DATA], []]);
  assert.deepEqual(result.kept, [{ volid: ROOT, keys: ["rootfs"] }]);
  assert.deepEqual(node.remaining(), [ROOT]);
  assert.ok(!("unused0" in node.config(100)!));
});

test("bug 2: an unusedN entry that can't be removed is a leftover even if the listing can't see the file", async () => {
  const node = new FakeNode({ local: [ROOT] }).ct(100, false, { rootfs: `${ROOT},size=20G`, unused0: DATA });
  node.failUnusedDelete = true;
  const result = await freeContainerDisks(node.client(), 100);
  assert.deepEqual(result.leftover, [DATA], "config still points at it");
  assert.match(result.errors[0], /unable to remove unused volume/);
});

test("a delete that reports success but leaves the file is caught by the storage cross-check", async () => {
  const node = new FakeNode({ local: [DATA] });
  node.silentDeleteFail.add(DATA);
  const result = await destroyContainerAndDisks(node.client(), 100);
  assert.deepEqual([result.freed, result.leftover], [[], [DATA]]);
});

test("a failing delete is reported with its error and as leftover", async () => {
  const node = new FakeNode({ local: [DATA] });
  node.throwOnDelete.add(DATA);
  const result = await freeContainerDisks(node.client(), 100);
  assert.deepEqual(result.leftover, [DATA]);
  assert.match(result.errors[0], /volume is busy/);
});

// ── Kept from the live test ──

test("deleting a container with a live /data disk and an unused0 disk leaves nothing on storage", async () => {
  const OLD = "local:100/vm-100-disk-2.raw";
  const node = new FakeNode({ local: [ROOT, DATA, OLD, "local:101/vm-101-disk-0.raw"], "sowsi-vol-7": ["sowsi-vol-7:100/vm-100-disk-3.raw"] }).ct(100, true, {
    rootfs: `${ROOT},size=20G`,
    mp0: `${DATA},mp=/data,backup=1,size=10G`,
    unused0: OLD,
  });
  const result = await destroyContainerAndDisks(node.client(), 100);
  assert.deepEqual([result.leftover, result.kept], [[], []]);
  assert.deepEqual(node.remaining(), ["local:101/vm-101-disk-0.raw"], "other containers untouched");
  assert.equal(node.calls[0], "destroy ct 100");
});

test("container deletion still catches orphans Proxmox left behind, on every storage", async () => {
  const node = new FakeNode({ local: [ROOT], "sowsi-vol-7": ["sowsi-vol-7:100/vm-100-disk-2.raw"] });
  // Container already gone (e.g. deleted by an earlier, interrupted run): only orphans remain.
  const result = await destroyContainerAndDisks(node.client(), 100);
  assert.deepEqual(result.freed.sort(), [ROOT, "sowsi-vol-7:100/vm-100-disk-2.raw"]);
  assert.deepEqual([result.leftover, node.remaining()], [[], []]);
});
