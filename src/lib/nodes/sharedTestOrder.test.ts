import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as T from "./sharedTestOrder";

const NODE: T.TestNode = { name: "sowsi-test-07", status: "READY", acceptNewClients: false, sharedIpv4: true, gatewayIpv4: "198.51.100.7", gatewayVmId: 9000, hasOwnToken: true, ipv6Subnet: "2a01:4f8:1c16:5f11" };
const PLAN: T.TestPlan = { slug: "VPS_BASIC", name: "VPS Basic", category: "VPS", coolify: false };

test("a test order needs a closed throwaway with its gateway and shared IPv4 on, a VPS plan without Coolify, room, and no earlier test order", () => {
  assert.deepEqual(T.testOrderProblems({ node: NODE, plan: PLAN, fit: null, liveTestServices: [] }), []);
  const cases: [Partial<Parameters<typeof T.testOrderProblems>[0]>, RegExp][] = [
    [{ node: { ...NODE, acceptNewClients: true } }, /open to customers: a throwaway node stays closed, so no real order can land on it/],
    [{ node: { ...NODE, sharedIpv4: false } }, /shared IPv4 off: turn it on with node-state.ts --shared on/],
    [{ node: { ...NODE, gatewayIpv4: null } }, /has no gateway/],
    [{ node: { ...NODE, status: "DECOMMISSIONING" } }, /is retired/],
    [{ node: { ...NODE, hasOwnToken: false } }, /no API token/],
    [{ node: null }, /no such node/],
    [{ plan: { ...PLAN, coolify: true, name: "VPS Pro" } }, /VPS Pro includes Coolify, which keeps a dedicated IPv4/],
    [{ plan: { ...PLAN, category: "STORAGE" } }, /isn't a VPS plan/],
    [{ fit: "sowsi-test-07 has 512 MB RAM free, needs 2048 MB" }, /needs 2048 MB/],
    [{ liveTestServices: ["svc_1 ACTIVE"] }, /a test order still exists \(svc_1 ACTIVE\): clean it up first/],
  ];
  for (const [over, why] of cases) {
    const problems = T.testOrderProblems({ node: NODE, plan: PLAN, fit: null, liveTestServices: [], ...over });
    assert.match(problems.join("; "), why);
  }
});

test("the installer's new node (PROVISIONING, closed) passes the script's checks and placement's pinned fit; opened, it's refused", async () => {
  const { nodeFit } = await import("@/lib/provisioning/placement");
  const fresh = { ...NODE, status: "PROVISIONING" };
  assert.deepEqual(T.testOrderProblems({ node: fresh, plan: PLAN, fit: null, liveTestServices: [] }), [], "as on sowsi-test-07");
  const load = { id: "n7", name: fresh.name, ip: "203.0.113.20", hetznerServerId: "175974701", location: "nbg1", ipv6Subnet: fresh.ipv6Subnet, acceptNewClients: false, status: "PROVISIONING", sharedIpv4: true, physicalRamMB: 8192, physicalDiskGB: 160, maxContainers: 6, monitor: null, settled: { ramMB: 0, diskGB: 0, count: 0 }, inFlight: { ramMB: 0, diskGB: 0, count: 0 } };
  const config = { ramOvercommit: 1, diskOvercommit: 1, diskPoolReserveGB: 20, hostRamReserveMB: 1536 };
  assert.equal(nodeFit(load, { ramMB: 2048, diskGB: 40, shared: true }, config, true).ok, true, "the fit the script reports in its plan");
  assert.match(T.testOrderProblems({ node: { ...fresh, acceptNewClients: true }, plan: PLAN, fit: null, liveTestServices: [] }).join(), /open to customers/);
  const opened = nodeFit({ ...load, acceptNewClients: true }, { ramMB: 2048, diskGB: 40, shared: true }, config, true);
  assert.match(opened.ok ? "" : opened.reason, /open to customers/);
});

const ACTIVE = {
  status: "ACTIVE", serverSource: "PROXMOX", serverIp: null, ipv6Address: "2a01:4f8:1c16:5f11::101", proxmoxVmId: "101", nodeId: "n1",
  hetznerFloatingIpId: null, ipv4Mode: "SHARED", privateIpv4: "100.64.0.5", publicName: "shared-test", routeKey: "q7w8e9r0t1y2u3i4", sshVerifiedAt: new Date(),
};

test("ACTIVE as shared: a private address, a name, a route key, and nothing bought", () => {
  assert.deepEqual(T.checkSharedService(ACTIVE), []);
  assert.match(T.checkSharedService({ ...ACTIVE, hetznerFloatingIpId: "555" }).join(), /it has a Floating IP \(555\): shared mode buys none/);
  assert.match(T.checkSharedService({ ...ACTIVE, serverIp: "78.46.1.2" }).join(), /no IPv4 of its own/);
  assert.match(T.checkSharedService({ ...ACTIVE, privateIpv4: "100.127.255.11" }).join(), /isn't one a service can have/, "never the installer's test block");
  assert.match(T.checkSharedService({ ...ACTIVE, ipv4Mode: "DEDICATED" }).join(), /not SHARED/);
  assert.match(T.checkSharedService({ ...ACTIVE, status: "FAILED" }).join(), /not ACTIVE/);
  assert.match(T.checkSharedService({ ...ACTIVE, routeKey: null }).join(), /no route key/);
});

test("its net0: the private address on vmbr1, a gateway, and its IPv6", () => {
  const net0 = "name=eth0,bridge=vmbr1,gw=172.31.1.1,gw6=fe80::1,hwaddr=BC:24:11:AA:BB:01,ip=100.64.0.5/32,ip6=2a01:4f8:1c16:5f11::101/64,type=veth";
  assert.deepEqual(T.checkSharedNet0(net0, "100.64.0.5", "2a01:4f8:1c16:5f11::101"), []);
  assert.match(T.checkSharedNet0(net0.replace("ip=100.64.0.5/32", "ip=203.0.113.7/32"), "100.64.0.5", "2a01:4f8:1c16:5f11::101").join(), /not 100\.64\.0\.5\/32/);
  assert.match(T.checkSharedNet0(net0.replace("vmbr1", "vmbr0"), "100.64.0.5", "2a01:4f8:1c16:5f11::101").join(), /on vmbr0, not vmbr1/);
  assert.match(T.checkSharedNet0(net0.replace("gw=172.31.1.1,", ""), "100.64.0.5", "2a01:4f8:1c16:5f11::101").join(), /no IPv4 gateway/);
  assert.deepEqual(T.checkSharedNet0(null, "100.64.0.5", "x"), ["the container has no net0 line"]);
});

test("the requests go to the gateway by the service's name, with no shell; a bad gateway address is refused", () => {
  assert.deepEqual(T.sharedProbeArgs("198.51.100.7", "shared-test", "http"), ["-sS", "-m", "10", "-w", "\\ncode=%{http_code}", "--resolve", "shared-test.c.sowsicloud.com:80:198.51.100.7", "-H", "X-Forwarded-For: 198.51.100.66", "http://shared-test.c.sowsicloud.com/"]);
  assert.deepEqual(T.sharedProbeArgs("198.51.100.7", "shared-test", "https").slice(5), ["-k", "--resolve", "shared-test.c.sowsicloud.com:443:198.51.100.7", "https://shared-test.c.sowsicloud.com/"]);
  assert.match(T.sharedProbeArgs("198.51.100.7", "shared-test", "http_unknown").join(" "), /unknown\.gateway\.test:80:198\.51\.100\.7/);
  assert.throws(() => T.sharedProbeArgs("198.51.100.7; reboot", "shared-test", "http"), /gateway address/);
});

const reply = (body: string, code: string, exit = 0) => ({ exit, stdout: `${body}\ncode=${code}` });

test("routing: its name reaches the test container on both ports, the client's own X-Forwarded-For is dropped, another name gets the 404", () => {
  const good = { http: reply("shared-test xff=2.31.11.105", "200"), https: reply("shared-test xff=-", "200"), http_unknown: reply("", "404") };
  assert.deepEqual(T.checkSharedRouting(good, "shared-test"), { problems: [], clientIp: "2.31.11.105" });
  const cases: [Partial<typeof good>, RegExp][] = [
    [{ http: reply("shared-test xff=198.51.100.66, 2.31.11.105", "200") }, /client's own X-Forwarded-For/],
    [{ http: reply("backend-101 xff=2.31.11.105", "200") }, /reached backend-101, not shared-test/],
    [{ https: reply("", "000", 35) }, /on port 443 got 000/],
    [{ https: reply("shared-test xff=2.31.11.105", "200") }, /TLS should pass through untouched/],
    [{ http_unknown: reply("shared-test xff=2.31.11.105", "200") }, /an unknown name got 200/],
    [{ http: reply("", "503") }, /on port 80 got 503/],
  ];
  for (const [over, why] of cases) assert.match(T.checkSharedRouting({ ...good, ...over }, "shared-test").problems.join("; "), why);
  assert.deepEqual(T.checkRouteGone(reply("", "404"), "shared-test"), []);
  assert.match(T.checkRouteGone(reply("shared-test xff=2.31.11.105", "200"), "shared-test").join(), /still got 200 after the cleanup/);
});

test("the script never prints a password, builds with refunds and emails off, pinned, and cleans up only the test customer's own order", () => {
  const src = readFileSync(path.join(process.cwd(), "scripts", "node", "shared-test-order.ts"), "utf8");
  assert.match(src, /provisionVPS\(service\.id, \{ refundOnFailure: false, notifyCustomer: false, pinNodeId: row!\.id \}\)/);
  assert.match(src, /billingHold: true,/);
  assert.match(src, /exitUnlessEnvironment\("the shared-mode test order"\)/, "production only");
  assert.match(src, /belongs to \$\{s\.user\.email\}, not the test customer: not touching it/);
  assert.match(src, /payment\(s\) and \$\{s\._count\.subscriptions\} subscription\(s\): a test order has none/);
  for (const line of src.split("\n").filter((l) => /say\(|console\.(log|error)\(/.test(l))) assert.doesNotMatch(line, /password\b(?!\s*(or|auth))/i, line.trim());
  assert.equal(T.TEST_CUSTOMER_EMAIL.endsWith(".invalid"), true, "an address that can't receive mail");
});
