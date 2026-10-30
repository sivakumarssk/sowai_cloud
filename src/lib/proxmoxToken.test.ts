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

test("nothing but the by-hand node-1 test uses the default client, which always talks to PROXMOX_HOST with the .env token", () => {
  const imports = /\{[^}]*\bproxmox\b[^}]*\}\s*(from\s*["'][^"']*lib\/proxmox["']|=\s*await import\(["'][^"']*lib\/proxmox["']\))/;
  const users = sources("src")
    .concat(sources("scripts"))
    .filter((f) => imports.test(readFileSync(f, "utf8")))
    .sort();
  assert.deepEqual(users, ["scripts/testProxmox.ts"]);
});
