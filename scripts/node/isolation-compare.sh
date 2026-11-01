#!/usr/bin/env bash
# Read-only: prints what the container isolation rules depend on. Changes nothing
# on the node and prints no keys. Run it on node 1 and on a fresh node, then diff.
set -u
sec() { echo; echo "=== $1"; }

sec versions
pveversion 2>/dev/null; uname -r
command -v nft >/dev/null && nft --version || echo "nft: NOT INSTALLED"

sec services
for s in nftables pve-firewall proxmox-firewall ufw fail2ban sowsi-routes sowsi-net-guard; do
  printf '%-18s enabled=%s active=%s\n' "$s" \
    "$(systemctl is-enabled "$s" 2>/dev/null)" "$(systemctl is-active "$s" 2>/dev/null)"
done

sec "proxmox firewall"
pve-firewall status 2>/dev/null
ls /etc/pve/firewall/ 2>/dev/null

sec "nft tables"
nft list tables 2>/dev/null

sec "cluster filesystem"
mountpoint /etc/pve

sec "links and bridge ports"
ip -br link; bridge link show 2>/dev/null

sec "every interface and its addresses"
ip -o addr show

sec "all routes"
ip -4 route show; ip -6 route show

sec "routes and proxy entries"
ip -4 route show proto 250; ip -6 route show proto 250; ip -6 neigh show proxy

sec sysctls
for k in net.ipv4.ip_forward net.ipv6.conf.all.forwarding \
  net.ipv4.conf.vmbr1.proxy_arp net.ipv6.conf.vmbr0.proxy_ndp \
  net.ipv4.conf.vmbr1.send_redirects net.ipv6.conf.vmbr1.accept_ra \
  net.bridge.bridge-nf-call-iptables net.bridge.bridge-nf-call-ip6tables; do
  printf '%s=%s\n' "$k" "$(sysctl -n "$k" 2>/dev/null || echo absent)"
done

sec ufw
ufw status verbose 2>/dev/null

sec "vmbr1 in interfaces"
sed -n '/vmbr1/,$p' /etc/network/interfaces

sec "script versions"
sha256sum /usr/local/sbin/sowsi-routes /usr/local/sbin/sowsi-host 2>/dev/null

sec "listening on the host"
ss -tulnH

sec containers
shopt -s nullglob
ips=""
for conf in /etc/pve/lxc/*.conf; do
  id=$(basename "$conf" .conf)
  net0=$(grep -m1 '^net0:' "$conf")
  echo "$id status=$(pct status "$id" 2>/dev/null | awk '{print $2}') nets=$(sed '/^\[/q' "$conf" | grep -c '^net[0-9]') $net0"
  [[ $net0 == *firewall=1* ]] && echo "  WARN $id has firewall=1"
  [[ $net0 == *hwaddr=* ]] || echo "  WARN $id has no hwaddr"
  [[ $net0 == *bridge=vmbr1* ]] || echo "  WARN $id isn't on vmbr1"
  if [[ $net0 =~ ,ip=([0-9.]+)/32 ]]; then ips="$ips ${BASH_REMATCH[1]}"; else echo "  NOTE $id has no /32 IPv4"; fi
  if [[ $net0 =~ ,ip6=([0-9a-fA-F:]+)/ ]]; then ips="$ips ${BASH_REMATCH[1]}"; fi
  grep -E '^(nameserver|searchdomain):' "$conf"
done

sec "established connections between the host and containers"
for ip in $ips; do ss -tnH state established | grep -F "$ip"; done

echo; echo "=== end"
