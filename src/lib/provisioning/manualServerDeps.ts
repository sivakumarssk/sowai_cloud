import { NodeSSH } from "node-ssh";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/crypto";
import { sendCredentialsEmail } from "@/lib/email";
import { prismaEngineLog } from "@/engine/data/engineLog";
import type { AssignDeps } from "./manualServer";

const SSH_TIMEOUT_MS = 15_000;

/** One password login, then a harmless command. Never retries — the admin sees the error at once. */
async function sshCheck({ host, port, username, password }: { host: string; port: number; username: string; password: string }) {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host, port, username, password, readyTimeout: SSH_TIMEOUT_MS, tryKeyboard: true });
    const r = await ssh.execCommand("echo sowsi-ssh-ok; whoami; uname -sr; uptime -p 2>/dev/null || true", { execOptions: { pty: false } });
    const [marker, whoami, kernel, uptime] = r.stdout.split("\n").map((l) => l.trim());
    if (marker !== "sowsi-ssh-ok") return { ok: false as const, error: `logged in, but the test command failed: ${(r.stderr || r.stdout).slice(0, 200)}` };
    return { ok: true as const, detail: `logged in as ${whoami} on ${host}:${port} · ${kernel}${uptime ? ` · ${uptime}` : ""}` };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  } finally {
    ssh.dispose();
  }
}

export function prismaAssignDeps(): AssignDeps {
  return {
    async load(serviceId) {
      const s = await prisma.service.findUnique({ where: { id: serviceId }, include: { plan: { select: { name: true } }, user: { select: { name: true, email: true } } } });
      if (!s) return null;
      return {
        id: s.id,
        status: s.status,
        serverSource: s.serverSource,
        proxmoxVmId: s.proxmoxVmId,
        provisioningPct: s.provisioningPct,
        updatedAt: s.updatedAt,
        serverIp: s.serverIp,
        planName: s.plan.name,
        customer: `${s.user.name} <${s.user.email}>`,
      };
    },
    sshCheck,
    async save(s, d) {
      const { count } = await prisma.service.updateMany({
        // Only if nobody changed it during the SSH check, and still no container.
        where: { id: s.id, updatedAt: s.updatedAt, proxmoxVmId: null },
        data: {
          ...d,
          status: d.status as "ACTIVE" | "SUSPENDED",
          sshUsername: encrypt(d.sshUsername),
          sshPassword: encrypt(d.sshPassword),
          panelPassword: d.panelPassword ? encrypt(d.panelPassword) : null,
        },
      });
      return count === 1;
    },
    async notifyCustomer(serviceId, input) {
      const s = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { user: true, plan: true } });
      await sendCredentialsEmail(s.user.email, s.user.name, {
        planName: s.plan.name,
        hostname: s.hostname || input.serverIp,
        serverIp: input.serverIp.trim(),
        sshUsername: input.sshUsername.trim(),
        sshPassword: input.sshPassword,
        panelUrl: input.panelUrl?.trim() || undefined,
        panelLogin: input.panelPassword ? { email: s.user.email, password: input.panelPassword } : undefined,
      }).catch((err) => console.error("[assign-server] credentials email failed:", err));
      await prisma.notification
        .create({ data: { userId: s.userId, title: "Server is ready", message: `Your ${s.plan.name} server is now active. Login credentials have been emailed to you.` } })
        .catch((err) => console.error("[assign-server] notification failed:", err));
    },
    log: (e) => prismaEngineLog({ ...e, trigger: "MANUAL" }),
  };
}
