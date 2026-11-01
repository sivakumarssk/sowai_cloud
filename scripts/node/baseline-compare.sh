#!/usr/bin/env bash
# Read-only: what a hand-built node lacks compared with one from install-node.ts.
# Changes nothing on the node and prints no keys. Run it on node 1 and on a fresh node, then diff.
set -u
has() { printf '%-30s %s\n' "$1" "$2"; }
yes_no() { if "$@" >/dev/null 2>&1; then echo yes; else echo NO; fi; }

echo "=== boot guard (sowsi-net-guard)"
has "script present" "$(yes_no test -x /usr/local/sbin/sowsi-net-guard)"
has "settings present" "$(yes_no test -f /etc/sowsi-net-guard.conf)"
has "unit enabled" "$(systemctl is-enabled sowsi-net-guard.service 2>/dev/null || echo NO)"
sha256sum /usr/local/sbin/sowsi-net-guard 2>/dev/null

echo; echo "=== card name pin"
has "link file present" "$(yes_no test -f /etc/systemd/network/10-sowsi-uplink.link)"
sha256sum /etc/systemd/network/10-sowsi-uplink.link 2>/dev/null
has "in the initramfs" "$(lsinitramfs "/boot/initrd.img-$(uname -r)" 2>/dev/null | grep -c 10-sowsi-uplink.link)"
ip -br link

echo; echo "=== persistent journal"
has "drop-in present" "$(yes_no test -f /etc/systemd/journald.conf.d/00-sowsi.conf)"
has "/var/log/journal exists" "$(yes_no test -d /var/log/journal)"
journalctl --list-boots 2>/dev/null | wc -l | sed 's/^/boots kept: /'

echo; echo "=== DNS"
has "resolv.conf is a link" "$(if test -L /etc/resolv.conf; then readlink /etc/resolv.conf; else echo no; fi)"
grep -E '^(nameserver|options)' /etc/resolv.conf
grep -n 'dns-nameservers' /etc/network/interfaces
ls /etc/network/interfaces.d/ 2>/dev/null

echo; echo "=== firewall and SSH"
ufw status verbose 2>/dev/null | grep -E '^(Status|Logging|Default):'
has "fail2ban active" "$(systemctl is-active fail2ban 2>/dev/null)"
has "fail2ban sshd jail" "$(yes_no fail2ban-client status sshd)"
has "sowsi fail2ban jail file" "$(yes_no test -f /etc/fail2ban/jail.d/sowsi-sshd.conf)"
has "sowsi sshd drop-in" "$(yes_no test -f /etc/ssh/sshd_config.d/00-sowsi.conf)"
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
ls /etc/ssh/sshd_config.d/ 2>/dev/null

echo; echo "=== forwarding settings saved"
grep -s '^net\.' /etc/sysctl.d/99-sowsi-routing.conf
grep -c 'post-up sysctl' /etc/network/interfaces | sed 's/^/post-up sysctl lines: /'

echo; echo "=== end"
