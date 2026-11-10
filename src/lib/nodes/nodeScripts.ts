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

export type BridgeInput = { nic: string; ipv4: string };

/**
 * The complete /etc/network/interfaces for the first boot: vmbr0 bridged to the card with
 * the server's /32, point-to-point to Hetzner's gateway. IPv4 only, as on node 1: IPv6 is
 * added by a later step, once SSH is back. proxmox-host-setup.sh appends vmbr1.
 * dns-nameservers is the second source for DNS: resolvconf's if-up hook reads it, and it only
 * counts if /etc/resolv.conf ever turns back into resolvconf's link.
 */
export function interfacesFile({ nic, ipv4 }: BridgeInput): string {
  return `# Written by Sowsi install-node. proxmox-host-setup.sh appends vmbr1.
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
    dns-nameservers ${RESOLVERS.join(" ")}
`;
}

/** Pins the card's name by MAC, on the disk and in the initramfs. */
export const LINK_FILE = "/etc/systemd/network/10-sowsi-uplink.link";

export function linkFile({ nic, mac }: { nic: string; mac: string }): string {
  return `# Written by Sowsi install-node: keeps this card's name whatever the kernel would call it.
[Match]
MACAddress=${mac}

[Link]
Name=${nic}
`;
}

const assertNic = (nic: string) => {
  if (!/^[a-z][a-z0-9]{1,14}$/.test(nic)) throw new Error(`unexpected card name "${nic}"`);
};
const assertMac = (mac: string) => {
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new Error(`unexpected MAC "${mac}"`);
};

/** Writes the pin and rebuilds the initramfs: the rename happens there, before the root disk is mounted. */
export function pinNicScript({ nic, mac }: { nic: string; mac: string }): string {
  assertNic(nic);
  assertMac(mac);
  return `set -euo pipefail
mkdir -p /etc/systemd/network
cat > ${LINK_FILE} <<'EOF'
${linkFile({ nic, mac }).trimEnd()}
EOF
update-initramfs -u -k all`;
}

export const GUARD_SCRIPT = "/usr/local/sbin/sowsi-net-guard";
export const GUARD_UNIT = "sowsi-net-guard.service";
export const GUARD_CONF = "/etc/sowsi-net-guard.conf";

/**
 * Runs at every boot. Does nothing if the network works. Otherwise it finds the card by MAC,
 * corrects vmbr0's port and reloads; if that isn't enough it drops the bridge for this boot and
 * falls back to DHCP, so the node can be reached. The fallback isn't written to disk: the next
 * boot tries the bridge again.
 *
 * sowsi-mgmt-01 being down must not look like a broken node, so reaching anything counts.
 */
export function guardScript(): string {
  return `#!/usr/bin/env bash
CONF=\${SOWSI_GUARD_CONF:-${GUARD_CONF}}
IFACES=\${SOWSI_GUARD_INTERFACES:-/etc/network/interfaces}
SYS=\${SOWSI_GUARD_SYS:-/sys/class/net}
LOG=\${SOWSI_GUARD_LOG:-/var/log/sowsi-net-guard.log}
. "$CONF"

log() { echo "$(date -Is) $*" >> "$LOG"; }
can_reach() { timeout 3 bash -c "</dev/tcp/$1/$2" 2>/dev/null; }
online() { can_reach "$MGMT_IP" 22 || can_reach 185.12.64.1 53 || can_reach 1.1.1.1 443; }
wait_online() {
  for _ in $(seq 1 $(($1 / 5))); do
    online && return 0
    sleep 5
  done
  return 1
}

wait_online 90 && exit 0

log "no network after 90 seconds"
card=""
for d in "$SYS"/*; do
  [ -e "$d/device" ] || continue
  [ "$(cat "$d/address")" = "$MAC" ] && card=\${d##*/}
done
if [ -z "$card" ]; then
  log "no card with MAC $MAC; nothing changed"
  exit 1
fi

port=$(awk '$1=="bridge-ports" && $2!="none"{print $2; exit}' "$IFACES")
if [ "$port" != "$card" ]; then
  cp -a "$IFACES" "$IFACES.sowsi-guard-$(date +%s)"
  sed -i -e "s/^iface $port inet manual/iface $card inet manual/" -e "/^iface vmbr0 inet static/,/^\\$/s/bridge-ports .*/bridge-ports $card/" "$IFACES"
  log "vmbr0 pointed at $port; the card with MAC $MAC is $card: interfaces file corrected"
fi
ifreload -a
if wait_online 30; then
  log "network is back on vmbr0 ($card)"
  exit 0
fi

log "still no network: dropping vmbr0 for this boot, falling back to DHCP on $card"
ip link set vmbr0 down
ip link del vmbr0
ip link set "$card" up
if command -v dhclient >/dev/null; then
  timeout 30 dhclient -1 "$card"
else
  ip addr add "$IPV4/32" dev "$card"
  ip route add "$GATEWAY" dev "$card"
  ip route add default via "$GATEWAY" dev "$card"
fi
if wait_online 30; then log "network is back on $card without the bridge"; else log "still no network"; fi
`;
}

/** Installs the guard, its settings and its unit. The script arrives on stdin. */
export function installGuardScript({ mac, ipv4, mgmtIp }: { mac: string; ipv4: string; mgmtIp: string }): string {
  assertMac(mac);
  return `set -euo pipefail
cat > ${GUARD_SCRIPT}
chmod 755 ${GUARD_SCRIPT}
cat > ${GUARD_CONF} <<'EOF'
MAC=${mac}
IPV4=${ipv4}
GATEWAY=${HETZNER_GATEWAY4}
MGMT_IP=${mgmtIp}
EOF
cat > /etc/systemd/system/${GUARD_UNIT} <<'EOF'
[Unit]
Description=Sowsi network guard: repairs the node's network if it can't reach anything at boot
After=network-pre.target
Wants=network-pre.target

[Service]
Type=simple
ExecStart=${GUARD_SCRIPT}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${GUARD_UNIT}`;
}

/**
 * Hetzner's two resolvers, then a public fallback. glibc reads only the first three, so that's all
 * there are. Hetzner's only answer from inside Hetzner, which is where every node is.
 */
export const RESOLVERS = ["185.12.64.1", "185.12.64.2", "1.1.1.1"];

/**
 * The Debian image links /etc/resolv.conf to /run/resolvconf/resolv.conf, fed by dhclient. /run is
 * wiped at boot and vmbr0 doesn't use DHCP, so after the first reboot that file has no nameserver.
 * A plain file needs neither: resolvconf only warns and leaves it alone, and it's what Proxmox expects.
 * mv replaces the link itself rather than writing through it.
 */
export function dnsScript(): string {
  return `set -euo pipefail
tmp=$(mktemp /etc/resolv.conf.sowsi.XXXXXX)
cat > "$tmp" <<'EOF'
# Written by Sowsi install-node. A plain file on purpose: a link into /run is empty after a reboot.
${RESOLVERS.map((r) => `nameserver ${r}`).join("\n")}
options timeout:2
EOF
chmod 644 "$tmp"
mv -fT "$tmp" /etc/resolv.conf`;
}

export function dnsFactsScript(): string {
  return `echo "resolv_link=$([ -L /etc/resolv.conf ] && echo yes || echo no)"
echo "resolv_servers=$(awk '$1=="nameserver"{printf "%s ", $2}' /etc/resolv.conf 2>/dev/null)"
echo "dns=$(getent hosts deb.debian.org >/dev/null 2>&1 && echo ok || echo broken)"`;
}

export function checkDns(facts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (facts.resolv_link !== "no") problems.push("/etc/resolv.conf is a link, so it won't survive a reboot");
  if (facts.resolv_servers !== RESOLVERS.join(" ")) problems.push(`/etc/resolv.conf lists "${facts.resolv_servers ?? ""}", expected ${RESOLVERS.join(" ")}`);
  if (facts.dns !== "ok") problems.push("names don't resolve");
  return problems;
}

/** A failed boot has to be readable afterwards. */
export function journaldScript(): string {
  return `set -euo pipefail
mkdir -p /etc/systemd/journald.conf.d /var/log/journal
printf '[Journal]\\nStorage=persistent\\n' > /etc/systemd/journald.conf.d/00-sowsi.conf
systemd-tmpfiles --create --prefix /var/log/journal 2>/dev/null || true
systemctl restart systemd-journald
journalctl --flush`;
}

/** What protects the first boot, as it really is on the machine. */
export function bootSafetyFactsScript(nic: string): string {
  assertNic(nic);
  return `echo "pin_file=$(sha256sum ${LINK_FILE} 2>/dev/null | cut -d' ' -f1)"
echo "pin_link=$(udevadm test-builtin net_setup_link /sys/class/net/${nic} 2>/dev/null | sed -n 's/^ID_NET_LINK_FILE=//p')"
pin=yes
for f in /boot/initrd.img-*; do lsinitramfs "$f" | grep -q 10-sowsi-uplink.link || pin=no; done
echo "pin_initrd=$pin"
echo "guard_unit=$(systemctl is-enabled ${GUARD_UNIT} 2>/dev/null)"
echo "guard_script=$(sha256sum ${GUARD_SCRIPT} 2>/dev/null | cut -d' ' -f1)"
echo "journal_storage=$(systemd-analyze cat-config systemd/journald.conf 2>/dev/null | awk -F= '/^Storage=/{v=$2} END{print v}')"
echo "journal_dir=$([ -d /var/log/journal ] && echo yes || echo no)"`;
}

export function checkBootSafety(facts: Record<string, string>, expected: { nic: string; mac: string; pin: boolean; guard: boolean }): string[] {
  const problems: string[] = [];
  if (expected.pin) {
    if (facts.pin_file !== sha256(linkFile(expected))) problems.push(`${LINK_FILE} isn't exactly the generated pin`);
    if (facts.pin_link !== LINK_FILE) problems.push(`udev doesn't apply the pin to ${expected.nic} (it uses ${facts.pin_link || "nothing"})`);
    if (facts.pin_initrd !== "yes") problems.push("the name pin isn't in every initramfs");
  }
  if (expected.guard) {
    if (facts.guard_unit !== "enabled") problems.push(`${GUARD_UNIT} is ${facts.guard_unit || "missing"}, not enabled`);
    if (facts.guard_script !== sha256(guardScript())) problems.push(`${GUARD_SCRIPT} isn't exactly the generated guard`);
  }
  if (facts.journal_storage !== "persistent") problems.push(`journald Storage is ${facts.journal_storage || "unknown"}, not persistent`);
  if (facts.journal_dir !== "yes") problems.push("/var/log/journal doesn't exist");
  return problems;
}

/** A card name that doesn't exist, for proving the guard and the rescue repair on a throwaway. */
export const BAD_NIC = "sowsibad0";

/** Points vmbr0 at the bad name. Only with --simulate-bad-nic, after every check has passed. */
export function simulateBadNicScript(nic: string): string {
  assertNic(nic);
  return `sed -i -e 's/^iface ${nic} inet manual/iface ${BAD_NIC} inet manual/' -e 's/bridge-ports ${nic}$/bridge-ports ${BAD_NIC}/' /etc/network/interfaces
grep -c 'bridge-ports ${BAD_NIC}' /etc/network/interfaces`;
}

/** Answer ping and don't depend on DNS, which proxmox-host-setup.sh only repairs in the next step. */
const IPV6_TARGETS = ["2001:4860:4860::8888", "2606:4700:4700::1111"];

/**
 * After the bridge is proven up: adds the IPv6 stanza and reloads. Then it waits for the address
 * to leave "tentative", pings the gateway so its neighbour entry exists, and only then gives the
 * outbound ping about 30 seconds. Safe to run again.
 */
export function ipv6Script(ipv6Subnet: string): string {
  return `set -euo pipefail
F=/etc/network/interfaces
if ! grep -q '^iface vmbr0 inet6' "$F"; then
  cp -a "$F" "$F.sowsi-before-ipv6"
  printf '\\niface vmbr0 inet6 static\\n    address ${ipv6Subnet}::1/64\\n    gateway fe80::1\\n' >> "$F"
fi
since=$(date '+%Y-%m-%d %H:%M:%S')
ifreload -a
for _ in $(seq 1 15); do
  addr=$(ip -o -6 addr show dev vmbr0 scope global)
  if [ -n "$addr" ] && ! grep -q tentative <<<"$addr"; then break; fi
  sleep 1
done
gateway6=fail
for _ in $(seq 1 5); do
  if ping -6 -c 1 -W 2 fe80::1%vmbr0 >/dev/null 2>&1; then gateway6=ok; break; fi
done
out6=fail
for i in $(seq 1 10); do
  target=${IPV6_TARGETS[0]}
  if [ $((i % 2)) = 0 ]; then target=${IPV6_TARGETS[1]}; fi
  if ping -6 -c 1 -W 2 "$target" >/dev/null 2>&1; then out6=ok; break; fi
  sleep 1
done
if [ "$out6" != ok ]; then
  echo "ipv6_debug<<"
  echo "--- ip -6 addr"; ip -6 addr show dev vmbr0
  echo "--- ip -6 route"; ip -6 route
  echo "--- ip -6 neigh"; ip -6 neigh show dev vmbr0
  echo "--- journal since the reload"; journalctl --since "$since" --no-pager 2>&1 | head -30 || true
  echo ">>ipv6_debug"
fi
echo "ipv6=$(ip -o -6 addr show dev vmbr0 scope global | awk '{print $4; exit}')"
echo "route6=$(ip -6 route show default | awk '{print $3" "$5; exit}')"
echo "ipv4=$(ip -o -4 addr show dev vmbr0 | awk '{print $4; exit}' | cut -d/ -f1)"
echo "gateway6=$gateway6"
echo "dns=$(getent hosts deb.debian.org >/dev/null && echo ok || echo broken)"
echo "out6=$out6"`;
}

export function checkIpv6(facts: Record<string, string>, expected: { ipv4: string; ipv6Subnet: string }): string[] {
  const problems: string[] = [];
  if (facts.ipv6 !== `${expected.ipv6Subnet}::1/64`) problems.push(`vmbr0 has IPv6 "${facts.ipv6}", expected ${expected.ipv6Subnet}::1/64`);
  if (facts.route6 !== "fe80::1 vmbr0") problems.push(`IPv6 default route is "${facts.route6}", expected via fe80::1 on vmbr0`);
  if (facts.ipv4 !== expected.ipv4) problems.push(`vmbr0 lost its IPv4 (now "${facts.ipv4}")`);
  if (facts.out6 !== "ok") problems.push("the host can't reach the internet over IPv6");
  return problems;
}

/** ip -6 addr, route, neigh and the journal, printed only when the outbound ping failed. */
export function ipv6Debug(output: string): string {
  return /ipv6_debug<<\n([\s\S]*?)\n?>>ipv6_debug/.exec(output)?.[1] ?? "";
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
`;
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
# The Proxmox kernel's initramfs must carry the name pin too.
update-initramfs -u -k all
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
# --no-block: without it systemd-run waits for a oneshot unit to finish, keeping this SSH call open for the whole install.
systemd-run --no-block --unit=${PVE_INSTALL_UNIT} --property=Type=oneshot --property=RemainAfterExit=yes /root/${PVE_INSTALL_UNIT}.sh
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
echo "vmbr0_ipv4=$(ip -o -4 addr show dev vmbr0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1)"
echo "gateway=$(ip -o -4 route show to default | awk '{print $3" "$5; exit}')"
echo "ipv6=$(ip -o -6 addr show dev vmbr0 scope global 2>/dev/null | awk '{print $4; exit}')"
echo "pve_services=$(systemctl is-active pve-cluster pvedaemon pveproxy | tr '\\n' ' ')"
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"`;
}

/** The first boot is IPv4 only: `ipv6Subnet` is checked only when given. */
export function checkAfterReboot(facts: Record<string, string>, expected: { ipv4: string; ipv6Subnet?: string | null }): string[] {
  const problems: string[] = [];
  if (!facts.kernel?.endsWith("-pve")) problems.push(`running kernel "${facts.kernel}" isn't a Proxmox kernel`);
  if (!facts.pveversion?.startsWith("pve-manager/")) problems.push(`pveversion says "${facts.pveversion}"`);
  // With pointopoint, ip prints "inet A peer 172.31.1.1/32": the address alone is compared.
  if (facts.vmbr0_ipv4 !== expected.ipv4) problems.push(`vmbr0 has IPv4 "${facts.vmbr0_ipv4}", expected ${expected.ipv4}`);
  if (facts.gateway !== `${HETZNER_GATEWAY4} vmbr0`) problems.push(`default route is "${facts.gateway}", expected via ${HETZNER_GATEWAY4} on vmbr0`);
  if (expected.ipv6Subnet && facts.ipv6 !== `${expected.ipv6Subnet}::1/64`) problems.push(`vmbr0 has IPv6 "${facts.ipv6}", expected ${expected.ipv6Subnet}::1/64`);
  if (facts.pve_services !== "active active active") problems.push(`Proxmox services: ${facts.pve_services} (pve-cluster pvedaemon pveproxy)`);
  return problems;
}

// ── f) firewall, fail2ban, key-only SSH (before the Proxmox install) ─

/** Prints the firewall and SSH state. Changes nothing. */
export function firewallStatusScript(): string {
  return `echo "ufw<<"; ufw status verbose; echo ">>ufw"
echo "sshd_password=$(sshd -T | awk '$1=="passwordauthentication"{print $2}')"
echo "sshd_root=$(sshd -T | awk '$1=="permitrootlogin"{print $2}')"
echo "sshd_kbd=$(sshd -T | awk '$1=="kbdinteractiveauthentication"{print $2}')"
echo "fail2ban=$(fail2ban-client status sshd >/dev/null 2>&1 && echo active || echo inactive)"
echo "ip_forward=$(sysctl -n net.ipv4.ip_forward)"`;
}

/** Runs before Proxmox is installed, on plain Debian: rules can name vmbr1 before it exists. */
export function firewallScript(mgmtIp: string): string {
  return `set -euo pipefail
${APT} update
${APT} install ufw fail2ban python3-systemd
# A clean start, so a half-applied firewall from an earlier run can't matter.
ufw --force reset >/dev/null
# ufw reports "disabled (routed)" while the kernel doesn't forward, whatever its policy says.
# proxmox-host-setup.sh adds IPv6 forwarding once the bridges exist.
grep -qs '^net.ipv4.ip_forward *= *1' /etc/sysctl.d/99-sowsi-routing.conf || echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.d/99-sowsi-routing.conf
sysctl -q -w net.ipv4.ip_forward=1
ufw default deny incoming
ufw default allow outgoing
ufw default allow routed
# Scanner hits otherwise fill the VNC console with [UFW BLOCK] lines.
ufw logging off
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
# Key-only SSH, set explicitly. 00- sorts first, and sshd keeps the first value it reads
# (cloud-init writes 50-cloud-init.conf). checkFirewall reads the result from sshd -T.
grep -qE '^Include /etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
cat > /etc/ssh/sshd_config.d/00-sowsi.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh
for _ in $(seq 1 15); do fail2ban-client ping >/dev/null 2>&1 && break; sleep 1; done
${firewallStatusScript()}`;
}

export function checkFirewall(output: string, mgmtIp: string): string[] {
  const problems: string[] = [];
  const ufw = /ufw<<([\s\S]*)>>ufw/.exec(output)?.[1] ?? "";
  const facts = parseFacts(output);
  if (!/Status: active/.test(ufw)) problems.push("ufw is not active");
  if (!/^Logging: off/m.test(ufw)) problems.push("ufw logging is still on");
  const defaults = /Default: (\S+) \(incoming\), (\S+) \(outgoing\), (\S+) \(routed\)/.exec(ufw);
  if (!defaults) problems.push("ufw status has no Default: line");
  else {
    if (defaults[1] !== "deny") problems.push(`ufw default incoming is "${defaults[1]}", expected deny`);
    if (defaults[2] !== "allow") problems.push(`ufw default outgoing is "${defaults[2]}", expected allow`);
    if (defaults[3] === "disabled") problems.push('ufw shows "disabled (routed)": the kernel isn\'t forwarding, so containers behind vmbr1 would have no internet');
    else if (defaults[3] !== "allow") problems.push(`ufw default routed is "${defaults[3]}", expected allow`);
  }
  if (facts.ip_forward !== "1") problems.push(`net.ipv4.ip_forward is ${facts.ip_forward || "unknown"}, expected 1`);
  for (const port of ["22", "80", "443"]) {
    if (!new RegExp(`^${port}/tcp\\s+ALLOW IN\\s+Anywhere`, "m").test(ufw)) problems.push(`port ${port} isn't open`);
  }
  if (!new RegExp(`^8006/tcp\\s+ALLOW IN\\s+${mgmtIp.replace(/\./g, "\\.")}(\\s|$)`, "m").test(ufw)) problems.push(`8006 isn't limited to ${mgmtIp}`);
  if (/^8006(\/tcp)?(\s+\(v6\))?\s+ALLOW IN\s+Anywhere/m.test(ufw)) problems.push("8006 is open to everyone");
  if (!/ALLOW FWD\s+Anywhere on vmbr1/.test(ufw) || !/Anywhere on vmbr1\s+ALLOW FWD/.test(ufw)) problems.push("routed traffic on vmbr1 isn't allowed both ways");
  // What sshd actually enforces, from sshd -T. It prints prohibit-password as "without-password".
  if (facts.sshd_password !== "no") problems.push(`sshd passwordauthentication is ${facts.sshd_password || "unknown"}, expected no`);
  if (facts.sshd_kbd !== "no") problems.push(`sshd kbdinteractiveauthentication is ${facts.sshd_kbd || "unknown"}, expected no`);
  if (facts.sshd_root !== "without-password" && facts.sshd_root !== "prohibit-password") problems.push(`sshd permitrootlogin is ${facts.sshd_root || "unknown"}, expected prohibit-password`);
  if (facts.fail2ban !== "active") problems.push("fail2ban's sshd jail isn't running");
  return problems;
}

// ── g) proxmox-host-setup.sh, then outbound checks from the host ────

export function hostSetupCommand(ipv6Subnet: string, mgmtIp: string): string {
  // The script itself arrives on stdin. No PROVISIONING_PUBKEY: step i installs that key, last.
  return `IPV6_SUBNET=${q(ipv6Subnet)} MGMT_IP=${q(mgmtIp)} CONTAINER_STORAGE=local bash -s`;
}

export const OUTBOUND_URL = "http://deb.debian.org/debian/dists/bookworm/Release";

export function outboundScript(mgmtIp: string): string {
  return `echo "out4=$(curl -4 -fsS -o /dev/null -m 15 ${OUTBOUND_URL} && echo ok || echo fail)"
echo "out6=$(curl -6 -fsS -o /dev/null -m 15 ${OUTBOUND_URL} && echo ok || echo fail)"
echo "template=$(pveam list local 2>/dev/null | grep -c ubuntu-22.04-standard)"
echo "routes_service=$(systemctl is-enabled sowsi-routes.service 2>/dev/null)"
echo "dispatcher=$(test -x /usr/local/sbin/sowsi-host && echo yes || echo no)"
echo "vmbr1=$(ip -br link show vmbr1 2>/dev/null | awk '{print $NF}')"
echo "storage=$(pvesh get /storage/local --output-format json | sed -n 's/.*"content":"\\([^"]*\\)".*/\\1/p')"
echo "forward4=$(sysctl -n net.ipv4.ip_forward)"
echo "forward6=$(sysctl -n net.ipv6.conf.all.forwarding)"
echo "forward_saved=$(grep -c '^net.ip' /etc/sysctl.d/99-sowsi-routing.conf)"
echo "proxy_ndp=$(sysctl -n net.ipv6.conf.vmbr0.proxy_ndp)"
echo "proxy_arp=$(sysctl -n net.ipv4.conf.vmbr1.proxy_arp)"
echo "proxy_saved=$(grep -cE 'post-up sysctl -qw net\\.(ipv6\\.conf\\.vmbr0\\.proxy_ndp|ipv4\\.conf\\.vmbr1\\.proxy_arp)=1' /etc/network/interfaces)"
echo "iso_tables=$(nft list tables 2>/dev/null | grep -cE '^table (bridge|inet) sowsi$')"
echo "iso_ports=$(nft list chain bridge sowsi from_ports 2>/dev/null | grep -c unknown_port)"
echo "iso_between=$(nft list chain bridge sowsi between_ports 2>/dev/null | grep -c to_neighbour_l2)"
echo "iso_forward=$(nft list chain inet sowsi forwarded 2>/dev/null | grep -cE 'to_neighbour_l3|to_other_iface|to_private|to_mail|to_metadata')"
echo "iso_mgmt=$(nft list chain inet sowsi host_input 2>/dev/null | grep -cF ${q(`ip saddr != ${mgmtIp} tcp dport 8006`)})"
echo "iso_timer=$(systemctl is-enabled sowsi-routes.timer 2>/dev/null)"
echo "iso_before_guests=$(systemctl show -p Before sowsi-routes.service 2>/dev/null | grep -c pve-guests)"
echo "iso_last_good=$(nft -c -f /etc/sowsi/rules.last-good.nft >/dev/null 2>&1 && echo ok || echo bad)"
echo "iso_redirects=$(sysctl -n net.ipv4.conf.vmbr1.send_redirects 2>/dev/null)"
echo "iso_accept_ra=$(sysctl -n net.ipv6.conf.vmbr1.accept_ra 2>/dev/null)"
echo "nftables_service=$(systemctl is-enabled nftables.service 2>/dev/null)"
echo "pve_nft_tables=$(nft list tables 2>/dev/null | grep -c proxmox-firewall)"`;
}

export function checkHostSetup(setupOutput: string, facts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!setupOutput.includes("== Done")) problems.push("proxmox-host-setup.sh didn't finish");
  if (facts.out4 !== "ok") problems.push("the host can't reach the internet over IPv4");
  if (facts.out6 !== "ok") problems.push("the host can't reach the internet over IPv6");
  if (!(Number(facts.template) >= 1)) problems.push("the Ubuntu 22.04 LXC template isn't downloaded");
  if (facts.routes_service !== "enabled") problems.push("sowsi-routes.service isn't enabled");
  if (facts.dispatcher !== "yes") problems.push("/usr/local/sbin/sowsi-host is missing");
  // Its state column says DOWN (no carrier) until the first container: read the UP flag instead.
  if (!/[<,]UP[,>]/.test(facts.vmbr1 ?? "")) problems.push(`vmbr1 isn't up (${facts.vmbr1 || "missing"})`);
  const content = `,${facts.storage ?? ""},`;
  for (const type of ["rootdir", "images", "vztmpl"]) if (!content.includes(`,${type},`)) problems.push(`storage "local" lacks ${type}`);
  // Containers depend on these, and they must survive a reboot: forwarding through /etc/sysctl.d,
  // the per-bridge proxies through vmbr1's post-up lines, which run each time the bridge comes up.
  if (facts.forward4 !== "1" || facts.forward6 !== "1") problems.push(`forwarding is off (IPv4 ${facts.forward4}, IPv6 ${facts.forward6})`);
  if (facts.forward_saved !== "2") problems.push("IPv4 and IPv6 forwarding aren't both in /etc/sysctl.d/99-sowsi-routing.conf");
  if (facts.proxy_ndp !== "1") problems.push(`proxy_ndp on vmbr0 is ${facts.proxy_ndp}`);
  if (facts.proxy_arp !== "1") problems.push(`proxy_arp on vmbr1 is ${facts.proxy_arp}`);
  if (facts.proxy_saved !== "2") problems.push("the proxy settings aren't in vmbr1's post-up lines, so they wouldn't survive a reboot");
  if (facts.iso_tables !== "2") problems.push(`the isolation tables aren't both loaded (${facts.iso_tables || "0"} of 2)`);
  if (facts.iso_ports !== "2") problems.push("the rule that drops ports without a chain is missing");
  if (facts.iso_between !== "1") problems.push("the rule between containers on vmbr1 is missing");
  if (facts.iso_forward !== "6") problems.push(`the forwarding rules are incomplete (${facts.iso_forward || "0"} of 6)`);
  if (facts.iso_mgmt !== "1") problems.push("8006 isn't limited to sowsi-mgmt-01 in the isolation rules");
  if (facts.iso_timer !== "enabled") problems.push("sowsi-routes.timer isn't enabled, so removed rules wouldn't come back");
  if (facts.iso_before_guests !== "1") problems.push("sowsi-routes.service doesn't run before pve-guests, so containers could start without rules");
  if (facts.iso_last_good !== "ok") problems.push("the last good rules are missing or don't load");
  if (facts.iso_redirects !== "0") problems.push(`vmbr1 sends ICMP redirects (${facts.iso_redirects})`);
  if (facts.iso_accept_ra !== "0") problems.push(`vmbr1 accepts router advertisements (${facts.iso_accept_ra})`);
  if (facts.nftables_service !== "masked") problems.push(`nftables.service is ${facts.nftables_service || "unknown"}, expected masked: it would flush every table`);
  if (facts.pve_nft_tables !== "0") problems.push("the Proxmox nftables firewall is running: check it leaves the sowsi tables alone before using this node");
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
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
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

/** A public key's fingerprint, exactly as ssh-keygen -l prints it. */
export function keyFingerprint(publicKey: string): string {
  const hash = createHash("sha256").update(Buffer.from(keyBody(publicKey), "base64")).digest("base64");
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

export type AuthorizedKeys = {
  /** Lines in the files that aren't blank or comments. */
  lines: number;
  /** Size, fingerprint and type, e.g. "256 SHA256:abc (ED25519)". */
  keys: { fingerprint: string; shown: string }[];
  /** Fingerprint of the key Proxmox made for this node; empty if the node has none. */
  nodeKey: string;
};

/** Output of `sowsi-host authorized-keys`: fingerprints only. */
export function parseAuthorizedKeys(output: string): AuthorizedKeys {
  const keys: AuthorizedKeys["keys"] = [];
  for (const line of output.split("\n")) {
    const m = /^key=(\S+ (SHA256:\S+).*)$/.exec(line.trim());
    if (m) keys.push({ fingerprint: m[2], shown: m[1] });
  }
  const facts = parseFacts(output);
  return { lines: Number(facts.lines ?? -1), keys, nodeKey: facts.node_key ?? "" };
}

/**
 * Every key on the node must be one of ours. `install` is passed only until that key is removed.
 * The node's own key isn't optional: Proxmox adds it back itself ("always add ourself" in pvecm
 * updatecerts), so it's allowed, but only as the key whose private half is on this node.
 */
export function checkAuthorizedKeys(
  found: AuthorizedKeys,
  allowed: { admin: string; provisioning: string; install?: string }
): { problems: string[]; listing: string[] } {
  const roles = new Map<string, string>([
    [keyFingerprint(allowed.admin), "admin"],
    [keyFingerprint(allowed.provisioning), "provisioning"],
  ]);
  if (allowed.install) roles.set(keyFingerprint(allowed.install), "install");
  if (found.nodeKey) roles.set(found.nodeKey, "Proxmox's own key for this node");

  const problems: string[] = [];
  const listing = found.keys.map((k) => `${roles.get(k.fingerprint) ?? "NOT ALLOWED"}: ${k.shown}`);
  for (const k of found.keys) if (!roles.has(k.fingerprint)) problems.push(`key not allowed: ${k.shown}`);
  if (found.lines !== found.keys.length) problems.push(`authorized_keys has ${found.lines} lines, but ${found.keys.length} readable keys`);
  for (const role of ["admin", "provisioning"] as const) {
    if (!found.keys.some((k) => k.fingerprint === keyFingerprint(allowed[role]))) problems.push(`the ${role} key isn't on the node`);
  }
  return { problems, listing };
}

/** "routes: 1 IPv4, 2 IPv6" (sowsi-routes) → counts. */
export function parseRoutes(output: string): { ipv4: number; ipv6: number } | null {
  const m = /routes: (\d+) IPv4, (\d+) IPv6/.exec(output);
  return m ? { ipv4: Number(m[1]), ipv6: Number(m[2]) } : null;
}

// ── 4) inside the test container ────────────────────────────────────

// ── 4) proving the isolation rules, from a test container ────────────

/**
 * Test containers get these instead of a Floating IP, unless --ipv4 gave one. Nothing routes them,
 * but they're enough to send IPv4 at the host, which is all the proof needs, and they cost nothing.
 */
export const TEST_IPV4 = { first: "198.18.254.10", second: "198.18.254.11", spoof: "198.18.254.99" };
/** Reached through the dummy interface from `isolation-probe on`. Must match sowsi-routes. */
export const PROBE_TARGET = { ipv4: "198.19.255.2", ipv6: "2001:db8:5053::2" };
/** A private address in case MGMT_PRIVATE_IP isn't set. */
export const PRIVATE_TARGET = "10.0.0.2";
const OUTSIDE_IPV6 = "2606:4700:4700::1111";

export type IsolationTargets = { neighbourIpv4: string; neighbourIpv6: string; nodeIpv4: string; nodeIpv6: string; mgmtPrivateIp: string | null };

/** Every line is an attempt that must fail. Each one also has a counter on the host that must rise. */
export function isolationProbeScript(t: IsolationTargets): string {
  const attempts: [string, string, number][] = [
    ["neighbour_v6", t.neighbourIpv6, 22],
    ["neighbour_v4", t.neighbourIpv4, 22],
    ["host_ssh_v4", t.nodeIpv4, 22],
    ["host_api_v4", t.nodeIpv4, 8006],
    ["host_ssh_v6", t.nodeIpv6, 22],
    ["host_gateway_v6", "fe80::1%eth0", 22],
    ["mail_25_v4", "1.1.1.1", 25],
    ["mail_465_v4", "1.1.1.1", 465],
    ["mail_25_v6", OUTSIDE_IPV6, 25],
    ["mail_465_v6", OUTSIDE_IPV6, 465],
    ["metadata", "169.254.169.254", 80],
    ["private_v4", PRIVATE_TARGET, 22],
    ["private_mgmt", t.mgmtPrivateIp ?? PRIVATE_TARGET, 22],
    ["private_v6", "fd00::1", 22],
    ["other_iface_v4", PROBE_TARGET.ipv4, 22],
    ["other_iface_v6", PROBE_TARGET.ipv6, 22],
  ];
  return [
    `reach() { if timeout 3 bash -c "</dev/tcp/$1/$2" 2>/dev/null; then echo yes; else echo no; fi; }`,
    ...attempts.map(([name, host, port]) => `echo "${name}=$(reach ${q(host)} ${port})"`),
    // The /64 looks on-link to a container, so these go by the gateway to reach the host's rules at all.
    `ip -6 route replace ${q(`${t.neighbourIpv6}/128`)} via fe80::1 dev eth0`,
    `ip -6 route replace ${q(`${t.nodeIpv6}/128`)} via fe80::1 dev eth0`,
    `echo "neighbour_v6_routed=$(reach ${q(t.neighbourIpv6)} 22)"`,
    `echo "host_ssh_v6_routed=$(reach ${q(t.nodeIpv6)} 22)"`,
    `echo "host_api_v6_routed=$(reach ${q(t.nodeIpv6)} 8006)"`,
    `ip -6 route del ${q(`${t.neighbourIpv6}/128`)} via fe80::1 dev eth0`,
    `ip -6 route del ${q(`${t.nodeIpv6}/128`)} via fe80::1 dev eth0`,
    `ip addr add ${TEST_IPV4.spoof}/32 dev eth0`,
    `ping -c 1 -W 1 -I ${TEST_IPV4.spoof} 1.1.1.1 >/dev/null 2>&1 || true`,
    `ip addr del ${TEST_IPV4.spoof}/32 dev eth0`,
    `ip -6 addr add ${q(`${t.neighbourIpv6}/128`)} dev eth0 nodad`,
    `ping -6 -c 1 -W 1 -I ${q(t.neighbourIpv6)} ${OUTSIDE_IPV6} >/dev/null 2>&1 || true`,
    `ip -6 addr del ${q(`${t.neighbourIpv6}/128`)} dev eth0`,
  ].join("\n");
}

/** Sends from a MAC that isn't the container's, then puts its own back. */
export function isolationMacScript(): string {
  return `own=$(cat /sys/class/net/eth0/address)
ip link set dev eth0 address 02:00:00:5e:53:01
ping -6 -c 2 -W 1 ${OUTSIDE_IPV6} >/dev/null 2>&1 || true
ip link set dev eth0 address "$own"
echo "mac_restored=yes"`;
}

// ── After a restart ──────────────────────────────────────────────────
// A restart recreates the veth and empties the container's neighbour table. A spoofed packet sent
// then first needs the gateway's MAC, and that ARP request carries the spoofed sender, so spoof_arp
// stops it before spoof_ip4 ever sees an IPv4 packet. So the gateway is learned from the real
// address first, and the ARP case is proved on its own.

const RESTART_COUNTERS = ["spoof_ip4", "spoof_arp", "spoof_mac", "spoof_ip6", "bad_frame", "unknown_port"];

/** What the container's network looks like, between markers, so a failure can show it. */
const networkEvidence = `echo "addr<<"; ip -br addr; echo ">>addr"
echo "route<<"; ip -4 route; ip -6 route; echo ">>route"
echo "neigh<<"; ip neigh show dev eth0; echo ">>neigh"`;

/** Waits for the address and default route, then learns the gateway's MAC from the real address. */
export function restartReadyScript(ownIpv4: string): string {
  return `ready=no
for _ in $(seq 1 30); do
  if ip -4 -o addr show dev eth0 | grep -qF ${q(` ${ownIpv4}/32 `)} && ip -4 route show default | grep -qF ${q(`via ${HETZNER_GATEWAY4}`)}; then ready=yes; break; fi
  sleep 2
done
echo "ipv4_ready=$ready"
# The gateway can't reply to an unrouted test address, so what counts is that its MAC was learned.
if ping -c 1 -W 2 -I ${q(ownIpv4)} ${HETZNER_GATEWAY4} >/dev/null 2>&1; then echo "gateway_ping=replied"; else echo "gateway_ping=no-reply"; fi
learned=no
for _ in $(seq 1 10); do
  if ip neigh show ${HETZNER_GATEWAY4} dev eth0 | grep -q lladdr; then learned=yes; break; fi
  sleep 0.5
done
echo "gateway_learned=$learned"
${networkEvidence}`;
}

/** A spoofed IPv4 source with the gateway's MAC already known: spoof_ip4 must stop it. */
export function restartSpoofScript(): string {
  return `ip addr add ${TEST_IPV4.spoof}/32 dev eth0; echo "add_exit=$?"
ping -c 1 -W 1 -I ${TEST_IPV4.spoof} 1.1.1.1 >/dev/null 2>&1
ip addr del ${TEST_IPV4.spoof}/32 dev eth0; echo "del_exit=$?"
${networkEvidence}`;
}

/** The gateway forgotten, so the spoofed source has to ask for it by ARP: spoof_arp must stop that. */
export function restartArpSpoofScript(): string {
  return `ip neigh flush dev eth0; echo "flush_exit=$?"
ip addr add ${TEST_IPV4.spoof}/32 dev eth0; echo "add_exit=$?"
ping -c 1 -W 1 -I ${TEST_IPV4.spoof} ${HETZNER_GATEWAY4} >/dev/null 2>&1
ip addr del ${TEST_IPV4.spoof}/32 dev eth0; echo "del_exit=$?"
${networkEvidence}`;
}

/** The text between name<< and >>name. */
export function block(output: string, name: string): string {
  return new RegExp(`${name}<<\\n([\\s\\S]*?)\\n?>>${name}`).exec(output)?.[1].trim() ?? "";
}

/** Every relevant counter at each read, and the container's addresses, routes and neighbours. */
export function restartEvidence(reads: [string, Record<string, number>][], output: string): string[] {
  const counters = RESTART_COUNTERS.map((name) => `${name} ${reads.map(([, r]) => r[name] ?? 0).join(" → ")}`);
  return [
    `counters (${reads.map(([when]) => when).join(" → ")}): ${counters.join(", ")}`,
    `ip addr: ${block(output, "addr").replace(/\s*\n\s*/g, " | ") || "(none)"}`,
    `ip route: ${block(output, "route").replace(/\s*\n\s*/g, " | ") || "(none)"}`,
    `ip neigh: ${block(output, "neigh").replace(/\s*\n\s*/g, " | ") || "(none)"}`,
  ];
}

/** Before any spoof: the address and route are back, and the gateway was learned from the real address. */
export function checkRestartReady(ready: Record<string, string>): string[] {
  const problems: string[] = [];
  if (ready.ipv4_ready !== "yes") problems.push("after the restart the container never got its IPv4 address and default route back");
  if (ready.gateway_learned !== "yes") problems.push("after the restart the container never learned the gateway from its own address");
  return problems;
}

/** Ready, then each spoof stopped by the rule meant for it. A rule that stopped applying fails here. */
export function checkRestartProof(
  ready: Record<string, string>,
  reads: { before: Record<string, number>; mid: Record<string, number>; after: Record<string, number> },
  spoof: Record<string, string>,
  arp: Record<string, string>
): string[] {
  const problems = checkRestartReady(ready);
  if (problems.length) return problems;
  if (spoof.add_exit !== "0") problems.push(`ip addr add for the spoofed address failed (exit ${spoof.add_exit ?? "unknown"})`);
  else if (!((reads.mid.spoof_ip4 ?? 0) > (reads.before.spoof_ip4 ?? 0))) problems.push("after a restart, a spoofed IPv4 source wasn't stopped by spoof_ip4");
  if (arp.add_exit !== "0") problems.push(`ip addr add for the ARP test failed (exit ${arp.add_exit ?? "unknown"})`);
  else if (!((reads.after.spoof_arp ?? 0) > (reads.mid.spoof_arp ?? 0))) problems.push("after a restart, an ARP request with a spoofed sender wasn't stopped by spoof_arp");
  return problems;
}

/** Collected from inside a test container when step 4 fails. Addresses and state, no secrets. */
export function containerDiagnosticsScript(): string {
  return `echo "--- ip -br addr"; ip -br addr
echo "--- ip -br link"; ip -br link
echo "--- ip -4 route"; ip -4 route
echo "--- ip -6 route"; ip -6 route
echo "--- ip neigh"; ip neigh
echo "--- ip -6 neigh"; ip -6 neigh
echo "--- system"; systemctl is-system-running 2>&1
echo "--- systemd-networkd"; journalctl -b -u systemd-networkd -n 40 --no-pager 2>&1`;
}

/** "name=number" lines from isolation-status. */
export function parseIsolationStatus(output: string): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const [, name, value] of output.matchAll(/^([a-z0-9_]+)=(\d+)$/gm)) counters[name] = Number(value);
  return counters;
}

const MUST_RISE = ["to_neighbour_l2", "to_neighbour_l3", "to_host", "to_other_iface", "to_private", "to_mail", "to_metadata", "spoof_ip4", "spoof_ip6", "spoof_mac"];

/** Each attempt failed, and the rule meant to stop it is the one that did. */
export function checkIsolationProof(before: Record<string, number>, after: Record<string, number>, attempts: Record<string, string>): string[] {
  const problems: string[] = [];
  if (after.tables !== 2) problems.push(`the isolation tables aren't both loaded (${after.tables ?? 0} of 2)`);
  const names = Object.keys(attempts).filter((k) => k !== "mac_restored");
  if (names.length === 0) problems.push("no attempts came back from the test container");
  for (const name of names) if (attempts[name] !== "no") problems.push(`the test container got through: ${name}`);
  for (const name of MUST_RISE) {
    if (!((after[name] ?? 0) > (before[name] ?? 0))) problems.push(`rule ${name} stopped nothing`);
  }
  return problems;
}

export function containerOutboundScript(ipv4: boolean): string {
  // Ping first: an IPv6-only container can't reach the node's IPv4 resolvers, so names may not work there.
  const get = (v: 4 | 6) =>
    `(ping -${v} -c 2 -W 3 ${v === 6 ? IPV6_TARGETS[0] : "1.1.1.1"} >/dev/null 2>&1 || curl -${v} -fsS -o /dev/null -m 15 ${OUTBOUND_URL} 2>/dev/null || wget -${v} -q -O /dev/null -T 15 ${OUTBOUND_URL}) && echo ok || echo fail`;
  return [`echo "out6=$(${get(6)})"`, ipv4 ? `echo "out4=$(${get(4)})"` : `echo "out4=skipped"`].join("\n");
}
