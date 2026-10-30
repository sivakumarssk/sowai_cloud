// Runs every *.test.ts under src/ with `tsx --test`.
// Node 20 doesn't expand ** in --test paths and Windows has no find/xargs,
// so the files are listed here and passed explicitly.
//
//   node scripts/run-tests.mjs            (npm run test:engine)

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function findTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : findTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const files = findTests(join(root, "src"))
  .map((f) => relative(root, f))
  .sort();
if (files.length === 0) {
  console.error("no *.test.ts files under src/");
  process.exit(1);
}

// tsx's own CLI, run with this node binary — no shell, works the same on Linux and Windows.
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsxCli, "--test", "--test-timeout=120000", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
