#!/usr/bin/env bash
# The isolation tests for a THROWAWAY node. It creates containers, reboots, resets ufw and changes
# rules, so it refuses to run unless the node's name contains "test".
#
#   FIP=<floating ip> bash -s -- main     tests 1-14, 16, 17, 19, 21-24 (creates containers 900-902)
#   bash -s -- reboot-check               test 18, after rebooting the node
#   bash -s -- bad-boot-prep              test 20, then reboot
#   bash -s -- bad-boot-check             test 20, after that reboot
#   bash -s -- rollback-prep              test 25: makes the node look like one without these rules
#   bash -s -- rollback-check             test 25, after ISOLATION_ONLY has run and its 10 minutes have passed
#   bash -s -- cleanup                    deletes the test containers
#
# Add PRIVATE=<sowsi-mgmt-01's private IP> to main once the node is attached to the private network.
# Tests 13 (inbound) and 15 come from outside the node.
set -u
phase=${1:-}
name=$(hostname)
if [[ $name != *test* ]]; then echo "refused: $name is not a throwaway node" >&2; exit 2; fi

A=900 B=901 C=902
TEMPLATE=local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst
OUTSIDE6=2606:4700:4700::1111
FORGE=/tmp/sowsi-forge.py
pass=0 failed=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { failed=$((failed + 1)); echo "  FAIL $1"; }
check() { local label=$1; shift; if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label"; fi; }
finish() { echo; echo "RESULT: $pass passed, $failed failed"; }
count() { /usr/local/sbin/sowsi-routes --status | awk -F= -v n="$1" '$1 == n { print $2 }' | grep . || echo 0; }
in_ct() { local id=$1; shift; pct exec "$id" -- bash -c "$*"; }
reach() { in_ct "$1" "timeout 3 bash -c '</dev/tcp/$2/$3' 2>/dev/null"; }
subnet() { ip -6 -o addr show dev vmbr0 scope global | awk '{ print $4 }' | sed 's/::1\/64$//' | head -1; }
node_ipv4() { ip -4 -o addr show dev vmbr0 | awk '{ print $4 }' | cut -d/ -f1 | head -1; }
tables() { /usr/local/sbin/sowsi-routes --status | awk -F= '$1 == "tables" { print $2 }'; }

# A step that must raise a counter: the attempt alone failing could be anything.
rises() {
  local label=$1 counter=$2 before after; shift 2
  before=$(count "$counter")
  "$@" >/dev/null 2>&1
  sleep 0.5
  after=$(count "$counter")
  if ((after > before)); then ok "$label ($counter +$((after - before)))"; else bad "$label: $counter stayed at $after"; fi
}
blocked() { # label counter container host port
  local label=$1 counter=$2 before after; shift 2
  before=$(count "$counter")
  if reach "$@"; then bad "$label: it connected"; return; fi
  after=$(count "$counter")
  if ((after > before)); then ok "$label ($counter +$((after - before)))"; else bad "$label: refused, but $counter stayed at $after"; fi
}
same_counter() {
  local label=$1 counter=$2 before after; shift 2
  before=$(count "$counter")
  "$@" >/dev/null 2>&1
  sleep 0.5
  after=$(count "$counter")
  if ((after == before)); then ok "$label"; else bad "$label: $counter rose from $before to $after"; fi
}

# The installer's restart check. A restarted container has forgotten the gateway, and a spoofed
# packet's ARP request would carry the spoofed sender: spoof_arp would stop that before spoof_ip4
# sees anything. So learn the gateway from the real address first, then check each rule on its own.
restart_spoof_check() { # label container real-ipv4
  local label=$1 id=$2 ip=$3 ready=no learned=no out b4 m4 ba aa all before=$failed
  for _ in $(seq 1 30); do
    if in_ct "$id" "ip -4 -o addr show dev eth0 | grep -qF ' $ip/32 ' && ip -4 route show default | grep -qF 'via 172.31.1.1'"; then ready=yes; break; fi
    sleep 2
  done
  if [[ $ready == yes ]]; then ok "$label: IPv4 address and default route are back"; else bad "$label: no IPv4 address or default route after the restart"; fi
  if in_ct "$id" "ping -c 1 -W 2 -I $ip 172.31.1.1" >/dev/null 2>&1; then echo "  info $label: the gateway replied"; else echo "  info $label: no reply from the gateway (an unrouted address gets none)"; fi
  for _ in $(seq 1 10); do
    if in_ct "$id" "ip neigh show 172.31.1.1 dev eth0 | grep -q lladdr"; then learned=yes; break; fi
    sleep 0.5
  done
  if [[ $learned == yes ]]; then ok "$label: gateway learned from its own address"; else bad "$label: the gateway's MAC was never learned"; fi
  all=$(/usr/local/sbin/sowsi-routes --status | tr '\n' ' ')
  b4=$(count spoof_ip4); ba=$(count spoof_arp)
  out=$(in_ct "$id" "ip addr add 198.18.254.99/32 dev eth0; echo add_exit=\$?; ping -c 1 -W 1 -I 198.18.254.99 1.1.1.1 >/dev/null 2>&1; ip addr del 198.18.254.99/32 dev eth0")
  sleep 0.5
  m4=$(count spoof_ip4)
  if [[ $out != *add_exit=0* ]]; then bad "$label: ip addr add failed ($out)"
  elif ((m4 > b4)); then ok "$label: spoofed IPv4 stopped (spoof_ip4 $b4 -> $m4)"
  else bad "$label: spoofed IPv4 not stopped (spoof_ip4 $b4 -> $m4, spoof_arp $ba -> $(count spoof_arp))"; fi
  ba=$(count spoof_arp)
  out=$(in_ct "$id" "ip neigh flush dev eth0; ip addr add 198.18.254.99/32 dev eth0; echo add_exit=\$?; ping -c 1 -W 1 -I 198.18.254.99 172.31.1.1 >/dev/null 2>&1; ip addr del 198.18.254.99/32 dev eth0")
  sleep 0.5
  aa=$(count spoof_arp)
  if [[ $out != *add_exit=0* ]]; then bad "$label: ip addr add failed for the ARP test ($out)"
  elif ((aa > ba)); then ok "$label: spoofed ARP stopped (spoof_arp $ba -> $aa)"
  else bad "$label: spoofed ARP not stopped (spoof_arp $ba -> $aa)"; fi
  if ((failed > before)); then
    echo "  counters before: $all"
    echo "  counters after:  $(/usr/local/sbin/sowsi-routes --status | tr '\n' ' ')"
    echo "  evidence: $(in_ct "$id" "ip -br addr; ip -4 route; ip neigh show dev eth0" | tr '\n' ';')"
  fi
}

write_forge() {
  cat > "$FORGE" <<'PY'
import socket, struct, sys
kind, mac, host_mac, own6, peer6, peer4, own4 = sys.argv[1:8]
MAC = bytes.fromhex(mac.replace(":", "")); HOST = bytes.fromhex(host_mac.replace(":", ""))
ip6 = lambda a: socket.inet_pton(socket.AF_INET6, a)
def csum(b):
    if len(b) % 2: b += b"\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16: s = (s & 0xffff) + (s >> 16)
    return (~s) & 0xffff
def icmp6(src, dst, body):
    c = csum(ip6(src) + ip6(dst) + struct.pack("!I", len(body)) + b"\0\0\0\x3a" + body)
    body = body[:2] + struct.pack("!H", c) + body[4:]
    return struct.pack("!IHBB", 0x60000000, len(body), 58, 255) + ip6(src) + ip6(dst) + body
eth6 = HOST + MAC + b"\x86\xdd"
def na(target): return eth6 + icmp6(own6, "ff02::1", struct.pack("!BBHI", 136, 0, 0, 0x20000000) + ip6(target) + b"\x02\x01" + MAC)
def arp(sender): return HOST + MAC + b"\x08\x06" + struct.pack("!HHBBH", 1, 0x800, 6, 4, 2) + MAC + socket.inet_aton(sender) + HOST + socket.inet_aton("172.31.1.1")
def udp4(sport): return HOST + MAC + b"\x08\x00" + struct.pack("!BBHHHBBH", 0x45, 0, 28, 0, 0, 64, 17, 0) + socket.inet_aton(own4) + socket.inet_aton("255.255.255.255") + struct.pack("!HHHH", sport, 68, 8, 0)
frames = {
  "na_peer": lambda: na(peer6), "na_own": lambda: na(own6), "na_gateway": lambda: na("fe80::1"),
  "ra": lambda: eth6 + icmp6("fe80::be24:11ff:fe00:1", "ff02::1", struct.pack("!BBHBBHII", 134, 0, 0, 64, 0, 1800, 0, 0)),
  "arp_peer": lambda: arp(peer4), "arp_own": lambda: arp(own4), "dhcp": lambda: udp4(67),
  "vlan": lambda: HOST + MAC + b"\x81\x00\x00\x05\x08\x00" + b"\x45" + bytes(39),
}
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW); s.bind(("eth0", 0)); s.send(frames[kind]())
PY
  pct push "$A" "$FORGE" /root/forge.py
}
forge() { in_ct "$A" "python3 /root/forge.py $1 $MAC_A $HOST_MAC $IP6_A $IP6_B $IP4_B $FIP"; }

main() {
  FIP=${FIP:?set FIP to a Floating IP assigned to this server}
  S=$(subnet) NODE4=$(node_ipv4) NODE6=$S::1
  IP6_A=$S::900 IP6_B=$S::901 IP4_B=198.18.254.11
  echo "node $name, $NODE4, $S::/64, Floating IP $FIP"
  mk() { pct create "$1" "$TEMPLATE" --hostname "sowsi-iso-$1" --cores 1 --memory 1024 --rootfs local:8 --unprivileged 1 --features nesting=1 --onboot 1 --start 1 --net0 "$2"; }
  mk "$A" "name=eth0,bridge=vmbr1,ip=$FIP/32,gw=172.31.1.1,ip6=$IP6_A/64,gw6=fe80::1"
  mk "$B" "name=eth0,bridge=vmbr1,ip=$IP4_B/32,gw=172.31.1.1,ip6=$IP6_B/64,gw6=fe80::1"
  /usr/local/sbin/sowsi-routes
  sleep 10
  MAC_A=$(sed -n 's/^net0:.*hwaddr=\([^,]*\).*/\1/p' "/etc/pve/lxc/$A.conf" | head -1)
  HOST_MAC=$(cat /sys/class/net/vmbr1/address)
  echo "== getting python3 and curl into the first container (needs outbound IPv4)"
  in_ct "$A" "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl" >/dev/null 2>&1 || bad "apt in the container"
  write_forge

  echo "== 13 internet still works"
  check "13 outbound IPv4" in_ct "$A" "curl -4 -fsS -m 15 -o /dev/null http://deb.debian.org/debian/dists/bookworm/Release"
  check "13 outbound IPv6" in_ct "$A" "curl -6 -fsS -m 15 -o /dev/null http://deb.debian.org/debian/dists/bookworm/Release"
  check "13 the neighbour's outbound IPv6" in_ct "$B" "ping -6 -c 2 -W 2 $OUTSIDE6"

  echo "== 1-7 spoofing"
  rises "1 another IPv4 as source" spoof_ip4 in_ct "$A" "ip addr add $IP4_B/32 dev eth0; ping -c 1 -W 1 -I $IP4_B 1.1.1.1; ip addr del $IP4_B/32 dev eth0"
  rises "2 another IPv6 as source" spoof_ip6 in_ct "$A" "ip -6 addr add $IP6_B/128 dev eth0 nodad; ping -6 -c 1 -W 1 -I $IP6_B $OUTSIDE6; ip -6 addr del $IP6_B/128 dev eth0"
  rises "3 another MAC" spoof_mac in_ct "$A" "ip link set dev eth0 address 02:00:00:5e:53:01; ping -6 -c 2 -W 1 $OUTSIDE6; ip link set dev eth0 address $MAC_A"
  if bridge fdb show br vmbr1 | grep -q 02:00:00:5e:53:01; then bad "3 the bridge learned the fake MAC"; else ok "3 the bridge never learned the fake MAC"; fi
  check "3 back on its own MAC" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  rises "4 forged ARP for the neighbour" spoof_arp forge arp_peer
  same_counter "4 ARP for its own IP passes" spoof_arp forge arp_own
  rises "5 forged advertisement for the neighbour" spoof_nd forge na_peer
  rises "5 forged advertisement for fe80::1" spoof_nd forge na_gateway
  same_counter "5 an advertisement for its own address passes" spoof_nd forge na_own
  if ip -6 neigh show "$IP6_B" dev vmbr1 | grep -qi "$MAC_A"; then bad "5 the host took the forged MAC"; else ok "5 the host's entry for the neighbour is unchanged"; fi
  rises "6 forged router advertisement" spoof_nd forge ra
  rises "6 forged DHCP server" spoof_nd forge dhcp
  rises "7 VLAN-tagged frame" bad_frame forge vlan

  echo "== 8-9 neighbours"
  blocked "8 neighbour over IPv4" to_neighbour_l3 "$A" "$IP4_B" 22
  blocked "9 neighbour over IPv6, on-link" to_neighbour_l2 "$A" "$IP6_B" 22
  in_ct "$A" "ip -6 route add $IP6_B/128 via fe80::1 dev eth0"
  blocked "9 neighbour over IPv6, routed" to_neighbour_l3 "$A" "$IP6_B" 22
  in_ct "$A" "ip -6 route del $IP6_B/128 via fe80::1 dev eth0"
  rises "9 ping the neighbour over IPv6" to_neighbour_l2 in_ct "$A" "ping -6 -c 1 -W 1 $IP6_B"

  echo "== 10 the host"
  for port in 22 8006 80; do blocked "10 host IPv4 port $port" to_host "$A" "$NODE4" "$port"; done
  blocked "10 host on fe80::1" to_host "$A" "fe80::1%eth0" 22
  in_ct "$A" "ip -6 route add $NODE6/128 via fe80::1 dev eth0"
  for port in 22 8006; do blocked "10 host IPv6 port $port" to_host "$A" "$NODE6" "$port"; done
  in_ct "$A" "ip -6 route del $NODE6/128 via fe80::1 dev eth0"

  echo "== 11 mail"
  for target in 1.1.1.1 "$OUTSIDE6"; do for port in 25 465; do blocked "11 $target port $port" to_mail "$A" "$target" "$port"; done; done
  same_counter "11 port 587 isn't ours to stop" to_mail reach "$A" 1.1.1.1 587

  echo "== 12, 26 metadata and private networks"
  blocked "12 metadata" to_metadata "$A" 169.254.169.254 80
  blocked "26 a private range" to_private "$A" 192.168.1.1 22
  blocked "26 a ULA" to_private "$A" fd00::1 22
  if ip route show 10.0.0.0/8 | grep -q . || ip route | grep -q '^10\.'; then
    blocked "26 the private network, by its own interface" to_other_iface "$A" "${PRIVATE:-10.0.0.2}" 22
  else
    blocked "26 10.0.0.x, with no private network attached" to_private "$A" "${PRIVATE:-10.0.0.2}" 22
  fi
  /usr/local/sbin/sowsi-routes --probe on
  blocked "26 out by another interface, IPv4" to_other_iface "$A" 198.19.255.2 22
  blocked "26 out by another interface, IPv6" to_other_iface "$A" 2001:db8:5053::2 22
  /usr/local/sbin/sowsi-routes --probe off

  echo "== 14 a live connection survives a reload"
  in_ct "$A" "curl -4 -fsS -m 60 --limit-rate 300k -o /dev/null http://deb.debian.org/debian/ls-lR.gz" &
  download=$!
  sleep 5
  rm -f /etc/sowsi/rules.last-good.nft
  /usr/local/sbin/sowsi-routes >/dev/null
  wait "$download"; rc=$?
  if ((rc == 0 || rc == 28)); then ok "14 download kept running across the reload (curl exit $rc; 28 is the 60-second limit)"; else bad "14 download broke with curl exit $rc"; fi

  echo "== 16 Docker inside the container"
  spoofs=$(count spoof_ip4)
  # nginx can take longer than a fixed sleep to listen (sowsi-test-03), so each step waits up to 30 s.
  docker_check='export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq docker.io >/dev/null 2>&1 || { echo "step=install"; exit 1; }
deadline=$((SECONDS + 30))
until docker info >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then echo "step=daemon"; exit 1; fi
  sleep 1
done
docker rm -f t >/dev/null 2>&1
if ! docker run -d --name t -p 8080:80 nginx:alpine >/dev/null 2>&1; then echo "step=run"; docker ps -a 2>&1 | tail -3; exit 1; fi
start=$SECONDS deadline=$((SECONDS + 30)) rc=1
while ((SECONDS < deadline)); do
  if curl -fsS -m 2 -o /dev/null http://localhost:8080; then rc=0; echo "served_after=$((SECONDS - start))s"; break; fi
  sleep 1
done
if ((rc != 0)); then echo "step=port"; docker ps -a 2>&1 | tail -3; docker logs t 2>&1 | tail -5; fi
docker rm -f t >/dev/null 2>&1
exit $rc'
  if docker_out=$(in_ct "$A" "$docker_check" 2>&1); then
    ok "16 Docker pulled and served a published port (${docker_out#served_after=})"
  else
    bad "16 Docker failed at $(sed -n 's/^step=//p' <<<"$docker_out" | head -1): check whether the rules or Docker in LXC are the cause"
    sed 's/^/       /' <<<"$docker_out"
  fi
  if [[ $(count spoof_ip4) == "$spoofs" ]]; then ok "16 no spoof counter rose"; else bad "16 Docker's traffic hit a spoof rule"; fi

  echo "== 17 container restart"
  pct reboot "$B"
  for _ in $(seq 1 120); do [[ $(pct status "$B") == *running* ]] && break; sleep 1; done
  restart_spoof_check "17 after a restart, with no sync" "$B" "$IP4_B"
  check "17 the neighbour still has outbound IPv6" in_ct "$B" "ping -6 -c 2 -W 2 $OUTSIDE6"

  echo "== 19 a bad rule file"
  good=$(sha256sum /etc/sowsi/rules.last-good.nft)
  if SOWSI_NFT_TEST_APPEND="this is not a rule" /usr/local/sbin/sowsi-routes 2>/dev/null; then bad "19 a bad file didn't fail the run"; else ok "19 a bad file fails the run"; fi
  if [[ $(tables) == 2 ]]; then ok "19 both tables still loaded"; else bad "19 tables lost"; fi
  if [[ $(sha256sum /etc/sowsi/rules.last-good.nft) == "$good" ]]; then ok "19 last good file unchanged"; else bad "19 last good file changed"; fi
  check "19 traffic still flows" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  blocked "19 rules still apply" to_mail "$A" 1.1.1.1 25

  echo "== 21 rules removed: waiting up to 6 minutes for the timer"
  nft delete table bridge sowsi
  back=no
  for _ in $(seq 1 36); do sleep 10; if [[ $(tables) == 2 ]]; then back=yes; break; fi; done
  if [[ $back == yes ]]; then ok "21 the timer put them back"; else bad "21 the rules didn't come back"; fi

  echo "== 22 ufw reset"
  before=$(nft list tables | grep -c sowsi)
  ufw --force reset >/dev/null
  if [[ $(nft list tables | grep -c sowsi) == "$before" ]]; then ok "22 our tables survive a ufw reset"; else bad "22 ufw reset removed our tables"; fi
  if nft list chain inet sowsi host_input | grep -q 'dport 8006'; then ok "22 8006 is still limited with ufw off"; else bad "22 the 8006 rule is gone"; fi
  mgmt=$(cat /etc/sowsi/mgmt-ip)
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null; ufw default allow routed >/dev/null; ufw logging off >/dev/null
  for port in 22 80 443; do ufw allow "$port/tcp" >/dev/null; done
  ufw allow from "$mgmt" to any port 8006 proto tcp >/dev/null
  ufw route allow in on vmbr1 >/dev/null; ufw route allow out on vmbr1 >/dev/null
  ufw --force enable >/dev/null

  echo "== 23 a damaged net0 line"
  cp "/etc/pve/lxc/$B.conf" /tmp/sowsi-b.conf
  sed -i 's/hwaddr=[^,]*/hwaddr=NOT-A-MAC/' "/etc/pve/lxc/$B.conf"
  out=$(/usr/local/sbin/sowsi-routes)
  if grep -q "refused: $B" <<<"$out"; then ok "23 the bad line is named"; else bad "23 the bad line wasn't reported: $out"; fi
  rises "23 that container is cut off" unknown_port in_ct "$B" "ping -6 -c 1 -W 1 $OUTSIDE6"
  check "23 the other is unaffected" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  cat /tmp/sowsi-b.conf > "/etc/pve/lxc/$B.conf"
  /usr/local/sbin/sowsi-routes >/dev/null

  echo "== 24 create and delete"
  pct create "$C" "$TEMPLATE" --hostname sowsi-iso-902 --cores 1 --memory 512 --rootfs local:4 --unprivileged 1 --start 1 --net0 "name=eth0,bridge=vmbr1,ip6=$S::902/64,gw6=fe80::1"
  sleep 8
  rises "24 before its sync, a new container has no traffic" unknown_port in_ct "$C" "ping -6 -c 1 -W 1 $OUTSIDE6"
  /usr/local/sbin/sowsi-routes >/dev/null
  check "24 after its sync it works" in_ct "$C" "ping -6 -c 2 -W 2 $OUTSIDE6"
  pct stop "$C"; pct destroy "$C" --purge
  /usr/local/sbin/sowsi-routes >/dev/null
  if nft list table bridge sowsi | grep -q "ct$C"; then bad "24 its chain is still there"; else ok "24 its chain is gone after delete"; fi

  finish
  echo "Next: test 13 inbound and 15 from outside, then reboot and run reboot-check."
}

reboot_check() {
  S=$(subnet) NODE4=$(node_ipv4)
  [[ $(tables) == 2 ]] && ok "18 both tables came back by themselves" || bad "18 tables missing after the reboot"
  rules=$(systemctl show -p ActiveEnterTimestampMonotonic --value sowsi-routes.service)
  guests=$(systemctl show -p ExecMainStartTimestampMonotonic --value pve-guests.service)
  if ((rules > 0 && guests > 0 && rules <= guests)); then ok "18 rules loaded before guests started"; else bad "18 order: rules at $rules, guests at $guests"; fi
  check "18 the timer is active" systemctl is-active sowsi-routes.timer
  check "18 ufw is active" bash -c "ufw status | grep -q 'Status: active'"
  check "18 the first container came back" pct status "$A"
  sleep 5
  check "18 outbound IPv6 works" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  blocked "18 the neighbour is still blocked" to_neighbour_l2 "$A" "$S::901" 22
  blocked "18 the host is still blocked" to_host "$A" "$NODE4" 22
  restart_spoof_check "18 after the reboot" "$A" "$(sed -n 's/^net0:.*,ip=\([0-9.]*\)\/32.*/\1/p' "/etc/pve/lxc/$A.conf" | head -1)"
  finish
}

bad_boot_prep() {
  mkdir -p /etc/systemd/system/sowsi-routes.service.d
  printf '[Service]\nEnvironment="SOWSI_NFT_TEST_APPEND=this is not a rule"\n' > /etc/systemd/system/sowsi-routes.service.d/test.conf
  systemctl stop sowsi-routes.timer
  systemctl disable sowsi-routes.timer
  systemctl daemon-reload
  echo "Ready: reboot the node, then run bad-boot-check."
}

bad_boot_check() {
  if [[ $(tables) == 2 ]]; then ok "20 the last good rules loaded at boot"; else bad "20 no rules after a boot with a bad file"; fi
  if systemctl is-failed sowsi-routes.service >/dev/null; then ok "20 the failure shows on the service"; else bad "20 the service shows no failure"; fi
  check "20 the container started" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  blocked "20 rules apply" to_mail "$A" 1.1.1.1 25
  rm -rf /etc/systemd/system/sowsi-routes.service.d
  systemctl daemon-reload
  systemctl enable --now sowsi-routes.timer
  systemctl restart sowsi-routes.service
  finish
}

rollback_prep() {
  systemctl disable --now sowsi-routes.timer 2>/dev/null
  rm -f /etc/systemd/system/sowsi-routes.timer /etc/systemd/system/sowsi-routes-sync.service
  sed -i '/^Before=pve-guests.service$/d' /etc/systemd/system/sowsi-routes.service
  systemctl daemon-reload
  nft delete table bridge sowsi; nft delete table inet sowsi
  systemctl unmask nftables.service
  cp /usr/local/sbin/sowsi-routes /root/sowsi-routes.isolated
  printf '#!/usr/bin/env bash\necho "routes: 0 IPv4, 0 IPv6"\n' > /usr/local/sbin/sowsi-routes
  echo "Ready: run the ISOLATION_ONLY rollout, let its 10 minutes pass without confirming, then run rollback-check."
}

rollback_check() {
  if nft list tables | grep -q sowsi; then bad "25 tables are still there"; else ok "25 both tables are gone"; fi
  if grep -q 'echo "routes: 0 IPv4, 0 IPv6"' /usr/local/sbin/sowsi-routes; then ok "25 the old script is back"; else bad "25 the old script wasn't restored"; fi
  if systemctl is-enabled sowsi-routes.timer >/dev/null 2>&1; then bad "25 the timer is still enabled"; else ok "25 the timer is gone"; fi
  check "25 containers keep working" in_ct "$A" "ping -6 -c 2 -W 2 $OUTSIDE6"
  finish
}

cleanup() {
  for id in "$A" "$B" "$C"; do
    if [[ -f /etc/pve/lxc/$id.conf ]]; then pct stop "$id" 2>/dev/null; pct destroy "$id" --purge; fi
  done
  echo "test containers removed"
}

case "$phase" in
  main) main ;;
  reboot-check) reboot_check ;;
  bad-boot-prep) bad_boot_prep ;;
  bad-boot-check) bad_boot_check ;;
  rollback-prep) rollback_prep ;;
  rollback-check) rollback_check ;;
  cleanup) cleanup ;;
  *) echo "usage: bash -s -- main | reboot-check | bad-boot-prep | bad-boot-check | rollback-prep | rollback-check | cleanup" >&2; exit 2 ;;
esac </dev/null # pct exec reads stdin, which is where this script arrives
