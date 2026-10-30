import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as S from "./nodeScripts";

const bridge = { nic: "eth0", mac: "96:00:03:aa:bb:cc", ipv4: "203.0.113.20", ipv6Subnet: "2a01:4f8:1c1c:abcd" };

test("every generated script is valid bash", () => {
  const scripts: Record<string, string> = {
    hostname: S.hostnameScript("sowsi-proxmox-02", bridge.ipv4),
    bridgeFacts: S.bridgeFactsScript(),
    stage: S.stageBridgeScript(),
    install: S.installBridgeScript("abc"),
    preReboot: S.preRebootFactsScript(),
    pveInstall: S.pveInstallScript(),
    startPve: S.startPveInstallScript(),
    pveStatus: S.pveInstallStatusScript(),
    afterReboot: S.afterRebootFactsScript(),
    firewall: S.firewallScript("2.31.11.105"),
    outbound: S.outboundScript(),
    token: S.apiTokenScript(),
    addKey: S.addProvisioningKeyScript("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL+L152cRvIkX3R0xtdG4toSwTbblpUz6PioDz89wglD sowsi-provisioning"),
    removeKey: S.removeInstallKeyScript("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallKeyBodyInstallKeyBodyInstallKeyBo sowsi-install", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdminKeyBodyAdminKeyBodyAdminKeyBodyAdmin me"),
    container: S.containerOutboundScript(true),
    hostSetup: readFileSync("scripts/proxmox-host-setup.sh", "utf8"),
  };
  const bash = spawnSync("bash", ["--version"]);
  if (bash.error) return; // no bash on this machine
  for (const [name, script] of Object.entries(scripts)) {
    const r = spawnSync("bash", ["-n"], { input: script.replace(/\r\n/g, "\n"), encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test("vmbr0: the server's /32, point-to-point to 172.31.1.1, bridged to the NIC with its MAC, plus the /64", () => {
  const f = S.interfacesFile(bridge);
  for (const line of ["iface eth0 inet manual", "auto vmbr0", "address 203.0.113.20/32", "gateway 172.31.1.1", "pointopoint 172.31.1.1", "bridge-ports eth0", "hwaddress 96:00:03:aa:bb:cc", "address 2a01:4f8:1c1c:abcd::1/64", "gateway fe80::1"]) {
    assert.ok(f.includes(line), line);
  }
  const config = f.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.doesNotMatch(config, /source|dhcp|vmbr1/, "nothing else is pulled in; vmbr1 comes from the host setup");
});

const good = (sha: string) => ({
  nic: "eth0", mac: bridge.mac, ipv4: bridge.ipv4, gateway: "172.31.1.1", staged_sha: sha, installed_sha: sha, cloudinit_net_disabled: "yes",
  interfaces_d: "", sources_interfaces_d: "no", ifupdown2: "yes", nameservers: "2", syntax: "ok", pve_kernel: "yes", grub_pve: "yes", debian_kernels: "none",
});

test("the bridge check catches everything that would leave the server unreachable after the reboot", () => {
  const sha = S.sha256(S.interfacesFile(bridge));
  const expected = { ipv4: bridge.ipv4, nic: "eth0", mac: bridge.mac, sha };
  assert.deepEqual(S.checkBridge(good(sha), expected, "pre-reboot"), []);
  const cases: [Partial<ReturnType<typeof good>>, RegExp][] = [
    [{ ipv4: "203.0.113.99" }, /live IPv4/],
    [{ gateway: "10.0.0.1" }, /default gateway/],
    [{ nic: "enp1s0" }, /uplink NIC/],
    [{ mac: "aa:aa:aa:aa:aa:aa" }, /MAC/],
    [{ cloudinit_net_disabled: "no" }, /cloud-init/],
    [{ interfaces_d: "50-cloud-init " }, /DHCP config/],
    [{ installed_sha: "0000" }, /isn't exactly the generated config/],
    [{ nameservers: "0" }, /nameserver/],
    [{ ifupdown2: "no" }, /ifupdown2 isn't installed/],
    [{ syntax: "error: line 3" }, /rejects/],
    [{ pve_kernel: "no" }, /no Proxmox kernel/],
    [{ grub_pve: "no" }, /GRUB/],
    [{ debian_kernels: "linux-image-6.1.0-26-cloud-amd64" }, /Debian kernels still installed/],
  ];
  for (const [bad, why] of cases) assert.match(S.checkBridge({ ...good(sha), ...bad }, expected, "pre-reboot").join(), why, String(why));
  // Before Proxmox is installed, ifupdown2 and the kernel aren't expected yet.
  assert.deepEqual(S.checkBridge({ ...good(sha), ifupdown2: "no", pve_kernel: "no", syntax: "" }, expected, "installed"), []);
});

test("after the reboot: Proxmox kernel, pve-manager, vmbr0 with both addresses, default route on vmbr0", () => {
  const ok = { kernel: "6.8.12-4-pve", pveversion: "pve-manager/8.3.0/1234", vmbr0_ipv4: "203.0.113.20/32", gateway: "172.31.1.1 vmbr0", ipv6: "2a01:4f8:1c1c:abcd::1/64", pve_services: "active active active" };
  assert.deepEqual(S.checkAfterReboot(ok, { ipv4: bridge.ipv4, ipv6Subnet: bridge.ipv6Subnet }), []);
  assert.match(S.checkAfterReboot({ ...ok, kernel: "6.1.0-26-cloud-amd64" }, bridge).join(), /isn't a Proxmox kernel/);
  assert.match(S.checkAfterReboot({ ...ok, gateway: "172.31.1.1 eth0" }, bridge).join(), /on vmbr0/);
});

test("IPv6 /64 from Hetzner", () => {
  assert.equal(S.subnetOf("2a01:4f8:1c1c:abcd::/64"), "2a01:4f8:1c1c:abcd");
  assert.equal(S.subnetOf("2A01:4F8:C17:6D2B::/64"), "2a01:4f8:c17:6d2b");
  assert.throws(() => S.subnetOf("2a01:4f8:1c1c:abcd::/56"), /not a \/64/);
  assert.throws(() => S.subnetOf("garbage"), /unexpected/);
});

test("the token secret comes from pveum's JSON and must be root@pam!sowsi without privilege separation", () => {
  const out = JSON.stringify({ "full-tokenid": "root@pam!sowsi", info: { privsep: "0" }, value: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
  assert.equal(S.parseTokenSecret(out), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  assert.throws(() => S.parseTokenSecret(out.replace('"0"', '"1"')), /privilege separation/);
  assert.throws(() => S.parseTokenSecret(out.replace("root@pam!sowsi", "root@pam!other")), /expected root@pam!sowsi/);
  assert.throws(() => S.parseTokenSecret("Permission denied"), /JSON/);
});

const UFW = `ufw<<
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), allow (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80/tcp                     ALLOW IN    Anywhere
443/tcp                    ALLOW IN    Anywhere
8006/tcp                   ALLOW IN    2.31.11.105                # Proxmox API: sowsi-mgmt-01 only
Anywhere                   ALLOW FWD   Anywhere on vmbr1
Anywhere on vmbr1          ALLOW FWD   Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
>>ufw
sshd_password=no
sshd_root=without-password
sshd_kbd=no
fail2ban=active`;

test("firewall: deny in, 22/80/443, 8006 only from sowsi-mgmt-01, routed vmbr1, key-only SSH, fail2ban", () => {
  assert.deepEqual(S.checkFirewall(UFW, "2.31.11.105"), []);
  assert.match(S.checkFirewall(UFW.replace("8006/tcp                   ALLOW IN    2.31.11.105", "8006/tcp                   ALLOW IN    Anywhere"), "2.31.11.105").join(), /open to everyone/);
  assert.match(S.checkFirewall(UFW.replace("deny (incoming)", "allow (incoming)"), "2.31.11.105").join(), /defaults/);
  assert.match(S.checkFirewall(UFW.replace("sshd_password=no", "sshd_password=yes"), "2.31.11.105").join(), /PasswordAuthentication/);
  assert.match(S.checkFirewall(UFW.replace("Status: active", "Status: inactive"), "2.31.11.105").join(), /not active/);
  assert.match(S.checkFirewall(UFW, "2.31.11.106").join(), /8006 isn't limited to 2\.31\.11\.106/);
});

test("lockdown never removes the install key unless the admin key is there", () => {
  const script = S.removeInstallKeyScript("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallKeyBodyInstallKeyBodyInstallKeyBo i", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdminKeyBodyAdminKeyBodyAdminKeyBodyAdmin a");
  assert.ok(script.indexOf('grep -qF "$ADMIN"') < script.indexOf('grep -vF "$INSTALL"'));
  assert.throws(() => S.removeInstallKeyScript("not a key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdminKeyBodyAdminKeyBodyAdminKeyBodyAdmin a"), /OpenSSH/);
  assert.match(S.addProvisioningKeyScript("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL+L152cRvIkX3R0xtdG4toSwTbblpUz6PioDz89wglD p"), /restrict,command="\/usr\/local\/sbin\/sowsi-host"/);
});

test("the Proxmox install is pinned to the published key hash and removes every Debian kernel", () => {
  const s = S.pveInstallScript();
  assert.match(s, /sha512sum -c -/);
  assert.match(s, /install proxmox-ve postfix open-iscsi/);
  assert.match(s, /ls \/boot\/vmlinuz-\*-pve/);
  assert.ok(s.indexOf("vmlinuz-*-pve") < s.indexOf("$APT remove $debian"), "a Proxmox kernel is checked before Debian's is removed");
  assert.match(s, /update-grub/);
  assert.doesNotMatch(s, /reboot/, "the reboot happens only after the pre-reboot check");
});
