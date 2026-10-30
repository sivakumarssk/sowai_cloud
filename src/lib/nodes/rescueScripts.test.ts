import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRepair, diagnose, diagnosticsScript, LINK_FILE, linkFile, minimalInterfacesFile, mountRootScript, repairScript, rootCandidates } from "./rescueScripts";
import { parseFacts, sha256 } from "./nodeScripts";

const plan = { nic: "enp1s0", mac: "92:00:0a:57:96:63", ipv4: "2.28.75.244", stamp: "2026-10-30T10-00-00-000Z" };
const lsblk = (children: Record<string, unknown>[], name = "sda") => JSON.stringify({ blockdevices: [{ name, path: `/dev/${name}`, size: 85899345920, type: "disk", children }, { name: "sr0", path: "/dev/sr0", size: 1024, type: "rom" }] });
const part = (path: string, size: number, over: Record<string, unknown> = {}) => ({ name: path.slice(5), path, size, fstype: "ext4", type: "part", label: null, mountpoint: null, ...over });
const GB = 1024 ** 3;

test("the root partition is found by label and size, whatever the disk is called", () => {
  for (const disk of ["sda", "vda", "nvme0n1"]) {
    const list = lsblk([part(`/dev/${disk}15`, 0.25 * GB, { fstype: "vfat", label: "EFI" }), part(`/dev/${disk}14`, 0.001 * GB, { fstype: null }), part(`/dev/${disk}1`, 80 * GB)], disk);
    assert.deepEqual(rootCandidates(list), [`/dev/${disk}1`]);
  }
  const labelled = lsblk([part("/dev/sda2", 70 * GB), part("/dev/sda1", 40 * GB, { label: "cloudimg-rootfs" })]);
  assert.deepEqual(rootCandidates(labelled), ["/dev/sda1", "/dev/sda2"], "a root label beats size");
  assert.deepEqual(rootCandidates(lsblk([part("/dev/sda1", 80 * GB, { mountpoint: "/" })])), [], "never one already mounted");
  assert.deepEqual(rootCandidates(lsblk([part("/dev/sda1", 2 * GB)])), [], "too small to be root");
  assert.deepEqual(rootCandidates(JSON.stringify({ blockdevices: [{ path: "/dev/sda", type: "disk", size: 85899345920, fstype: "ext4" }] })), [], "only partitions");
});

test("the disk is mounted read-only and kept only if it's really this system's root", () => {
  const s = mountRootScript("/dev/sda1");
  assert.match(s, /mount -o ro '\/dev\/sda1'/);
  assert.match(s, /etc\/debian_version/);
  assert.doesNotMatch(s, /rw/);
  assert.throws(() => mountRootScript("/dev/sda1; rm -rf /"), /unexpected device/);
});

const report = (over: Record<string, string> = {}) =>
  Object.entries({ sowsi_bridge_ports: "eth0", sowsi_mac: plan.mac, sowsi_rescue_dev: "eth0", sowsi_name_udev: "enp1s0", sowsi_name_journal: "enp1s0", sowsi_port_errors: "2", ...over })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

test("the cause and how sure, from the output only", () => {
  const sure = diagnose(report());
  assert.equal(sure.confidence, "high");
  assert.match(sure.cause, /bridged to eth0, but on the Proxmox kernel the card is named enp1s0/);
  assert.deepEqual(sure.repair, { nic: "enp1s0", mac: plan.mac });

  const onlyUdev = diagnose(report({ sowsi_name_journal: "", sowsi_port_errors: "0" }));
  assert.equal(onlyUdev.confidence, "medium");
  assert.deepEqual(onlyUdev.repair, { nic: "enp1s0", mac: plan.mac });

  assert.equal(diagnose(report({ sowsi_name_journal: "ens3" })).repair!.nic, "ens3", "what the kernel really did wins");
});

test("no repair without evidence it would help", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ sowsi_bridge_ports: "enp1s0" }, /already names the real card/],
    [{ sowsi_name_udev: "", sowsi_name_journal: "" }, /Can't tell/],
    [{ sowsi_rescue_dev: "" }, /Can't tell/],
    [{ sowsi_mac: "" }, /Can't tell/],
    [{ sowsi_bridge_ports: "" }, /Can't tell/],
  ];
  for (const [over, why] of cases) {
    const d = diagnose(report(over));
    assert.equal(d.repair, null, JSON.stringify(over));
    assert.equal(d.confidence, "low");
    assert.match(d.cause, why);
  }
});

test("the repaired config is node 1's shape: IPv4 /32, gateway, pointopoint, the real port, no IPv6", () => {
  const f = minimalInterfacesFile(plan);
  for (const line of ["iface enp1s0 inet manual", "auto vmbr0", "address 2.28.75.244/32", "gateway 172.31.1.1", "pointopoint 172.31.1.1", "bridge-ports enp1s0"]) assert.ok(f.includes(line), line);
  assert.doesNotMatch(f.split("\n").filter((l) => !l.startsWith("#")).join("\n"), /inet6|source|dhcp|vmbr1/);
  assert.equal(linkFile(plan), `# Written by Sowsi install-node: keeps this card's name whatever the kernel would call it.\n[Match]\nMACAddress=${plan.mac}\n\n[Link]\nName=enp1s0\n`);
});

test("the repair backs up first, pins the name, rebuilds the initramfs, and touches nothing else", () => {
  const s = repairScript(plan);
  const at = (t: string) => s.indexOf(t);
  assert.ok(at('cp -a "$R/etc/network/interfaces" "$R/etc/network/interfaces.$SUFFIX"') < at('cat > "$R/etc/network/interfaces"'), "backup first");
  assert.ok(at("mount -o remount,rw") < at("cp -a"), "writable only for this");
  assert.ok(at(`cat > "$R${LINK_FILE}"`) < at("update-initramfs -u -k all"), "the pin goes into the initramfs");
  assert.match(s, /lsinitramfs/);
  const written = [...s.matchAll(/(?:cat|cp -a \S+) > ?"?\$R([^"\s]+)/g)].map((m) => m[1]);
  assert.deepEqual(written, ["/etc/network/interfaces", LINK_FILE]);
  assert.doesNotMatch(s, /update-grub|grub-install|rm -/);

  assert.throws(() => repairScript({ ...plan, nic: "enp1s0; reboot" }), /card name/);
  assert.throws(() => repairScript({ ...plan, mac: "nope" }), /MAC/);
  if (spawnSync("bash", ["--version"]).error) return;
  for (const script of [repairScript(plan), diagnosticsScript(), mountRootScript("/dev/sda1")]) {
    const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

test("what the repair reports is checked against what it was meant to write", () => {
  const good = `sowsi_backup=/etc/network/interfaces.x\nsowsi_interfaces_sha=${sha256(minimalInterfacesFile(plan))}\nsowsi_link_sha=${sha256(linkFile(plan))}\nsowsi_initrd_pin=yes`;
  assert.deepEqual(checkRepair(good, plan), []);
  assert.match(checkRepair(good.replace("pin=yes", "pin=no"), plan).join(), /isn't in every initramfs/);
  assert.match(checkRepair(good.replace("sowsi_interfaces_sha=", "sowsi_interfaces_sha=0"), plan).join(), /isn't exactly the repaired config/);
  assert.match(checkRepair(good.replace("sowsi_backup=", "x="), plan).join(), /no backup/);
});

test("the diagnostics script finds the card by MAC and reads the real name, on a disk laid out like the real one", (t) => {
  if (spawnSync("bash", ["--version"]).error) return t.skip("no bash");
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-diag-"));
  const put = (file: string, text = "") => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  try {
    put("root/etc/network/interfaces", "auto vmbr0\niface vmbr0 inet static\n    bridge-ports eth0\n    hwaddress 92:00:0A:57:96:63\n");
    put("root/etc/ufw/ufw.conf", "ENABLED=yes\nLOGLEVEL=low\n");
    put("root/var/log/journal/x/system.journal");
    put("root/var/lib/vz/images/.keep");
    put("sys/class/net/lo/address", "00:00:00:00:00:00\n");
    put("sys/class/net/eth0/address", "92:00:0a:57:96:63\n");
    put("sys/class/net/eth0/device/x");
    const script = diagnosticsScript().replaceAll("/mnt/sowsi-root", "./root").replaceAll("/sys/class/net", "./sys/class/net");
    const stubs = `journalctl() {
  case "$*" in
    *--list-boots*) echo ' 0 abc Fri 2026-10-30 Fri 2026-10-30' ;;
    *) printf '%s\\n' 'kernel: virtio_net virtio1 enp1s0: renamed from eth0' 'systemd[1]: Failed to start networking.service' 'ifupdown2: vmbr0: bridge port eth0 does not exist' 'kernel: eth0: renamed from veth1a2b' ;;
  esac
}
lsblk() { echo disks; }
udevadm() { echo 'ID_NET_NAME_PATH=enp1s0'; }
ip() { echo 'eth0 UP'; }`;
    const r = spawnSync("bash", ["-s"], { input: `${stubs}\n${script}`, encoding: "utf8", cwd: dir });
    const f = parseFacts(r.stdout);
    assert.equal(f.sowsi_bridge_ports, "eth0");
    assert.equal(f.sowsi_mac, "92:00:0a:57:96:63", "lower-cased to match /sys");
    assert.equal(f.sowsi_rescue_dev, "eth0");
    assert.equal(f.sowsi_name_journal, "enp1s0", "a container's veth rename isn't the card");
    assert.equal(f.sowsi_name_udev, "enp1s0");
    assert.equal(f.sowsi_port_errors, "1");
    assert.equal(f.sowsi_journal, "yes");
    assert.equal(f.sowsi_images, "");
    for (const section of ["lsblk -f", "/etc/network/interfaces", "systemd network files", "udev rules", "cloud-init network config", "cards on the rescue system", "journalctl --list-boots", "failed boot", "ufw log setting"]) {
      assert.ok(r.stdout.includes(`=== ${section}`), section);
    }
    assert.match(r.stdout, /LOGLEVEL=low/);
    assert.match(r.stdout, /Failed to start networking/);
    assert.equal(diagnose(r.stdout).confidence, "high");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
