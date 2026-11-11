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
# Shared mode: each such container has a private address from here, and leaves by NAT (Stage A).
SHARED=100.64.0.0/10
# The shared IPv4 gateway (Stage B): HAProxy in this container, on a Floating IP of its own.
GATEWAY_VMID=9000
GATEWAY_NAME=sowsi-gateway

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
chains="" ports="" skipped="" count=0 gw4=""
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
    # The gateway is container 9000 named sowsi-gateway, on a public address: never a shared one.
    if [[ $id == "$GATEWAY_VMID" && $(grep -m1 '^hostname:' "$conf" || true) == "hostname: $GATEWAY_NAME" && $net0 =~ $re4 ]]; then
      candidate=${BASH_REMATCH[1]}
      if valid_ipv4 "$candidate" && ! [[ $candidate =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then gw4=$candidate; fi
    fi
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
  for name in to_host to_neighbour_l3 to_other_iface to_private to_mail to_metadata api_refused ssh_limited nat_out shared_in gateway_in gateway_hairpin; do
    echo "  counter $name { }"
  done
  echo "  set ssh4 { type ipv4_addr; flags dynamic, timeout; timeout 2m; }"
  echo "  set ssh6 { type ipv6_addr; flags dynamic, timeout; timeout 2m; }"
  echo "  chain forwarded {"
  echo "    type filter hook forward priority -10; policy accept;"
  # A shared address is never reached from outside: only replies to its own connections come back.
  echo "    iifname != \"$BRIDGE\" ip daddr $SHARED ct state new counter name shared_in drop"
  if [[ -n $gw4 ]]; then
    # The gateway reaches shared-mode containers on 80 and 443 only, and any container reaches the
    # gateway on 80 and 443 (a site calling its own domain). Everything else between ports stays dropped.
    echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" ip saddr $gw4 ip daddr $SHARED tcp dport { 80, 443 } counter name gateway_in accept"
    echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" ip saddr $SHARED ip daddr $gw4 tcp sport { 80, 443 } ct direction reply ct state established accept"
    echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" ip daddr $gw4 tcp dport { 80, 443 } counter name gateway_hairpin accept"
    echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" ip saddr $gw4 tcp sport { 80, 443 } ct direction reply ct state established accept"
  fi
  echo "    iifname \"$BRIDGE\" oifname \"$BRIDGE\" counter name to_neighbour_l3 drop"
  # Forwarded traffic may leave by the public uplink only, never into a private network.
  echo "    iifname \"$BRIDGE\" oifname != { ${allowed%, } } counter name to_other_iface drop"
  echo "    iifname \"$BRIDGE\" tcp dport { 25, 465 } counter name to_mail drop"
  echo "    iifname \"$BRIDGE\" ip daddr 169.254.0.0/16 counter name to_metadata drop"
  # Hetzner's gateway sits in 172.16.0.0/12, and it's the one private address containers may use.
  echo "    iifname \"$BRIDGE\" ip daddr 172.31.1.1 accept"
  echo "    iifname \"$BRIDGE\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, $SHARED } counter name to_private drop"
  echo "    iifname \"$BRIDGE\" ip6 daddr fc00::/7 counter name to_private drop"
  echo "  }"
  # Shared mode: a container's private address leaves as the node's own IPv4, by the uplink only.
  echo "  chain shared_out {"
  echo "    type nat hook postrouting priority srcnat; policy accept;"
  echo "    ip saddr $SHARED oifname { ${allowed%, } } counter name nat_out masquerade"
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
echo "isolation: $count containers${skipped:+, refused:$skipped}${gw4:+, gateway $gw4}${failed:+, RULES NOT LOADED}"
if [[ -n $failed ]]; then exit 1; fi
SCRIPT
chmod 755 /usr/local/sbin/sowsi-routes

if [[ -z $ISOLATION_ONLY ]]; then
echo "== 4b. Shared IPv4 gateway tool"
cat > /usr/local/sbin/sowsi-gateway <<'SCRIPT'
#!/usr/bin/env bash
# The shared IPv4 gateway (Stage B): HAProxy in container 9000, on the gateway's own Floating IP.
# Port 80 is routed by the Host header and port 443 by the TLS name (SNI), still encrypted.
# The route table arrives from sowsi-mgmt-01 as plain data. The config is generated here and
# never taken from outside, and a table with one bad line is refused whole, before anything changes.
#
#   sowsi-gateway status            facts about the gateway, read only
#   sowsi-gateway sync <version>    the whole route table on stdin, one route per line:
#                                     <hostname> <service key> <backend IPv4> <PROXY protocol 0|1>
#   sowsi-gateway install           HAProxy into the container, no logins, an empty table (the installer, as root)
set -euo pipefail

VMID=9000
NAME=sowsi-gateway
BRIDGE=vmbr1
LXC_DIR=${SOWSI_LXC_DIR:-/etc/pve/lxc}
STATE=${SOWSI_GATEWAY_STATE:-/etc/sowsi/gateway}
RUN_DIR=${SOWSI_RUN_DIR:-/run/sowsi}
# Inside the container: one folder per version, and "current" pointing at the live one.
CT_DIR=/etc/haproxy/sowsi
MAX_BYTES=1048576
MAX_LINES=5000
PROBE_HOST=sowsi-probe.invalid

refuse() { echo "refused: $*" >&2; exit 2; }
die() { echo "gateway: $*" >&2; exit 1; }
# Says what it was given, quoted: a stray carriage return (a command kept in a Windows file) shows as $'\r'.
usage() { echo "usage: sowsi-gateway status | sync <version> | install (got:$(printf ' %q' "${ARGS[@]}"))" >&2; exit 2; }
# fd 9 is this script's lock: nothing run in the container may hold it, or the next sync waits forever.
ct() { pct exec "$VMID" -- "$@" 9>&-; }
push() { pct push "$VMID" "$1" "$2" --perms 0644 9>&-; }
# What the container says is printed as one plain word: it can't add a line or a field.
clean() { LC_ALL=C tr -cd 'A-Za-z0-9._:/+,-' | head -c 80; }

# The gateway's own address: container 9000 named sowsi-gateway, with a /32 IPv4 on the bridge.
gateway_ipv4() {
  local conf=$LXC_DIR/$VMID.conf net0
  [[ -f $conf ]] || return 1
  [[ $(grep -m1 '^hostname:' "$conf" || true) == "hostname: $NAME" ]] || return 1
  net0=$(grep -m1 '^net0:' "$conf" || true)
  [[ $net0 == *"bridge=$BRIDGE"* && $net0 =~ ,ip=([0-9.]+)/32 ]] || return 1
  echo "${BASH_REMATCH[1]}"
}

# 100.64.0.0/10, written the one way net0 writes it (no leading zeros).
shared_ipv4() {
  [[ $1 =~ ^100\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  ((BASH_REMATCH[1] >= 64 && BASH_REMATCH[1] <= 127 && BASH_REMATCH[2] <= 255 && BASH_REMATCH[3] <= 255))
}

# Lowercase labels of 1-63 characters, at most 253 in all, and a real top-level part. No wildcard.
valid_host() {
  local h=$1 label
  local -a labels=()
  ((${#h} <= 253)) || return 1
  [[ $h =~ ^[a-z0-9.-]+$ && $h == *.* && $h != .* && $h != *. && $h != *..* ]] || return 1
  IFS=. read -ra labels <<<"$h"
  for label in "${labels[@]}"; do
    [[ $label =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  done
  [[ ${labels[-1]} =~ ^[a-z]{2,63}$ || ${labels[-1]} =~ ^xn--[a-z0-9-]{1,59}$ ]]
}

# Shared-mode addresses of this node's containers: a route may only point at one of these.
declare -A here=()
node_backends() {
  local f id net0 ip
  for f in "$LXC_DIR"/*.conf; do
    [[ -f $f ]] || continue
    id=${f##*/}
    id=${id%.conf}
    [[ $id != "$VMID" ]] || continue
    net0=$(grep -m1 '^net0:' "$f" || true)
    [[ $net0 == *"bridge=$BRIDGE"* && $net0 =~ ,ip=([0-9.]+)/32 ]] || continue
    # Copied first: shared_ipv4 runs a match of its own.
    ip=${BASH_REMATCH[1]}
    if shared_ipv4 "$ip"; then here[$ip]=1; fi
  done
}

# stdin -> $work/routes, every line checked. One bad line refuses the whole table.
read_table() {
  local raw=$work/table.in line n=0 host key ip proxy
  local -A hosts=() key_ip=() ip_key=()
  head -c $((MAX_BYTES + 1)) >"$raw"
  (($(wc -c <"$raw") <= MAX_BYTES)) || refuse "the table is over $MAX_BYTES bytes"
  # Lowercase letters, digits, dots, dashes, spaces and newlines: nothing else, anywhere.
  (($(LC_ALL=C tr -d 'a-z0-9. \n-' <"$raw" | wc -c) == 0)) || refuse "the table has a character other than a-z 0-9 . - space and newline"
  : >"$work/routes"
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    ((n <= MAX_LINES)) || refuse "the table is over $MAX_LINES lines"
    [[ $line =~ ^([a-z0-9.-]+)\ ([a-z0-9]{16})\ ([0-9.]+)\ ([01])$ ]] || refuse "line $n isn't: hostname key ipv4 0|1"
    host=${BASH_REMATCH[1]} key=${BASH_REMATCH[2]} ip=${BASH_REMATCH[3]} proxy=${BASH_REMATCH[4]}
    valid_host "$host" || refuse "line $n: not a hostname"
    [[ -z ${hosts[$host]:-} ]] || refuse "line $n: $host is listed twice"
    shared_ipv4 "$ip" || refuse "line $n: the backend isn't a shared-mode address"
    [[ -n ${here[$ip]:-} ]] || refuse "line $n: no container on this node has $ip"
    [[ -z ${key_ip[$key]:-} || ${key_ip[$key]} == "$ip" ]] || refuse "line $n: service $key has two addresses"
    [[ -z ${ip_key[$ip]:-} || ${ip_key[$ip]} == "$key" ]] || refuse "line $n: $ip belongs to two services"
    hosts[$host]=1 key_ip[$key]=$ip ip_key[$ip]=$key
    echo "$host $key $ip $proxy" >>"$work/routes"
  done <"$raw"
}

# $work/routes -> haproxy.cfg and the two maps in $work/out, for version $1.
render() {
  local v=$1 dir=$CT_DIR/$1 out=$work/out host key ip proxy name
  local -A http=() tls=()
  mkdir -p "$out"
  : >"$out/http.map"
  : >"$out/tls.map"
  while read -r host key ip proxy; do
    echo "$host h_$key" >>"$out/http.map"
    if [[ $proxy == 1 ]]; then name=p_$key; else name=t_$key; fi
    echo "$host $name" >>"$out/tls.map"
    http[h_$key]=$ip
    tls[$name]=$ip
  done <"$work/routes"
  {
    cat <<EOF
# Generated by sowsi-gateway, version $v. Every sync replaces it, so don't edit it.
global
  log /dev/log local0 warning
  chroot /var/lib/haproxy
  user haproxy
  group haproxy
  maxconn 5000
  hard-stop-after 1h

defaults
  log global
  maxconn 5000
  timeout connect 5s
  timeout client 60s
  timeout server 300s
  timeout tunnel 1h
  timeout http-request 10s
  timeout queue 30s

# Port 80, by the Host header. An unknown name gets a neutral 404, never a customer's site.
frontend http_in
  bind :80
  mode http
  http-request return status 204 hdr x-sowsi-gateway-version $v if { src 127.0.0.1 } { req.hdr(host) -m str $PROBE_HOST }
  http-request del-header X-Forwarded-For
  http-request del-header Forwarded
  http-request del-header X-Real-IP
  option forwardfor
  use_backend %[req.hdr(host),lower,field(1,:),map($dir/http.map)]
  default_backend unknown_host

# Port 443, by the TLS name, passed through still encrypted. An unknown or missing name is closed.
frontend tls_in
  bind :443
  mode tcp
  tcp-request inspect-delay 5s
  tcp-request content accept if { req.ssl_hello_type 1 }
  use_backend %[req.ssl_sni,lower,map($dir/tls.map)]
  default_backend refuse

backend unknown_host
  mode http
  http-request return status 404 content-type text/plain string "Not found"

backend refuse
  mode tcp
  tcp-request content reject
EOF
    for name in $(printf '%s\n' "${!http[@]}" | sort); do
      printf '\nbackend %s\n  mode http\n  server s %s:80 maxconn 500\n' "$name" "${http[$name]}"
    done
    for name in $(printf '%s\n' "${!tls[@]}" | sort); do
      if [[ $name == p_* ]]; then proxy=" send-proxy-v2"; else proxy=""; fi
      printf '\nbackend %s\n  mode tcp\n  server s %s:443 maxconn 500%s\n' "$name" "${tls[$name]}" "$proxy"
    done
    if [[ -n ${SOWSI_GATEWAY_TEST_APPEND:-} ]]; then echo "$SOWSI_GATEWAY_TEST_APPEND"; fi
  } >"$out/haproxy.cfg"
}

# The version the running HAProxy answers with, asked from inside the container.
live_version() {
  ct curl -s -m 5 -o /dev/null -D - -H "Host: $PROBE_HOST" http://127.0.0.1/ 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "x-sowsi-gateway-version" { print $2 }' | clean || true
}
unknown_host_code() {
  ct curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: unknown.invalid' http://127.0.0.1/ 2>/dev/null | clean || true
}
# The config the running HAProxy was started with: its master's -f, read from /proc in the container.
# A reload re-executes the master with the arguments it started with, so this changes only on a restart.
running_config() {
  local pid
  pid=$(ct systemctl show -p MainPID --value haproxy 2>/dev/null | clean || true)
  [[ $pid =~ ^[1-9][0-9]{0,9}$ ]] || return 0
  ct cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' '\n' | awk 'prev == "-f" { print; exit } { prev = $0 }' | clean || true
}
LIVE_CONFIG=$CT_DIR/current/haproxy.cfg

# Running on our config: a graceful reload. Otherwise (not running, or still on the package's own
# config, as apt starts it at install) only a restart makes it read the unit's CONFIG again.
haproxy_up() {
  if [[ $(ct systemctl is-active haproxy 2>/dev/null | clean || true) == active && $(running_config) == "$LIVE_CONFIG" ]]; then
    ct systemctl reload haproxy
  else
    ct systemctl daemon-reload && ct systemctl restart haproxy
  fi
}

# Serving version $1: on our config, answering with that version, and the neutral 404 for an unknown name.
serving() { # version
  local _
  for _ in $(seq 1 20); do
    if [[ $(running_config) == "$LIVE_CONFIG" && $(live_version) == "$1" && $(unknown_host_code) == 404 ]]; then return 0; fi
    sleep 0.5
  done
  return 1
}

current_version() {
  local v
  v=$(ct readlink "$CT_DIR/current" 2>/dev/null | clean || true)
  if [[ $v =~ ^[0-9]{1,15}$ ]]; then echo "$v"; fi
}

point_at() { # version
  ct ln -sfn "$1" "$CT_DIR/current.new"
  ct mv -Tf "$CT_DIR/current.new" "$CT_DIR/current"
}

# Validated routes -> live: config test first, then swap, reload and prove it, else back to the last good.
apply() {
  local v=$1 prev out f d
  [[ $(pct status "$VMID" 9>&- 2>/dev/null | awk '{ print $2 }' || true) == running ]] || die "container $VMID isn't running: nothing changed"
  render "$v"
  ct mkdir -p "$CT_DIR/$v"
  for f in haproxy.cfg http.map tls.map; do push "$work/out/$f" "$CT_DIR/$v/$f"; done
  if ! out=$(ct haproxy -c -f "$CT_DIR/$v/haproxy.cfg" 2>&1); then
    ct rm -rf "$CT_DIR/$v" || true
    echo "$out" | LC_ALL=C tr -cd '[:print:]\n' | tail -5 >&2
    die "version $v failed HAProxy's config test: nothing changed"
  fi
  prev=$(current_version)
  point_at "$v"
  if haproxy_up && serving "$v"; then
    mkdir -p "$STATE"
    cp "$work/routes" "$STATE/table.tmp"
    mv -f "$STATE/table.tmp" "$STATE/table"
    echo "$v" >"$STATE/version.tmp"
    mv -f "$STATE/version.tmp" "$STATE/version"
    # Keep this version and the one before it; the rest go.
    for d in $(ct ls -1 "$CT_DIR" 2>/dev/null | LC_ALL=C tr -cd '0-9a-z.\n' || true); do
      if [[ $d =~ ^[0-9]{1,15}$ && $d != "$v" && $d != "${prev:-}" ]]; then ct rm -rf "$CT_DIR/$d" || true; fi
    done
    logger -t sowsi-gateway "version $v: $(wc -l <"$work/routes") routes" 2>/dev/null || true
    echo "gateway: version $v, $(wc -l <"$work/routes") routes"
    return 0
  fi
  local run_cfg run_v
  run_cfg=$(running_config) run_v=$(live_version)
  if [[ -n $prev ]]; then
    point_at "$prev"
    haproxy_up || true
    ct rm -rf "$CT_DIR/$v" || true
    if serving "$prev"; then die "version $v didn't come up: rolled back to version $prev"; fi
    die "version $v didn't come up, and version $prev isn't serving after the rollback either"
  fi
  die "version $v didn't come up (HAProxy runs ${run_cfg:-nothing}, live version ${run_v:-none}), and there's no earlier version to go back to"
}

lock() {
  mkdir -p "$RUN_DIR"
  exec 9>"$RUN_DIR/gateway.lock"
  flock 9
  work=$(mktemp -d "$RUN_DIR/gateway.XXXXXX")
  trap 'rm -rf "$work"' EXIT
}

applied_version() { if [[ -f $STATE/version ]]; then clean <"$STATE/version"; fi; }

sync_table() {
  local v=$((10#$1)) applied
  lock
  node_backends
  read_table
  applied=$(applied_version)
  if [[ $applied =~ ^[0-9]{1,15}$ ]]; then
    if ((v < applied)); then refuse "version $v is older than the applied version $applied"; fi
    if ((v == applied)); then
      if cmp -s "$work/routes" "$STATE/table"; then echo "gateway: version $v already applied"; return 0; fi
      refuse "version $v was applied with a different table"
    fi
  fi
  gateway_ipv4 >/dev/null || die "container $VMID isn't the gateway: nothing changed"
  apply "$v"
}

status() {
  local ip state route=0 m ports
  ip=$(gateway_ipv4 || true)
  state=$(pct status "$VMID" 9>&- 2>/dev/null | awk '{ print $2 }' | clean || true)
  if [[ -n $ip ]]; then route=$(ip -4 route show "$ip/32" dev "$BRIDGE" 2>/dev/null | grep -c . || true); fi
  echo "container=${state:-missing}"
  echo "ipv4=$ip"
  echo "route=$route"
  echo "version=$(applied_version)"
  echo "routes=$(if [[ -f $STATE/table ]]; then wc -l <"$STATE/table"; else echo 0; fi)"
  [[ $state == running ]] || return 0
  echo "haproxy=$(ct systemctl is-active haproxy 2>/dev/null | clean || true)"
  echo "haproxy_enabled=$(ct systemctl is-enabled haproxy 2>/dev/null | clean || true)"
  echo "config=$(ct systemctl show -p Environment --value haproxy 2>/dev/null | tr ' ' '\n' | sed -n 's/^CONFIG=//p' | clean || true)"
  echo "running_config=$(running_config)"
  echo "live_version=$(live_version)"
  echo "unknown_host=$(unknown_host_code)"
  echo "ssh=$(ct systemctl is-active ssh 2>/dev/null | clean || true)"
  echo "logins=$(ct sh -c 'grep -c . /root/.ssh/authorized_keys 2>/dev/null || true' 2>/dev/null | clean || true)"
  # Ports open beyond the container itself: only HAProxy's.
  ports=$(ct ss -Hltnu 2>/dev/null | awk '{ print $5 }' | grep -vE '^(127\.|\[::1\]|[^ ]*%lo:)' | sed 's/.*://' | sort -un | paste -sd, - | clean || true)
  echo "public_ports=$ports"
  m=$(ct cat /sys/fs/cgroup/memory.current 2>/dev/null | clean || true)
  if [[ $m =~ ^[0-9]{1,15}$ ]]; then echo "memory_mb=$((m / 1048576))"; fi
}

install() {
  local _
  lock
  gateway_ipv4 >/dev/null || die "container $VMID isn't the gateway (hostname $NAME, a /32 IPv4 on $BRIDGE)"
  [[ $(pct status "$VMID" 9>&- | awk '{ print $2 }') == running ]] || pct start "$VMID" 9>&-
  for _ in $(seq 1 30); do
    if ct getent ahostsv4 archive.ubuntu.com >/dev/null 2>&1; then break; fi
    sleep 2
  done
  ct env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  ct env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy curl >/dev/null
  # No logins: the gateway is run through pct only, so nothing listens on it but HAProxy.
  ct systemctl disable --now ssh.service >/dev/null 2>&1 || true
  ct systemctl disable --now ssh.socket >/dev/null 2>&1 || true
  ct systemctl mask ssh.service >/dev/null 2>&1 || true
  ct sh -c ': > /root/.ssh/authorized_keys' 2>/dev/null || true
  # The package's unit reads $CONFIG: pointed at the generated config, which an upgrade never touches.
  printf '[Service]\nEnvironment="CONFIG=%s/current/haproxy.cfg"\n' "$CT_DIR" >"$work/sowsi.conf"
  ct mkdir -p /etc/systemd/system/haproxy.service.d "$CT_DIR"
  push "$work/sowsi.conf" /etc/systemd/system/haproxy.service.d/sowsi.conf
  ct systemctl daemon-reload
  ct systemctl enable haproxy >/dev/null 2>&1
  local applied
  applied=$(applied_version)
  if [[ $applied =~ ^[0-9]{1,15}$ && -n $(current_version) ]]; then
    haproxy_up
    serving "$applied" || die "HAProxy isn't serving version $applied (it runs $(running_config))"
    echo "gateway: installed, version $applied"
  else
    : >"$work/routes"
    apply 0
  fi
}

ARGS=("$@")
case "${1:-}" in
  status) [[ $# == 1 ]] || usage; status ;;
  sync)
    [[ $# == 2 && $2 =~ ^[0-9]{1,15}$ ]] || refuse "usage: sowsi-gateway sync <version>, the table on stdin"
    sync_table "$2" ;;
  install) [[ $# == 1 ]] || usage; install ;;
  *) usage ;;
esac
SCRIPT
chmod 755 /usr/local/sbin/sowsi-gateway
mkdir -p /etc/sowsi/gateway
fi

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
#   gateway-status                 facts about the shared IPv4 gateway (container 9000)
#   gateway-sync <version>         the gateway's whole route table, on stdin; sowsi-gateway checks every line
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
  gateway-status) no_arguments; exec /usr/local/sbin/sowsi-gateway status ;;
  gateway-sync)
    # stdin carries the table. The command line carries only its version number.
    if ! [[ "${arg:-}" =~ ^[0-9]{1,15}$ ]]; then echo "invalid version" >&2; exit 2; fi
    exec /usr/local/sbin/sowsi-gateway sync "$arg" ;;
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
