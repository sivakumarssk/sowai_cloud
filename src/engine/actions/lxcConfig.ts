// Parsing Proxmox LXC disk config, e.g.
//   rootfs: "local:100/vm-100-disk-0.raw,size=20G"
//   mp0:    "local:100/vm-100-disk-1.raw,mp=/data,backup=1,size=10G"

export const DATA_MOUNT_PATH = "/data";
const MAX_MOUNT_POINTS = 256; // Proxmox allows mp0 … mp255

export type DiskEntry = { key: string; storage: string; volume: string; sizeGB: number; mountPath: string | null };

/** "20G" → 20, "512M" → 0.5, "1T" → 1024. Unknown → 0. */
export function sizeToGB(size: string | undefined): number {
  const m = size?.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT])?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  switch ((m[2] ?? "G").toUpperCase()) {
    case "K":
      return n / 1024 ** 2;
    case "M":
      return n / 1024;
    case "T":
      return n * 1024;
    default:
      return n;
  }
}

export function parseDisk(key: string, value: string): DiskEntry {
  const [volume, ...opts] = String(value).split(",");
  const options = Object.fromEntries(opts.map((o) => o.split("=") as [string, string]));
  return {
    key,
    storage: volume.split(":")[0],
    volume,
    sizeGB: sizeToGB(options.size),
    mountPath: key === "rootfs" ? "/" : options.mp ?? null,
  };
}

export type ContainerDisks = {
  root: DiskEntry;
  /** The mount at /data, if any. */
  data: DiskEntry | null;
  /** First unused mpN key, for creating /data. */
  freeMountKey: string | null;
  /** Disk changes Proxmox has queued until the container restarts (e.g. a mount point removal or addition). */
  pending: PendingDiskChange[];
};

/** `to` null = the key is removed at the next restart. */
export type PendingDiskChange = { key: string; from: string | null; to: string | null };

/** One key from GET …/lxc/{vmid}/pending (same shape as LXCPendingEntry in lib/proxmox). */
type PendingEntry = { key: string; value?: string | number; pending?: string | number; delete?: number };

const DISK_KEY = /^(rootfs|mp\d+)$/;

/** The config as the container runs now, from a pending listing. */
export function currentConfig(entries: PendingEntry[]): Record<string, string | number> {
  return Object.fromEntries(entries.filter((e) => e.value !== undefined).map((e) => [e.key, e.value!]));
}

/** Disk keys whose change only takes effect at the next restart. */
export function pendingDiskChanges(entries: PendingEntry[]): PendingDiskChange[] {
  return entries
    .filter((e) => DISK_KEY.test(e.key) && (Boolean(e.delete) || (e.pending !== undefined && String(e.pending) !== String(e.value ?? ""))))
    .map((e) => ({ key: e.key, from: e.value === undefined ? null : String(e.value), to: e.delete ? null : String(e.pending) }));
}

/**
 * Disks as the container runs now. Pass the pending listing to also learn
 * what's queued for the next restart; never read pending values as current.
 */
export function readContainerDisks(config: Record<string, string | number>, pendingEntries: PendingEntry[] = []): ContainerDisks {
  if (!config.rootfs) throw new Error("container config has no rootfs");
  const root = parseDisk("rootfs", String(config.rootfs));
  const mounts = Object.entries(config)
    .filter(([k]) => /^mp\d+$/.test(k))
    .map(([k, v]) => parseDisk(k, String(v)));
  const data = mounts.find((m) => m.mountPath === DATA_MOUNT_PATH) ?? null;
  const taken = new Set([...Object.keys(config), ...pendingEntries.map((e) => e.key)]);
  let freeMountKey: string | null = null;
  for (let i = 0; i < MAX_MOUNT_POINTS; i++) {
    if (!taken.has(`mp${i}`)) {
      freeMountKey = `mp${i}`;
      break;
    }
  }
  return { root, data, freeMountKey, pending: pendingDiskChanges(pendingEntries) };
}

export const describePending = (changes: PendingDiskChange[]) =>
  changes.map((c) => (c.to === null ? `remove ${c.key}` : c.from === null ? `add ${c.key}: ${c.to}` : `change ${c.key}: ${c.to}`)).join("; ");
