import type { HetznerService } from "@/lib/hetzner";
import type { InstallDeps } from "./installNode";

/** Type + base64 body of an OpenSSH public key (the comment doesn't count). */
export const keyId = (publicKey: string) => publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

/** Names the installer gives its own entry (a suffix when the name was taken). No other key is ever removed. */
export const isInstallKeyEntry = (name: string) => /^sowsi-install(-\d+)?$/.test(name);

/** The Hetzner calls the installer makes. Tests run this same code against a simulated Hetzner. */
export function installHetznerApi(hetzner: HetznerService): InstallDeps["hetzner"] {
  return {
    getServerType: (name) => hetzner.getServerType(name),
    ipPrices: (location) => hetzner.ipPrices(location),
    findServerByName: (n) => hetzner.findServerByName(n),
    getServer: (id) => hetzner.getServer(id),
    createServer: (i) => hetzner.createServer(i),
    deleteServer: (id) => hetzner.deleteServer(id),
    enableRescue: (id, keys) => hetzner.enableRescue(id, keys),
    disableRescue: (id) => hetzner.disableRescue(id),
    resetServer: (id) => hetzner.resetServer(id),
    async ensureSshKey(name, publicKey) {
      const keys = await hetzner.listSshKeys();
      const existing = keys.find((k) => keyId(k.publicKey) === keyId(publicKey));
      if (existing) return { id: existing.id, created: false };
      // Names are unique in a project: an old entry under the same name with another key gets a suffix.
      const taken = keys.some((k) => k.name === name);
      const created = await hetzner.createSshKey(taken ? `${name}-${Date.now()}` : name, publicKey, { "sowsi-key": name });
      return { id: created.id, created: true };
    },
    async removeInstallKeys() {
      const removed: string[] = [];
      for (const key of (await hetzner.listSshKeys()).filter((k) => isInstallKeyEntry(k.name))) {
        await hetzner.deleteSshKey(key.id);
        removed.push(key.name);
      }
      return { removed, left: (await hetzner.listSshKeys()).filter((k) => isInstallKeyEntry(k.name)).map((k) => `${k.name} (${k.id})`) };
    },
    buyFloatingIP: (label, location) => hetzner.buyFloatingIP(label, location),
    assignFloatingIP: (id, serverId) => hetzner.assignFloatingIP(id, serverId),
    releaseFloatingIP: (id) => hetzner.releaseFloatingIP(id),
    floatingIpExists: async (id) => (await hetzner.getFloatingIP(id)) !== null,
  };
}
