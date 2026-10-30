// The shell run on a new node by scripts/node/install-node.ts, and the checks
// on what it reports. Pure: no SSH here, so all of it is unit-tested.
//
// Every script is idempotent (safe to run again on a half-done server) and
// reads only the values passed in — nothing is guessed on the server.
import { createHash } from "node:crypto";

/** Hetzner Cloud's IPv4 gateway (reached point-to-point; every server's IPv4 is a /32). */
export const HETZNER_GATEWAY4 = "172.31.1.1";
/** Name of the per-node Proxmox API token (root@pam!sowsi, no privilege separation). */
export const API_TOKEN_NAME = "sowsi";
export const API_TOKEN_ID = `root@pam!${API_TOKEN_NAME}`;
/** Hostname of the throwaway container the verify step creates. */
export const TEST_CONTAINER_HOSTNAME = "sowsi-node-test";
/** systemd unit running the long Proxmox install, so an SSH drop can't kill apt halfway. */
export const PVE_INSTALL_UNIT = "sowsi-pve-install";

export const APT =
  "DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 " +
  "-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";

/** Proxmox release key for Debian 12, and its SHA-512 as published in the Proxmox wiki ("Install Proxmox VE on Debian 12 Bookworm"). */
export const PVE_KEY_URL = "https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg";
export const PVE_KEY_SHA512 =
  "7da6fe34168adc6e479327ba517796d4702fa2f8b4f0a9833f5ea6e6b48f6507a6da403a274fe201595edc86a84463d50383d07f64bdde2e3658108db7d6dc87";

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** "2a01:4f8:1c1c:abcd::/64" → "2a01:4f8:1c1c:abcd" */
export function subnetOf(ipv6Network: string): string {
  const prefix = ipv6Network.split("/")[0].replace(/::$/, "").replace(/:+$/, "");
  if (!/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){1,3}$/i.test(prefix)) throw new Error(`unexpected IPv6 network "${ipv6Network}" — expected a /64 like 2a01:4f8:1c1c:abcd::/64`);
  if (!ipv6Network.endsWith("/64")) throw new Error(`IPv6 network "${ipv6Network}" is not a /64`);
  return prefix.toLowerCase();
}

/** "key=value" lines → object (later keys win). */
export function parseFacts(output: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) facts[m[1]] = m[2].trim();
  }
  return facts;
}

// ── b) hostname and /etc/hosts ───────────────────────────────────────

export function hostnameScript(name: string, ipv4: string): string {
  return `set -euo pipefail
NAME=${q(name)}; IP=${q(ipv4)}
# cloud-init must not rewrite the hostname, /etc/hosts or the network config again.
mkdir -p /etc/cloud/cloud.cfg.d
cat > /etc/cloud/cloud.cfg.d/99-sowsi.cfg <<'EOF'
preserve_hostname: true
manage_etc_hosts: false
network: {config: disabled}
EOF
hostnamectl set-hostname "$NAME"
# Proxmox needs the node name to resolve to its public IP, not 127.0.1.1.
sed -i -E "/^127\\.0\\.1\\.1[[:space:]]/d; /[[:space:]]$NAME([[:space:]]|\\$)/d" /etc/hosts
echo "$IP $NAME.sowsi.internal $NAME" >> /etc/hosts
echo "hostname=$(hostname)"
echo "resolves=$(getent ahostsv4 "$NAME" | awk 'NR==1{print $1}')"`;
}

export function checkHostname(facts: Record<string, string>, name: string, ipv4: string): string[] {
  const problems: string[] = [];
  if (facts.hostname !== name) problems.push(`hostname is "${facts.hostname}", expected "${name}"`);
  if (facts.resolves !== ipv4) problems.push(`${name} resolves to "${facts.resolves}", expected ${ipv4}`);
  return problems;
}

// ── c) bridge config, verified before any reboot ────────────────────

export type BridgeInput = { nic: string; mac: string; ipv4: string; ipv6Subnet: string };

/**
 * The complete /etc/network/interfaces: vmbr0 bridged to the NIC with the
 * server's /32, point-to-point to Hetzner's gateway, and the NIC's MAC (Hetzner
 * only forwards traffic from it). proxmox-host-setup.sh appends vmbr1 later.
 */
export function interfacesFile({ nic, mac, ipv4, ipv6Subnet }: BridgeInput): string {
  return `# Written by Sowsi install-node (step c). proxmox-host-setup.sh appends vmbr1.
auto lo
iface lo inet loopback

iface ${nic} inet manual

auto vmbr0
iface vmbr0 inet static
    address ${ipv4}/32
    gateway ${HETZNER_GATEWAY4}
    pointopoint ${HETZNER_GATEWAY4}
    bridge-ports ${nic}
    bridge-stp off
    bridge-fd 0
    hwaddress ${mac}

iface vmbr0 inet6 static
    address ${ipv6Subnet}::1/64
    gateway fe80::1
`;
}

export const STAGED_INTERFACES = "/etc/network/interfaces.sowsi-new";

/** Prints what the bridge config depends on, as key=value lines. Changes nothing. */
export function bridgeFactsScript(): string {
  return `set -uo pipefail
dev=$(ip -o -4 route show to default | awk '{print $5; exit}')
nic=$dev
if [[ -d /sys/class/net/$dev/bridge ]]; then nic=$(ls /sys/class/net/$dev/brif | head -1); fi
echo "default_dev=$dev"
echo "nic=$nic"
echo "mac=$(cat /sys/class/net/$nic/address 2>/dev/null)"
echo "ipv4=$(ip -o -4 addr show dev "$dev" scope global | awk '{print $4; exit}' | cut -d/ -f1)"
echo "gateway=$(ip -o -4 route show to default | awk '{print $3; exit}')"
echo "staged_sha=$( [[ -f ${STAGED_INTERFACES} ]] && sha256sum ${STAGED_INTERFACES} | cut -d' ' -f1 )"
echo "installed_sha=$(sha256sum /etc/network/interfaces | cut -d' ' -f1)"
echo "cloudinit_net_disabled=$(grep -qs 'network: {config: disabled}' /etc/cloud/cloud.cfg.d/99-sowsi.cfg && echo yes || echo no)"
echo "interfaces_d=$(ls /etc/network/interfaces.d 2>/dev/null | tr '\\n' ' ')"
echo "sources_interfaces_d=$(grep -Eqs '^[[:space:]]*source' /etc/network/interfaces && echo yes || echo no)"
echo "ifupdown2=$(dpkg-query -W -f='\${Status}' ifupdown2 2>/dev/null | grep -q 'install ok installed' && echo yes || echo no)"
echo "nameservers=$(grep -c '^nameserver' /etc/resolv.conf 2>/dev/null || echo 0)"`;
}

/** Writes the staged file (content on stdin) and turns cloud-init's network config off. Doesn't touch the live config. */
export function stageBridgeScript(): string {
  return `set -euo pipefail
cat > ${STAGED_INTERFACES}
mkdir -p /etc/cloud/cloud.cfg.d
grep -qs 'network: {config: disabled}' /etc/cloud/cloud.cfg.d/99-sowsi.cfg || echo 'network: {config: disabled}' >> /etc/cloud/cloud.cfg.d/99-sowsi.cfg
rm -f /etc/network/interfaces.d/50-cloud-init /etc/network/interfaces.d/50-cloud-init.cfg
# DNS must keep working once dhclient no longer writes resolv.conf (Hetzner's resolvers).
if ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
  rm -f /etc/resolv.conf
  printf 'nameserver 185.12.64.1\\nnameserver 185.12.64.2\\nnameserver 2a01:4ff:ff00::add:1\\n' > /etc/resolv.conf
fi`;
}

/** Puts the staged file in place (keeping the original once). Takes effect at the next boot. */
export function installBridgeScript(expectedSha: string): string {
  return `set -euo pipefail
test "$(sha256sum ${STAGED_INTERFACES} | cut -d' ' -f1)" = ${q(expectedSha)}
[[ -f /etc/network/interfaces.sowsi-orig ]] || cp -a /etc/network/interfaces /etc/network/interfaces.sowsi-orig
cp ${STAGED_INTERFACES} /etc/network/interfaces`;
}

/**
 * Everything the bridge config needs to bring the server back after a reboot.
 * `stage` "staged" = before it is installed; "installed" = in place;
 * "pre-reboot" = installed and ifupdown2 (which reads it at boot) is present.
 */
export function checkBridge(
  facts: Record<string, string>,
  expected: { ipv4: string; nic: string; mac: string; sha: string },
  stage: "staged" | "installed" | "pre-reboot"
): string[] {
  const problems: string[] = [];
  if (facts.ipv4 !== expected.ipv4) problems.push(`the server's live IPv4 is "${facts.ipv4}", but Hetzner says ${expected.ipv4}`);
  if (facts.gateway !== HETZNER_GATEWAY4) problems.push(`default gateway is "${facts.gateway}", expected ${HETZNER_GATEWAY4}`);
  if (facts.nic !== expected.nic) problems.push(`uplink NIC is "${facts.nic}", the config bridges ${expected.nic}`);
  if (facts.mac?.toLowerCase() !== expected.mac.toLowerCase()) problems.push(`NIC MAC is "${facts.mac}", the config sets ${expected.mac}`);
  if (facts.cloudinit_net_disabled !== "yes") problems.push("cloud-init's network config is still enabled (it would overwrite the bridge at boot)");
  if (/50-cloud-init/.test(facts.interfaces_d ?? "")) problems.push("/etc/network/interfaces.d still has cloud-init's DHCP config");
  if (Number(facts.nameservers ?? 0) < 1) problems.push("/etc/resolv.conf has no nameserver");
  const sha = stage === "staged" ? facts.staged_sha : facts.installed_sha;
  if (sha !== expected.sha) problems.push(`${stage === "staged" ? STAGED_INTERFACES : "/etc/network/interfaces"} isn't exactly the generated config (sha ${sha || "missing"})`);
  if (stage !== "staged" && facts.sources_interfaces_d === "yes") problems.push("/etc/network/interfaces sources other files");
  if (stage === "pre-reboot") {
    if (facts.ifupdown2 !== "yes") problems.push("ifupdown2 isn't installed — the bridge wouldn't come up at boot");
    if (facts.syntax !== "ok") problems.push(`ifupdown2 rejects /etc/network/interfaces: ${facts.syntax || "no result"}`);
    if (facts.pve_kernel !== "yes") problems.push("no Proxmox kernel in /boot");
    if (facts.grub_pve !== "yes") problems.push("GRUB has no Proxmox kernel entry");
    if (facts.debian_kernels && facts.debian_kernels !== "none") problems.push(`Debian kernels still installed: ${facts.debian_kernels}`);
  }
  return problems;
}

/** Extra facts for the last check before rebooting into Proxmox. */
export function preRebootFactsScript(): string {
  return `${bridgeFactsScript()}
echo "syntax=$(ifup --syntax-check -a -i /etc/network/interfaces >/dev/null 2>/tmp/sowsi-syntax && echo ok || tr '\\n' ' ' < /tmp/sowsi-syntax)"
echo "pve_kernel=$(ls /boot/vmlinuz-*-pve >/dev/null 2>&1 && echo yes || echo no)"
echo "grub_pve=$(grep -qs 'vmlinuz-[^ ]*-pve' /boot/grub/grub.cfg && echo yes || echo no)"
echo "debian_kernels=$(dpkg-query -W -f='\${Package} \${Status}\\n' 'linux-image-*' 2>/dev/null | awk '/install ok installed/{print $1}' | tr '\\n' ' ' | sed 's/ $//' | grep . || echo none)"
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"`;
}

// ── d) Proxmox VE install (runs as a systemd unit) ──────────────────

/** The install itself. Written to /root and run by systemd-run, so it survives an SSH drop. */
export function pveInstallScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="${APT.replace("DEBIAN_FRONTEND=noninteractive ", "")}"
echo "deb [arch=amd64] http://download.proxmox.com/debian/pve bookworm pve-no-subscription" > /etc/apt/sources.list.d/pve-install-repo.list
curl -fsSL ${PVE_KEY_URL} -o /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg
echo "${PVE_KEY_SHA512}  /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg" | sha512sum -c -
echo "postfix postfix/main_mailer_type select Local only" | debconf-set-selections
echo "postfix postfix/mailname string $(hostname -f)" | debconf-set-selections
$APT update
$APT full-upgrade
$APT install proxmox-ve postfix open-iscsi chrony
# Proxmox kernel only: remove every Debian kernel once a Proxmox one is in /boot.
ls /boot/vmlinuz-*-pve >/dev/null
debian=$(dpkg-query -W -f='\${Package} \${Status}\\n' 'linux-image-*' 2>/dev/null | awk '/install ok installed/{print $1}' || true)
if [[ -n $debian ]]; then $APT remove $debian; fi
$APT remove os-prober || true
update-grub
echo "PVE_INSTALL_DONE"
`;
}

/** Starts the install unit unless it already succeeded; restarts it if it failed. Prints the unit's state. */
export function startPveInstallScript(): string {
  return `set -euo pipefail
cat > /root/${PVE_INSTALL_UNIT}.sh
chmod 700 /root/${PVE_INSTALL_UNIT}.sh
state=$(systemctl show -p ActiveState --value ${PVE_INSTALL_UNIT} 2>/dev/null || true)
result=$(systemctl show -p Result --value ${PVE_INSTALL_UNIT} 2>/dev/null || true)
if [[ $state == active && $result == success ]]; then echo "already=done"; exit 0; fi
if [[ $state == activating ]]; then echo "already=running"; exit 0; fi
systemctl reset-failed ${PVE_INSTALL_UNIT} 2>/dev/null || true
systemctl stop ${PVE_INSTALL_UNIT} 2>/dev/null || true
systemd-run --unit=${PVE_INSTALL_UNIT} --property=Type=oneshot --property=RemainAfterExit=yes /root/${PVE_INSTALL_UNIT}.sh
echo "started=yes"`;
}

export function pveInstallStatusScript(): string {
  return `echo "state=$(systemctl show -p ActiveState --value ${PVE_INSTALL_UNIT})"
echo "result=$(systemctl show -p Result --value ${PVE_INSTALL_UNIT})"
echo "last=$(journalctl -u ${PVE_INSTALL_UNIT} -n 1 -o cat --no-pager 2>/dev/null | tr -d '\\n' | cut -c1-200)"`;
}

export function pveInstallLogScript(): string {
  return `journalctl -u ${PVE_INSTALL_UNIT} -n 40 -o cat --no-pager`;
}

/** Reboots a few seconds after the command returns, so the SSH call ends cleanly. */
export const REBOOT_SCRIPT = "systemd-run --on-active=3 /bin/systemctl reboot && echo rebooting";

// ── e) back after the reboot ────────────────────────────────────────

export function afterRebootFactsScript(): string {
  return `echo "kernel=$(uname -r)"
echo "pveversion=$(pveversion 2>/dev/null | head -1)"
echo "vmbr0_ipv4=$(ip -o -4 addr show dev vmbr0 2>/dev/null | awk '{print $4; exit}')"
echo "gateway=$(ip -o -4 route show to default | awk '{print $3" "$5; exit}')"
echo "ipv6=$(ip -o -6 addr show dev vmbr0 scope global 2>/dev/null | awk '{print $4; exit}')"
echo "pve_services=$(systemctl is-active pve-cluster pvedaemon pveproxy | tr '\\n' ' ')"
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"`;
}

export function checkAfterReboot(facts: Record<string, string>, expected: { ipv4: string; ipv6Subnet: string }): string[] {
  const problems: string[] = [];
  if (!facts.kernel?.endsWith("-pve")) problems.push(`running kernel "${facts.kernel}" isn't a Proxmox kernel`);
  if (!facts.pveversion?.startsWith("pve-manager/")) problems.push(`pveversion says "${facts.pveversion}"`);
  if (facts.vmbr0_ipv4 !== `${expected.ipv4}/32`) problems.push(`vmbr0 has IPv4 "${facts.vmbr0_ipv4}", expected ${expected.ipv4}/32`);
  if (facts.gateway !== `${HETZNER_GATEWAY4} vmbr0`) problems.push(`default route is "${facts.gateway}", expected via ${HETZNER_GATEWAY4} on vmbr0`);
  if (facts.ipv6 !== `${expected.ipv6Subnet}::1/64`) problems.push(`vmbr0 has IPv6 "${facts.ipv6}", expected ${expected.ipv6Subnet}::1/64`);
  if (facts.pve_services !== "active active active") problems.push(`Proxmox services: ${facts.pve_services} (pve-cluster pvedaemon pveproxy)`);
  return problems;
}

// ── f) firewall, fail2ban, key-only SSH ─────────────────────────────

export function firewallScript(mgmtIp: string): string {
  return `set -euo pipefail
${APT} install ufw fail2ban python3-systemd
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw default allow routed
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow from ${q(mgmtIp)} to any port 8006 proto tcp comment 'Proxmox API: sowsi-mgmt-01 only'
ufw route allow in on vmbr1
ufw route allow out on vmbr1
ufw --force enable
cat > /etc/fail2ban/jail.d/sowsi-sshd.conf <<EOF
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
# Never ban the management server (it runs this installer and the engine).
ignoreip = 127.0.0.1/8 ::1 ${mgmtIp}
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban
# Key-only SSH. 00- sorts first, and sshd keeps the first value it reads (cloud-init writes 50-cloud-init.conf).
cat > /etc/ssh/sshd_config.d/00-sowsi.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh
echo "ufw<<"; ufw status verbose; echo ">>ufw"
echo "sshd_password=$(sshd -T | awk '$1=="passwordauthentication"{print $2}')"
echo "sshd_root=$(sshd -T | awk '$1=="permitrootlogin"{print $2}')"
echo "sshd_kbd=$(sshd -T | awk '$1=="kbdinteractiveauthentication"{print $2}')"
echo "fail2ban=$(fail2ban-client status sshd >/dev/null 2>&1 && echo active || echo inactive)"`;
}

export function checkFirewall(output: string, mgmtIp: string): string[] {
  const problems: string[] = [];
  const ufw = /ufw<<([\s\S]*)>>ufw/.exec(output)?.[1] ?? "";
  const facts = parseFacts(output);
  if (!/Status: active/.test(ufw)) problems.push("ufw is not active");
  if (!/Default: deny \(incoming\), allow \(outgoing\), allow \(routed\)/.test(ufw)) problems.push("ufw defaults aren't deny incoming / allow outgoing / allow routed");
  for (const port of ["22", "80", "443"]) {
    if (!new RegExp(`^${port}/tcp\\s+ALLOW IN\\s+Anywhere`, "m").test(ufw)) problems.push(`port ${port} isn't open`);
  }
  if (!new RegExp(`^8006/tcp\\s+ALLOW IN\\s+${mgmtIp.replace(/\./g, "\\.")}`, "m").test(ufw)) problems.push(`8006 isn't limited to ${mgmtIp}`);
  if (/^8006(\/tcp)?\s+ALLOW IN\s+Anywhere/m.test(ufw)) problems.push("8006 is open to everyone");
  if (!/ALLOW FWD\s+Anywhere on vmbr1/.test(ufw)) problems.push("routed traffic from vmbr1 isn't allowed");
  if (facts.sshd_password !== "no") problems.push(`sshd PasswordAuthentication is ${facts.sshd_password}`);
  if (facts.sshd_kbd !== "no") problems.push(`sshd KbdInteractiveAuthentication is ${facts.sshd_kbd}`);
  if (facts.sshd_root !== "without-password" && facts.sshd_root !== "prohibit-password") problems.push(`sshd PermitRootLogin is ${facts.sshd_root}`);
  if (facts.fail2ban !== "active") problems.push("fail2ban's sshd jail isn't running");
  return problems;
}

// ── g) proxmox-host-setup.sh, then outbound checks from the host ────

export function hostSetupCommand(ipv6Subnet: string): string {
  // The script itself arrives on stdin. No PROVISIONING_PUBKEY: step i installs that key, last.
  return `IPV6_SUBNET=${q(ipv6Subnet)} CONTAINER_STORAGE=local bash -s`;
}

export const OUTBOUND_URL = "http://deb.debian.org/debian/dists/bookworm/Release";

export function outboundScript(): string {
  return `echo "out4=$(curl -4 -fsS -o /dev/null -m 15 ${OUTBOUND_URL} && echo ok || echo fail)"
echo "out6=$(curl -6 -fsS -o /dev/null -m 15 ${OUTBOUND_URL} && echo ok || echo fail)"
echo "template=$(pveam list local 2>/dev/null | grep -c ubuntu-22.04-standard)"
echo "routes_service=$(systemctl is-enabled sowsi-routes.service 2>/dev/null)"
echo "dispatcher=$(test -x /usr/local/sbin/sowsi-host && echo yes || echo no)"
echo "vmbr1=$(ip -br link show vmbr1 2>/dev/null | awk '{print $2}')"
echo "storage=$(pvesh get /storage/local --output-format json | sed -n 's/.*"content":"\\([^"]*\\)".*/\\1/p')"`;
}

export function checkHostSetup(setupOutput: string, facts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!setupOutput.includes("== Done")) problems.push("proxmox-host-setup.sh didn't finish");
  if (facts.out4 !== "ok") problems.push("the host can't reach the internet over IPv4");
  if (facts.out6 !== "ok") problems.push("the host can't reach the internet over IPv6");
  if (!(Number(facts.template) >= 1)) problems.push("the Ubuntu 22.04 LXC template isn't downloaded");
  if (facts.routes_service !== "enabled") problems.push("sowsi-routes.service isn't enabled");
  if (facts.dispatcher !== "yes") problems.push("/usr/local/sbin/sowsi-host is missing");
  if (!facts.vmbr1 || facts.vmbr1 === "DOWN") problems.push(`vmbr1 is ${facts.vmbr1 || "missing"}`);
  const content = `,${facts.storage ?? ""},`;
  for (const type of ["rootdir", "images", "vztmpl"]) if (!content.includes(`,${type},`)) problems.push(`storage "local" lacks ${type}`);
  return problems;
}

// ── h) API token ─────────────────────────────────────────────────────

/** Replaces the token (a secret can only be read when it is created). Output: the JSON pveum prints. */
export function apiTokenScript(): string {
  return `set -euo pipefail
pveum user token remove root@pam ${API_TOKEN_NAME} >/dev/null 2>&1 || true
pveum user token add root@pam ${API_TOKEN_NAME} --privsep 0 --comment 'Sowsi engine (install-node)' --output-format json`;
}

/** The token secret from `pveum user token add … --output-format json`. Never logged. */
export function parseTokenSecret(output: string): string {
  let parsed: { "full-tokenid"?: string; value?: string; info?: { privsep?: string | number } };
  try {
    parsed = JSON.parse(output.trim().split("\n").filter((l) => l.trim().startsWith("{")).join("") || output);
  } catch {
    throw new Error("pveum didn't print the token as JSON");
  }
  if (parsed["full-tokenid"] !== API_TOKEN_ID) throw new Error(`pveum created token "${parsed["full-tokenid"]}", expected ${API_TOKEN_ID}`);
  if (String(parsed.info?.privsep ?? "0") !== "0") throw new Error("the token has privilege separation on");
  if (!parsed.value || !/^[0-9a-f-]{36}$/i.test(parsed.value)) throw new Error("pveum's output has no token secret");
  return parsed.value;
}

// ── i) lock down: provisioning key in, install key out ──────────────

const keyBody = (publicKey: string) => {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body || !/^[A-Za-z0-9+/=]{40,}$/.test(body)) throw new Error("not an OpenSSH public key");
  return body;
};

/** Adds the provisioning key, forced to sowsi-host. Keeps every other line. */
export function addProvisioningKeyScript(provisioningPublicKey: string): string {
  return `set -euo pipefail
AUTH=/root/.ssh/authorized_keys
BODY=${q(keyBody(provisioningPublicKey))}
LINE=${q(`restrict,command="/usr/local/sbin/sowsi-host" ${provisioningPublicKey.trim()}`)}
touch "$AUTH"
TMP=$(mktemp)
grep -vF "$BODY" "$AUTH" > "$TMP" || true
echo "$LINE" >> "$TMP"
# On Proxmox this file is a symlink into /etc/pve: write through it, don't replace it.
cat "$TMP" > "$AUTH"
rm -f "$TMP"
grep -cF "$BODY" "$AUTH"`;
}

/** Removes the install key — refuses if the admin key isn't there, so root can't be locked out. */
export function removeInstallKeyScript(installPublicKey: string, adminPublicKey: string): string {
  return `set -euo pipefail
AUTH=/root/.ssh/authorized_keys
INSTALL=${q(keyBody(installPublicKey))}
ADMIN=${q(keyBody(adminPublicKey))}
grep -qF "$ADMIN" "$AUTH" || { echo "the admin key isn't in authorized_keys — not removing the install key" >&2; exit 3; }
TMP=$(mktemp)
grep -vF "$INSTALL" "$AUTH" > "$TMP" || true
cat "$TMP" > "$AUTH"
rm -f "$TMP"
echo "install_lines=$(grep -cF "$INSTALL" "$AUTH" || true)"
echo "admin_lines=$(grep -cF "$ADMIN" "$AUTH")"`;
}

/** "routes: 1 IPv4, 2 IPv6" (sowsi-routes) → counts. */
export function parseRoutes(output: string): { ipv4: number; ipv6: number } | null {
  const m = /routes: (\d+) IPv4, (\d+) IPv6/.exec(output);
  return m ? { ipv4: Number(m[1]), ipv6: Number(m[2]) } : null;
}

// ── 4) inside the test container ────────────────────────────────────

export function containerOutboundScript(ipv4: boolean): string {
  const get = (v: 4 | 6) =>
    `(curl -${v} -fsS -o /dev/null -m 15 ${OUTBOUND_URL} 2>/dev/null || wget -${v} -q -O /dev/null -T 15 ${OUTBOUND_URL}) && echo ok || echo fail`;
  return [`echo "out6=$(${get(6)})"`, ipv4 ? `echo "out4=$(${get(4)})"` : `echo "out4=skipped"`].join("\n");
}
