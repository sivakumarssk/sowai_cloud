// The gateway's checks on the installer's side: the table it sends, what `sowsi-gateway status` must
// say, curl's requests from sowsi-mgmt-01, and what the routing proof accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "./nodeScripts";
import { GATEWAY_HOSTNAME, GATEWAY_VMID, isGatewayContainer } from "./gateway";

test("the gateway is container 9000 named sowsi-gateway: both, never one alone", () => {
  assert.equal(isGatewayContainer({ vmid: GATEWAY_VMID, name: GATEWAY_HOSTNAME }), true);
  assert.equal(isGatewayContainer({ vmid: "9000", name: GATEWAY_HOSTNAME }), true);
  assert.equal(isGatewayContainer({ vmid: 9000, name: "sowsi-cmabc123" }), false, "a customer's container at 9000 isn't the gateway");
  assert.equal(isGatewayContainer({ vmid: 101, name: GATEWAY_HOSTNAME }), false, "nor is one that only borrows the name");
  assert.equal(isGatewayContainer({ vmid: 9000 }), false);
});

test("the installer never sends a table sowsi-gateway would refuse", () => {
  const key = S.testServiceKey(101);
  assert.equal(key, "sowsitest0000101");
  assert.match(key, /^[a-z0-9]{16}$/);
  assert.equal(
    S.gatewayTable([{ host: "one.gateway.test", key, ipv4: "100.127.255.11" }, { host: "x.example.com", key: S.testServiceKey(102), ipv4: "100.64.0.6", proxy: true }]),
    `one.gateway.test ${key} 100.127.255.11 0\nx.example.com sowsitest0000102 100.64.0.6 1\n`
  );
  assert.equal(S.gatewayTable([]), "");
  for (const bad of [
    { host: "A.example.com", key, ipv4: "100.64.0.5" },
    { host: "*.example.com", key, ipv4: "100.64.0.5" },
    { host: "example", key, ipv4: "100.64.0.5" },
    { host: "a.example.com.", key, ipv4: "100.64.0.5" },
    { host: "a.example.com", key: "short", ipv4: "100.64.0.5" },
    { host: "a.example.com", key, ipv4: "203.0.113.7" },
    { host: "a.example.com", key, ipv4: "100.128.0.1" },
    { host: "a.example.com", key, ipv4: "100.64.0.256" },
    { host: "a.example.com", key, ipv4: "100.064.0.5" },
    { host: "a.example.com;reboot", key, ipv4: "100.64.0.5" },
  ]) assert.throws(() => S.gatewayTable([bad]), /gateway route/, JSON.stringify(bad));
  assert.throws(() => S.gatewayTable([{ host: "a.example.com", key, ipv4: "100.64.0.5" }, { host: "a.example.com", key, ipv4: "100.64.0.5" }]), /listed twice/);
});

const working = { container: "running", ipv4: "198.51.100.7", route: "1", version: "0", routes: "0", haproxy: "active", haproxy_enabled: "enabled", config: S.GATEWAY_CONFIG, running_config: S.GATEWAY_CONFIG, live_version: "0", unknown_host: "404", ssh: "inactive", logins: "0", public_ports: "80,443" };

test("a gateway is working only when every fact says so", () => {
  assert.deepEqual(S.checkGatewayStatus(working, { ipv4: "198.51.100.7", version: "0", routes: 0 }), []);
  const cases: [Record<string, string>, RegExp][] = [
    [{ container: "stopped" }, /the gateway container isn't running \(stopped\)/],
    [{ ipv4: "198.51.100.8" }, /address is 198\.51\.100\.8, not 198\.51\.100\.7/],
    [{ route: "0" }, /no route for the gateway's Floating IP/],
    [{ haproxy: "failed" }, /HAProxy isn't running in the gateway \(failed\)/],
    [{ haproxy_enabled: "disabled" }, /wouldn't start after a reboot/],
    [{ config: "/etc/haproxy/haproxy.cfg" }, /HAProxy's unit reads \/etc\/haproxy\/haproxy\.cfg, not \/etc\/haproxy\/sowsi\/current\/haproxy\.cfg/],
    // sowsi-test-05: the unit had our CONFIG, the process still ran the package's.
    [{ running_config: "/etc/haproxy/haproxy.cfg" }, /HAProxy is running \/etc\/haproxy\/haproxy\.cfg, not \/etc\/haproxy\/sowsi\/current\/haproxy\.cfg/],
    [{ running_config: "" }, /HAProxy is running no config it can name/],
    [{ version: "" }, /no route table has been applied/],
    [{ live_version: "4" }, /HAProxy serves table version 4, not the applied 0/],
    [{ unknown_host: "200" }, /an unknown name gets 200, not the neutral 404/],
    [{ ssh: "active" }, /SSH is running in the gateway/],
    [{ logins: "1" }, /holds 1 authorized SSH key/],
    [{ public_ports: "22,80,443" }, /ports open on the gateway: 22,80,443, expected 80,443/],
    [{ routes: "2" }, /has 2 routes, not 0/],
  ];
  for (const [over, why] of cases) assert.match(S.checkGatewayStatus({ ...working, ...over }, { ipv4: "198.51.100.7", routes: 0 }).join("; "), why, JSON.stringify(over));
  assert.match(S.checkGatewayStatus({ ...working, version: "3", live_version: "3" }, { ipv4: "198.51.100.7", version: "4" }).join(), /version 3, not 4/);
  assert.deepEqual(S.checkGatewayStatus({ ...working, logins: "" }, { ipv4: "198.51.100.7" }), [], "no authorized_keys file at all is no logins");
});

test("curl's requests: each name to the gateway's address only, a spoofed client on port 80, no name at all for one TLS check", () => {
  const p = (id: S.GatewayProbeId) => S.gatewayProbe("198.51.100.7", id);
  const base = ["-sS", "-m", "10", "-w", "\\ncode=%{http_code}"];
  assert.deepEqual(p("http_one"), [...base, "--resolve", "one.gateway.test:80:198.51.100.7", "-H", "X-Forwarded-For: 198.51.100.66", "http://one.gateway.test/"]);
  assert.deepEqual(p("https_two"), [...base, "-k", "--resolve", "two.gateway.test:443:198.51.100.7", "https://two.gateway.test/"]);
  assert.deepEqual(p("http_unknown"), [...base, "--resolve", "unknown.gateway.test:80:198.51.100.7", "-H", "X-Forwarded-For: 198.51.100.66", "http://unknown.gateway.test/"]);
  assert.deepEqual(p("https_nosni"), [...base, "-k", "https://198.51.100.7/"]);
  assert.throws(() => S.gatewayProbe("198.51.100.7;reboot", "http_one"), /gateway address/);
});

const reply = (body: string, code = "200", exit = 0): S.CurlResult => ({ exit, stdout: `${body}\ncode=${code}` });
const proven = (): Partial<Record<S.GatewayProbeId, S.CurlResult>> => ({
  http_one: reply("backend-101 xff=2.31.11.105"),
  http_two: reply("backend-102 xff=2.31.11.105"),
  https_one: reply("backend-101 xff=-"),
  https_two: reply("backend-102 xff=-"),
  http_unknown: reply("Not found", "404"),
  https_unknown: reply("", "000", 35),
  https_nosni: reply("", "000", 35),
});

test("the routing proof: each name reaches its own container on both ports, the client's own header is dropped, unknown names get nothing", () => {
  const want = { one: "backend-101", two: "backend-102" };
  assert.deepEqual(S.checkGatewayProof(proven(), want), { problems: [], clientIp: "2.31.11.105" });
  const cases: [Partial<Record<S.GatewayProbeId, S.CurlResult>>, RegExp][] = [
    [{ http_one: reply("backend-102 xff=2.31.11.105") }, /one\.gateway\.test on port 80 reached backend-102, not backend-101/],
    [{ https_two: reply("backend-101 xff=-") }, /two\.gateway\.test on port 443 reached backend-101, not backend-102/],
    [{ http_one: reply("backend-101 xff=198.51.100.66,2.31.11.105") }, /the client's own X-Forwarded-For \(198\.51\.100\.66\) reached the site/],
    [{ http_one: reply("backend-101 xff=-") }, /saw X-Forwarded-For "-", not one client address/],
    [{ https_one: reply("backend-101 xff=2.31.11.105") }, /on port 443 had an X-Forwarded-For/],
    [{ http_two: reply("", "503") }, /two\.gateway\.test on port 80 got 503, not backend-102/],
    [{ https_one: reply("", "000", 35) }, /one\.gateway\.test on port 443 got 000/],
    [{ http_unknown: reply("backend-101 xff=2.31.11.105") }, /an unknown name on port 80 got 200, not the neutral 404; an unknown name on port 80 reached a site/],
    [{ https_unknown: reply("hello") }, /an unknown TLS name on port 443 was answered \(200\), not closed/],
    [{ https_nosni: reply("backend-101 xff=-") }, /TLS with no name on port 443 was answered \(200\), not closed; TLS with no name on port 443 reached a site/],
    [{ http_one: undefined }, /one\.gateway\.test on port 80 got curl exit -1/],
  ];
  for (const [over, why] of cases) assert.match(S.checkGatewayProof({ ...proven(), ...over }, want).problems.join("; "), why, JSON.stringify(over));
});

test("a test container's web server listens on 0.0.0.0 only, gets what it lacks, and is quoted", () => {
  const script = S.gatewayBackendScript("backend-101");
  assert.match(script, /\("0\.0\.0\.0", port\)/, "IPv4 only, as many apps listen");
  assert.match(script, /command -v python3 .*\ncommand -v openssl/);
  assert.match(script, /setsid -f python3 \/root\/sowsi-web\.py 'backend-101' >\/dev\/null 2>&1 <\/dev\/null/, "detached, so the SSH session can end");
  assert.match(script, /echo "listening=/);
  assert.match(script, /"%s xff=%s\\n"/, "python's own newline escape survives into the script");
  assert.throws(() => S.gatewayBackendScript("x'; reboot"), /backend name/);
});

test("host setup fails without the gateway tool or its dispatcher commands", () => {
  assert.match(S.checkHostSetup("== Done", { gateway_tool: "no" }).join(), /sowsi-gateway is missing or isn't valid bash/);
  assert.match(S.checkHostSetup("== Done", { gateway_commands: "1" }).join(), /doesn't have gateway-status and gateway-sync/);
  assert.match(S.outboundScript("2.31.11.105"), /grep -cE '\^ {2}gateway-\(status\|sync\)\\\)' \/usr\/local\/sbin\/sowsi-host/, "counts the two case lines, escaped for grep -E");
});

test("isolation-test.sh checks the gateway on the node (test 28) and again after a reboot", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const script = readFileSync(path.join(process.cwd(), "scripts", "node", "isolation-test.sh"), "utf8").replace(/\r\n/g, "\n");
  for (const line of [
    'gateway_check "28"',
    'gateway_check "18 after the reboot:"',
    "| /usr/local/sbin/sowsi-gateway sync $((v + 1))",
    'SOWSI_GATEWAY_TEST_APPEND="this is not haproxy" /usr/local/sbin/sowsi-gateway sync $((v + 1))',
    "/usr/local/sbin/sowsi-gateway sync $((v - 1))",
    'blocked "28 a container with its own IP can\'t reach a shared container\'s port 80: only the gateway may" to_neighbour_l3 "$A" "$IP4_B" 80',
    'blocked "28 the gateway can\'t reach a shared container\'s SSH" to_neighbour_l3 9000 "$IP4_B" 22',
    'rises "28 a container reaches the gateway on port 80 (a site calling its own domain)" gateway_hairpin reach "$B" "$gw" 80',
    'blocked "28 but not on any other port" to_neighbour_l3 "$B" "$gw" 22',
  ]) assert.ok(script.includes(line), `missing: ${line}`);
  // The gateway checks come before test 17 restarts the neighbour they use.
  assert.ok(script.indexOf('gateway_check "28"') < script.indexOf('echo "== 17 container restart"'));
  for (const fact of ["container", "haproxy", "haproxy_enabled", "live_version", "version", "route", "public_ports", "ssh"]) assert.ok(script.includes(`gateway_fact ${fact}`), fact);
  assert.doesNotMatch(script, /ipify|ifconfig\.me|icanhazip/, "no third-party address services");
});
