export type ProvisioningInput = {
  serviceId: string;
  hostname: string;
  region: string;
  osImage: string;
  stackPreset: string;
  planName: string;
};

export type ProvisioningResult = {
  serverIp: string;
  sshUsername: string;
  sshPassword: string;
  panelUrl?: string;
};

/**
 * Abstraction over "turn a paid-for service into a running server."
 * SimulatedProvider fakes this today; a HetznerProxmoxProvider (or similar)
 * implements the same interface later with no changes to call sites.
 */
export interface ProvisioningProvider {
  provision(input: ProvisioningInput): Promise<ProvisioningResult>;
}
