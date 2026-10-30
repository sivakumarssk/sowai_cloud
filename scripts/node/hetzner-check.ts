/**
 * Read-only check of every Hetzner endpoint we use: does it answer, and are the fields we read there.
 *
 *   npx tsx scripts/node/hetzner-check.ts --type cpx22
 *
 * GET calls only: the client below has no other method, so this can't create, change or delete anything.
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

(async () => {
  const { formatResults, runHetznerChecks } = await import("../../src/lib/nodes/hetznerCheck");
  if (!serverType || serverType.startsWith("--")) throw new Error("usage: hetzner-check.ts --type <server type, e.g. cpx22>");
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN is not set");

  const get = async (path: string, params?: Record<string, string | number>) => {
    const res = await axios.get(`https://api.hetzner.cloud/v1${path}`, { params, timeout: 30_000, headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  };

  const results = await runHetznerChecks(get, { serverType, location: "nbg1", ownServerIds: [process.env.HETZNER_SERVER_ID ?? ""].filter(Boolean) });
  console.log(formatResults(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
