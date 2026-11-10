import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import axios from "axios";
import { formatResults, hasField, runHetznerChecks, type HetznerGet } from "./hetznerCheck";
import { describeFloatingIpv4, describeIncludedTraffic, describeTrafficPrice, HETZNER_INVOICE } from "./hetznerInvoice";
import { HetznerService } from "@/lib/hetzner";
import { CPX22, deprecatedUse, fakeHetzner, type FakeHetznerConfig } from "@/lib/testing/fakeHetzner";

/** The same GET the script makes, against the simulated API. */
function setup(cfg: FakeHetznerConfig = {}) {
  const hz = fakeHetzner(cfg);
  const client = axios.create({ adapter: hz.adapter });
  const get: HetznerGet = async (path, params) => (await client.get(path, { params })).data;
  return { hz, get };
}

test("the invoice facts: 20 TB a month per CPX server, then $1.20/TB; Floating IPv4 $0.0056/hour up to $3.50", () => {
  assert.deepEqual(HETZNER_INVOICE, { cpxIncludedTrafficTB: 20, trafficUsdPerTB: 1.2, floatingIpv4UsdHourly: 0.0056, floatingIpv4UsdMonthlyMax: 3.5 });
  assert.equal(describeIncludedTraffic(20e12), "included traffic: 20000000000000 bytes = 20.00 TB = 18.19 TiB");
  assert.equal(describeIncludedTraffic(20 * 2 ** 40), "included traffic: 21990232555520 bytes = 21.99 TB = 20.00 TiB", "20 TiB also matches: the API's unit isn't confirmed");
  assert.match(describeIncludedTraffic(2 * 2 ** 40), /= 2\.00 TiB — DIFFERS from the invoice's 20 TB$/, "the old 2 TiB note is caught");
  assert.match(describeIncludedTraffic(undefined), /not in the answer \(invoice: 20 TB\)/);
  assert.equal(describeTrafficPrice("1.20"), "traffic over the allowance: $1.20/TB");
  assert.match(describeTrafficPrice("1.00"), /\$1\.00\/TB — DIFFERS from the invoice's \$1\.20\/TB/);
  assert.match(describeTrafficPrice(undefined), /not in the answer \(invoice: \$1\.20\/TB\)/);
  assert.equal(describeFloatingIpv4(3.5), "$0.0056/hour, at most $3.50/month (invoice); the API lists $3.50/month");
  assert.match(describeFloatingIpv4(3.57), /the API lists \$3\.57\/month — DIFFERS from the invoice's \$3\.50/);
  assert.match(describeFloatingIpv4(null), /the API lists no monthly price/);
});

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
  assert.match(text, /cpx22 is buyable in nbg1: \$22\.99\/month, \$0\.0368\/hour/);
  assert.match(text, /nbg1 is in eu-central/);
  assert.match(text, /currency USD\n/);
  assert.match(text, /Primary IPv4 in nbg1: \$0\.50\/month/);
  assert.match(text, /included traffic: 20000000000000 bytes = 20\.00 TB = 18\.19 TiB\n/, "the API's bytes, as TB and TiB, matching the invoice");
  assert.match(text, /traffic over the allowance: \$1\.20\/TB\n/);
  assert.match(text, /Floating IPv4 in nbg1: \$0\.0056\/hour, at most \$3\.50\/month \(invoice\); the API lists \$3\.50\/month\n/);
  assert.doesNotMatch(text, /DIFFERS/);
  assert.doesNotMatch(text, /€/);
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

test("prints the SSH key names, flags any but sowsi-hosting, and flags servers that aren't ours", async () => {
  const { hz, get } = setup();
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  await h.createSshKey("sowsi-hosting", "ssh-ed25519 AAAA1");
  await h.createSshKey("sowsi-install", "ssh-ed25519 AAAA2");
  for (const name of ["sowsi-mgmt-01", "sowsi-proxmox-01", "sowsi-test-01", "someone-elses"]) {
    await h.createServer({ name, serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: name === "sowsi-test-01" ? { "sowsi-node-install": "1" } : {} });
  }
  const text = formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1" }));
  assert.match(text, /key sowsi-hosting/);
  assert.match(text, /UNEXPECTED key sowsi-install \(id \d+\)/);
  assert.doesNotMatch(text, /UNEXPECTED key sowsi-hosting/);
  assert.match(text, /NOT OURS: server \d+ someone-elses/);
  assert.doesNotMatch(text, /NOT OURS: server \d+ sowsi-/);
  assert.match(text, /All 10 checks passed/, "a flag is a warning, not a failed endpoint");
});

test("a server is ours by label, by its id, or by our naming", async () => {
  const { hz, get } = setup();
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const s = await h.createServer({ name: "renamed-node", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  assert.match(formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1" })), /NOT OURS/);
  assert.doesNotMatch(formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", ownServerIds: [String(s.id)] })), /NOT OURS/);
});

test("says so if Hetzner reports anything but dollars", async () => {
  const eur = setup({ currency: "EUR" });
  assert.match(formatResults(await runHetznerChecks(eur.get, { serverType: "cpx22", location: "nbg1" })), /currency EUR — costs here are worked out from USD/);
});

// ── Floating IPs that bill for nothing, and --expect-gone ────────────

const NODE = { name: "sowsi-proxmox-02", status: "READY" };

test("a Floating IP that's unassigned, or on a server that isn't a node in service, is flagged", async () => {
  const { hz, get } = setup();
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const node = await h.createServer({ name: "sowsi-proxmox-02", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const mgmt = await h.createServer({ name: "sowsi-mgmt-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const old = await h.createServer({ name: "sowsi-proxmox-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const onNode = await h.buyFloatingIP("customer", "nbg1");
  await h.assignFloatingIP(onNode.id, node.id);
  const loose = await h.buyFloatingIP("forgotten", "nbg1");
  const onMgmt = await h.buyFloatingIP("misplaced", "nbg1");
  await h.assignFloatingIP(onMgmt.id, mgmt.id);
  const onRetired = await h.buyFloatingIP("left behind", "nbg1");
  await h.assignFloatingIP(onRetired.id, old.id);
  const nodes = [
    { ...NODE, hetznerServerId: String(node.id) },
    { name: "sowsi-proxmox-01", hetznerServerId: String(old.id), status: "DECOMMISSIONING" },
  ];
  hz.requests.length = 0;
  const results = await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", nodes });
  const text = formatResults(results);
  assert.match(text, new RegExp(`Floating IP ${onNode.id} \\(198\\.51\\.100\\.7, "customer"\\) on node sowsi-proxmox-02\\n`));
  assert.doesNotMatch(text, new RegExp(`FLAG Floating IP ${onNode.id} `));
  assert.match(text, new RegExp(`FLAG Floating IP ${loose.id} \\(198\\.51\\.100\\.7, "forgotten"\\) is unassigned: billed \\$0\\.0056/hour, up to \\$3\\.50/month`));
  assert.match(text, new RegExp(`FLAG Floating IP ${onMgmt.id} .* is on server ${mgmt.id}, which isn't a registered node`));
  assert.match(text, new RegExp(`FLAG Floating IP ${onRetired.id} .* is on sowsi-proxmox-01, a retired node`));
  assert.match(text, /3 flag\(s\): see the FLAG lines above\./);
  assert.ok(results.every((r) => r.ok), "flags warn; they don't fail an endpoint");
  assert.ok(hz.requests.every((r) => r.method === "GET"), "GET only");

  const blind = formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", nodes: { problem: "the database couldn't be read: refused" } }));
  assert.match(blind, /registered nodes unknown \(the database couldn't be read: refused\): only unassigned Floating IPs can be flagged/);
  assert.match(blind, new RegExp(`FLAG Floating IP ${loose.id} `), "an unassigned one is still flagged");
  assert.doesNotMatch(blind, new RegExp(`FLAG Floating IP ${onMgmt.id} `), "nothing is claimed about servers it can't place");
});

test("--expect-gone fails while the server or anything it held is still there, and passes once it's all gone", async () => {
  const { hz, get } = setup({ primaryIpsSurviveDelete: true });
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const keep = await h.createServer({ name: "sowsi-mgmt-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const old = await h.createServer({ name: "sowsi-proxmox-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const id = String(old.id);
  const run = async () => {
    const results = await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", nodes: [], expectGone: [id] });
    return { gone: results.find((r) => r.endpoint === `EXPECT GONE: server ${id}`)!, text: formatResults(results) };
  };

  const before = await run();
  assert.equal(before.gone.ok, false);
  assert.match(before.text, new RegExp(`FAIL EXPECT GONE: server ${id}: NOT gone`));
  assert.match(before.text, new RegExp(`LEFT server ${id} still exists \\(sowsi-proxmox-01\\)`));
  assert.match(before.text, new RegExp(`LEFT server ${id} is still in the server list`));
  assert.match(before.text, new RegExp(`LEFT Primary IP \\d+ \\(203\\.0\\.113\\.\\d+\\) is still on server ${id}`));

  // Deleted by hand in the console, keeping its Primary IPs (they then sit unassigned).
  hz.state.servers.delete(old.id);
  for (const ip of hz.state.primaryIps.values()) if (ip.assignee_id === old.id) Object.assign(ip, { assignee_id: null, assignee_type: "unassigned" });
  const leftovers = await run();
  assert.equal(leftovers.gone.ok, false, "its Primary IPs survived the delete");
  assert.match(leftovers.text, new RegExp(`GET /servers/${id}: 404, the server is gone`));
  assert.match(leftovers.text, /LEFT Primary IP \d+ \(.*\) is unattached and bills hourly: if it was this server's, remove it in the console/);

  for (const ip of [...hz.state.primaryIps.values()]) if (ip.assignee_id === null) hz.state.primaryIps.delete(ip.id);
  hz.state.images.set(9001, { id: 9001, type: "snapshot", description: "node 1 before retiring", created_from: { id: old.id, name: "sowsi-proxmox-01" } });
  hz.requests.length = 0;
  const clean = await run();
  assert.equal(clean.gone.ok, true, clean.text);
  assert.match(clean.text, new RegExp(`OK   EXPECT GONE: server ${id}: gone, and nothing it held is left`));
  assert.match(clean.text, new RegExp(`no Primary IP, Floating IP or Volume left on server ${id}, and no unattached Primary IPs`));
  assert.match(clean.text, new RegExp(`snapshot 9001 \\(node 1 before retiring\\) of server ${id} still exists: billed until removed`), "a snapshot is shown, and left to you");
  assert.match(clean.text, /All 11 checks passed/);
  assert.ok(hz.requests.every((r) => r.method === "GET"), "the check only reads");
  assert.ok(hz.requests.some((r) => r.path === `/servers/${id}`) && hz.requests.some((r) => r.path === "/images" && r.params.type === "snapshot"));
  void keep;
});

test("--expect-gone also fails on a Floating IP or Volume still pointing at the server, and on a bad id", async () => {
  const { hz, get } = setup();
  const h = new HetznerService({ adapter: hz.adapter, token: "t", pollMs: 1 });
  const old = await h.createServer({ name: "sowsi-proxmox-01", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [], labels: {} });
  const fip = await h.buyFloatingIP("node 1", "nbg1");
  await h.assignFloatingIP(fip.id, old.id);
  const vol = await h.createVolume({ name: "data", sizeGB: 10, location: "nbg1" });
  await h.attachVolume(vol.id, old.id);
  await h.deleteServer(old.id).catch(() => undefined);
  hz.state.servers.delete(old.id);
  const text = formatResults(await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", nodes: [], expectGone: [String(old.id)] }));
  assert.match(text, new RegExp(`LEFT Floating IP ${fip.id} \\(198\\.51\\.100\\.7\\) is still on server ${old.id}`));
  assert.match(text, new RegExp(`LEFT Volume ${vol.id} \\(data\\) is still attached to server ${old.id}`));
  // Hetzner failing isn't proof that the server is gone.
  const flaky: typeof get = async (p, params) => {
    if (p === "/servers/424242") throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
    return get(p, params);
  };
  const down = (await runHetznerChecks(flaky, { serverType: "cpx22", location: "nbg1", nodes: [], expectGone: ["424242"] })).at(-1)!;
  assert.equal(down.ok, false);
  assert.ok(down.notes.some((n) => /^LEFT GET \/servers\/424242 couldn't tell: /.test(n)), down.notes.join("\n"));
  const bad = await runHetznerChecks(get, { serverType: "cpx22", location: "nbg1", expectGone: ["abc"] });
  assert.equal(bad.at(-1)!.ok, false);
  assert.match(bad.at(-1)!.detail, /"abc" isn't a server id/);
});
