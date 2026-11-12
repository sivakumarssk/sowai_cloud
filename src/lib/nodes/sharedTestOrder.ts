// The checks behind scripts/node/shared-test-order.ts: Stage C's proof that a simulated order ends
// ACTIVE as shared on a throwaway node, reachable through its gateway, with nothing bought.
import { curlReply, SPOOFED_CLIENT, type CurlResult } from "./nodeScripts";
import { isTestPrivateIpv4, privateIpv4Index } from "@/lib/provisioning/privateIpv4";
import { isRealServer, type RealServerFields } from "@/lib/provisioning/serverReady";
import { serviceFqdn } from "@/lib/provisioning/publicName";

/** The made-up customer every test order belongs to. ".invalid" can't receive mail (RFC 2606). */
export const TEST_CUSTOMER_EMAIL = "shared-mode-test@sowsicloud.invalid";
export const TEST_HOSTNAME = "shared-test";
/** The test container's web server answers with this name (gatewayBackendScript). */
export const TEST_BACKEND = "shared-test";

export type TestNode = {
  name: string;
  status: string;
  acceptNewClients: boolean;
  sharedIpv4: boolean;
  gatewayIpv4: string | null;
  gatewayVmId: number | null;
  hasOwnToken: boolean;
  ipv6Subnet: string | null;
};

export type TestPlan = { slug: string; name: string; category: string; coolify: boolean };

/** Why a test order can't be placed here, before anything is created. */
export function testOrderProblems(input: { node: TestNode | null; plan: TestPlan | null; fit: string | null; liveTestServices: string[] }): string[] {
  const { node, plan } = input;
  const problems: string[] = [];
  if (!node) problems.push("no such node");
  else {
    if (node.status === "DECOMMISSIONING") problems.push(`${node.name} is retired`);
    if (node.acceptNewClients) problems.push(`${node.name} is open to customers: a throwaway node stays closed, so no real order can land on it (close it first)`);
    if (!node.gatewayIpv4 || node.gatewayVmId === null) problems.push(`${node.name} has no gateway`);
    if (!node.sharedIpv4) problems.push(`${node.name} has shared IPv4 off: turn it on with node-state.ts --shared on`);
    if (!node.hasOwnToken) problems.push(`${node.name} has no API token of its own`);
    if (!node.ipv6Subnet) problems.push(`${node.name} has no IPv6 subnet`);
  }
  if (!input.plan) problems.push("no such plan");
  else {
    if (plan!.category !== "VPS") problems.push(`${plan!.name} isn't a VPS plan`);
    if (plan!.coolify) problems.push(`${plan!.name} includes Coolify, which keeps a dedicated IPv4: pick a plan without it`);
  }
  if (input.fit) problems.push(input.fit);
  if (input.liveTestServices.length) problems.push(`a test order still exists (${input.liveTestServices.join(", ")}): clean it up first with --cleanup`);
  return problems;
}

type SharedService = RealServerFields & { serverIp: string | null; ipv6Address: string | null };

/** ACTIVE in shared mode: a private address, a name, a route key, and no Floating IP. */
export function checkSharedService(s: SharedService): string[] {
  const problems: string[] = [];
  if (s.status !== "ACTIVE") problems.push(`status is ${s.status}, not ACTIVE`);
  if (s.ipv4Mode !== "SHARED") problems.push(`IPv4 mode is ${s.ipv4Mode}, not SHARED`);
  if (s.hetznerFloatingIpId) problems.push(`it has a Floating IP (${s.hetznerFloatingIpId}): shared mode buys none`);
  if (s.serverIp) problems.push(`serverIp is ${s.serverIp}: a shared service has no IPv4 of its own`);
  if (!s.privateIpv4 || privateIpv4Index(s.privateIpv4) === null || isTestPrivateIpv4(s.privateIpv4)) problems.push(`private IPv4 ${s.privateIpv4 ?? "missing"} isn't one a service can have`);
  if (!s.publicName) problems.push("no service name");
  if (!s.routeKey) problems.push("no route key");
  if (!s.ipv6Address) problems.push("no IPv6 address");
  if (!s.sshVerifiedAt) problems.push("no SSH check");
  if (!problems.length && !isRealServer(s)) problems.push("it isn't a real server by the ACTIVE rule");
  return problems;
}

/** Its net0 line on the node: the private address on vmbr1, the shared gateway route, and its IPv6. */
export function checkSharedNet0(net0: string | null, privateIpv4: string, ipv6: string): string[] {
  if (!net0) return ["the container has no net0 line"];
  const parts = new Map(net0.split(",").map((p) => [p.split("=")[0], p.slice(p.indexOf("=") + 1)] as const));
  const problems: string[] = [];
  if (parts.get("bridge") !== "vmbr1") problems.push(`net0 is on ${parts.get("bridge") ?? "no bridge"}, not vmbr1`);
  if (parts.get("ip") !== `${privateIpv4}/32`) problems.push(`net0 has ip=${parts.get("ip") ?? "none"}, not ${privateIpv4}/32`);
  if (!parts.get("gw")) problems.push("net0 has no IPv4 gateway");
  if (parts.get("ip6") !== `${ipv6}/64`) problems.push(`net0 has ip6=${parts.get("ip6") ?? "none"}, not ${ipv6}/64`);
  return problems;
}

export type SharedProbe = "http" | "https" | "http_unknown";
const UNKNOWN = "unknown.gateway.test";

/** curl's arguments (no shell) for a request to the service's name through the gateway, from sowsi-mgmt-01. */
export function sharedProbeArgs(gw: string, publicName: string, probe: SharedProbe): string[] {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(gw)) throw new Error(`gateway address "${gw}"`);
  const fqdn = serviceFqdn(publicName);
  const base = ["-sS", "-m", "10", "-w", "\\ncode=%{http_code}"];
  switch (probe) {
    case "http": return [...base, "--resolve", `${fqdn}:80:${gw}`, "-H", `X-Forwarded-For: ${SPOOFED_CLIENT}`, `http://${fqdn}/`];
    // -k: the test web server's certificate is a throwaway; the gateway passes TLS through untouched.
    case "https": return [...base, "-k", "--resolve", `${fqdn}:443:${gw}`, `https://${fqdn}/`];
    case "http_unknown": return [...base, "--resolve", `${UNKNOWN}:80:${gw}`, `http://${UNKNOWN}/`];
  }
}

/** Its name reaches its container on 80 and 443 through the gateway; another name gets the neutral 404. */
export function checkSharedRouting(results: Partial<Record<SharedProbe, CurlResult>>, publicName: string): { problems: string[]; clientIp: string | null } {
  const problems: string[] = [];
  let clientIp: string | null = null;
  const fqdn = serviceFqdn(publicName);
  for (const [probe, port] of [["http", 80], ["https", 443]] as const) {
    const r = curlReply(results[probe]);
    // Everything after "xff=": a forwarded chain has spaces in it.
    const m = /^(\S+) xff=(.+)$/.exec(r.body);
    if (r.exit !== 0 || r.code !== "200" || !m) {
      problems.push(`${fqdn} on port ${port} got ${r.code || `curl exit ${r.exit}`}${r.body ? ` "${r.body.slice(0, 60)}"` : ""}, not the test container`);
      continue;
    }
    if (m[1] !== TEST_BACKEND) problems.push(`${fqdn} on port ${port} reached ${m[1]}, not ${TEST_BACKEND}`);
    if (port === 80) {
      if (m[2].includes(SPOOFED_CLIENT)) problems.push(`the client's own X-Forwarded-For (${SPOOFED_CLIENT}) reached the site`);
      else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(m[2])) clientIp = m[2];
      else problems.push(`port 80 saw X-Forwarded-For "${m[2]}", not one client address`);
    } else if (m[2] !== "-") problems.push(`port 443 had an X-Forwarded-For (${m[2]}): TLS should pass through untouched`);
  }
  const unknown = curlReply(results.http_unknown);
  if (unknown.code !== "404") problems.push(`an unknown name got ${unknown.code || `curl exit ${unknown.exit}`}, not the neutral 404`);
  if (/xff=/.test(unknown.body)) problems.push("an unknown name reached a site");
  return { problems, clientIp };
}

/** After the cleanup: its name gets the neutral 404 again. */
export function checkRouteGone(r: CurlResult | undefined, publicName: string): string[] {
  const reply = curlReply(r);
  return reply.code === "404" && !/xff=/.test(reply.body) ? [] : [`${serviceFqdn(publicName)} still got ${reply.code || `curl exit ${reply.exit}`} after the cleanup, not the neutral 404`];
}
