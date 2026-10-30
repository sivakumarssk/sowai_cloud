import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";
import { formatResults, hasField, runHetznerChecks, type HetznerGet } from "./hetznerCheck";
import { HetznerService } from "@/lib/hetzner";
import { CPX22, deprecatedUse, fakeHetzner, type FakeHetznerConfig } from "@/lib/testing/fakeHetzner";

/** The same GET the script makes, against the simulated API. */
function setup(cfg: FakeHetznerConfig = {}) {
  const hz = fakeHetzner(cfg);
  const client = axios.create({ adapter: hz.adapter });
  const get: HetznerGet = async (path, params) => (await client.get(path, { params })).data;
  return { hz, get };
}

test("hasField: nested paths, lists, and null counts as present", () => {
  const row = { a: { b: 1 }, list: [{ c: null }], empty: [] };
  assert.ok(hasField(row, "a.b"));
  assert.ok(hasField(row, "list[].c"), "null is a value");
  assert.ok(hasField(row, "empty[].x"), "nothing to check on an empty list");
  assert.equal(hasField(row, "a.x"), false);
  assert.equal(hasField(row, "list[].d"), false);
  assert.equal(hasField({ a: 1 }, "a[].b"), false);
});

test("every endpoint answers, every field we read is there, and only GETs are sent", async () => {
  const { hz, get } = setup();
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const server = await h.createServer({ name: "sowsi-mgmt-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  await h.createSshKey("k", "ssh-ed25519 AAAA");
  await h.buyFloatingIP("f", "nbg1");
  await h.createVolume({ name: "v", sizeGB: 10, location: "nbg1" });
  hz.requests.length = 0;

  const results = await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1" });
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.deepEqual(results.map((r) => r.endpoint), [
    "GET /server_types?name=cpx22",
    "GET /locations",
    "GET /pricing",
    "GET /ssh_keys",
    "GET /servers",
    "GET /floating_ips",
    "GET /volumes",
    "GET /primary_ips",
    `GET /servers/${server.id}/actions`,
    "GET /actions/{id}",
  ]);
  assert.ok(hz.requests.every((r) => r.method === "GET"), "GET only");
  assert.deepEqual(hz.requests.flatMap(deprecatedUse), []);
  const text = formatResults(results);
  assert.match(text, /cpx22 is buyable in nbg1: €22\.99\/month, €0\.0368\/hour/);
  assert.match(text, /nbg1 is in eu-central/);
  assert.match(text, /Primary IPv4 in nbg1: €0\.50\/month/);
  assert.match(text, /no unattached Primary IPs/);
  assert.match(text, /All 10 checks passed/);
  assert.doesNotMatch(text, /ssh-ed25519/, "public keys aren't printed");
});

test("reports a type that can't be bought, a missing field, and a failing endpoint", async () => {
  const off = setup({ serverTypes: [{ ...CPX22, locations: [{ ...CPX22.locations[0], available: false }] }] });
  assert.match(formatResults(await runHetznerChecks(off.get, { serverType: "cpx22", location: "nbg1" })), /NOT buyable: cpx22 isn't available in nbg1/);

  const noField = setup({ serverTypes: [{ ...CPX22, locations: [{ name: "nbg1" }] }] });
  const r = await runHetznerChecks(noField.get, { serverType: "cpx22", location: "nbg1" });
  assert.deepEqual(r[0].missing, ["locations[].available", "locations[].deprecation"]);
  assert.equal(r[0].ok, false);

  const down = setup({ pricingError: { status: 503, code: "service_error", message: "down" } });
  const text = formatResults(await runHetznerChecks(down.get, { serverType: "cpx22", location: "nbg1" }));
  assert.match(text, /FAIL GET \/pricing: 503 service_error: down/);
  assert.match(text, /1 of \d+ checks failed/);
});

test("flags an unattached Primary IP, which bills hourly", async () => {
  const { hz, get } = setup({ primaryIpsSurviveDelete: true });
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const s = await h.createServer({ name: "x-1", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  hz.state.servers.delete(s.id);
  for (const ip of hz.state.primaryIps.values()) ip.assignee_id = null;
  assert.match(formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1" })), /UNATTACHED Primary IP \d+ \(203\.0\.113\.20, ipv4\) — bills hourly/);
});

test("the check can only read: no write method anywhere in the script or its module", () => {
  for (const f of ["scripts/node/hetzner-check.ts", "src/lib/nodes/hetznerCheck.ts"]) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /axios\.(post|put|patch|delete|request)\b|method:|\.(post|put|patch|delete)\(/, f);
    assert.doesNotMatch(code, /new HetznerService|\bhetzner\.[a-zA-Z]+\(/, `${f} must not use the read-write client`);
  }
});
