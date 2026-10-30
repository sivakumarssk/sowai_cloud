import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HetznerError, HetznerService, serverTypeOffer, toServer } from "./hetzner";
import { CPX22, deprecatedUse, fakeHetzner, type FakeHetznerConfig } from "./testing/fakeHetzner";

const client = (cfg: FakeHetznerConfig = {}) => {
  const hz = fakeHetzner(cfg);
  return { hz, h: new HetznerService({ adapter: hz.adapter, token: "test", pollMs: 1 }) };
};
const buy = (h: HetznerService) => h.createServer({ name: "sowsi-proxmox-02", serverType: "cpx22", location: "nbg1", image: "debian-12", sshKeyIds: [1, 2], labels: { a: "1" } });

// ── The deprecated list itself ───────────────────────────────────────

test("the deprecated list catches removed endpoints and fields", () => {
  const req = (method: string, p: string, body?: Record<string, unknown>, params = {}) => ({ method, path: p, params, body });
  for (const [r, why] of [
    [req("GET", "/datacenters"), /removed/],
    [req("GET", "/datacenters/4"), /removed/],
    [req("GET", "/actions"), /removed/],
    [req("GET", "/servers/5/actions/9"), /deprecated/],
    [req("POST", "/servers", { name: "x", datacenter: "nbg1-dc3" }), /datacenter property/],
    [req("POST", "/volumes/1/actions/attach", { server: 5 }), /use assignee/],
    [req("POST", "/volumes", { server: 5, name: "v", size: 10 }), /use assignee/],
    [req("POST", "/volumes", { automount: false, name: "v", size: 10 }), /automount/],
  ] as const) {
    assert.match(deprecatedUse(r).join(), why, r.path);
  }
  assert.deepEqual(deprecatedUse(req("GET", "/actions/9")), []);
  assert.deepEqual(deprecatedUse(req("POST", "/volumes/1/actions/attach", { assignee: { id: 5, type: "server" } })), []);
  assert.deepEqual(deprecatedUse(req("POST", "/floating_ips/1/actions/assign", { server: 5 })), [], "a Floating IP's server isn't deprecated");
});

test("no Hetzner code names a removed endpoint or field", () => {
  const dirs = ["src/lib", "src/lib/nodes", "src/engine/data", "src/engine/actions", "src/lib/provisioning", "src/lib/billing", "scripts/node", "scripts/engine"];
  const files = dirs.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(d, f)) : []));
  assert.ok(files.length > 30);
  const banned: [RegExp, string][] = [
    [/\/datacenters\b/, "the Data Center endpoints"],
    [/\.datacenter\b|\bdatacenter:/, "the datacenter property"],
    [/\.recommendation\b/, "server type recommendation"],
    [/\.deprecated\b/, "the deprecated field (removed 2026-11-02)"],
    [/["'`]\/actions["'`]/, "GET /actions"],
    [/price_per_gb|pricing\.floating_ip\b/, "deprecated pricing fields"],
  ];
  for (const f of files) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const [re, what] of banned) assert.doesNotMatch(code, re, `${f} uses ${what}`);
  }
});

// ── Servers ──────────────────────────────────────────────────────────

test("server create sends location (never datacenter) and reads the live server shape", async () => {
  const { h, hz } = client();
  const s = await buy(h);
  const body = hz.requests.find((r) => r.method === "POST" && r.path === "/servers")!.body!;
  assert.equal(body.location, "nbg1");
  assert.ok(!("datacenter" in body));
  assert.deepEqual(body.public_net, { enable_ipv4: true, enable_ipv6: true });
  assert.equal(s.location, "nbg1");
  assert.equal(s.serverType, "cpx22");
  assert.equal(s.ipv4, "203.0.113.20");
  assert.equal(s.ipv6Network, "2a01:4f8:1c1c:abcd::/64");
  assert.equal(s.primaryIpIds.length, 2);
  assert.equal((await h.findServerByName("sowsi-proxmox-02"))!.id, s.id);
  assert.equal(await h.findServerByName("other"), null);
  assert.equal(await h.getServer(1), null, "404 is null");
});

test("a server response without the removed datacenter property parses; one without location is a loud error, not a guess", () => {
  const row = { id: 1, name: "n", status: "running", server_type: { name: "cpx22" }, location: { name: "nbg1" }, public_net: { ipv4: null, ipv6: null }, labels: {} };
  assert.equal(toServer(row).location, "nbg1");
  assert.deepEqual(toServer(row).primaryIpIds, []);
  assert.throws(() => toServer({ ...row, location: undefined as never }));
});

test("hard errors carry Hetzner's code", async () => {
  const { h } = client({ createError: { status: 422, code: "resource_unavailable", message: "unavailable" } });
  await assert.rejects(buy(h), (e: HetznerError) => e instanceof HetznerError && e.code === "resource_unavailable" && e.status === 422);
});

test("/datacenters answers like the live API", async () => {
  const { hz } = client();
  await assert.rejects(hz.adapter({ url: "/datacenters", method: "get", headers: {} } as never), (e: { response: { status: number; data: { error: { code: string } } } }) => e.response.status === 410 && e.response.data.error.code === "deprecated_api_endpoint");
});

test("server delete waits for the action and its Primary IPs go with it", async () => {
  const { h, hz } = client();
  const s = await buy(h);
  assert.equal(hz.state.primaryIps.size, 2);
  assert.deepEqual(await h.deleteServer(s.id), { primaryIpsRemoved: [], primaryIpsLeft: [] });
  assert.equal(hz.state.servers.size, 0);
  assert.equal(hz.state.primaryIps.size, 0);
});

test("Primary IPs a delete leaves behind are removed, since an unattached IPv4 keeps billing", async () => {
  const { h, hz } = client({ primaryIpsSurviveDelete: true });
  const s = await buy(h);
  assert.deepEqual(await h.deleteServer(s.id), { primaryIpsRemoved: s.primaryIpIds, primaryIpsLeft: [] });
  assert.equal(hz.state.primaryIps.size, 0);
});

test("Primary IPs that can't be removed are reported, not hidden; an already-deleted server is fine", async () => {
  const { h, hz } = client({ primaryIpsSurviveDelete: true, primaryIpDeleteFails: true });
  const s = await buy(h);
  assert.deepEqual(await h.deleteServer(s.id), { primaryIpsRemoved: [], primaryIpsLeft: s.primaryIpIds });
  assert.equal(hz.state.primaryIps.size, 2);
  assert.deepEqual(await h.deleteServer(s.id), { primaryIpsRemoved: [], primaryIpsLeft: [] });
});

// ── Availability and price ───────────────────────────────────────────

test("availability and price come from the server type's own entry for that location", () => {
  assert.deepEqual(serverTypeOffer(CPX22 as never, "nbg1"), { buyable: true, reason: null, price: { hourlyEur: 0.0368, monthlyEur: 22.99 } });
  assert.match(serverTypeOffer(CPX22 as never, "ash").reason!, /isn't sold in ash/);
});

test("reads the server type and IP prices", async () => {
  const { h, hz } = client();
  assert.equal((await h.getServerType("cpx22"))!.id, 109);
  assert.equal(await h.getServerType("cpx99"), null);
  assert.deepEqual(await h.ipPrices("nbg1"), { primaryIpv4: { hourlyEur: 0.0008, monthlyEur: 0.5 }, floatingIpv4MonthlyEur: 3.57 });
  assert.deepEqual(await h.ipPrices("ash"), { primaryIpv4: null, floatingIpv4MonthlyEur: null });
  assert.deepEqual(hz.requests.flatMap(deprecatedUse), []);
});

// ── Floating IPs, Volumes, SSH keys, actions ─────────────────────────

test("Floating IP: create, assign, then release unassigns first (a delete while assigned is refused)", async () => {
  const { h, hz } = client();
  const s = await buy(h);
  const ip = await h.buyFloatingIP("sowsi-svc", "nbg1");
  const create = hz.requests.find((r) => r.path === "/floating_ips" && r.method === "POST")!.body!;
  assert.deepEqual(create, { type: "ipv4", home_location: "nbg1", description: "sowsi-svc" });
  await h.assignFloatingIP(ip.id, s.id);
  assert.equal((await h.getFloatingIP(ip.id))!.server, s.id);
  assert.equal((await h.listFloatingIPs())[0].homeLocation, "nbg1");
  await h.releaseFloatingIP(ip.id);
  assert.equal(await h.getFloatingIP(ip.id), null);
  const paths = hz.requests.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.indexOf(`POST /floating_ips/${ip.id}/actions/unassign`) < paths.indexOf(`DELETE /floating_ips/${ip.id}`));
  await h.releaseFloatingIP(ip.id); // already gone: fine
});

test("Volume: create without a server, attach with assignee, detach, delete", async () => {
  const { h, hz } = client();
  const s = await buy(h);
  const v = await h.createVolume({ name: "sowsi-vol", sizeGB: 100, location: "nbg1", labels: { a: "1" } });
  assert.equal(v.server, null);
  assert.deepEqual(hz.requests.find((r) => r.path === "/volumes" && r.method === "POST")!.body, { name: "sowsi-vol", size: 100, location: "nbg1", format: "ext4", labels: { a: "1" } });
  await h.attachVolume(v.id, s.id);
  assert.deepEqual(hz.requests.find((r) => r.path.endsWith("/actions/attach"))!.body, { assignee: { id: s.id, type: "server" }, automount: false });
  assert.equal((await h.getVolume(v.id))!.server, s.id, "read from assignee");
  await h.deleteVolume(v.id);
  assert.equal(await h.getVolume(v.id), null);
  assert.ok(hz.requests.some((r) => r.path.endsWith("/actions/detach")), "detached first");
  assert.deepEqual(hz.requests.flatMap(deprecatedUse), []);
});

test("SSH keys: public key sent without leading whitespace; listed and deleted", async () => {
  const { h, hz } = client();
  const k = await h.createSshKey("sowsi-install", "  ssh-ed25519 AAAA key\n", { a: "1" });
  assert.equal(hz.requests[0].body!.public_key, "ssh-ed25519 AAAA key");
  assert.equal((await h.listSshKeys())[0].id, k.id);
  await h.deleteSshKey(k.id);
  await h.deleteSshKey(k.id);
  assert.deepEqual(await h.listSshKeys(), []);
});

test("action polling uses GET /actions/{id} until the action finishes", async () => {
  const { h, hz } = client({ actionPollsRunning: 2 });
  const ip = await h.buyFloatingIP("x", "nbg1");
  const s = await buy(h);
  await h.assignFloatingIP(ip.id, s.id);
  const polls = hz.requests.filter((r) => /^\/actions\/\d+$/.test(r.path));
  assert.ok(polls.length >= 3, `${polls.length} polls`);
  assert.deepEqual(hz.requests.flatMap(deprecatedUse), []);
});
