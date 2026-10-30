// What runs inside the Hetzner rescue system when a new node doesn't come back
// from its first reboot, and how its output is read. Pure: no SSH here.
import { interfacesFile, LINK_FILE, linkFile, parseFacts, sha256 } from "./nodeScripts";

export { LINK_FILE, linkFile };

/** Where the node's own disk is mounted in the rescue system. */
export const ROOT = "/mnt/sowsi-root";
export const LSBLK_COMMAND = "lsblk -J -b -o NAME,PATH,LABEL,SIZE,FSTYPE,TYPE,MOUNTPOINT";

type BlockDevice = { path?: string; name?: string; label?: string | null; size?: number | string; fstype?: string | null; type?: string; mountpoint?: string | null; children?: BlockDevice[] };

const MIN_ROOT_BYTES = 5 * 1024 ** 3;
const ROOT_LABELS = /^(cloudimg-rootfs|rootfs|root)$/i;
const ROOT_FILESYSTEMS = new Set(["ext4", "xfs", "btrfs"]);

/**
 * Partitions that could be the node's root, best first: a root-like label, then
 * size. Never a fixed device name. Each is confirmed by its contents once mounted.
 */
export function rootCandidates(lsblkJson: string): string[] {
  const flatten = (d: BlockDevice): BlockDevice[] => [d, ...(d.children ?? []).flatMap(flatten)];
  const devices = ((JSON.parse(lsblkJson) as { blockdevices?: BlockDevice[] }).blockdevices ?? []).flatMap(flatten);
  return devices
    .filter((d) => d.type === "part" && d.path && ROOT_FILESYSTEMS.has(d.fstype ?? "") && !d.mountpoint && Number(d.size) >= MIN_ROOT_BYTES)
    .sort((a, b) => Number(ROOT_LABELS.test(b.label ?? "")) - Number(ROOT_LABELS.test(a.label ?? "")) || Number(b.size) - Number(a.size))
    .map((d) => d.path!);
}

/** Read-only, and only keeps it mounted if it really is this system's root. Prints root=ok or root=no. */
export function mountRootScript(device: string): string {
  if (!/^\/dev\/[\w/.-]+$/.test(device)) throw new Error(`unexpected device "${device}"`);
  return `R=${ROOT}
mkdir -p "$R"
mountpoint -q "$R" && umount "$R"
if ! mount -o ro '${device}' "$R"; then echo "root=no"; exit 0; fi
if [ -f "$R/etc/debian_version" ] && [ -f "$R/etc/network/interfaces" ] && [ -d "$R/boot" ]; then echo "root=ok"; else umount "$R"; echo "root=no"; fi`;
}

export const UNMOUNT_SCRIPT = `sync; umount ${ROOT} 2>/dev/null || umount -l ${ROOT} 2>/dev/null || true`;

/**
 * Everything worth knowing about why the node has no network. Reads only.
 * Key facts come last, as sowsi_* lines. `root` "" reads the running system instead of a mounted disk.
 */
export function diagnosticsScript(root: string = ROOT): string {
  return `R=${root}
section() { echo; echo "=== $1"; }
show() { for f in "$@"; do [ -e "$f" ] || continue; echo "--- $f"; cat "$f" 2>&1; done; }
journal() { journalctl -D "$R/var/log/journal" --no-pager "$@" 2>&1; }

section "lsblk -f"; lsblk -f 2>&1
section "/etc/network/interfaces"; show "$R/etc/network/interfaces"
section "/etc/network/interfaces.d"; show "$R"/etc/network/interfaces.d/*
section "systemd network files"; show "$R"/etc/systemd/network/*
section "udev rules"; show "$R"/etc/udev/rules.d/*.rules
section "cloud-init network config"; show "$R"/etc/cloud/cloud.cfg.d/*
section "kernel command line and GRUB"; grep -hE '^GRUB_CMDLINE' "$R"/etc/default/grub "$R"/etc/default/grub.d/* 2>/dev/null; grep -m3 -E '^[[:space:]]*linux' "$R/boot/grub/grub.cfg" 2>/dev/null
section "cards on the rescue system"; for d in /sys/class/net/*; do n=\${d##*/}; [ "$n" = lo ] && continue; echo "$n $(cat "$d/address")"; done; ip -br link 2>&1
section "journalctl --list-boots"; [ -d "$R/var/log/journal" ] && journal --list-boots || echo "no persistent journal on this disk"
section "failed boot: networking, ifup, ifreload, vmbr0, renamed, Failed"
[ -d "$R/var/log/journal" ] && journal -b 0 -o short-iso | grep -Ei 'networking|ifup|ifreload|vmbr0|renamed|failed' | tail -200
section "ifupdown2 log"; ls -t "$R"/var/log/ifupdown2 2>/dev/null | head -3
section "ufw log setting"; grep -E '^(ENABLED|LOGLEVEL)' "$R/etc/ufw/ufw.conf" 2>&1
section "DNS"; ls -l "$R/etc/resolv.conf" 2>&1; cat "$R/etc/resolv.conf" 2>&1
section "IPv6 on this system"; ip -6 addr 2>&1; ip -6 route 2>&1; ip -6 neigh 2>&1

section "facts"
ports=$(awk '$1=="bridge-ports"{print $2; exit}' "$R/etc/network/interfaces")
mac=$(awk -F= '$1=="MACAddress"{print $2; exit}' "$R${LINK_FILE}" 2>/dev/null | tr 'A-Z' 'a-z')
[ -n "$mac" ] || mac=$(awk '$1=="hwaddress"{print $NF; exit}' "$R/etc/network/interfaces" | tr 'A-Z' 'a-z')
pinned=$(awk -F= '$1=="Name"{print $2; exit}' "$R${LINK_FILE}" 2>/dev/null)
dev=""; count=0; only=""
for d in /sys/class/net/*; do
  n=\${d##*/}; [ "$n" = lo ] && continue
  [ -e "$d/device" ] || continue
  count=$((count + 1)); only=$n
  [ "$(cat "$d/address")" = "$mac" ] && dev=$n
done
[ -z "$mac" ] && [ "$count" = 1 ] && dev=$only && mac=$(cat "/sys/class/net/$dev/address")
udev=""
if [ -n "$dev" ]; then
  udev=$(udevadm info -q property -p "/sys/class/net/$dev" 2>/dev/null | sed -n 's/^ID_NET_NAME_PATH=//p')
  [ -n "$udev" ] || udev=$(udevadm test-builtin net_id "/sys/class/net/$dev" 2>/dev/null | sed -n 's/^ID_NET_NAME_PATH=//p')
fi
named=""; porterr=0
if [ -d "$R/var/log/journal" ]; then
  named=$(journal -b 0 | grep -oE '[a-z][a-z0-9]+: renamed from eth[0-9]+' | tail -1 | cut -d: -f1)
  [ -n "$ports" ] && porterr=$(journal -b 0 | grep -Eic "$ports.*(does not exist|not found|no such|cannot find)")
fi
echo "sowsi_bridge_ports=$ports"
echo "sowsi_mac=$mac"
echo "sowsi_rescue_dev=$dev"
echo "sowsi_name_udev=$udev"
echo "sowsi_name_pin=$pinned"
echo "sowsi_name_journal=$named"
echo "sowsi_port_errors=$porterr"
echo "sowsi_journal=$([ -d "$R/var/log/journal" ] && echo yes || echo no)"
echo "sowsi_images=$(ls "$R/var/lib/vz/images" 2>/dev/null | tr '\\n' ' ')"`;
}

export type Diagnosis = {
  cause: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  /** Null = there's no evidence a network rewrite would help, so nothing is changed. */
  repair: { nic: string; mac: string } | null;
};

/** The cause, from the collected output only. */
export function diagnose(text: string): Diagnosis {
  const f = parseFacts(text);
  const ports = f.sowsi_bridge_ports ?? "";
  // What the kernel really did, then what the pin says, then the name udev would pick.
  const real = f.sowsi_name_journal || f.sowsi_name_pin || f.sowsi_name_udev || "";
  const evidence = [
    `bridge-ports in /etc/network/interfaces: ${ports || "none"}`,
    `card MAC ${f.sowsi_mac || "unknown"}, ${f.sowsi_rescue_dev ? `found as ${f.sowsi_rescue_dev} on the rescue system` : "not found on the rescue system"}`,
    `its name on the node's own kernel: ${f.sowsi_name_journal ? `${f.sowsi_name_journal} (failed boot's journal)` : "not in the journal"}; pinned: ${f.sowsi_name_pin || "no"}; udev path name: ${f.sowsi_name_udev || "none"}`,
    `journal lines saying ${ports || "the port"} is missing: ${f.sowsi_port_errors ?? "0"}`,
  ];
  const usable = Boolean(f.sowsi_rescue_dev && f.sowsi_mac);
  if (!ports || !real || !usable) {
    return { cause: "Can't tell: the bridge port, the card or its real name couldn't be read.", confidence: "low", evidence, repair: null };
  }
  if (ports === real) {
    return { cause: `vmbr0 already names the real card (${real}), so a wrong port name isn't the cause.`, confidence: "low", evidence, repair: null };
  }
  const confirmed = Boolean(f.sowsi_name_journal) || Number(f.sowsi_port_errors) > 0;
  return {
    cause: `vmbr0 is bridged to ${ports}, but on the Proxmox kernel the card is named ${real}. The bridge came up with no port, so the server had no network.`,
    confidence: confirmed ? "high" : "medium",
    evidence,
    repair: { nic: real, mac: f.sowsi_mac },
  };
}

export type RepairPlan = { nic: string; mac: string; ipv4: string; stamp: string };

/**
 * The repair: backs up what it replaces, writes the two files, rebuilds the initramfs so the
 * pin holds from early boot. The interfaces file arrives on stdin. Nothing else on the disk changes.
 */
export function repairScript({ nic, mac, stamp }: RepairPlan): string {
  if (!/^[a-z][a-z0-9]{1,14}$/.test(nic)) throw new Error(`unexpected card name "${nic}"`);
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new Error(`unexpected MAC "${mac}"`);
  if (!/^[\w.-]+$/.test(stamp)) throw new Error(`unexpected stamp "${stamp}"`);
  return `set -euo pipefail
R=${ROOT}
SUFFIX=sowsi-before-repair-${stamp}
mount -o remount,rw "$R"
cp -a "$R/etc/network/interfaces" "$R/etc/network/interfaces.$SUFFIX"
if [ -e "$R${LINK_FILE}" ]; then cp -a "$R${LINK_FILE}" "$R${LINK_FILE}.$SUFFIX"; fi
cat > "$R/etc/network/interfaces"
mkdir -p "$R/etc/systemd/network"
cat > "$R${LINK_FILE}" <<'EOF'
${linkFile({ nic, mac }).trimEnd()}
EOF
trap 'for d in run dev sys proc; do umount -l "$R/$d" 2>/dev/null || true; done' EXIT
for d in proc sys dev run; do mount --bind "/$d" "$R/$d"; done
chroot "$R" update-initramfs -u -k all
pin=yes
for f in "$R"/boot/initrd.img-*; do chroot "$R" lsinitramfs "\${f#"$R"}" | grep -q '10-sowsi-uplink.link' || pin=no; done
sync
echo "sowsi_backup=/etc/network/interfaces.$SUFFIX"
echo "sowsi_interfaces_sha=$(sha256sum "$R/etc/network/interfaces" | cut -d' ' -f1)"
echo "sowsi_link_sha=$(sha256sum "$R${LINK_FILE}" | cut -d' ' -f1)"
echo "sowsi_initrd_pin=$pin"`;
}

/** Problems with what the repair reports having written. */
export function checkRepair(output: string, plan: RepairPlan): string[] {
  const f = parseFacts(output);
  const problems: string[] = [];
  if (f.sowsi_interfaces_sha !== sha256(interfacesFile(plan))) problems.push("/etc/network/interfaces isn't exactly the repaired config");
  if (f.sowsi_link_sha !== sha256(linkFile(plan))) problems.push(`${LINK_FILE} isn't exactly what was written`);
  if (f.sowsi_initrd_pin !== "yes") problems.push("the name pin isn't in every initramfs");
  if (!f.sowsi_backup) problems.push("no backup of the original interfaces file was reported");
  return problems;
}
