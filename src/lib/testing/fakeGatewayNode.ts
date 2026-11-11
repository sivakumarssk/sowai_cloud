// Test harness: sowsi-gateway, exactly as proxmox-host-setup.sh writes it, run in bash. The container
// is faked: `pct exec 9000 --` works on a folder (ct/), HAProxy's config test and reload are
// recorded, and "live" holds the version the running HAProxy would answer with. Used by
// gatewayScript.test.ts and gatewayTable.test.ts (two files: each runs bash many times, and the
// test runner gives each file 120 seconds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const setup = () => readFileSync(path.join(process.cwd(), "scripts", "proxmox-host-setup.sh"), "utf8").replace(/\r\n/g, "\n");
const gatewayScript = () => /cat > \/usr\/local\/sbin\/sowsi-gateway <<'SCRIPT'\n([\s\S]*?)\nSCRIPT\n/.exec(setup())![1];
export const whenBash = (name: string, fn: () => void) => test(name, (t) => (spawnSync("bash", ["--version"]).error ? t.skip("no bash") : fn()));

export const GW = "net0: name=eth0,bridge=vmbr1,gw=172.31.1.1,hwaddr=BC:24:11:AA:BB:90,ip=203.0.113.50/32,type=veth";
export const NODE: Record<string, string> = {
  9000: `hostname: sowsi-gateway\n${GW}`,
  101: "hostname: sowsi-a\nnet0: name=eth0,bridge=vmbr1,gw=172.31.1.1,hwaddr=BC:24:11:AA:BB:01,ip=100.64.0.5/32,ip6=2a01:4f8:1c16:5f1d::101/64,type=veth",
  102: "hostname: sowsi-b\nnet0: name=eth0,bridge=vmbr1,gw=172.31.1.1,hwaddr=BC:24:11:AA:BB:02,ip=100.64.0.6/32,ip6=2a01:4f8:1c16:5f1d::102/64,type=veth",
  // A dedicated container, on its own Floating IP: never a gateway backend.
  103: "hostname: sowsi-c\nnet0: name=eth0,bridge=vmbr1,gw=172.31.1.1,hwaddr=BC:24:11:AA:BB:03,ip=203.0.113.7/32,type=veth",
  // A shared address, but not on the containers' bridge.
  104: "hostname: sowsi-d\nnet0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:04,ip=100.64.0.9/32,type=veth",
};
export const K1 = "3f9ac21e7b104d6a";
export const K2 = "0123456789abcdef";
export const LAST_GOOD = `old.example.com ${K1} 100.64.0.5 0\n`;

type Run = {
  args: string;
  stdin?: string;
  containers?: Record<string, string>;
  /** Applied before this run: version 5, one route, live in the container. */
  applied?: boolean;
  env?: Record<string, string>;
};

const FAKES = `
export SOWSI_LXC_DIR=lxc SOWSI_GATEWAY_STATE=state SOWSI_RUN_DIR=run
log() { echo "$*" >> calls; }
flock() { :; }
logger() { :; }
sleep() { :; }
ip() { echo "$1 $2 $3 $4: 203.0.113.50 dev vmbr1 proto 250 scope link"; }
pct() {
  log "pct $*"
  # The script's lock is fd 9: anything run in the container must not hold it.
  if { true >&9; } 2>/dev/null; then echo "pct $1 got the lock" >> leaks; fi
  local cmd=$1; shift 2
  case $cmd in
    status)
      case "\${GW_STATE:-running}" in
        missing) echo "Configuration file does not exist" >&2; return 2 ;;
        *) echo "status: \${GW_STATE:-running}" ;;
      esac ;;
    start) : ;;
    push) mkdir -p "ct$(dirname "$2")"; cp "$1" "ct$2" ;;
    exec) shift; ctexec "$@" ;;
  esac
}
ctexec() {
  case $1 in
    mkdir) shift; for a in "$@"; do [ "$a" = -p ] || mkdir -p "ct$a"; done ;;
    haproxy)
      log "config test $4"
      if [ -n "\${HAPROXY_FAILS:-}" ] || grep -q 'this is not haproxy' "ct$4"; then echo "[ALERT] parsing [$4:99] : unknown keyword 'this'" >&2; return 1; fi ;;
    readlink) if [ -f "ct$2" ]; then cat "ct$2"; else return 1; fi ;;
    ln) echo "$3" > "ct$4" ;;
    mv) mv -f "ct$3" "ct$4" ;;
    rm) rm -rf "ct$3" ;;
    ls) ls -1 "ct$3" 2>/dev/null ;;
    systemctl)
      case $2 in
        reload-or-restart)
          log "reload"
          if [ -n "\${RELOAD_FAILS:-}" ]; then return 1; fi
          if [ -z "\${RELOAD_NOOP:-}" ] && [ -f ct/etc/haproxy/sowsi/current ]; then cp ct/etc/haproxy/sowsi/current live; fi ;;
        is-active) if [ "$3" = ssh ]; then echo "\${SSH_STATE:-inactive}"; else printf "%s" "\${HAPROXY_ACTIVE:-active}"; fi ;;
        is-enabled) echo enabled ;;
        show) echo "CONFIG=/etc/haproxy/sowsi/current/haproxy.cfg PIDFILE=/run/haproxy.pid EXTRAOPTS=-S /run/haproxy-master.sock" ;;
        *) log "ct $*" ;;
      esac ;;
    curl)
      case "$*" in
        *sowsi-probe.invalid*) printf 'HTTP/1.1 204 No Content\\r\\nx-sowsi-gateway-version: %s\\r\\n\\r\\n' "$(cat live 2>/dev/null)" ;;
        *) printf '%s' "\${UNKNOWN_CODE:-404}" ;;
      esac ;;
    env) log "ct $*" ;;
    getent) return 0 ;;
    sh) log "ct $*"; case "$*" in *grep*) echo "\${LOGINS:-0}" ;; esac ;;
    ss) printf 'tcp LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\\ntcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\\ntcp LISTEN 0 4096 127.0.0.53%%lo:53 0.0.0.0:*\\n' ;;
    cat) echo "\${MEMORY:-64000000}" ;;
  esac
}
`;

function files(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, files(p, base));
    else out[path.relative(base, p).replaceAll("\\", "/")] = readFileSync(p, "utf8");
  }
  return out;
}

export function runGateway(o: Run) {
  const dir = mkdtempSync(path.join(tmpdir(), "sowsi-gateway-"));
  mkdirSync(path.join(dir, "lxc"));
  for (const [id, text] of Object.entries(o.containers ?? NODE)) writeFileSync(path.join(dir, "lxc", `${id}.conf`), `arch: amd64\n${text}\n`);
  if (o.applied !== false) {
    mkdirSync(path.join(dir, "state"));
    writeFileSync(path.join(dir, "state", "version"), "5\n");
    writeFileSync(path.join(dir, "state", "table"), LAST_GOOD);
    const v5 = path.join(dir, "ct", "etc", "haproxy", "sowsi", "5");
    mkdirSync(v5, { recursive: true });
    writeFileSync(path.join(v5, "haproxy.cfg"), "# version 5\n");
    writeFileSync(path.join(v5, "http.map"), `old.example.com h_${K1}\n`);
    writeFileSync(path.join(v5, "tls.map"), `old.example.com t_${K1}\n`);
    writeFileSync(path.join(dir, "ct", "etc", "haproxy", "sowsi", "current"), "5\n");
    writeFileSync(path.join(dir, "live"), "5\n");
  }
  const before = { state: files(path.join(dir, "state")), ct: files(path.join(dir, "ct")) };
  const script = gatewayScript().replace("set -euo pipefail\n", `set -euo pipefail\n${FAKES}\n`);
  // From a file: a command line this long is cut short on Windows.
  writeFileSync(path.join(dir, "sowsi-gateway"), script);
  const r = spawnSync("bash", ["sowsi-gateway", ...o.args.split(" ").filter(Boolean)], { input: o.stdin ?? "", encoding: "utf8", cwd: dir, env: { ...process.env, ...o.env }, maxBuffer: 64 * 1024 * 1024 });
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : "");
  const result = {
    ...r,
    before,
    state: files(path.join(dir, "state")),
    ct: files(path.join(dir, "ct")),
    calls: read("calls"),
    live: read("live").trim(),
    pwned: existsSync(path.join(dir, "pwned")),
    leaks: read("leaks"),
    leftovers: existsSync(path.join(dir, "run")) ? readdirSync(path.join(dir, "run")).filter((f) => f.startsWith("gateway.") && f !== "gateway.lock") : [],
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

export const unchanged = (r: ReturnType<typeof runGateway>, what: string) => {
  assert.deepEqual(r.state, r.before.state, `${what}: the applied version and table are byte for byte the same`);
  assert.deepEqual(r.ct, r.before.ct, `${what}: the container's config is byte for byte the same`);
  assert.equal(r.live, "5", `${what}: the last good config is still serving`);
  assert.doesNotMatch(r.calls, /reload|config test/, `${what}: HAProxy wasn't touched`);
};
