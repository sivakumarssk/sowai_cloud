// Assigning a server an admin set up by hand (serverSource MANUAL).
//
// The service only becomes ACTIVE after a real SSH login with the given
// credentials succeeds — the same rule the database enforces (sshVerifiedAt).
// Every attempt, passed or failed, is written to the audit log; passwords
// never are.
import { isIP } from "node:net";

export type AssignInput = {
  serverIp: string;
  ipv6Address?: string | null;
  sshPort?: number;
  sshUsername: string;
  sshPassword: string;
  panelUrl?: string | null;
  panelPassword?: string | null;
  notifyCustomer: boolean;
};

export type AssignSnapshot = {
  id: string;
  status: string;
  serverSource: string;
  proxmoxVmId: string | null;
  provisioningPct: number;
  updatedAt: Date;
  serverIp: string | null;
  planName: string;
  customer: string;
};

export type SshCheck = { ok: true; detail: string } | { ok: false; error: string };

export type AssignDeps = {
  load(serviceId: string): Promise<AssignSnapshot | null>;
  sshCheck(target: { host: string; port: number; username: string; password: string }): Promise<SshCheck>;
  /** Writes the server and marks it verified; false if the service changed since it was loaded. */
  save(s: AssignSnapshot, data: AssignedServer): Promise<boolean>;
  notifyCustomer(serviceId: string, input: AssignInput): Promise<void>;
  log(entry: { action: string; serviceId: string; before?: unknown; after?: unknown; success: boolean; error?: string }): Promise<void>;
};

export type AssignedServer = {
  serverSource: "MANUAL";
  status: string;
  serverIp: string;
  ipv6Address: string | null;
  sshUsername: string;
  sshPassword: string;
  panelUrl: string | null;
  panelPassword: string | null;
  sshVerifiedAt: Date;
  provisioningPct: 100;
  provisioningStep: string;
  provisionError: null;
  waitingForNodeSince: null;
};

export type AssignResult = { ok: true; status: string; sshDetail: string } | { ok: false; httpStatus: number; error: string };

const BUILD_RUNNING_MS = 30 * 60_000;

/** Why this service can't take a manual server, or null. */
export function assignRefusal(s: AssignSnapshot, now = new Date()): string | null {
  if (s.status === "CANCELLED" || s.status === "DELETED") return `the service is ${s.status}`;
  if (s.proxmoxVmId) return `it already has Proxmox container ${s.proxmoxVmId} — manage it as a Proxmox server, or delete the container first`;
  const building = s.serverSource === "PROXMOX" && (s.status === "PROVISIONING" || s.status === "INSTALLING") && s.provisioningPct > 0 && s.provisioningPct < 100;
  if (building && now.getTime() - s.updatedAt.getTime() < BUILD_RUNNING_MS) return `a Proxmox build is running (${s.provisioningPct}%) — wait for it to finish or fail`;
  return null;
}

/** Field problems in the form, or null. */
export function inputProblem(input: AssignInput): string | null {
  if (!isIP(input.serverIp.trim())) return "Server IP must be an IPv4 or IPv6 address";
  if (input.ipv6Address && isIP(input.ipv6Address.trim()) !== 6) return "IPv6 address isn't a valid IPv6 address";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(input.sshUsername.trim())) return "SSH username isn't a valid Linux user name";
  if (!input.sshPassword) return "SSH password is required — it's checked by logging in";
  const port = input.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "SSH port must be 1–65535";
  if (input.panelUrl && !/^https?:\/\//i.test(input.panelUrl.trim())) return "Panel URL must start with http:// or https://";
  return null;
}

export async function assignManualServer(serviceId: string, input: AssignInput, by: string, deps: AssignDeps, now = new Date()): Promise<AssignResult> {
  const s = await deps.load(serviceId);
  if (!s) return { ok: false, httpStatus: 404, error: "Service not found" };

  const target = { host: input.serverIp.trim(), port: input.sshPort ?? 22, username: input.sshUsername.trim() };
  const audit = { by, serverIp: target.host, ipv6Address: input.ipv6Address?.trim() || null, sshPort: target.port, sshUsername: target.username, panelUrl: input.panelUrl?.trim() || null };
  const before = { status: s.status, serverSource: s.serverSource, serverIp: s.serverIp };

  const refusal = assignRefusal(s, now) ?? inputProblem(input);
  if (refusal) {
    await deps.log({ action: "SERVER_ASSIGN_REFUSED", serviceId, before, after: audit, success: false, error: refusal });
    return { ok: false, httpStatus: 409, error: refusal };
  }

  const check = await deps.sshCheck({ ...target, password: input.sshPassword });
  if (!check.ok) {
    await deps.log({ action: "SERVER_ASSIGN_SSH_FAILED", serviceId, before, after: audit, success: false, error: check.error });
    return { ok: false, httpStatus: 422, error: `SSH check failed — nothing was changed: ${check.error}` };
  }

  // A service suspended for non-payment gets its server but stays suspended.
  const status = s.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
  const saved = await deps.save(s, {
    serverSource: "MANUAL",
    status,
    serverIp: target.host,
    ipv6Address: audit.ipv6Address,
    sshUsername: target.username,
    sshPassword: input.sshPassword,
    panelUrl: audit.panelUrl,
    panelPassword: input.panelPassword || null,
    sshVerifiedAt: now,
    provisioningPct: 100,
    provisioningStep: "Server is ready!",
    provisionError: null,
    waitingForNodeSince: null,
  });
  if (!saved) {
    const error = "the service changed while the SSH check ran — nothing was saved; try again";
    await deps.log({ action: "SERVER_ASSIGN_REFUSED", serviceId, before, after: { ...audit, ssh: check.detail }, success: false, error });
    return { ok: false, httpStatus: 409, error };
  }
  await deps.log({ action: "SERVER_ASSIGNED", serviceId, before, after: { ...audit, status, ssh: check.detail, notifiedCustomer: input.notifyCustomer }, success: true });
  if (input.notifyCustomer && status === "ACTIVE") await deps.notifyCustomer(serviceId, input);
  return { ok: true, status, sshDetail: check.detail };
}
