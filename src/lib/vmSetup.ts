import { NodeSSH, type Config as SSHConfig } from "node-ssh";
import { generatePassword, randomLowerAlnum } from "@/lib/crypto";

export type SetupStep = "connecting" | "updating" | "firewall" | "user" | "coolify" | "hardening";

export type SetupVMInput = {
  ipAddress: string;
  hasCoolify: boolean;
  /** Becomes the Coolify admin login. */
  clientEmail: string;
  onStep?: (step: SetupStep) => Promise<void> | void;
};

export type SetupVMResult = {
  sshUsername: string;
  sshPassword: string;
  coolifyUrl: string | null;
  coolifyPassword: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A freshly started container takes a moment before sshd accepts
// connections, so the first connection is retried for up to 5 minutes.
const SSH_CONNECT_ATTEMPTS = 30;
const SSH_RETRY_DELAY_MS = 10_000;

const APT =
  "DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 " +
  "-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function provisioningKey(): { privateKey: string } | { privateKeyPath: string } {
  if (process.env.PROVISIONING_SSH_PRIVATE_KEY_PATH) {
    return { privateKeyPath: process.env.PROVISIONING_SSH_PRIVATE_KEY_PATH };
  }
  if (process.env.PROVISIONING_SSH_PRIVATE_KEY) {
    // Allow the key to be stored on one line in .env with literal "\n".
    return { privateKey: process.env.PROVISIONING_SSH_PRIVATE_KEY.replace(/\\n/g, "\n") };
  }
  throw new Error("Set PROVISIONING_SSH_PRIVATE_KEY_PATH or PROVISIONING_SSH_PRIVATE_KEY");
}

export async function connectWithRetry(config: SSHConfig, attempts = SSH_CONNECT_ATTEMPTS): Promise<NodeSSH> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ readyTimeout: 20_000, ...config });
      return ssh;
    } catch (err) {
      lastError = err;
      ssh.dispose();
      if (i < attempts) await sleep(SSH_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `SSH to ${config.username}@${config.host} failed after ${attempts} attempts: ` +
      (lastError instanceof Error ? lastError.message : String(lastError))
  );
}

export async function run(
  ssh: NodeSSH,
  label: string,
  command: string,
  { stdin, timeoutMs = 20 * 60_000 }: { stdin?: string; timeoutMs?: number } = {}
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    const result = await Promise.race([ssh.execCommand(command, { stdin }), timeout]);
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().split("\n").slice(-15).join("\n");
      throw new Error(`${label} failed (exit ${result.code}):\n${output}`);
    }
    return result.stdout;
  } finally {
    clearTimeout(timer);
  }
}

export class VMSetupService {
  /**
   * Makes the Proxmox host route every container's public IPs to the routed
   * bridge, based on the containers' own net0 config (adds new routes and
   * removes ones for deleted containers). Call after creating or deleting a
   * container.
   *
   * The provisioning key is installed on the host with a forced command, so
   * this connection can only ever run /usr/local/sbin/sowsi-routes — see
   * scripts/proxmox-host-setup.sh.
   */
  async syncHostRoutes(): Promise<string> {
    const host = process.env.PROXMOX_HOST;
    if (!host) throw new Error("PROXMOX_HOST is not set");
    const ssh = await connectWithRetry({ host, username: "root", ...provisioningKey() }, 3);
    try {
      return (await run(ssh, "sync host routes", "sowsi-routes", { timeoutMs: 60_000 })).trim();
    } finally {
      ssh.dispose();
    }
  }

  /**
   * Logs in as root with the platform SSH key, hardens the server, creates the
   * client's sudo user and optionally installs Coolify. Root SSH login is
   * disabled at the end, so only the returned client credentials work.
   */
  async setupVM({ ipAddress, hasCoolify, clientEmail, onStep }: SetupVMInput): Promise<SetupVMResult> {
    await onStep?.("connecting");
    const ssh = await connectWithRetry({ host: ipAddress, username: "root", ...provisioningKey() });

    try {
      await onStep?.("updating");
      await run(ssh, "apt upgrade", `${APT} update && ${APT} upgrade`);

      await onStep?.("firewall");
      const ports = ["22", "80", "443", ...(hasCoolify ? ["8000"] : [])];
      await run(
        ssh,
        "firewall",
        [`${APT} install ufw`, ...ports.map((p) => `ufw allow ${p}/tcp`), "ufw --force enable"].join(" && ")
      );

      await onStep?.("user");
      const sshUsername = `user${randomLowerAlnum(6)}`;
      const sshPassword = generatePassword(16);
      await run(ssh, "create user", `useradd -m -s /bin/bash ${sshUsername} && usermod -aG sudo ${sshUsername}`);
      // Password goes over stdin so it never appears in the process list or shell history.
      await run(ssh, "set password", "chpasswd", { stdin: `${sshUsername}:${sshPassword}\n` });

      let coolifyUrl: string | null = null;
      let coolifyPassword: string | null = null;

      if (hasCoolify) {
        await onStep?.("coolify");
        coolifyPassword = generatePassword(20);
        // ROOT_* pre-creates the admin account; otherwise whoever opens
        // :8000 first gets to register as admin.
        await run(
          ssh,
          "install Coolify",
          [
            "curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /tmp/coolify-install.sh",
            `env ROOT_USERNAME=admin ROOT_USER_EMAIL=${shellQuote(clientEmail)} ` +
              `ROOT_USER_PASSWORD=${shellQuote(coolifyPassword)} bash /tmp/coolify-install.sh`,
          ].join(" && "),
          { timeoutMs: 30 * 60_000 }
        );
        await run(
          ssh,
          "wait for Coolify",
          `for i in $(seq 1 60); do
             code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/login || true)
             if [ "$code" = 200 ] || [ "$code" = 302 ]; then exit 0; fi
             sleep 5
           done
           exit 1`,
          { timeoutMs: 6 * 60_000 }
        );
        coolifyUrl = `http://${ipAddress}:8000`;
      }

      await onStep?.("hardening");
      // sshd uses the first value it reads and loads sshd_config.d/ in order,
      // so "01-" wins over any distro drop-in that turns password auth off.
      await run(
        ssh,
        "configure sshd",
        `cat > /etc/ssh/sshd_config.d/01-sowsi.conf <<'EOF'
# Managed by Sowsi Cloud
PermitRootLogin no
PasswordAuthentication yes
KbdInteractiveAuthentication no
EOF
sshd -t && (systemctl reload ssh || systemctl reload sshd)`
      );

      // Prove the client can actually get in (and sudo) before handing over credentials.
      const clientSsh = await connectWithRetry({ host: ipAddress, username: sshUsername, password: sshPassword }, 3);
      try {
        await run(clientSsh, "verify client sudo", "sudo -S -p '' true", { stdin: `${sshPassword}\n` });
      } finally {
        clientSsh.dispose();
      }

      return { sshUsername, sshPassword, coolifyUrl, coolifyPassword };
    } finally {
      ssh.dispose();
    }
  }
}

export const vmSetup = new VMSetupService();
