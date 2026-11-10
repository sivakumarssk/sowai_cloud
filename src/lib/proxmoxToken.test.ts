import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { nodeToken } from "./proxmox";

test("a node uses its own token; one without a token is refused, never given .env's", () => {
  // Node 1's old .env token, still set: it must never be used for anything.
  process.env.PROXMOX_USER = "root@pam";
  process.env.PROXMOX_TOKEN_ID = "first";
  process.env.PROXMOX_TOKEN_SECRET = "env-secret";
  const decrypt = (v: string) => v.replace("enc:", "");
  assert.deepEqual(nodeToken("node-2", { apiTokenId: "root@pam!sowsi", apiTokenSecret: "enc:node-2-secret" }, decrypt), { tokenId: "root@pam!sowsi", secret: "node-2-secret" });
  assert.throws(() => nodeToken("sowsi-proxmox-01", { apiTokenId: null, apiTokenSecret: null }, decrypt), /sowsi-proxmox-01 has no API token of its own/);
  assert.throws(() => nodeToken("node-3", { apiTokenId: "root@pam!sowsi", apiTokenSecret: null }, decrypt), /no API token of its own/, "half a token is no token");
  assert.throws(() => nodeToken("ghost", null, decrypt), /ghost is not registered/);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(tsx?|mjs)$/.test(f) && !f.endsWith(".test.ts") && !full.includes(`${path.sep}testing${path.sep}`) ? [full.replace(/\\/g, "/")] : [];
  });
}

test("no code reads node 1's .env settings: every node comes from its ProxmoxNode row", () => {
  const nodeOne = /process\.env\.(PROXMOX_(USER|TOKEN_ID|TOKEN_SECRET|HOST|NODE|IPV6_SUBNET|NODE_MONTHLY_COST_PAISE)|HETZNER_SERVER_ID)\b|requireEnv\(["']PROXMOX_(USER|TOKEN_ID|TOKEN_SECRET|HOST|NODE)["']\)/;
  const readers = sources("src")
    .concat(sources("scripts"))
    .filter((f) => nodeOne.test(readFileSync(f, "utf8")))
    .sort();
  assert.deepEqual(readers, []);
});

test("the production seed registers no node: nodes come only from install-node.ts", () => {
  const seed = readFileSync(path.join("scripts", "prod", "seed.ts"), "utf8");
  assert.doesNotMatch(seed, /upsertNode|proxmoxNode\./);
});

test("nothing builds a Proxmox client without naming its node and address", () => {
  const users = sources("src")
    .concat(sources("scripts"))
    .filter((f) => /new ProxmoxService\(\s*\)|\bproxmox\s*\}\s*from\s*["'][^"']*lib\/proxmox["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users, []);
});
