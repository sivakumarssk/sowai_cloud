import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assignPrivateIpv4, isTestPrivateIpv4, MAX_PRIVATE_INDEX, privateIpv4ForIndex, privateIpv4Index, type PrivateIpv4Db } from "./privateIpv4";
import { TEST_IPV4 } from "@/lib/nodes/nodeScripts";

test("sequence values map to 100.64.0.0/10, skipping .0 and .255, and never into the test block", () => {
  assert.equal(privateIpv4ForIndex(1), "100.64.0.1");
  assert.equal(privateIpv4ForIndex(254), "100.64.0.254");
  assert.equal(privateIpv4ForIndex(255), "100.64.1.1");
  assert.equal(privateIpv4ForIndex(254 * 256), "100.64.255.254");
  assert.equal(privateIpv4ForIndex(254 * 256 + 1), "100.65.0.1");
  assert.equal(privateIpv4ForIndex(MAX_PRIVATE_INDEX), "100.127.254.254", "the last one stops short of 100.127.255.0/24");
  assert.equal(MAX_PRIVATE_INDEX, 4161282, "the sequence's MAXVALUE");
  for (const bad of [0, -1, 1.5, MAX_PRIVATE_INDEX + 1, Number.NaN]) assert.throws(() => privateIpv4ForIndex(bad), /outside/);
});

test("every address maps back to its own index, and nothing else does", () => {
  for (const n of [1, 2, 253, 254, 255, 256, 509, 65024, 65025, 1_000_000, MAX_PRIVATE_INDEX]) assert.equal(privateIpv4Index(privateIpv4ForIndex(n)), n);
  const seen = new Set<string>();
  for (let n = 1; n <= 5000; n++) {
    const ip = privateIpv4ForIndex(n);
    assert.ok(!seen.has(ip), `${ip} twice`);
    seen.add(ip);
    assert.doesNotMatch(ip, /\.(0|255)$/);
  }
  for (const ip of ["100.64.0.0", "100.64.0.255", "100.63.255.254", "100.128.0.1", "100.127.255.1", "100.127.255.11", "10.0.0.1", "100.064.0.1", "100.64.0.1 ", "100.64.256.1", "x"]) {
    assert.equal(privateIpv4Index(ip), null, ip);
  }
});

test("the installer's shared-mode test address is in the test block, so no service can ever hold it", () => {
  assert.ok(isTestPrivateIpv4(TEST_IPV4.second));
  assert.equal(privateIpv4Index(TEST_IPV4.second), null);
  assert.ok(!isTestPrivateIpv4(privateIpv4ForIndex(MAX_PRIVATE_INDEX)));
});

function fakeDb(start = 0, rows: Record<string, string | null> = { svc_a: null, svc_b: null }) {
  let seq = start;
  const calls: string[] = [];
  const db: PrivateIpv4Db = {
    current: async (id) => rows[id] ?? null,
    nextIndex: async () => (calls.push("nextval"), ++seq),
    setIfEmpty: async (id, ip) => {
      if (!(id in rows) || rows[id] !== null) return false;
      if (Object.values(rows).includes(ip)) throw new Error("unique violation");
      rows[id] = ip;
      return true;
    },
  };
  return { db, rows, calls };
}

test("a service gets one address, once; asking again returns the same one and burns nothing", async () => {
  const w = fakeDb();
  assert.equal(await assignPrivateIpv4(w.db, "svc_a"), "100.64.0.1");
  assert.equal(await assignPrivateIpv4(w.db, "svc_a"), "100.64.0.1");
  assert.equal(await assignPrivateIpv4(w.db, "svc_b"), "100.64.0.2");
  assert.deepEqual(w.calls, ["nextval", "nextval"], "no sequence value for a service that has one");
});

test("an address is never reused: a deleted service's address stays taken", async () => {
  const w = fakeDb(0, { svc_old: null, svc_new: null });
  assert.equal(await assignPrivateIpv4(w.db, "svc_old"), "100.64.0.1");
  // Deleting a service keeps its row (status DELETED) and so its address; the sequence moves on anyway.
  assert.equal(await assignPrivateIpv4(w.db, "svc_new"), "100.64.0.2");
});

test("a race: the other call's address wins and is returned; this call's value is never used", async () => {
  const rows: Record<string, string | null> = { svc_a: null };
  let seq = 0;
  const db: PrivateIpv4Db = {
    current: async (id) => rows[id] ?? null,
    nextIndex: async () => ++seq,
    setIfEmpty: async () => {
      rows.svc_a = "100.64.0.9"; // someone else got there first
      return false;
    },
  };
  assert.equal(await assignPrivateIpv4(db, "svc_a"), "100.64.0.9");
  await assert.rejects(assignPrivateIpv4({ ...db, current: async () => null }, "svc_gone"), /has no private IPv4, and setting 100\.64\.0\.2 changed nothing/);
});

test("the migration's sequence and checks match this module", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", "20261111090000_private_ipv4", "migration.sql"), "utf8");
  assert.match(sql, /CREATE SEQUENCE "service_private_ipv4_seq" AS INTEGER MINVALUE 1 MAXVALUE 4161282 NO CYCLE;/);
  assert.match(sql, /CREATE UNIQUE INDEX "Service_privateIpv4_key" ON "Service"\("privateIpv4"\);/);
  assert.match(sql, /"privateIpv4" NOT LIKE '100\.127\.255\.%'/);
  assert.match(sql, /\("hetznerFloatingIpId" IS NOT NULL OR \("ipv4Mode" = 'SHARED' AND "privateIpv4" IS NOT NULL\)\)/);
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "provisioning", "privateIpv4.ts"), "utf8");
  assert.match(src, /nextval\('service_private_ipv4_seq'\)/);
});
