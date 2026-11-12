import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assignSharedIdentity, isServiceName, nameBase, nameCandidate, serviceFqdn, type PublicNameDb } from "./publicName";

test("the order's hostname becomes one DNS label, or 'server' when nothing is left of it", () => {
  assert.equal(nameBase("My Shop"), "my-shop");
  assert.equal(nameBase("  shop.example.com "), "shop-example-com");
  assert.equal(nameBase("Café--Déjà__vu!!"), "cafe-deja-vu");
  assert.equal(nameBase("---"), "server");
  assert.equal(nameBase(null), "server");
  assert.equal(nameBase("नमस्ते"), "server", "no letters it can keep");
  const long = nameBase("a".repeat(30) + "-" + "b".repeat(30));
  assert.ok(long.length <= 40 && !long.endsWith("-"), long);
  assert.equal(serviceFqdn("my-shop"), "my-shop.c.sowsicloud.com");
});

test("a reserved or taken name gets a short suffix; our own prefix is never handed out", () => {
  const r = () => "k3x9q2";
  assert.equal(nameCandidate("My Shop", 0, r), "my-shop");
  assert.equal(nameCandidate("My Shop", 1, r), "my-shop-k3x9q2");
  assert.equal(nameCandidate("www", 0, r), "www-k3x9q2");
  assert.equal(nameCandidate("mail", 0, r), "mail-k3x9q2");
  assert.equal(nameCandidate("Sowsi Cloud", 0, r), "server", "not sowsi-cloud");
  assert.equal(nameCandidate("sowsi", 3, r), "server-k3x9q2");
  for (const bad of ["www", "sowsi-x", "-a", "a-", "a--b", "A", "a.b", "", "x".repeat(64)]) assert.equal(isServiceName(bad), false, bad);
  for (const good of ["my-shop", "a", "server-k3x9q2", "x".repeat(63)]) assert.equal(isServiceName(good), true, good);
});

/** A database with the unique indexes: a value held by another service is "taken". */
function fakeDb(rows: Record<string, { publicName: string | null; routeKey: string | null }>) {
  const writes: string[] = [];
  const db: PublicNameDb = {
    current: async (id) => (rows[id] ? { ...rows[id] } : null),
    async setIfEmpty(id, field, value) {
      writes.push(`${field}=${value}`);
      if (Object.entries(rows).some(([other, r]) => other !== id && r[field] === value)) return "taken";
      if (rows[id][field]) return "kept";
      rows[id][field] = value;
      return "set";
    },
  };
  return { db, rows, writes };
}

test("assignment: the hostname when free, a suffix when taken, a route key once, and the same answer every time", async () => {
  const f = fakeDb({ a: { publicName: null, routeKey: null }, b: { publicName: "my-shop", routeKey: "aaaaaaaaaaaaaaaa" } });
  let n = 0;
  const random = () => ["k3x9q2", "p8z1m4"][n++];
  const keys = ["aaaaaaaaaaaaaaaa", "q7w8e9r0t1y2u3i4"];
  let k = 0;
  const got = await assignSharedIdentity(f.db, "a", "My Shop", random, () => keys[k++]);
  assert.deepEqual(got, { publicName: "my-shop-k3x9q2", routeKey: "q7w8e9r0t1y2u3i4" }, "b holds my-shop and its key, so a gets neither");
  assert.deepEqual(f.writes, ["publicName=my-shop", "publicName=my-shop-k3x9q2", "routeKey=aaaaaaaaaaaaaaaa", "routeKey=q7w8e9r0t1y2u3i4"]);

  const again = await assignSharedIdentity(f.db, "a", "Something Else", () => "zzzzzz", () => "zzzzzzzzzzzzzzzz");
  assert.deepEqual(again, got, "a second call keeps what the first assigned");
  assert.equal(f.writes.length, 4, "and writes nothing");

  await assert.rejects(assignSharedIdentity(f.db, "missing", "x"), /doesn't exist/);
  const full = fakeDb({ a: { publicName: null, routeKey: null }, b: { publicName: "my-shop-same", routeKey: "bbbbbbbbbbbbbbbb" } });
  full.rows.c = { publicName: "my-shop", routeKey: "cccccccccccccccc" };
  await assert.rejects(assignSharedIdentity(full.db, "a", "My Shop", () => "same"), /no free publicName for service a after 8 tries/);
});

test("the migration keeps names and keys to their formats, unique, and ACTIVE shared mode needs both", () => {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", "20261112090000_shared_mode", "migration.sql"), "utf8");
  assert.match(sql, /CREATE UNIQUE INDEX "Service_publicName_key" ON "Service"\("publicName"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX "Service_routeKey_key" ON "Service"\("routeKey"\)/);
  assert.match(sql, /"publicName" ~ '\^\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\$' AND "publicName" NOT LIKE '%--%'/);
  assert.match(sql, /"routeKey" ~ '\^\[a-z0-9\]\{16\}\$'/);
  assert.match(sql, /"ipv4Mode" = 'SHARED' AND "privateIpv4" IS NOT NULL AND "publicName" IS NOT NULL AND "routeKey" IS NOT NULL/);
  assert.match(sql, /"sharedIpv4" BOOLEAN NOT NULL DEFAULT false/, "every node starts with shared IPv4 off");
});
