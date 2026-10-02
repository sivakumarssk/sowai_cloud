/**
 * End-to-end check of the Proxmox side of provisioning.
 *
 *   npx tsx scripts/testProxmox.ts                   # IPv6-only test container
 *   npx tsx scripts/testProxmox.ts --ipv4 1.2.3.4    # also use an existing, assigned Floating IP
 *
 * Creates a real LXC container (1 core, 2 GB, 20 GB, Ubuntu 22.04), starts
 * it, syncs host routes, prints its details, then asks whether to delete it.
 * Does not touch the database or buy anything from Hetzner.
 * Run scripts/proxmox-host-setup.sh on the host first.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { proxmox } from "../src/lib/proxmox";
import { vmSetup } from "../src/lib/vmSetup";

const OS = "ubuntu-22.04";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function step(n: number, text: string) {
  console.log(`\n[${n}] ${text}`);
}

async function syncRoutes() {
  try {
    console.log(`    ${await vmSetup.syncHostRoutes()}`);
  } catch (err) {
    console.warn(`    ⚠ Route sync failed (has proxmox-host-setup.sh been run?): ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  step(1, "Connecting to Proxmox...");
  if (!(await proxmox.testConnection())) throw new Error("Connection failed — check PROXMOX_* in .env");
  console.log("    OK");

  step(2, "Version");
  const version = await proxmox.getVersion();
  console.log(`    Proxmox VE ${version.version} (release ${version.release})`);

  if (!(await proxmox.hasOSTemplate(OS))) {
    console.log(`    Template ${proxmox.getTemplateFile(OS)} missing — downloading...`);
    await proxmox.downloadOSTemplate(OS);
  }

  step(3, "Next container ID");
  const vmid = await proxmox.getNextVMID();
  console.log(`    ${vmid}`);

  const subnet = process.env.PROXMOX_IPV6_SUBNET?.replace(/:+$/, "");
  const ipv4 = arg("--ipv4");
  const ipv6 = subnet ? `${subnet}::${vmid}` : undefined;

  step(4, `Creating test container ${vmid} (1 core, 2 GB RAM, 20 GB disk, ${OS}) and starting it...`);
  const started = Date.now();
  await proxmox.createLXC({
    vmid,
    hostname: `sowsi-test-${vmid}`,
    cores: 1,
    memory: 2048,
    diskSize: 20,
    osTemplate: OS,
    ipv4,
    ipv6,
    start: true,
  });
  console.log(`    Created in ${secs(started)}s`);

  try {
    step(5, "Waiting for running state...");
    await proxmox.waitForLXC(vmid);
    console.log("    Running");

    step(6, "Syncing host routes...");
    await syncRoutes();

    step(7, "Details");
    const status = await proxmox.getLXCStatus(vmid);
    console.table({
      vmid,
      status: status.status,
      ipv4: ipv4 ?? "(none — pass --ipv4)",
      ipv6: ipv6 ?? "(PROXMOX_IPV6_SUBNET not set)",
      net0: (await proxmox.getLXCNetConfig(vmid)) ?? "",
      cpu: `${(status.cpu * 100).toFixed(1)}%`,
      memory: `${mb(status.mem)} / ${mb(status.maxmem)} MB`,
      disk: `${gb(status.disk)} / ${gb(status.maxdisk)} GB`,
    });

    const target = ipv4 ?? ipv6;
    if (target) {
      console.log(`\n    From another machine, try:  ping ${target}   and   ssh -i <provisioning key> root@${target}`);
    }
  } finally {
    await askDelete(vmid);
  }
}

async function askDelete(vmid: number) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n[8] Delete test container ${vmid}? (y/n) `);
  rl.close();

  if (answer.trim().toLowerCase().startsWith("y")) {
    step(9, `Deleting container ${vmid}...`);
    await proxmox.deleteLXC(vmid);
    await syncRoutes();
    console.log("    Deleted");
  } else {
    console.log(`    Kept. Delete later in the Proxmox UI or with: pct stop ${vmid} && pct destroy ${vmid} --purge`);
  }
}

const secs = (since: number) => ((Date.now() - since) / 1000).toFixed(0);
const mb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0);
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
