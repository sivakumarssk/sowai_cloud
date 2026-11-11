// sowsi-gateway, run in bash against a faked container whose systemd behaves as on sowsi-test-05
// (src/lib/testing/fakeGatewayNode.ts): HAProxy on our config, status, install, the command line.
import assert from "node:assert/strict";
import { runGateway, whenBash } from "@/lib/testing/fakeGatewayNode";

whenBash("status prints facts, and nothing the container says can add a line or a field", () => {
  const r = runGateway({ args: "status" });
  assert.equal(r.status, 0, r.stderr);
  const facts = Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  assert.deepEqual(facts, {
    container: "running", ipv4: "203.0.113.50", route: "1", version: "5", routes: "1", haproxy: "active", haproxy_enabled: "enabled",
    config: "/etc/haproxy/sowsi/current/haproxy.cfg", running_config: "/etc/haproxy/sowsi/current/haproxy.cfg", live_version: "5", unknown_host: "404", ssh: "inactive", logins: "0", public_ports: "80,443", memory_mb: "61",
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

// ── sowsi-test-05: HAProxy kept running the package's own config ─────

const PACKAGE = "/etc/haproxy/haproxy.cfg";

whenBash("install: HAProxy started by apt on the package's config is restarted onto ours, never just reloaded", () => {
  const r = runGateway({ args: "install", applied: false });
  assert.equal(r.status, 0, r.stderr);
  const calls = r.calls.split("\n");
  const pushed = calls.findIndex((c) => c.includes("haproxy.service.d/sowsi.conf"));
  const daemonReload = calls.findIndex((c, i) => i > pushed && c === "daemon-reload");
  const restart = calls.findIndex((c) => c === "haproxy restart");
  assert.ok(pushed >= 0 && daemonReload > pushed && restart > daemonReload, `the drop-in, then daemon-reload, then a restart:\n${r.calls}`);
  assert.ok(!calls.slice(0, restart).includes("haproxy reload"), "a reload would re-run the package's config: it's never the first step");
  assert.equal(r.live, "0");
  const status = runGateway({ args: "status", applied: false, running: `${PACKAGE}\n` });
  assert.match(status.stdout, new RegExp(`^running_config=${PACKAGE.replaceAll(".", "\\.")}$`, "m"), "status names the config HAProxy really runs");
});

whenBash("a sync while HAProxy runs the package's config restarts it onto ours", () => {
  const r = runGateway({ args: "sync 6", stdin: "", running: `${PACKAGE}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^haproxy restart$/m);
  assert.doesNotMatch(r.calls, /^haproxy reload$/m);
  assert.equal(r.live, "6");
  const onOurs = runGateway({ args: "sync 6", stdin: "" });
  assert.match(onOurs.calls, /^haproxy reload$/m, "on our config, a graceful reload");
  assert.doesNotMatch(onOurs.calls, /^haproxy restart$/m, "and no restart, which would drop connections");
});

whenBash("a HAProxy that answers but runs another config isn't taken as serving", () => {
  // The unit never picks the drop-in up: a restart keeps the package's config.
  const stuck = runGateway({ args: "install", applied: false, env: { DROPIN_IGNORED: "1", OTHER_CONFIG_ANSWERS: "1" } });
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, new RegExp(`version 0 didn't come up \\(HAProxy runs ${PACKAGE.replaceAll(".", "\\.")}, live version 0\\)`), "says which config it found running");
  assert.deepEqual(stuck.state, {}, "nothing recorded as applied");
});

whenBash("a command line it refuses is shown back quoted, so a stray carriage return is plain to see", () => {
  const r = runGateway({ args: "", bashArgs: "$'status\\r'" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: sowsi-gateway status \| sync <version> \| install \(got: \$'status\\r'\)/);
});

whenBash("a restart reads the drop-in first: systemd may not have loaded it yet (an install that stopped halfway)", () => {
  const r = runGateway({ args: "sync 6", stdin: "", running: `${PACKAGE}\n`, unit: `${PACKAGE}\n`, dropin: true });
  assert.equal(r.status, 0, r.stderr);
  const calls = r.calls.split("\n");
  assert.ok(calls.indexOf("daemon-reload") >= 0 && calls.indexOf("daemon-reload") < calls.indexOf("haproxy restart"), `daemon-reload, then the restart:\n${r.calls}`);
  assert.equal(r.live, "6");
});
