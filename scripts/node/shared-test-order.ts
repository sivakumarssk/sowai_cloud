/**
 * Stage C's proof on a throwaway node: a simulated order ends ACTIVE in shared mode, with no
 * Floating IP bought, reachable by its name through the node's gateway on 80 and 443, and its
 * outbound IPv4 leaving by NAT. Then --cleanup removes it again.
 *
 *   npx tsx scripts/node/shared-test-order.ts --node sowsi-test-07                                   # plan only
 *   npx tsx scripts/node/shared-test-order.ts --node sowsi-test-07 --execute --approved-by <name>
 *   npx tsx scripts/node/shared-test-order.ts --cleanup <serviceId>                                 # plan only
 *   npx tsx scripts/node/shared-test-order.ts --cleanup <serviceId> --execute --approved-by <name>
 *
 * Options: --plan <slug> (default VPS_BASIC; a plan with Coolify is refused).
 *
 * The order belongs to a made-up customer (shared-mode-test@sowsicloud.invalid) that can't log in
 * or receive mail. It has no payment, no subscription and billingHold on, so billing never touches
 * it; it's built with refunds and customer emails off. It's pinned to the named node, which must be
 * closed to customers and have shared IPv4 on. Production only: nodes live there.
 * Prints no password or key.
 */
import { config as loadEnv } from "dotenv";
import { exitUnlessEnvironment } from "../lib/env";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", quiet: true });
exitUnlessEnvironment("the shared-mode test order");

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

(async () => {
  const nodeName = value("--node");
  const cleanupId = value("--cleanup");
  const execute = argv.includes("--execute");
  const approvedBy = value("--approved-by") ?? "";
  const planSlug = value("--plan") ?? "VPS_BASIC";
  if (Boolean(nodeName) === Boolean(cleanupId)) throw new Error("usage: shared-test-order.ts (--node <name> [--plan <slug>] | --cleanup <serviceId>) [--execute --approved-by <name>]");
  if (execute && !approvedBy.trim()) throw new Error("--execute needs --approved-by <name>");

  const { prisma } = await import("../../src/lib/prisma");
  const S = await import("../../src/lib/nodes/nodeScripts");
  const T = await import("../../src/lib/nodes/sharedTestOrder");
  const { planFeatures } = await import("../../src/lib/plans");
  const { nodeLoads, placementConfig, planNeed } = await import("../../src/lib/provisioning/placementDeps");
  const { nodeFit } = await import("../../src/lib/provisioning/placement");
  const { provisionVPS, deprovisionVPS } = await import("../../src/lib/provisioning/provisionVPS");
  const { proxmoxForNode } = await import("../../src/lib/proxmox");
  const { runOnHost } = await import("../../src/engine/data/hostShell");
  const { connectWithRetry, run } = await import("../../src/lib/vmSetup");
  const { decrypt } = await import("../../src/lib/crypto");
  const { serviceConnection } = await import("../../src/lib/provisioning/connection");
  const { serviceFqdn } = await import("../../src/lib/provisioning/publicName");
  const { prismaEngineLog } = await import("../../src/engine/data/engineLog");
  const { execFile } = await import("node:child_process");

  const curl = (args: string[]) =>
    new Promise<{ exit: number; stdout: string }>((resolve, reject) => {
      execFile("curl", args, { timeout: 30_000, encoding: "utf8" }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("curl isn't installed on this machine"));
        resolve({ exit: err ? (typeof (err as { code?: unknown }).code === "number" ? Number((err as { code?: unknown }).code) : 1) : 0, stdout: String(stdout ?? "") });
      });
    });
  const say = (line = "") => console.log(line);
  const fail = (problems: string[]) => {
    for (const p of problems) say(`  FAIL ${p}`);
    process.exitCode = 1;
  };

  try {
    if (nodeName) {
      // ── The test order ──
      const row = await prisma.proxmoxNode.findUnique({ where: { name: nodeName } });
      const node = row && { ...row, hasOwnToken: Boolean(row.apiTokenId && row.apiTokenSecret) };
      const plan = await prisma.plan.findFirst({ where: { slug: planSlug } });
      const coolify = plan ? planFeatures(plan).some((f) => /coolify/i.test(f)) : false;
      let fit: string | null = null;
      if (row && plan) {
        const load = (await nodeLoads(prisma)).find((n) => n.id === row.id)!;
        const f = nodeFit(load, planNeed(plan, "SHARED"), placementConfig(), true);
        if (!f.ok) fit = f.reason;
      }
      const live = await prisma.service.findMany({ where: { user: { email: T.TEST_CUSTOMER_EMAIL }, status: { not: "DELETED" } }, select: { id: true, status: true } });
      const problems = T.testOrderProblems({ node, plan: plan && { slug: plan.slug ?? planSlug, name: plan.name, category: plan.category, coolify }, fit, liveTestServices: live.map((s) => `${s.id} ${s.status}`) });

      say(`Shared-mode test order on ${nodeName}`);
      if (row) say(`  node: ${row.status}, ${row.acceptNewClients ? "OPEN" : "closed"} to customers, shared IPv4 ${row.sharedIpv4 ? "on" : "off"}, gateway ${row.gatewayIpv4 ?? "none"}`);
      if (plan) say(`  plan: ${plan.name} (${plan.vcpu} vCPU, ${plan.ramGB} GB RAM, ${plan.storageGB} GB disk)`);
      say(`  customer: ${T.TEST_CUSTOMER_EMAIL} (made up: no login, no mail), billingHold on, no payment or subscription`);
      say("  steps: create the order (PROVISIONING), build it pinned to this node with refunds and customer emails off,");
      say("         check it's ACTIVE as shared with no Floating IP, its net0, the gateway's route, a web server reached by");
      say(`         its name on 80 and 443 through the gateway (curl --resolve), and IPv4 out by NAT. Nothing is bought.`);
      for (const p of problems) say(`  REFUSED: ${p}`);
      if (problems.length) return void (process.exitCode = 1);
      if (!execute) return say("\nPlan only: nothing changed. Add --execute --approved-by <name> to run it.");

      const bcrypt = (await import("bcryptjs")).default;
      const { generatePassword } = await import("../../src/lib/crypto");
      const user = await prisma.user.upsert({
        where: { email: T.TEST_CUSTOMER_EMAIL },
        update: {},
        create: { email: T.TEST_CUSTOMER_EMAIL, name: "Shared-mode test (not a customer)", phone: "0000000000", password: await bcrypt.hash(generatePassword(), 10), isVerified: false },
      });
      const service = await prisma.service.create({
        data: {
          userId: user.id,
          planId: plan!.id,
          status: "PROVISIONING",
          provisioningPct: 0,
          provisioningStep: "Shared-mode test order",
          hostname: T.TEST_HOSTNAME,
          osImage: "ubuntu-22.04",
          // The one place a service is made shared before Stage G: a test order on a throwaway node.
          ipv4Mode: "SHARED",
          billingHold: true,
          nextBillingDate: new Date(Date.now() + 7 * 24 * 3_600_000),
        },
      });
      await prismaEngineLog({ action: "SHARED_TEST_ORDER", serviceId: service.id, toNode: row!.name, after: { approvedBy, plan: planSlug }, trigger: "MANUAL" });
      say(`\nservice ${service.id} created; building it on ${row!.name} (a few minutes)...`);
      const status = () => runOnHost(row!, "isolation-status", 60_000).then(S.parseIsolationStatus);
      const natBefore = (await status()).nat_out ?? 0;

      await provisionVPS(service.id, { refundOnFailure: false, notifyCustomer: false, pinNodeId: row!.id });

      // Not placed (the node had no room after all): never leave it PROVISIONING at 0%, where the sweep would pick it up.
      await prisma.service.updateMany({ where: { id: service.id, status: "PROVISIONING", provisioningPct: 0 }, data: { status: "FAILED", provisionError: "shared-mode test order: not placed on the pinned node" } });
      const s = await prisma.service.findUniqueOrThrow({ where: { id: service.id }, include: { node: { select: { name: true, gatewayIpv4: true, gatewayRoutesVersion: true } } } });
      if (s.status !== "ACTIVE") {
        fail([`the build ended ${s.status} at "${s.provisioningStep}": ${s.provisionError ?? "no error recorded"}`]);
        say(`  It cleaned up after itself (an admin alert says what's left, if anything). Remove the rows: --cleanup ${s.id} --execute --approved-by <name>`);
        return;
      }
      const problems2 = T.checkSharedService(s);
      say(`\n1. ACTIVE as shared: ${problems2.length ? "FAILED" : `private ${s.privateIpv4}, name ${s.publicName}, IPv6 ${s.ipv6Address}, no Floating IP`}`);
      if (problems2.length) return fail(problems2);

      const net0 = await proxmoxForNode(row!).getLXCNetConfig(Number(s.proxmoxVmId));
      const net = T.checkSharedNet0(net0, s.privateIpv4!, s.ipv6Address!);
      say(`2. container ${s.proxmoxVmId}'s net0: ${net.length ? "FAILED" : `ip=${s.privateIpv4}/32 on vmbr1, its IPv6`}`);
      if (net.length) return fail(net);

      const gw = S.parseFacts(await runOnHost(row!, "gateway-status", 60_000));
      const gwProblems = S.checkGatewayStatus(gw, { ipv4: row!.gatewayIpv4!, version: s.node?.gatewayRoutesVersion?.toString() });
      if (!(Number(gw.routes) >= 1)) gwProblems.push(`the gateway has ${gw.routes || 0} routes, not this service's`);
      say(`3. gateway: ${gwProblems.length ? "FAILED" : `table version ${gw.version} (${gw.routes} route${gw.routes === "1" ? "" : "s"}), HAProxy on ${gw.running_config}`}`);
      if (gwProblems.length) return fail(gwProblems);

      // As the customer would: SSH over its IPv6 with its own login (setup turned root login off).
      const username = decrypt(s.sshUsername!);
      const password = decrypt(s.sshPassword!);
      const ssh = await connectWithRetry({ host: s.ipv6Address!, username, password }, 3);
      let web: Record<string, string>;
      let out: Record<string, string>;
      try {
        await run(ssh, "write the test web server", "cat > /tmp/sowsi-web.sh", { stdin: S.gatewayBackendScript(T.TEST_BACKEND) });
        web = S.parseFacts(await run(ssh, "start the test web server", "sudo -S -p '' bash /tmp/sowsi-web.sh", { stdin: `${password}\n`, timeoutMs: 5 * 60_000 }));
        out = S.parseFacts(await run(ssh, "outbound", S.containerOutboundScript(true), { timeoutMs: 2 * 60_000 }));
      } finally {
        ssh.dispose();
      }
      say(`4. SSH over IPv6 as ${username}: a web server on 0.0.0.0:80 and :443 (${web.listening ?? 0} of 2 listening, tools ${web.tools ?? "unknown"})`);
      if (web.listening !== "2") return fail(["the test web server isn't listening on both ports"]);

      const results: Partial<Record<import("../../src/lib/nodes/sharedTestOrder").SharedProbe, { exit: number; stdout: string }>> = {};
      for (const probe of ["http", "https", "http_unknown"] as const) results[probe] = await curl(T.sharedProbeArgs(row!.gatewayIpv4!, s.publicName!, probe));
      const routing = T.checkSharedRouting(results, s.publicName!);
      say(`5. through the gateway ${row!.gatewayIpv4}: ${routing.problems.length ? "FAILED" : `${serviceFqdn(s.publicName!)} reached the container on 80 and 443; X-Forwarded-For ${routing.clientIp}, the client's own dropped; another name got the 404`}`);
      if (routing.problems.length) return fail(routing.problems);

      const natAfter = (await status()).nat_out ?? 0;
      const outProblems = [out.out4 !== "ok" && `outbound IPv4 failed (${out.out4 || "no answer"})`, out.out6 !== "ok" && `outbound IPv6 failed (${out.out6 || "no answer"})`, !(natAfter > natBefore) && `nat_out didn't rise (${natBefore} → ${natAfter})`].filter((x): x is string => Boolean(x));
      say(`6. outbound: ${outProblems.length ? "FAILED" : `IPv4 by NAT (nat_out ${natBefore} → ${natAfter}) and IPv6`}`);
      if (outProblems.length) return fail(outProblems);

      const c = serviceConnection({ ...s, sshUsername: username });
      say(`7. what the customer sees: ${c.tag} · ${c.label} ${c.ipv4} (${c.ipv4Note}) · IPv6 ${c.ipv6} · ${c.sshCommand}`);
      say(`   ${c.notice}`);
      say(`\nPASSED. Clean up: npx tsx scripts/node/shared-test-order.ts --cleanup ${s.id} --execute --approved-by <name>`);
      return;
    }

    // ── Cleanup ──
    const s = await prisma.service.findUnique({
      where: { id: cleanupId! },
      include: { user: { select: { id: true, email: true } }, node: { select: { name: true, ip: true, gatewayIpv4: true } }, _count: { select: { payments: true, subscriptions: true } } },
    });
    const problems: string[] = [];
    if (!s) problems.push(`no service ${cleanupId}`);
    else {
      if (s.user.email !== T.TEST_CUSTOMER_EMAIL) problems.push(`service ${s.id} belongs to ${s.user.email}, not the test customer: not touching it`);
      if (s._count.payments || s._count.subscriptions) problems.push(`service ${s.id} has ${s._count.payments} payment(s) and ${s._count.subscriptions} subscription(s): a test order has none, so not touching it`);
      if (s.status === "PROVISIONING" || s.status === "INSTALLING") problems.push(`service ${s.id} is ${s.status}: wait for the build to finish or fail`);
    }
    say(`Clean up test order ${cleanupId}`);
    if (s) say(`  ${s.status}, ${s.ipv4Mode}, container ${s.proxmoxVmId ?? "none"} on ${s.node?.name ?? "no node"}, name ${s.publicName ?? "none"}, private ${s.privateIpv4 ?? "none"}`);
    say("  steps: cancel it as a customer would (its route goes first, then its container and disks), check its name gets");
    say("         the gateway's 404, then delete the service row and the test customer. Its private address and name are never reused.");
    for (const p of problems) say(`  REFUSED: ${p}`);
    if (problems.length) return void (process.exitCode = 1);
    if (!execute) return say("\nPlan only: nothing changed. Add --execute --approved-by <name> to run it.");

    await prismaEngineLog({ action: "SHARED_TEST_ORDER_CLEANUP", serviceId: s!.id, toNode: s!.node?.name, after: { approvedBy }, trigger: "MANUAL" });
    if (s!.status !== "DELETED") await deprovisionVPS(s!.id);
    say(`1. cancelled: container and disks removed${s!.ipv4Mode === "SHARED" ? ", route removed first" : ""}`);
    if (s!.publicName && s!.node?.gatewayIpv4) {
      const gone = T.checkRouteGone(await curl(T.sharedProbeArgs(s!.node.gatewayIpv4, s!.publicName, "http")), s!.publicName);
      say(`2. ${serviceFqdn(s!.publicName)}: ${gone.length ? "FAILED" : "the gateway's neutral 404"}`);
      if (gone.length) return fail(gone);
    }
    await prisma.service.delete({ where: { id: s!.id } });
    const others = await prisma.service.count({ where: { userId: s!.user.id } });
    if (!others) await prisma.user.delete({ where: { id: s!.user.id } });
    say(`3. service row deleted${others ? ` (the test customer still has ${others} other service(s))` : ", and the test customer"}`);
    say("\nDone.");
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
