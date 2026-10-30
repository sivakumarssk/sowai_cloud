import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { nodeToken } from "./proxmox";

test("a node with its own token uses it; only a node without one falls back to .env", () => {
  process.env.PROXMOX_USER = "root@pam";
  process.env.PROXMOX_TOKEN_ID = "first";
  process.env.PROXMOX_TOKEN_SECRET = "env-secret";
  const decrypt = (v: string) => v.replace("enc:", "");
  assert.deepEqual(nodeToken({ apiTokenId: "root@pam!sowsi", apiTokenSecret: "enc:node-2-secret" }, decrypt), { tokenId: "root@pam!sowsi", secret: "node-2-secret" });
  assert.deepEqual(nodeToken({ apiTokenId: null, apiTokenSecret: null }, decrypt), { tokenId: "root@pam!first", secret: "env-secret" });
  assert.deepEqual(nodeToken(null, decrypt), { tokenId: "root@pam!first", secret: "env-secret" });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(f) && !f.endsWith(".test.ts") ? [full.replace(/\\/g, "/")] : [];
  });
}

test("every Proxmox call goes through a node's own client, apart from the listed node-1 uses", () => {
  // The default `proxmox` client always talks to PROXMOX_HOST with the .env token.
  const nodeOne = sources("src")
    .concat(sources("scripts"))
    .filter((f) => f !== "src/lib/proxmox.ts" && /\bproxmox\.[a-zA-Z]+\(/.test(readFileSync(f, "utf8")))
    .sort();
  assert.deepEqual(nodeOne, [
    "scripts/testProxmox.ts", // by-hand connection test against node 1
    // KNOWN BUG, not fixed because billing is frozen: suspend and resume act on node 1 whatever
    // node the service is on. Must move to proxmoxForNode(service.node) before a second node opens.
    "src/lib/billing/suspension.ts",
  ]);

  // Fallbacks that exist only for rows with no node: never reached for a service on a registered node.
  for (const f of ["src/lib/provisioning/provisionVPS.ts", "src/lib/billing/reprovisionDeps.ts"]) {
    assert.match(readFileSync(f, "utf8"), /proxmoxForNode\(/, f);
  }
});
