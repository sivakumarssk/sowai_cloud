#!/usr/bin/env bash
# One-time Proxmox host setup for Sowsi Cloud container networking.
#
#   scp scripts/proxmox-host-setup.sh root@128.140.70.53:/root/
#   ssh root@128.140.70.53 bash /root/proxmox-host-setup.sh
#
# Safe to re-run. Does not modify vmbr0's IPv4 config, so it can't cut off
# your SSH session.
#
# Why a separate routed bridge: Hetzner Cloud only forwards traffic from the
# server's own MAC address, so containers can't sit directly on vmbr0 (which
# is bridged to eth0). Instead they attach to vmbr1, which has no physical
# port, and the host routes each container's Floating IP / IPv6 to it.
set -euo pipefail

IPV6_SUBNET="2a01:4f8:1c16:5f1d"
PROVISIONING_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL+L152cRvIkX3R0xtdG4toSwTbblpUz6PioDz89wglD sowsi-provisioning"

echo "== 1. DNS"
if ! getent hosts download.proxmox.com >/dev/null; then
  # resolv.conf is empty (or a dangling systemd-resolved link); use Hetzner's resolvers.
  rm -f /etc/resolv.conf
  printf 'nameserver 185.12.64.1\nnameserver 185.12.64.2\n' > /etc/resolv.conf
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

echo "== 7. Provisioning key (restricted to running sowsi-routes)"
KEY_BODY=$(awk '{print $2}' <<<"$PROVISIONING_PUBKEY")
if ! grep -qF "$KEY_BODY" /root/.ssh/authorized_keys 2>/dev/null; then
  echo "restrict,command=\"/usr/local/sbin/sowsi-routes\" $PROVISIONING_PUBKEY" >> /root/.ssh/authorized_keys
fi

echo
echo "== Done"
ip -br link show vmbr1
ip -6 route show default
/usr/local/sbin/sowsi-routes
