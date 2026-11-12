import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SERVICE_DNS_LIVE, SHARED_NOTICE, serviceConnection } from "./connection";

const dedicated = { serverSource: "PROXMOX", ipv4Mode: "DEDICATED", serverIp: "78.46.1.2", ipv6Address: "2a01:4f8:1c16:5f11::101", publicName: null, sshUsername: "userab12", node: { gatewayIpv4: "198.51.100.7" } };
const shared = { ...dedicated, ipv4Mode: "SHARED", serverIp: null, publicName: "my-shop" };

test("dedicated: its own IPv4, SSH to it, no notice", () => {
  const c = serviceConnection(dedicated);
  assert.deepEqual(c, {
    mode: "DEDICATED",
    tag: "Dedicated",
    label: "Dedicated IPv4",
    ipv4: "78.46.1.2",
    ipv4Note: "Yours alone",
    ipv6: "2a01:4f8:1c16:5f11::101",
    hostname: null,
    sshCommand: "ssh userab12@78.46.1.2",
    notice: null,
  });
  assert.equal(serviceConnection({ ...dedicated, sshUsername: null }).sshCommand, null, "no username, no command");
});

test("shared: the gateway's IPv4 for websites, SSH over its own IPv6, and the notice says so", () => {
  const c = serviceConnection(shared);
  assert.equal(c.mode, "SHARED");
  assert.equal(c.tag, "Shared");
  assert.equal(c.label, "Shared IPv4");
  assert.equal(c.ipv4, "198.51.100.7", "the node's gateway, never the service's own field");
  assert.equal(c.ipv4Note, "Shared with other websites: ports 80 and 443 only");
  assert.equal(c.sshCommand, "ssh userab12@2a01:4f8:1c16:5f11::101");
  assert.equal(c.notice, SHARED_NOTICE);
  assert.match(SHARED_NOTICE, /ports 80 and 443 \(websites\) only/);
  assert.match(SHARED_NOTICE, /SSH and every other port work over IPv6/);
  assert.doesNotMatch(SHARED_NOTICE, /₹|add-on|\d+ a month/i, "no add-on or price until Stage G");
  assert.equal(serviceConnection({ ...shared, node: null }).ipv4, null, "no gateway known: no IPv4 shown");
  assert.equal(serviceConnection({ ...shared, serverIp: "78.46.1.2" }).ipv4, "198.51.100.7", "a stray serverIp isn't shown as its own");
});

test("until Stage D, a service's name isn't offered as an address: it isn't in DNS yet", () => {
  assert.equal(SERVICE_DNS_LIVE, false);
  assert.equal(serviceConnection(shared).hostname, null);
  assert.doesNotMatch(serviceConnection(shared).sshCommand ?? "", /sowsicloud/);
});

test("a manual server is always Dedicated, with its port when it isn't 22", () => {
  const manual = { serverSource: "MANUAL", ipv4Mode: "SHARED", serverIp: "203.0.113.7", ipv6Address: null, sshUsername: "root", sshPort: 2222 };
  const c = serviceConnection(manual);
  assert.equal(c.mode, "DEDICATED", "even if the row says SHARED");
  assert.equal(c.ipv4, "203.0.113.7");
  assert.equal(c.sshCommand, "ssh -p 2222 root@203.0.113.7");
  assert.equal(serviceConnection({ ...manual, sshPort: 22 }).sshCommand, "ssh root@203.0.113.7");
});

test("every place that shows a server's IP words it through serviceConnection()", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), ...p.split("/")), "utf8");
  for (const p of [
    "src/app/api/services/route.ts",
    "src/app/api/services/[id]/status/route.ts",
    "src/app/api/orders/[id]/status/route.ts",
    "src/app/api/admin/services/route.ts",
    "src/lib/provisioning/provisionVPS.ts",
    "src/lib/provisioning/manualServerDeps.ts",
  ]) assert.match(read(p), /serviceConnection\(/, p);
  for (const p of ["src/app/(client)/dashboard/services/page.tsx", "src/app/(public)/order/[planId]/provisioning/ProvisioningClient.tsx", "src/app/(admin)/admin/servers/page.tsx"]) {
    const text = read(p);
    assert.match(text, /<Ipv4Tag connection=/, `${p} tags the IPv4 Shared or Dedicated`);
    assert.doesNotMatch(text, /`ssh \$\{/, `${p} builds no SSH command of its own`);
  }
  const email = read("src/lib/email.ts");
  assert.doesNotMatch(email, /server\.serverIp/, "the email takes the connection, not a bare IP");
  for (const field of ["label", "ipv4", "ipv4Note", "ipv6", "sshCommand", "notice"]) assert.ok(email.includes("${server.connection." + field + "}"), `the email shows connection.${field}`);
});
