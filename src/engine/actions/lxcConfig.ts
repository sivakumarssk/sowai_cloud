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
};

export function readContainerDisks(config: Record<string, string | number>): ContainerDisks {
  if (!config.rootfs) throw new Error("container config has no rootfs");
  const root = parseDisk("rootfs", String(config.rootfs));
  const mounts = Object.entries(config)
    .filter(([k]) => /^mp\d+$/.test(k))
    .map(([k, v]) => parseDisk(k, String(v)));
  const data = mounts.find((m) => m.mountPath === DATA_MOUNT_PATH) ?? null;
  let freeMountKey: string | null = null;
  for (let i = 0; i < MAX_MOUNT_POINTS; i++) {
    if (!(`mp${i}` in config)) {
      freeMountKey = `mp${i}`;
      break;
    }
  }
  return { root, data, freeMountKey };
}
