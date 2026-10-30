import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeDestroy,
  executeInstall,
  HostKeyMismatchError,
  INSTALL_LABEL,
  planDestroy,
  planInstall,
  SshAuthError,
  STEPS,
  type InstallDeps,
  type InstallOptions,
  type InstallRecord,
  type InstallSettings,
  type NodeRegistration,
  type Shell,
} from "./installNode";
import * as S from "./nodeScripts";
import { installHetznerApi } from "./hetznerApi";
import { HetznerService } from "@/lib/hetzner";
import { CPX22, deprecatedUse, fakeHetzner, type FakeHetznerConfig } from "@/lib/testing/fakeHetzner";

// ── A simulated Hetzner project, server and Proxmox node ─────────────

const INSTALL_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallKeyBodyInstallKeyBodyInstallKeyBo sowsi-install@sowsi-mgmt-01";
const ADMIN_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdminKeyBodyAdminKeyBodyAdminKeyBodyAdmin me@laptop";
const PROV_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL+L152cRvIkX3R0xtdG4toSwTbblpUz6PioDz89wglD sowsi-provisioning";
const SECRET = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

const settings: InstallSettings = {
  location: "nbg1",
  image: "debian-12",
  mgmtIp: "2.31.11.105",
  mgmtHasIpv6: true,
  protectedServerId: "168392011",
  eurToInr: 100,
  spendCapPaise: 500_000,
  sshTimeoutMs: 60_000,
  rebootTimeoutMs: 120_000,
  installTimeoutMs: 600_000,
  wrongHost: null,
  environmentProblems: [],
};
const opts = (over: Partial<InstallOptions> = {}): InstallOptions => ({ name: "sowsi-proxmox-02", serverType: "cpx22", ipv4Test: false, approvedBy: "sivakumar", keepOnFailure: false, ...over });

type World = ReturnType<typeof world>;

const SERVER_IPV4 = "203.0.113.20";
const SERVER_IPV6_NET = "2a01:4f8:1c1c:abcd::/64";

function world(
  cfg: {
    failLabel?: string;
    facts?: Record<string, string>;
    neverBack?: boolean;
    hostKeyAfterReboot?: string;
    outbound6?: "ok" | "fail";
    otherContainers?: { vmid: number; name: string }[];
    spent?: number;
    /** ufw comes back disabled after the reboot. */
    firewallLostOnReboot?: boolean;
    hetzner?: FakeHetznerConfig;
  } = {},
  hz = fakeHetzner(cfg.hetzner)
) {
  const w = {
    hz,
    installs: new Map<string, InstallRecord>(),
    nodes: [] as (NodeRegistration & { id: string; services: number; volumes: number })[],
    logs: [] as { action: string; cost?: number; after?: unknown; error?: string; success?: boolean }[],
    alerts: [] as { subject: string; detail: string }[],
    commands: [] as string[],
    clock: 0,
    // the server
    booted: "boot-1",
    kernel: "6.1.0-26-cloud-amd64",
    staged: "",
    installed: "original",
    pveInstall: "none" as "none" | "running" | "done",
    rebootAt: null as number | null,
    hostKey: "hk-1",
    authorized: [INSTALL_KEY, ADMIN_KEY],
    containers: [...(cfg.otherContainers ?? [])] as { vmid: number; name: string }[],
    tokenMade: false,
  };

  const live = () => ({ nic: "eth0", mac: "96:00:03:aa:bb:cc", ipv4: SERVER_IPV4, gateway: "172.31.1.1" });
  const sha = (t: string) => (t ? S.sha256(t) : "");
  const facts = (extra: Record<string, string> = {}) =>
    Object.entries({
      default_dev: "eth0", ...live(), staged_sha: sha(w.staged), installed_sha: sha(w.installed), cloudinit_net_disabled: w.staged ? "yes" : "no",
      interfaces_d: "", sources_interfaces_d: "no", ifupdown2: w.pveInstall === "done" ? "yes" : "no", nameservers: "2",
      syntax: "ok", pve_kernel: w.pveInstall === "done" ? "yes" : "no", grub_pve: w.pveInstall === "done" ? "yes" : "no", debian_kernels: w.pveInstall === "done" ? "none" : "linux-image-amd64",
      boot_id: w.booted, ...extra, ...(cfg.facts ?? {}),
    }).map(([k, v]) => `${k}=${v}`).join("\n");

  const shellFor = (): Shell => ({
    async exec(label, _command, o) {
      w.commands.push(label);
      if (cfg.failLabel === label) throw new Error(`${label} failed (exit 1):\nsimulated failure`);
      switch (label) {
        case "debian check": return "debian 12";
        case "hostname": return `hostname=sowsi-proxmox-02\nresolves=${SERVER_IPV4}`;
        case "bridge facts": return facts();
        case "stage bridge config": w.staged = o!.stdin!; return "";
        case "install bridge config": w.installed = w.staged; return "";
        case "kernel": return `kernel=${w.kernel}`;
        case "start Proxmox install": w.pveInstall = "running"; return "started=yes";
        case "install status": if (w.pveInstall === "running") { w.pveInstall = "done"; return "state=activating\nresult=success"; } return "state=active\nresult=success";
        case "pre-reboot check": return facts();
        case "reboot": w.rebootAt = w.clock; return "rebooting";
        case "after reboot": return `kernel=${w.kernel}\npveversion=pve-manager/8.3.0/abc\nvmbr0_ipv4=${SERVER_IPV4}/32\ngateway=172.31.1.1 vmbr0\nipv6=${S.subnetOf(SERVER_IPV6_NET)}::1/64\npve_services=active active active\nboot_id=${w.booted}`;
        case "firewall": return FIREWALL_OK;
        case "firewall check": return cfg.firewallLostOnReboot && w.kernel.endsWith("-pve") ? FIREWALL_OK.replace("Status: active", "Status: inactive") : FIREWALL_OK;
        case "proxmox-host-setup.sh": assert.match(o!.stdin!, /sowsi-routes/); return "== 1. DNS\n…\n== Done";
        case "host checks": return "out4=ok\nout6=ok\ntemplate=1\nroutes_service=enabled\ndispatcher=yes\nvmbr1=UP\nstorage=iso,vztmpl,backup,rootdir,images";
        case "API token": w.tokenMade = true; return JSON.stringify({ "full-tokenid": "root@pam!sowsi", info: { privsep: "0" }, value: SECRET });
        case "add provisioning key": w.authorized.push(`restrict,command="/usr/local/sbin/sowsi-host" ${PROV_KEY}`); return "1";
        case "remove install key": w.authorized = w.authorized.filter((k) => k !== INSTALL_KEY); return `install_lines=0\nadmin_lines=${w.authorized.includes(ADMIN_KEY) ? 1 : 0}`;
        case "outbound": return `out6=${cfg.outbound6 ?? "ok"}\nout4=${o?.stdin ? "ok" : "ok"}`;
        default: return "";
      }
    },
    close() {},
  });

  const deps: InstallDeps = {
    hetzner: installHetznerApi(new HetznerService({ adapter: hz.adapter, token: "test", pollMs: 1 })),
    keys: { installPublicKey: async () => INSTALL_KEY, adminPublicKey: ADMIN_KEY, provisioningPublicKey: PROV_KEY },
    async ssh(_host, key, o) {
      if (w.rebootAt !== null) {
        if (cfg.neverBack || w.clock - w.rebootAt < 30_000) throw new Error("connect ECONNREFUSED");
        // Came back: new boot, Proxmox kernel.
        w.rebootAt = null;
        w.booted = "boot-2";
        w.kernel = "6.8.12-4-pve";
        if (cfg.hostKeyAfterReboot) w.hostKey = cfg.hostKeyAfterReboot;
      }
      if (o.hostKeySha256 && o.hostKeySha256 !== w.hostKey) throw new HostKeyMismatchError("host key changed");
      if (key === "install" && !w.authorized.includes(INSTALL_KEY)) throw new SshAuthError("refused");
      return { shell: shellFor(), hostKeySha256: w.hostKey };
    },
    containerShell: async () => shellFor(),
    syncRoutes: async () => {
      if (!w.authorized.some((k) => k.includes(PROV_KEY))) throw new Error("All configured authentication methods failed");
      const ours = w.containers.filter((c) => c.name === S.TEST_CONTAINER_HOSTNAME);
      return `routes: ${ours.filter((c) => (c as { ipv4?: string }).ipv4).length} IPv4, ${ours.length} IPv6`;
    },
    hostSetupScript: () => "#!/usr/bin/env bash\n# sowsi-routes …",
    proxmox: () => ({
      getVersion: async () => ({ version: "8.3.0" }),
      getNodeStatus: async () => ({ memory: { total: 7_940 * 1024 * 1024 }, cpus: 4 }),
      getStorageStatus: async () => ({ total: 150 * 1024 ** 3 }),
      getNextVMID: async () => 100,
      listLXC: async () => w.containers.map((c) => ({ ...c, status: "running" })),
      createLXC: async (i) => void w.containers.push({ vmid: i.vmid, name: i.hostname, ...(i.ipv4 ? { ipv4: i.ipv4 } : {}) }),
      waitForLXC: async () => {},
      destroyContainer: async (vmid) => {
        w.containers = w.containers.filter((c) => c.vmid !== vmid);
        return { leftover: [], errors: [] };
      },
    }),
    db: {
      findInstall: async (name) => w.installs.get(name) ?? null,
      findInstallByServer: async (id) => [...w.installs.values()].find((r) => r.hetznerServerId === id) ?? null,
      async createInstall(d) {
        const r: InstallRecord = { id: `ni_${w.installs.size + 1}`, status: "IN_PROGRESS", completedSteps: [], error: null, hetznerServerId: null, ipv4: null, ipv6Subnet: null, hostKeySha256: null, bootIdBeforeReboot: null, apiTokenSecret: null, testFloatingIpId: null, ...d };
        w.installs.set(r.name, r);
        return { ...r };
      },
      async updateInstall(id, d) {
        const r = [...w.installs.values()].find((x) => x.id === id)!;
        Object.assign(r, d);
        return { ...r, completedSteps: [...r.completedSteps] };
      },
      async nodeByServerId(id) {
        const n = w.nodes.find((x) => x.hetznerServerId === id);
        return n ? { id: n.id, name: n.name, ip: n.ip, services: n.services, volumes: n.volumes, apiTokenId: n.apiTokenId, apiTokenSecret: n.apiTokenSecret } : null;
      },
      nodeNameTaken: async (name) => w.nodes.some((n) => n.name === name),
      registerNode: async (d) => void w.nodes.push({ ...d, id: `node_${w.nodes.length + 1}`, services: 0, volumes: 0 }),
      deleteNode: async (id) => void (w.nodes = w.nodes.filter((n) => n.id !== id)),
      spentThisMonthPaise: async () => cfg.spent ?? 0,
    },
    log: async (e) => void w.logs.push(e),
    alert: async (subject, detail) => void w.alerts.push({ subject, detail }),
    encrypt: (t) => `enc(${t})`,
    decrypt: (t) => t.replace(/^enc\((.*)\)$/, "$1"),
    sleep: async (ms) => void (w.clock += ms),
    now: () => w.clock,
    report: () => {},
  };
  return Object.assign(w, { deps });
}

const servers = (w: World) => w.hz.state.servers;
const hetznerRequests = (w: World) => w.hz.requests;

const FIREWALL_OK = `ufw<<
Status: active
Default: deny (incoming), allow (outgoing), allow (routed)
22/tcp                     ALLOW IN    Anywhere
80/tcp                     ALLOW IN    Anywhere
443/tcp                    ALLOW IN    Anywhere
8006/tcp                   ALLOW IN    2.31.11.105
Anywhere                   ALLOW FWD   Anywhere on vmbr1
>>ufw
sshd_password=no
sshd_root=without-password
sshd_kbd=no
fail2ban=active`;

const steps = (w: World) => w.logs.filter((l) => l.action === "NODE_INSTALL_STEP").map((l) => (l.after as { step: string }).step);

// ── Plan and spend ────────────────────────────────────────────────────

test("plan: monthly and hourly cost from the live prices, nothing bought", async () => {
  const w = world();
  const p = await planInstall(w.deps, opts(), settings);
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.cost!.monthlyPaise, Math.ceil((22.99 + 0.5) * 100 * 100));
  assert.equal(p.cost!.hourlyPaise, Math.ceil((0.0368 + 0.0008) * 100 * 100));
  assert.match(p.cost!.lines.join("\n"), /€22\.99\/month, €0\.0368\/hour[\s\S]*₹2,349\/month, ₹3\.76\/hour/);
  assert.equal(p.resumeFrom, "server");
  assert.equal(servers(w).size, 0);
  assert.ok(hetznerRequests(w).every((r) => r.method === "GET"), "plan mode only reads");
});

const nbg1 = (over: Record<string, unknown>) => ({ ...CPX22, locations: CPX22.locations.map((l) => (l.name === "nbg1" ? { ...l, ...over } : l)) });

test("a type is buyable only when its location says available: true and deprecation: null; anything else fails the plan with the reason", async () => {
  const cases: [Record<string, unknown>[], RegExp][] = [
    [[nbg1({ available: false })], /isn't available in nbg1 right now/],
    [[nbg1({ deprecation: { announced: "2026-09-01T00:00:00Z", unavailable_after: "2026-12-01T00:00:00Z" } })], /deprecated in nbg1 \(unavailable after 2026-12-01/],
    [[{ ...CPX22, locations: CPX22.locations.filter((l) => l.name !== "nbg1") }], /isn't sold in nbg1/],
    [[{ ...CPX22, locations: undefined }], /availability can't be read/],
    [[nbg1({ available: undefined })], /availability can't be read/],
    [[nbg1({ deprecation: undefined })], /availability can't be read/],
    [[{ ...CPX22, prices: [] }], /lists no price/],
    [[{ ...CPX22, architecture: "arm" }], /Proxmox VE's packages are x86/],
    [[], /isn't a Hetzner server type/],
  ];
  for (const [serverTypes, why] of cases) {
    const w = world({ hetzner: { serverTypes } });
    const p = await planInstall(w.deps, opts(), settings);
    assert.equal(p.ok, false, String(why));
    assert.match(p.problems.join(" "), why);
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false);
    assert.equal(servers(w).size, 0, "nothing bought");
  }
});

test("if availability or prices can't be read, the plan fails with the reason and never assumes", async () => {
  const down = { status: 503, code: "service_error", message: "try again" };
  for (const hetzner of [{ serverTypesError: down }, { pricingError: down }]) {
    const w = world({ hetzner });
    const p = await planInstall(w.deps, opts(), settings);
    assert.equal(p.ok, false);
    assert.match(p.problems.join(" "), /can't read availability and prices from Hetzner.*service_error: try again/);
    assert.equal((await executeInstall(w.deps, opts(), settings)).ok, false);
    assert.equal(servers(w).size, 0);
  }
});

test("plan refuses: ARM type, over the ₹5,000 cap, name taken, IPv6-only test without IPv6 on mgmt", async () => {
  const cases: [ReturnType<typeof world>, Partial<InstallOptions>, Partial<InstallSettings>, RegExp][] = [
    [world(), { serverType: "cax21" }, {}, /ARM/],
    [world({ spent: 490_000 }), {}, {}, /over the ₹5,000 cap/],
    [world(), { name: "Bad_Name" }, {}, /--name must be a hostname/],
    [world(), {}, { mgmtHasIpv6: false }, /add --ipv4/],
    [world(), {}, { wrongHost: "this runs only on sowsi-mgmt-01" }, /only on sowsi-mgmt-01/],
    [world(), {}, { environmentProblems: ["PROVISIONING_SSH_PUBLIC_KEY is not set"] }, /PROVISIONING_SSH_PUBLIC_KEY/],
  ];
  for (const [w, o, st, why] of cases) {
    const p = await planInstall(w.deps, opts(o), { ...settings, ...st });
    assert.equal(p.ok, false, String(why));
    assert.match(p.problems.join(" "), why);
  }
  const w = world();
  w.nodes.push({ id: "n1", name: "sowsi-proxmox-02", services: 0, volumes: 0 } as never);
  assert.match((await planInstall(w.deps, opts(), settings)).problems.join(), /already registered/);
});

test("--execute needs --approved-by and still checks the cap", async () => {
  const w = world();
  assert.match((await executeInstall(w.deps, opts({ approvedBy: null }), settings) as { error: string }).error, /--approved-by/);
  const over = world({ spent: 499_000 });
  const r = await executeInstall(over.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.equal(servers(over).size, 0, "nothing bought over the cap");
});

// ── The whole install ─────────────────────────────────────────────────

test("execute: every step in order; registered closed with measured specs and the encrypted per-node token", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.deepEqual(steps(w), [...STEPS]);

  const create = hetznerRequests(w).find((q) => q.method === "POST" && q.path === "/servers")!.body!;
  assert.equal(create.location, "nbg1");
  assert.equal(create.image, "debian-12");
  assert.equal(create.server_type, "cpx22");
  assert.equal((create.ssh_keys as number[]).length, 2, "install key + admin key");
  assert.deepEqual(create.labels, { [INSTALL_LABEL]: "1", "sowsi-node": "sowsi-proxmox-02" });

  const purchase = w.logs.find((l) => l.action === "SERVER_PURCHASED")!;
  assert.equal(purchase.cost, Math.ceil(23.49 * 100 * 100), "counts toward the monthly cap");

  const [node] = w.nodes;
  assert.equal(node.physicalRamMB, 7940);
  assert.equal(node.physicalDiskGB, 150);
  assert.equal(node.ipv6Subnet, "2a01:4f8:1c1c:abcd");
  assert.equal(node.apiTokenId, "root@pam!sowsi");
  assert.equal(node.apiTokenSecret, `enc(${SECRET})`);
  assert.doesNotMatch(JSON.stringify([w.logs, w.alerts]), new RegExp(SECRET), "the token secret is never logged");
  assert.equal(w.installs.get("sowsi-proxmox-02")!.apiTokenSecret, null, "moved to the node row");

  // Order on the server: bridge verified before Proxmox, the reboot only after the pre-reboot check.
  const c = w.commands;
  assert.ok(c.indexOf("firewall") >= 0 && c.indexOf("firewall") < c.indexOf("start Proxmox install"), "8006 is denied before Proxmox exists");
  assert.ok(c.indexOf("firewall check") < c.indexOf("start Proxmox install"), "and checked right before the install");
  assert.ok(c.lastIndexOf("firewall check") > c.indexOf("after reboot"), "and again after the reboot");
  assert.ok(c.indexOf("install bridge config") < c.indexOf("start Proxmox install"));
  assert.ok(c.indexOf("pre-reboot check") < c.indexOf("reboot"));
  assert.ok(c.indexOf("add provisioning key") < c.indexOf("remove install key"));
  assert.deepEqual(w.authorized.filter((k) => k === INSTALL_KEY), [], "install key gone from the server");
  assert.ok(w.authorized.includes(ADMIN_KEY));
  assert.deepEqual([...w.hz.state.sshKeys.values()].map((k) => k.public_key), [ADMIN_KEY], "install key entry removed from Hetzner; admin key kept");
  assert.deepEqual(w.containers, [], "test container deleted");
  assert.match(w.alerts[0].subject, /New Proxmox node installed/);
});

test("--ipv4: the test container gets a Floating IP, which is released afterwards", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts({ ipv4Test: true }), settings)).ok, true);
  assert.equal(w.hz.state.floatingIps.size, 0);
  assert.equal(w.installs.get("sowsi-proxmox-02")!.testFloatingIpId, null);
});

// ── Hetzner refusing the purchase ─────────────────────────────────────

test("type not available, limit reached, quota: a clear message and nothing bought", async () => {
  for (const [status, code, why] of [
    [422, "resource_unavailable", /no cpx22 available in nbg1/],
    [403, "resource_limit_exceeded", /project limit reached/],
    [422, "placement_error", /couldn't place/],
    [409, "uniqueness_error", /already exists/],
  ] as const) {
    const w = world({ hetzner: { createError: { status, code, message: "x" } } });
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false, code);
    assert.match((r as { error: string }).error, why);
    assert.match((r as { error: string }).error, /Nothing was bought/);
    assert.equal(servers(w).size, 0);
    assert.ok(!w.logs.some((l) => l.action === "SERVER_PURCHASED"), code);
    assert.equal(w.installs.get("sowsi-proxmox-02")!.status, "FAILED");
  }
});

// ── Failures delete the server ────────────────────────────────────────

test("a bridge config that doesn't match the server is caught before any reboot; the server is deleted", async () => {
  // The server's own IPv4 isn't the one Hetzner reported: the config would bring up the wrong address.
  const w = world({ facts: { ipv4: "203.0.113.99" } });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /bridge \(staged\): the server's live IPv4 is "203\.0\.113\.99", but Hetzner says 203\.0\.113\.20/);
  assert.ok(!w.commands.includes("reboot"));
  assert.ok(!w.commands.includes("start Proxmox install"));
  assert.equal(servers(w).size, 0, "server deleted");
  assert.ok(![...w.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY), "install key entry removed");
  assert.equal(w.installs.get("sowsi-proxmox-02")!.status, "FAILED");
  assert.ok(w.logs.some((l) => l.action === "NODE_INSTALL_FAILED"));
  assert.match(w.alerts[0].subject, /failed: sowsi-proxmox-02 at bridge/);
  assert.match(w.alerts[0].detail, /was deleted/);
});

test("the pre-reboot check refuses to reboot without ifupdown2 or a Proxmox kernel", async () => {
  for (const bad of [{ ifupdown2: "no" }, { grub_pve: "no" }, { syntax: "error: bad line" }] as Record<string, string>[]) {
    // Only the pre-reboot stage looks at these; earlier stages ignore them.
    const w = world({ facts: bad });
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /pre-reboot check \(not rebooted\)/);
    assert.ok(!w.commands.includes("reboot"));
    assert.equal(servers(w).size, 0);
  }
});

test("a server that doesn't come back after the reboot times out and is deleted", async () => {
  const w = world({ neverBack: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /didn't come back within 2 min/);
  assert.equal(servers(w).size, 0);
});

test("a changed SSH host key after the reboot stops the install", async () => {
  const w = world({ hostKeyAfterReboot: "hk-EVIL" });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /failed at step 3e[\s\S]*host key changed/);
  assert.equal(servers(w).size, 0);
});

test("a failed test container is cleaned up (container, Floating IP) before the server is deleted", async () => {
  const w = world({ outbound6: "fail" });
  const r = await executeInstall(w.deps, opts({ ipv4Test: true }), settings);
  assert.match((r as { error: string }).error, /can't reach the internet over IPv6/);
  assert.deepEqual(w.containers, []);
  assert.equal(w.hz.state.floatingIps.size, 0);
  assert.equal(servers(w).size, 0);
  assert.equal(w.nodes.length, 0, "never registered");
});

test("never deletes a server that holds someone else's container", async () => {
  const w = world({ outbound6: "fail", otherContainers: [{ vmid: 104, name: "sowsi-cmabc123" }] });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.equal(servers(w).size, 1, "kept");
  assert.match(w.alerts[0].detail, /NOT deleted: the node has container\(s\) 104 sowsi-cmabc123/);
});

test("--keep-on-failure keeps the server for inspection and a re-run resumes it", async () => {
  const w = world({ failLabel: "firewall" });
  const r = await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  assert.equal(r.ok, false);
  assert.equal(servers(w).size, 1);
  assert.match(w.alerts[0].detail, /KEPT and still billed/);
  const rec = w.installs.get("sowsi-proxmox-02")!;
  assert.equal(rec.status, "IN_PROGRESS");
  assert.ok(!rec.completedSteps.includes("firewall"));
});

// ── Resume ────────────────────────────────────────────────────────────

test("a re-run resumes at the first unfinished step and repeats nothing before it", async () => {
  const w = world({ failLabel: "proxmox-host-setup.sh" });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const before = w.commands.length;
  const purchases = w.logs.filter((l) => l.action === "SERVER_PURCHASED").length;

  // The same server and records, now without the failure.
  const resumed = resumeWorld(w);
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  const after = resumed.commands.slice(before);
  assert.equal(after[0], "proxmox-host-setup.sh", "starts at the failed step");
  for (const earlier of ["hostname", "firewall", "stage bridge config", "start Proxmox install", "reboot"]) assert.ok(!after.includes(earlier), earlier);
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, purchases, "not bought twice");
});

/** The same simulated Hetzner, server and records, with no injected failure. */
function resumeWorld(w: World): World {
  const fresh = world({}, w.hz);
  for (const key of ["installs", "nodes", "logs", "alerts", "commands", "booted", "kernel", "staged", "installed", "pveInstall", "hostKey", "authorized", "containers", "clock"] as const) {
    (fresh as Record<string, unknown>)[key] = (w as Record<string, unknown>)[key];
  }
  return fresh;
}

test("a run that stopped right after removing the install key counts the lockdown as done", async () => {
  const w = world({ failLabel: "outbound" });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const rec = w.installs.get("sowsi-proxmox-02")!;
  // Pretend the lockdown never got recorded, though it happened on the server.
  rec.completedSteps = rec.completedSteps.filter((s) => s !== "lockdown");
  assert.ok(!w.authorized.includes(INSTALL_KEY));
  const resumed = resumeWorld(w);
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.match(JSON.stringify(resumed.logs.findLast((l) => (l.after as { step?: string })?.step === "lockdown")), /already locked down/);
});

test("a recorded server that vanished at Hetzner: the install is marked failed, nothing else bought", async () => {
  const w = world({ failLabel: "firewall" });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  servers(w).clear();
  const resumed = resumeWorld(w);
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.match((r as { error: string }).error, /no longer exists at Hetzner/);
  assert.equal(resumed.installs.get("sowsi-proxmox-02")!.status, "FAILED");
  assert.equal(servers(resumed).size, 0);
});

// ── --destroy ─────────────────────────────────────────────────────────

test("--destroy: plan by default; refuses node 1, servers it didn't create, and nodes with services", async () => {
  const w = world();
  await executeInstall(w.deps, opts({ ipv4Test: false }), settings);
  const id = String([...servers(w).keys()][0]);

  const plan = await planDestroy(w.deps, id, settings);
  assert.equal(plan.ok, true, plan.problems.join());
  assert.match(plan.lines.join("\n"), /delete Hetzner server[\s\S]*remove ProxmoxNode sowsi-proxmox-02/);
  assert.equal(servers(w).size, 1, "plan changes nothing");

  assert.match((await planDestroy(w.deps, "168392011", settings)).problems.join(), /node 1/);
  servers(w).set(777, { id: 777, name: "someone-else", status: "running", server_type: { name: "cpx22" }, location: { name: "nbg1" }, public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: null }, labels: {} });
  assert.match((await planDestroy(w.deps, "777", settings)).problems.join(), /wasn't created by install-node/);
  w.nodes[0].services = 1;
  assert.match((await planDestroy(w.deps, id, settings)).problems.join(), /1 service\(s\)/);
  assert.equal((await executeDestroy(w.deps, id, "sivakumar", settings)).ok, false);
  assert.equal(servers(w).has(Number(id)), true);
});

test("--destroy refuses anywhere but sowsi-mgmt-01, in plan and in execute", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const id = String([...servers(w).keys()][0]);
  const elsewhere = { ...settings, wrongHost: "this runs only on sowsi-mgmt-01 (this is laptop)" };
  assert.match((await planDestroy(w.deps, id, elsewhere)).problems.join(), /only on sowsi-mgmt-01/);
  const r = await executeDestroy(w.deps, id, "sivakumar", elsewhere);
  assert.equal(r.ok, false);
  assert.equal(servers(w).size, 1, "nothing deleted");
});

test("--destroy --execute: needs --approved-by; deletes the server and the node row, marks the install destroyed", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const id = String([...servers(w).keys()][0]);
  assert.equal((await executeDestroy(w.deps, id, null, settings)).ok, false);
  const r = await executeDestroy(w.deps, id, "sivakumar", settings);
  assert.equal(r.ok, true, r.lines.join());
  assert.equal(servers(w).size, 0);
  assert.equal(w.nodes.length, 0);
  assert.equal(w.installs.get("sowsi-proxmox-02")!.status, "DESTROYED");
  assert.ok(w.logs.some((l) => l.action === "NODE_DESTROYED"));
});

// ── The 8006 window, Primary IPs, deprecated calls ────────────────────

test("Proxmox is never installed while the firewall is down", async () => {
  const w = world({ failLabel: "firewall check" });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.ok(!w.commands.includes("start Proxmox install"));
  assert.equal(servers(w).size, 0);
});

test("a firewall that didn't survive the reboot stops the install", async () => {
  const w = world({ firewallLostOnReboot: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /firewall check after the reboot: ufw is not active/);
  assert.equal(servers(w).size, 0);
  assert.equal(w.nodes.length, 0);
});

test("deleting a failed server leaves no Primary IP billing", async () => {
  for (const hetzner of [{}, { primaryIpsSurviveDelete: true }]) {
    const w = world({ failLabel: "hostname", hetzner });
    await executeInstall(w.deps, opts(), settings);
    assert.equal(servers(w).size, 0);
    assert.equal(w.hz.state.primaryIps.size, 0, "no Primary IP left");
    assert.doesNotMatch(w.alerts[0].detail, /bill hourly/);
  }
});

test("a Primary IP that can't be deleted is reported, for a failed install and for --destroy", async () => {
  const w = world({ failLabel: "hostname", hetzner: { primaryIpsSurviveDelete: true, primaryIpDeleteFails: true } });
  await executeInstall(w.deps, opts(), settings);
  assert.equal(w.hz.state.primaryIps.size, 2);
  assert.match(w.alerts[0].detail, /Primary IP\(s\) \d+, \d+ still exist and bill hourly/);

  const d = world({ hetzner: { primaryIpsSurviveDelete: true, primaryIpDeleteFails: true } });
  await executeInstall(d.deps, opts(), settings);
  const r = await executeDestroy(d.deps, String([...servers(d).keys()][0]), "sivakumar", settings);
  assert.equal(r.ok, false);
  assert.match(r.lines.join(), /still exist and bill hourly/);
});

test("a whole install and destroy touches nothing deprecated", async () => {
  const w = world();
  await executeInstall(w.deps, opts({ ipv4Test: true }), settings);
  await executeDestroy(w.deps, String([...servers(w).keys()][0]), "sivakumar", settings);
  assert.deepEqual(hetznerRequests(w).flatMap(deprecatedUse), []);
  assert.ok(!hetznerRequests(w).some((r) => r.path.startsWith("/datacenters")));
  assert.equal(w.hz.state.primaryIps.size, 0);
});
