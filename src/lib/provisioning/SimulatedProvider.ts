import type { ProvisioningProvider, ProvisioningInput, ProvisioningResult } from "./ProvisioningProvider";

function randomOctet() {
  return Math.floor(Math.random() * 254) + 1;
}

function randomPassword(length = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fakes real VM provisioning with a realistic delay and plausible-looking
 * output. Swap this for a HetznerProxmoxProvider (same interface) once real
 * infrastructure calls are wired up.
 */
export class SimulatedProvider implements ProvisioningProvider {
  async provision(input: ProvisioningInput): Promise<ProvisioningResult> {
    // Simulate the time a real Proxmox clone + cloud-init run would take.
    await sleep(4000 + Math.random() * 4000);

    const serverIp = `${randomOctet()}.${randomOctet()}.${randomOctet()}.${randomOctet()}`;
    const sshUsername = "root";
    const sshPassword = randomPassword();
    const panelUrl = input.stackPreset === "wordpress" ? `http://${serverIp}/wp-admin` : undefined;

    return { serverIp, sshUsername, sshPassword, panelUrl };
  }
}
