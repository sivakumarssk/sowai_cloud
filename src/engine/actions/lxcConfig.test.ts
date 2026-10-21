import { test } from "node:test";
import assert from "node:assert/strict";
import { readContainerDisks, sizeToGB } from "./lxcConfig";

test("sizeToGB handles Proxmox size units", () => {
  assert.equal(sizeToGB("20G"), 20);
  assert.equal(sizeToGB("512M"), 0.5);
  assert.equal(sizeToGB("1T"), 1024);
  assert.equal(sizeToGB("40"), 40);
  assert.equal(sizeToGB(undefined), 0);
});

test("reads root disk, the /data mount and the next free mount key", () => {
  const disks = readContainerDisks({
    memory: 2048,
    rootfs: "local:100/vm-100-disk-0.raw,size=20G",
    mp0: "local:100/vm-100-disk-1.raw,mp=/srv/app,size=5G",
    mp1: "hcloud-vol-1:100/vm-100-disk-2.raw,mp=/data,backup=1,size=30G",
  });
  assert.deepEqual(disks.root, { key: "rootfs", storage: "local", volume: "local:100/vm-100-disk-0.raw", sizeGB: 20, mountPath: "/" });
  assert.equal(disks.data?.key, "mp1");
  assert.equal(disks.data?.storage, "hcloud-vol-1");
  assert.equal(disks.data?.sizeGB, 30);
  assert.equal(disks.freeMountKey, "mp2");
});

test("no /data mount yet → mp0 is free", () => {
  const disks = readContainerDisks({ rootfs: "local:101/vm-101-disk-0.raw,size=40G" });
  assert.equal(disks.data, null);
  assert.equal(disks.freeMountKey, "mp0");
});
