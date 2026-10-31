import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeDestroy,
  executeInstall,
  HostKeyMismatchError,
  INSTALL_LABEL,
  planDestroy,
  planInstall,
  resumeSummary,
  SshAuthError,
  STEPS,
  testFlagProblems,
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
import { CPX22, deprecatedUse, fakeHetzner, RESCUE_ROOT_PASSWORD, type FakeHetznerConfig } from "@/lib/testing/fakeHetzner";
import { freshFirewall, runFirewallScript } from "@/lib/testing/fakeUfw";

/** Always with a message: a bare assert.ok that fails under tsx spins instead of reporting. */
const ok = (value: unknown, message = "expected a true value") => assert.ok(value, message);

// ── A simulated Hetzner project, server and Proxmox node ─────────────

const INSTALL_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallKeyBodyInstallKeyBodyInstallKeyBo sowsi-install@sowsi-mgmt-01";
const ADMIN_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdminKeyBodyAdminKeyBodyAdminKeyBodyAdmin me@laptop";
const NODE_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQNodeKeyBodyNodeKeyBodyNodeKeyBodyNode root@sowsi-test-01";
const STRANGER_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQStrangerBodyStrangerBodyStrangerBody who@where";
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
  resumeProbeMs: 60_000,
  installTimeoutMs: 600_000,
  wrongHost: null,
  environmentProblems: [],
};
const opts = (over: Partial<InstallOptions> = {}): InstallOptions => ({ name: "sowsi-proxmox-02", serverType: "cpx22", ipv4Test: false, approvedBy: "sivakumar", keepOnFailure: false, ...over });

type World = ReturnType<typeof world>;

const SERVER_IPV4 = "203.0.113.20";
const SERVER_IPV6_NET = "2a01:4f8:1c1c:abcd::/64";

type WorldCfg = {
    failLabel?: string;
    facts?: Record<string, string>;
    neverBack?: boolean;
    hostKeyAfterReboot?: string;
    outbound6?: "ok" | "fail";
    otherContainers?: { vmid: number; name: string }[];
    spent?: number;
    /** ufw comes back disabled after the reboot. */
    firewallLostOnReboot?: boolean;
    /** Polls after the reboot that find Proxmox's services still starting. */
    servicesStartingPolls?: number;
    hetzner?: FakeHetznerConfig;
    /** The card is enp1s0 on the Proxmox kernel: a bridge on any other name leaves the server dark. */
    renameNic?: boolean;
    /** Stays dark even with the right bridge port. */
    repairDoesntHelp?: boolean;
    /** The rescue system never answers SSH. */
    rescueNeverAnswers?: boolean;
    /** The failed boot's name for the card can't be read and udev has none. */
    nameUnknown?: boolean;
    /** Container images on the disk. */
    diskImages?: string;
    /** update-initramfs didn't pick the pin up. */
    pinNotInInitrd?: boolean;
    /** The IPv6 step can't reach anything. */
    ipv6Fails?: boolean;
    /** Names don't resolve even with resolvers set. */
    dnsNeverResolves?: boolean;
    /** /etc/resolv.conf is a link again after the reboot. */
    resolvLostOnReboot?: boolean;
    /** A key nobody put there is in authorized_keys. */
    strangerKey?: boolean;
    /** authorized_keys has a line ssh-keygen can't read. */
    unreadableKeyLine?: boolean;
    /** The RSA key is on the node, but no private half is there to prove it's the node's own. */
    nodeKeyMissing?: boolean;
    /** The Proxmox install put the link back, after DNS was written. */
    resolvLostInInstall?: boolean;
};

function world(cfg: WorldCfg = {}, hz = fakeHetzner(cfg.hetzner)) {
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
    firewall: freshFirewall(),
    saved: [] as { suffix: string; text: string }[],
    /** Card name pinned by the .link file. */
    pinName: null as string | null,
    guardInstalled: false,
    ipv6Fails: cfg.ipv6Fails ?? false,
    /** A plain /etc/resolv.conf. Otherwise it's the image's link, which only works while DHCP feeds it. */
    resolvStatic: false,
    /** What the rescue repair wrote. */
    repaired: "",
    servicesStarting: cfg.servicesStartingPolls ?? 0,
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

  const REAL_NIC = "enp1s0";
  const MAC = "96:00:03:aa:bb:cc";
  const bridgePort = () => /bridge-ports (\S+)/.exec(w.installed)?.[1] ?? "";
  /** The card's name on the Proxmox kernel: the pin wins, or the rename happens. */
  const cardName = () => (cfg.renameNic ? (w.pinName ?? REAL_NIC) : "eth0");
  /** A bridge on any other name has no port, so the server has no network. */
  const netDown = () => w.kernel.endsWith("-pve") && (Boolean(cfg.repairDoesntHelp) || bridgePort() !== cardName());
  /** The boot-time guard: finds the card and corrects vmbr0. Nothing if the network works. */
  const runGuard = () => {
    if (!w.guardInstalled || !netDown()) return;
    w.installed = w.installed.replace(/bridge-ports \S+/, `bridge-ports ${cardName()}`);
    w.commands.push("guard repaired");
  };

  const rescueShell = (): Shell => ({
    async exec(label, _command, o) {
      w.commands.push(label);
      if (cfg.failLabel === label) throw new Error(`${label} failed (exit 1):\nsimulated failure`);
      switch (label) {
        case "rescue lsblk":
          return JSON.stringify({ blockdevices: [{ name: "vda", path: "/dev/vda", size: 85899345920, type: "disk", children: [{ name: "vda1", path: "/dev/vda1", label: "root", size: 85000000000, fstype: "ext4", type: "part", mountpoint: null }] }] });
        case "rescue mount":
          return "root=ok";
        case "rescue diagnostics": {
          const unknown = cfg.nameUnknown;
          const journal = !unknown && cfg.renameNic && !w.pinName ? REAL_NIC : "";
          return `=== /etc/network/interfaces\n${w.installed}\n=== facts\nsowsi_bridge_ports=${bridgePort()}\nsowsi_mac=${MAC}\nsowsi_rescue_dev=eth0\nsowsi_name_udev=${unknown ? "" : cardName()}\nsowsi_name_pin=${unknown ? "" : (w.pinName ?? "")}\nsowsi_name_journal=${journal}\nsowsi_port_errors=1\nsowsi_journal=yes\nsowsi_images=${cfg.diskImages ?? ""}`;
        }
        case "rescue repair": {
          w.installed = o!.stdin!;
          w.repaired = o!.stdin!;
          const nic = bridgePort();
          w.pinName = nic;
          return `sowsi_backup=/etc/network/interfaces.sowsi-before-repair-x\nsowsi_interfaces_sha=${S.sha256(o!.stdin!)}\nsowsi_link_sha=${S.sha256(S.linkFile({ nic, mac: MAC }))}\nsowsi_initrd_pin=yes`;
        }
        default:
          return "";
      }
    },
    close() {},
  });

  const shellFor = (): Shell => ({
    async exec(label, command, o) {
      w.commands.push(label);
      if (cfg.failLabel === label) throw new Error(`${label} failed (exit 1):\nsimulated failure`);
      switch (label) {
        case "debian check": return "debian 12";
        case "hostname": return `hostname=sowsi-proxmox-02\nresolves=${SERVER_IPV4}`;
        case "bridge facts": return facts();
        case "stage bridge config": w.staged = o!.stdin!; return "";
        case "install bridge config": w.installed = w.staged; return "";
        case "kernel": return `kernel=${w.kernel}`;
        case "dns write": w.resolvStatic = true; return "";
        case "dns check": {
          const resolves = !cfg.dnsNeverResolves && (w.resolvStatic || !w.kernel.endsWith("-pve"));
          return `resolv_link=${w.resolvStatic ? "no" : "yes"}\nresolv_servers=${w.resolvStatic ? S.RESOLVERS.join(" ") : ""}\ndns=${resolves ? "ok" : "broken"}`;
        }
        case "pin nic": w.pinName = /Name=(\S+)/.exec(command)![1]; return "";
        case "install guard": w.guardInstalled = true; return "";
        case "boot safety check":
          return [
            `pin_file=${w.pinName ? S.sha256(S.linkFile({ nic: w.pinName, mac: MAC })) : ""}`,
            `pin_link=${w.pinName ? S.LINK_FILE : ""}`,
            `pin_initrd=${cfg.pinNotInInitrd ? "no" : "yes"}`,
            `guard_unit=${w.guardInstalled ? "enabled" : "disabled"}`,
            `guard_script=${S.sha256(S.guardScript())}`,
            "journal_storage=persistent",
            "journal_dir=yes",
          ].join("\n");
        case "simulate bad nic": w.installed = w.installed.replace(/bridge-ports \S+/, `bridge-ports ${S.BAD_NIC}`); return "1";
        case "ipv6":
          if (!/inet6/.test(w.installed)) w.installed += "\niface vmbr0 inet6 static\n";
          return `${w.ipv6Fails ? "ipv6_debug<<\n--- ip -6 addr\ninet6 fe80::1/64\n--- ip -6 neigh\nfe80::1 FAILED\n>>ipv6_debug\n" : ""}ipv6=${S.subnetOf(SERVER_IPV6_NET)}::1/64\nroute6=fe80::1 vmbr0\nipv4=${SERVER_IPV4}\ngateway6=ok\ndns=${w.resolvStatic ? "ok" : "broken"}\nout6=${w.ipv6Fails ? "fail" : "ok"}`;
        case "start Proxmox install": w.pveInstall = "running"; return "started=yes";
        case "install status": if (w.pveInstall === "running") { w.pveInstall = "done"; if (cfg.resolvLostInInstall) w.resolvStatic = false; return "state=activating\nresult=success"; } return "state=active\nresult=success";
        case "pre-reboot check": return facts();
        case "reboot": w.rebootAt = w.clock; return "rebooting";
        case "after reboot": {
          const services = w.servicesStarting-- > 0 ? "activating activating activating" : "active active active";
          return `kernel=${w.kernel}\npveversion=pve-manager/8.3.0/abc (running kernel: ${w.kernel})\nvmbr0_ipv4=${SERVER_IPV4}\ngateway=172.31.1.1 vmbr0\nipv6=${/inet6/.test(w.installed) ? `${S.subnetOf(SERVER_IPV6_NET)}::1/64` : ""}\npve_services=${services}\nboot_id=${w.booted}`;
        }
        case "firewall":
          return runFirewallScript(w.firewall, command);
        case "firewall check":
          if (cfg.firewallLostOnReboot && w.kernel.endsWith("-pve")) w.firewall.active = false;
          return runFirewallScript(w.firewall, command);
        case "proxmox-host-setup.sh": assert.match(o!.stdin!, /sowsi-routes/); return "== 1. DNS\n…\n== Done";
        case "host checks": return "out4=ok\nout6=ok\ntemplate=1\nroutes_service=enabled\ndispatcher=yes\nvmbr1=<NO-CARRIER,BROADCAST,MULTICAST,UP>\nstorage=iso,vztmpl,backup,rootdir,images\nforward4=1\nforward6=1\nforward_saved=2\nproxy_ndp=1\nproxy_arp=1\nproxy_saved=2";
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
      const srv = [...hz.state.servers.values()][0] as { bootedRescue?: boolean; rescueKeys?: number[] } | undefined;
      if (srv?.bootedRescue) {
        if (cfg.rescueNeverAnswers) throw new Error("connect ETIMEDOUT");
        const injected = (srv.rescueKeys ?? []).some((id) => hz.state.sshKeys.get(id)?.public_key === INSTALL_KEY);
        if (key !== "install" || !injected) throw new SshAuthError("the rescue system refused the key");
        return { shell: rescueShell(), hostKeySha256: "hk-rescue" };
      }
      if (w.rebootAt !== null) {
        if (cfg.neverBack || w.clock - w.rebootAt < 30_000) throw new Error("connect ECONNREFUSED");
        // Came back: new boot, Proxmox kernel.
        w.rebootAt = null;
        w.booted = "boot-2";
        w.kernel = "6.8.12-4-pve";
        if (cfg.hostKeyAfterReboot) w.hostKey = cfg.hostKeyAfterReboot;
        if (cfg.resolvLostOnReboot) w.resolvStatic = false;
        runGuard();
      }
      if (netDown()) throw new Error("connect ETIMEDOUT");
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
    authorizedKeys: async () => {
      // Proxmox adds the node's own key itself; a planted key sits next to the others.
      const lines = [...w.authorized, NODE_KEY, ...(cfg.strangerKey ? [STRANGER_KEY] : [])];
      const rows = lines.map((l) => `key=256 ${S.keyFingerprint(/ssh-\S+ \S+/.exec(l)![0])} (ED25519)`);
      return [`lines=${lines.length + (cfg.unreadableKeyLine ? 1 : 0)}`, ...rows, `node_key=${cfg.nodeKeyMissing ? "" : S.keyFingerprint(NODE_KEY)}`].join("\n");
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
        const r: InstallRecord = { id: `ni_${w.installs.size + 1}`, status: "IN_PROGRESS", completedSteps: [], error: null, hetznerServerId: null, ipv4: null, ipv6Subnet: null, hostKeySha256: null, bootIdBeforeReboot: null, repairedAt: null, purchasedAt: null, costSettledPaise: null, createdAt: new Date(w.clock), updatedAt: new Date(w.clock), apiTokenSecret: null, testFloatingIpId: null, ...d };
        w.installs.set(r.name, r);
        return { ...r };
      },
      async updateInstall(id, d) {
        const r = [...w.installs.values()].find((x) => x.id === id)!;
        if (d.name && d.name !== r.name) {
          w.installs.delete(r.name);
          w.installs.set(d.name, r);
        }
        Object.assign(r, d, { updatedAt: new Date(w.clock) });
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
    saveDiagnostics: async (serverId, suffix, text) => {
      w.commands.push(`saved diagnostics${suffix}`);
      w.saved.push({ suffix, text });
      return `/root/node-diagnostics/${serverId}-stamp${suffix}.txt`;
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
  ok(hetznerRequests(w).every((r) => r.method === "GET"), "plan mode only reads");
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
  ok(c.indexOf("firewall") >= 0 && c.indexOf("firewall") < c.indexOf("start Proxmox install"), "8006 is denied before Proxmox exists");
  ok(c.indexOf("firewall check") < c.indexOf("start Proxmox install"), "and checked right before the install");
  ok(c.lastIndexOf("firewall check") > c.indexOf("after reboot"), "and again after the reboot");
  ok(c.indexOf("install bridge config") < c.indexOf("start Proxmox install"));
  ok(c.indexOf("pre-reboot check") < c.indexOf("reboot"));
  ok(c.indexOf("add provisioning key") < c.indexOf("remove install key"));
  assert.deepEqual(w.authorized.filter((k) => k === INSTALL_KEY), [], "install key gone from the server");
  ok(w.authorized.includes(ADMIN_KEY));
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
    ok(!w.logs.some((l) => l.action === "SERVER_PURCHASED"), code);
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
  ok(!w.commands.includes("reboot"));
  ok(!w.commands.includes("start Proxmox install"));
  assert.equal(servers(w).size, 0, "server deleted");
  ok(![...w.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY), "install key entry removed");
  assert.equal(w.installs.get("sowsi-proxmox-02")!.status, "FAILED");
  ok(w.logs.some((l) => l.action === "NODE_INSTALL_FAILED"));
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
    ok(!w.commands.includes("reboot"));
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
  ok(!rec.completedSteps.includes("firewall"));
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
  for (const earlier of ["hostname", "firewall", "stage bridge config", "start Proxmox install", "reboot"]) ok(!after.includes(earlier), earlier);
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, purchases, "not bought twice");
});

/** The same simulated Hetzner, server and records, with no injected failure unless `cfg` says so. */
function resumeWorld(w: World, cfg: WorldCfg = {}): World {
  const fresh = world(cfg, w.hz);
  for (const key of ["installs", "nodes", "logs", "alerts", "commands", "booted", "kernel", "staged", "installed", "pveInstall", "hostKey", "authorized", "containers", "clock", "firewall", "saved", "rebootAt", "pinName", "guardInstalled", "repaired", "resolvStatic"] as const) {
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
  ok(!w.authorized.includes(INSTALL_KEY), "the install key was removed from the server");
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
  ok(w.logs.some((l) => l.action === "NODE_DESTROYED"));
});

// ── The 8006 window, Primary IPs, deprecated calls ────────────────────

test("Proxmox is never installed while the firewall is down", async () => {
  const w = world({ failLabel: "firewall check" });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  ok(!w.commands.includes("start Proxmox install"));
  assert.equal(servers(w).size, 0);
});

test("a firewall that didn't survive the reboot stops the install", async () => {
  const w = world({ firewallLostOnReboot: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /ufw is not active/);
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
  ok(!hetznerRequests(w).some((r) => r.path.startsWith("/datacenters")));
  assert.equal(w.hz.state.primaryIps.size, 0);
});

// ── The real stop at step 3f ──────────────────────────────────────────

/** Server 173512291 as found: bought, 3a and 3b done, ufw half applied by the run that stopped at 3f. */
async function stoppedAt3f() {
  const w = world({ failLabel: "firewall" });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  Object.assign(w.firewall, { active: true, ipForward: 0, policy: { incoming: "deny", outgoing: "allow", routed: "allow" } });
  w.firewall.rules = ["22/tcp                     ALLOW IN    Anywhere", "8006/tcp                   ALLOW IN    2.31.11.105"];
  return w;
}

test("the plan shows the install resumes at 3f, buys nothing, and which step is next", async () => {
  const w = await stoppedAt3f();
  const p = await planInstall(w.deps, opts(), settings);
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.resumeFrom, "firewall");
  const lines = resumeSummary(p.install!).join("\n");
  assert.match(lines, /no new server is bought/);
  assert.match(lines, /done: server, ssh, hostname/);
  assert.match(lines, /next: 3f ufw, fail2ban, key-only SSH/);
  assert.match(lines, /last error: firewall: /);
});

test("a re-run on the half-configured server resumes at 3f, buys no second server, and finishes", async () => {
  const w = await stoppedAt3f();
  const before = w.commands.length;
  const shown: string[] = [];
  const resumed = resumeWorld(w);
  resumed.deps.report = (l) => void shown.push(l);
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);

  assert.equal(resumed.commands[before], "firewall", "3f is the first thing it runs");
  ok(!resumed.commands.slice(before).includes("hostname"));
  assert.equal(hetznerRequests(resumed).filter((q) => q.method === "POST" && q.path === "/servers").length, 1, "one server, ever");
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, 1);
  assert.equal(servers(resumed).size, 1);
  assert.match(shown[0], /Resuming sowsi-proxmox-02 on Hetzner server \d+ \(203\.0\.113\.20\): no new server is bought/);
  assert.match(shown[2], /next: 3f/, "says what's next before running it");
  assert.equal(w.installs.get("sowsi-proxmox-02")!.error, null, "the old error doesn't linger");
});

test("SSH coming up before Proxmox's services isn't a failure: it waits for them", async () => {
  const w = world({ servicesStartingPolls: 3 });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.equal(servers(w).size, 1);
});

test("Proxmox services that never start fail after the timeout; a wrong kernel fails at once", async () => {
  const stuck = world({ servicesStartingPolls: 1000 });
  const r = await executeInstall(stuck.deps, opts(), settings);
  assert.match((r as { error: string }).error, /after reboot: Proxmox services: activating/);
  assert.equal(servers(stuck).size, 0);

  const wrong = world({ facts: {} });
  wrong.deps.report = () => {};
  const shell = wrong.deps.ssh;
  wrong.deps.ssh = async (...a) => {
    const c = await shell(...a);
    const exec = c.shell.exec;
    c.shell.exec = async (label, cmd, o) => (label === "after reboot" ? (await exec(label, cmd, o)).replace(/kernel=\S+/, "kernel=6.1.0-26-cloud-amd64") : exec(label, cmd, o));
    return c;
  };
  const started = wrong.clock;
  const r2 = await executeInstall(wrong.deps, opts(), settings);
  assert.match((r2 as { error: string }).error, /after reboot: running kernel/);
  ok(wrong.clock - started < 60_000 + 30_000, "doesn't wait out the timeout");
});

// ── A node that doesn't come back from the first reboot ───────────────

const NAME = "sowsi-proxmox-02";
const requested = (w: World, suffix: string) => hetznerRequests(w).filter((q) => q.method === "POST" && q.path.endsWith(suffix));
const rescueOf = (w: World) => [...servers(w).values()][0] as unknown as { rescue_enabled: boolean; bootedRescue?: boolean };
const noRescueTraffic = (w: World) => requested(w, "/enable_rescue").length === 0 && requested(w, "/reset").length === 0;

/** Server 173512291 as it stands: Proxmox installed, rebooted, dark, Hetzner install key removed. */
async function darkServer() {
  const w = world({ renameNic: true, hetzner: { rescueError: { status: 503, code: "unavailable", message: "not this time" } } });
  await executeInstall(w.deps, opts({ keepOnFailure: true, noPin: true, noGuard: true }), settings);
  assert.equal(w.installs.get(NAME)!.completedSteps.at(-1), "proxmox");
  delete w.hz.cfg.rescueError;
  hetznerRequests(w).length = 0;
  w.alerts.length = 0;
  w.hz.state.sshKeys.forEach((k, id) => k.public_key === INSTALL_KEY && w.hz.state.sshKeys.delete(id));
  w.installs.get(NAME)!.error = null;
  return w;
}

test("a fresh install whose card is renamed at the reboot recovers by itself and finishes", async () => {
  const w = world({ renameNic: true });
  const r = await executeInstall(w.deps, opts({ noPin: true, noGuard: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.deepEqual(steps(w), [...STEPS]);
  assert.equal(w.nodes.length, 1);
  assert.match(w.installed, /bridge-ports enp1s0/);
  assert.equal(w.logs.filter((l) => l.action === "NODE_RESCUE_RECOVERED").length, 1);
});

test("the live case: a re-run finds the dark server, repairs it once, resumes at 3e, buys nothing", async () => {
  const w = await darkServer();
  const plan = await planInstall(w.deps, opts(), settings);
  assert.equal(plan.resumeFrom, "reboot");
  assert.match(plan.notes!.join(), /doesn't answer SSH.*POWER-CYCLE/);
  ok(noRescueTraffic(w), "the plan changes nothing");

  const resumed = resumeWorld(w, { renameNic: true });
  const before = steps(resumed).length;
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);

  assert.deepEqual(steps(resumed).slice(before), STEPS.slice(STEPS.indexOf("reboot")), "carries on from 3e");
  assert.equal(requested(resumed, "/servers").length, 0, "no second server");
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, 1);
  assert.equal(requested(resumed, "/enable_rescue").length, 1);
  assert.equal(requested(resumed, "/reset").length, 2, "into rescue, and back to its own disk");
  assert.deepEqual(requested(resumed, "/enable_rescue")[0].body!.type, "linux64");
});

test("rescue is cleaned up, and the install key is registered for it and removed after", async () => {
  const w = await darkServer();
  ok(![...w.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY), "removed earlier");
  const resumed = resumeWorld(w, { renameNic: true });
  await executeInstall(resumed.deps, opts(), settings);
  const paths = hetznerRequests(resumed).map((q) => `${q.method} ${q.path}`);
  ok(paths.indexOf("POST /ssh_keys") < paths.findIndex((p) => p.endsWith("/enable_rescue")), "registered first");
  const keyId = (requested(resumed, "/enable_rescue")[0].body!.ssh_keys as number[])[0];
  ok(hetznerRequests(resumed).some((q) => q.method === "DELETE" && q.path === `/ssh_keys/${keyId}`), "removed afterwards");
  ok(![...resumed.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY));
  assert.equal(rescueOf(resumed).rescue_enabled, false);
  assert.equal(rescueOf(resumed).bootedRescue, false, "booted from its own disk");
});

test("diagnostics are saved before anything on the disk changes", async () => {
  const w = await darkServer();
  const resumed = resumeWorld(w, { renameNic: true });
  await executeInstall(resumed.deps, opts(), settings);
  const c = resumed.commands;
  ok(c.indexOf("rescue mount") < c.indexOf("rescue diagnostics"));
  ok(c.indexOf("rescue diagnostics") < c.indexOf("saved diagnostics"));
  ok(c.indexOf("saved diagnostics") < c.indexOf("rescue repair"));
  ok(c.indexOf("rescue repair") < c.indexOf("rescue unmount"));
  assert.match(resumed.saved[0].text, /bridge-ports eth0/, "the original config is in the evidence");
  const diagnosed = resumed.logs.find((l) => l.action === "NODE_RESCUE_DIAGNOSED")!.after as { cause: string; confidence: string };
  assert.equal(diagnosed.confidence, "high");
  assert.match(diagnosed.cause, /bridged to eth0, but on the Proxmox kernel the card is named enp1s0/);
});

test("the rescue host key is for that session only: the node's own pin survives, and is what's checked after", async () => {
  const w = await darkServer();
  const pinned = w.installs.get(NAME)!.hostKeySha256;
  ok(pinned && pinned !== "hk-rescue");
  const resumed = resumeWorld(w, { renameNic: true });
  await executeInstall(resumed.deps, opts(), settings);
  assert.equal(resumed.installs.get(NAME)!.hostKeySha256, pinned);
});

test("a repaired node is IPv4 only at first, and it's the node's own host key that gets it past 3e", async () => {
  const w = await darkServer();
  const resumed = resumeWorld(w, { renameNic: true });
  await executeInstall(resumed.deps, opts(), settings);
  assert.doesNotMatch(resumed.repaired.split("\n").filter((l) => !l.startsWith("#")).join("\n"), /inet6|vmbr1|hwaddress/);
  assert.match(resumed.repaired, /address 203\.0\.113\.20\/32[\s\S]*gateway 172\.31\.1\.1[\s\S]*pointopoint 172\.31\.1\.1[\s\S]*bridge-ports enp1s0/);
  assert.match(resumed.installed, /inet6/, "the IPv6 step added it after");
});

test("the repair runs once: if it doesn't help, it looks again, changes nothing more, and follows --keep-on-failure", async () => {
  const w = await darkServer();
  const stuck = resumeWorld(w, { renameNic: true, repairDoesntHelp: true });
  const r = await executeInstall(stuck.deps, opts({ keepOnFailure: true }), settings);
  assert.equal(r.ok, false);
  assert.equal(stuck.commands.filter((c) => c === "rescue repair").length, 1);
  assert.deepEqual(stuck.saved.map((d) => d.suffix), ["", "-after-repair"]);
  assert.match(stuck.alerts.at(-1)!.detail, /didn't bring the server back[\s\S]*What changed:/);
  assert.equal(servers(stuck).size, 1, "kept");
  ok(stuck.installs.get(NAME)!.repairedAt);

  const resets = requested(stuck, "/reset").length;
  const again = resumeWorld(stuck, { renameNic: true, repairDoesntHelp: true });
  const r2 = await executeInstall(again.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r2 as { error: string }).error, /already tried.*runs only once/);
  assert.equal(requested(again, "/reset").length, resets, "no further power cycle");
  assert.equal(again.commands.filter((c) => c === "rescue repair").length, 1);
});

test("without --keep-on-failure, a repair that doesn't help ends with the server deleted", async () => {
  const w = await darkServer();
  const stuck = resumeWorld(w, { renameNic: true, repairDoesntHelp: true });
  await executeInstall(stuck.deps, opts(), settings);
  assert.equal(servers(stuck).size, 0);
  assert.equal(stuck.hz.state.primaryIps.size, 0);
});

test("a node holding customers is never power-cycled without --allow-downtime", async () => {
  const w = await darkServer();
  const id = String([...servers(w).keys()][0]);
  w.nodes.push({ id: "n9", name: "already-open", hetznerServerId: id, ip: "203.0.113.20", services: 2, volumes: 0, apiTokenId: null, apiTokenSecret: null } as never);
  const refused = resumeWorld(w, { renameNic: true });
  const r = await executeInstall(refused.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /No automatic repair: rescue power-cycles the server, and node already-open has 2 service\(s\).*--allow-downtime/);
  ok(noRescueTraffic(refused));
  assert.equal(refused.commands.filter((c) => c.startsWith("rescue")).length, 0);
  ok(refused.logs.some((l) => l.action === "NODE_RESCUE_REFUSED"));

  const allowed = resumeWorld(refused, { renameNic: true });
  const r2 = await executeInstall(allowed.deps, opts({ allowDowntime: true }), settings);
  assert.equal(requested(allowed, "/enable_rescue").length, 1, (r2 as { error?: string }).error);
});

test("never node 1, and never a server the installer didn't create", async () => {
  const one = await darkServer();
  const id = String([...servers(one).keys()][0]);
  const r = await executeInstall(resumeWorld(one, { renameNic: true }).deps, opts({ keepOnFailure: true }), { ...settings, protectedServerId: id });
  assert.match((r as { error: string }).error, /HETZNER_SERVER_ID \(node 1\)/);
  ok(noRescueTraffic(one));

  const other = await darkServer();
  (servers(other).get(Number(String([...servers(other).keys()][0])))!.labels as Record<string, string>)[INSTALL_LABEL] = "0";
  const r2 = await executeInstall(resumeWorld(other, { renameNic: true }).deps, opts({ keepOnFailure: true }), settings);
  assert.match((r2 as { error: string }).error, /wasn't created by install-node/);
  ok(noRescueTraffic(other));
});

test("container images on the disk stop the repair without --allow-downtime", async () => {
  const w = await darkServer();
  const blocked = resumeWorld(w, { renameNic: true, diskImages: "104 " });
  const r = await executeInstall(blocked.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /disk holds container images \(104\)/);
  ok(!blocked.commands.includes("rescue repair"));
  assert.equal(rescueOf(blocked).bootedRescue, false, "booted back");
});

test("no evidence, no repair: the disk isn't touched, and rescue is still cleaned up", async () => {
  for (const cfg of [{ nameUnknown: true, renameNic: true }, { neverBack: true }] as WorldCfg[]) {
    const w = world(cfg);
    const r = await executeInstall(w.deps, opts({ keepOnFailure: true, noPin: true, noGuard: true }), settings);
    assert.equal(r.ok, false);
    assert.equal(w.commands.includes("rescue repair"), false);
    ok(w.commands.includes("saved diagnostics"));
    assert.equal(w.installs.get(NAME)!.repairedAt, null, "the attempt isn't used up");
    assert.equal(rescueOf(w).rescue_enabled, false);
    assert.equal(rescueOf(w).bootedRescue, false);
    ok(![...w.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY));
  }
});

test("a rescue system that never answers still ends with rescue off, the server on its own disk, and no key left", async () => {
  const w = await darkServer();
  const silent = resumeWorld(w, { renameNic: true, rescueNeverAnswers: true });
  const r = await executeInstall(silent.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /Rescue repair failed/);
  assert.equal(rescueOf(silent).bootedRescue, false);
  assert.equal(requested(silent, "/reset").length, 2);
  ok(![...silent.hz.state.sshKeys.values()].some((k) => k.public_key === INSTALL_KEY));
});

test("rescue's root password never reaches a log, and nothing deprecated is called", async () => {
  const w = await darkServer();
  const resumed = resumeWorld(w, { renameNic: true });
  await executeInstall(resumed.deps, opts(), settings);
  assert.doesNotMatch(JSON.stringify([resumed.logs, resumed.alerts, resumed.saved]), new RegExp(RESCUE_ROOT_PASSWORD));
  assert.deepEqual(hetznerRequests(resumed).flatMap(deprecatedUse), []);
});

// ── Three layers against a renamed card ───────────────────────────────

const onlyRescue = (w: World) => requested(w, "/enable_rescue").length;

test("without any of the fixes, a renamed card leaves the server dark", async () => {
  const w = world({ renameNic: true, hetzner: { rescueError: { status: 503, code: "unavailable", message: "no rescue today" } } });
  const r = await executeInstall(w.deps, opts({ noPin: true, noGuard: true }), settings);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /didn't come back/);
  assert.equal(w.nodes.length, 0);
});

test("the pin alone fixes it: the card keeps its name, and neither the guard nor rescue is needed", async () => {
  const w = world({ renameNic: true });
  const r = await executeInstall(w.deps, opts({ noGuard: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.equal(onlyRescue(w), 0);
  ok(!w.commands.includes("guard repaired"));
  assert.match(w.installed, /bridge-ports eth0/);
});

test("with the pin off, the guard fixes it, with no rescue and no power cycle", async () => {
  const w = world({ renameNic: true });
  const r = await executeInstall(w.deps, opts({ noPin: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  ok(w.commands.includes("guard repaired"));
  assert.equal(onlyRescue(w), 0);
  assert.match(w.installed, /bridge-ports enp1s0/);
});

test("with both off, rescue repairs it, once", async () => {
  const w = world({ renameNic: true });
  const r = await executeInstall(w.deps, opts({ noPin: true, noGuard: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.equal(onlyRescue(w), 1);
  assert.equal(w.commands.filter((c) => c === "rescue repair").length, 1);
});

test("the guard does nothing on a healthy network", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  ok(w.guardInstalled);
  ok(!w.commands.includes("guard repaired"));
});

test("--simulate-bad-nic proves the guard, and with --no-guard the rescue repair, on a healthy pinned server", async () => {
  const guard = world();
  const r = await executeInstall(guard.deps, opts({ simulateBadNic: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  ok(guard.commands.indexOf("pre-reboot check") < guard.commands.indexOf("simulate bad nic"));
  ok(guard.commands.indexOf("simulate bad nic") < guard.commands.indexOf("reboot"));
  ok(guard.commands.includes("guard repaired"));
  assert.equal(onlyRescue(guard), 0);

  const rescue = world();
  const r2 = await executeInstall(rescue.deps, opts({ simulateBadNic: true, noGuard: true }), settings);
  assert.equal(r2.ok, true, (r2 as { error?: string }).error);
  assert.equal(onlyRescue(rescue), 1);
  assert.match(rescue.repaired, /bridge-ports eth0/, "the pinned name, not a guess");
  assert.match(rescue.saved[0].text, /sowsi_bridge_ports=sowsibad0/);
});

test("the test switches can't reach a real node", () => {
  assert.deepEqual(testFlagProblems({ name: "sowsi-test-01", simulateBadNic: true, noGuard: true }), []);
  assert.match(testFlagProblems({ name: "sowsi-proxmox-02", simulateBadNic: true }).join(), /must contain "test"/);
  assert.deepEqual(testFlagProblems({ name: "sowsi-test-01", noPin: true }), [], "--no-pin alone, to see what the pin does");
  assert.match(testFlagProblems({ name: "sowsi-proxmox-02", noPin: true, noGuard: true }).join(), /--no-pin, --no-guard are only for a throwaway/);
  assert.deepEqual(testFlagProblems({ name: "sowsi-proxmox-02" }), []);
});

test("no reboot unless the pin is really in the initramfs and the guard is enabled", async () => {
  const w = world({ pinNotInInitrd: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /name pin isn't in every initramfs/);
  ok(!w.commands.includes("reboot"));
});

test("the pin is checked again after Proxmox installs its own kernel, right before the reboot", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const c = w.commands;
  ok(c.indexOf("boot safety check") < c.indexOf("start Proxmox install"));
  ok(c.lastIndexOf("boot safety check") > c.indexOf("install status"));
  ok(c.lastIndexOf("boot safety check") < c.indexOf("reboot"));
});

test("IPv6 comes after SSH is back and before the host setup; a failure there stops the install", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const c = w.commands;
  ok(c.indexOf("after reboot") < c.indexOf("ipv6"));
  ok(c.indexOf("ipv6") < c.indexOf("proxmox-host-setup.sh"));
  const bad = world({ ipv6Fails: true });
  const r = await executeInstall(bad.deps, opts(), settings);
  assert.match((r as { error: string }).error, /can't reach the internet over IPv6/);
});

// ── Diagnostics on every failure ──────────────────────────────────────

test("a failure on a reachable server saves diagnostics before the server is deleted", async () => {
  const w = world({ failLabel: "proxmox-host-setup.sh" });
  await executeInstall(w.deps, opts(), settings);
  assert.equal(servers(w).size, 0);
  assert.deepEqual(w.saved.map((d) => d.suffix), ["-host-setup"]);
  ok(w.commands.indexOf("saved diagnostics-host-setup") >= 0);
  ok(w.commands.indexOf("node diagnostics") < w.commands.indexOf("saved diagnostics-host-setup"));
});

test("a server that can't be reached says so rather than staying silent", async () => {
  const w = world({ renameNic: true, rescueNeverAnswers: true });
  await executeInstall(w.deps, opts({ noPin: true, noGuard: true, keepOnFailure: true }), settings);
  assert.match(w.alerts.at(-1)!.detail, /no diagnostics: the server can't be reached/);
});

// ── The install key ───────────────────────────────────────────────────

const installEntries = (w: World) => [...w.hz.state.sshKeys.values()].filter((k) => k.name === "sowsi-install");
const seedHosting = (w: World) => void w.hz.state.sshKeys.set(1, { id: 1, name: "sowsi-hosting", fingerprint: "aa", public_key: ADMIN_KEY, labels: {} } as never);

test("the install key entry goes in every path, and sowsi-hosting is never touched", async () => {
  const paths: [string, WorldCfg, Partial<InstallOptions>][] = [
    ["success", {}, {}],
    ["failure, server deleted", { failLabel: "hostname" }, {}],
    ["failure, server kept", { failLabel: "hostname" }, { keepOnFailure: true }],
    ["refused by Hetzner", { hetzner: { createError: { status: 422, code: "resource_unavailable", message: "x" } } }, {}],
    ["rescue repair", { renameNic: true }, { noPin: true, noGuard: true }],
    ["rescue fails", { renameNic: true, rescueNeverAnswers: true }, { noPin: true, noGuard: true, keepOnFailure: true }],
  ];
  for (const [name, cfg, o] of paths) {
    const w = world(cfg);
    seedHosting(w);
    await executeInstall(w.deps, opts(o), settings);
    assert.deepEqual(installEntries(w), [], name);
    ok(w.hz.state.sshKeys.has(1), `${name}: sowsi-hosting kept`);
    ok(hetznerRequests(w).filter((q) => q.path === "/ssh_keys" && q.method === "GET").length > 0, name);
  }
});

test("--destroy removes it and proves it by listing, even for a server long gone", async () => {
  const w = world();
  seedHosting(w);
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const id = String([...servers(w).keys()][0]);
  await executeDestroy(w.deps, id, "sivakumar", settings);

  // The real leftover: destroyed, but the entry stayed behind.
  w.hz.state.sshKeys.set(131973547, { id: 131973547, name: "sowsi-install", fingerprint: "bb", public_key: INSTALL_KEY, labels: {} } as never);
  const again = await executeDestroy(w.deps, id, "sivakumar", settings);
  assert.equal(again.ok, true, again.lines.join());
  assert.deepEqual(installEntries(w), []);
  ok(w.hz.state.sshKeys.has(1));
  assert.match(again.lines.join(), /no installer key entry left/);
});

test("an entry that can't be removed is reported, and --destroy doesn't claim success", async () => {
  const w = world({ hetzner: { sshKeyDeleteFails: true } });
  await executeInstall(w.deps, opts(), settings);
  assert.match(w.alerts.at(-1)!.detail, /install key entry still at Hetzner/);
  const d = world();
  await executeInstall(d.deps, opts(), settings);
  const id = String([...servers(d).keys()][0]);
  d.hz.cfg.sshKeyDeleteFails = true;
  d.hz.state.sshKeys.set(9, { id: 9, name: "sowsi-install", fingerprint: "cc", public_key: INSTALL_KEY, labels: {} } as never);
  const r = await executeDestroy(d.deps, id, "sivakumar", settings);
  assert.equal(r.ok, false);
  assert.match(r.lines.join(), /still at Hetzner/);
});

// ── Cost accounting ───────────────────────────────────────────────────

const MONTHLY = Math.ceil(23.49 * 100 * 100);
const HOURLY = Math.ceil((0.0368 + 0.0008) * 100 * 100);
const spend = (w: World) => w.logs.filter((l) => ["SERVER_PURCHASED", "SERVER_COST_SETTLED"].includes(l.action)).reduce((sum, l) => sum + (l.cost ?? 0), 0);

test("a node that stays registered counts its full monthly price", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  assert.equal(spend(w), MONTHLY);
  ok(!w.logs.some((l) => l.action === "SERVER_COST_SETTLED"));
});

test("a destroyed throwaway counts the started hours it lived, not the month: 73 minutes is 2 hours", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const started = w.installs.get(NAME)!.purchasedAt!.getTime();
  w.clock = started + 73 * 60_000;
  const r = await executeDestroy(w.deps, String([...servers(w).keys()][0]), "sivakumar", settings);
  assert.equal(r.ok, true);
  assert.equal(spend(w), 2 * HOURLY);
  assert.equal(w.installs.get(NAME)!.costSettledPaise, 2 * HOURLY);
  assert.match(r.lines.join(), /spend corrected/);

  await executeDestroy(w.deps, String(w.installs.get(NAME)!.hetznerServerId), "sivakumar", settings);
  assert.equal(w.logs.filter((l) => l.action === "SERVER_COST_SETTLED").length, 1, "only once");
});

test("a failed install whose server was deleted is settled too; a kept one isn't", async () => {
  const gone = world({ failLabel: "hostname" });
  await executeInstall(gone.deps, opts(), settings);
  assert.equal(spend(gone), HOURLY, "one started hour");
  const kept = world({ failLabel: "hostname" });
  await executeInstall(kept.deps, opts({ keepOnFailure: true }), settings);
  assert.equal(spend(kept), MONTHLY);
});

test("a server that lives long enough can't cost more than the month", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  w.clock = w.installs.get(NAME)!.purchasedAt!.getTime() + 2000 * 3_600_000;
  await executeDestroy(w.deps, String([...servers(w).keys()][0]), "sivakumar", settings);
  assert.equal(spend(w), MONTHLY);
});

test("a server already gone is settled from when its record last changed", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const rec = w.installs.get(NAME)!;
  servers(w).clear();
  Object.assign(rec, { status: "DESTROYED", purchasedAt: null, createdAt: new Date(1_000_000), updatedAt: new Date(1_000_000 + 73 * 60_000) });
  w.nodes.length = 0;
  await executeDestroy(w.deps, String(rec.hetznerServerId), "sivakumar", settings);
  assert.equal(spend(w), 2 * HOURLY);
});

test("the plan shows both numbers", async () => {
  const w = world();
  const p = await planInstall(w.deps, opts(), settings);
  assert.match(p.cost!.lines.join(), /against the spend cap: ₹2,349 if it stays as a node; if it's destroyed, only ₹3\.76 per started hour/);
});

// ── A name that was used before ───────────────────────────────────────

test("the plan for a destroyed name says so, says a new server will be bought, and shows the cost", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const old = String([...servers(w).keys()][0]);
  await executeDestroy(w.deps, old, "sivakumar", settings);

  const p = await planInstall(w.deps, opts(), settings);
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.resumeFrom, "server");
  assert.match(p.notes!.join(), new RegExp(`this name was destroyed \\(server ${old}\\); a new server will be bought`));
  assert.match(p.cost!.lines.join(), /₹2,349\/month/);
  assert.equal(w.installs.get(NAME)!.hetznerServerId, old, "the plan changes nothing");
});

test("re-installing a destroyed name never reuses the row: the old record stays whole, and --destroy still finds it", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  const old = String([...servers(w).keys()][0]);
  w.clock += 73 * 60_000;
  await executeDestroy(w.deps, old, "sivakumar", settings);
  const before = { ...w.installs.get(NAME)! };

  const shown: string[] = [];
  w.deps.report = (l) => void shown.push(l);
  // A brand-new server this time.
  Object.assign(w, { authorized: [INSTALL_KEY, ADMIN_KEY], pveInstall: "none", kernel: "6.1.0-26-cloud-amd64", staged: "", installed: "original", rebootAt: null, booted: "boot-1", pinName: null, guardInstalled: false });
  w.nodes.length = 0;
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);

  const archived = w.installs.get(`${NAME}#${old}`)!;
  assert.equal(archived.id, before.id);
  assert.equal(archived.status, "DESTROYED");
  assert.equal(archived.hetznerServerId, old);
  assert.equal(archived.costSettledPaise, before.costSettledPaise);
  assert.deepEqual(archived.completedSteps, before.completedSteps);

  const current = w.installs.get(NAME)!;
  assert.notEqual(current.id, before.id, "a new row");
  assert.notEqual(current.hetznerServerId, old);
  assert.equal(current.status, "REGISTERED");
  assert.equal(w.logs.filter((l) => l.action === "SERVER_PURCHASED").length, 2, "and a second purchase, on the record");
  ok(w.logs.some((l) => l.action === "NODE_INSTALL_ARCHIVED"), "archived");
  assert.match(shown.join(), new RegExp(`kept as ${NAME}#${old}; this is a new install`));
  assert.equal((await w.deps.db.findInstallByServer(old))!.status, "DESTROYED");
});

test("a failed name is kept the same way, and an old unsettled record is corrected when it's archived", async () => {
  const w = world({ failLabel: "hostname" });
  await executeInstall(w.deps, opts(), settings);
  const old = w.installs.get(NAME)!;
  Object.assign(old, { costSettledPaise: null, purchasedAt: null, createdAt: new Date(0), updatedAt: new Date(73 * 60_000), status: "DESTROYED" });
  w.logs.length = 0;
  w.logs.push({ action: "SERVER_PURCHASED", cost: MONTHLY });

  const next = resumeWorld(w);
  const p = await planInstall(next.deps, opts(), settings);
  assert.match(p.notes!.join(), /this name was destroyed/);
  await executeInstall(next.deps, opts(), settings);
  assert.equal(next.logs.filter((l) => l.action === "SERVER_COST_SETTLED").at(0)!.cost, 2 * HOURLY - MONTHLY, "₹2,359 becomes the hours it lived");

  const f = world({ failLabel: "hostname" });
  await executeInstall(f.deps, opts(), settings);
  assert.match((await planInstall(f.deps, opts(), settings)).notes!.join(), /this name failed last time.*a new server will be bought/);
});

// ── Stopped at 3e+ ────────────────────────────────────────────────────

test("a failure at 3e+ keeps the message and shows the network state", async () => {
  const w = world({ ipv6Fails: true });
  const r = await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /the host can't reach the internet over IPv6[\s\S]*--- ip -6 addr[\s\S]*--- ip -6 neigh/);
});

test("a re-run on the server that stopped at 3e+ resumes there, buys nothing, and says so first", async () => {
  const w = world({ ipv6Fails: true });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const done = w.installs.get(NAME)!.completedSteps;
  assert.deepEqual(done, STEPS.slice(0, STEPS.indexOf("ipv6")), "everything up to 3e");

  const before = w.commands.length;
  const resumed = resumeWorld(w);
  const plan = await planInstall(resumed.deps, opts(), settings);
  assert.equal(plan.ok, true, plan.problems.join());
  assert.equal(plan.resumeFrom, "ipv6");
  const lines = resumeSummary(plan.install!).join("\n");
  assert.match(lines, /Resuming sowsi-proxmox-02 on Hetzner server \d+ \(203\.0\.113\.20\): no new server is bought/);
  assert.match(lines, /next: 3e\+ add IPv6/);

  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.equal(resumed.commands[before], "ipv6");
  ok(!resumed.commands.slice(before).includes("reboot"), "no second reboot");
  assert.equal(requested(resumed, "/servers").length, 1, "one server, ever");
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, 1);
});

// ── DNS ───────────────────────────────────────────────────────────────

test("DNS is made permanent before Proxmox installs, checked before the reboot, and again right after it", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  const c = w.commands;
  ok(c.indexOf("dns write") < c.indexOf("start Proxmox install"), "written first");
  const checks = c.flatMap((x, i) => (x === "dns check" ? [i] : []));
  assert.equal(checks.length, 3);
  ok(checks[1] > c.indexOf("install status") && checks[1] < c.indexOf("reboot"), "before the reboot");
  ok(checks[2] > c.indexOf("after reboot") && checks[2] < c.indexOf("ipv6"), "right after 3e, before anything needs it");
  assert.equal(c.filter((x) => x === "dns write").length, 1, "it survived, so it isn't rewritten");
  ok(!w.logs.some((l) => l.action === "NODE_DNS_REPAIRED"), "nothing to repair");
  assert.match(JSON.stringify(w.logs.find((l) => (l.after as { step?: string })?.step === "dns")), /survived the reboot/);
});

test("names that don't resolve stop the install at the first step that needs them, before any reboot", async () => {
  const w = world({ dnsNeverResolves: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /names don't resolve/);
  ok(!w.commands.includes("start Proxmox install"), "not even the install");
  ok(!w.commands.includes("reboot"), "no reboot");
});

test("if the Proxmox install undoes DNS, the check right before the reboot stops it", async () => {
  const w = world({ resolvLostInInstall: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /pre-reboot check \(not rebooted\): .*is a link/);
  ok(!w.commands.includes("reboot"), "no reboot");
});

test("the real server: stopped after 3e with the image's link in place, it's repaired on resume and carries on", async () => {
  const w = world({ ipv6Fails: true });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const rec = w.installs.get(NAME)!;
  // It was installed before this step existed: no static file, and 3e already done.
  rec.completedSteps = STEPS.slice(0, STEPS.indexOf("dns"));
  w.resolvStatic = false;

  const before = w.commands.length;
  const resumed = resumeWorld(w);
  const plan = await planInstall(resumed.deps, opts(), settings);
  assert.equal(plan.resumeFrom, "dns");
  assert.match(resumeSummary(plan.install!).join("\n"), /no new server is bought[\s\S]*next: 3e\+ check DNS survived the reboot/);

  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.deepEqual(resumed.commands.slice(before, before + 4), ["dns check", "dns write", "dns check", "ipv6"]);
  assert.equal(resumed.logs.filter((l) => l.action === "SERVER_PURCHASED").length, 1);
  assert.equal(requested(resumed, "/servers").length, 1);
  ok(resumed.logs.some((l) => l.action === "NODE_DNS_REPAIRED"), "on the record");
});

test("DNS lost across the reboot is repaired once and logged; if that doesn't help, the step fails", async () => {
  const w = world({ resolvLostOnReboot: true });
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  const repaired = w.logs.find((l) => l.action === "NODE_DNS_REPAIRED")!;
  ok(repaired.success !== false, "the repair worked, so it's logged as a success");
  assert.equal(repaired.error, undefined);
  assert.match(JSON.stringify(repaired.after), /is a link/);

  const dead = world({ dnsNeverResolves: false, resolvLostOnReboot: true });
  const write = dead.deps.ssh;
  dead.deps.ssh = async (...a) => {
    const c = await write(...a);
    const exec = c.shell.exec;
    c.shell.exec = async (label, cmd, o) => (label === "dns write" && dead.kernel.endsWith("-pve") ? "" : exec(label, cmd, o));
    return c;
  };
  const r = await executeInstall(dead.deps, opts(), settings);
  assert.match((r as { error: string }).error, /dns: .*is a link/);
  ok(!dead.logs.some((l) => l.action === "NODE_DNS_REPAIRED"), "a repair that failed isn't logged as a repair");
});

test("3j lists every key by fingerprint and never prints a key", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  const c = w.commands;
  const text = JSON.stringify(w.logs.find((l) => (l.after as { step?: string })?.step === "keys"));
  for (const [role, key] of [["admin", ADMIN_KEY], ["provisioning", PROV_KEY], ["Proxmox's own key for this node", NODE_KEY]]) {
    ok(text.includes(role) && text.includes(S.keyFingerprint(key)), role);
    ok(!text.includes(key.split(" ")[1]), `${role}: no key body`);
  }
  ok(!text.includes(S.keyFingerprint(INSTALL_KEY)), "the install key is gone by then");
  ok(c.includes("remove install key"));
  ok(STEPS.indexOf("keys") === STEPS.indexOf("lockdown") + 1 && STEPS.indexOf("keys") < STEPS.indexOf("verify"), "right after the lockdown");
});

test("an unknown key stops the install before the install key is removed, and shows its fingerprint", async () => {
  const w = world({ strangerKey: true });
  const r = await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const error = (r as { error: string }).error;
  assert.match(error, /lockdown: .*key not allowed: 256 SHA256:/);
  assert.match(error, /install key kept/);
  ok(!error.includes(STRANGER_KEY.split(" ")[1]), "the fingerprint, not the key");
  ok(!w.commands.includes("remove install key"), "the installer can still log in");
  ok(w.authorized.includes(INSTALL_KEY));
});

test("a key that appears after the lockdown fails 3j, and so does the install key if it's still there", async () => {
  const w = world();
  const audit = w.deps.authorizedKeys;
  w.deps.authorizedKeys = async (host) => {
    const out = await audit(host);
    return w.authorized.includes(INSTALL_KEY) ? out : out.replace("lines=3", "lines=4").replace("\nnode_key", `\nkey=4096 ${S.keyFingerprint(STRANGER_KEY)} who@where (RSA)\nnode_key`);
  };
  const r = await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /failed at step 3j[\s\S]*key not allowed: 4096 SHA256:/);

  const again = world();
  const stale = again.deps.authorizedKeys;
  again.deps.authorizedKeys = async (host) => {
    const out = await stale(host);
    return again.authorized.includes(INSTALL_KEY) ? out : out.replace("lines=3", "lines=4").replace("\nnode_key", `\nkey=256 ${S.keyFingerprint(INSTALL_KEY)} (ED25519)\nnode_key`);
  };
  const stayed = await executeInstall(again.deps, opts({ keepOnFailure: true }), settings);
  assert.match((stayed as { error: string }).error, /key not allowed/);
});

test("the RSA key is only allowed if the node can prove it's its own, and every line must be readable", async () => {
  const unproven = await executeInstall(world({ nodeKeyMissing: true }).deps, opts({ keepOnFailure: true }), settings);
  assert.match((unproven as { error: string }).error, /key not allowed/);
  const unreadable = await executeInstall(world({ unreadableKeyLine: true }).deps, opts({ keepOnFailure: true }), settings);
  assert.match((unreadable as { error: string }).error, /authorized_keys has \d+ lines, but \d+ readable keys/);
});

test("a run that stopped after the lockdown still gets 3j on resume", async () => {
  const w = world({ ipv6Fails: false });
  await executeInstall(w.deps, opts(), settings);
  const rec = w.installs.get(NAME)!;
  rec.completedSteps = rec.completedSteps.filter((s) => s !== "keys" && s !== "verify" && s !== "register");
  rec.status = "IN_PROGRESS";
  w.nodes.length = 0;
  rec.apiTokenSecret = w.deps.encrypt(SECRET);
  const before = w.logs.length;
  const r = await executeInstall(resumeWorld(w).deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  ok(w.logs.slice(before).some((l) => (l.after as { step?: string })?.step === "keys"), "the audit ran");
});

test("IPv6 still doesn't depend on DNS, which is recorded on its own", async () => {
  const w = world();
  await executeInstall(w.deps, opts(), settings);
  assert.doesNotMatch(JSON.stringify(w.logs.find((l) => (l.after as { step?: string })?.step === "ipv6")), /DNS doesn't work/);
});
