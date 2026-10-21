// Making sure a container's disks are really gone.
//
// The only source of truth is the storage content listing: a container's
// config can stop referencing a disk (e.g. a /data mount detached from a
// running container leaves no "unused" entry) while the file still exists.

import type { StorageVolume } from "@/lib/proxmox";

export type DiskCleanupClient = {
  listContainerStorages(): Promise<string[]>;
  listStorageVolumes(storage: string): Promise<StorageVolume[]>;
  deleteStorageVolume(storage: string, volid: string): Promise<void>;
};

export type ContainerCleanupClient = DiskCleanupClient & { deleteLXC(vmid: number): Promise<void> };

export type StoredDisk = { storage: string; volid: string };

export type DiskCleanupResult = {
  /** Disks this call destroyed. */
  freed: string[];
  /** Disks still on storage after cleanup (each one is a failure). */
  leftover: string[];
  /** Errors from individual delete attempts. */
  errors: string[];
};

/** True for vm-<vmid>-disk-N / subvol-<vmid>-disk-N image names, on any storage type. */
export function isContainerDisk(volid: string, vmid: number): boolean {
  return new RegExp(`(?:^|[:/])(?:vm|subvol|base)-${vmid}-disk-\\d+(?:\\.\\w+)?$`).test(volid);
}

/** Every disk for this vmid on every container storage, read from the storage listings. */
export async function findContainerDisks(client: DiskCleanupClient, vmid: number): Promise<StoredDisk[]> {
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
 * Destroys this vmid's disks (all of them, or only `volids`) through the
 * storage API, then re-reads the storage listings to prove they're gone.
 */
export async function freeContainerDisks(client: DiskCleanupClient, vmid: number, volids?: string[]): Promise<DiskCleanupResult> {
  const wanted = (d: StoredDisk) => !volids || volids.includes(d.volid);
  const targets = (await findContainerDisks(client, vmid)).filter(wanted);
  const freed: string[] = [];
  const errors: string[] = [];

  for (const disk of targets) {
    try {
      await client.deleteStorageVolume(disk.storage, disk.volid);
      freed.push(disk.volid);
    } catch (err) {
      errors.push(`${disk.volid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const leftover = (await findContainerDisks(client, vmid)).filter(wanted).map((d) => d.volid);
  return { freed: freed.filter((v) => !leftover.includes(v)), leftover, errors };
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
