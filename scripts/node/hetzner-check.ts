/**
 * Read-only check of every Hetzner endpoint we use: does it answer, and are the fields we read there.
 *
 *   npx tsx scripts/node/hetzner-check.ts --type cpx22
 *   npx tsx scripts/node/hetzner-check.ts --type cpx22 --expect-gone 168392011
 *
 * GET calls only: the client below has no other method, so this can't create, change or delete anything.
 * It also reads the registered nodes from the database (read only), to flag any Floating IP that is
 * unassigned or on a server that isn't a registered node. --expect-gone <server id> (repeatable)
 * fails unless that server, its Primary IPs, Floating IPs and Volumes are all gone.
 * Exits 1 if any check fails. Never prints the API token or any public key.
 */
import { config as loadEnv } from "dotenv";
import axios from "axios";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment();

const argv = process.argv.slice(2);
const i = argv.indexOf("--type");
const serverType = i >= 0 ? argv[i + 1] : undefined;
const expectGone = argv.flatMap((a, n) => (a === "--expect-gone" ? [argv[n + 1] ?? ""] : []));

(async () => {
  const { formatResults, runHetznerChecks } = await import("../../src/lib/nodes/hetznerCheck");
  if (!serverType || serverType.startsWith("--")) throw new Error("usage: hetzner-check.ts --type <server type, e.g. cpx22> [--expect-gone <server id>]");
  if (expectGone.some((id) => !/^\d+$/.test(id))) throw new Error("--expect-gone needs a numeric Hetzner server id");
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN is not set");

  const get = async (path: string, params?: Record<string, string | number>) => {
    const res = await axios.get(`https://api.hetzner.cloud/v1${path}`, { params, timeout: 30_000, headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  };

  const nodes = await (async () => {
    const { prisma } = await import("../../src/lib/prisma");
    try {
      return await prisma.proxmoxNode.findMany({ select: { name: true, hetznerServerId: true, status: true }, orderBy: { name: "asc" } });
    } catch (err) {
      return { problem: `the database couldn't be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
    } finally {
      await prisma.$disconnect();
    }
  })();

  const results = await runHetznerChecks(get, { serverType, location: "nbg1", nodes, expectGone });
  console.log(formatResults(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
