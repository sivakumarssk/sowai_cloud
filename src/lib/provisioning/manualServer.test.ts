import { test } from "node:test";
import assert from "node:assert/strict";
import { assignManualServer, type AssignDeps, type AssignInput, type AssignSnapshot, type SshCheck } from "./manualServer";

const now = new Date("2026-10-30T12:00:00Z");

/** The imported client: a manual server on billing hold, not assigned yet. */
const imported = (over: Partial<AssignSnapshot> = {}): AssignSnapshot => ({
  id: "svc_imp",
  status: "INSTALLING",
  serverSource: "MANUAL",
  proxmoxVmId: null,
  provisioningPct: 0,
  updatedAt: new Date("2026-10-29T08:00:00Z"),
  serverIp: null,
  planName: "VPS Basic",
  customer: "Asha <asha@example.com>",
  ...over,
});

const input: AssignInput = { serverIp: "203.0.113.10", sshUsername: "root", sshPassword: "s3cret-Pass!", notifyCustomer: true };

function fakes(opts: { snap?: AssignSnapshot | null; ssh?: SshCheck; saveOk?: boolean } = {}) {
  const calls: string[] = [];
  const logs: { action: string; success: boolean; after?: unknown; error?: string }[] = [];
  let saved: Record<string, unknown> | null = null;
  const deps: AssignDeps = {
    load: async () => (opts.snap === undefined ? imported() : opts.snap),
    sshCheck: async (t) => {
      calls.push(`ssh ${t.username}@${t.host}:${t.port}`);
      return opts.ssh ?? { ok: true, detail: "logged in as root on 203.0.113.10:22 · Linux 6.1" };
    },
    save: async (_s, d) => {
      calls.push("save");
      saved = d;
      return opts.saveOk ?? true;
    },
    notifyCustomer: async () => void calls.push("notify"),
    log: async (e) => void logs.push(e),
  };
  return { deps, calls, logs, saved: () => saved };
}

test("ACTIVE only after the SSH login works; the attempt is audited without the password", async () => {
  const f = fakes();
  const r = await assignManualServer("svc_imp", input, "admin@sowsi.in", f.deps, now);
  assert.deepEqual(r, { ok: true, status: "ACTIVE", sshDetail: "logged in as root on 203.0.113.10:22 · Linux 6.1" });
  assert.deepEqual(f.calls, ["ssh root@203.0.113.10:22", "save", "notify"]);
  const saved = f.saved()!;
  assert.equal(saved.status, "ACTIVE");
  assert.equal(saved.serverSource, "MANUAL");
  assert.equal((saved.sshVerifiedAt as Date).toISOString(), now.toISOString());
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].action, "SERVER_ASSIGNED");
  assert.doesNotMatch(JSON.stringify(f.logs), /s3cret-Pass!/, "the password is never logged");
  assert.match(JSON.stringify(f.logs[0].after), /admin@sowsi\.in/);
});

test("a failed SSH check changes nothing, is audited, and says why", async () => {
  const f = fakes({ ssh: { ok: false, error: "All configured authentication methods failed" } });
  const r = await assignManualServer("svc_imp", input, "admin@sowsi.in", f.deps, now);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.httpStatus, 422);
    assert.match(r.error, /SSH check failed — nothing was changed: All configured authentication methods failed/);
  }
  assert.deepEqual(f.calls, ["ssh root@203.0.113.10:22"], "no save, no email");
  assert.deepEqual(f.logs.map((l) => [l.action, l.success]), [["SERVER_ASSIGN_SSH_FAILED", false]]);
  assert.doesNotMatch(JSON.stringify(f.logs), /s3cret-Pass!/);
});

test("refuses — without trying SSH — a Proxmox container, a running build, a cancelled service or bad input", async () => {
  const cases: [Parameters<typeof fakes>[0], AssignInput, RegExp][] = [
    [{ snap: imported({ proxmoxVmId: "104", serverSource: "PROXMOX" }) }, input, /already has Proxmox container 104/],
    [{ snap: imported({ serverSource: "PROXMOX", status: "INSTALLING", provisioningPct: 60, updatedAt: new Date(now.getTime() - 60_000) }) }, input, /Proxmox build is running/],
    [{ snap: imported({ status: "CANCELLED" }) }, input, /CANCELLED/],
    [{}, { ...input, serverIp: "not-an-ip" }, /IPv4 or IPv6/],
    [{}, { ...input, sshPassword: "" }, /password is required/],
    [{}, { ...input, sshPort: 70000 }, /port/],
    [{}, { ...input, sshUsername: "root; rm -rf /" }, /user name/],
  ];
  for (const [opts, inp, why] of cases) {
    const f = fakes(opts);
    const r = await assignManualServer("svc_imp", inp, "admin", f.deps, now);
    assert.equal(r.ok, false, String(why));
    if (!r.ok) assert.match(r.error, why);
    assert.deepEqual(f.calls, [], String(why));
    assert.equal(f.logs[0].action, "SERVER_ASSIGN_REFUSED", String(why));
  }
});

test("a Proxmox order that never got a container (e.g. held S4) can be assigned by hand", async () => {
  const f = fakes({ snap: imported({ serverSource: "PROXMOX", status: "PROVISIONING", provisioningPct: 0 }) });
  assert.equal((await assignManualServer("svc_imp", input, "admin", f.deps, now)).ok, true);
  assert.equal(f.saved()!.serverSource, "MANUAL");
});

test("a suspended service gets its server but stays suspended, and the client isn't emailed", async () => {
  const f = fakes({ snap: imported({ status: "SUSPENDED" }) });
  const r = await assignManualServer("svc_imp", input, "admin", f.deps, now);
  assert.deepEqual(r.ok && r.status, "SUSPENDED");
  assert.ok(!f.calls.includes("notify"));
});

test("if the service changed during the SSH check, nothing is saved", async () => {
  const f = fakes({ saveOk: false });
  const r = await assignManualServer("svc_imp", input, "admin", f.deps, now);
  assert.equal(r.ok, false);
  assert.ok(!f.calls.includes("notify"));
  assert.equal(f.logs.at(-1)!.action, "SERVER_ASSIGN_REFUSED");
});
