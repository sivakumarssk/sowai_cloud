#!/usr/bin/env bash
# One-time Proxmox host setup for Sowsi Cloud container networking. Works on
# any node: the node's IPv6 /64 and the provisioning key come from the
# environment. scripts/node/install-node.ts runs it on new nodes (without
# PROVISIONING_PUBKEY: it installs that key itself, last). By hand, on a node install-node.ts
# didn't build:
#
#   ssh root@<node ip> \
#     'IPV6_SUBNET=<the node's /64> MGMT_IP=2.31.11.105 PROVISIONING_PUBKEY="ssh-ed25519 AAAA… sowsi-provisioning" bash -s' \
#     < scripts/proxmox-host-setup.sh
#
# ISOLATION_ONLY=1 MGMT_IP=… bash -s  touches only the isolation pieces, for a node set up by
# hand: it backs up what it replaces, writes /root/sowsi-isolation-rollback.sh and arms it to
# run in 10 minutes unless stopped with: systemctl stop sowsi-isolation-undo.timer
#
# Safe to re-run. Does not modify vmbr0's IPv4 config, so it can't cut off
# your SSH session.
#
# Why a separate routed bridge: Hetzner Cloud only forwards traffic from the
# server's own MAC address, so containers can't sit directly on vmbr0 (which
# is bridged to eth0). Instead they attach to vmbr1, which has no physical
# port, and the host routes each container's Floating IP / IPv6 to it.
set -euo pipefail

# This node's routed /64 without the trailing "::" (Hetzner Console → server → Networking).
ISOLATION_ONLY="${ISOLATION_ONLY:-}"
if [[ -z $ISOLATION_ONLY ]]; then
  IPV6_SUBNET="${IPV6_SUBNET:?set IPV6_SUBNET to the /64 of this node without ::, e.g. 2a01:4f8:1c16:5f1d}"
  IPV6_SUBNET="${IPV6_SUBNET%%::*}"
fi
# sowsi-mgmt-01's public IPv4: the one address allowed to reach :8006.
MGMT_IP="${MGMT_IP:?set MGMT_IP to sowsi-mgmt-01s public IPv4}"
if ! [[ $MGMT_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "MGMT_IP must be an IPv4 address" >&2; exit 2; fi
# Public half of the platform provisioning key (PROVISIONING_SSH_PUBLIC_KEY). Empty = step 8 is skipped.
PROVISIONING_PUBKEY="${PROVISIONING_PUBKEY:-}"

if [[ -z $ISOLATION_ONLY ]]; then
echo "== 1. DNS"
if [[ -L /etc/resolv.conf ]] || ! getent hosts download.proxmox.com >/dev/null; then
  # A plain file: a link into /run is empty after a reboot once DHCP no longer feeds it.
  rm -f /etc/resolv.conf
  printf 'nameserver 185.12.64.1\nnameserver 185.12.64.2\nnameserver 1.1.1.1\noptions timeout:2\n' > /etc/resolv.conf
fi
getent hosts download.proxmox.com >/dev/null && echo "DNS OK" || { echo "DNS still broken — fix /etc/resolv.conf"; exit 1; }

echo "== 2. LXC template"
pveam update >/dev/null
pveam list local | grep -q ubuntu-22.04-standard_22.04-1_amd64.tar.zst \
  || pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst

echo "== 3. IP forwarding"
cat > /etc/sysctl.d/99-sowsi-routing.conf <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
sysctl -q --system
fi

if [[ -n $ISOLATION_ONLY ]]; then
  echo "== Backup and automatic rollback"
  if ! command -v nft >/dev/null; then echo "nft isn't installed: nothing changed. Run: apt-get install -y nftables" >&2; exit 1; fi
  if [[ $(systemctl is-enabled nftables.service 2>/dev/null || true) == enabled ]]; then
    echo "nftables.service is enabled and would flush these rules: nothing changed" >&2
    exit 1
  fi
  BACKUP=/root/sowsi-isolation-backup-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$BACKUP"
  cp -a /usr/local/sbin/sowsi-routes /usr/local/sbin/sowsi-host /etc/systemd/system/sowsi-routes.service "$BACKUP"/
  nft list ruleset > "$BACKUP/ruleset.txt" 2>/dev/null || true
  ufw status verbose > "$BACKUP/ufw.txt" 2>/dev/null || true
  redirects=$(sysctl -n net.ipv4.conf.vmbr1.send_redirects 2>/dev/null || echo 1)
  accept_ra=$(sysctl -n net.ipv6.conf.vmbr1.accept_ra 2>/dev/null || echo 1)
  accept_redirects=$(sysctl -n net.ipv6.conf.vmbr1.accept_redirects 2>/dev/null || echo 1)
  cat > /root/sowsi-isolation-rollback.sh <<EOF
#!/usr/bin/env bash
# Undoes the isolation rollout. Needs no network, so it works from the Hetzner console.
systemctl stop sowsi-isolation-undo.timer 2>/dev/null
systemctl disable --now sowsi-routes.timer 2>/dev/null
rm -f /etc/systemd/system/sowsi-routes.timer /etc/systemd/system/sowsi-routes-sync.service
nft delete table bridge sowsi 2>/dev/null
nft delete table inet sowsi 2>/dev/null
cp -a "$BACKUP/sowsi-routes" "$BACKUP/sowsi-host" /usr/local/sbin/
cp -a "$BACKUP/sowsi-routes.service" /etc/systemd/system/
systemctl unmask nftables.service 2>/dev/null
systemctl daemon-reload
sysctl -qw net.ipv4.conf.vmbr1.send_redirects=$redirects net.ipv6.conf.vmbr1.accept_ra=$accept_ra net.ipv6.conf.vmbr1.accept_redirects=$accept_redirects
/usr/local/sbin/sowsi-routes
echo "rolled back: sowsi tables gone, old scripts restored from $BACKUP"
EOF
  chmod 700 /root/sowsi-isolation-rollback.sh
  systemd-run --on-active=10m --unit=sowsi-isolation-undo /root/sowsi-isolation-rollback.sh
  echo "rollback armed for 10 minutes. To keep this: systemctl stop sowsi-isolation-undo.timer"
fi

echo "== 4. Route sync and isolation rules"
if ! command -v nft >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get -y install nftables; fi
# Debian's unit runs /etc/nftables.conf, which starts with "flush ruleset" and would remove every table.
systemctl mask nftables.service >/dev/null 2>&1 || true
mkdir -p /etc/sowsi
echo "$MGMT_IP" > /etc/sowsi/mgmt-ip
cat > /usr/local/sbin/sowsi-routes <<'SCRIPT'
#!/usr/bin/env bash
# Routes every Sowsi container's public IPs from the host to the routed
# bridge, and isolates containers from each other and from the host.
# Source of truth: the net0 line (hwaddr=, ip=, ip6=) of each container on
# $BRIDGE in /etc/pve/lxc/*.conf. Idempotent; also removes routes and rules
# for containers that no longer exist.
#
#   sowsi-routes                 sync routes and isolation rules
#   sowsi-routes --status        rule counters and nothing else
#   sowsi-routes --report        rules, counters, ports, net0 lines and the rule journal, read only
#   sowsi-routes --probe on|off  a dummy interface, so the installer can prove traffic can't leave by it
set -euo pipefail

BRIDGE=vmbr1
UPLINK=vmbr0
PROTO=250 # tags routes owned by this script
LXC_DIR=${SOWSI_LXC_DIR:-/etc/pve/lxc}
PVE_DIR=${SOWSI_PVE_DIR:-/etc/pve}
STATE_DIR=${SOWSI_STATE_DIR:-/etc/sowsi}
RUN_DIR=${SOWSI_RUN_DIR:-/run/sowsi}
GOOD=$STATE_DIR/rules.last-good.nft
PROBE=sowsiprobe0

have_tables() { nft list table bridge sowsi >/dev/null 2>&1 && nft list table inet sowsi >/dev/null 2>&1; }
load_last_good() { [[ -f $GOOD ]] && nft -f "$GOOD"; }

status() {
  echo "tables=$(nft list tables 2>/dev/null | grep -cE '^table (bridge|inet) sowsi$' || true)"
  for table in "bridge sowsi" "inet sowsi"; do
    # shellcheck disable=SC2086
    nft list counters table $table 2>/dev/null | awk '$1 == "counter" { name = $2 } $1 == "packets" { print name "=" $2 }' || true
  done
}

# Everything a failed proof needs, and nothing secret: -t leaves out set elements (SSH clients' addresses).
report() {
  echo "=== counters"; status
  echo "=== bridge table"; nft -t list table bridge sowsi 2>&1 || true
  echo "=== inet table"; nft -t list table inet sowsi 2>&1 || true
  echo "=== bridge ports"; bridge link show 2>&1 || true
  echo "=== links"; ip -br link 2>&1 || true
  echo "=== addresses"; ip -br addr 2>&1 || true
  echo "=== container routes"; ip -4 route show proto "$PROTO" 2>&1 || true; ip -6 route show proto "$PROTO" 2>&1 || true
  echo "=== net0 lines"
  local conf
  for conf in "$LXC_DIR"/*.conf; do
    [[ -f $conf ]] || continue
    echo "${conf##*/}: $(grep -m1 '^net0:' "$conf" || echo none)"
  done
  echo "=== last good rules"; sha256sum "$GOOD" 2>&1 || true
  echo "=== journal"; journalctl -u sowsi-routes.service -u sowsi-routes-sync.service -n 60 --no-pager 2>&1 || true
}

probe() {
  if [[ $1 == on ]]; then
    ip link show "$PROBE" >/dev/null 2>&1 || ip link add "$PROBE" type dummy
    ip link set "$PROBE" up
    ip -4 route replace 198.19.255.0/24 dev "$PROBE"
    ip -6 route replace 2001:db8:5053::/64 dev "$PROBE"
  else
    ip link del "$PROBE" 2>/dev/null || true
  fi
}

case "${1:-}" in
  "") ;;
  --status) status; exit 0 ;;
  --report) report; exit 0 ;;
  --probe)
    if [[ "${2:-}" != on && "${2:-}" != off ]]; then echo "usage: sowsi-routes --probe on|off" >&2; exit 2; fi
    probe "$2"
    exit 0 ;;
  *) echo "usage: sowsi-routes [--status | --report | --probe on|off]" >&2; exit 2 ;;
esac

mkdir -p "$RUN_DIR" "$STATE_DIR"
exec 9>"$RUN_DIR/lock"
flock 9

# Without the cluster filesystem the container list is empty and means nothing:
# syncing against it would delete every route and rule.
if ! mountpoint -q "$PVE_DIR"; then
  have_tables || load_last_good || echo "isolation: no rules loaded and none saved" >&2
  echo "routes: skipped, $PVE_DIR isn't mounted"
  exit 0
fi

# 128 bits as 32 hex digits, or nothing if it isn't an IPv6 address.
ipv6_hex() {
  local addr=${1,,} head tail g out="" gap=no
  local -a left=() right=()
  [[ $addr =~ ^[0-9a-f:]+$ ]] || return 1
  if [[ $addr == *::* ]]; then
    [[ $addr != *::*::* ]] || return 1
    gap=yes head=${addr%%::*} tail=${addr#*::}
  else
    head=$addr tail=""
  fi
  IFS=: read -ra left <<<"$head"
  IFS=: read -ra right <<<"$tail"
  local missing=$((8 - ${#left[@]} - ${#right[@]}))
  if [[ $gap == yes ]]; then
    if ((missing < 1)); then return 1; fi
  elif ((missing != 0)); then
    return 1
  fi
  for g in "${left[@]}"; do
    [[ $g =~ ^[0-9a-f]{1,4}$ ]] || return 1
    out+=$(printf '%04x' "0x$g")
  done
  for ((g = 0; g < missing; g++)); do out+=0000; done
  for g in "${right[@]}"; do
    [[ $g =~ ^[0-9a-f]{1,4}$ ]] || return 1
    out+=$(printf '%04x' "0x$g")
  done
  echo "$out"
}

valid_ipv4() {
  local a b c d
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  ((10#$a <= 255 && 10#$b <= 255 && 10#$c <= 255 && 10#$d <= 255))
}

# One container's rules, from its VM id and net0 line. Nothing from the line
# reaches the rules until it has passed a check: a line that doesn't is refused,
# so that container gets no chain and its port is dropped.
container_chain() {
  local id=$1 line=$2 mac="" ip4="" ip6="" hex="" field
  local -a fields=()
  [[ $id =~ ^[0-9]{1,9}$ ]] || return 1
  [[ $line != *[$' \t\n"\\;{}']* ]] || return 1
  IFS=, read -ra fields <<<"$line"
  for field in "${fields[@]}"; do
    case $field in
      hwaddr=*) mac=${field#hwaddr=} ;;
      ip=*) ip4=${field#ip=} ;;
      ip6=*) ip6=${field#ip6=} ;;
      firewall=1) return 1 ;; # Proxmox puts a firewall bridge in front, so the port on vmbr1 isn't veth…
    esac
  done
  [[ $mac =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]] || return 1
  mac=${mac,,}
  if [[ -n $ip4 ]]; then
    [[ $ip4 == */32 ]] || return 1
    ip4=${ip4%/32}
    valid_ipv4 "$ip4" || return 1
  fi
  if [[ -n $ip6 ]]; then
    [[ $ip6 =~ ^[0-9a-fA-F:]+/[0-9]{1,3}$ ]] || return 1
    ip6=${ip6%/*}
    hex=$(ipv6_hex "$ip6") || return 1
  fi
  [[ -n $ip4 || -n $ip6 ]] || return 1

  echo "  chain ct$id {"
  echo "    ether saddr != $mac counter name spoof_mac drop"
  if [[ -n $ip4 && -n $ip6 ]]; then
    echo "    ether type != { arp, ip, ip6 } counter name bad_frame drop"
  elif [[ -n $ip4 ]]; then
    echo "    ether type != { arp, ip } counter name bad_frame drop"
  else
    echo "    ether type != ip6 counter name bad_frame drop"
  fi
  if [[ -n $ip4 ]]; then
    echo "    ether type arp arp saddr ether != $mac counter name spoof_arp drop"
    echo "    ether type arp arp saddr ip != { $ip4, 0.0.0.0 } counter name spoof_arp drop"
    echo "    ether type ip ip saddr != $ip4 counter name spoof_ip4 drop"
    echo "    udp sport 67 counter name spoof_nd drop"
  fi
  if [[ -n $ip6 ]]; then
    echo "    ether type ip6 ip6 saddr != { ${ip6,,}, fe80::/10, :: } counter name spoof_ip6 drop"
    echo "    ether type ip6 ip6 saddr fe80::1 counter name spoof_ip6 drop"
    echo "    ether type ip6 ip6 saddr :: meta l4proto != ipv6-icmp counter name spoof_ip6 drop"
    echo "    ip6 saddr :: icmpv6 type != { nd-neighbor-solicit, mld-listener-report, mld2-listener-report } counter name spoof_ip6 drop"
    echo "    icmpv6 type { nd-router-advert, nd-redirect } counter name spoof_nd drop"
    # An advertisement may claim only this container's own address or a link-local one.
    echo "    icmpv6 type nd-neighbor-advert @th,64,128 != 0x$hex @th,64,10 != 0x3fa counter name spoof_nd drop"
    echo "    icmpv6 type nd-neighbor-advert @th,64,128 0xfe800000000000000000000000000001 counter name spoof_nd drop"
    echo "    udp sport 547 counter name spoof_nd drop"
  fi
  echo "    accept"
  echo "  }"
}

# Where forwarded traffic may leave: vmbr0, or the card if the boot guard has dropped the bridge.
uplinks() {
  {
    echo "$UPLINK"
    ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }'
    ip -6 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1) }'
  } | sort -u | while read -r dev; do
    if [[ $dev != "$BRIDGE" && $dev =~ ^[a-zA-Z0-9._-]{1,15}$ ]]; then printf '"%s", ' "$dev"; fi
  done
}

re4=',ip=([0-9.]+)/32'
re6=',ip6=([0-9a-fA-F:]+)/'
declare -A want4=() want6=()
chains="" ports="" skipped="" count=0
shopt -s nullglob
for conf in "$LXC_DIR"/*.conf; do
  # The first net0 line is the live config; later ones belong to snapshots.
  net0=$(grep -m1 '^net0:' "$conf" || true)
  [[ $net0 == *"bridge=$BRIDGE"* ]] || continue
  if [[ $net0 =~ $re4 ]]; then want4[${BASH_REMATCH[1]}]=1; fi
  if [[ $net0 =~ $re6 ]]; then want6[${BASH_REMATCH[1]}]=1; fi
  id=${conf##*/}
  id=${id%.conf}
  if chain=$(container_chain "$id" "${net0#net0: }"); then
    chains+=$chain$'\n'
    ports+="\"veth${id}i0\" : jump ct$id, "
    count=$((count + 1))
  else
    skipped+=" $id"
  fi
done

for ip in "${!want4[@]}"; do
  ip route replace "$ip/32" dev "$BRIDGE" proto "$PROTO"
done
for ip in "${!want6[@]}"; do
  ip -6 route replace "$ip/128" dev "$BRIDGE" proto "$PROTO"
  # Answer neighbor discovery for the container on the uplink, in case
  # Hetzner treats the /64 as on-link rather than routed.
  ip -6 neigh replace proxy "$ip" dev "$UPLINK" 2>/dev/null || ip -6 neigh add proxy "$ip" dev "$UPLINK" 2>/dev/null || true
done

# Remove routes for containers that are gone.
while read -r dst _; do
  addr=${dst%/32}
  [[ -n ${want4[$addr]:-} ]] || ip route del "$addr/32" proto "$PROTO"
done < <(ip -4 route show proto "$PROTO")
while read -r dst _; do
  addr=${dst%/128}
  if [[ -z ${want6[$addr]:-} ]]; then
    ip -6 route del "$addr/128" proto "$PROTO"
    ip -6 neigh del proxy "$addr" dev "$UPLINK" 2>/dev/null || true
  fi
done < <(ip -6 route show proto "$PROTO")

# vmbr1 doesn't exist yet when /etc/sysctl.d is applied at boot, so these are set here.
sysctl -qw "net.ipv4.conf.$BRIDGE.send_redirects=0" "net.ipv6.conf.$BRIDGE.accept_ra=0" "net.ipv6.conf.$BRIDGE.accept_redirects=0" 2>/dev/null || true

mgmt=""
if [[ -f $STATE_DIR/mgmt-ip ]]; then read -r mgmt <"$STATE_DIR/mgmt-ip" || true; fi
if ! valid_ipv4 "$mgmt"; then
  # Never guess: a wrong address here would lock out management.
  echo "isolation: no valid management IP in $STATE_DIR/mgmt-ip, so 8006 and the SSH limit are left to ufw" >&2
  mgmt=""
fi
allowed=$(uplinks)

rules=$RUN_DIR/rules.nft
{
  echo "# Generated by sowsi-routes. Replaces both tables in one transaction."
  echo "table bridge sowsi"
  echo "delete table bridge sowsi"
  echo "table inet sowsi"
  echo "delete table inet sowsi"
  echo
  echo "table bridge sowsi {"
  for name in spoof_mac spoof_ip4 spoof_ip6 spoof_arp spoof_nd bad_frame unknown_port to_neighbour_l2; do
    echo "  counter $name { }"
  done
  echo "  chain from_ports {"
  echo "    type filter hook prerouting priority -200; policy accept;"
  echo "    ibrname != \"$BRIDGE\" accept"
  if [[ -n $ports ]]; then echo "    iifname vmap { ${ports%, } }"; fi
  # No chain, no traffic: a new container is cut off until the sync that follows its creation.
  echo "    iifname \"veth*\" counter name unknown_port drop"
  echo "    iifname \"fwpr*\" counter name unknown_port drop"
  echo "  }"
  echo "  chain between_ports {"
  echo "    type filter hook forward priority -200; policy accept;"
  echo "    ibrname \"$BRIDGE\" counter name to_neighbour_l2 drop"
  echo "  }"
  printf '%s' "$chains"
  echo "}"
  echo
  echo "table inet sowsi {"
  for name in to_host to_neighbour_l3 to_other_iface to_private to_mail to_metadata api_refused ssh_limited; do
    echo "  counter $name { }"
  done
  echo "  set ssh4 { type ipv4_addr; flags dynamic, timeout; timeout 2m; }"
  echo "  set ssh6 { type ipv6_addr; flags dynamic, timeout; timeout 2m; }"
  echo "  chain forwarded {"
  echo "    type filter hook forward priority -10; policy accept;"
  echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" counter name to_neighbour_l3 drop"
  # Forwarded traffic may leave by the public uplink only, never into a private network.
  echo "    iifname \"$BRIDGE\" oifname != { ${allowed%, } } counter name to_other_iface drop"
  echo "    iifname \"$BRIDGE\" tcp dport { 25, 465 } counter name to_mail drop"
  echo "    iifname \"$BRIDGE\" ip daddr 169.254.0.0/16 counter name to_metadata drop"
  # Hetzner's gateway sits in 172.16.0.0/12, and it's the one private address containers may use.
  echo "    iifname \"$BRIDGE\" ip daddr 172.31.1.1 accept"
  echo "    iifname \"$BRIDGE\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } counter name to_private drop"
  echo "    iifname \"$BRIDGE\" ip6 daddr fc00::/7 counter name to_private drop"
  echo "  }"
  echo "  chain from_container {"
  echo "    ct state established,related accept"
  echo "    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, mld-listener-report, mld2-listener-report } accept"
  echo "    counter name to_host drop"
  echo "  }"
  echo "  chain host_input {"
  echo "    type filter hook input priority -10; policy accept;"
  echo "    iifname \"$BRIDGE\" jump from_container"
  if [[ -n $mgmt ]]; then
    echo "    iifname != \"lo\" ip saddr != $mgmt tcp dport 8006 counter name api_refused drop"
    echo "    iifname != \"lo\" meta nfproto ipv6 tcp dport 8006 counter name api_refused drop"
    echo "    ip saddr $mgmt tcp dport 22 accept"
    echo "    tcp dport 22 ct state new add @ssh4 { ip saddr limit rate over 10/minute burst 20 packets } counter name ssh_limited drop"
    echo "    tcp dport 22 ct state new add @ssh6 { ip6 saddr & ffff:ffff:ffff:ffff:: limit rate over 10/minute burst 20 packets } counter name ssh_limited drop"
  fi
  echo "  }"
  echo "}"
  if [[ -n ${SOWSI_NFT_TEST_APPEND:-} ]]; then echo "$SOWSI_NFT_TEST_APPEND"; fi
} >"$rules"

failed=""
if have_tables && cmp -s "$rules" "$GOOD"; then
  : # Nothing changed: keep the counters.
elif nft -c -f "$rules" && nft -f "$rules"; then
  cp "$rules" "$GOOD.tmp"
  mv -f "$GOOD.tmp" "$GOOD"
else
  failed=yes
  # The transaction failed, so what's running stays. If that's nothing, as at boot, use the last good rules.
  have_tables || load_last_good || echo "isolation: no rules loaded and none saved" >&2
fi

echo "routes: ${#want4[@]} IPv4, ${#want6[@]} IPv6"
echo "isolation: $count containers${skipped:+, refused:$skipped}${failed:+, RULES NOT LOADED}"
if [[ -n $failed ]]; then exit 1; fi
SCRIPT
chmod 755 /usr/local/sbin/sowsi-routes

if [[ -z $ISOLATION_ONLY ]]; then
echo "== 5. Routed bridge vmbr1"
if ! grep -q '^auto vmbr1' /etc/network/interfaces; then
  cat >> /etc/network/interfaces <<EOF

# Sowsi Cloud: routed bridge for customer containers (no physical port).
# Containers use gateway 172.31.1.1 (answered via proxy ARP) and fe80::1.
auto vmbr1
iface vmbr1 inet manual
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up sysctl -qw net.ipv4.conf.vmbr1.proxy_arp=1
    post-up sysctl -qw net.ipv6.conf.vmbr0.proxy_ndp=1
    post-up ip -6 addr replace ${IPV6_SUBNET}::1/64 dev vmbr0
    post-up ip -6 route replace default via fe80::1 dev vmbr0
    post-up /usr/local/sbin/sowsi-routes || true

iface vmbr1 inet6 static
    address fe80::1/64
EOF
fi
ifup vmbr1
fi

echo "== 6. Re-apply routes and rules at boot, and every 5 minutes"
cat > /etc/systemd/system/sowsi-routes.service <<'EOF'
[Unit]
Description=Sowsi Cloud container routes and isolation rules
After=network-online.target pve-cluster.service
Before=pve-guests.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sowsi-routes
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
# A separate unit: a timer can't re-run a oneshot that stays active.
cat > /etc/systemd/system/sowsi-routes-sync.service <<'EOF'
[Unit]
Description=Sowsi Cloud container routes and isolation rules, kept in place
After=sowsi-routes.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sowsi-routes
EOF
cat > /etc/systemd/system/sowsi-routes.timer <<'EOF'
[Unit]
Description=Put Sowsi Cloud's isolation rules back if anything removed them

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Unit=sowsi-routes-sync.service

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sowsi-routes.service
systemctl enable --now sowsi-routes.timer

echo "== 7. Host command dispatcher (the only thing the provisioning key may run)"
cat > /usr/local/sbin/sowsi-host <<'SCRIPT'
#!/usr/bin/env bash
# Forced command for the Sowsi provisioning SSH key. Only these are allowed:
#   routes | sowsi-routes          re-sync container routes and isolation rules
#   isolation-status               isolation rule counters
#   isolation-report               isolation rules, counters, ports and their journal, for a failed proof
#   isolation-probe on|off         a dummy interface, for the installer's proof
#   mount-volume <hetzner-id>      mount an attached Hetzner Volume and register it as Proxmox storage
#   unmount-volume <hetzner-id>    unregister + unmount it (refused while any disk is on it)
#   authorized-keys                root's authorized keys as fingerprints, never the keys
set -euo pipefail
if [[ "${SSH_ORIGINAL_COMMAND:-}" == *$'\n'* ]]; then echo "one line only" >&2; exit 2; fi
read -r cmd arg extra <<<"${SSH_ORIGINAL_COMMAND:-routes}"
if [[ -n "${extra:-}" ]]; then echo "too many arguments" >&2; exit 2; fi
no_arguments() { if [[ -n "${arg:-}" ]]; then echo "too many arguments" >&2; exit 2; fi; }
case "$cmd" in
  routes|sowsi-routes) no_arguments; exec /usr/local/sbin/sowsi-routes ;;
  isolation-status) no_arguments; exec /usr/local/sbin/sowsi-routes --status ;;
  isolation-report) no_arguments; exec /usr/local/sbin/sowsi-routes --report ;;
  isolation-probe)
    if [[ "${arg:-}" != on && "${arg:-}" != off ]]; then echo "invalid probe" >&2; exit 2; fi
    exec /usr/local/sbin/sowsi-routes --probe "$arg" ;;
  authorized-keys)
    no_arguments
    # sshd reads both files. The line count catches anything ssh-keygen can't read.
    keys=$(mktemp)
    cat /root/.ssh/authorized_keys /root/.ssh/authorized_keys2 2>/dev/null > "$keys" || true
    echo "lines=$(grep -cvE '^[[:space:]]*(#|$)' "$keys" || true)"
    # Size, fingerprint and type: not the comment, which is free text.
    ssh-keygen -lf "$keys" 2>/dev/null | awk '{print "key=" $1, $2, $NF}' || true
    rm -f "$keys"
    # Proxmox's own key for this node, derived from the private half that lives here.
    echo "node_key=$(ssh-keygen -y -f /root/.ssh/id_rsa 2>/dev/null | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || true)"
    exit 0 ;;
  mount-volume|unmount-volume)
    if ! [[ "${arg:-}" =~ ^[0-9]{1,12}$ ]]; then echo "invalid volume id" >&2; exit 2; fi ;;
  *) echo "command not allowed: $cmd" >&2; exit 2 ;;
esac
logger -t sowsi-host "$cmd $arg"

id=$arg
dev="/dev/disk/by-id/scsi-0HC_Volume_$id"
mnt="/mnt/sowsi-vol-$id"
storage="sowsi-vol-$id"

if [[ $cmd == mount-volume ]]; then
  for _ in $(seq 1 30); do [[ -b $dev ]] && break; sleep 2; done
  if [[ ! -b $dev ]]; then echo "device $dev not found — is the volume attached to this server?" >&2; exit 1; fi
  fstype=$(blkid -o value -s TYPE "$dev" || true)
  if [[ -z $fstype ]]; then mkfs.ext4 -q -F "$dev"; fstype=ext4; fi
  if [[ $fstype != ext4 ]]; then echo "unexpected filesystem $fstype on $dev" >&2; exit 1; fi
  uuid=$(blkid -o value -s UUID "$dev")
  mkdir -p "$mnt"
  grep -q "^UUID=$uuid " /etc/fstab || echo "UUID=$uuid $mnt ext4 discard,nofail,defaults 0 2" >> /etc/fstab
  mountpoint -q "$mnt" || mount "$mnt"
  pvesm status --storage "$storage" >/dev/null 2>&1 \
    || pvesm add dir "$storage" --path "$mnt" --content rootdir,images --is_mountpoint yes
  echo "OK storage=$storage path=$mnt"
else
  if pvesm status --storage "$storage" >/dev/null 2>&1; then
    if [[ -n "$(pvesm list "$storage" | tail -n +2)" ]]; then echo "storage $storage still holds disks — not removing" >&2; exit 1; fi
    pvesm remove "$storage"
  fi
  if mountpoint -q "$mnt"; then umount "$mnt"; fi
  if [[ -b $dev ]]; then
    uuid=$(blkid -o value -s UUID "$dev" || true)
    if [[ -n $uuid ]]; then sed -i "\#^UUID=$uuid #d" /etc/fstab; fi
  fi
  rmdir "$mnt" 2>/dev/null || true
  echo "OK unmounted storage=$storage"
fi
SCRIPT
chmod 755 /usr/local/sbin/sowsi-host

if [[ -z $ISOLATION_ONLY ]]; then
echo "== 8. Provisioning key → restricted to sowsi-host"
if [[ -z $PROVISIONING_PUBKEY ]]; then
  echo "skipped (PROVISIONING_PUBKEY not set)"
else
KEY_BODY=$(awk '{print $2}' <<<"$PROVISIONING_PUBKEY")
AUTH=/root/.ssh/authorized_keys
touch "$AUTH"
TMP=$(mktemp)
# Drop any older line for this key (e.g. restricted to sowsi-routes), then add the current one.
grep -vF "$KEY_BODY" "$AUTH" > "$TMP" || true
echo "restrict,command=\"/usr/local/sbin/sowsi-host\" $PROVISIONING_PUBKEY" >> "$TMP"
# On Proxmox this file is a symlink into /etc/pve: write through it, don't replace it.
cat "$TMP" > "$AUTH"
rm -f "$TMP"
fi

echo "== 9. Container storage holds containers and lists orphaned disks"
# "rootdir": containers can be created on it (a Proxmox installed on Debian
# starts with only iso,vztmpl,backup on "local").
# "images": Proxmox labels a disk "rootdir" only while its container exists; a
# disk left behind by a deleted container is labelled "images". A storage
# without the "images" content type hides those orphans from every listing
# (pvesm list and the API), so the engine's leftover-disk check couldn't see them.
CONTAINER_STORAGE=${CONTAINER_STORAGE:-local}
content=$(pvesh get "/storage/$CONTAINER_STORAGE" --output-format json | sed -n 's/.*"content":"\([^"]*\)".*/\1/p')
was=$content
for type in rootdir images; do
  if [[ ",$content," != *",$type,"* ]]; then content="${content:+$content,}$type"; fi
done
if [[ $content != "$was" ]]; then
  pvesm set "$CONTAINER_STORAGE" --content "$content"
  echo "$CONTAINER_STORAGE content: ${was:-none} → $content"
else
  echo "$CONTAINER_STORAGE already holds rootdir and images ($content)"
fi
fi

echo
echo "== Done"
ip -br link show vmbr1
ip -6 route show default
/usr/local/sbin/sowsi-routes
