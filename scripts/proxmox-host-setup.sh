#!/usr/bin/env bash
# One-time Proxmox host setup for Sowsi Cloud container networking. Works on
# any node: the node's IPv6 /64 and the provisioning key come from the
# environment. scripts/node/install-node.ts runs it on new nodes (without
# PROVISIONING_PUBKEY: it installs that key itself, last). By hand, e.g. node 1:
#
#   ssh root@128.140.70.53 \
#     'IPV6_SUBNET=2a01:4f8:1c16:5f1d PROVISIONING_PUBKEY="ssh-ed25519 AAAA… sowsi-provisioning" bash -s' \
#     < scripts/proxmox-host-setup.sh
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
IPV6_SUBNET="${IPV6_SUBNET:?set IPV6_SUBNET to the /64 of this node without ::, e.g. 2a01:4f8:1c16:5f1d}"
IPV6_SUBNET="${IPV6_SUBNET%%::*}"
# Public half of the platform provisioning key (PROVISIONING_SSH_PUBLIC_KEY). Empty = step 8 is skipped.
PROVISIONING_PUBKEY="${PROVISIONING_PUBKEY:-}"

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

echo "== 4. Route sync script"
cat > /usr/local/sbin/sowsi-routes <<'SCRIPT'
#!/usr/bin/env bash
# Routes every Sowsi container's public IPs from the host to the routed
# bridge. Source of truth: the net0 line (ip=, ip6=) of each container on
# $BRIDGE in /etc/pve/lxc/*.conf. Idempotent; also removes routes for
# containers that no longer exist.
set -euo pipefail

BRIDGE=vmbr1
UPLINK=vmbr0
PROTO=250 # tags routes owned by this script

re4=',ip=([0-9.]+)/32'
re6=',ip6=([0-9a-fA-F:]+)/'
declare -A want4=() want6=()
shopt -s nullglob
for conf in /etc/pve/lxc/*.conf; do
  # The first net0 line is the live config; later ones belong to snapshots.
  net0=$(grep -m1 '^net0:' "$conf" || true)
  [[ $net0 == *"bridge=$BRIDGE"* ]] || continue
  if [[ $net0 =~ $re4 ]]; then want4[${BASH_REMATCH[1]}]=1; fi
  if [[ $net0 =~ $re6 ]]; then want6[${BASH_REMATCH[1]}]=1; fi
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

echo "routes: ${#want4[@]} IPv4, ${#want6[@]} IPv6"
SCRIPT
chmod 755 /usr/local/sbin/sowsi-routes

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

echo "== 6. Re-apply routes at boot"
cat > /etc/systemd/system/sowsi-routes.service <<'EOF'
[Unit]
Description=Sowsi Cloud container routes
After=network-online.target pve-cluster.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/sowsi-routes
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now sowsi-routes.service

echo "== 7. Host command dispatcher (the only thing the provisioning key may run)"
cat > /usr/local/sbin/sowsi-host <<'SCRIPT'
#!/usr/bin/env bash
# Forced command for the Sowsi provisioning SSH key. Only these are allowed:
#   routes | sowsi-routes          re-sync container routes
#   mount-volume <hetzner-id>      mount an attached Hetzner Volume and register it as Proxmox storage
#   unmount-volume <hetzner-id>    unregister + unmount it (refused while any disk is on it)
set -euo pipefail
read -r cmd arg extra <<<"${SSH_ORIGINAL_COMMAND:-routes}"
if [[ -n "${extra:-}" ]]; then echo "too many arguments" >&2; exit 2; fi
case "$cmd" in
  routes|sowsi-routes) exec /usr/local/sbin/sowsi-routes ;;
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

echo
echo "== Done"
ip -br link show vmbr1
ip -6 route show default
/usr/local/sbin/sowsi-routes
