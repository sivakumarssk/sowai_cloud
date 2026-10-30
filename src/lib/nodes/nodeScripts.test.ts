import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as S from "./nodeScripts";
import { freshFirewall, runFirewallScript, type FakeFirewall } from "@/lib/testing/fakeUfw";

const bridge = { nic: "eth0", ipv4: "203.0.113.20", mac: "96:00:03:aa:bb:cc", ipv6Subnet: "2a01:4f8:1c1c:abcd" };

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
    pin: S.pinNicScript(bridge),
    guard: S.guardScript(),
    installGuard: S.installGuardScript({ mac: bridge.mac, ipv4: bridge.ipv4, mgmtIp: "2.31.11.105" }),
    journald: S.journaldScript(),
    bootSafety: S.bootSafetyFactsScript("eth0"),
    badNic: S.simulateBadNicScript("eth0"),
    ipv6: S.ipv6Script(bridge.ipv6Subnet),
    hostSetup: readFileSync("scripts/proxmox-host-setup.sh", "utf8"),
  };
  const bash = spawnSync("bash", ["--version"]);
  if (bash.error) return; // no bash on this machine
  for (const [name, script] of Object.entries(scripts)) {
    const r = spawnSync("bash", ["-n"], { input: script.replace(/\r\n/g, "\n"), encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
});

test("the first boot is minimal: IPv4 /32, point-to-point to 172.31.1.1, bridged to the card, no IPv6", () => {
  const f = S.interfacesFile(bridge);
  for (const line of ["iface eth0 inet manual", "auto vmbr0", "address 203.0.113.20/32", "gateway 172.31.1.1", "pointopoint 172.31.1.1", "bridge-ports eth0"]) {
    assert.ok(f.includes(line), line);
  }
  const config = f.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.doesNotMatch(config, /source|dhcp|vmbr1|inet6|hwaddress/, "nothing else is pulled in; vmbr1 comes from the host setup");
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
  const ok = { kernel: "6.8.12-4-pve", pveversion: "pve-manager/8.3.0/1234", vmbr0_ipv4: "203.0.113.20", gateway: "172.31.1.1 vmbr0", ipv6: "2a01:4f8:1c1c:abcd::1/64", pve_services: "active active active" };
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

// The real formats, from the tools' own sources and the live server.
const UFW = `ufw<<
Status: active
Logging: off
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
Anywhere (v6)              ALLOW FWD   Anywhere (v6) on vmbr1
>>ufw
sshd_password=no
sshd_root=without-password
sshd_kbd=no
fail2ban=active
ip_forward=1`;

test("firewall: deny in, 22/80/443, 8006 only from sowsi-mgmt-01, routed vmbr1, key-only SSH, fail2ban", () => {
  assert.deepEqual(S.checkFirewall(UFW, "2.31.11.105"), []);
  assert.match(S.checkFirewall(UFW.replace("8006/tcp                   ALLOW IN    2.31.11.105", "8006/tcp                   ALLOW IN    Anywhere"), "2.31.11.105").join(), /open to everyone/);
  assert.match(S.checkFirewall(UFW.replace("deny (incoming)", "allow (incoming)"), "2.31.11.105").join(), /default incoming is "allow"/);
  assert.match(S.checkFirewall(UFW.replace("allow (routed)", "disabled (routed)"), "2.31.11.105").join(), /"disabled \(routed\)": the kernel isn't forwarding/);
  assert.match(S.checkFirewall(UFW.replace("allow (routed)", "deny (routed)"), "2.31.11.105").join(), /default routed is "deny"/);
  assert.match(S.checkFirewall(UFW.replace("ip_forward=1", "ip_forward=0"), "2.31.11.105").join(), /ip_forward is 0/);
  assert.match(S.checkFirewall(UFW.replace("sshd_password=no", "sshd_password=yes"), "2.31.11.105").join(), /passwordauthentication is yes, expected no/);
  assert.match(S.checkFirewall(UFW.replace("sshd_password=no\n", ""), "2.31.11.105").join(), /passwordauthentication is unknown/);
  assert.match(S.checkFirewall(UFW.replace("sshd_root=without-password", "sshd_root=yes"), "2.31.11.105").join(), /permitrootlogin is yes, expected prohibit-password/);
  assert.deepEqual(S.checkFirewall(UFW.replace("sshd_root=without-password", "sshd_root=prohibit-password"), "2.31.11.105"), [], "either spelling");
  assert.match(S.checkFirewall(UFW.replace("Status: active", "Status: inactive"), "2.31.11.105").join(), /not active/);
  assert.match(S.checkFirewall(UFW.replace("Logging: off", "Logging: on (low)"), "2.31.11.105").join(), /logging is still on/);
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

// ── Step 3f, against a host that behaves like the real tools ─────────

const MGMT = "2.31.11.105";
const script = S.firewallScript(MGMT);
const withoutLine = (needle: string) => script.split("\n").filter((l) => !l.includes(needle)).join("\n");

test("3f from a fresh server: deny in, allow out, allow routed, and it passes its own check", () => {
  const fw = freshFirewall();
  const out = runFirewallScript(fw, script);
  assert.match(out, /Default: deny \(incoming\), allow \(outgoing\), allow \(routed\)/);
  assert.deepEqual(S.checkFirewall(out, MGMT), []);
});

test("3f sets the defaults and turns forwarding on before it enables ufw", () => {
  const fw = freshFirewall();
  runFirewallScript(fw, script);
  assert.deepEqual(fw.atEnable, { policy: { incoming: "deny", outgoing: "allow", routed: "allow" }, ipForward: 1, rules: 6 });
  const at = (needle: string) => script.indexOf(needle);
  for (const line of ["ufw default deny incoming", "ufw default allow outgoing", "ufw default allow routed", "sysctl -q -w net.ipv4.ip_forward=1"]) {
    assert.ok(at(line) >= 0 && at(line) < at("ufw --force enable"), line);
  }
});

test("the script that stopped on the real server: policy set, no forwarding, disabled (routed) — and the check catches it", () => {
  const out = runFirewallScript(freshFirewall(), withoutLine("sysctl -q -w net.ipv4.ip_forward=1"));
  assert.match(out, /allow \(outgoing\), disabled \(routed\)/);
  assert.match(S.checkFirewall(out, MGMT).join(), /"disabled \(routed\)"/);
});

test("without ufw default allow routed: disabled (routed) with forwarding off, deny (routed) with it on — caught both ways", () => {
  const off = runFirewallScript(freshFirewall(), withoutLine("ufw default allow routed").replace(/.*ip_forward=1.*\n/g, ""));
  assert.match(off, /disabled \(routed\)/);
  assert.ok(S.checkFirewall(off, MGMT).length > 0);
  const on = runFirewallScript(freshFirewall(), withoutLine("ufw default allow routed"));
  assert.match(on, /deny \(routed\)/);
  assert.match(S.checkFirewall(on, MGMT).join(), /default routed is "deny"/);
});

test("3f on the half-configured real server, and twice in a row: same clean result, no duplicate rules", () => {
  const halfDone: FakeFirewall = {
    ...freshFirewall(),
    active: true,
    policy: { incoming: "deny", outgoing: "allow", routed: "allow" },
    rules: ["22/tcp                     ALLOW IN    Anywhere", "8006/tcp                   ALLOW IN    2.31.11.105", "1234/tcp                   ALLOW IN    Anywhere"],
  };
  const first = runFirewallScript(halfDone, script);
  assert.deepEqual(S.checkFirewall(first, MGMT), []);
  assert.doesNotMatch(first, /1234/, "a stray rule from before doesn't survive");
  const second = runFirewallScript(halfDone, script);
  assert.equal(second, first);
  assert.equal(new Set(halfDone.rules).size, halfDone.rules.length);
});

test("SSH: PasswordAuthentication no is set explicitly, and the effective value is what's checked", () => {
  const out = runFirewallScript(freshFirewall(), script);
  assert.match(out, /sshd_password=no/);
  assert.match(out, /sshd_root=without-password/, "how sshd -T prints prohibit-password");
  const noDropIn = runFirewallScript(freshFirewall(), script.replace(/cat > \/etc\/ssh\/sshd_config\.d\/00-sowsi\.conf <<'EOF'[\s\S]*?\nEOF\n/, ""));
  assert.match(S.checkFirewall(noDropIn, MGMT).join(), /passwordauthentication is yes/, "Debian's default fails the check");
  assert.match(script, /sshd -T \| awk|sshd -T/);
  assert.doesNotMatch(S.firewallStatusScript(), /grep[^\n]*sshd_config/, "never read from the config file");
});

// ── The scripts' own parsing, on real tool output ────────────────────

/** Runs a script under bash with the tools stubbed to print their real output. Null if there's no bash. */
function factsFrom(script: string, stubs: string): Record<string, string> | null {
  if (spawnSync("bash", ["--version"]).error) return null;
  const r = spawnSync("bash", ["-s"], { input: `${stubs}\n${script}`, encoding: "utf8" });
  return S.parseFacts(r.stdout);
}

test("3e parses the real output of ip, pveversion, uname and systemctl", () => {
  const facts = factsFrom(
    S.afterRebootFactsScript(),
    `uname() { echo 6.8.12-9-pve; }
pveversion() { echo "pve-manager/8.4.1/2a5fa54a8503f96d (running kernel: 6.8.12-9-pve)"; }
cat() { echo 3f2c-boot; }
systemctl() { printf 'active\\nactive\\nactive\\n'; }
ip() {
  case "$*" in
    "-o -4 addr show dev vmbr0") echo '2: vmbr0    inet 203.0.113.20 peer 172.31.1.1/32 scope global vmbr0\\       valid_lft forever preferred_lft forever' ;;
    "-o -4 route show to default") echo 'default via 172.31.1.1 dev vmbr0 proto kernel onlink' ;;
    "-o -6 addr show dev vmbr0 scope global") echo '2: vmbr0    inet6 2a01:4f8:1c1c:abcd::1/64 scope global \\       valid_lft forever preferred_lft forever' ;;
  esac
}`
  );
  if (!facts) return;
  assert.equal(facts.vmbr0_ipv4, "203.0.113.20", "the address, with ip's peer form");
  assert.equal(facts.gateway, "172.31.1.1 vmbr0");
  assert.equal(facts.pve_services, "active active active");
  assert.deepEqual(S.checkAfterReboot(facts, { ipv4: "203.0.113.20", ipv6Subnet: "2a01:4f8:1c1c:abcd" }), []);
});

test("3e accepts the address whichever way ip prints it: with a peer, or as a plain /32", () => {
  for (const line of ["2: vmbr0    inet 203.0.113.20 peer 172.31.1.1/32 scope global vmbr0", "2: vmbr0    inet 203.0.113.20/32 scope global vmbr0"]) {
    const facts = factsFrom(S.afterRebootFactsScript(), `ip() { [ "$1 $2" = "-o -4" ] && [ "$3" = addr ] && echo '${line}'; }\nuname() { :; }\npveversion() { :; }\ncat() { :; }\nsystemctl() { :; }`);
    if (!facts) return;
    assert.equal(facts.vmbr0_ipv4, "203.0.113.20", line);
  }
  const ok = { kernel: "6.8.12-9-pve", pveversion: "pve-manager/8.4.1/abc", vmbr0_ipv4: "203.0.113.20", gateway: "172.31.1.1 vmbr0", ipv6: "2a01:4f8:1c1c:abcd::1/64", pve_services: "active active active" };
  assert.deepEqual(S.checkAfterReboot(ok, { ipv4: "203.0.113.20", ipv6Subnet: "2a01:4f8:1c1c:abcd" }), []);
  assert.match(S.checkAfterReboot({ ...ok, vmbr0_ipv4: "203.0.113.99" }, { ipv4: "203.0.113.20", ipv6Subnet: "2a01:4f8:1c1c:abcd" }).join(), /vmbr0 has IPv4/);
});

test("3g: a bridge with no ports reports DOWN until its first container, and that's healthy", () => {
  const facts = factsFrom(
    S.outboundScript(),
    `curl() { return 0; }
pveam() { echo 'local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst   141.00MB'; }
systemctl() { echo enabled; }
pvesh() { echo '{"content":"iso,vztmpl,backup,rootdir,images","digest":"x","type":"dir"}'; }
ip() { echo 'vmbr1            DOWN           bc:24:11:aa:bb:cc <NO-CARRIER,BROADCAST,MULTICAST,UP>'; }
test() { return 0; }`
  );
  if (!facts) return;
  assert.equal(facts.vmbr1, "<NO-CARRIER,BROADCAST,MULTICAST,UP>");
  assert.deepEqual(S.checkHostSetup("== Done", facts), []);
  assert.match(S.checkHostSetup("== Done", { ...facts, vmbr1: "<BROADCAST,MULTICAST>" }).join(), /vmbr1 isn't up/);
  assert.match(S.checkHostSetup("== Done", { ...facts, vmbr1: "" }).join(), /missing/);
});

test("3f parses real sshd -T output", () => {
  const facts = factsFrom(
    S.firewallStatusScript(),
    `ufw() { echo 'Status: active'; }
sshd() { printf 'port 22\\npermitrootlogin without-password\\npasswordauthentication no\\nkbdinteractiveauthentication no\\npubkeyauthentication yes\\n'; }
fail2ban-client() { return 0; }
sysctl() { echo 1; }`
  );
  if (!facts) return;
  assert.deepEqual([facts.sshd_password, facts.sshd_root, facts.sshd_kbd, facts.fail2ban, facts.ip_forward], ["no", "without-password", "no", "active", "1"]);
});

test("3d doesn't hold the SSH call open for the whole install", () => {
  assert.match(S.startPveInstallScript(), /systemd-run --no-block --unit=sowsi-pve-install/);
});

test("3h finds the token JSON even with other output around it", () => {
  const json = JSON.stringify({ "full-tokenid": "root@pam!sowsi", info: { privsep: 0 }, value: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" }, null, 2);
  assert.equal(S.parseTokenSecret(`perl: warning: Setting locale failed.\n${json}\n`), "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
});

// ── The name pin, journald and IPv6 steps ────────────────────────────

const pinOk = {
  pin_file: S.sha256(S.linkFile(bridge)),
  pin_link: S.LINK_FILE,
  pin_initrd: "yes",
  guard_unit: "enabled",
  guard_script: S.sha256(S.guardScript()),
  journal_storage: "persistent",
  journal_dir: "yes",
};

test("the pin is verified where it counts: the file, what udev applies, and every initramfs", () => {
  const want = { nic: "eth0", mac: bridge.mac, pin: true, guard: true };
  assert.deepEqual(S.checkBootSafety(pinOk, want), []);
  assert.match(S.checkBootSafety({ ...pinOk, pin_link: "/usr/lib/systemd/network/99-default.link" }, want).join(), /udev doesn't apply the pin/);
  assert.match(S.checkBootSafety({ ...pinOk, pin_initrd: "no" }, want).join(), /every initramfs/);
  assert.match(S.checkBootSafety({ ...pinOk, pin_file: "0" }, want).join(), /isn't exactly the generated pin/);
  assert.match(S.checkBootSafety({ ...pinOk, guard_unit: "disabled" }, want).join(), /not enabled/);
  assert.match(S.checkBootSafety({ ...pinOk, guard_script: "0" }, want).join(), /isn't exactly the generated guard/);
  assert.match(S.checkBootSafety({ ...pinOk, journal_storage: "auto" }, want).join(), /not persistent/);
  assert.deepEqual(S.checkBootSafety({ journal_storage: "persistent", journal_dir: "yes" }, { ...want, pin: false, guard: false }), [], "switched off for a test");
  assert.throws(() => S.pinNicScript({ nic: "eth0; reboot", mac: bridge.mac }), /card name/);
  assert.throws(() => S.pinNicScript({ nic: "eth0", mac: "nope" }), /MAC/);
});

test("the pin goes into the initramfs on Debian's kernel and again on Proxmox's", () => {
  assert.match(S.pinNicScript(bridge), /update-initramfs -u -k all/);
  const install = S.pveInstallScript();
  assert.ok(install.indexOf("update-initramfs -u -k all") > install.indexOf("install proxmox-ve"));
  assert.ok(install.indexOf("update-initramfs -u -k all") < install.indexOf("update-grub"));
});

test("real udevadm, lsinitramfs and systemd-analyze output parses", (t) => {
  if (spawnSync("bash", ["--version"]).error) return t.skip("no bash");
  const stubs = `udevadm() { printf 'ID_NET_DRIVER=virtio_net\\nID_NET_LINK_FILE=${S.LINK_FILE}\\nID_NET_NAME=eth0\\n'; }
sha256sum() { echo "abc  $1"; }
lsinitramfs() { echo usr/lib/systemd/network/10-sowsi-uplink.link; }
systemctl() { echo enabled; }
systemd-analyze() { printf '# /etc/systemd/journald.conf\\n[Journal]\\n#Storage=auto\\n# /etc/systemd/journald.conf.d/00-sowsi.conf\\n[Journal]\\nStorage=persistent\\n'; }`;
  const r = spawnSync("bash", ["-s"], { input: `${stubs}\n${S.bootSafetyFactsScript("eth0")}`, encoding: "utf8" });
  const f = S.parseFacts(r.stdout);
  assert.equal(f.pin_link, S.LINK_FILE);
  assert.equal(f.pin_initrd, "yes");
  assert.equal(f.guard_unit, "enabled");
  assert.equal(f.journal_storage, "persistent", "the last value, not the commented default");
});

test("IPv6 is added by its own step, idempotently, and proven", () => {
  const script = S.ipv6Script(bridge.ipv6Subnet);
  assert.match(script, /grep -q '\^iface vmbr0 inet6'/);
  assert.ok(script.indexOf("cp -a") < script.indexOf(">> \"$F\""), "backed up first");
  assert.ok(script.indexOf(">> \"$F\"") < script.indexOf("ifreload -a"));
  const ok = { ipv6: "2a01:4f8:1c1c:abcd::1/64", route6: "fe80::1 vmbr0", ipv4: bridge.ipv4, out6: "ok" };
  const want = { ipv4: bridge.ipv4, ipv6Subnet: bridge.ipv6Subnet };
  assert.deepEqual(S.checkIpv6(ok, want), []);
  assert.match(S.checkIpv6({ ...ok, ipv4: "" }, want).join(), /lost its IPv4/);
  assert.match(S.checkIpv6({ ...ok, route6: "" }, want).join(), /default route/);
  assert.match(S.checkIpv6({ ...ok, out6: "fail" }, want).join(), /over IPv6/);
});

test("--simulate-bad-nic only rewrites vmbr0's port", () => {
  const script = S.simulateBadNicScript("eth0");
  assert.match(script, /bridge-ports eth0\$\/bridge-ports sowsibad0/);
  assert.match(script, /iface eth0 inet manual\/iface sowsibad0 inet manual/);
});
