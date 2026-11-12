import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { prepareIpv4, setupAddress, sharedRefusal, type NetworkDeps } from "./serviceNetwork";

const NODE = { name: "sowsi-test-07", location: "nbg1", hetznerServerId: 175800001, sharedIpv4: true };

function deps(over: Partial<NetworkDeps> = {}) {
  const calls: string[] = [];
  const d: NetworkDeps = {
    buyFloatingIP: async (name, location) => (calls.push(`buy ${name} ${location}`), { id: 555, ip: "78.46.1.2" }),
    saveFloatingIP: async (id, ip) => void calls.push(`save ${id} ${ip.id} ${ip.ip}`),
    assignFloatingIP: async (id, server) => void calls.push(`assign ${id} ${server}`),
    assignPrivateIpv4: async (id) => (calls.push(`private ${id}`), "100.64.0.5"),
    assignSharedIdentity: async (id, hint) => (calls.push(`identity ${id} ${hint}`), { publicName: "my-shop", routeKey: "q7w8e9r0t1y2u3i4" }),
    progress: async (step) => void calls.push(`step ${step}`),
    ...over,
  };
  return { d, calls };
}

test("dedicated: buys the Floating IP, hands its id over at once, saves it, then routes it to the node", async () => {
  const { d, calls } = deps();
  const seen: number[] = [];
  const plan = await prepareIpv4(d, { serviceId: "svc_1", mode: "DEDICATED", node: { ...NODE, sharedIpv4: false }, hasCoolify: true, hostname: "shop", onFloatingIp: (id) => seen.push(id) });
  assert.deepEqual(plan, { mode: "DEDICATED", ipv4: "78.46.1.2", floatingIpId: 555 });
  assert.deepEqual(calls, ["buy sowsi-svc_1 nbg1", "save svc_1 555 78.46.1.2", "step Assigning IP address...", "assign 555 175800001"]);
  assert.deepEqual(seen, [555]);
  assert.equal(setupAddress(plan, "2a01::101"), "78.46.1.2", "setup logs in over the Floating IP");
});

test("a failure after the purchase still leaves the caller the Floating IP's id to release", async () => {
  const { d } = deps({ saveFloatingIP: async () => { throw new Error("database down"); } });
  const seen: number[] = [];
  await assert.rejects(prepareIpv4(d, { serviceId: "svc_1", mode: "DEDICATED", node: NODE, hasCoolify: false, hostname: null, onFloatingIp: (id) => seen.push(id) }), /database down/);
  assert.deepEqual(seen, [555]);
});

test("shared: no Floating IP; its private address, name and route key; setup over its IPv6", async () => {
  const { d, calls } = deps();
  const plan = await prepareIpv4(d, { serviceId: "svc_2", mode: "SHARED", node: NODE, hasCoolify: false, hostname: "My Shop", onFloatingIp: () => assert.fail("no Floating IP in shared mode") });
  assert.deepEqual(plan, { mode: "SHARED", ipv4: "100.64.0.5", publicName: "my-shop", routeKey: "q7w8e9r0t1y2u3i4" });
  assert.deepEqual(calls, ["step Assigning a private address...", "private svc_2", "identity svc_2 My Shop"]);
  assert.ok(!calls.some((c) => c.startsWith("buy") || c.startsWith("assign ")), "nothing bought or assigned at Hetzner");
  assert.equal(setupAddress(plan, "2a01:4f8:1c16:5f11::101"), "2a01:4f8:1c16:5f11::101");
  assert.throws(() => setupAddress(plan, ""), /set up over IPv6, and it has none/);
});

test("shared mode is refused before anything happens: a node without the flag or gateway, or a Coolify server", async () => {
  assert.equal(sharedRefusal({ mode: "DEDICATED", node: { ...NODE, sharedIpv4: false }, hasCoolify: true }), null, "dedicated is never refused here");
  assert.match(sharedRefusal({ mode: "SHARED", node: { ...NODE, sharedIpv4: false }, hasCoolify: false }) ?? "", /doesn't take shared-IPv4 services/);
  assert.match(sharedRefusal({ mode: "SHARED", node: NODE, hasCoolify: true }) ?? "", /Coolify server keeps a dedicated IPv4/);
  for (const [node, coolify] of [[{ ...NODE, sharedIpv4: false }, false], [NODE, true]] as const) {
    const { d, calls } = deps();
    await assert.rejects(prepareIpv4(d, { serviceId: "svc_3", mode: "SHARED", node, hasCoolify: coolify, hostname: null, onFloatingIp: () => {} }), /shared IPv4 refused/);
    assert.deepEqual(calls, [], "nothing assigned, nothing bought");
  }
  await assert.rejects(prepareIpv4(deps().d, { serviceId: "svc_4", mode: "BOTH", node: NODE, hasCoolify: false, hostname: null, onFloatingIp: () => {} }), /unknown IPv4 mode "BOTH"/);
});

test("provisionVPS takes the IPv4 from prepareIpv4, sets up over setupAddress, and syncs the gateway for shared mode", () => {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "provisioning", "provisionVPS.ts"), "utf8");
  assert.match(src, /await prepareIpv4\(networkDeps\(serviceId, hasCoolify\), \{/);
  assert.match(src, /ipv4: ip\.ipv4,/, "the container gets the planned address");
  assert.match(src, /ipAddress: setupAddress\(ip, ipv6\)/);
  assert.doesNotMatch(src, /hetzner\.buyFloatingIP\(`sowsi-/, "no second purchase path");
  const ready = src.indexOf('status: "ACTIVE"');
  const sync = src.indexOf('if (ip.mode === "SHARED") await syncGatewayAfterChange(placement.node.id');
  assert.ok(ready > 0 && sync > ready, "the route is sent once the service is ACTIVE (the table only lists ACTIVE and SUSPENDED)");
  const cancel = src.indexOf('if (service.ipv4Mode === "SHARED" && service.nodeId) await syncGatewayAfterChange(service.nodeId');
  assert.ok(cancel > 0 && cancel < src.indexOf("const errors = await releaseResources("), "a cancelled service's route goes before its container");
});

test("no customer order can be shared before Stage G: only the test-order script ever writes SHARED", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "generated") walk(p); }
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(path.join(process.cwd(), "src"));
  walk(path.join(process.cwd(), "scripts"));
  const writers = files.filter((f) => /ipv4Mode:\s*"SHARED"/.test(readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"));
  // Each of these only reads it (a query filter), apart from the test-order script. A new one needs a look.
  assert.deepEqual(writers.sort(), [
    "scripts/node/node-state.ts",
    "scripts/node/shared-test-order.ts",
    "src/lib/nodes/gatewaySyncDeps.ts",
    "src/lib/provisioning/serverReady.ts",
  ]);
  for (const f of ["scripts/node/node-state.ts", "src/lib/nodes/gatewaySyncDeps.ts", "src/lib/provisioning/serverReady.ts"]) {
    const lines = readFileSync(path.join(process.cwd(), f), "utf8").split("\n").filter((l) => /ipv4Mode:\s*"SHARED"/.test(l));
    for (const l of lines) assert.match(l, /where: \{|OR: \[|\{ serverSource: "PROXMOX"/, `${f} filters, never writes: ${l.trim()}`);
  }
  assert.match(readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"), /ipv4Mode\s+Ipv4Mode\s+@default\(DEDICATED\)/);
});
