// The real guard script, run under bash on a fake /sys, with only the network tools stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardScript, interfacesFile, installGuardScript } from "./nodeScripts";

const MAC = "92:00:0a:57:96:63";
const MGMT = "2.31.11.105";
const HAS_BASH = !spawnSync("bash", ["--version"]).error;

const STUBS = `
timeout() {
  [ "$1" = 30 ] && { shift; "$@"; return; }
  for h in $(cat reachable 2>/dev/null); do [[ "$*" == *"/dev/tcp/$h/"* ]] && return 0; done
  return 1
}
sleep() { :; }
ifreload() { echo "ifreload $*" >> calls; [ -f reload-fixes ] && echo ${MGMT} > reachable; true; }
ip() { echo "ip $*" >> calls; true; }
dhclient() { echo "dhclient $*" >> calls; [ -f dhcp-fixes ] && echo ${MGMT} > reachable; true; }
`;

function host(cfg: { port?: string; reachable?: string[]; card?: string; noCard?: boolean; extra?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-guard-"));
  const put = (file: string, text = "") => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const card = cfg.card ?? "enp1s0";
  put("conf", `MAC=${MAC}\nIPV4=2.28.75.244\nGATEWAY=172.31.1.1\nMGMT_IP=${MGMT}\n`);
  put("interfaces", `${interfacesFile({ nic: cfg.port ?? card, ipv4: "2.28.75.244" })}\nauto vmbr1\niface vmbr1 inet manual\n    bridge-ports none\n    bridge-stp off\n`);
  put("reachable", (cfg.reachable ?? []).join("\n"));
  // The bridge shares the card's MAC but isn't a card: it has no device link.
  put("sys/vmbr0/address", `${MAC}\n`);
  put("sys/lo/address", "00:00:00:00:00:00\n");
  if (!cfg.noCard) {
    put(`sys/${card}/address`, `${MAC}\n`);
    put(`sys/${card}/device/x`);
  }
  return {
    dir,
    put,
    run() {
      const env = { ...process.env, SOWSI_GUARD_CONF: "conf", SOWSI_GUARD_INTERFACES: "interfaces", SOWSI_GUARD_SYS: "sys", SOWSI_GUARD_LOG: "guard.log" };
      return spawnSync("bash", ["-s"], { input: `${STUBS}\n${cfg.extra ?? ""}\n${guardScript()}`, encoding: "utf8", cwd: dir, env });
    },
    read: (file: string) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf8") : ""),
    backups: () => readdirSync(dir).filter((f) => f.startsWith("interfaces.sowsi-guard-")),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function guarded(name: string, fn: () => void) {
  test(name, (t) => {
    if (!HAS_BASH) return t.skip("no bash");
    fn();
  });
}

guarded("a working network: the guard changes nothing at all, not even its log", () => {
  const h = host({ reachable: [MGMT] });
  const before = h.read("interfaces");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(h.read("interfaces"), before);
  assert.equal(h.read("calls"), "");
  assert.equal(h.read("guard.log"), "");
  assert.deepEqual(h.backups(), []);
  h.done();
});

guarded("sowsi-mgmt-01 being down doesn't look like a broken node", () => {
  for (const target of ["185.12.64.1", "1.1.1.1"]) {
    const h = host({ reachable: [target], port: "eth0" });
    const before = h.read("interfaces");
    assert.equal(h.run().status, 0);
    assert.equal(h.read("interfaces"), before, "a wrong-looking config is left alone while the network works");
    assert.equal(h.read("calls"), "");
    h.done();
  }
});

guarded("a DNS failure isn't a network failure: names don't resolve, the address answers, nothing happens", () => {
  const h = host({ reachable: [MGMT], port: "eth0", extra: "getent() { return 2; }\nnslookup() { return 1; }\ndig() { return 1; }" });
  h.put("resolv.conf", "# only comments\n");
  const before = h.read("interfaces");
  assert.equal(h.run().status, 0);
  assert.equal(h.read("interfaces"), before);
  assert.equal(h.read("calls"), "");
  assert.equal(h.read("guard.log"), "");
  h.done();
});

test("the guard only ever tests addresses: there's no name in it to look up", () => {
  const script = guardScript();
  assert.doesNotMatch(script, /getent|nslookup|\bdig\b|\bhost \w|resolv\.conf|\.(com|org|net)\b/);
  const targets = [...script.matchAll(/can_reach ("?[^"\s]+"?) \d+/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['"$MGMT_IP"', "185.12.64.1", "1.1.1.1"]);
  assert.match(installGuardScript({ mac: MAC, ipv4: "2.28.75.244", mgmtIp: MGMT }), /MGMT_IP=2\.31\.11\.105/, "an address, not a name");
});

guarded("a bridge on the wrong card: found by MAC, corrected, reloaded, and the bridge kept", () => {
  const h = host({ port: "eth0" });
  h.put("reload-fixes");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  const f = h.read("interfaces");
  assert.match(f, /iface vmbr0 inet static[\s\S]*bridge-ports enp1s0/);
  assert.match(f, /dns-nameservers 185\.12\.64\.1/, "the correction leaves the rest of the stanza alone");
  assert.match(f, /^iface enp1s0 inet manual$/m);
  assert.doesNotMatch(f, /eth0/);
  assert.match(f, /iface vmbr1 inet manual\n {4}bridge-ports none/, "vmbr1 is untouched");
  assert.equal(h.backups().length, 1);
  assert.match(readFileSync(path.join(h.dir, h.backups()[0]), "utf8"), /bridge-ports eth0/);
  assert.match(h.read("calls"), /ifreload -a/);
  assert.doesNotMatch(h.read("calls"), /dhclient|link del/);
  assert.match(h.read("guard.log"), /pointed at eth0; the card with MAC .* is enp1s0[\s\S]*network is back on vmbr0/);
  h.done();
});

guarded("the same with a card name that doesn't exist (--simulate-bad-nic)", () => {
  const h = host({ port: "sowsibad0", card: "eth0" });
  h.put("reload-fixes");
  assert.equal(h.run().status, 0);
  assert.match(h.read("interfaces"), /bridge-ports eth0/);
  assert.doesNotMatch(h.read("interfaces"), /sowsibad0/);
  h.done();
});

guarded("idempotent: a second run on the corrected file rewrites nothing and adds no backup", () => {
  const h = host({ port: "eth0" });
  h.put("reload-fixes");
  h.run();
  const after = h.read("interfaces");
  h.put("reachable", "");
  h.put("calls", "");
  h.run();
  assert.equal(h.read("interfaces"), after);
  assert.equal(h.backups().length, 1);
  h.done();
});

guarded("still no network: the bridge goes for this boot only, and DHCP takes over; the file keeps the bridge", () => {
  const h = host({ port: "eth0" });
  h.put("dhcp-fixes");
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  const calls = h.read("calls");
  assert.ok(calls.indexOf("ifreload") < calls.indexOf("ip link del vmbr0"));
  assert.ok(calls.indexOf("ip link del vmbr0") < calls.indexOf("dhclient -1 enp1s0"));
  assert.match(h.read("interfaces"), /auto vmbr0/, "the next boot tries the bridge again");
  assert.match(h.read("guard.log"), /falling back to DHCP on enp1s0[\s\S]*back on enp1s0 without the bridge/);
  h.done();
});

guarded("no DHCP client on the node: the address is set by hand instead", () => {
  const h = host({ extra: `command() { return 1; }` });
  h.run();
  assert.match(h.read("calls"), /ip addr add 2\.28\.75\.244\/32 dev enp1s0[\s\S]*ip route add default via 172\.31\.1\.1 dev enp1s0/);
  assert.doesNotMatch(h.read("calls"), /dhclient/);
  assert.match(h.read("guard.log"), /still no network/);
  h.done();
});

guarded("no card with that MAC: it says so and changes nothing, and the bridge's own MAC doesn't fool it", () => {
  const h = host({ noCard: true });
  const before = h.read("interfaces");
  assert.equal(h.run().status, 1);
  assert.equal(h.read("interfaces"), before);
  assert.equal(h.read("calls"), "");
  assert.match(h.read("guard.log"), /no card with MAC/);
  h.done();
});

test("the unit runs at every boot, after network-pre, and doesn't hold the boot up", () => {
  const s = installGuardScript({ mac: MAC, ipv4: "2.28.75.244", mgmtIp: MGMT });
  assert.match(s, /After=network-pre\.target/);
  assert.match(s, /Type=simple/);
  assert.match(s, /WantedBy=multi-user\.target/);
  assert.match(s, /systemctl enable sowsi-net-guard\.service/);
  assert.match(s, new RegExp(`MGMT_IP=${MGMT}`));
  assert.match(s, /cat > \/usr\/local\/sbin\/sowsi-net-guard\n/, "the script arrives on stdin");
  assert.throws(() => installGuardScript({ mac: "nope", ipv4: "1.2.3.4", mgmtIp: MGMT }), /MAC/);
});
