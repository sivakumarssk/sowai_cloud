// Making sure a container's disks are really gone — and never destroying one
// that's still in use.
//
// Two sources are checked every time:
//   1. the container's config, current AND pending: rootfs/mpN entries are
//      attached (never destroyed), unusedN entries are detached disks;
//   2. the storage content listing: the file itself.
//
// Proxmox's storage delete (`pvesm free`) does not check whether a disk is in
// use: it unlinks the file even while a running container has it mounted.
// And removing a mount point from a running container is only queued until
// the next restart — the disk stays mounted until then. So a disk is
// destroyed only when no config entry, current or pending, attaches it.
// Nothing here ever restarts a container.

import type { LXCPendingEntry, StorageVolume } from "@/lib/proxmox";
import { DATA_MOUNT_PATH, parseDisk } from "@/engine/actions/lxcConfig";

export type DiskCleanupClient = {
  listContainerStorages(): Promise<string[]>;
  listStorageVolumes(storage: string): Promise<StorageVolume[]>;
  deleteStorageVolume(storage: string, volid: string): Promise<void>;
  /** Current + pending config. Throws "… does not exist" when the container is gone. */
  getLXCPending(vmid: number): Promise<LXCPendingEntry[]>;
  updateLXCConfig(vmid: number, params: Record<string, string | number | boolean | undefined>): Promise<void>;
};

export type ContainerCleanupClient = DiskCleanupClient & { deleteLXC(vmid: number): Promise<void> };

export type StoredDisk = { storage: string; volid: string };

export type DiskCleanupResult = {
  /** Disks this call destroyed (verified gone from storage and config). */
  freed: string[];
  /** Disks still on storage or still listed as unusedN after cleanup — each one is a failure. */
  leftover: string[];
  /** Disks deliberately left alone because a config entry (current or pending) still attaches them. */
  kept: { volid: string; keys: string[] }[];
  /** Errors from individual steps. */
  errors: string[];
};

/** True for vm-<vmid>-disk-N / subvol-<vmid>-disk-N image names, on any storage type. */
export function isContainerDisk(volid: string, vmid: number): boolean {
  return new RegExp(`(?:^|[:/])(?:vm|subvol|base)-${vmid}-disk-\\d+(?:\\.\\w+)?$`).test(volid);
}

/** "local:100/vm-100-disk-1.raw,mp=/data" → the volid; null for a new allocation ("local:10") or a bind mount. */
function volumeOf(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const volume = String(value).split(",")[0];
  return /^[^:/]+:(?!\d+(?:\.\d+)?$).+/.test(volume) ? volume : null;
}

const storageOf = (volid: string) => volid.split(":")[0];

export type DiskReferences = {
  /** False when the container doesn't exist (any more). */
  exists: boolean;
  /** volid → rootfs/mpN keys using it now or after the next restart. Never destroy these. */
  attached: Map<string, string[]>;
  /** volid → unusedN keys (detached disks Proxmox still remembers). */
  unused: Map<string, string[]>;
};

const add = (map: Map<string, string[]>, volid: string | null, key: string) => {
  if (volid) map.set(volid, [...new Set([...(map.get(volid) ?? []), key])]);
};

/** Which disks the container's config refers to — current and pending values both count. */
export async function readDiskReferences(client: Pick<DiskCleanupClient, "getLXCPending">, vmid: number): Promise<DiskReferences> {
  const refs: DiskReferences = { exists: true, attached: new Map(), unused: new Map() };
  let entries: LXCPendingEntry[];
  try {
    entries = await client.getLXCPending(vmid);
  } catch (err) {
    if (err instanceof Error && /does not exist/i.test(err.message)) return { ...refs, exists: false };
    throw err;
  }
  for (const e of entries) {
    const target = /^(rootfs|mp\d+)$/.test(e.key) ? refs.attached : /^unused\d+$/.test(e.key) ? refs.unused : null;
    if (!target) continue;
    add(target, volumeOf(e.value), e.key);
    add(target, volumeOf(e.pending), e.key);
  }
  return refs;
}

/** Every disk for this vmid on every container storage, from the storage listings. */
export async function findContainerDisks(client: Pick<DiskCleanupClient, "listContainerStorages" | "listStorageVolumes">, vmid: number): Promise<StoredDisk[]> {
  const storages = await client.listContainerStorages();
  const perStorage = await Promise.all(
    storages.map(async (storage) =>
      (await client.listStorageVolumes(storage))
        .filter((v) => v.vmid === vmid || isContainerDisk(v.volid, vmid))
        .map((v) => ({ storage, volid: v.volid }))
    )
  );
  return perStorage.flat();
}

/**
 * Destroys this vmid's detached disks (all of them, or only `volids`), then
 * proves they're gone: not in any storage listing and not in any unusedN
 * entry. Disks a config entry still attaches (current or pending) are kept.
 */
export async function freeContainerDisks(client: DiskCleanupClient, vmid: number, volids?: string[]): Promise<DiskCleanupResult> {
  const wanted = (volid: string) => !volids || volids.includes(volid);
  const errors: string[] = [];
  const refs = await readDiskReferences(client, vmid);

  // Candidates: files on storage, plus disks only known from an unusedN entry
  // (their file may be hidden from the listing, e.g. on a storage without "images" content).
  const candidates = new Map<string, string>();
  for (const d of await findContainerDisks(client, vmid)) if (wanted(d.volid)) candidates.set(d.volid, d.storage);
  for (const volid of refs.unused.keys()) if (wanted(volid) && isContainerDisk(volid, vmid) && !candidates.has(volid)) candidates.set(volid, storageOf(volid));

  const kept: DiskCleanupResult["kept"] = [];
  const targets: string[] = [];
  for (const volid of candidates.keys()) {
    const keys = refs.attached.get(volid);
    if (keys) kept.push({ volid, keys });
    else targets.push(volid);
  }

  // 1. Forget unusedN entries first (Proxmox may destroy the file itself when one is removed).
  const failedUnused = new Set<string>();
  for (const volid of targets) {
    const keys = refs.unused.get(volid);
    if (!keys) continue;
    try {
      await client.updateLXCConfig(vmid, { delete: keys.join(",") });
    } catch (err) {
      failedUnused.add(volid);
      errors.push(`${volid}: removing ${keys.join(",")} from the config failed: ${message(err)}`);
    }
  }

  // 2. Destroy what's still on storage — unless removing its unusedN entry failed (keep config and storage consistent).
  const stillListed = new Set((await findContainerDisks(client, vmid)).map((d) => d.volid));
  for (const volid of targets) {
    if (!stillListed.has(volid) || failedUnused.has(volid)) continue;
    try {
      await client.deleteStorageVolume(candidates.get(volid)!, volid);
    } catch (err) {
      errors.push(`${volid}: ${message(err)}`);
    }
  }

  // 3. Verify against both sources.
  const listedAfter = new Set((await findContainerDisks(client, vmid)).map((d) => d.volid));
  const refsAfter = refs.exists ? await readDiskReferences(client, vmid) : refs;
  const leftover = targets.filter((v) => listedAfter.has(v) || refsAfter.unused.has(v));
  return { freed: targets.filter((v) => !leftover.includes(v)), leftover, kept, errors };
}

/**
 * Deletes a container and every disk it ever had, then verifies no
 * vm-<vmid>-* file is left on any container storage. Safe to repeat: a
 * container that no longer exists still gets its leftover disks cleaned.
 */
export async function destroyContainerAndDisks(client: ContainerCleanupClient, vmid: number): Promise<DiskCleanupResult> {
  await client.deleteLXC(vmid);
  return freeContainerDisks(client, vmid);
}

export type DataDetachResult =
  /** No /data mount. `unused` lists detached disks still remembered in the config. */
  | { status: "NO_DATA"; unused: string[] }
  /** Removal (or a queued /data addition) waits for the next restart. Nothing was destroyed. */
  | { status: "PENDING_RESTART"; key: string; volume: string | null; detail: string }
  | { status: "REMOVED"; key: string; volume: string; cleanup: DiskCleanupResult };

/**
 * Removes the /data mount point and, only once it's really detached,
 * destroys its disk. On a running container Proxmox queues the removal until
 * the next restart: then nothing is destroyed and the disk stays in place.
 * Never restarts the container.
 */
export async function detachDataDisk(client: DiskCleanupClient, vmid: number): Promise<DataDetachResult> {
  const entries = await client.getLXCPending(vmid);
  const isData = (v: string | number | undefined) => v !== undefined && parseDisk("mp", String(v)).mountPath === DATA_MOUNT_PATH;
  const current = entries.find((e) => /^mp\d+$/.test(e.key) && isData(e.value));

  if (!current) {
    const queued = entries.find((e) => /^mp\d+$/.test(e.key) && isData(e.pending));
    if (queued) return { status: "PENDING_RESTART", key: queued.key, volume: volumeOf(queued.pending), detail: `adding ${queued.key} (${queued.pending}) is queued until the container restarts` };
    const unused = entries.filter((e) => /^unused\d+$/.test(e.key)).map((e) => `${e.key}: ${e.value}`);
    return { status: "NO_DATA", unused };
  }

  const volume = volumeOf(current.value)!;
  if (current.delete) return { status: "PENDING_RESTART", key: current.key, volume, detail: `removal of ${current.key} is already queued until the container restarts` };

  await client.updateLXCConfig(vmid, { delete: current.key });
  const after = (await client.getLXCPending(vmid)).find((e) => e.key === current.key);
  if (after?.value !== undefined) {
    return { status: "PENDING_RESTART", key: current.key, volume, detail: `removal of ${current.key} is queued until the container restarts` };
  }
  return { status: "REMOVED", key: current.key, volume, cleanup: await freeContainerDisks(client, vmid, [volume]) };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
