import type { HetznerService } from "@/lib/hetzner";
import type { InstallDeps } from "./installNode";

/** Type + base64 body of an OpenSSH public key (the comment doesn't count). */
export const keyId = (publicKey: string) => publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

/** The Hetzner calls the installer makes. Tests run this same code against a simulated Hetzner. */
export function installHetznerApi(hetzner: HetznerService): InstallDeps["hetzner"] {
  return {
    getServerType: (name) => hetzner.getServerType(name),
    ipPrices: (location) => hetzner.ipPrices(location),
    findServerByName: (n) => hetzner.findServerByName(n),
    getServer: (id) => hetzner.getServer(id),
    createServer: (i) => hetzner.createServer(i),
    deleteServer: (id) => hetzner.deleteServer(id),
    async ensureSshKey(name, publicKey) {
      const keys = await hetzner.listSshKeys();
      const existing = keys.find((k) => keyId(k.publicKey) === keyId(publicKey));
      if (existing) return { id: existing.id, created: false };
      // Names are unique in a project: an old entry under the same name with another key gets a suffix.
      const taken = keys.some((k) => k.name === name);
      const created = await hetzner.createSshKey(taken ? `${name}-${Date.now()}` : name, publicKey, { "sowsi-key": name });
      return { id: created.id, created: true };
    },
    async removeSshKey(publicKey) {
      const existing = (await hetzner.listSshKeys()).find((k) => keyId(k.publicKey) === keyId(publicKey));
      if (!existing) return false;
      await hetzner.deleteSshKey(existing.id);
      return true;
    },
    buyFloatingIP: (label, location) => hetzner.buyFloatingIP(label, location),
    assignFloatingIP: (id, serverId) => hetzner.assignFloatingIP(id, serverId),
    releaseFloatingIP: (id) => hetzner.releaseFloatingIP(id),
    floatingIpExists: async (id) => (await hetzner.getFloatingIP(id)) !== null,
  };
}
