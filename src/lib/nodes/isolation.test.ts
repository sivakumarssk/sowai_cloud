import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as S from "./nodeScripts";

const setupScript = () => readFileSync(path.join(process.cwd(), "scripts", "proxmox-host-setup.sh"), "utf8").replace(/\r\n/g, "\n");
const routesScript = () => /cat > \/usr\/local\/sbin\/sowsi-routes <<'SCRIPT'\n([\s\S]*?)\nSCRIPT\n/.exec(setupScript())![1];
const whenBash = (name: string, fn: () => void) => test(name, (t) => (spawnSync("bash", ["--version"]).error ? t.skip("no bash") : fn()));

const FLOATING = "net0: name=eth0,bridge=vmbr1,gw=172.31.1.1,gw6=fe80::1,hwaddr=BC:24:11:AA:BB:01,ip=203.0.113.7/32,ip6=2a01:4f8:1c16:5f1d::100/64,type=veth";
const IPV6_ONLY = "net0: name=eth0,bridge=vmbr1,gw6=fe80::1,hwaddr=BC:24:11:AA:BB:02,ip6=2a01:4f8:1c16:5f1d::101/64,type=veth";

type Node = {
  containers?: Record<string, string>;
  mgmt?: string | null;
  mounted?: boolean;
  /** The kernel refuses the rule file. */
  nftFails?: boolean;
  /** Only the inet table is there. */
  noBridgeTable?: boolean;
  /** The tables are loaded already. */
  tablesPresent?: boolean;
  lastGood?: string;
  defaultDev?: string;
  append?: string;
  args?: string;
  /** bridge, journalctl and ip fail, as on a node half set up. */
  reportFakesFail?: boolean;
};

/** The real script, with the commands it can't run here replaced by ones that write down what they were asked. */
function runRoutes(node: Node = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-routes-"));
  mkdirSync(path.join(dir, "lxc"));
  mkdirSync(path.join(dir, "state"));
  for (const [name, text] of Object.entries(node.containers ?? {})) writeFileSync(path.join(dir, "lxc", `${name}.conf`), `arch: amd64\n${text}\n`);
  if (node.mgmt !== null) writeFileSync(path.join(dir, "state", "mgmt-ip"), `${node.mgmt ?? "2.31.11.105"}\n`);
  if (node.lastGood) writeFileSync(path.join(dir, "state", "rules.last-good.nft"), node.lastGood);
  if (node.tablesPresent) writeFileSync(path.join(dir, "tables"), "yes");
  const fakes = `
export SOWSI_LXC_DIR=lxc SOWSI_PVE_DIR=pve SOWSI_STATE_DIR=state SOWSI_RUN_DIR=run
${node.append ? `export SOWSI_NFT_TEST_APPEND='${node.append}'` : ""}
log() { echo "$*" >> calls; }
flock() { :; }
mountpoint() { ${node.mounted === false ? "return 1" : "return 0"}; }
sysctl() { log "sysctl $*"; }
ip() {
  log "ip $*"
  case "$*" in
    "-4 route show default") echo "default via 172.31.1.1 dev ${node.defaultDev ?? "vmbr0"} onlink" ;;
    "-4 route show proto 250") echo "198.51.100.9/32 dev vmbr1 scope link" ;;
    "-br link") echo "veth100i0 UP" ;;
  esac
  ${node.reportFakesFail ? "return 1" : ""}
}
bridge() { log "bridge $*"; ${node.reportFakesFail ? "return 1" : "echo '7: veth100i0@if2: <BROADCAST,UP> master vmbr1 state forwarding'"}; }
journalctl() { log "journalctl $*"; ${node.reportFakesFail ? "return 1" : "echo 'sowsi-routes: isolation: 2 containers'"}; }
nft() {
  log "nft $*"
  case "$*" in
    "list table "*) [ -f tables ] ;;
    "-t list table "*) if [ -f tables ]; then echo "table $4 $5 { }"; else echo "Error: No such file or directory" >&2; return 1; fi ;;
    "list tables") if [ -f tables ]; then printf 'table bridge sowsi\\ntable inet sowsi\\ntable inet other\\n'; fi ;;
    "list counters table bridge sowsi") ${node.noBridgeTable ? "return 1" : "printf 'table bridge sowsi {\\n\\tcounter spoof_mac {\\n\\t\\tpackets 3 bytes 180\\n\\t}\\n}\\n'"} ;;
    "list counters table inet sowsi") printf 'table inet sowsi {\\n\\tcounter to_mail {\\n\\t\\tpackets 7 bytes 420\\n\\t}\\n}\\n' ;;
    "-c -f "*) ${node.nftFails ? "return 1" : "return 0"} ;;
    "-f "*) ${node.nftFails ? `case "$2" in *last-good*) cp "$2" loaded; : > tables ;; *) return 1 ;; esac` : `cp "$2" loaded; : > tables`} ;;
  esac
}
`;
  const script = routesScript().replace("set -euo pipefail\n", `set -euo pipefail\n${fakes}\n`);
  const r = spawnSync("bash", ["-s", "--", ...(node.args ? node.args.split(" ") : [])], { input: script, encoding: "utf8", cwd: dir });
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : "");
  const result = { ...r, calls: read("calls"), rules: read("run/rules.nft"), loaded: read("loaded"), good: read("state/rules.last-good.nft") };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

const chain = (rules: string, id: string) => new RegExp(`  chain ct${id} \\{\\n([\\s\\S]*?)\\n  \\}`).exec(rules)?.[1] ?? "";
const before = (rules: string, a: string, b: string) => {
  assert.ok(rules.includes(a), `missing: ${a}`);
  assert.ok(rules.includes(b), `missing: ${b}`);
  assert.ok(rules.indexOf(a) < rules.indexOf(b), `${a} must come before ${b}`);
};

whenBash("a container with a Floating IP may send only from its own MAC and addresses", () => {
  const r = runRoutes({ containers: { 100: FLOATING, 101: IPV6_ONLY } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(S.parseRoutes(r.stdout), { ipv4: 1, ipv6: 2 });
  assert.match(r.stdout, /isolation: 2 containers$/m);
  const c = chain(r.rules, "100");
  for (const line of [
    "ether saddr != bc:24:11:aa:bb:01 counter name spoof_mac drop",
    "ether type != { arp, ip, ip6 } counter name bad_frame drop",
    "ether type arp arp saddr ether != bc:24:11:aa:bb:01 counter name spoof_arp drop",
    "ether type arp arp saddr ip != { 203.0.113.7, 0.0.0.0 } counter name spoof_arp drop",
    "ether type ip ip saddr != 203.0.113.7 counter name spoof_ip4 drop",
    "ether type ip6 ip6 saddr != { 2a01:4f8:1c16:5f1d::100, fe80::/10, :: } counter name spoof_ip6 drop",
    "ether type ip6 ip6 saddr fe80::1 counter name spoof_ip6 drop",
    "ether type ip6 ip6 saddr :: meta l4proto != ipv6-icmp counter name spoof_ip6 drop",
    "icmpv6 type { nd-router-advert, nd-redirect } counter name spoof_nd drop",
    "icmpv6 type nd-neighbor-advert @th,64,128 != 0x2a0104f81c165f1d0000000000000100 @th,64,10 != 0x3fa counter name spoof_nd drop",
    "icmpv6 type nd-neighbor-advert @th,64,128 0xfe800000000000000000000000000001 counter name spoof_nd drop",
    "udp sport 67 counter name spoof_nd drop",
    "udp sport 547 counter name spoof_nd drop",
  ]) assert.ok(c.includes(line), `missing: ${line}`);
  assert.equal(c.trimEnd().split("\n").at(-1)!.trim(), "accept", "the only accept is the last line");
  assert.equal(c.match(/\baccept\b/g)!.length, 1, "nothing is accepted ahead of the checks");
});

whenBash("an IPv6-only container can send no IPv4 or ARP at all", () => {
  const c = chain(runRoutes({ containers: { 101: IPV6_ONLY } }).rules, "101");
  assert.ok(c.includes("ether type != ip6 counter name bad_frame drop"));
  assert.doesNotMatch(c, /arp saddr|ip saddr/);
  assert.ok(c.includes("0x2a0104f81c165f1d0000000000000101"));
});

whenBash("every port is keyed by name, an unknown port is dropped, and the check runs before anything else", () => {
  const { rules } = runRoutes({ containers: { 100: FLOATING, 101: IPV6_ONLY } });
  assert.ok(rules.includes('iifname vmap { "veth100i0" : jump ct100, "veth101i0" : jump ct101 }'));
  before(rules, 'ibrname != "vmbr1" accept', "iifname vmap");
  before(rules, "iifname vmap", 'iifname "veth*" counter name unknown_port drop');
  assert.ok(rules.includes('iifname "fwpr*" counter name unknown_port drop'), "a firewall bridge's port is refused too");
  assert.ok(rules.includes('ibrname "vmbr1" counter name to_neighbour_l2 drop'));
  assert.ok(rules.includes("type filter hook prerouting priority -200"));
  assert.ok(rules.includes("type filter hook forward priority -200"));
});

whenBash("with no containers the rules still load, and any new port is cut off", () => {
  const r = runRoutes();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.rules, /vmap/, "nft refuses an empty map");
  assert.ok(r.rules.includes('iifname "veth*" counter name unknown_port drop'));
  assert.match(r.stdout, /routes: 0 IPv4, 0 IPv6\nisolation: 0 containers$/m);
});

whenBash("forwarded traffic may leave by the uplink only, and the private ranges and mail are dropped", () => {
  const { rules } = runRoutes({ containers: { 100: FLOATING } });
  for (const line of [
    'iifname "vmbr1" oifname "vmbr1" counter name to_neighbour_l3 drop',
    'iifname "vmbr1" oifname != { "vmbr0" } counter name to_other_iface drop',
    'iifname "vmbr1" tcp dport { 25, 465 } counter name to_mail drop',
    'iifname "vmbr1" ip daddr 169.254.0.0/16 counter name to_metadata drop',
    'iifname "vmbr1" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } counter name to_private drop',
    'iifname "vmbr1" ip6 daddr fc00::/7 counter name to_private drop',
  ]) assert.ok(rules.includes(line), `missing: ${line}`);
  before(rules, "name to_other_iface drop", 'ip daddr 172.31.1.1 accept');
  before(rules, "name to_mail drop", 'ip daddr 172.31.1.1 accept');
  before(rules, 'ip daddr 172.31.1.1 accept', "name to_private drop");
});

whenBash("the uplink follows the default route if the boot guard has dropped the bridge, and never includes vmbr1 or a bad name", () => {
  assert.ok(runRoutes({ defaultDev: "eth0" }).rules.includes('oifname != { "eth0", "vmbr0" }'));
  assert.ok(runRoutes({ defaultDev: "vmbr1" }).rules.includes('oifname != { "vmbr0" }'));
  assert.ok(runRoutes({ defaultDev: "bad;name" }).rules.includes('oifname != { "vmbr0" }'));
});

whenBash("nothing from the host is reachable, apart from what IPv6 needs to work", () => {
  const { rules } = runRoutes();
  before(rules, 'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert', "counter name to_host drop");
  before(rules, 'iifname "vmbr1" jump from_container', "tcp dport 8006");
  assert.ok(rules.includes("type filter hook input priority -10"));
});

whenBash("8006 and the SSH limit name sowsi-mgmt-01, and are left out rather than guessed", () => {
  const { rules } = runRoutes();
  assert.ok(rules.includes('iifname != "lo" ip saddr != 2.31.11.105 tcp dport 8006 counter name api_refused drop'));
  assert.ok(rules.includes('iifname != "lo" meta nfproto ipv6 tcp dport 8006 counter name api_refused drop'));
  before(rules, "ip saddr 2.31.11.105 tcp dport 22 accept", "add @ssh4");
  assert.ok(rules.includes("add @ssh6 { ip6 saddr & ffff:ffff:ffff:ffff:: limit rate over 10/minute"));
  for (const mgmt of [null, "", "not-an-ip", "2.31.11.105; drop", "999.1.1.1"]) {
    const r = runRoutes({ mgmt });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.rules, /8006|add @ssh/, String(mgmt));
    assert.match(r.stderr, /no valid management IP/);
  }
});

whenBash("a net0 line that fails a check gets no rules, and says so; the others are unaffected", () => {
  const good = FLOATING;
  const bad: Record<string, string> = {
    "bad mac": good.replace("BC:24:11:AA:BB:01", "BC:24:11:AA:BB"),
    "mac injection": good.replace("BC:24:11:AA:BB:01", "BC:24:11:AA:BB:01;drop"),
    "ip injection": good.replace("203.0.113.7/32", "203.0.113.7/32;drop"),
    "ip out of range": good.replace("203.0.113.7/32", "203.0.113.999/32"),
    "not a /32": good.replace("203.0.113.7/32", "203.0.113.7/24"),
    "no prefix": good.replace("203.0.113.7/32", "203.0.113.7"),
    dhcp: good.replace("ip=203.0.113.7/32", "ip=dhcp"),
    "ip6 auto": good.replace("ip6=2a01:4f8:1c16:5f1d::100/64", "ip6=auto"),
    "two gaps": good.replace("2a01:4f8:1c16:5f1d::100", "2a01::1::2"),
    "too many groups": good.replace("2a01:4f8:1c16:5f1d::100", "1:2:3:4:5:6:7:8:9"),
    "long group": good.replace("2a01:4f8:1c16:5f1d::100", "2a01a::1"),
    brace: good.replace("hwaddr=", "x=} drop,hwaddr="),
    quote: good.replace("hwaddr=", 'x="a,hwaddr='),
    "space and rule": good.replace("hwaddr=", "x=a drop,hwaddr="),
    "no addresses": good.replace(",ip=203.0.113.7/32,ip6=2a01:4f8:1c16:5f1d::100/64", ""),
    "firewall bridge": `${good},firewall=1`,
  };
  for (const [why, line] of Object.entries(bad)) {
    const r = runRoutes({ containers: { 100: line, 101: IPV6_ONLY } });
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
    assert.equal(chain(r.rules, "100"), "", why);
    assert.ok(!r.rules.includes("veth100i0"), why);
    assert.ok(!/;drop|} drop,|"a/.test(r.rules), `${why} reached the rules`);
    assert.match(r.stdout, /isolation: 1 containers, refused: 100$/m, why);
    assert.ok(chain(r.rules, "101"), `${why} cost the other container its rules`);
  }
});

whenBash("a file name that isn't a VM id gets no rules", () => {
  for (const name of ["100;drop", "x..y", "abc", "100 drop"]) {
    const r = runRoutes({ containers: { [name]: FLOATING } });
    assert.ok(!r.rules.includes("chain ct100;"), name);
    assert.match(r.stdout, /refused:/, name);
    assert.ok(!r.rules.includes(`veth${name}`), name);
  }
});

whenBash("only the live net0 line on vmbr1 counts: not a snapshot's, and not another bridge", () => {
  const snapshot = `${FLOATING}\n[before]\nnet0: name=eth0,bridge=vmbr1,hwaddr=BC:24:11:FF:FF:FF,ip=198.51.100.200/32,type=veth`;
  const r = runRoutes({ containers: { 100: snapshot, 102: FLOATING.replace("bridge=vmbr1", "bridge=vmbr0") } });
  assert.ok(chain(r.rules, "100").includes("bc:24:11:aa:bb:01"));
  assert.ok(!r.rules.includes("bc:24:11:ff:ff:ff"));
  assert.equal(chain(r.rules, "102"), "");
});

whenBash("addresses are written out in full for the advertisement check", () => {
  const cases: [string, string][] = [
    ["2a01:4f8:1c16:5f1d::100", "2a0104f81c165f1d0000000000000100"],
    ["2A01:4F8:0:1::ABCD", "2a0104f800000001000000000000abcd"],
    ["1:2:3:4:5:6:7:8", "00010002000300040005000600070008"],
    ["::1", "00000000000000000000000000000001"],
    ["fd00::", "fd000000000000000000000000000000"],
  ];
  for (const [addr, hex] of cases) {
    const c = chain(runRoutes({ containers: { 100: FLOATING.replace("2a01:4f8:1c16:5f1d::100", addr) } }).rules, "100");
    assert.ok(c.includes(`0x${hex} @th,64,10`), `${addr}: ${c}`);
  }
});

whenBash("the file replaces both tables in one transaction, and never flushes anything else", () => {
  const r = runRoutes({ containers: { 100: FLOATING } });
  assert.ok(r.rules.startsWith("# Generated by sowsi-routes. Replaces both tables in one transaction.\ntable bridge sowsi\ndelete table bridge sowsi\ntable inet sowsi\ndelete table inet sowsi\n"));
  assert.doesNotMatch(routesScript(), /flush ruleset|nft flush/);
  before(r.calls, "nft -c -f", "nft -f run/rules.nft");
  assert.equal(r.loaded, r.rules);
  assert.equal(r.good, r.rules, "kept as the last good rules");
});

whenBash("routes are synced before the rules, so a rule problem can't cost a container its route", () => {
  const { calls } = runRoutes({ containers: { 100: FLOATING } });
  before(calls, "ip route replace 203.0.113.7/32 dev vmbr1 proto 250", "nft -c -f");
  before(calls, "ip route del 198.51.100.9/32 proto 250", "nft -c -f");
});

whenBash("a file that won't load keeps the running rules and the last good file, and the run fails", () => {
  const r = runRoutes({ containers: { 100: FLOATING }, nftFails: true, tablesPresent: true, lastGood: "old rules\n" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /routes: 1 IPv4, 1 IPv6/, "routes were still synced");
  assert.match(r.stdout, /RULES NOT LOADED/);
  assert.equal(r.good, "old rules\n");
  assert.ok(!/nft -f state/.test(r.calls), "what's running stays");
});

whenBash("if nothing is running, as at boot, a file that won't load falls back to the last good rules", () => {
  const r = runRoutes({ containers: { 100: FLOATING }, nftFails: true, lastGood: "old rules\n" });
  assert.equal(r.status, 1);
  assert.equal(r.loaded, "old rules\n");
  assert.match(runRoutes({ nftFails: true }).stderr, /no rules loaded and none saved/);
});

whenBash("a broken line in the generated file is caught by the same path", () => {
  const r = runRoutes({ append: "BROKEN", nftFails: true, lastGood: "old rules\n", tablesPresent: true });
  assert.ok(r.rules.endsWith("BROKEN\n"));
  assert.equal(r.status, 1);
  assert.equal(r.good, "old rules\n");
});

whenBash("unchanged rules aren't reloaded, so the counters survive the timer", () => {
  const first = runRoutes({ containers: { 100: FLOATING } });
  const again = runRoutes({ containers: { 100: FLOATING }, tablesPresent: true, lastGood: first.rules });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!/nft -f /.test(again.calls), again.calls);
  const removed = runRoutes({ containers: { 100: FLOATING }, lastGood: first.rules });
  assert.match(removed.calls, /nft -f run\/rules\.nft/, "rules someone removed come back");
});

whenBash("without the cluster filesystem nothing is deleted, and the last good rules are loaded", () => {
  const r = runRoutes({ mounted: false, lastGood: "old rules\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.loaded, "old rules\n");
  assert.ok(!/route (del|replace)/.test(r.calls), r.calls);
  assert.match(r.stdout, /skipped/);
  assert.ok(!r.rules, "no rules generated from an empty list");
  assert.ok(!/nft -f/.test(runRoutes({ mounted: false, tablesPresent: true, lastGood: "x" }).calls), "what's running stays");
});

whenBash("vmbr1 doesn't send redirects or take router advertisements", () => {
  assert.match(runRoutes().calls, /sysctl -qw net\.ipv4\.conf\.vmbr1\.send_redirects=0 net\.ipv6\.conf\.vmbr1\.accept_ra=0 net\.ipv6\.conf\.vmbr1\.accept_redirects=0/);
});

whenBash("--status prints counters and nothing else; --probe manages one fixed interface; anything else is refused", () => {
  const r = runRoutes({ args: "--status", tablesPresent: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["tables=2", "spoof_mac=3", "to_mail=7"]);
  assert.deepEqual(S.parseIsolationStatus(r.stdout), { tables: 2, spoof_mac: 3, to_mail: 7 });
  assert.match(runRoutes({ args: "--status", tablesPresent: true, noBridgeTable: true }).stdout, /to_mail=7/, "a missing table can't hide the other's counters");

  const on = runRoutes({ args: "--probe on" });
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.calls, /ip -4 route replace 198\.19\.255\.0\/24 dev sowsiprobe0/);
  assert.match(on.calls, /ip -6 route replace 2001:db8:5053::\/64 dev sowsiprobe0/);
  assert.ok(on.calls.includes(S.PROBE_TARGET.ipv4.replace(/\.2$/, ".0")), "the same network the proof aims at");
  assert.match(runRoutes({ args: "--probe off" }).calls, /ip link del sowsiprobe0/);
  for (const args of ["--probe", "--probe maybe", "--flush", "extra"]) assert.equal(runRoutes({ args }).status, 2, args);
});

whenBash("--report shows rules, counters, ports, net0 lines and the journal, and changes nothing", () => {
  const r = runRoutes({ args: "--report", tablesPresent: true, containers: { 100: `${FLOATING}\ndescription: customer-note-s3cret\nlxc.environment: TOKEN=s3cret`, 101: IPV6_ONLY } });
  assert.equal(r.status, 0, r.stderr);
  for (const heading of ["counters", "bridge table", "inet table", "bridge ports", "links", "addresses", "container routes", "net0 lines", "last good rules", "journal"]) {
    assert.match(r.stdout, new RegExp(`^=== ${heading}$`, "m"), heading);
  }
  assert.match(r.stdout, /^spoof_mac=3$/m);
  assert.match(r.stdout, /^100\.conf: net0: name=eth0,bridge=vmbr1/m);
  assert.match(r.stdout, /^101\.conf: net0: /m);
  assert.doesNotMatch(r.stdout, /s3cret/, "only the net0 line of each container");
  assert.match(r.calls, /^nft -t list table bridge sowsi$/m, "-t: no set elements, so no SSH clients' addresses");
  assert.match(r.calls, /^nft -t list table inet sowsi$/m);
  assert.doesNotMatch(r.calls, /^nft (-c )?-f|^nft (add|delete|flush)|^ip (link|addr|-[46] route) (add|del|replace|set)|^sysctl|^ip route (add|del|replace)/m, "changes nothing");
  assert.equal(r.rules, "", "writes no rule file");
  assert.equal(r.good, "", "and no last-good file");
  assert.match(r.calls, /^journalctl -u sowsi-routes\.service -u sowsi-routes-sync\.service -n 60 --no-pager$/m);
  const broken = runRoutes({ args: "--report", tablesPresent: false, reportFakesFail: true });
  assert.equal(broken.status, 0, "a missing table or failing command doesn't stop the report");
  assert.match(broken.stdout, /=== journal/);
});

whenBash("the setup script keeps ISOLATION_ONLY to the isolation pieces, and arms the rollback before anything changes", () => {
  const home = mkdtempSync(path.join(tmpdir(), "sowsi-setup-"));
  try {
    for (const dir of ["sbin", "systemd", "etc"]) mkdirSync(path.join(home, dir));
    for (const f of ["sbin/sowsi-routes", "sbin/sowsi-host", "systemd/sowsi-routes.service"]) writeFileSync(path.join(home, f), "old\n");
    const fakes = `
log() { echo "$*" >> calls; }
nft() { log "nft $*"; }
ufw() { :; }
sysctl() { echo 1; }
systemctl() { log "systemctl $*"; if [ "$1" = is-enabled ]; then echo "\${NFT_SERVICE:-disabled}"; fi; }
systemd-run() { log "systemd-run $*"; }
pveam() { log "pveam $*"; }
ifup() { log "ifup $*"; }
pvesh() { log "pvesh $*"; }
ip() { :; }
`;
    const body = setupScript()
      .replaceAll("/usr/local/sbin", "sbin")
      .replaceAll("/etc/systemd/system", "systemd")
      .replaceAll("/etc/sowsi", "etc/sowsi")
      .replaceAll("/root/", "./");
    // The last line runs the real thing, which has its own tests.
    const last = body.lastIndexOf("sbin/sowsi-routes");
    const script = `${body.slice(0, last)}log sowsi-routes ran${body.slice(last + "sbin/sowsi-routes".length)}`;
    const run = (env: Record<string, string>) => spawnSync("bash", ["-s"], { input: script.replace("set -euo pipefail\n", `set -euo pipefail\n${fakes}\n`), encoding: "utf8", cwd: home, env: { ...process.env, ...env } });

    assert.notEqual(run({ ISOLATION_ONLY: "1" }).status, 0, "MGMT_IP is required");
    assert.notEqual(run({ ISOLATION_ONLY: "1", MGMT_IP: "not-an-ip" }).status, 0);
    const refused = run({ ISOLATION_ONLY: "1", MGMT_IP: "2.31.11.105", NFT_SERVICE: "enabled" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /nothing changed/);
    assert.equal(readFileSync(path.join(home, "sbin/sowsi-routes"), "utf8"), "old\n", "nothing changed");

    writeFileSync(path.join(home, "sbin/sowsi-routes"), "old\n");
    const r = run({ ISOLATION_ONLY: "1", MGMT_IP: "2.31.11.105" });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(path.join(home, "calls"), "utf8");
    assert.ok(!/pveam|ifup|pvesh/.test(calls), `only the isolation pieces: ${calls}`);
    assert.match(r.stdout, /rollback armed for 10 minutes/);
    assert.match(calls, /systemd-run --on-active=10m --unit=sowsi-isolation-undo/);
    const rollback = readFileSync(path.join(home, "sowsi-isolation-rollback.sh"), "utf8");
    before(rollback, "disable --now sowsi-routes.timer", "nft delete table bridge sowsi");
    for (const line of ["nft delete table inet sowsi", "sowsi-routes.timer", "systemctl unmask nftables.service", "send_redirects=1"]) assert.ok(rollback.includes(line), line);
    assert.equal(readFileSync(path.join(home, "etc/sowsi/mgmt-ip"), "utf8"), "2.31.11.105\n");
    const backups = spawnSync("bash", ["-c", "ls -d sowsi-isolation-backup-*"], { encoding: "utf8", cwd: home }).stdout.trim();
    assert.equal(readFileSync(path.join(home, backups, "sowsi-routes"), "utf8"), "old\n", "the old script is kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the setup script runs the rules before guests start, and from a timer that can really repeat", () => {
  const s = setupScript();
  const unit = /cat > \/etc\/systemd\/system\/sowsi-routes\.service <<'EOF'\n([\s\S]*?)\nEOF/.exec(s)![1];
  assert.match(unit, /^Before=pve-guests\.service$/m);
  assert.match(unit, /^RemainAfterExit=yes$/m);
  const timer = /cat > \/etc\/systemd\/system\/sowsi-routes\.timer <<'EOF'\n([\s\S]*?)\nEOF/.exec(s)![1];
  assert.match(timer, /^Unit=sowsi-routes-sync\.service$/m, "a oneshot that stays active can't be re-run by its own timer");
  const sync = /cat > \/etc\/systemd\/system\/sowsi-routes-sync\.service <<'EOF'\n([\s\S]*?)\nEOF/.exec(s)![1];
  assert.doesNotMatch(sync, /RemainAfterExit/);
  assert.match(s, /systemctl mask nftables\.service/);
});

test("the compare scripts only read", () => {
  for (const name of ["isolation-compare.sh", "baseline-compare.sh"]) {
    const text = readFileSync(path.join(process.cwd(), "scripts", "node", name), "utf8");
    const lines = text.split("\n").filter((l) => !l.startsWith("#"));
    const writes = /\b(rm|mv|cp|mkdir|touch|tee|dd|chmod|chown|ln|truncate|install|mktemp|reboot|kill|curl|wget|eval|exec|source|apt|apt-get)\b|sed[^|]* -i|sysctl -q?w|systemctl (start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)|nft (add|delete|flush|create|insert|replace|-f)|ufw (allow|deny|reject|delete|reset|enable|disable|default|logging|route)|ip (link set|addr add|addr del|route (add|del|replace))|pct (set|start|stop|exec|push)|fail2ban-client (start|stop|reload|set|restart)/;
    for (const line of lines) {
      assert.ok(!writes.test(line), `${name}: ${line}`);
      assert.ok(!/>\s*[^&\s]/.test(line.replace(/2?>\/dev\/null|2>&1/g, "")), `${name} writes a file: ${line}`);
    }
  }
});

whenBash("the isolation test script is valid bash and refuses any node that isn't a throwaway", () => {
  const script = readFileSync(path.join(process.cwd(), "scripts", "node", "isolation-test.sh"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  for (const name of ["sowsi-proxmox-01", "sowsi-proxmox-02"]) {
    for (const phase of ["main", "cleanup", "rollback-prep", "bad-boot-prep", ""]) {
      const r = spawnSync("bash", ["-s", "--", phase], { input: script.replace("set -u\n", `set -u\nhostname() { echo ${name}; }\npct() { echo RAN > ran; }\n`), encoding: "utf8" });
      assert.equal(r.status, 2, `${name} ${phase}`);
      assert.match(r.stderr, /not a throwaway node/);
    }
  }
});

/**
 * isolation-test.sh's restart_spoof_check, run against a fake container. The fake behaves like the real
 * kernel: until the gateway's MAC is known, a spoofed packet goes out as an ARP request, and spoof_arp stops it.
 */
function runRestartCheck(o: { neverLearned?: boolean; ip4Lost?: boolean; arpLost?: boolean; addExit?: number; noAddr?: boolean } = {}) {
  const script = readFileSync(path.join(process.cwd(), "scripts", "node", "isolation-test.sh"), "utf8").replace(/\r\n/g, "\n");
  const fn = /\nrestart_spoof_check\(\) \{[\s\S]*?\n\}\n/.exec(script)![0].replaceAll("/usr/local/sbin/sowsi-routes --status", "fake_status");
  const fakes = `
mkdir -p st; echo 5 > st/spoof_ip4; echo 5 > st/spoof_arp; echo no > st/learned
pass=0 failed=0
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
bad() { failed=$((failed + 1)); echo "  FAIL $1"; }
bump() { echo $(( $(cat st/$1) + 1 )) > st/$1; }
fake_status() { echo tables=2; echo spoof_ip4=$(cat st/spoof_ip4); echo spoof_arp=$(cat st/spoof_arp); echo spoof_mac=0; }
count() { fake_status | awk -F= -v n="$1" '$1 == n { print $2 }'; }
sleep() { :; }
ip() {
  case "$*" in
    "-4 -o addr show dev eth0") ${o.noAddr ? ":" : `echo "2: eth0    inet 198.18.254.11/32 scope global eth0"`} ;;
    "-4 route show default"|"-4 route") echo "default via 172.31.1.1 dev eth0 onlink" ;;
    "neigh show 172.31.1.1 dev eth0") if [ "$(cat st/learned)" = yes ]; then echo "172.31.1.1 lladdr fe:ff:ff:ff:ff:ff REACHABLE"; fi ;;
    "neigh show dev eth0") echo "172.31.1.1 learned=$(cat st/learned)" ;;
    "-br addr") echo "eth0 UP 198.18.254.11/32" ;;
    "neigh flush dev eth0") echo no > st/learned ;;
    "addr add "*) return ${o.addExit ?? 0} ;;
  esac
}
ping() {
  case "$*" in
    *"-I 198.18.254.11 172.31.1.1"*) ${o.neverLearned ? ":" : "echo yes > st/learned"} ;;
    *"-I 198.18.254.99 1.1.1.1"*) if [ "$(cat st/learned)" = yes ]; then ${o.ip4Lost ? ":" : "bump spoof_ip4"}; else ${o.arpLost ? ":" : "bump spoof_arp"}; fi ;;
    *"-I 198.18.254.99 172.31.1.1"*) if [ "$(cat st/learned)" != yes ]; then ${o.arpLost ? ":" : "bump spoof_arp"}; fi ;;
  esac
  return 1
}
in_ct() { shift; ( eval "$*" ); }
`;
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-restart-"));
  const r = spawnSync("bash", ["-s"], { input: `${fakes}${fn}\nrestart_spoof_check "17 after a restart" 901 198.18.254.11\necho "failed=$failed"\n`, encoding: "utf8", cwd: dir });
  rmSync(dir, { recursive: true, force: true });
  return { ...r, failed: Number(/^failed=(\d+)$/m.exec(r.stdout)?.[1] ?? -1) };
}

whenBash("isolation-test.sh tests 17 and 18 learn the gateway first, then check each spoof rule on its own", () => {
  const script = readFileSync(path.join(process.cwd(), "scripts", "node", "isolation-test.sh"), "utf8");
  assert.match(script, /restart_spoof_check "17 [^"]*" "\$B" "\$IP4_B"/);
  assert.match(script, /restart_spoof_check "18 [^"]*" "\$A" /);
  assert.doesNotMatch(script, /rises "1[78] /, "no test 17 or 18 left on the old check");

  const good = runRestartCheck();
  assert.equal(good.failed, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /ok {3}17 after a restart: IPv4 address and default route are back/);
  assert.match(good.stdout, /ok {3}17 after a restart: gateway learned from its own address/);
  assert.match(good.stdout, /spoofed IPv4 stopped \(spoof_ip4 5 -> 6\)/);
  assert.match(good.stdout, /spoofed ARP stopped \(spoof_arp 5 -> 6\)/);
  assert.doesNotMatch(good.stdout, /counters before/, "evidence only on failure");

  const lost = runRestartCheck({ ip4Lost: true });
  assert.equal(lost.failed, 1);
  assert.match(lost.stdout, /FAIL 17 after a restart: spoofed IPv4 not stopped \(spoof_ip4 5 -> 5, spoof_arp 5 -> 5\)/);
  assert.match(lost.stdout, /counters before: tables=2 spoof_ip4=5 spoof_arp=5 spoof_mac=0/);
  assert.match(lost.stdout, /counters after: {2}tables=2 spoof_ip4=5 spoof_arp=6 spoof_mac=0/);
  assert.match(lost.stdout, /evidence: .*198\.18\.254\.11\/32.*default via 172\.31\.1\.1.*learned=/);

  assert.match(runRestartCheck({ arpLost: true }).stdout, /FAIL 17 after a restart: spoofed ARP not stopped \(spoof_arp 5 -> 5\)/);
  const unlearned = runRestartCheck({ neverLearned: true });
  assert.match(unlearned.stdout, /FAIL 17 after a restart: the gateway's MAC was never learned/);
  assert.match(unlearned.stdout, /FAIL 17 after a restart: spoofed IPv4 not stopped/, "the ARP drop isn't counted as the IPv4 proof");
  const unadded = runRestartCheck({ addExit: 2 });
  assert.match(unadded.stdout, /FAIL 17 after a restart: ip addr add failed \(add_exit=2\)/, "the IPv4 spoof's add");
  assert.match(unadded.stdout, /FAIL 17 after a restart: ip addr add failed for the ARP test \(add_exit=2\)/, "and the ARP spoof's");
  assert.match(runRestartCheck({ noAddr: true }).stdout, /FAIL 17 after a restart: no IPv4 address or default route after the restart/);
});

/** isolation-test.sh test 16's in-container script, with apt, docker and curl faked. sleep moves bash's clock. */
function runDockerCheck(o: { daemonAfter?: number; portAfter?: number; runFails?: boolean; installFails?: boolean } = {}) {
  const script = readFileSync(path.join(process.cwd(), "scripts", "node", "isolation-test.sh"), "utf8").replace(/\r\n/g, "\n");
  const check = /\n {2}docker_check='([\s\S]*?)'\n/.exec(script)![1];
  const fakes = `
sleep() { SECONDS=$((SECONDS + 1)); }
apt-get() { return ${o.installFails ? 1 : 0}; }
docker() {
  case "$1" in
    info) [ "$SECONDS" -ge ${o.daemonAfter ?? 0} ] ;;
    run) echo "docker run $*" >> calls; return ${o.runFails ? 125 : 0} ;;
    rm) echo "docker rm" >> calls ;;
    ps) echo "CONTAINER ID   IMAGE          STATUS" ;;
    logs) echo "nginx: starting" ;;
  esac
}
curl() { echo "curl at $SECONDS" >> calls; [ "$SECONDS" -ge ${o.portAfter ?? 0} ]; }
`;
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-docker-"));
  const r = spawnSync("bash", ["-c", `${fakes}\n${check}`], { encoding: "utf8", cwd: dir });
  const calls = existsSync(path.join(dir, "calls")) ? readFileSync(path.join(dir, "calls"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}

whenBash("test 16 waits up to 30 seconds for Docker's port, and says which step failed", () => {
  const slow = runDockerCheck({ daemonAfter: 4, portAfter: 20 });
  assert.equal(slow.status, 0, slow.stdout + slow.stderr);
  assert.match(slow.stdout, /^served_after=1[0-9]s$/m, "nginx answering 20 s in still passes");
  assert.match(slow.calls, /docker rm\n$/, "the test container is removed afterwards");

  const never = runDockerCheck({ portAfter: 999 });
  assert.notEqual(never.status, 0);
  assert.match(never.stdout, /^step=port$/m);
  assert.match(never.stdout, /nginx: starting/, "with docker's own view of it");
  const tries = never.calls.match(/^curl at (\d+)$/gm)!.map((l) => Number(l.split(" ").pop()));
  assert.ok(tries.length >= 20 && tries.at(-1)! < 31, `retried for 30 seconds, then stopped (${tries.length} tries, last at ${tries.at(-1)})`);

  assert.match(runDockerCheck({ daemonAfter: 999 }).stdout, /^step=daemon$/m);
  assert.match(runDockerCheck({ runFails: true }).stdout, /^step=run$/m);
  assert.match(runDockerCheck({ installFails: true }).stdout, /^step=install$/m);
  assert.doesNotMatch(runDockerCheck({ runFails: true }).calls, /curl/, "no waiting on a port that can't come");
});

test("the proof fails on any attempt that got through and any rule that stopped nothing", () => {
  const names = ["to_neighbour_l2", "to_neighbour_l3", "to_host", "to_other_iface", "to_private", "to_mail", "to_metadata", "spoof_ip4", "spoof_ip6", "spoof_mac"];
  const zero = Object.fromEntries(names.map((n) => [n, 0]));
  const up = { ...Object.fromEntries(names.map((n) => [n, 2])), tables: 2 };
  assert.deepEqual(S.checkIsolationProof(zero, up, { neighbour_v6: "no", mac_restored: "yes" }), []);
  assert.match(S.checkIsolationProof(zero, up, { neighbour_v6: "yes" }).join(), /got through: neighbour_v6/);
  assert.match(S.checkIsolationProof(zero, up, { neighbour_v6: "" }).join(), /got through/, "no answer isn't a refusal");
  assert.match(S.checkIsolationProof(zero, up, {}).join(), /no attempts came back/);
  assert.match(S.checkIsolationProof(zero, { ...up, tables: 1 }, { a: "no" }).join(), /aren't both loaded/);
  for (const name of names) assert.match(S.checkIsolationProof(zero, { ...up, [name]: 0 }, { a: "no" }).join(), new RegExp(`rule ${name} stopped nothing`));
});

test("the proof tries every path, with its targets quoted", () => {
  const script = S.isolationProbeScript({ neighbourIpv4: "198.18.254.11", neighbourIpv6: "2a01:4f8:1c16:abcd::101", nodeIpv4: "203.0.113.20", nodeIpv6: "2a01:4f8:1c16:abcd::1", mgmtPrivateIp: "10.0.0.7" });
  for (const line of [
    "neighbour_v6=", "neighbour_v4=", "neighbour_v6_routed=", "host_ssh_v4=", "host_api_v4=", "host_ssh_v6=", "host_gateway_v6=", "host_ssh_v6_routed=", "host_api_v6_routed=",
    "mail_25_v4=", "mail_465_v4=", "mail_25_v6=", "mail_465_v6=", "metadata=", "private_v4=", "private_mgmt=", "private_v6=", "other_iface_v4=", "other_iface_v6=",
  ]) assert.ok(script.includes(line), line);
  assert.ok(script.includes("'10.0.0.7'"), "sowsi-mgmt-01's private address");
  assert.ok(script.includes("'203.0.113.20' 8006"));
  assert.ok(script.includes(S.PROBE_TARGET.ipv4));
  assert.ok(script.includes(S.PROBE_TARGET.ipv6));
  const fallback = S.isolationProbeScript({ neighbourIpv4: "198.18.254.11", neighbourIpv6: "2a01::1", nodeIpv4: "203.0.113.20", nodeIpv6: "2a01::2", mgmtPrivateIp: null });
  assert.match(fallback, /private_mgmt=\$\(reach '10\.0\.0\.2' 22\)/);
});

/** A restart script run in bash, with ip, ping and sleep faked. `addrAfter` polls before eth0 has its address. */
function runInContainer(script: string, c: { addrAfter?: number; noRoute?: boolean; gateway?: "lladdr" | "INCOMPLETE" | ""; addExit?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-ct-"));
  const fakes = `
log() { echo "$*" >> calls; }
sleep() { :; }
ping() { log "ping $*"; return 1; }
ip() {
  log "ip $*"
  case "$*" in
    "-4 -o addr show dev eth0")
      n=$(($(cat polls 2>/dev/null || echo 0) + 1)); echo "$n" > polls
      if [ "$n" -gt ${c.addrAfter ?? 0} ]; then echo "2: eth0    inet 198.18.254.11/32 scope global eth0"; fi ;;
    "-4 route show default"|"-4 route") ${c.noRoute ? ":" : "echo 'default via 172.31.1.1 dev eth0 onlink'"} ;;
    "neigh show 172.31.1.1 dev eth0") ${c.gateway === "lladdr" ? "echo '172.31.1.1 lladdr fe:ff:ff:ff:ff:ff REACHABLE'" : c.gateway === "INCOMPLETE" ? "echo '172.31.1.1 INCOMPLETE'" : ":"} ;;
    "addr add "*) return ${c.addExit ?? 0} ;;
    "-br addr") echo "eth0 UP 198.18.254.11/32" ;;
    "neigh show dev eth0") echo "172.31.1.1 INCOMPLETE" ;;
  esac
}
`;
  const r = spawnSync("bash", ["-s"], { input: `${fakes}
${script}`, encoding: "utf8", cwd: dir });
  const calls = existsSync(path.join(dir, "calls")) ? readFileSync(path.join(dir, "calls"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { ...r, calls, facts: S.parseFacts(r.stdout) };
}

whenBash("after a restart: wait for the address and route, then learn the gateway from the real address", () => {
  const ready = runInContainer(S.restartReadyScript("198.18.254.11"), { addrAfter: 3, gateway: "lladdr" });
  assert.equal(ready.facts.ipv4_ready, "yes", "waited for the address");
  assert.equal(ready.calls.match(/ip -4 -o addr show dev eth0/g)!.length, 4);
  assert.match(ready.calls, /ping -c 1 -W 2 -I 198\.18\.254\.11 172\.31\.1\.1/, "pinged from the real address");
  assert.ok(ready.calls.indexOf("ping") > ready.calls.lastIndexOf("addr show dev eth0"), "only once the address is there");
  assert.equal(ready.facts.gateway_ping, "no-reply");
  assert.equal(ready.facts.gateway_learned, "yes");
  assert.equal(S.block(ready.stdout, "addr"), "eth0 UP 198.18.254.11/32");
  assert.equal(S.block(ready.stdout, "route"), "default via 172.31.1.1 dev eth0 onlink");

  assert.equal(runInContainer(S.restartReadyScript("198.18.254.11"), { addrAfter: 99, gateway: "lladdr" }).facts.ipv4_ready, "no", "no address");
  assert.equal(runInContainer(S.restartReadyScript("198.18.254.11"), { noRoute: true, gateway: "lladdr" }).facts.ipv4_ready, "no", "no default route");
  assert.equal(runInContainer(S.restartReadyScript("198.18.254.12"), { gateway: "lladdr" }).facts.ipv4_ready, "no", "another address isn't its own");
  assert.equal(runInContainer(S.restartReadyScript("198.18.254.1"), { gateway: "lladdr" }).facts.ipv4_ready, "no", "nor is a prefix of it");
  assert.equal(runInContainer(S.restartReadyScript("198.18.254.11"), { gateway: "INCOMPLETE" }).facts.gateway_learned, "no", "an INCOMPLETE entry isn't learned");
  assert.equal(runInContainer(S.restartReadyScript("198.18.254.11"), { gateway: "" }).facts.gateway_learned, "no");
});

whenBash("the restart spoofs report ip addr add's exit, and the ARP case forgets the gateway first", () => {
  const spoof = runInContainer(S.restartSpoofScript());
  assert.equal(spoof.facts.add_exit, "0");
  assert.match(spoof.calls, /ip addr add 198\.18\.254\.99\/32 dev eth0\nping -c 1 -W 1 -I 198\.18\.254\.99 1\.1\.1\.1\nip addr del/);
  assert.equal(S.block(spoof.stdout, "neigh"), "172.31.1.1 INCOMPLETE");
  assert.equal(runInContainer(S.restartSpoofScript(), { addExit: 2 }).facts.add_exit, "2");
  const arp = runInContainer(S.restartArpSpoofScript());
  assert.match(arp.calls, /ip neigh flush dev eth0\nip addr add 198\.18\.254\.99\/32 dev eth0\nping -c 1 -W 1 -I 198\.18\.254\.99 172\.31\.1\.1/);
  assert.equal(arp.facts.add_exit, "0");
  assert.equal(runInContainer(S.restartArpSpoofScript(), { addExit: 2 }).facts.add_exit, "2");
});

test("the restart proof passes only when each rule stopped its own spoof", () => {
  const ready = { ipv4_ready: "yes", gateway_learned: "yes", gateway_ping: "no-reply" };
  const at = (ip4: number, arp: number) => ({ spoof_ip4: ip4, spoof_arp: arp });
  const good = { before: at(5, 5), mid: at(6, 5), after: at(6, 6) };
  const added = { add_exit: "0" };
  assert.deepEqual(S.checkRestartProof(ready, good, added, added), []);
  assert.match(S.checkRestartProof({ ...ready, ipv4_ready: "no" }, good, added, added).join(), /never got its IPv4 address/);
  assert.match(S.checkRestartProof({ ...ready, gateway_learned: "no" }, good, added, added).join(), /never learned the gateway/);
  assert.match(S.checkRestartProof({}, good, added, added).join(), /never got its IPv4 address/, "no answer isn't ready");
  // The sowsi-test-02 case: the spoof went out as ARP. It must not count as the IPv4 proof.
  assert.match(S.checkRestartProof(ready, { before: at(5, 5), mid: at(5, 6), after: at(5, 7) }, added, added).join(), /spoofed IPv4 source wasn't stopped by spoof_ip4/);
  assert.match(S.checkRestartProof(ready, { before: at(5, 5), mid: at(6, 5), after: at(6, 5) }, added, added).join(), /spoofed sender wasn't stopped by spoof_arp/);
  assert.match(S.checkRestartProof(ready, { before: at(5, 5), mid: at(6, 6), after: at(6, 6) }, added, added).join(), /spoof_arp/, "ARP counted between before and mid isn't the ARP test's");
  assert.match(S.checkRestartProof(ready, good, { add_exit: "2" }, added).join(), /spoofed address failed \(exit 2\)/);
  assert.match(S.checkRestartProof(ready, good, {}, added).join(), /exit unknown/);
  assert.match(S.checkRestartProof(ready, good, added, { add_exit: "1" }).join(), /ARP test failed \(exit 1\)/);
});

test("the restart evidence shows every relevant counter at each read, and the container's network", () => {
  const out = "add_exit=0\naddr<<\nlo UNKNOWN 127.0.0.1/8\neth0 UP 198.18.254.11/32\n>>addr\nroute<<\ndefault via 172.31.1.1 dev eth0\n>>route\nneigh<<\n\n>>neigh";
  const lines = S.restartEvidence([["before", { spoof_ip4: 1, spoof_arp: 2 }], ["after", { spoof_ip4: 3, spoof_arp: 4, bad_frame: 9 }]], out);
  assert.equal(lines[0], "counters (before → after): spoof_ip4 1 → 3, spoof_arp 2 → 4, spoof_mac 0 → 0, spoof_ip6 0 → 0, bad_frame 0 → 9, unknown_port 0 → 0");
  assert.equal(lines[1], "ip addr: lo UNKNOWN 127.0.0.1/8 | eth0 UP 198.18.254.11/32");
  assert.equal(lines[2], "ip route: default via 172.31.1.1 dev eth0");
  assert.equal(lines[3], "ip neigh: (none)");
});

whenBash("every proof script is valid bash", () => {
  for (const script of [
    S.isolationProbeScript({ neighbourIpv4: "198.18.254.11", neighbourIpv6: "2a01::1", nodeIpv4: "203.0.113.20", nodeIpv6: "2a01::2", mgmtPrivateIp: null }),
    S.isolationMacScript(),
    S.restartReadyScript("198.18.254.11"),
    S.restartSpoofScript(),
    S.restartArpSpoofScript(),
    S.containerDiagnosticsScript(),
    routesScript(),
    setupScript(),
  ]) {
    const r = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});
