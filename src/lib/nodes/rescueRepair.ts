// A new node that doesn't come back from its first reboot: through the Hetzner
// rescue system, find out why, save the evidence, then repair it once.
//
// Rescue is a power cycle, so this refuses a node holding customers unless the
// admin passes --allow-downtime. It runs at most once per install (repairedAt),
// and only when the evidence says rewriting the network config will help. The
// rescue host key is used for this session only: the node's own pin is untouched.
import type { InstallDeps, InstallRecord, InstallSettings, Shell } from "./installNode";
import { interfacesFile, sha256 } from "./nodeScripts";
import * as R from "./rescueScripts";

export type RescueArgs = {
  deps: InstallDeps;
  rec: InstallRecord;
  s: InstallSettings;
  allowDowntime: boolean;
  /** Set when a customer's service, volume or container is on this node. */
  customerProblem: string | null;
  /** Records repairedAt, before the repair runs. */
  markRepairAttempt(at: Date): Promise<void>;
};

/** Why this server mustn't be power-cycled automatically, or null. */
export async function rescueRefusal({ deps, rec, s, allowDowntime, customerProblem }: RescueArgs, installLabel: string): Promise<string | null> {
  const serverId = rec.hetznerServerId;
  if (rec.repairedAt) return `a rescue repair was already tried on ${rec.repairedAt.toISOString()}; it runs only once`;
  if (!serverId) return "no server recorded";
  if (serverId === s.protectedServerId) return `server ${serverId} is HETZNER_SERVER_ID (node 1): never power-cycled by the installer`;
  const server = await deps.hetzner.getServer(Number(serverId));
  if (!server) return `server ${serverId} no longer exists at Hetzner`;
  if (server.labels[installLabel] !== "1") return `server ${serverId} wasn't created by install-node`;
  if (customerProblem && !allowDowntime) return `rescue power-cycles the server, and ${customerProblem}; add --allow-downtime to accept that`;
  return null;
}

/** Boots rescue, mounts the node's disk read-only, runs `body`, then always boots back from disk. */
async function inRescue<T>({ deps, rec, s }: RescueArgs, body: (shell: Shell) => Promise<T>): Promise<T> {
  const serverId = Number(rec.hetznerServerId);
  const installKey = await deps.keys.installPublicKey(false);
  if (!installKey) throw new Error("the install key is missing on this machine");
  // The Hetzner entry is removed after each install, so it may have to be registered again.
  const { id: keyId } = await deps.hetzner.ensureSshKey("sowsi-install", installKey);
  let powerCycled = false;
  try {
    await deps.hetzner.enableRescue(serverId, [keyId]);
    await deps.hetzner.resetServer(serverId);
    powerCycled = true;
    await deps.log({ action: "NODE_RESCUE_BOOTED", toNode: rec.name, after: { hetznerServerId: rec.hetznerServerId } });
    deps.report("      power-cycled into the rescue system, waiting for SSH…");

    // Pinned for this session only: rec.hostKeySha256 stays the node's own key.
    const { shell, hostKeySha256 } = await deps.ssh(rec.ipv4!, "install", { hostKeySha256: null, timeoutMs: s.sshTimeoutMs });
    try {
      if (hostKeySha256 === rec.hostKeySha256) throw new Error("the server answered with its own host key, not the rescue system's");
      const candidates = R.rootCandidates(await shell.exec("rescue lsblk", R.LSBLK_COMMAND));
      if (candidates.length === 0) throw new Error("no partition on this server looks like its root");
      let mounted: string | null = null;
      for (const device of candidates) {
        if ((await shell.exec("rescue mount", R.mountRootScript(device))).includes("root=ok")) {
          mounted = device;
          break;
        }
      }
      if (!mounted) throw new Error(`none of ${candidates.join(", ")} is this server's root`);
      deps.report(`      node's disk is ${mounted}, mounted read-only`);
      try {
        return await body(shell);
      } finally {
        await shell.exec("rescue unmount", R.UNMOUNT_SCRIPT).catch(() => {});
      }
    } finally {
      shell.close();
    }
  } finally {
    // Whatever happened: rescue off, back to its own disk, no install key left at Hetzner.
    const cleanup: string[] = [];
    const server = await deps.hetzner.getServer(serverId).catch(() => null);
    if (server?.rescueEnabled) await deps.hetzner.disableRescue(serverId).catch((e) => cleanup.push(`disable rescue: ${String(e)}`));
    if (powerCycled) await deps.hetzner.resetServer(serverId).catch((e) => cleanup.push(`reset: ${String(e)}`));
    const keys = await deps.hetzner.removeInstallKeys().catch((e) => ({ removed: [], left: [String(e)] }));
    if (keys.left.length) cleanup.push(`install key entry still at Hetzner: ${keys.left.join(", ")}`);
    if (cleanup.length) await deps.alert(`Rescue cleanup incomplete on ${rec.name}`, cleanup.join("\n"));
  }
}

async function collect({ deps, rec }: RescueArgs, shell: Shell, suffix: string): Promise<{ text: string; path: string }> {
  const text = await shell.exec("rescue diagnostics", R.diagnosticsScript(), { timeoutMs: 3 * 60_000 });
  const path = await deps.saveDiagnostics(rec.hetznerServerId!, suffix, text);
  for (const line of text.split("\n")) deps.report(`      | ${line}`);
  deps.report(`      diagnostics saved: ${path}`);
  return { text, path };
}

export type RepairResult = { repaired: boolean; summary: string; diagnosticsPath: string; changes: string[] };

/** Diagnose, save, then repair once if the evidence supports it. The server is back on its own disk afterwards. */
export async function rescueRepair(args: RescueArgs): Promise<RepairResult> {
  const { deps, rec } = args;
  return inRescue(args, async (shell) => {
    const { text, path } = await collect(args, shell, "");
    const found = R.diagnose(text);
    deps.report(`      cause (${found.confidence} confidence): ${found.cause}`);
    for (const e of found.evidence) deps.report(`        - ${e}`);
    await deps.log({ action: "NODE_RESCUE_DIAGNOSED", toNode: rec.name, after: { cause: found.cause, confidence: found.confidence, evidence: found.evidence, diagnostics: path } });

    const images = /^sowsi_images=(.*)$/m.exec(text)?.[1].trim();
    if (images && !args.allowDowntime) return { repaired: false, summary: `the disk holds container images (${images}); nothing changed. Add --allow-downtime to accept that.`, diagnosticsPath: path, changes: [] };
    if (!found.repair) return { repaired: false, summary: `${found.cause} Nothing was changed.`, diagnosticsPath: path, changes: [] };

    const plan: R.RepairPlan = { ...found.repair, ipv4: rec.ipv4!, stamp: new Date(deps.now()).toISOString().replace(/[:.]/g, "-") };
    // Recorded first, so even a crash below can't lead to a second attempt.
    await args.markRepairAttempt(new Date(deps.now()));
    const out = await shell.exec("rescue repair", R.repairScript(plan), { stdin: interfacesFile(plan), timeoutMs: 5 * 60_000 });
    const problems = R.checkRepair(out, plan);
    if (problems.length) throw new Error(`rescue repair: ${problems.join("; ")}`);

    const changes = [
      `/etc/network/interfaces rewritten (backup /etc/network/interfaces.sowsi-before-repair-${plan.stamp}): vmbr0 on ${plan.nic}, IPv4 only, sha ${sha256(interfacesFile(plan)).slice(0, 12)}`,
      `${R.LINK_FILE} pins ${plan.mac} to ${plan.nic}`,
      "initramfs rebuilt with the pin",
    ];
    for (const c of changes) deps.report(`      changed: ${c}`);
    await deps.log({ action: "NODE_RESCUE_REPAIRED", toNode: rec.name, after: { nic: plan.nic, mac: plan.mac, changes, diagnostics: path } });
    return { repaired: true, summary: `repaired: vmbr0 on ${plan.nic}, name pinned by MAC`, diagnosticsPath: path, changes };
  });
}

/** The repair didn't bring it back: look again, with what changed, without changing anything more. */
export async function rescueDiagnoseAgain(args: RescueArgs, changes: string[]): Promise<string> {
  return inRescue(args, async (shell) => {
    args.deps.report("      the repair didn't bring it back; collecting diagnostics again, changing nothing");
    for (const c of changes) args.deps.report(`      changed earlier: ${c}`);
    return (await collect(args, shell, "-after-repair")).path;
  });
}
