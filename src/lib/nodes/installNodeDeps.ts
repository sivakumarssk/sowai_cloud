import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { NodeSSH } from "node-ssh";
import { prisma } from "@/lib/prisma";
import { hetzner } from "@/lib/hetzner";
import { ProxmoxService } from "@/lib/proxmox";
import { destroyContainerAndDisks } from "@/lib/containerDisks";
import { connectWithRetry, provisioningKey, run } from "@/lib/vmSetup";
import { runOnHost } from "@/engine/data/hostShell";
import { prismaEngineLog } from "@/engine/data/engineLog";
import { spentThisMonthPaise } from "@/engine/data/spend";
import { loadEngineSettings } from "@/engine/core/policy";
import { alertAdmins } from "@/lib/adminAlert";
import { decrypt, encrypt } from "@/lib/crypto";
import { HostKeyMismatchError, SshAuthError, type InstallDeps, type InstallRecord, type InstallSettings, type Shell } from "./installNode";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Type + base64 body of an OpenSSH public key (the comment doesn't count). */
const keyId = (publicKey: string) => publicKey.trim().split(/\s+/).slice(0, 2).join(" ");

/** The dedicated install key on sowsi-mgmt-01 — never a personal key, never the provisioning key. */
export function installKeyPath(env = process.env): string {
  return env.NODE_INSTALL_KEY_PATH?.trim() || path.join(homedir(), ".ssh", "sowsi_install_ed25519");
}

function wrapShell(ssh: NodeSSH): Shell {
  return {
    exec: (label, command, opts) => run(ssh, label, command, opts),
    close: () => ssh.dispose(),
  };
}

async function sshAsRoot(host: string, key: "install" | "provisioning", { hostKeySha256, timeoutMs }: { hostKeySha256: string | null; timeoutMs: number }) {
  const auth = key === "install" ? { privateKeyPath: installKeyPath() } : provisioningKey();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    const ssh = new NodeSSH();
    let seen: string | null = null;
    try {
      await ssh.connect({
        host,
        username: "root",
        ...auth,
        readyTimeout: 15_000,
        hostHash: "sha256",
        // Pin the host key at first contact; afterwards anything else is refused.
        hostVerifier: (hash: string) => {
          seen = hash;
          return !hostKeySha256 || hash === hostKeySha256;
        },
      });
      return { shell: wrapShell(ssh), hostKeySha256: hostKeySha256 ?? seen! };
    } catch (err) {
      ssh.dispose();
      const msg = err instanceof Error ? err.message : String(err);
      if (hostKeySha256 && seen && seen !== hostKeySha256) {
        throw new HostKeyMismatchError(`${host}'s SSH host key changed (pinned ${hostKeySha256.slice(0, 16)}…, got ${String(seen).slice(0, 16)}…) — refusing to connect`);
      }
      if (/All configured authentication methods failed/i.test(msg)) throw new SshAuthError(`root@${host} refused the ${key} key`);
      lastError = err;
    }
    if (Date.now() > deadline) throw new Error(`SSH to root@${host} not reachable within ${Math.round(timeoutMs / 1000)}s: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    await sleep(5_000);
  }
}

const toRecord = (r: NonNullable<Awaited<ReturnType<typeof prisma.nodeInstall.findUnique>>>): InstallRecord => ({ ...r, status: r.status });

export function prismaInstallDeps(): InstallDeps {
  return {
    hetzner: {
      prices: (t, l) => hetzner.prices(t, l),
      serverTypeAvailable: (t, l) => hetzner.serverTypeAvailable(t, l),
      findServerByName: (n) => hetzner.findServerByName(n),
      getServer: (id) => hetzner.getServer(id),
      createServer: (i) => hetzner.createServer(i),
      deleteServer: (id) => hetzner.deleteServer(id),
      async ensureSshKey(name, publicKey) {
        const existing = (await hetzner.listSshKeys()).find((k) => keyId(k.publicKey) === keyId(publicKey));
        if (existing) return { id: existing.id, created: false };
        // Names are unique in a project: an old entry under the same name with another key gets a suffix.
        const taken = (await hetzner.listSshKeys()).some((k) => k.name === name);
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
    },

    keys: {
      async installPublicKey(create) {
        const file = installKeyPath();
        if (!existsSync(`${file}.pub`)) {
          if (!create) return null;
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `sowsi-install@${hostname()}`, "-f", file], { stdio: "ignore" });
        }
        return readFileSync(`${file}.pub`, "utf8").trim();
      },
      adminPublicKey: process.env.NODE_ADMIN_SSH_PUBLIC_KEY?.trim() || null,
      provisioningPublicKey: process.env.PROVISIONING_SSH_PUBLIC_KEY?.trim() || null,
    },

    ssh: sshAsRoot,
    async containerShell(host, timeoutMs) {
      const ssh = await connectWithRetry({ host, username: "root", ...provisioningKey(), readyTimeout: 15_000 }, Math.max(1, Math.ceil(timeoutMs / 10_000)));
      return wrapShell(ssh);
    },
    syncRoutes: (host) => runOnHost({ name: host, ip: host }, "routes", 60_000),
    hostSetupScript: () => readFileSync(path.join(process.cwd(), "scripts", "proxmox-host-setup.sh"), "utf8").replace(/\r\n/g, "\n"),

    proxmox(node, token) {
      const client = new ProxmoxService({ node: node.name, host: node.ip, token });
      return {
        getVersion: () => client.getVersion(),
        getNodeStatus: () => client.getNodeStatus(),
        getStorageStatus: (storage) => client.getStorageStatus(storage),
        getNextVMID: () => client.getNextVMID(),
        listLXC: () => client.listLXC(),
        createLXC: (input) => client.createLXC(input),
        waitForLXC: (vmid) => client.waitForLXC(vmid),
        destroyContainer: async (vmid) => {
          const r = await destroyContainerAndDisks(client, vmid);
          return { leftover: r.leftover, errors: r.errors };
        },
      };
    },

    db: {
      findInstall: async (name) => {
        const r = await prisma.nodeInstall.findUnique({ where: { name } });
        return r ? toRecord(r) : null;
      },
      findInstallByServer: async (serverId) => {
        const r = await prisma.nodeInstall.findUnique({ where: { hetznerServerId: serverId } });
        return r ? toRecord(r) : null;
      },
      createInstall: async (data) => toRecord(await prisma.nodeInstall.create({ data })),
      updateInstall: async (id, data) => {
        const { id: _id, ...rest } = data;
        void _id;
        return toRecord(await prisma.nodeInstall.update({ where: { id }, data: rest }));
      },
      async nodeByServerId(serverId) {
        const n = await prisma.proxmoxNode.findUnique({ where: { hetznerServerId: serverId }, include: { _count: { select: { services: true, volumes: true } } } });
        return n ? { id: n.id, name: n.name, ip: n.ip, services: n._count.services, volumes: n._count.volumes, apiTokenId: n.apiTokenId, apiTokenSecret: n.apiTokenSecret } : null;
      },
      nodeNameTaken: async (name) => (await prisma.proxmoxNode.count({ where: { name } })) > 0,
      async registerNode(d) {
        await prisma.proxmoxNode.create({ data: { ...d, status: "PROVISIONING", acceptNewClients: false } });
      },
      async deleteNode(id) {
        // Only ever called for a node with no services or volumes (checked before).
        await prisma.proxmoxNode.delete({ where: { id } });
      },
      spentThisMonthPaise: () => spentThisMonthPaise(),
    },

    log: (e) => prismaEngineLog({ ...e, trigger: "MANUAL" }),
    alert: alertAdmins,
    encrypt,
    decrypt,
    sleep,
    now: () => Date.now(),
    report: (line) => console.log(line),
  };
}

/** Settings and pre-flight checks for the machine this runs on. */
export function installSettings(env = process.env): InstallSettings {
  const problems: string[] = [];
  const expectedHost = env.NODE_INSTALL_FROM_HOST?.trim() || "sowsi-mgmt-01";
  if (hostname() !== expectedHost) problems.push(`this runs only on ${expectedHost} (this is ${hostname()}; NODE_INSTALL_FROM_HOST)`);

  const addrs = Object.values(networkInterfaces()).flat().filter((a): a is NonNullable<typeof a> => Boolean(a));
  const mgmtIp = env.MGMT_PUBLIC_IP?.trim() ?? "";
  if (!mgmtIp) problems.push("MGMT_PUBLIC_IP is not set (sowsi-mgmt-01's public IPv4 — the only address allowed to reach :8006)");
  else if (!addrs.some((a) => a.address === mgmtIp)) problems.push(`MGMT_PUBLIC_IP ${mgmtIp} isn't an address of this machine`);
  const mgmtHasIpv6 = addrs.some((a) => a.family === "IPv6" && !a.internal && !a.address.startsWith("fe80") && !a.address.startsWith("fd"));

  if (!env.HETZNER_API_TOKEN) problems.push("HETZNER_API_TOKEN is not set");
  if (!env.ENCRYPTION_KEY) problems.push("ENCRYPTION_KEY is not set (the API token is stored encrypted)");
  const admin = env.NODE_ADMIN_SSH_PUBLIC_KEY?.trim();
  const prov = env.PROVISIONING_SSH_PUBLIC_KEY?.trim();
  if (!admin || !/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]{40,}/.test(admin)) problems.push("NODE_ADMIN_SSH_PUBLIC_KEY must be your admin OpenSSH public key (attached to the server so you can log in; never used by this script)");
  if (!prov) problems.push("PROVISIONING_SSH_PUBLIC_KEY is not set");
  if (!env.PROVISIONING_SSH_PRIVATE_KEY_PATH && !env.PROVISIONING_SSH_PRIVATE_KEY) problems.push("PROVISIONING_SSH_PRIVATE_KEY_PATH is not set");
  if (admin && prov && keyId(admin) === keyId(prov)) problems.push("NODE_ADMIN_SSH_PUBLIC_KEY is the provisioning key — use your own admin key");

  const keyPath = installKeyPath(env);
  if (/^id_/.test(path.basename(keyPath))) problems.push(`NODE_INSTALL_KEY_PATH ${keyPath} looks like a personal key — use a dedicated file such as ~/.ssh/sowsi_install_ed25519`);
  if (env.PROVISIONING_SSH_PRIVATE_KEY_PATH && path.resolve(env.PROVISIONING_SSH_PRIVATE_KEY_PATH) === path.resolve(keyPath)) problems.push("the install key must not be the provisioning key");
  if (existsSync(`${keyPath}.pub`)) {
    const pub = readFileSync(`${keyPath}.pub`, "utf8");
    if (admin && keyId(pub) === keyId(admin)) problems.push("the install key is your admin key — it must be a dedicated key");
    if (prov && keyId(pub) === keyId(prov)) problems.push("the install key is the provisioning key — it must be a dedicated key");
  }

  const rate = Number(env.HETZNER_EUR_TO_INR || 100);
  if (!(rate > 0)) problems.push(`HETZNER_EUR_TO_INR must be a positive number, got "${env.HETZNER_EUR_TO_INR}"`);

  return {
    location: "nbg1",
    image: "debian-12",
    mgmtIp,
    mgmtHasIpv6,
    protectedServerId: env.HETZNER_SERVER_ID?.trim() || null,
    eurToInr: rate,
    spendCapPaise: loadEngineSettings(env).spendCapPaise,
    sshTimeoutMs: Number(env.NODE_SSH_TIMEOUT_SECONDS || 300) * 1000,
    rebootTimeoutMs: Number(env.NODE_REBOOT_TIMEOUT_SECONDS || 600) * 1000,
    installTimeoutMs: Number(env.NODE_PVE_INSTALL_TIMEOUT_SECONDS || 2400) * 1000,
    environmentProblems: problems,
  };
}
