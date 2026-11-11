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
  serverCost,
  type Cost,
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
  mgmtPrivateIp: "10.0.0.7",
  protectedServerId: "168392011",
  usdToInr: 100,
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
    /** This rule stops nothing. */
    isolationHole?: string;
    /** The test container got through on this attempt. */
    gotThrough?: string;
    /** The rules stop applying once the container has restarted. */
    rulesLostOnRestart?: boolean;
    /** isolation-probe off fails. */
    probeStuck?: boolean;
    /** After the restart the container never gets its IPv4 address or default route back. */
    restartNeverReady?: boolean;
    /** After the restart the gateway never answers ARP. */
    gatewayNeverLearned?: boolean;
    /** ip addr add for the spoofed address fails (while something else makes the counter rise). */
    spoofAddFails?: boolean;
    /** After the restart the ARP rule stops applying, while the IPv4 rule still does. */
    arpRuleLostOnRestart?: boolean;
    /** isolation-report fails. */
    reportFails?: boolean;
    /** The NAT rule counts nothing (traffic from the shared range isn't translated). */
    natCountsNothing?: boolean;
    /** The shared-mode container's answer, field by field. */
    shared?: Record<string, string>;
    /** `sowsi-gateway status`, field by field over a working gateway. */
    gatewayStatus?: Record<string, string>;
    /** The gateway, as curl sees it from sowsi-mgmt-01, gets this wrong. */
    gatewayFault?: "xff_passes" | "swapped" | "unknown_served" | "tls_answers" | "no_sni_answers" | "route_stays" | "not_counted";
    /** A test container's web server never listens. */
    backendDown?: boolean;
    /** sowsi-routes doesn't take container 9000 as the gateway. */
    routesIgnoreGateway?: boolean;
    /** sowsi-gateway refuses every table. */
    syncRefused?: boolean;
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
    isolationReads: 0,
    restarted: false,
    /** Connections the NAT rule has counted. */
    natOut: 0,
    /** The restarted container knows the gateway's MAC. Until it does, a spoofed packet's ARP is what's sent. */
    gatewayKnown: false,
    /** Packets each rule stopped after the restart. */
    afterRestart: { spoof_ip4: 0, spoof_arp: 0 },
    probes: [] as boolean[],
    proofScript: "",
    created: [] as { vmid: number; ipv4?: string; ipv6?: string }[],
    /** The node's gateway: installed, the applied version and table, and every sync it was sent. */
    gw: { installed: false, version: null as number | null, table: "", syncs: [] as { version: number; table: string }[], counted: 0 },
    curls: [] as string[][],
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

  const evidence = () =>
    `addr<<\nlo UNKNOWN 127.0.0.1/8\neth0@if7 UP ${S.TEST_IPV4.second}/32\n>>addr\nroute<<\ndefault via 172.31.1.1 dev eth0 onlink\n>>route\nneigh<<\n${w.gatewayKnown ? "172.31.1.1 lladdr fe:ff:ff:ff:ff:ff REACHABLE" : "172.31.1.1 INCOMPLETE"}\n>>neigh`;

  // ── The gateway, simulated: container 9000, HAProxy's table, and what curl sees from outside ──
  const gatewayCt = () => w.containers.find((c) => c.vmid === 9000 && c.name === "sowsi-gateway") as { vmid: number; name: string; ipv4?: string } | undefined;
  const routesNow = () => {
    const withV4 = w.containers.filter((c) => (c.name === S.TEST_CONTAINER_HOSTNAME || c.name === "sowsi-gateway") && (c as { ipv4?: string }).ipv4).length;
    const withV6 = w.containers.filter((c) => c.name === S.TEST_CONTAINER_HOSTNAME).length;
    const gw = gatewayCt();
    return `routes: ${withV4} IPv4, ${withV6} IPv6\nisolation: ${w.containers.length} containers${gw && !cfg.routesIgnoreGateway ? `, gateway ${gw.ipv4}` : ""}`;
  };
  const gatewayStatusText = () => {
    const gw = gatewayCt();
    const lines = w.gw.table.split("\n").filter(Boolean).length;
    const f: Record<string, string> = gw
      ? { container: "running", ipv4: gw.ipv4 ?? "", route: "1", version: w.gw.version === null ? "" : String(w.gw.version), routes: String(lines), haproxy: w.gw.installed ? "active" : "inactive", haproxy_enabled: w.gw.installed ? "enabled" : "disabled", config: w.gw.installed ? S.GATEWAY_CONFIG : "", live_version: w.gw.version === null ? "" : String(w.gw.version), unknown_host: w.gw.installed ? "404" : "", ssh: "inactive", logins: "0", public_ports: w.gw.installed ? "80,443" : "22", memory_mb: "61" }
      : { container: "missing", ipv4: "", route: "0", version: "", routes: "0" };
    return Object.entries({ ...f, ...(gw ? cfg.gatewayStatus : {}) }).map(([k, v]) => `${k}=${v}`).join("\n");
  };
  const fakeCurl = (args: string[]): S.CurlResult => {
    w.curls.push(args);
    const url = new URL(args[args.length - 1]);
    const resolve = args[args.indexOf("--resolve") + 1];
    const ip = args.includes("--resolve") ? resolve.split(":")[2] : url.hostname;
    const tls = url.protocol === "https:";
    const gw = gatewayCt();
    if (!gw || ip !== gw.ipv4 || !w.gw.installed) return { exit: 7, stdout: "\ncode=000" };
    const sni = args.includes("--resolve") ? url.hostname : null;
    const routes = Object.fromEntries(w.gw.table.split("\n").filter(Boolean).map((l) => l.split(" ")).map(([h, , v4]) => [h, v4]));
    let backend = sni ? routes[sni] : undefined;
    if (cfg.gatewayFault === "route_stays" && !backend && sni === S.GATEWAY_TEST_NAMES.one && w.gw.syncs.length > 1) backend = S.TEST_IPV4.second;
    if (cfg.gatewayFault === "swapped" && backend) backend = backend === S.TEST_IPV4.second ? S.TEST_IPV4.third : S.TEST_IPV4.second;
    if (!backend) {
      if (cfg.gatewayFault === "unknown_served" && !tls) return { exit: 0, stdout: `backend-101 xff=${settings.mgmtIp}\ncode=200` };
      if (tls && (cfg.gatewayFault === "tls_answers" ? sni !== null : cfg.gatewayFault === "no_sni_answers" ? sni === null : false)) return { exit: 0, stdout: "hello\ncode=200" };
      return tls ? { exit: 35, stdout: "\ncode=000" } : { exit: 0, stdout: "Not found\ncode=404" };
    }
    const ct = w.containers.find((c) => (c as { ipv4?: string }).ipv4 === backend);
    if (!ct) return tls ? { exit: 35, stdout: "\ncode=000" } : { exit: 0, stdout: "\ncode=503" };
    if (cfg.gatewayFault !== "not_counted") w.gw.counted++;
    const xff = tls ? "-" : cfg.gatewayFault === "xff_passes" ? `${S.SPOOFED_CLIENT},${settings.mgmtIp}` : settings.mgmtIp;
    return { exit: 0, stdout: `backend-${ct.vmid} xff=${xff}\ncode=200` };
  };

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
        case "host checks": return "out4=ok\nout6=ok\ntemplate=1\nroutes_service=enabled\ndispatcher=yes\ngateway_tool=yes\ngateway_commands=2\nvmbr1=<NO-CARRIER,BROADCAST,MULTICAST,UP>\nstorage=iso,vztmpl,backup,rootdir,images\nforward4=1\nforward6=1\nforward_saved=2\nproxy_ndp=1\nproxy_arp=1\nproxy_saved=2\niso_tables=2\niso_ports=2\niso_between=1\niso_forward=7\niso_nat=1\niso_mgmt=1\niso_timer=enabled\niso_before_guests=1\niso_last_good=ok\niso_redirects=0\niso_accept_ra=0\nnftables_service=masked\npve_nft_tables=0";
        case "API token": w.tokenMade = true; return JSON.stringify({ "full-tokenid": "root@pam!sowsi", info: { privsep: "0" }, value: SECRET });
        case "add provisioning key": w.authorized.push(`restrict,command="/usr/local/sbin/sowsi-host" ${PROV_KEY}`); return "1";
        case "remove install key": w.authorized = w.authorized.filter((k) => k !== INSTALL_KEY); return `install_lines=0\nadmin_lines=${w.authorized.includes(ADMIN_KEY) ? 1 : 0}`;
        case "outbound": return `out6=${cfg.outbound6 ?? "ok"}\nout4=${o?.stdin ? "ok" : "ok"}`;
        case "isolation proof":
          w.proofScript = command;
          return `neighbour_v6=${cfg.gotThrough === "neighbour_v6" ? "yes" : "no"}\nmail_25_v4=${cfg.gotThrough === "mail_25_v4" ? "yes" : "no"}\nprivate_mgmt=no`;
        case "isolation mac": return "mac_restored=yes";
        case "restart ready": {
          ok(command.includes(`-I '${S.TEST_IPV4.second}'`), "the gateway is pinged from the real address");
          const ready = !cfg.restartNeverReady;
          w.gatewayKnown = ready && !cfg.gatewayNeverLearned;
          return `ipv4_ready=${ready ? "yes" : "no"}\ngateway_ping=no-reply\ngateway_learned=${w.gatewayKnown ? "yes" : "no"}\n${evidence()}`;
        }
        case "restart spoof": {
          const lost = cfg.rulesLostOnRestart;
          // H1: with the gateway unknown, the spoofed ARP request goes first, and spoof_arp stops it.
          if (!lost || cfg.spoofAddFails) w.afterRestart[w.gatewayKnown || cfg.spoofAddFails ? "spoof_ip4" : "spoof_arp"]++;
          return `add_exit=${cfg.spoofAddFails ? 2 : 0}\ndel_exit=0\n${evidence()}`;
        }
        case "restart arp spoof":
          w.gatewayKnown = false;
          if (!cfg.rulesLostOnRestart && !cfg.arpRuleLostOnRestart) w.afterRestart.spoof_arp++;
          return `flush_exit=0\nadd_exit=0\ndel_exit=0\n${evidence()}`;
        case "shared outbound": {
          w.natOut += cfg.natCountsNothing ? 0 : 1;
          const facts = { address: `${S.TEST_IPV4.second}/32`, out4: "ok", dns: "ok", ...cfg.shared };
          return Object.entries(facts).map(([k, v]) => `${k}=${v}`).join("\n");
        }
        case "container diagnostics": return `--- ip -br addr\neth0 UP ${S.TEST_IPV4.second}/32\n--- ip neigh\n172.31.1.1 dev eth0 INCOMPLETE`;
        case "routes": return routesNow();
        case "gateway install":
          if (!gatewayCt()) throw new Error("gateway install failed (exit 1):\ngateway: container 9000 isn't the gateway");
          w.gw.installed = true;
          if (w.gw.version === null) w.gw.version = 0;
          return `gateway: version ${w.gw.version}, 0 routes`;
        case "gateway status": return gatewayStatusText();
        case "gateway backend": return `tools=present\nlistening=${cfg.backendDown ? 0 : 2}`;
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
      return routesNow();
    },
    gatewayStatus: async () => {
      if (!w.authorized.some((k) => k.includes(PROV_KEY))) throw new Error("All configured authentication methods failed");
      return gatewayStatusText();
    },
    gatewaySync: async (_host, version, table) => {
      if (!w.authorized.some((k) => k.includes(PROV_KEY))) throw new Error("All configured authentication methods failed");
      w.commands.push(`gateway sync ${version}`);
      if (cfg.syncRefused) throw new Error(`gateway-sync ${version} failed (exit 2):\nrefused: line 1: no container on this node has ${S.TEST_IPV4.second}`);
      if (w.gw.version !== null && version <= w.gw.version) throw new Error(`gateway-sync ${version} failed (exit 2):\nrefused: version ${version} is older than the applied version ${w.gw.version}`);
      w.gw.syncs.push({ version, table });
      w.gw.version = version;
      w.gw.table = table;
      return `gateway: version ${version}, ${table.split("\n").filter(Boolean).length} routes`;
    },
    curl: async (args) => fakeCurl(args),
    authorizedKeys: async () => {
      // Proxmox adds the node's own key itself; a planted key sits next to the others.
      const lines = [...w.authorized, NODE_KEY, ...(cfg.strangerKey ? [STRANGER_KEY] : [])];
      const rows = lines.map((l) => `key=256 ${S.keyFingerprint(/ssh-\S+ \S+/.exec(l)![0])} (ED25519)`);
      return [`lines=${lines.length + (cfg.unreadableKeyLine ? 1 : 0)}`, ...rows, `node_key=${cfg.nodeKeyMissing ? "" : S.keyFingerprint(NODE_KEY)}`].join("\n");
    },
    isolationStatus: async () => {
      w.isolationReads++;
      const names = ["to_neighbour_l2", "to_neighbour_l3", "to_host", "to_other_iface", "to_private", "to_mail", "to_metadata", "spoof_ip4", "spoof_ip6", "spoof_mac", "spoof_arp"];
      const frozen = cfg.rulesLostOnRestart && w.restarted;
      // After the restart the two spoof counters count only what was actually stopped.
      const value = (n: string) =>
        w.restarted && (n === "spoof_ip4" || n === "spoof_arp") ? 1000 + w.afterRestart[n] : n === cfg.isolationHole || frozen ? 1 : w.isolationReads;
      return ["tables=2", ...names.map((n) => `${n}=${value(n)}`), `nat_out=${w.natOut}`, `gateway_in=${w.gw.counted}`].join("\n");
    },
    isolationReport: async () => {
      w.commands.push("isolation report");
      if (cfg.reportFails) throw new Error("connection reset");
      return "=== counters\ntables=2\nspoof_ip4=1000\n=== bridge table\ntable bridge sowsi {}";
    },
    isolationProbe: async (_host, on) => {
      w.probes.push(on);
      if (!on && cfg.probeStuck) throw new Error("ip link del failed");
    },
    hostSetupScript: () => "#!/usr/bin/env bash\n# sowsi-routes …",
    proxmox: () => ({
      getVersion: async () => ({ version: "8.3.0" }),
      getNodeStatus: async () => ({ memory: { total: 7_940 * 1024 * 1024 }, cpus: 4 }),
      getStorageStatus: async () => ({ total: 150 * 1024 ** 3 }),
      getNextVMID: async () => {
        let id = 100;
        while (w.containers.some((c) => c.vmid === id)) id++;
        return id;
      },
      listLXC: async () => w.containers.map((c) => ({ ...c, status: "running" })),
      createLXC: async (i) => {
        w.created.push({ vmid: i.vmid, ipv4: i.ipv4, ipv6: i.ipv6 });
        // A new test container: nothing has restarted yet.
        w.restarted = false;
        w.afterRestart = { spoof_ip4: 0, spoof_arp: 0 };
        w.containers.push({ vmid: i.vmid, name: i.hostname, ...(i.ipv4 ? { ipv4: i.ipv4 } : {}) });
      },
      waitForLXC: async () => {},
      restartLXC: async () => {
        w.restarted = true;
        w.gatewayKnown = false;
      },
      destroyContainer: async (vmid) => {
        w.containers = w.containers.filter((c) => c.vmid !== vmid);
        return { leftover: [], errors: [] };
      },
    }),
    db: {
      findInstall: async (name) => w.installs.get(name) ?? null,
      findInstallByServer: async (id) => [...w.installs.values()].find((r) => r.hetznerServerId === id) ?? null,
      async createInstall(d) {
        const r: InstallRecord = { id: `ni_${w.installs.size + 1}`, status: "IN_PROGRESS", completedSteps: [], error: null, hetznerServerId: null, ipv4: null, ipv6Subnet: null, hostKeySha256: null, bootIdBeforeReboot: null, repairedAt: null, purchasedAt: null, costSettledPaise: null, createdAt: new Date(w.clock), updatedAt: new Date(w.clock), apiTokenSecret: null, testFloatingIpId: null, gatewayFloatingIpId: null, gatewayIpv4: null, gatewayPurchasedAt: null, gatewayMonthlyPaise: null, ...d };
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
        return n ? { id: n.id, name: n.name, ip: n.ip, services: n.services, volumes: n.volumes, apiTokenId: n.apiTokenId, apiTokenSecret: n.apiTokenSecret, gatewayFloatingIpId: n.gatewayFloatingIpId } : null;
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
/** Containers other than the gateway (9000), which stays with the node. */
const testContainers = (w: World) => w.containers.filter((c) => c.vmid !== 9000);
const gatewayIps = (w: World) => [...w.hz.state.floatingIps.values()].filter((f) => (f.labels as Record<string, string>)[INSTALL_LABEL] === "gateway");

// ── Plan and spend ────────────────────────────────────────────────────

test("plan: monthly and hourly cost from the live prices, nothing bought", async () => {
  const w = world();
  const p = await planInstall(w.deps, opts(), settings);
  assert.equal(p.ok, true, p.problems.join());
  assert.equal(p.cost!.monthlyPaise, Math.ceil((22.99 + 0.5) * 100 * 100));
  assert.equal(p.cost!.hourlyPaise, Math.ceil((0.0368 + 0.0008) * 100 * 100));
  assert.match(p.cost!.lines.join("\n"), /\$22\.99\/month, \$0\.0368\/hour[\s\S]*₹2,349\/month, ₹3\.76\/hour \(at ₹100\/\$, HETZNER_USD_TO_INR\)/);
  assert.doesNotMatch(p.cost!.lines.join("\n"), /€|EUR/);
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
  assert.deepEqual(testContainers(w), [], "test containers deleted");
  assert.deepEqual(w.containers, [{ vmid: 9000, name: "sowsi-gateway", ipv4: "198.51.100.7" }], "the gateway stays, on its Floating IP");
  assert.equal(node.gatewayIpv4, "198.51.100.7");
  assert.equal(node.gatewayFloatingIpId, String(gatewayIps(w)[0].id));
  assert.equal(node.gatewayVmId, 9000);
  assert.equal(node.gatewayRoutesVersion, BigInt(w.gw.version!), "the last table version the gateway applied");
  assert.equal(w.gw.table, "", "registered with an empty table");
  assert.match(w.alerts[0].subject, /New Proxmox node installed/);
});

test("--ipv4: the test container gets a Floating IP, which is released afterwards", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts({ ipv4Test: true }), settings)).ok, true);
  assert.equal(w.hz.state.floatingIps.size, 1, "only the gateway's is left");
  assert.equal(gatewayIps(w).length, 1);
  assert.equal(w.installs.get("sowsi-proxmox-02")!.testFloatingIpId, null);
  assert.equal(w.created[0].vmid, 9000, "the gateway first, on its own Floating IP");
  assert.notEqual(w.created[1].ipv4, S.TEST_IPV4.first);
  assert.notEqual(w.created[1].ipv4, w.created[0].ipv4, "the test container's Floating IP isn't the gateway's");
  assert.equal(w.created[2].ipv4, S.TEST_IPV4.second, "the neighbour doesn't need one");
});

// ── Proving the isolation rules ──────────────────────────────────────

test("verify proves isolation with two containers, without buying an IP, and leaves nothing behind", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  assert.equal(w.nodes.length, 1);
  assert.deepEqual(w.created.map((c) => c.vmid), [9000, 100, 101, 102]);
  assert.deepEqual(w.created.map((c) => c.ipv4), ["198.51.100.7", S.TEST_IPV4.first, S.TEST_IPV4.second, S.TEST_IPV4.third], "the gateway's Floating IP; then an unrouted address and two shared-mode ones, so no test Floating IP");
  assert.equal(S.TEST_IPV4.second, "100.127.255.11", "the neighbour is in shared mode, from the block reserved for tests");
  ok(w.commands.indexOf("shared outbound") > 0 && w.commands.indexOf("shared outbound") < w.commands.indexOf("isolation proof"), "NAT is proven before the isolation proof");
  assert.equal(w.natOut, 1);
  assert.equal(w.hz.state.floatingIps.size, 1, "the gateway's, and no other");
  assert.deepEqual(testContainers(w), []);
  assert.deepEqual(w.probes, [true, false], "the dummy interface comes and goes");
  ok(w.restarted, "the neighbour was restarted");
  assert.match(w.proofScript, /'10\.0\.0\.7' 22/, "it tries sowsi-mgmt-01's private address");
  assert.ok(w.proofScript.includes(`${S.TEST_IPV4.second}' 22`), "and the neighbour");
});

for (const hole of ["to_neighbour_l2", "to_neighbour_l3", "to_host", "to_other_iface", "to_private", "to_mail", "to_metadata", "spoof_ip4", "spoof_ip6", "spoof_mac"]) {
  test(`a node where ${hole} stops nothing never registers`, async () => {
    const w = world({ isolationHole: hole });
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, new RegExp(`rule ${hole} stopped nothing`));
    assert.equal(w.nodes.length, 0);
    assert.deepEqual(testContainers(w), []);
    assert.deepEqual(w.probes, [true, false], "the dummy interface is removed on failure too");
  });
}

test("shared mode: no NAT, no IPv4, no DNS or the wrong address fails step 4 and leaves nothing behind", async () => {
  for (const [cfg, why] of [
    [{ natCountsNothing: true }, /the NAT rule counted nothing \(nat_out 0 → 0\)/],
    [{ shared: { out4: "fail" } }, /the shared-mode container can't reach the internet over IPv4 \(NAT\)/],
    [{ shared: { dns: "fail" } }, /the shared-mode container can't resolve names/],
    [{ shared: { address: "198.18.254.11/32" } }, /the shared-mode container has 198\.18\.254\.11\/32, not 100\.127\.255\.11\/32/],
    [{ shared: { address: "" } }, /has no IPv4/],
  ] as const) {
    const w = world(cfg);
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, why);
    assert.equal(w.nodes.length, 0);
    assert.deepEqual(testContainers(w), []);
    ok(!w.commands.includes("isolation proof"), "stops before the isolation proof");
  }
});

test("a node without the NAT rule fails host setup", async () => {
  assert.match(S.checkHostSetup("== Done", { ...S.parseFacts("iso_nat=0") }).join(), /the NAT rule for shared-mode containers is missing/);
  assert.match(S.checkHostSetup("== Done", { iso_forward: "6" }).join(), /the forwarding rules are incomplete \(6 of 7\)/);
});

test("a container that gets through fails the install, even if every counter rose", async () => {
  const w = world({ gotThrough: "mail_25_v4" });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /got through: mail_25_v4/);
  assert.equal(w.nodes.length, 0);
});

test("rules that stop applying after a container restart fail the install, with every counter and the container's network", async () => {
  const w = world({ rulesLostOnRestart: true });
  const r = await executeInstall(w.deps, opts(), settings);
  const error = (r as { error: string }).error;
  assert.match(error, /after a restart, a spoofed IPv4 source wasn't stopped by spoof_ip4/);
  assert.match(error, /after a restart, an ARP request with a spoofed sender wasn't stopped by spoof_arp/);
  assert.match(error, /counters \(before → after the IPv4 spoof → after the ARP spoof\): spoof_ip4 1000 → 1000 → 1000, spoof_arp 1000 → 1000 → 1000, spoof_mac \d+ → \d+ → \d+, spoof_ip6 /);
  assert.match(error, /bad_frame 0 → 0 → 0, unknown_port 0 → 0 → 0/);
  assert.match(error, /ip addr: lo UNKNOWN 127\.0\.0\.1\/8 \| eth0@if7 UP 100\.127\.255\.11\/32/);
  assert.match(error, /ip route: default via 172\.31\.1\.1 dev eth0 onlink/);
  assert.match(error, /ip neigh: 172\.31\.1\.1 lladdr fe:ff:ff:ff:ff:ff REACHABLE; /, "the gateway was known when the IPv4 spoof went out");
  assert.match(error, /ip neigh after the ARP spoof: 172\.31\.1\.1 INCOMPLETE/);
  assert.equal(w.nodes.length, 0);
  assert.deepEqual(testContainers(w), []);
});

test("after a restart the gateway is learned from the real address before the spoof (the sowsi-test-02 failure)", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  const c = w.commands;
  ok(c.indexOf("restart ready") > 0 && c.indexOf("restart ready") < c.indexOf("restart spoof"), "ready, then the spoof");
  ok(c.indexOf("restart spoof") < c.indexOf("restart arp spoof"), "the ARP case on its own, after");
  assert.deepEqual(w.afterRestart, { spoof_ip4: 1, spoof_arp: 1 }, "each rule stopped its own packet");
});

test("a container that never gets its address back after a restart fails, and no spoof is tried", async () => {
  const w = world({ restartNeverReady: true });
  const error = ((await executeInstall(w.deps, opts(), settings)) as { error: string }).error;
  assert.match(error, /never got its IPv4 address and default route back/);
  assert.match(error, /ip neigh: 172\.31\.1\.1 INCOMPLETE/);
  ok(!w.commands.includes("restart spoof"));
  assert.equal(w.nodes.length, 0);
});

test("a gateway that's never learned after a restart fails, rather than counting the ARP drop as proof", async () => {
  const w = world({ gatewayNeverLearned: true });
  const error = ((await executeInstall(w.deps, opts(), settings)) as { error: string }).error;
  assert.match(error, /never learned the gateway from its own address/);
  ok(!w.commands.includes("restart spoof"));
});

test("an ip addr add that failed fails the restart check, even when spoof_ip4 rose", async () => {
  const w = world({ spoofAddFails: true });
  const error = ((await executeInstall(w.deps, opts(), settings)) as { error: string }).error;
  assert.match(error, /ip addr add for the spoofed address failed \(exit 2\)/);
  assert.equal(w.afterRestart.spoof_ip4, 1, "the counter did rise");
});

test("an ARP rule lost after a restart fails, even though the IPv4 rule still works", async () => {
  const w = world({ arpRuleLostOnRestart: true });
  const error = ((await executeInstall(w.deps, opts(), settings)) as { error: string }).error;
  assert.match(error, /an ARP request with a spoofed sender wasn't stopped by spoof_arp/);
  assert.doesNotMatch(error, /spoofed IPv4 source wasn't stopped/);
  assert.match(error, /spoof_arp 1000 → 1000 → 1000/);
});

// ── Diagnostics and --keep-on-failure at step 4 ──────────────────────

test("a step 4 failure saves what the test containers and isolation-report show, before cleanup", async () => {
  const w = world({ rulesLostOnRestart: true });
  const error = ((await executeInstall(w.deps, opts(), settings)) as { error: string }).error;
  assert.deepEqual(w.saved.map((d) => d.suffix), ["-verify"], "saved once, and not again by the generic node diagnostics");
  const text = w.saved[0].text;
  assert.match(text, /=== test container 100 \(2a01:4f8:1c1c:abcd:[0-9a-f:]+\)\n--- ip -br addr/);
  assert.match(text, /=== test container 101 \(2a01:4f8:1c1c:abcd:[0-9a-f:]+\)\n--- ip -br addr/);
  assert.match(text, /=== isolation-report on the node\n=== counters/);
  assert.match(error, /\(diagnostics: /);
  const c = w.commands;
  ok(c.indexOf("container diagnostics") > c.indexOf("restart arp spoof"), "after the failed check");
  ok(c.indexOf("isolation report") > 0 && c.indexOf("isolation report") < c.indexOf("saved diagnostics-verify"), "report read, then saved");
  assert.deepEqual(testContainers(w), [], "then cleaned up as before");
  assert.deepEqual(w.probes, [true, false]);
  assert.doesNotMatch(text, new RegExp(`${SECRET}|${PROV_KEY.split(" ")[1]}|${INSTALL_KEY.split(" ")[1]}`), "no secrets or keys");
  ok(!c.includes("node diagnostics"), "the install-key diagnostics isn't tried: that key is gone");
  assert.doesNotMatch(w.alerts[0].detail, /no diagnostics: the server can't be reached/);
});

test("--keep-on-failure keeps nothing when step 4 passes", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts({ ipv4Test: true, keepOnFailure: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.deepEqual(testContainers(w), []);
  assert.equal(w.hz.state.floatingIps.size, 1, "the gateway's only");
  assert.equal(w.installs.get("sowsi-proxmox-02")!.testFloatingIpId, null);
  assert.deepEqual(w.saved, []);
});

test("diagnostics are still saved when isolation-report fails", async () => {
  const w = world({ rulesLostOnRestart: true, reportFails: true });
  await executeInstall(w.deps, opts(), settings);
  assert.match(w.saved[0].text, /=== isolation-report on the node\nnot available: connection reset/);
  assert.match(w.saved[0].text, /=== test container 101/);
});

test("an early step 4 failure (no outbound IPv6) saves diagnostics too", async () => {
  const w = world({ outbound6: "fail" });
  await executeInstall(w.deps, opts(), settings);
  assert.deepEqual(w.saved.map((d) => d.suffix), ["-verify"]);
  assert.match(w.saved[0].text, /=== test container 100/);
  assert.match(w.saved[0].text, /=== isolation-report on the node/);
});

test("--keep-on-failure at step 4 keeps the test containers and their Floating IP, and turns the probe off", async () => {
  const w = world({ rulesLostOnRestart: true });
  const r = await executeInstall(w.deps, opts({ ipv4Test: true, keepOnFailure: true }), settings);
  const error = (r as { error: string }).error;
  const rec = w.installs.get("sowsi-proxmox-02")!;
  assert.deepEqual(testContainers(w).map((c) => c.vmid), [100, 101, 102], "all three kept");
  assert.equal(w.hz.state.floatingIps.size, 2, "the Floating IP A holds is kept, and the gateway's with the server");
  assert.notEqual(rec.testFloatingIpId, null, "and still on the record, so a re-run or --destroy can release it");
  assert.match(error, new RegExp(`kept for inspection: test containers 100, 101, 102 and Floating IP ${rec.testFloatingIpId}; a re-run deletes them first`));
  assert.deepEqual(w.probes, [true, false], "the probe interface is still removed");
  assert.equal(servers(w).size, 1);
  assert.deepEqual(w.saved.map((d) => d.suffix), ["-verify"]);
});

test("a re-run deletes what --keep-on-failure kept before making its own, and leaves nothing behind", async () => {
  const other = { vmid: 104, name: "sowsi-cmabc123" };
  const w = world({ rulesLostOnRestart: true });
  await executeInstall(w.deps, opts({ ipv4Test: true, keepOnFailure: true }), settings);
  const keptIp = w.installs.get("sowsi-proxmox-02")!.testFloatingIpId;
  w.containers.push(other);
  const resumed = resumeWorld(w);
  const destroyed: number[] = [];
  const pve = resumed.deps.proxmox;
  resumed.deps.proxmox = (...a) => {
    const api = pve(...a);
    return { ...api, destroyContainer: async (id) => (destroyed.push(id), api.destroyContainer(id)) };
  };
  const r = await executeInstall(resumed.deps, opts({ ipv4Test: true }), settings);
  assert.equal(r.ok, true, (r as { error?: string }).error);
  assert.deepEqual(destroyed.slice(0, 3), [100, 101, 102], "the kept ones go first");
  ok(!destroyed.includes(104), "a customer's container is never touched");
  assert.deepEqual(testContainers(resumed), [other]);
  assert.equal(resumed.hz.state.floatingIps.size, 1, "kept and new test Floating IPs both released; the gateway's stays");
  assert.equal(gatewayIps(resumed).length, 1);
  ok(![...resumed.hz.state.floatingIps.keys()].map(String).includes(String(keptIp)));
  assert.equal(resumed.installs.get("sowsi-proxmox-02")!.testFloatingIpId, null);
  assert.equal(resumed.nodes.length, 1);
});

test("a kept test container that won't delete stops the re-run before it makes new ones", async () => {
  const w = world({ rulesLostOnRestart: true });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  const resumed = resumeWorld(w);
  const pve = resumed.deps.proxmox;
  resumed.deps.proxmox = (...a) => ({ ...pve(...a), destroyContainer: async () => ({ leftover: ["local:vm-100-disk-0"], errors: [] }) });
  const r = await executeInstall(resumed.deps, opts({ keepOnFailure: true }), settings);
  assert.match((r as { error: string }).error, /kept test container 100: leftover disks local:vm-100-disk-0/);
  assert.equal(resumed.created.length, 0, "nothing new made");
  assert.equal(resumed.nodes.length, 0);
});

test("without --keep-on-failure a step 4 failure releases the Floating IP and deletes everything", async () => {
  const w = world({ rulesLostOnRestart: true });
  await executeInstall(w.deps, opts({ ipv4Test: true }), settings);
  assert.deepEqual(testContainers(w), []);
  assert.equal(w.hz.state.floatingIps.size, 0);
  assert.equal(servers(w).size, 0);
});

test("a probe interface that won't go away is reported", async () => {
  const w = world({ probeStuck: true });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match((r as { error: string }).error, /probe interface: ip link del failed/);
  assert.equal(w.nodes.length, 0);
});

test("setup gets the management IP, for the rules that limit 8006", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  assert.match(S.hostSetupCommand("2a01:4f8:1c16:abcd", settings.mgmtIp), /MGMT_IP='?2\.31\.11\.105'? /);
  assert.ok(S.outboundScript(settings.mgmtIp).includes("ip saddr != 2.31.11.105 tcp dport 8006"));
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
  assert.deepEqual(testContainers(w), []);
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
  for (const key of ["installs", "nodes", "logs", "alerts", "commands", "booted", "kernel", "staged", "installed", "pveInstall", "hostKey", "authorized", "containers", "clock", "firewall", "saved", "rebootAt", "pinName", "guardInstalled", "repaired", "resolvStatic", "gw", "curls"] as const) {
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

  assert.match((await planDestroy(w.deps, "168392011", settings)).problems.join(), /HETZNER_SERVER_ID \(a hand-built server\) — never destroyed/);
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
  assert.match((r as { error: string }).error, /HETZNER_SERVER_ID \(a hand-built server\)/);
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
  Object.assign(w, { authorized: [INSTALL_KEY, ADMIN_KEY], pveInstall: "none", kernel: "6.1.0-26-cloud-amd64", staged: "", installed: "original", rebootAt: null, booted: "boot-1", pinName: null, guardInstalled: false, containers: [], gw: { installed: false, version: null, table: "", syncs: [], counted: 0 } });
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

test("the cost follows the dollar rate, and a default rate is said out loud", () => {
  const price = { hourly: 0.0368, monthly: 22.99 };
  const ips = { currency: "USD", primaryIpv4: { hourly: 0.0008, monthly: 0.5 }, floatingIpv4Monthly: 3.5 };
  const at = (usdToInr: number, rateWarning?: string) => serverCost("cpx22", price, ips, { location: "nbg1", usdToInr, rateWarning }, false);
  const set = at(96) as Cost;
  assert.equal(set.monthlyPaise, Math.ceil(23.49 * 96 * 100));
  assert.equal(set.hourlyPaise, Math.ceil(0.0376 * 96 * 100));
  assert.ok(!set.lines.some((l) => l.includes("WARNING")));
  assert.equal((at(96, "WARNING: a default") as Cost).lines.at(-1), "WARNING: a default");
  assert.ok(set.lines.includes("traffic: 20 TB a month included with a CPX server, then $1.20/TB (invoice; not in the total)"));
  assert.equal(set.monthlyPaise, Math.ceil(23.49 * 96 * 100), "the traffic line changes no total");
  const test4 = serverCost("cpx22", price, ips, { location: "nbg1", usdToInr: 96 }, true) as Cost;
  assert.ok(test4.lines.includes("--ipv4 test: one Floating IPv4, $0.0056/hour, at most $3.50/month (invoice); the API lists $3.50/month; released right after the test"));
  assert.equal(test4.monthlyPaise, set.monthlyPaise, "nor does the Floating IP line");
});

test("prices in another currency are refused, not converted at the dollar rate", async () => {
  const w = world({ hetzner: { currency: "EUR" } });
  const p = await planInstall(w.deps, opts(), settings);
  assert.equal(p.ok, false);
  assert.match(p.problems.join(), /Hetzner reports prices in EUR/);
  ok(hetznerRequests(w).every((r) => r.method === "GET"), "nothing bought");
});

// ── The shared IPv4 gateway (Stage B) ────────────────────────────────

const GATEWAY_MONTHLY = Math.ceil(3.5 * 100 * 100);
const FIP_HOURLY = Math.ceil(0.0056 * 100 * 100);
const fipRow = (id: number, ip: string, server: number | null, labels: Record<string, string>, description: string | null = null) => ({ id, name: `fip-${id}`, description, ip, type: "ipv4", server, home_location: { name: "nbg1" }, blocked: false, labels, dns_ptr: [] });
const errorOf = (r: { ok: boolean }) => (r as { error?: string }).error ?? "";

test("gateway: its own Floating IP, labelled and counted against the cap, container 9000 on it, HAProxy, checked from outside", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, errorOf(r));
  const [serverId] = [...servers(w).keys()];
  const [fip] = gatewayIps(w);
  assert.equal(fip.server, serverId, "assigned to the node");
  assert.deepEqual(fip.labels, { [INSTALL_LABEL]: "gateway", "sowsi-node": NAME }, "labelled, so --destroy knows it's the installer's");
  assert.equal(fip.description, `sowsi-gateway-${NAME}`);
  const bought = w.logs.filter((l) => l.action === "FLOATING_IP_PURCHASED");
  assert.equal(bought.length, 1);
  assert.equal(bought[0].cost, GATEWAY_MONTHLY, "a full month against the cap, like a server");
  assert.deepEqual(w.created.find((c) => c.vmid === 9000), { vmid: 9000, ipv4: fip.ip, ipv6: undefined }, "its Floating IP, and no IPv6: IPv6 visitors go straight to the container");
  const c = w.commands;
  ok(c.indexOf("routes") < c.indexOf("gateway install") && c.indexOf("gateway install") < c.indexOf("gateway status"), "routes first, then HAProxy, then its facts");
  ok(c.indexOf("gateway status") < c.indexOf("add provisioning key"), "all before the lockdown, on the install key");
  for (const id of ["http_unknown", "https_unknown", "https_nosni"] as const) ok(w.curls.some((a) => JSON.stringify(a) === JSON.stringify(S.gatewayProbe(fip.ip as string, id))), `checked from outside: ${id}`);
  const rec = w.installs.get(NAME)!;
  assert.equal(rec.gatewayFloatingIpId, String(fip.id));
  assert.equal(rec.gatewayMonthlyPaise, GATEWAY_MONTHLY);
  assert.match(JSON.stringify(w.logs.find((l) => (l.after as { step?: string })?.step === "gateway")), /container 9000 on Floating IP 198\.51\.100\.7 .*HAProxy active, table version 0 \(0 routes\), no logins, ports 80,443, 61 MB in use/);
});

test("gateway: the plan shows its Floating IP and counts it against the cap with the server", async () => {
  const ok1 = await planInstall(world().deps, opts(), settings);
  assert.equal(ok1.cost!.gatewayMonthlyPaise, GATEWAY_MONTHLY);
  assert.match(ok1.cost!.lines.join("\n"), /gateway: one Floating IPv4 for the node's shared IPv4 gateway, \$0\.0056\/hour, at most \$3\.50\/month \(invoice\); the API lists \$3\.50\/month; kept while the node lives; ₹350 against the spend cap/);
  const server = Math.ceil(23.49 * 100 * 100);
  const tight = await planInstall(world({ spent: settings.spendCapPaise - server - 100 }).deps, opts(), settings);
  assert.equal(tight.ok, false, "the server alone would fit; with its gateway it doesn't");
  assert.match(tight.problems.join(), /buying it and its gateway's Floating IP takes this month's infrastructure spend to ₹5,349, over the ₹5,000 cap/);
});

test("gateway: a cap reached since the plan stops it before anything is bought", async () => {
  const w = world();
  let reads = 0;
  w.deps.db.spentThisMonthPaise = async () => (reads++ === 0 ? 0 : settings.spendCapPaise - 100);
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.match(errorOf(r), /failed at step 3h\+ shared IPv4 gateway[\s\S]*its Floating IP takes this month's infrastructure spend to ₹5,349, over the ₹5,000 cap \(ENGINE_SPEND_CAP_PAISE\)\. Nothing was bought\./);
  assert.equal(w.hz.state.floatingIps.size, 0);
  ok(!hetznerRequests(w).some((q) => q.method === "POST" && q.path === "/floating_ips"), "never asked Hetzner for one");
  assert.equal(servers(w).size, 0, "and the server went, as with any failed install");
});

test("gateway: Hetzner's Floating IP limit is said plainly; nothing was bought", async () => {
  const w = world();
  w.deps.hetzner.buyFloatingIP = async () => {
    throw Object.assign(new Error("floating_ip limit exceeded"), { code: "resource_limit_exceeded" });
  };
  const r = await executeInstall(w.deps, opts(), settings);
  assert.match(errorOf(r), /Hetzner's Floating IP limit for this project is reached — ask Hetzner to raise it \(Console → Limits\), or release an unused one\. Nothing was bought\./);
  assert.equal(w.logs.filter((l) => l.action === "FLOATING_IP_PURCHASED").length, 0, "no spend recorded");
});

test("gateway: a run that stopped right after buying adopts that IP, and buys no second one", async () => {
  const w = world();
  w.hz.state.floatingIps.set(7777, fipRow(7777, "198.51.100.40", null, { [INSTALL_LABEL]: "gateway", "sowsi-node": NAME }, `sowsi-gateway-${NAME}`));
  // Someone else's, unlabelled, and a gateway IP of another node: neither is taken.
  w.hz.state.floatingIps.set(7778, fipRow(7778, "198.51.100.41", null, {}));
  w.hz.state.floatingIps.set(7779, fipRow(7779, "198.51.100.42", null, { [INSTALL_LABEL]: "gateway", "sowsi-node": "sowsi-proxmox-09" }));
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, errorOf(r));
  ok(!hetznerRequests(w).some((q) => q.method === "POST" && q.path === "/floating_ips"), "nothing bought");
  assert.equal(w.installs.get(NAME)!.gatewayFloatingIpId, "7777");
  assert.equal(w.hz.state.floatingIps.get(7777)!.server, [...servers(w).keys()][0]);
  assert.equal(w.hz.state.floatingIps.get(7778)!.server, null);
  assert.equal(w.hz.state.floatingIps.get(7779)!.server, null);
  const log = w.logs.find((l) => l.action === "FLOATING_IP_PURCHASED")!;
  assert.equal((log.after as { adopted: boolean }).adopted, true);
  assert.equal(log.cost, GATEWAY_MONTHLY, "an adopted IP is counted too: it was bought this run");
});

test("gateway: a container 9000 that isn't the gateway is never touched, and the server it's on is never deleted", async () => {
  const w = world({ otherContainers: [{ vmid: 9000, name: "sowsi-cmabc123" }] });
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  assert.match(errorOf(r), /container 9000 exists and isn't the gateway \(sowsi-cmabc123\) — not touching it/);
  assert.match(errorOf(r), /server \d+ NOT deleted: the node has container\(s\) 9000 sowsi-cmabc123/);
  assert.match(errorOf(r), /gateway Floating IP \d+ kept with the server/);
  assert.deepEqual(w.containers, [{ vmid: 9000, name: "sowsi-cmabc123" }]);
  assert.equal(servers(w).size, 1);
  ok(!w.created.some((c) => c.vmid === 9000), "nothing was created over it");
});

test("gateway: a broken gateway fails its step; its Floating IP goes with the server, and the spend is settled to the hours it lived", async () => {
  const cases: [WorldCfg, RegExp][] = [
    [{ gatewayStatus: { public_ports: "22,80,443" } }, /ports open on the gateway: 22,80,443, expected 80,443/],
    [{ gatewayStatus: { config: "/etc/haproxy/haproxy.cfg" } }, /HAProxy reads \/etc\/haproxy\/haproxy\.cfg/],
    [{ gatewayStatus: { haproxy_enabled: "disabled" } }, /wouldn't start after a reboot/],
    [{ gatewayStatus: { logins: "1" } }, /holds 1 authorized SSH key/],
    [{ routesIgnoreGateway: true }, /sowsi-routes didn't take container 9000 as the gateway/],
    [{ gatewayFault: "unknown_served" }, /an unknown name on port 80 got 200, not the neutral 404/],
    [{ gatewayFault: "no_sni_answers" }, /TLS with no name on port 443 was answered/],
  ];
  for (const [cfg, why] of cases) {
    const w = world(cfg);
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false, JSON.stringify(cfg));
    assert.match(errorOf(r), /failed at step 3h\+ shared IPv4 gateway/, JSON.stringify(cfg));
    assert.match(errorOf(r), why);
    assert.equal(w.hz.state.floatingIps.size, 0, `${JSON.stringify(cfg)}: released`);
    assert.equal(servers(w).size, 0);
    const settled = w.logs.find((l) => l.action === "FLOATING_IP_COST_SETTLED")!;
    const after = settled.after as { hours: number; accruedPaise: number; monthlyPaise: number };
    assert.equal(after.monthlyPaise, GATEWAY_MONTHLY);
    assert.equal(after.accruedPaise, Math.min(after.hours * FIP_HOURLY, GATEWAY_MONTHLY), "billed hourly, up to the monthly price (the invoice)");
    assert.equal(settled.cost, after.accruedPaise - GATEWAY_MONTHLY, "the difference is given back to the cap");
    const rec = w.installs.get(NAME)!;
    assert.deepEqual([rec.gatewayFloatingIpId, rec.gatewayIpv4, rec.gatewayPurchasedAt, rec.gatewayMonthlyPaise], [null, null, null, null]);
  }
});

test("gateway: --keep-on-failure keeps its Floating IP with the server, and says so", async () => {
  const w = world({ gatewayStatus: { ssh: "active" } });
  const r = await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  assert.match(errorOf(r), /SSH is running in the gateway/);
  assert.match(errorOf(r), /server \d+ \(203\.0\.113\.20\) and its gateway Floating IP \d+ are KEPT/);
  assert.equal(gatewayIps(w).length, 1);
  assert.equal(w.logs.filter((l) => l.action === "FLOATING_IP_COST_SETTLED").length, 0);
});

test("step 4: two names reach two shared containers through the gateway, from outside, then the routes go", async () => {
  const w = world();
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, true, errorOf(r));
  assert.equal(w.gw.syncs.length, 2);
  const [routed, cleared] = w.gw.syncs;
  assert.equal(routed.table, `one.gateway.test sowsitest0000101 ${S.TEST_IPV4.second} 0\ntwo.gateway.test sowsitest0000102 ${S.TEST_IPV4.third} 0\n`);
  ok(routed.version > 0, "above the empty table the install applied");
  assert.deepEqual(cleared, { version: routed.version + 1, table: "" });
  for (const id of S.GATEWAY_PROBES) ok(w.curls.some((a) => JSON.stringify(a) === JSON.stringify(S.gatewayProbe("198.51.100.7", id))), `asked from outside: ${id}`);
  ok(w.gw.counted >= 4, "the rule meant for the gateway's traffic counted it");
  const detail = JSON.stringify(w.logs.find((l) => (l.after as { step?: string })?.step === "verify"));
  assert.match(detail, /gateway 198\.51\.100\.7: one\.gateway\.test → container 101, two\.gateway\.test → container 102, on 80 and 443 \(curl --resolve from sowsi-mgmt-01\); X-Forwarded-For 2\.31\.11\.105, the client's own value dropped; unknown name: 404 on 80, closed on 443, also with no name; routes removed again/);
  const c = w.commands;
  ok(c.indexOf("shared outbound") < c.indexOf(`gateway sync ${routed.version}`) && c.indexOf(`gateway sync ${cleared.version}`) < c.indexOf("isolation proof"), "after NAT is proven, before the isolation proof");
  assert.equal(w.nodes[0].gatewayRoutesVersion, BigInt(cleared.version));
});

test("step 4: a gateway that routes wrongly, passes a client's header, answers an unknown name or keeps a removed route fails, and leaves nothing behind", async () => {
  const cases: [WorldCfg, RegExp][] = [
    [{ gatewayFault: "swapped" }, /one\.gateway\.test on port 80 reached backend-102, not backend-101/],
    [{ gatewayFault: "xff_passes" }, /the client's own X-Forwarded-For \(198\.51\.100\.66\) reached the site on one\.gateway\.test/],
    [{ gatewayFault: "tls_answers" }, /an unknown TLS name on port 443 was answered/],
    [{ gatewayFault: "route_stays" }, /one\.gateway\.test still got 200 after its route was removed, not the neutral 404/],
    [{ gatewayFault: "not_counted" }, /gateway_in counted nothing \(0 → 0\)/],
    [{ backendDown: true }, /test container 101 has no web server on 0\.0\.0\.0:80 and :443 \(tools present, 0 of 2 listening\)/],
    [{ syncRefused: true }, /refused: line 1: no container on this node has 100\.127\.255\.11/],
  ];
  for (const [cfg, why] of cases) {
    const w = world(cfg);
    const r = await executeInstall(w.deps, opts(), settings);
    assert.equal(r.ok, false, JSON.stringify(cfg));
    assert.match(errorOf(r), why);
    assert.deepEqual(testContainers(w), [], JSON.stringify(cfg));
    assert.equal(w.gw.table, "", `${JSON.stringify(cfg)}: no test route left on the gateway`);
    assert.equal(w.nodes.length, 0);
    assert.equal(w.hz.state.floatingIps.size, 0, "the gateway's IP went with the server");
  }
});

test("step 4: --keep-on-failure keeps the test routes with the containers they point at, and a re-run replaces them", async () => {
  const w = world({ gatewayFault: "swapped" });
  await executeInstall(w.deps, opts({ keepOnFailure: true }), settings);
  assert.equal(w.gw.table.split("\n").filter(Boolean).length, 2, "kept as evidence");
  const kept = w.gw.version!;
  const resumed = resumeWorld(w);
  const r = await executeInstall(resumed.deps, opts(), settings);
  assert.equal(r.ok, true, errorOf(r));
  ok(resumed.gw.syncs.at(-1)!.version > kept, "each new table's version is higher");
  assert.equal(resumed.gw.table, "");
});

test("--destroy releases the node's gateway Floating IP and settles its spend; the plan lists it", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  const sid = String([...servers(w).keys()][0]);
  const plan = await planDestroy(w.deps, sid, settings);
  assert.equal(plan.ok, true, plan.problems.join());
  assert.match(plan.lines.join("\n"), /release Floating IP \d+ \(198\.51\.100\.7\), the node's gateway/);
  w.clock += 3 * 3_600_000;
  const r = await executeDestroy(w.deps, sid, "sivakumar", settings);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /released Floating IP \d+ \(198\.51\.100\.7\), the node's gateway; its spend settled to the hours it lived/);
  assert.equal(w.hz.state.floatingIps.size, 0);
  const settled = w.logs.find((l) => l.action === "FLOATING_IP_COST_SETTLED")!;
  const after = settled.after as { hours: number; accruedPaise: number };
  ok(after.hours >= 3, `${after.hours} hours`);
  assert.equal(settled.cost, after.accruedPaise - GATEWAY_MONTHLY);
  assert.equal(w.nodes.length, 0);
});

test("--destroy asks about a Floating IP it didn't buy, and never decides about another server's", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  const sid = String([...servers(w).keys()][0]);
  // As on sowsi-test-04: a test IP made in the console and assigned to the server, with no labels.
  w.hz.state.floatingIps.set(8888, fipRow(8888, "198.51.100.90", Number(sid), {}));
  w.hz.state.floatingIps.set(8889, fipRow(8889, "198.51.100.91", 424242, {}, "someone else's"));
  const plain = await planDestroy(w.deps, sid, settings);
  assert.equal(plain.ok, false);
  assert.match(plain.problems.join(), /Floating IP 8888 \(198\.51\.100\.90\) is assigned to this server and isn't labelled as a test or installer IP: add --release-floating-ip 8888 to release it, or --keep-floating-ip 8888 to leave it \(it stays billed, unassigned\)/);
  assert.doesNotMatch(plain.problems.join(), /8889/);
  assert.equal((await executeDestroy(w.deps, sid, "sivakumar", settings)).ok, false);
  assert.equal(servers(w).size, 1, "nothing done until it's decided");
  ok(w.hz.state.floatingIps.has(8888));
  assert.match((await planDestroy(w.deps, sid, settings, { release: ["8889"], keep: [] })).problems.join(), /Floating IP 8889 \(198\.51\.100\.91, "someone else's"\) isn't assigned to server \d+: --destroy only decides about this server's/);
  assert.match((await planDestroy(w.deps, sid, settings, { release: ["8888"], keep: ["8888"] })).problems.join(), /Floating IP 8888 is both released and kept/);
  assert.match((await planDestroy(w.deps, sid, settings, { release: ["123"], keep: [] })).problems.join(), /Floating IP 123 \(--release-floating-ip\/--keep-floating-ip\) doesn't exist/);
  const keep = await planDestroy(w.deps, sid, settings, { release: [], keep: ["8888"] });
  assert.equal(keep.ok, true, keep.problems.join());
  assert.match(keep.lines.join("\n"), /keep Floating IP 8888 \(198\.51\.100\.90\) \(--keep-floating-ip\): it stays billed, unassigned, until you release it/);
  const r = await executeDestroy(w.deps, sid, "sivakumar", settings, { release: ["8888"], keep: [] });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /released Floating IP 8888 \(198\.51\.100\.90\), --release-floating-ip/);
  ok(!w.hz.state.floatingIps.has(8888));
  ok(w.hz.state.floatingIps.has(8889), "another server's is never touched");
  assert.equal(gatewayIps(w).length, 0);
});

test("--keep-floating-ip leaves it, unassigned: the server goes and the IP doesn't", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  const sid = String([...servers(w).keys()][0]);
  w.hz.state.floatingIps.set(8888, fipRow(8888, "198.51.100.90", Number(sid), {}));
  const r = await executeDestroy(w.deps, sid, "sivakumar", settings, { release: [], keep: ["8888"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(w.hz.state.floatingIps.get(8888)!.server, null, "left unassigned by the server's deletion, as you chose");
});

test("--destroy releases an installer-labelled IP no record holds (left by a run that stopped), and reports one that won't go", async () => {
  const w = world();
  assert.equal((await executeInstall(w.deps, opts(), settings)).ok, true);
  const sid = String([...servers(w).keys()][0]);
  w.hz.state.floatingIps.set(8890, fipRow(8890, "198.51.100.92", null, { [INSTALL_LABEL]: "test", "sowsi-node": NAME }));
  const plan = await planDestroy(w.deps, sid, settings);
  assert.equal(plan.ok, true, plan.problems.join());
  assert.match(plan.lines.join("\n"), /release Floating IP 8890 \(198\.51\.100\.92\), the installer's test IP/);
  const release = w.deps.hetzner.releaseFloatingIP;
  w.deps.hetzner.releaseFloatingIP = async (id) => {
    if (id === 8890) throw new Error("locked");
    return release(id);
  };
  const r = await executeDestroy(w.deps, sid, "sivakumar", settings);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /Floating IP 8890 \(198\.51\.100\.92\) NOT released: locked/);
  assert.match(r.lines.join("\n"), /deleted server/, "the server still goes");
  assert.equal(gatewayIps(w).length, 0, "and the gateway's IP was released");
});

test("the gateway's spend actions count towards the cap", async () => {
  const { SPEND_ACTIONS } = await import("@/engine/data/spend");
  for (const a of ["FLOATING_IP_PURCHASED", "FLOATING_IP_COST_SETTLED"]) ok((SPEND_ACTIONS as readonly string[]).includes(a), a);
});

test("gateway: a Floating IP still there after its release is reported, kept on the record, and not settled", async () => {
  const w = world({ gatewayStatus: { haproxy: "failed" } });
  // Hetzner answers the release, but the IP is still listed afterwards.
  w.deps.hetzner.releaseFloatingIP = async () => {};
  const r = await executeInstall(w.deps, opts(), settings);
  assert.equal(r.ok, false);
  const id = w.installs.get(NAME)!.gatewayFloatingIpId;
  assert.notEqual(id, null, "still on the record, so --destroy can release it");
  assert.match(errorOf(r), new RegExp(`gateway Floating IP ${id} still exists after release`));
  assert.equal(w.logs.filter((l) => l.action === "FLOATING_IP_COST_SETTLED").length, 0, "no spend given back for an IP that's still billing");
});
