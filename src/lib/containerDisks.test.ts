import { test } from "node:test";
import assert from "node:assert/strict";
import { destroyContainerAndDisks, freeContainerDisks, isContainerDisk, type ContainerCleanupClient } from "./containerDisks";

/**
 * Fake node: storages with disk files. `deleteLXC` removes only the disks the
 * container config still references (like Proxmox does), so detached disks
 * stay behind as orphans.
 */
function fakeNode(files: Record<string, string[]>, opts: { referenced?: string[]; silentDeleteFail?: string[]; throwOn?: string[] } = {}) {
  const storage = new Map(Object.entries(files).map(([k, v]) => [k, new Set(v)]));
  const calls: string[] = [];
  const vmidOf = (volid: string) => Number(volid.match(/-(\d+)-disk-/)?.[1] ?? NaN);
  const client: ContainerCleanupClient = {
    listContainerStorages: async () => [...storage.keys()],
    listStorageVolumes: async (s) => [...(storage.get(s) ?? [])].map((volid) => ({ volid, vmid: vmidOf(volid), size: 10 * 1024 ** 3, used: null })),
    deleteStorageVolume: async (s, volid) => {
      calls.push(`free ${volid}`);
      if (opts.throwOn?.includes(volid)) throw new Error("volume is busy");
      if (opts.silentDeleteFail?.includes(volid)) return; // API says OK, file stays
      storage.get(s)?.delete(volid);
    },
    deleteLXC: async (vmid) => {
      calls.push(`destroy ct ${vmid}`);
      for (const set of storage.values()) for (const v of [...set]) if (opts.referenced?.includes(v)) set.delete(v);
    },
  };
  const remaining = () => [...storage.values()].flatMap((s) => [...s]).sort();
  return { client, calls, remaining };
}

test("isContainerDisk matches only this vmid's images", () => {
  assert.ok(isContainerDisk("local:100/vm-100-disk-1.raw", 100));
  assert.ok(isContainerDisk("sowsi-vol-7:100/vm-100-disk-0.raw", 100));
  assert.ok(isContainerDisk("local-zfs:subvol-100-disk-0", 100));
  assert.ok(!isContainerDisk("local:1000/vm-1000-disk-0.raw", 100));
  assert.ok(!isContainerDisk("local:10/vm-10-disk-0.raw", 100));
  assert.ok(!isContainerDisk("local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst", 100));
});

test("live bug: /data detached from a running container leaves no config entry — the disk is still destroyed and verified gone", async () => {
  // After `delete mp0` the config has no mp0 and no unusedN, but the file is still on storage.
  const node = fakeNode({ local: ["local:100/vm-100-disk-0.raw", "local:100/vm-100-disk-1.raw"] });
  const result = await freeContainerDisks(node.client, 100, ["local:100/vm-100-disk-1.raw"]);
  assert.deepEqual(result, { freed: ["local:100/vm-100-disk-1.raw"], leftover: [], errors: [] });
  assert.deepEqual(node.remaining(), ["local:100/vm-100-disk-0.raw"], "root disk untouched");
});

test("deleting a container also removes orphaned disks on every storage and leaves no vm-<vmid>-* file", async () => {
  const node = fakeNode(
    {
      local: ["local:100/vm-100-disk-0.raw", "local:100/vm-100-disk-1.raw", "local:101/vm-101-disk-0.raw"],
      "sowsi-vol-7": ["sowsi-vol-7:100/vm-100-disk-2.raw"],
    },
    { referenced: ["local:100/vm-100-disk-0.raw"] } // only rootfs is still in the config
  );
  const result = await destroyContainerAndDisks(node.client, 100);
  assert.deepEqual(result.leftover, []);
  assert.deepEqual(result.freed.sort(), ["local:100/vm-100-disk-1.raw", "sowsi-vol-7:100/vm-100-disk-2.raw"]);
  assert.deepEqual(node.remaining(), ["local:101/vm-101-disk-0.raw"], "other containers' disks untouched");
  assert.equal(node.calls[0], "destroy ct 100");
});

test("a delete that reports success but leaves the file is caught as leftover", async () => {
  const node = fakeNode({ local: ["local:100/vm-100-disk-1.raw"] }, { silentDeleteFail: ["local:100/vm-100-disk-1.raw"] });
  const result = await destroyContainerAndDisks(node.client, 100);
  assert.deepEqual(result.leftover, ["local:100/vm-100-disk-1.raw"]);
  assert.deepEqual(result.freed, [], "not counted as freed");
});

test("a failing delete is reported with its error and as leftover", async () => {
  const node = fakeNode({ local: ["local:100/vm-100-disk-1.raw"] }, { throwOn: ["local:100/vm-100-disk-1.raw"] });
  const result = await freeContainerDisks(node.client, 100);
  assert.deepEqual(result.leftover, ["local:100/vm-100-disk-1.raw"]);
  assert.match(result.errors[0], /volume is busy/);
});

test("cleanup still runs when the container itself is already gone", async () => {
  const node = fakeNode({ local: ["local:100/vm-100-disk-1.raw"] });
  const result = await destroyContainerAndDisks(node.client, 100); // fake deleteLXC is a no-op for unreferenced disks
  assert.deepEqual(result, { freed: ["local:100/vm-100-disk-1.raw"], leftover: [], errors: [] });
});
