/**
 * End-to-end check of the Proxmox side of provisioning.
 *
 *   npx tsx scripts/testProxmox.ts           # IPv6-only test container (free)
 *   npx tsx scripts/testProxmox.ts --ipv4    # also buys a Hetzner Floating IP (billed by Hetzner)
 *
 * Creates a real LXC container (1 core, 2 GB, 20 GB, Ubuntu 22.04), starts
 * it, routes its IPs on the host, SSHes in over each address, creates a test
 * user, then asks whether to delete everything (container + Floating IP).
 * Does not touch the database. Run scripts/proxmox-host-setup.sh on the host first.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { proxmox } from "../src/lib/proxmox";
import { hetzner } from "../src/lib/hetzner";
import { vmSetup, connectWithRetry, provisioningKey, run } from "../src/lib/vmSetup";
import { generatePassword, randomLowerAlnum } from "../src/lib/crypto";

const OS = "ubuntu-22.04";
const WANT_IPV4 = process.argv.includes("--ipv4");

let stepNo = 0;
function step(text: string) {
  console.log(`\n[${++stepNo}] ${text}`);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function syncRoutes() {
  try {
    console.log(`    ${await vmSetup.syncHostRoutes()}`);
  } catch (err) {
    console.warn(`    ⚠ Route sync failed (has proxmox-host-setup.sh been run?): ${message(err)}`);
  }
}

type SshResult = { address: string; ok: boolean; detail: string };

/** SSH in as root with the provisioning key and report who/where we are and which IPs traffic leaves from. */
async function sshCheck(address: string): Promise<SshResult> {
  try {
    const ssh = await connectWithRetry({ host: address, username: "root", ...provisioningKey() }, 6);
    try {
      const whoami = (await run(ssh, "whoami", "whoami")).trim();
      const uname = (await run(ssh, "uname", "uname -a")).trim();
      const egress = (family: 4 | 6) =>
        run(
          ssh,
          `egress IPv${family}`,
          `curl -${family} -s --max-time 10 https://api${family === 6 ? "6" : ""}.ipify.org ` +
            `|| wget -${family} -qO- -T 10 https://api${family === 6 ? "6" : ""}.ipify.org || echo unreachable`
        ).then((s) => s.trim());
      console.log(`    whoami:   ${whoami}`);
      console.log(`    uname -a: ${uname}`);
      console.log(`    outbound IPv4 seen as: ${await egress(4)}`);
      console.log(`    outbound IPv6 seen as: ${await egress(6)}`);
      return { address, ok: true, detail: "root login with provisioning key" };
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    console.warn(`    ✗ ${message(err)}`);
    return { address, ok: false, detail: message(err) };
  }
}

/** Creates a sudo user with a random password, then proves a password login works. */
async function createTestUser(address: string): Promise<{ username: string; password: string; loginOk: boolean }> {
  const username = `user${randomLowerAlnum(6)}`;
  const password = generatePassword(16);

  const ssh = await connectWithRetry({ host: address, username: "root", ...provisioningKey() }, 3);
  try {
    await run(ssh, "create user", `useradd -m -s /bin/bash ${username} && usermod -aG sudo ${username}`);
    await run(ssh, "set password", "chpasswd", { stdin: `${username}:${password}\n` });
  } finally {
    ssh.dispose();
  }

  let loginOk = false;
  try {
    const userSsh = await connectWithRetry({ host: address, username, password }, 2);
    try {
      loginOk = (await run(userSsh, "whoami", "whoami")).trim() === username;
    } finally {
      userSsh.dispose();
    }
  } catch (err) {
    console.warn(`    ✗ Password login as ${username} failed: ${message(err)}`);
  }
  return { username, password, loginOk };
}

async function askDelete(vmid: number): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nDelete test container ${vmid}${WANT_IPV4 ? " and release its Floating IP" : ""}? (y/n) `);
  rl.close();
  if (!answer.trim().toLowerCase().startsWith("y")) return false;

  step(`Deleting container ${vmid}...`);
  await proxmox.deleteLXC(vmid);
  await syncRoutes();
  console.log("    Deleted");
  return true;
}

async function main() {
  step("Connecting to Proxmox...");
  if (!(await proxmox.testConnection())) throw new Error("Connection failed — check PROXMOX_* in .env and that port 8006 is reachable");
  const version = await proxmox.getVersion();
  console.log(`    OK — Proxmox VE ${version.version}`);

  if (!(await proxmox.hasOSTemplate(OS))) {
    console.log(`    Template ${proxmox.getTemplateFile(OS)} missing — downloading...`);
    await proxmox.downloadOSTemplate(OS);
  }

  step("Next container ID");
  const vmid = await proxmox.getNextVMID();
  console.log(`    ${vmid}`);

  const subnet = process.env.PROXMOX_IPV6_SUBNET?.replace(/:+$/, "");
  const ipv6 = subnet ? `${subnet}::${vmid}` : undefined;

  let floatingIp: { id: number; ip: string } | null = null;
  let created = false;
  let deleted = false;

  try {
    if (WANT_IPV4) {
      step("Buying Hetzner Floating IP...");
      floatingIp = await hetzner.buyFloatingIP(`sowsi-test-${vmid}`);
      console.log(`    ${floatingIp.ip} (id ${floatingIp.id})`);

      step(`Assigning it to Proxmox server ${hetzner.serverId}...`);
      await hetzner.assignFloatingIP(floatingIp.id);
      console.log("    Assigned");
    }

    step(`Creating test container ${vmid} (1 core, 2 GB RAM, 20 GB disk, ${OS}) and starting it...`);
    const started = Date.now();
    await proxmox.createLXC({
      vmid,
      hostname: `sowsi-test-${vmid}`,
      cores: 1,
      memory: 2048,
      diskSize: 20,
      osTemplate: OS,
      ipv4: floatingIp?.ip,
      ipv6,
      start: true,
    });
    created = true;
    console.log(`    Created in ${((Date.now() - started) / 1000).toFixed(0)}s`);

    step("Waiting for running state...");
    await proxmox.waitForLXC(vmid);
    console.log("    Running");

    step("Routing the container's IPs on the host...");
    // Without routes nothing can reach the container, so stop here rather
    // than wait for SSH to time out.
    const routes = await vmSetup.syncHostRoutes();
    console.log(`    ${routes}`);
    if (/ 0 IPv6/.test(routes) && ipv6) {
      throw new Error("Host reports 0 IPv6 routes — the container's net0 isn't on vmbr1 or has no ip6=");
    }

    const addresses = [ipv6, floatingIp?.ip].filter((a): a is string => Boolean(a));
    const sshResults: SshResult[] = [];
    for (const address of addresses) {
      step(`SSH as root@${address} with the provisioning key...`);
      sshResults.push(await sshCheck(address));
    }

    const reachable = sshResults.find((r) => r.ok);
    let testUser: Awaited<ReturnType<typeof createTestUser>> | null = null;
    if (reachable) {
      step(`Creating a test user via ${reachable.address}...`);
      testUser = await createTestUser(reachable.address);
    }

    step("Details");
    const status = await proxmox.getLXCStatus(vmid);
    console.table({
      vmid,
      status: status.status,
      ipv4: floatingIp?.ip ?? "(none — run with --ipv4)",
      ipv6: ipv6 ?? "(PROXMOX_IPV6_SUBNET not set)",
      net0: (await proxmox.getLXCNetConfig(vmid)) ?? "",
      cpu: `${(status.cpu * 100).toFixed(1)}%`,
      memory: `${(status.mem / 1024 ** 2).toFixed(0)} / ${(status.maxmem / 1024 ** 2).toFixed(0)} MB`,
      disk: `${(status.disk / 1024 ** 3).toFixed(1)} / ${(status.maxdisk / 1024 ** 3).toFixed(1)} GB`,
      ...Object.fromEntries(sshResults.map((r) => [`ssh ${r.address}`, r.ok ? "OK" : `FAILED: ${r.detail}`])),
    });

    if (testUser) {
      console.log("\n    Test user credentials:");
      console.table({
        username: testUser.username,
        password: testUser.password,
        "password login": testUser.loginOk ? "OK" : "FAILED",
        ssh: `ssh ${testUser.username}@${reachable!.address}`,
      });
    }
  } finally {
    if (created) {
      try {
        deleted = await askDelete(vmid);
      } catch (err) {
        console.error(`    ✗ Delete failed: ${message(err)}`);
      }
    }
    if (floatingIp) {
      if (!created || deleted) {
        step(`Releasing Floating IP ${floatingIp.ip}...`);
        await hetzner.releaseFloatingIP(floatingIp.id);
        console.log("    Released");
      } else {
        console.log(
          `    Floating IP ${floatingIp.ip} (id ${floatingIp.id}) kept with the container — Hetzner keeps billing it.\n` +
            `    After deleting the container, delete the IP in Hetzner Console → Floating IPs.`
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("\n✗", message(err));
  process.exit(1);
});
