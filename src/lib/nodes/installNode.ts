// Turning a fresh Debian 12 Hetzner Cloud server into a Proxmox node (Stage 2).
//
// Plan first (prints cost and every check); --execute buys the server and runs
// the steps in order, recording each one, so a re-run resumes at the first
// step that didn't finish. Any failure before the node is registered deletes
// the server (unless --keep-on-failure) — never one that holds a customer's
// container. The new node is registered closed (PROVISIONING, no new clients).
//
// Not wired to the engine or approvals: only scripts/node/install-node.ts calls this.
import { serverTypeOffer, type ApiServerType, type HetznerPrice, type HetznerServer, type ServerDeleted } from "@/lib/hetzner";
import { ipv6ForVmid } from "@/lib/provisioning/nodeTarget";
import * as S from "./nodeScripts";
import { rescueDiagnoseAgain, rescueRefusal, rescueRepair, type RescueArgs } from "./rescueRepair";
import { diagnosticsScript } from "./rescueScripts";

// ── Dependencies (real ones in installNodeDeps.ts, fakes in the tests) ──

export type Shell = {
  /** Runs a command; throws on a non-zero exit (with the last lines of output). */
  exec(label: string, command: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<string>;
  close(): void;
};

export class SshAuthError extends Error {}
export class HostKeyMismatchError extends Error {}

export type ContainerApi = {
  getVersion(): Promise<{ version: string }>;
  getNodeStatus(): Promise<{ memory: { total: number }; cpus: number }>;
  getStorageStatus(storage: string): Promise<{ total: number }>;
  getNextVMID(): Promise<number>;
  listLXC(): Promise<{ vmid: number; name?: string; status: string }[]>;
  createLXC(input: { vmid: number; hostname: string; cores: number; memory: number; diskSize: number; osTemplate: string; ipv4?: string; ipv6?: string; start?: boolean }): Promise<unknown>;
  waitForLXC(vmid: number): Promise<void>;
  /** destroyContainerAndDisks: deletes it and proves no disk is left. */
  destroyContainer(vmid: number): Promise<{ leftover: string[]; errors: string[] }>;
};

export type InstallRecord = {
  id: string;
  name: string;
  serverType: string;
  location: string;
  status: "IN_PROGRESS" | "REGISTERED" | "FAILED" | "DESTROYED";
  hetznerServerId: string | null;
  ipv4: string | null;
  ipv6Subnet: string | null;
  hostKeySha256: string | null;
  /** boot_id just before the reboot into Proxmox (the reboot step waits for a different one). */
  bootIdBeforeReboot: string | null;
  repairedAt: Date | null;
  purchasedAt: Date | null;
  /** The real cost of a server that was deleted: set once, when the monthly price is corrected. */
  costSettledPaise: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedSteps: string[];
  /** Encrypted. */
  apiTokenSecret: string | null;
  testFloatingIpId: string | null;
  monthlyCostPaise: number;
  hourlyCostPaise: number;
  approvedBy: string;
  error: string | null;
};

export type NodeRegistration = {
  name: string;
  ip: string;
  hetznerServerId: string;
  location: string;
  ipv6Subnet: string;
  physicalRamMB: number;
  physicalDiskGB: number;
  physicalCpu: number;
  monthlyCost: number;
  apiTokenId: string;
  /** Encrypted. */
  apiTokenSecret: string;
};

export type InstallDeps = {
  hetzner: {
    getServerType(name: string): Promise<ApiServerType | null>;
    ipPrices(location: string): Promise<{ primaryIpv4: HetznerPrice | null; floatingIpv4MonthlyEur: number | null }>;
    findServerByName(name: string): Promise<HetznerServer | null>;
    getServer(id: number): Promise<HetznerServer | null>;
    createServer(input: { name: string; serverType: string; location: string; image: string; sshKeyIds: number[]; labels: Record<string, string> }): Promise<HetznerServer>;
    deleteServer(id: number): Promise<ServerDeleted>;
    enableRescue(id: number, sshKeyIds: number[]): Promise<void>;
    disableRescue(id: number): Promise<void>;
    resetServer(id: number): Promise<void>;
    /** The project's SSH key entry for this public key, registering it under `name` if missing. */
    ensureSshKey(name: string, publicKey: string): Promise<{ id: number; created: boolean }>;
    /** Removes the installer's own key entries, then lists again: `left` is what's still there. Never any other key. */
    removeInstallKeys(): Promise<{ removed: string[]; left: string[] }>;
    buyFloatingIP(label: string, location: string): Promise<{ id: number; ip: string }>;
    assignFloatingIP(id: number, serverId: number): Promise<void>;
    releaseFloatingIP(id: number): Promise<void>;
    floatingIpExists(id: number): Promise<boolean>;
  };
  keys: {
    /** Public half of the install key; creates the pair on sowsi-mgmt-01 the first time (`create`). */
    installPublicKey(create: boolean): Promise<string | null>;
    adminPublicKey: string | null;
    provisioningPublicKey: string | null;
  };
  /** SSH as root. Pins the host key on first contact (`hostKeySha256` null) and refuses a different one later. */
  ssh(host: string, key: "install" | "provisioning", opts: { hostKeySha256: string | null; timeoutMs: number }): Promise<{ shell: Shell; hostKeySha256: string }>;
  /** SSH into the test container as root with the provisioning key. */
  containerShell(host: string, timeoutMs: number): Promise<Shell>;
  /** scripts/proxmox-host-setup.sh, read on sowsi-mgmt-01. */
  hostSetupScript(): string;
  /** `routes` through the host's sowsi-host dispatcher (provisioning key). */
  syncRoutes(host: string): Promise<string>;
  proxmox(node: { name: string; ip: string }, token: { tokenId: string; secret: string }): ContainerApi;
  db: {
    findInstall(name: string): Promise<InstallRecord | null>;
    findInstallByServer(serverId: string): Promise<InstallRecord | null>;
    createInstall(data: Omit<InstallRecord, "id" | "status" | "completedSteps" | "error" | "hetznerServerId" | "ipv4" | "ipv6Subnet" | "hostKeySha256" | "bootIdBeforeReboot" | "repairedAt" | "purchasedAt" | "costSettledPaise" | "createdAt" | "updatedAt" | "apiTokenSecret" | "testFloatingIpId">): Promise<InstallRecord>;
    updateInstall(id: string, data: Partial<InstallRecord>): Promise<InstallRecord>;
    /** The registered node on this Hetzner server, with how many services and volumes it has. */
    nodeByServerId(serverId: string): Promise<{ id: string; name: string; services: number; volumes: number; apiTokenId: string | null; apiTokenSecret: string | null; ip: string } | null>;
    nodeNameTaken(name: string): Promise<boolean>;
    registerNode(data: NodeRegistration): Promise<void>;
    deleteNode(id: string): Promise<void>;
    spentThisMonthPaise(): Promise<number>;
  };
  /** Saves a diagnostics report on this machine and returns where. */
  saveDiagnostics(serverId: string, suffix: string, text: string): Promise<string>;
  log(entry: { action: string; after?: unknown; cost?: number; success?: boolean; error?: string; dryRun?: boolean; toNode?: string }): Promise<void>;
  alert(subject: string, detail: string): Promise<void>;
  encrypt(text: string): string;
  decrypt(text: string): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  report(line: string): void;
};

export type InstallSettings = {
  location: string;
  image: string;
  /** sowsi-mgmt-01's public IPv4: the only address allowed to reach :8006. */
  mgmtIp: string;
  /** sowsi-mgmt-01 has a global IPv6 address (needed to SSH into an IPv6-only test container). */
  mgmtHasIpv6: boolean;
  /** HETZNER_SERVER_ID: node 1, never touched. */
  protectedServerId: string | null;
  eurToInr: number;
  spendCapPaise: number;
  sshTimeoutMs: number;
  rebootTimeoutMs: number;
  /** How long a re-run waits for a node it didn't just reboot before calling it unreachable. */
  resumeProbeMs: number;
  installTimeoutMs: number;
  /** Set when this isn't sowsi-mgmt-01. Refuses installs and --destroy alike. */
  wrongHost: string | null;
  /** Problems with the machine this runs on (missing keys…), found by the script. */
  environmentProblems: string[];
};

export const INSTALL_LABEL = "sowsi-node-install";
// The firewall comes before the Proxmox install, so port 8006 is never open to the
// internet: ufw is already denying it when pveproxy first starts listening.
export const STEPS = ["server", "ssh", "hostname", "firewall", "bridge", "boot-safety", "proxmox", "reboot", "ipv6", "host-setup", "api-token", "lockdown", "verify", "register"] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_TITLES: Record<StepId, string> = {
  server: "1  buy the Hetzner server",
  ssh: "3a wait for SSH (install key), pin the host key",
  hostname: "3b hostname and /etc/hosts",
  firewall: "3f ufw, fail2ban, key-only SSH (before Proxmox, so 8006 is never open)",
  bridge: "3c write vmbr0 (IPv4 /32, point-to-point to 172.31.1.1) and verify it",
  "boot-safety": "3c+ pin the card name by MAC, boot-time network guard, persistent journal",
  proxmox: "3d install Proxmox VE, remove the Debian kernel, verify, reboot",
  reboot: "3e wait for SSH after the reboot, check the Proxmox kernel and network (rescue repair if it never answers)",
  ipv6: "3e+ add IPv6 now the bridge is proven up, reload, verify",
  "host-setup": "3g proxmox-host-setup.sh (vmbr1, routes, sowsi-host, storage, template)",
  "api-token": "3h Proxmox API token, stored encrypted; check :8006 from sowsi-mgmt-01",
  lockdown: "3i provisioning key in (restricted), install key out",
  verify: "4  test container: SSH, outbound, delete with verified cleanup",
  register: "5  register the ProxmoxNode (closed, PROVISIONING)",
};

const NAME_RE = /^[a-z][a-z0-9-]{2,30}[a-z0-9]$/;
const TYPE_RE = /^[a-z]{2,4}[0-9]{2,3}$/;

export function validateArgs(name: string | undefined, serverType: string | undefined): string[] {
  const problems: string[] = [];
  if (!name || !NAME_RE.test(name)) problems.push(`--name must be a hostname like sowsi-proxmox-02 (lowercase letters, digits, dashes), got "${name ?? ""}"`);
  if (!serverType || !TYPE_RE.test(serverType)) problems.push(`--type must be a Hetzner server type like cpx32, got "${serverType ?? ""}"`);
  else if (serverType.startsWith("cax")) problems.push(`${serverType} is an ARM server — Proxmox VE's packages are amd64 only`);
  return problems;
}

/** Hetzner's answer → what to do about it. Nothing was bought when this is thrown at creation. */
export function explainHetznerError(err: unknown, ctx: { serverType: string; location: string; name: string }): string {
  const code = (err as { code?: string }).code;
  const raw = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "resource_unavailable":
      return `Hetzner has no ${ctx.serverType} available in ${ctx.location} right now — try another type, or later. Nothing was bought.`;
    case "resource_limit_exceeded":
      return `Hetzner project limit reached (servers, cores or primary IPs) — ask Hetzner to raise it (Console → Limits), or delete an unused server. Nothing was bought.`;
    case "uniqueness_error":
      return `a Hetzner server named ${ctx.name} already exists — pick another --name, or re-run with the same name to resume its install. Nothing was bought.`;
    case "placement_error":
      return `Hetzner couldn't place a ${ctx.serverType} in ${ctx.location} (capacity) — try again later or another type. Nothing was bought.`;
    case "rate_limit_exceeded":
      return "Hetzner API rate limit — wait a minute and re-run. Nothing was bought.";
    case "invalid_input":
      return `Hetzner rejected the request: ${raw}. Nothing was bought.`;
    case "forbidden":
    case "unauthorized":
    case "token_readonly":
      return `the Hetzner API token can't create servers (${code}) — it needs read & write. Nothing was bought.`;
    default:
      if (/quota|limit/i.test(raw)) return `Hetzner quota or limit reached: ${raw}. Nothing was bought.`;
      return raw;
  }
}

// ── Cost ──────────────────────────────────────────────────────────────

export type Cost = { monthlyPaise: number; hourlyPaise: number; lines: string[] };

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The server's price plus its Primary IPv4. A missing price is an error, never a zero. */
export function serverCost(serverType: string, price: HetznerPrice, ips: { primaryIpv4: HetznerPrice | null; floatingIpv4MonthlyEur: number | null }, s: InstallSettings, withIpv4Test: boolean): Cost | { error: string } {
  const ip = ips.primaryIpv4;
  if (!ip) return { error: `Hetzner's pricing has no Primary IPv4 price for ${s.location}` };
  const monthlyEur = price.monthlyEur + ip.monthlyEur;
  const hourlyEur = price.hourlyEur + ip.hourlyEur;
  const monthlyPaise = Math.ceil(monthlyEur * s.eurToInr * 100);
  const hourlyPaise = Math.ceil(hourlyEur * s.eurToInr * 100);
  const lines = [
    `${serverType} in ${s.location}: €${price.monthlyEur.toFixed(2)}/month, €${price.hourlyEur.toFixed(4)}/hour (gross)`,
    `primary IPv4: €${ip.monthlyEur.toFixed(2)}/month, €${ip.hourlyEur.toFixed(4)}/hour`,
    `total: ${inr(monthlyPaise)}/month, ${inr(hourlyPaise)}/hour (at ₹${s.eurToInr}/€, HETZNER_EUR_TO_INR). Billed hourly until deleted.`,
    `against the spend cap: ${inr(monthlyPaise)} if it stays as a node; if it's destroyed, only ${inr(hourlyPaise)} per started hour it lived`,
  ];
  if (withIpv4Test) lines.push(`--ipv4 test: one Floating IPv4 (€${(ips.floatingIpv4MonthlyEur ?? 0).toFixed(2)}/month list price), released right after the test`);
  return { monthlyPaise, hourlyPaise, lines };
}

// ── Plan ──────────────────────────────────────────────────────────────

export type InstallOptions = {
  name: string;
  serverType: string;
  ipv4Test: boolean;
  approvedBy: string | null;
  keepOnFailure: boolean;
  allowDowntime?: boolean;
  /** Throwaway tests: point the bridge at a card that doesn't exist before the reboot. */
  simulateBadNic?: boolean;
  /** Throwaway tests: leave a layer of protection out, to see what happens without it. */
  noPin?: boolean;
  noGuard?: boolean;
};

/** The test-only switches can't reach a real node: they need a throwaway name and each other. */
export function testFlagProblems(o: Pick<InstallOptions, "name" | "simulateBadNic" | "noPin" | "noGuard">): string[] {
  const problems: string[] = [];
  const flags = [o.simulateBadNic && "--simulate-bad-nic", o.noPin && "--no-pin", o.noGuard && "--no-guard"].filter(Boolean);
  if (flags.length && !/test/.test(o.name)) problems.push(`${flags.join(", ")} ${flags.length === 1 ? "is" : "are"} only for a throwaway: the --name must contain "test" (got "${o.name}")`);
  return problems;
}

export type InstallPlan = { ok: boolean; problems: string[]; notes?: string[]; resumeFrom: StepId | null; install: InstallRecord | null; cost: Cost | null };

export async function planInstall(deps: InstallDeps, o: InstallOptions, s: InstallSettings): Promise<InstallPlan> {
  const problems = [...(s.wrongHost ? [s.wrongHost] : []), ...validateArgs(o.name, o.serverType), ...s.environmentProblems];
  if (problems.length) return { ok: false, problems, resumeFrom: null, install: null, cost: null };

  if (await deps.db.nodeNameTaken(o.name)) problems.push(`a ProxmoxNode named ${o.name} is already registered`);
  if (o.ipv4Test === false && !s.mgmtHasIpv6) problems.push("sowsi-mgmt-01 has no global IPv6 address, so it can't SSH into the IPv6-only test container — add --ipv4");

  const notes: string[] = [];
  const install = await deps.db.findInstall(o.name);
  let resumeFrom: StepId | null = "server";
  if (install?.status === "IN_PROGRESS") {
    if (install.serverType !== o.serverType) problems.push(`${o.name} is being installed as ${install.serverType}; re-run with --type ${install.serverType} to resume it`);
    resumeFrom = STEPS.find((st) => !install.completedSteps.includes(st)) ?? null;
    if (install.hetznerServerId && !(await deps.hetzner.getServer(Number(install.hetznerServerId)))) {
      problems.push(`the install of ${o.name} recorded server ${install.hetznerServerId}, which no longer exists at Hetzner — it will be marked failed; run again to start over`);
    }
  } else if (install?.status === "REGISTERED") {
    problems.push(`${o.name} was already installed and registered`);
  } else {
    const existing = await deps.hetzner.findServerByName(o.name);
    if (existing) problems.push(`a Hetzner server named ${o.name} already exists (id ${existing.id}) and isn't one this installer is running — pick another --name`);
    if (install) {
      const was = install.status === "DESTROYED" ? "was destroyed" : "failed last time";
      notes.push(`this name ${was}${install.hetznerServerId ? ` (server ${install.hetznerServerId})` : ""}; a new server will be bought. The old record is kept, not reused.`);
    }
  }

  // Availability and price come from the server type's own entry. If they can't be read, the plan fails.
  let cost: Cost | null = null;
  const buying = resumeFrom === "server";
  try {
    const [type, ips] = await Promise.all([deps.hetzner.getServerType(o.serverType), deps.hetzner.ipPrices(s.location)]);
    if (!type) {
      if (buying) problems.push(`${o.serverType} isn't a Hetzner server type`);
    } else {
      const offer = serverTypeOffer(type, s.location);
      if (buying && !offer.buyable) problems.push(offer.reason!);
      if (buying && type.architecture !== "x86") problems.push(`${o.serverType} is ${type.architecture} — Proxmox VE's packages are x86 (amd64) only`);
      if (offer.price) {
        const c = serverCost(o.serverType, offer.price, ips, s, o.ipv4Test);
        if ("error" in c) problems.push(c.error);
        else cost = c;
      }
    }
  } catch (err) {
    if (buying) problems.push(`can't read availability and prices from Hetzner, so nothing can be bought: ${errMsg(err)}`);
  }

  if (cost && resumeFrom === "server") {
    const spent = await deps.db.spentThisMonthPaise();
    if (spent + cost.monthlyPaise > s.spendCapPaise) {
      problems.push(`buying it takes this month's infrastructure spend to ${inr(spent + cost.monthlyPaise)}, over the ${inr(s.spendCapPaise)} cap (ENGINE_SPEND_CAP_PAISE) — already ${inr(spent)}`);
    }
  }
  if (resumeFrom === "reboot" && install?.ipv4) {
    const reachable = await deps
      .ssh(install.ipv4, "install", { hostKeySha256: install.hostKeySha256, timeoutMs: 20_000 })
      .then((c) => (c.shell.close(), true))
      .catch(() => false);
    notes.push(
      reachable
        ? `${install.ipv4} answers SSH`
        : `${install.ipv4} doesn't answer SSH. --execute will wait ${s.resumeProbeMs / 1000}s, then POWER-CYCLE it into the rescue system, save diagnostics and repair the network once`
    );
  }
  return { ok: problems.length === 0, problems, notes, resumeFrom, install, cost };
}

// ── Execute ───────────────────────────────────────────────────────────

type Ctx = {
  deps: InstallDeps;
  s: InstallSettings;
  o: InstallOptions;
  rec: InstallRecord;
  shell: Shell | null;
  /** Plain token secret while this run has it. */
  tokenSecret: string | null;
  /** This run issued the reboot, so the node gets the full timeout to come back. */
  rebootedNow: boolean;
  /** Diagnostics for this failure are already saved. */
  diagnosed?: boolean;
};

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function save(ctx: Ctx, data: Partial<InstallRecord>) {
  ctx.rec = await ctx.deps.db.updateInstall(ctx.rec.id, data);
}

/** The install-key shell, reconnecting (with the pinned host key) when needed. */
async function installShell(ctx: Ctx, timeoutMs = ctx.s.sshTimeoutMs): Promise<Shell> {
  if (ctx.shell) return ctx.shell;
  const { shell, hostKeySha256 } = await ctx.deps.ssh(ctx.rec.ipv4!, "install", { hostKeySha256: ctx.rec.hostKeySha256, timeoutMs });
  if (!ctx.rec.hostKeySha256) await save(ctx, { hostKeySha256 });
  ctx.shell = shell;
  return shell;
}

function dropShell(ctx: Ctx) {
  ctx.shell?.close();
  ctx.shell = null;
}

/** Runs on the node; if the connection dropped, reconnects once and runs it again (every script is idempotent). */
async function onNode(ctx: Ctx, label: string, command: string, opts?: { stdin?: string; timeoutMs?: number }): Promise<string> {
  try {
    return await (await installShell(ctx)).exec(label, command, opts);
  } catch (err) {
    if (!/not connected|ECONNRESET|socket|channel|closed/i.test(errMsg(err))) throw err;
    dropShell(ctx);
    return (await installShell(ctx)).exec(label, command, opts);
  }
}

const fail = (step: string, problems: string[]) => {
  throw new Error(`${step}: ${problems.join("; ")}`);
};

const nodeRef = (ctx: Ctx) => ({ name: ctx.rec.name, ip: ctx.rec.ipv4! });

/** Install key entries gone, proven by listing; anything else is reported, never hidden. */
async function removeInstallKeys(deps: InstallDeps, problems: string[]) {
  const { left } = await deps.hetzner.removeInstallKeys().catch((e) => ({ removed: [] as string[], left: [errMsg(e)] }));
  if (left.length) problems.push(`install key entry still at Hetzner: ${left.join(", ")}`);
}

/**
 * The cap took the full monthly price at purchase. A server that was deleted only cost the
 * hours it lived (started hours, as Hetzner bills them), so the difference is given back once.
 */
async function settleServerCost(deps: InstallDeps, rec: InstallRecord, endedAt: Date): Promise<InstallRecord> {
  if (rec.costSettledPaise !== null || !rec.hetznerServerId) return rec;
  const started = rec.purchasedAt ?? rec.createdAt;
  const hours = Math.max(1, Math.ceil((endedAt.getTime() - started.getTime()) / 3_600_000));
  const accrued = Math.min(hours * rec.hourlyCostPaise, rec.monthlyCostPaise);
  await deps.log({ action: "SERVER_COST_SETTLED", toNode: rec.name, cost: accrued - rec.monthlyCostPaise, after: { hetznerServerId: rec.hetznerServerId, hours, accruedPaise: accrued, monthlyPaise: rec.monthlyCostPaise } });
  return deps.db.updateInstall(rec.id, { costSettledPaise: accrued });
}

/** Any failed server, not only one that went dark: what the running system says, before it's gone. */
async function diagnoseOnNode(ctx: Ctx, step: StepId, problems: string[]) {
  const { deps, rec } = ctx;
  if (!rec.ipv4 || !rec.hetznerServerId || ctx.diagnosed) return;
  try {
    const { shell } = await deps.ssh(rec.ipv4, "install", { hostKeySha256: rec.hostKeySha256, timeoutMs: 20_000 });
    try {
      const path = await deps.saveDiagnostics(rec.hetznerServerId, `-${step}`, await shell.exec("node diagnostics", diagnosticsScript(""), { timeoutMs: 3 * 60_000 }));
      deps.report(`      diagnostics saved: ${path}`);
    } finally {
      shell.close();
    }
  } catch (err) {
    problems.push(`no diagnostics: the server can't be reached (${errMsg(err)})`);
  }
}

function api(ctx: Ctx): ContainerApi {
  const secret = ctx.tokenSecret ?? (ctx.rec.apiTokenSecret ? ctx.deps.decrypt(ctx.rec.apiTokenSecret) : null);
  if (!secret) throw new Error("no Proxmox API token for this node yet");
  return ctx.deps.proxmox(nodeRef(ctx), { tokenId: S.API_TOKEN_ID, secret });
}

/**
 * Waits for a new boot on the pinned host key, then checks it. Null = the node
 * never answered in time. The first boot is IPv4 only: the next step adds IPv6.
 */
async function waitForBoot(ctx: Ctx, timeoutMs: number): Promise<Record<string, string> | null> {
  const { deps } = ctx;
  const before = ctx.rec.bootIdBeforeReboot;
  const deadline = deps.now() + timeoutMs;
  const expected = { ipv4: ctx.rec.ipv4! };
  let problems: string[] = [];
  for (;;) {
    if (deps.now() > deadline) {
      if (problems.length) fail("after reboot", problems);
      return null;
    }
    try {
      dropShell(ctx);
      const facts = S.parseFacts(await (await installShell(ctx, 30_000)).exec("after reboot", S.afterRebootFactsScript()));
      if (!before || facts.boot_id !== before) {
        problems = S.checkAfterReboot(facts, expected);
        if (problems.length === 0) return facts;
        // SSH comes up before Proxmox's services, so those get time; anything else won't fix itself.
        const lasting = S.checkAfterReboot({ ...facts, pve_services: "active active active" }, expected);
        if (lasting.length) fail("after reboot", lasting);
      }
    } catch (err) {
      if (err instanceof HostKeyMismatchError || /^after reboot:/.test(errMsg(err))) throw err;
    }
    await deps.sleep(10_000);
  }
}

async function rescueArgs(ctx: Ctx): Promise<RescueArgs> {
  const secret = ctx.tokenSecret ?? (ctx.rec.apiTokenSecret ? ctx.deps.decrypt(ctx.rec.apiTokenSecret) : null);
  return {
    deps: ctx.deps,
    rec: ctx.rec,
    s: ctx.s,
    allowDowntime: ctx.o.allowDowntime ?? false,
    customerProblem: await customerProblem(ctx.deps, ctx.rec.hetznerServerId!, secret, nodeRef(ctx)),
    markRepairAttempt: (at) => save(ctx, { repairedAt: at }),
  };
}

const RUN: Record<StepId, (ctx: Ctx) => Promise<string>> = {
  async server(ctx) {
    const { deps, o, s } = ctx;
    if (ctx.rec.hetznerServerId) return `server ${ctx.rec.hetznerServerId} already bought`;
    // A run that stopped between Hetzner creating the server and recording it: adopt it.
    const stray = await deps.hetzner.findServerByName(o.name);
    if (stray && stray.labels[INSTALL_LABEL] === "1" && stray.ipv4 && stray.ipv6Network) {
      await save(ctx, { hetznerServerId: String(stray.id), ipv4: stray.ipv4, ipv6Subnet: S.subnetOf(stray.ipv6Network), purchasedAt: new Date(deps.now()) });
      await deps.log({ action: "SERVER_PURCHASED", toNode: o.name, cost: ctx.rec.monthlyCostPaise, after: { hetznerServerId: stray.id, adopted: true, approvedBy: o.approvedBy } });
      return `server ${stray.id} (bought by an interrupted run): ${stray.ipv4}, ${stray.ipv6Network}`;
    }
    const installKey = await deps.keys.installPublicKey(true);
    if (!installKey || !deps.keys.adminPublicKey) throw new Error("the install key or NODE_ADMIN_SSH_PUBLIC_KEY is missing");
    const [install, admin] = await Promise.all([deps.hetzner.ensureSshKey("sowsi-install", installKey), deps.hetzner.ensureSshKey("sowsi-admin", deps.keys.adminPublicKey)]);
    let server: HetznerServer;
    try {
      server = await deps.hetzner.createServer({
        name: o.name,
        serverType: o.serverType,
        location: s.location,
        image: s.image,
        sshKeyIds: [install.id, admin.id],
        labels: { [INSTALL_LABEL]: "1", "sowsi-node": o.name },
      });
    } catch (err) {
      // Make sure nothing was left behind, whatever Hetzner said.
      const stray = await deps.hetzner.findServerByName(o.name).catch(() => null);
      if (stray && stray.labels[INSTALL_LABEL] === "1") await deps.hetzner.deleteServer(stray.id).catch(() => {});
      throw new Error(explainHetznerError(err, { serverType: o.serverType, location: s.location, name: o.name }));
    }
    if (!server.ipv4 || !server.ipv6Network) {
      await deps.hetzner.deleteServer(server.id);
      throw new Error(`Hetzner created server ${server.id} without ${server.ipv4 ? "an IPv6 network" : "an IPv4"} — deleted it`);
    }
    await save(ctx, { hetznerServerId: String(server.id), ipv4: server.ipv4, ipv6Subnet: S.subnetOf(server.ipv6Network), purchasedAt: new Date(deps.now()) });
    await deps.log({ action: "SERVER_PURCHASED", toNode: o.name, cost: ctx.rec.monthlyCostPaise, after: { hetznerServerId: server.id, serverType: o.serverType, location: s.location, ipv4: server.ipv4, ipv6: server.ipv6Network, approvedBy: o.approvedBy, hourlyCostPaise: ctx.rec.hourlyCostPaise } });
    return `server ${server.id}: ${server.ipv4}, ${server.ipv6Network}`;
  },

  async ssh(ctx) {
    const shell = await installShell(ctx, ctx.s.sshTimeoutMs);
    const out = await shell.exec("debian check", ". /etc/os-release && echo \"$ID $VERSION_ID\"");
    if (out.trim() !== "debian 12") throw new Error(`the server runs "${out.trim()}", not Debian 12`);
    return `logged in with the install key; host key pinned (${ctx.rec.hostKeySha256!.slice(0, 16)}…)`;
  },

  async hostname(ctx) {
    const facts = S.parseFacts(await onNode(ctx, "hostname", S.hostnameScript(ctx.rec.name, ctx.rec.ipv4!)));
    const problems = S.checkHostname(facts, ctx.rec.name, ctx.rec.ipv4!);
    if (problems.length) fail("hostname", problems);
    return `${ctx.rec.name} → ${ctx.rec.ipv4}`;
  },

  async bridge(ctx) {
    const live = S.parseFacts(await onNode(ctx, "bridge facts", S.bridgeFactsScript()));
    if (!live.nic || !live.mac) fail("bridge", [`can't find the uplink NIC (default route via "${live.default_dev}")`]);
    const content = S.interfacesFile({ nic: live.nic, ipv4: ctx.rec.ipv4! });
    const expected = { ipv4: ctx.rec.ipv4!, nic: live.nic, mac: live.mac, sha: S.sha256(content) };

    await onNode(ctx, "stage bridge config", S.stageBridgeScript(), { stdin: content });
    const staged = S.checkBridge(S.parseFacts(await onNode(ctx, "bridge facts", S.bridgeFactsScript())), expected, "staged");
    if (staged.length) fail("bridge (staged)", staged);

    await onNode(ctx, "install bridge config", S.installBridgeScript(expected.sha));
    const installed = S.checkBridge(S.parseFacts(await onNode(ctx, "bridge facts", S.bridgeFactsScript())), expected, "installed");
    if (installed.length) fail("bridge (installed)", installed);
    return `vmbr0 on ${live.nic} (${live.mac}): ${ctx.rec.ipv4}/32 via ${S.HETZNER_GATEWAY4}, IPv4 only — active from the next boot`;
  },

  async "boot-safety"(ctx) {
    const { o, s } = ctx;
    const live = S.parseFacts(await onNode(ctx, "bridge facts", S.bridgeFactsScript()));
    if (!o.noPin) await onNode(ctx, "pin nic", S.pinNicScript({ nic: live.nic, mac: live.mac }), { timeoutMs: 5 * 60_000 });
    if (!o.noGuard) await onNode(ctx, "install guard", S.installGuardScript({ mac: live.mac, ipv4: ctx.rec.ipv4!, mgmtIp: s.mgmtIp }), { stdin: S.guardScript() });
    await onNode(ctx, "journald", S.journaldScript());
    const problems = S.checkBootSafety(S.parseFacts(await onNode(ctx, "boot safety check", S.bootSafetyFactsScript(live.nic))), { nic: live.nic, mac: live.mac, pin: !o.noPin, guard: !o.noGuard });
    if (problems.length) fail("boot safety", problems);
    return `${o.noPin ? "NO name pin" : `${live.nic} pinned to ${live.mac}, in every initramfs`}; ${o.noGuard ? "NO guard" : "boot guard enabled"}; journal persistent`;
  },

  async proxmox(ctx) {
    const { s } = ctx;
    const already = S.parseFacts(await onNode(ctx, "kernel", "echo \"kernel=$(uname -r)\""));
    if (already.kernel?.endsWith("-pve")) return "already running a Proxmox kernel";

    // Proxmox opens 8006 as soon as it is installed: never start without the firewall up.
    const before = S.checkFirewall(await onNode(ctx, "firewall check", S.firewallStatusScript()), s.mgmtIp);
    if (before.length) fail("firewall check (Proxmox not installed)", before);

    const started = await onNode(ctx, "start Proxmox install", S.startPveInstallScript(), { stdin: S.pveInstallScript() });
    ctx.deps.report(`      ${started.includes("already=done") ? "install already finished" : "installing proxmox-ve (10–20 min)…"}`);
    const deadline = ctx.deps.now() + s.installTimeoutMs;
    for (;;) {
      const st = S.parseFacts(await onNode(ctx, "install status", S.pveInstallStatusScript()));
      if (st.state === "active" && st.result === "success") break;
      if (st.state === "failed" || (st.state === "inactive" && st.result && st.result !== "success")) {
        throw new Error(`Proxmox install failed (${st.result}):\n${await onNode(ctx, "install log", S.pveInstallLogScript()).catch(() => "(no log)")}`);
      }
      if (ctx.deps.now() > deadline) throw new Error(`Proxmox install still running after ${s.installTimeoutMs / 60_000} min (last: ${st.last})`);
      await ctx.deps.sleep(20_000);
    }

    // The last look before the reboot: the server must come back on vmbr0 with the Proxmox kernel.
    const live = S.parseFacts(await onNode(ctx, "pre-reboot check", S.preRebootFactsScript()));
    const content = S.interfacesFile({ nic: live.nic, ipv4: ctx.rec.ipv4! });
    const problems = S.checkBridge(live, { ipv4: ctx.rec.ipv4!, nic: live.nic, mac: live.mac, sha: S.sha256(content) }, "pre-reboot");
    if (problems.length) fail("pre-reboot check (not rebooted)", problems);
    // The Proxmox kernel has its own initramfs: the pin has to be in that one, not only Debian's.
    const safety = S.checkBootSafety(S.parseFacts(await onNode(ctx, "boot safety check", S.bootSafetyFactsScript(live.nic))), { nic: live.nic, mac: live.mac, pin: !ctx.o.noPin, guard: !ctx.o.noGuard });
    if (safety.length) fail("pre-reboot check (not rebooted)", safety);

    if (ctx.o.simulateBadNic) {
      ctx.deps.report(`      --simulate-bad-nic: pointing vmbr0 at ${S.BAD_NIC}`);
      await onNode(ctx, "simulate bad nic", S.simulateBadNicScript(live.nic));
    }
    await save(ctx, { bootIdBeforeReboot: live.boot_id });
    await onNode(ctx, "reboot", S.REBOOT_SCRIPT);
    dropShell(ctx);
    ctx.rebootedNow = true;
    return `Proxmox VE installed, Debian kernel removed, bridge verified; rebooting (boot ${live.boot_id.slice(0, 8)}…)`;
  },

  async reboot(ctx) {
    const { deps, s } = ctx;
    let facts = await waitForBoot(ctx, ctx.rebootedNow ? s.rebootTimeoutMs : s.resumeProbeMs);
    if (!facts) {
      const unreachable = `the server didn't come back within ${(ctx.rebootedNow ? s.rebootTimeoutMs : s.resumeProbeMs) / 60_000} min of the reboot`;
      deps.report(`      ${unreachable}: starting the rescue repair`);
      await deps.log({ action: "NODE_UNREACHABLE", toNode: ctx.rec.name, success: false, after: { hetznerServerId: ctx.rec.hetznerServerId, ipv4: ctx.rec.ipv4 } });
      const args = await rescueArgs(ctx);
      const refused = await rescueRefusal(args, INSTALL_LABEL);
      if (refused) {
        await deps.log({ action: "NODE_RESCUE_REFUSED", toNode: ctx.rec.name, success: false, error: refused });
        throw new Error(`${unreachable}. No automatic repair: ${refused}`);
      }
      const repair = await rescueRepair(args).catch((err) => {
        throw new Error(`${unreachable}. Rescue repair failed: ${errMsg(err)}`);
      });
      ctx.diagnosed = true;
      if (!repair.repaired) throw new Error(`${unreachable}. ${repair.summary} Diagnostics: ${repair.diagnosticsPath}`);
      dropShell(ctx);
      deps.report(`      ${repair.summary}; booting from its own disk`);

      facts = await waitForBoot(ctx, s.rebootTimeoutMs);
      if (!facts) {
        const again = await rescueDiagnoseAgain(args, repair.changes).catch((err) => `not collected: ${errMsg(err)}`);
        throw new Error(`the rescue repair didn't bring the server back. Diagnostics: ${repair.diagnosticsPath}, then ${again}. What changed: ${repair.changes.join("; ")}`);
      }
      await deps.log({ action: "NODE_RESCUE_RECOVERED", toNode: ctx.rec.name, after: { kernel: facts.kernel } });
    }
    const firewall = S.checkFirewall(await onNode(ctx, "firewall check", S.firewallStatusScript()), s.mgmtIp);
    if (firewall.length) fail("firewall check after the reboot", firewall);
    return `${facts.pveversion} on ${facts.kernel}${ctx.rec.repairedAt ? " (recovered by the rescue repair)" : ""}`;
  },

  async ipv6(ctx) {
    const expected = { ipv4: ctx.rec.ipv4!, ipv6Subnet: ctx.rec.ipv6Subnet! };
    const output = await onNode(ctx, "ipv6", S.ipv6Script(expected.ipv6Subnet), { timeoutMs: 3 * 60_000 });
    const facts = S.parseFacts(output);
    const problems = S.checkIpv6(facts, expected);
    if (problems.length) fail("ipv6", [...problems, ...(S.ipv6Debug(output) ? [`\n${S.ipv6Debug(output)}`] : [])]);
    return `${expected.ipv6Subnet}::1/64 on vmbr0 via fe80::1; IPv4 still up; host reaches the internet over IPv6${facts.dns === "ok" ? "" : "; DNS doesn't work yet (the host setup repairs it next)"}`;
  },

  async firewall(ctx) {
    const out = await onNode(ctx, "firewall", S.firewallScript(ctx.s.mgmtIp), { timeoutMs: 10 * 60_000 });
    const problems = S.checkFirewall(out, ctx.s.mgmtIp);
    if (problems.length) fail("firewall", problems);
    return `deny incoming; 22/80/443 open; 8006 from ${ctx.s.mgmtIp} only (before Proxmox exists); routed allow on vmbr1; fail2ban; key-only SSH`;
  },

  async "host-setup"(ctx) {
    const script = ctx.deps.hostSetupScript();
    const out = await onNode(ctx, "proxmox-host-setup.sh", S.hostSetupCommand(ctx.rec.ipv6Subnet!), { stdin: script, timeoutMs: 20 * 60_000 });
    const facts = S.parseFacts(await onNode(ctx, "host checks", S.outboundScript()));
    const problems = S.checkHostSetup(out, facts);
    if (problems.length) fail("host setup", problems);
    return "vmbr1, sowsi-routes (+ boot service), sowsi-host dispatcher, local: rootdir+images, Ubuntu 22.04 template; host reaches IPv4 and IPv6";
  },

  async "api-token"(ctx) {
    const secret = S.parseTokenSecret(await onNode(ctx, "API token", S.apiTokenScript()));
    ctx.tokenSecret = secret;
    await save(ctx, { apiTokenSecret: ctx.deps.encrypt(secret) });
    try {
      const v = await api(ctx).getVersion();
      return `${S.API_TOKEN_ID} (no privilege separation), stored encrypted; API ${v.version} reachable from sowsi-mgmt-01 on :8006`;
    } catch (err) {
      throw new Error(`the token works on the node, but sowsi-mgmt-01 can't reach https://${ctx.rec.ipv4}:8006 (${errMsg(err)}) — is MGMT_PUBLIC_IP (${ctx.s.mgmtIp}) this server's public IP?`);
    }
  },

  async lockdown(ctx) {
    const { deps } = ctx;
    const installKey = await deps.keys.installPublicKey(false);
    if (!installKey || !deps.keys.provisioningPublicKey || !deps.keys.adminPublicKey) throw new Error("install, provisioning or admin public key missing");
    let shell: Shell;
    try {
      shell = await installShell(ctx);
    } catch (err) {
      // A run that stopped right after removing the install key: done if the provisioning key works.
      if (err instanceof SshAuthError && S.parseRoutes(await deps.syncRoutes(ctx.rec.ipv4!).catch(() => ""))) return "already locked down (install key refused, provisioning key works)";
      throw err;
    }
    await shell.exec("add provisioning key", S.addProvisioningKeyScript(deps.keys.provisioningPublicKey));
    const routes = await deps.syncRoutes(ctx.rec.ipv4!);
    if (!S.parseRoutes(routes)) fail("lockdown", [`the provisioning key doesn't reach sowsi-host (${routes.trim().slice(0, 120)}) — install key kept`]);

    const removed = S.parseFacts(await shell.exec("remove install key", S.removeInstallKeyScript(installKey, deps.keys.adminPublicKey)));
    if (removed.install_lines !== "0" || removed.admin_lines === "0") fail("lockdown", [`authorized_keys: install key lines ${removed.install_lines}, admin key lines ${removed.admin_lines}`]);
    dropShell(ctx);
    try {
      const again = await deps.ssh(ctx.rec.ipv4!, "install", { hostKeySha256: ctx.rec.hostKeySha256, timeoutMs: 15_000 });
      again.shell.close();
      fail("lockdown", ["the install key still logs in"]);
    } catch (err) {
      if (!(err instanceof SshAuthError)) throw err;
    }
    return "provisioning key forced to sowsi-host; install key refused; admin key kept";
  },

  async verify(ctx) {
    const { deps, o, s } = ctx;
    const pve = api(ctx);
    const vmid = await pve.getNextVMID();
    const ipv6 = ipv6ForVmid(ctx.rec.ipv6Subnet!, vmid);
    let ipv4: string | undefined;
    const lines: string[] = [];
    let created = false;
    let failure: unknown = null;
    try {
      if (o.ipv4Test) {
        const fip = await deps.hetzner.buyFloatingIP(`sowsi-node-test-${ctx.rec.name}`, s.location);
        await save(ctx, { testFloatingIpId: String(fip.id) });
        await deps.hetzner.assignFloatingIP(fip.id, Number(ctx.rec.hetznerServerId));
        ipv4 = fip.ip;
      }
      await pve.createLXC({ vmid, hostname: S.TEST_CONTAINER_HOSTNAME, cores: 1, memory: 512, diskSize: 4, osTemplate: "ubuntu-22.04", ipv6, ipv4, start: true });
      created = true;
      await pve.waitForLXC(vmid);
      const routes = S.parseRoutes(await deps.syncRoutes(ctx.rec.ipv4!));
      if (!routes || routes.ipv6 !== 1 || routes.ipv4 !== (ipv4 ? 1 : 0)) fail("verify", [`host routes after create: ${JSON.stringify(routes)}`]);

      const shell = await deps.containerShell(ipv4 ?? ipv6, 3 * 60_000);
      try {
        const out = S.parseFacts(await shell.exec("outbound", S.containerOutboundScript(Boolean(ipv4))));
        if (out.out6 !== "ok") fail("verify", ["the container can't reach the internet over IPv6"]);
        if (ipv4 && out.out4 !== "ok") fail("verify", ["the container can't reach the internet over IPv4"]);
        lines.push(`container ${vmid} at ${ipv4 ? `${ipv4} + ` : ""}${ipv6}: SSH (provisioning key) ok, outbound IPv6 ok${ipv4 ? ", IPv4 ok" : ", IPv4 not tested (add --ipv4)"}`);
      } finally {
        shell.close();
      }
    } catch (err) {
      failure = err;
    } finally {
      // Always clean up, verified — even when a check above failed.
      const cleanup: string[] = [];
      if (created) {
        const r = await pve.destroyContainer(vmid).catch((e) => ({ leftover: [`(${errMsg(e)})`], errors: [] as string[] }));
        if (r.leftover.length) cleanup.push(`leftover disks: ${r.leftover.join(", ")}`);
        const left = await pve.listLXC().catch(() => [{ vmid, status: "unknown" }]);
        if (left.some((c) => c.vmid === vmid)) cleanup.push(`container ${vmid} still exists`);
        const routes = S.parseRoutes(await deps.syncRoutes(ctx.rec.ipv4!).catch(() => ""));
        if (!routes || routes.ipv4 + routes.ipv6 !== 0) cleanup.push(`host routes after delete: ${JSON.stringify(routes)}`);
      }
      if (ctx.rec.testFloatingIpId) {
        const id = Number(ctx.rec.testFloatingIpId);
        await deps.hetzner.releaseFloatingIP(id).catch((e) => cleanup.push(`Floating IP ${id}: ${errMsg(e)}`));
        if (await deps.hetzner.floatingIpExists(id).catch(() => true)) cleanup.push(`Floating IP ${id} still exists`);
        else await save(ctx, { testFloatingIpId: null });
      }
      if (cleanup.length) {
        throw new Error([failure ? errMsg(failure) : null, `verify cleanup: ${cleanup.join("; ")}`].filter(Boolean).join(" — then "));
      }
    }
    if (failure) throw failure;
    return `${lines.join("; ")}; deleted: no container, disks, routes${o.ipv4Test ? " or Floating IP" : ""} left`;
  },

  async register(ctx) {
    const pve = api(ctx);
    const [status, storage] = await Promise.all([pve.getNodeStatus(), pve.getStorageStatus("local")]);
    const reg: NodeRegistration = {
      name: ctx.rec.name,
      ip: ctx.rec.ipv4!,
      hetznerServerId: ctx.rec.hetznerServerId!,
      location: ctx.rec.location,
      ipv6Subnet: ctx.rec.ipv6Subnet!,
      physicalRamMB: Math.floor(status.memory.total / 1024 / 1024),
      physicalDiskGB: Math.floor(storage.total / 1024 ** 3),
      physicalCpu: status.cpus,
      monthlyCost: ctx.rec.monthlyCostPaise,
      apiTokenId: S.API_TOKEN_ID,
      apiTokenSecret: ctx.rec.apiTokenSecret!,
    };
    await ctx.deps.db.registerNode(reg);
    await save(ctx, { status: "REGISTERED", apiTokenSecret: null });
    return `${reg.name}: ${reg.physicalRamMB} MB RAM, ${reg.physicalDiskGB} GB disk, ${reg.physicalCpu} CPU — status PROVISIONING, acceptNewClients false`;
  },
};

/** Where an unfinished install stands: shown before anything runs. */
export function resumeSummary(rec: InstallRecord): string[] {
  const next = STEPS.find((st) => !rec.completedSteps.includes(st));
  return [
    `Resuming ${rec.name}${rec.hetznerServerId ? ` on Hetzner server ${rec.hetznerServerId} (${rec.ipv4})` : ""}${rec.completedSteps.includes("server") ? ": no new server is bought" : ""}`,
    `  done: ${rec.completedSteps.join(", ") || "nothing"}`,
    `  next: ${next ? STEP_TITLES[next] : "nothing left"}`,
    ...(rec.error ? [`  last error: ${rec.error}`] : []),
  ];
}

/**
 * A finished install keeps its record: its server id, cost and history stay readable, and
 * --destroy still finds it. The name is freed for a new install, which gets its own row.
 * A server that's gone only cost the hours it lived, so that is settled here if it wasn't yet.
 */
async function archiveInstall(deps: InstallDeps, rec: InstallRecord) {
  const settled = await settleServerCost(deps, rec, rec.updatedAt);
  const name = `${rec.name}#${rec.hetznerServerId ?? rec.id}`;
  await deps.db.updateInstall(settled.id, { name });
  await deps.log({ action: "NODE_INSTALL_ARCHIVED", toNode: rec.name, after: { archivedAs: name, status: rec.status, hetznerServerId: rec.hetznerServerId } });
  deps.report(`  ${rec.name}'s old install (${rec.status}) is kept as ${name}; this is a new install`);
}

export type InstallResult = { ok: true; summary: string } | { ok: false; error: string; serverDeleted: boolean };

export async function executeInstall(deps: InstallDeps, o: InstallOptions, s: InstallSettings): Promise<InstallResult> {
  if (!o.approvedBy?.trim()) return { ok: false, error: "--execute needs --approved-by <name>", serverDeleted: false };
  const plan = await planInstall(deps, o, s);
  let rec = plan.install;

  // A recorded server that vanished: close that install out; the next run starts over.
  if (rec?.status === "IN_PROGRESS" && rec.hetznerServerId && !(await deps.hetzner.getServer(Number(rec.hetznerServerId)))) {
    await deps.db.updateInstall(rec.id, { status: "FAILED", error: `server ${rec.hetznerServerId} disappeared at Hetzner` });
    await deps.log({ action: "NODE_INSTALL_FAILED", toNode: o.name, success: false, error: "server disappeared" });
    return { ok: false, error: `server ${rec.hetznerServerId} no longer exists at Hetzner — marked failed; run again to start over`, serverDeleted: false };
  }
  if (!plan.ok) return { ok: false, error: plan.problems.join("; "), serverDeleted: false };

  if (!rec || rec.status !== "IN_PROGRESS") {
    if (rec) await archiveInstall(deps, rec);
    rec = await deps.db.createInstall({ name: o.name, serverType: o.serverType, location: s.location, monthlyCostPaise: plan.cost!.monthlyPaise, hourlyCostPaise: plan.cost!.hourlyPaise, approvedBy: o.approvedBy });
  }
  if (rec.completedSteps.length > 0) {
    for (const line of resumeSummary(rec)) deps.report(line);
    rec = await deps.db.updateInstall(rec.id, { error: null });
  }
  const ctx: Ctx = { deps, s, o, rec, shell: null, tokenSecret: null, rebootedNow: false };
  await deps.log({ action: "NODE_INSTALL_STARTED", toNode: o.name, after: { resumeFrom: plan.resumeFrom, serverType: o.serverType, approvedBy: o.approvedBy, ipv4Test: o.ipv4Test } });

  let current: StepId = "server";
  try {
    for (const step of STEPS) {
      if (ctx.rec.completedSteps.includes(step)) continue;
      current = step;
      deps.report(`→ ${STEP_TITLES[step]}`);
      const started = deps.now();
      const detail = await RUN[step](ctx);
      await save(ctx, { completedSteps: [...ctx.rec.completedSteps, step] });
      await deps.log({ action: "NODE_INSTALL_STEP", toNode: o.name, after: { step, detail, seconds: Math.round((deps.now() - started) / 1000) } });
      deps.report(`  ✓ ${detail}`);
    }
  } catch (err) {
    dropShell(ctx);
    return failInstall(ctx, current, err);
  }
  dropShell(ctx);
  const keyProblems: string[] = [];
  await removeInstallKeys(deps, keyProblems);
  const summary = `${o.name} is a Proxmox node (Hetzner server ${ctx.rec.hetznerServerId}, ${ctx.rec.ipv4}). Registered closed: status PROVISIONING, acceptNewClients false — open it by hand when you're ready.`;
  await deps.log({ action: "NODE_REGISTERED", toNode: o.name, after: { hetznerServerId: ctx.rec.hetznerServerId, ipv4: ctx.rec.ipv4, ipv6Subnet: ctx.rec.ipv6Subnet, approvedBy: o.approvedBy } });
  await deps.alert(`New Proxmox node installed: ${o.name}`, [summary, ...keyProblems.map((p) => `! ${p}`)].join("\n"));
  return { ok: true, summary };
}

/** Nothing of a customer's may be on a server this deletes. */
async function customerProblem(deps: InstallDeps, serverId: string, tokenSecret: string | null, node: { name: string; ip: string } | null): Promise<string | null> {
  const registered = await deps.db.nodeByServerId(serverId);
  if (registered && (registered.services > 0 || registered.volumes > 0)) {
    return `node ${registered.name} has ${registered.services} service(s) and ${registered.volumes} volume(s) registered on it`;
  }
  const secret = tokenSecret ?? (registered?.apiTokenSecret ? deps.decrypt(registered.apiTokenSecret) : null);
  const target = node ?? (registered ? { name: registered.name, ip: registered.ip } : null);
  if (secret && target) {
    const containers = await deps
      .proxmox(target, { tokenId: registered?.apiTokenId ?? S.API_TOKEN_ID, secret })
      .listLXC()
      .catch(() => null);
    const others = containers?.filter((c) => c.name !== S.TEST_CONTAINER_HOSTNAME) ?? [];
    if (others.length) return `the node has container(s) ${others.map((c) => `${c.vmid} ${c.name ?? ""}`.trim()).join(", ")}`;
  }
  return null;
}

async function failInstall(ctx: Ctx, step: StepId, err: unknown): Promise<InstallResult> {
  const { deps, o } = ctx;
  const error = `${step}: ${errMsg(err)}`;
  const serverId = ctx.rec.hetznerServerId;
  const cleanup: string[] = [];

  if (ctx.rec.testFloatingIpId) {
    const id = Number(ctx.rec.testFloatingIpId);
    await deps.hetzner
      .releaseFloatingIP(id)
      .then(() => save(ctx, { testFloatingIpId: null }))
      .catch((e) => cleanup.push(`Floating IP ${id} NOT released: ${errMsg(e)}`));
  }

  await diagnoseOnNode(ctx, step, cleanup);

  let serverDeleted = false;
  if (serverId && !o.keepOnFailure) {
    const secret = ctx.tokenSecret ?? (ctx.rec.apiTokenSecret ? deps.decrypt(ctx.rec.apiTokenSecret) : null);
    const blocked = await customerProblem(deps, serverId, secret, ctx.rec.ipv4 ? nodeRef(ctx) : null);
    if (blocked) {
      cleanup.push(`server ${serverId} NOT deleted: ${blocked}`);
    } else {
      try {
        const { primaryIpsLeft } = await deps.hetzner.deleteServer(Number(serverId));
        serverDeleted = (await deps.hetzner.getServer(Number(serverId))) === null;
        if (!serverDeleted) cleanup.push(`server ${serverId} still exists after delete`);
        if (primaryIpsLeft.length) cleanup.push(`Primary IP(s) ${primaryIpsLeft.join(", ")} still exist and bill hourly — delete them in the Hetzner Console`);
      } catch (e) {
        cleanup.push(`server ${serverId} NOT deleted: ${errMsg(e)}`);
      }
    }
  }
  // Kept or not: a rescue registers the key again if it's ever needed.
  await removeInstallKeys(deps, cleanup);
  if (serverDeleted) ctx.rec = await settleServerCost(deps, ctx.rec, new Date(deps.now()));

  const kept = o.keepOnFailure && serverId;
  await save(ctx, kept ? { error } : { status: "FAILED", error, apiTokenSecret: null });
  const detail = [
    `Install of ${o.name} (${o.serverType}) failed at step ${STEP_TITLES[step]}:`,
    errMsg(err),
    "",
    kept
      ? `--keep-on-failure: server ${serverId} (${ctx.rec.ipv4}) is KEPT and still billed (${inr(ctx.rec.hourlyCostPaise)}/hour). Re-run to resume, or remove it: npx tsx scripts/node/install-node.ts --destroy ${serverId}`
      : serverId
        ? serverDeleted
          ? `Server ${serverId} was deleted; its install key entry was removed. Nothing else was bought.`
          : `Server ${serverId} could NOT be deleted — check the Hetzner Console.`
        : "No server was bought.",
    ...cleanup.map((c) => `! ${c}`),
  ].join("\n");
  await deps.log({ action: "NODE_INSTALL_FAILED", toNode: o.name, success: false, error, after: { step, hetznerServerId: serverId, serverDeleted, kept: Boolean(kept), cleanup } });
  await deps.alert(`Node install failed: ${o.name} at ${step}`, detail);
  return { ok: false, error: detail, serverDeleted };
}

// ── --destroy ─────────────────────────────────────────────────────────

/** What destroying will do to the spend figure. */
function destroySpendNote(install: InstallRecord | null): string | null {
  if (!install?.hetznerServerId || install.costSettledPaise !== null) return null;
  return `correct the spend: ${inr(install.monthlyCostPaise)} was counted; only the started hours it lived, at ${inr(install.hourlyCostPaise)}/hour, will stay`;
}

export type DestroyPlan = { ok: boolean; problems: string[]; lines: string[]; server: HetznerServer | null; install: InstallRecord | null; nodeId: string | null };

export async function planDestroy(deps: InstallDeps, serverId: string, s: InstallSettings): Promise<DestroyPlan> {
  const problems: string[] = s.wrongHost ? [s.wrongHost] : [];
  const lines: string[] = [];
  if (!/^\d+$/.test(serverId)) return { ok: false, problems: [`--destroy needs a numeric Hetzner server id, got "${serverId}"`], lines, server: null, install: null, nodeId: null };
  if (s.protectedServerId && serverId === s.protectedServerId) problems.push(`server ${serverId} is HETZNER_SERVER_ID (node 1) — never destroyed by this script`);

  const [server, install, node] = await Promise.all([deps.hetzner.getServer(Number(serverId)), deps.db.findInstallByServer(serverId), deps.db.nodeByServerId(serverId)]);
  if (server && server.labels[INSTALL_LABEL] !== "1") problems.push(`server ${serverId} (${server.name}) wasn't created by install-node — not touching it`);
  if (!server && !install) problems.push(`no server ${serverId} at Hetzner and no install record for it`);
  const blocked = await customerProblem(deps, serverId, install?.apiTokenSecret ? deps.decrypt(install.apiTokenSecret) : null, install?.ipv4 ? { name: install.name, ip: install.ipv4 } : null);
  if (blocked) problems.push(`refusing: ${blocked}`);

  if (server) lines.push(`delete Hetzner server ${server.id} ${server.name} (${server.serverType}, ${server.ipv4}) and its Primary IPs ${server.primaryIpIds.join(", ") || "(none)"} — saves ${install ? `${inr(install.monthlyCostPaise)}/month` : "its monthly cost"}`);
  else lines.push(`server ${serverId} is already gone at Hetzner`);
  if (install?.testFloatingIpId) lines.push(`release test Floating IP ${install.testFloatingIpId}`);
  lines.push("remove the installer's key entry at Hetzner, if it's there");
  const spendNote = destroySpendNote(install);
  if (spendNote) lines.push(spendNote);
  if (node) lines.push(`remove ProxmoxNode ${node.name} (no services, no volumes)`);
  if (install) lines.push(`mark install ${install.name} DESTROYED`);
  return { ok: problems.length === 0, problems, lines, server, install, nodeId: node?.id ?? null };
}

export async function executeDestroy(deps: InstallDeps, serverId: string, approvedBy: string | null, s: InstallSettings): Promise<{ ok: boolean; lines: string[] }> {
  if (!approvedBy?.trim()) return { ok: false, lines: ["--destroy --execute needs --approved-by <name>"] };
  const plan = await planDestroy(deps, serverId, s);
  if (!plan.ok) return { ok: false, lines: plan.problems };
  const done: string[] = [];
  if (plan.install?.testFloatingIpId) {
    await deps.hetzner.releaseFloatingIP(Number(plan.install.testFloatingIpId));
    done.push(`released Floating IP ${plan.install.testFloatingIpId}`);
  }
  if (plan.server) {
    const { primaryIpsRemoved, primaryIpsLeft } = await deps.hetzner.deleteServer(plan.server.id);
    if (await deps.hetzner.getServer(plan.server.id)) return { ok: false, lines: [...done, `server ${plan.server.id} still exists after delete`] };
    done.push(`deleted server ${plan.server.id}`);
    if (primaryIpsRemoved.length) done.push(`deleted leftover Primary IP(s) ${primaryIpsRemoved.join(", ")}`);
    if (primaryIpsLeft.length) return { ok: false, lines: [...done, `Primary IP(s) ${primaryIpsLeft.join(", ")} still exist and bill hourly — delete them in the Hetzner Console`] };
  }
  if (plan.nodeId) {
    await deps.db.deleteNode(plan.nodeId);
    done.push("removed the ProxmoxNode row");
  }
  if (plan.install) {
    // A server already gone at Hetzner ended when its record last changed.
    const alreadySettled = plan.install.costSettledPaise !== null;
    const settled = await settleServerCost(deps, plan.install, plan.server ? new Date(deps.now()) : plan.install.updatedAt);
    if (!alreadySettled) done.push(`spend corrected: ${inr(settled.costSettledPaise ?? 0)} for the hours it lived, not ${inr(plan.install.monthlyCostPaise)}`);
    await deps.db.updateInstall(plan.install.id, { status: "DESTROYED", apiTokenSecret: null, testFloatingIpId: null });
  }
  const keyProblems: string[] = [];
  await removeInstallKeys(deps, keyProblems);
  if (keyProblems.length === 0) done.push("no installer key entry left at Hetzner");
  await deps.log({ action: "NODE_DESTROYED", toNode: plan.install?.name ?? plan.server?.name, after: { hetznerServerId: serverId, approvedBy, done } });
  await deps.alert(`Node server destroyed: ${plan.install?.name ?? serverId}`, `${[...done, ...keyProblems].join("\n")}\nApproved by ${approvedBy}.`);
  return { ok: keyProblems.length === 0, lines: [...done, ...keyProblems] };
}
