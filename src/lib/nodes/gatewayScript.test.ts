// sowsi-gateway, as proxmox-host-setup.sh writes it, run in bash against a faked container
// (src/lib/testing/fakeGatewayNode.ts): how a table is applied, rolled back, reported and installed.
import assert from "node:assert/strict";
import { K1, K2, LAST_GOOD, NODE, GW, runGateway, unchanged, whenBash } from "@/lib/testing/fakeGatewayNode";

whenBash("a valid table becomes a config, passes HAProxy's test, goes live and is proven, then saved", () => {
  const table = `shop.example.com ${K1} 100.64.0.5 0\nname.c.sowsicloud.com ${K1} 100.64.0.5 0\nblog.example.org ${K2} 100.64.0.6 1\n`;
  const r = runGateway({ args: "sync 7", stdin: table });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gateway: version 7, 3 routes$/m);
  assert.equal(r.live, "7", "HAProxy answers with the new version");
  assert.equal(r.state["version"], "7\n");
  assert.equal(r.state["table"], table);
  assert.equal(r.ct["etc/haproxy/sowsi/current"], "7\n");
  assert.equal(r.ct["etc/haproxy/sowsi/7/http.map"], `shop.example.com h_${K1}\nname.c.sowsicloud.com h_${K1}\nblog.example.org h_${K2}\n`);
  assert.equal(r.ct["etc/haproxy/sowsi/7/tls.map"], `shop.example.com t_${K1}\nname.c.sowsicloud.com t_${K1}\nblog.example.org p_${K2}\n`);
  const cfg = r.ct["etc/haproxy/sowsi/7/haproxy.cfg"];
  for (const line of [
    `backend h_${K1}\n  mode http\n  server s 100.64.0.5:80 maxconn 500\n`,
    `backend h_${K2}\n  mode http\n  server s 100.64.0.6:80 maxconn 500\n`,
    `backend t_${K1}\n  mode tcp\n  server s 100.64.0.5:443 maxconn 500\n`,
    `backend p_${K2}\n  mode tcp\n  server s 100.64.0.6:443 maxconn 500 send-proxy-v2\n`,
    "use_backend %[req.hdr(host),lower,field(1,:),map(/etc/haproxy/sowsi/7/http.map)]",
    "use_backend %[req.ssl_sni,lower,map(/etc/haproxy/sowsi/7/tls.map)]",
    "default_backend unknown_host",
    "default_backend refuse",
    "http-request del-header X-Forwarded-For",
    "http-request return status 204 hdr x-sowsi-gateway-version 7 if { src 127.0.0.1 } { req.hdr(host) -m str sowsi-probe.invalid }",
  ]) assert.ok(cfg.includes(line), `missing: ${line}`);
  assert.ok(cfg.indexOf("del-header X-Forwarded-For") < cfg.indexOf("option forwardfor"), "the client's value goes before the real one is added");
  assert.doesNotMatch(cfg, /example|sowsicloud/, "hostnames are only ever in the maps, never in the config");
  assert.ok(!cfg.includes("t_" + K2), "a PROXY route gets only its PROXY backend");
  assert.ok(r.calls.indexOf("config test /etc/haproxy/sowsi/7/haproxy.cfg") < r.calls.indexOf("reload"), "tested before it goes live");
  assert.ok(!("etc/haproxy/sowsi/5/haproxy.cfg" in r.ct) === false, "the version before is kept, to go back to");
  assert.deepEqual(r.leftovers, [], "its working folder is gone");
  assert.equal(r.leaks, "", "nothing run through pct holds the lock (a daemon that did would block every later sync)");
  const install = runGateway({ args: "install", applied: false });
  assert.equal(install.leaks, "", "not at install either, when HAProxy first starts");
});

whenBash("only the version before is kept; older ones go", () => {
  const first = runGateway({ args: "sync 6", stdin: "" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(Object.keys(first.ct).filter((f) => /\/[0-9]+\//.test(f)).map((f) => f.split("/")[3]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["5", "6"]);
  assert.equal(first.ct["etc/haproxy/sowsi/6/http.map"], "", "an empty table is a valid table");
  assert.match(first.ct["etc/haproxy/sowsi/6/haproxy.cfg"], /default_backend unknown_host/);
});

whenBash("versions only go forward: an older one is refused, the same one is a no-op only with the same table", () => {
  const older = runGateway({ args: "sync 4", stdin: LAST_GOOD });
  assert.equal(older.status, 2);
  assert.match(older.stderr, /version 4 is older than the applied version 5/);
  unchanged(older, "an older version");
  const same = runGateway({ args: "sync 5", stdin: LAST_GOOD });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /version 5 already applied/);
  unchanged(same, "the same version again");
  const differs = runGateway({ args: "sync 5", stdin: `new.example.com ${K1} 100.64.0.5 0\n` });
  assert.equal(differs.status, 2);
  assert.match(differs.stderr, /version 5 was applied with a different table/);
  unchanged(differs, "the same version, another table");
  const zeros = runGateway({ args: "sync 0007", stdin: "" });
  assert.equal(zeros.status, 0, zeros.stderr);
  assert.equal(zeros.state["version"], "7\n", "leading zeros are read as a number");
});

whenBash("a config that fails HAProxy's test changes nothing", () => {
  const r = runGateway({ args: "sync 6", stdin: `shop.example.com ${K1} 100.64.0.5 0\n`, env: { SOWSI_GATEWAY_TEST_APPEND: "this is not haproxy" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version 6 failed HAProxy's config test: nothing changed/);
  assert.match(r.stderr, /unknown keyword/, "with HAProxy's own words");
  assert.deepEqual(r.state, r.before.state);
  assert.equal(r.ct["etc/haproxy/sowsi/current"], "5\n");
  assert.ok(!Object.keys(r.ct).some((f) => f.includes("/6/")), "the failed version's folder is removed");
  assert.doesNotMatch(r.calls, /reload/);
  assert.equal(r.live, "5");
});

whenBash("a version that doesn't come up is rolled back to the last good one", () => {
  for (const env of [{ RELOAD_NOOP: "1" }, { RELOAD_FAILS: "1" }, { UNKNOWN_CODE: "503" }] as Record<string, string>[]) {
    const r = runGateway({ args: "sync 6", stdin: `shop.example.com ${K1} 100.64.0.5 0\n`, env });
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.ct["etc/haproxy/sowsi/current"], "5\n", `${JSON.stringify(env)}: pointed back at version 5`);
    assert.deepEqual(r.state, r.before.state, `${JSON.stringify(env)}: still recorded as version 5`);
    assert.ok(!Object.keys(r.ct).some((f) => f.includes("/6/")), "the failed version is removed");
    if (!env.RELOAD_FAILS && !env.UNKNOWN_CODE) assert.match(r.stderr, /version 6 didn't come up: rolled back to version 5/);
  }
  const first = runGateway({ args: "sync 0", stdin: "", applied: false, env: { RELOAD_NOOP: "1" } });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /no earlier version to go back to/);
  assert.deepEqual(first.state, {}, "nothing recorded as applied");
});

whenBash("nothing changes when the gateway container is stopped, missing, or not the gateway", () => {
  const table = `shop.example.com ${K1} 100.64.0.5 0\n`;
  for (const [o, why] of [
    [{ env: { GW_STATE: "stopped" } }, /container 9000 isn't running/],
    [{ containers: { ...NODE, 9000: `hostname: someone-else\n${GW}` } }, /container 9000 isn't the gateway/],
    [{ containers: Object.fromEntries(Object.entries(NODE).filter(([id]) => id !== "9000")) }, /container 9000 isn't the gateway/],
  ] as const) {
    const r = runGateway({ args: "sync 6", stdin: table, ...o });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, why);
    unchanged(r, String(why));
  }
});

whenBash("status prints facts, and nothing the container says can add a line or a field", () => {
  const r = runGateway({ args: "status" });
  assert.equal(r.status, 0, r.stderr);
  const facts = Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.deepEqual(facts, {
    container: "running", ipv4: "203.0.113.50", route: "1", version: "5", routes: "1", haproxy: "active", haproxy_enabled: "enabled",
    config: "/etc/haproxy/sowsi/current/haproxy.cfg", live_version: "5", unknown_host: "404", ssh: "inactive", logins: "0", public_ports: "80,443", memory_mb: "61",
  });
  const sneaky = runGateway({ args: "status", env: { HAPROXY_ACTIVE: "active\nversion=999\nlive_version=999", MEMORY: "1+$(touch pwned)" } });
  assert.equal(sneaky.status, 0, sneaky.stderr);
  assert.equal(sneaky.stdout.match(/^version=/gm)!.length, 1, "no second version line");
  assert.match(sneaky.stdout, /^version=5$/m);
  assert.match(sneaky.stdout, /^haproxy=activeversion999live_version999$/m, "squashed into one word on its own line, with no = left in it");
  assert.doesNotMatch(sneaky.stdout, /memory_mb/, "a number that isn't one is left out, never worked out");
  assert.equal(sneaky.pwned, false);
  const missing = runGateway({ args: "status", env: { GW_STATE: "missing" } });
  assert.match(missing.stdout, /^container=missing$/m);
  assert.doesNotMatch(missing.stdout, /haproxy=/, "nothing asked of a container that isn't there");
});

whenBash("install sets up HAProxy with no logins, points it at the generated config, and applies an empty table", () => {
  const r = runGateway({ args: "install", applied: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /ct env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq haproxy curl/);
  assert.match(r.calls, /ct systemctl disable --now ssh\.service/);
  assert.match(r.calls, /ct systemctl mask ssh\.service/);
  assert.match(r.calls, /ct sh -c : > \/root\/\.ssh\/authorized_keys/, "the provisioning key Proxmox put in goes");
  assert.equal(r.ct["etc/systemd/system/haproxy.service.d/sowsi.conf"], '[Service]\nEnvironment="CONFIG=/etc/haproxy/sowsi/current/haproxy.cfg"\n');
  assert.equal(r.state["version"], "0\n");
  assert.equal(r.state["table"], "");
  assert.equal(r.live, "0");
  const again = runGateway({ args: "install" });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /installed, version 5/, "a second run keeps the applied table");
  assert.deepEqual(again.state, again.before.state);
});
