import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSync, nextVersion, routesFor, syncGateway, type GatewaySyncDeps, type RoutableService } from "./gatewaySync";

const svc = (id: string, over: Partial<RoutableService> = {}): RoutableService => ({
  id,
  status: "ACTIVE",
  ipv4Mode: "SHARED",
  privateIpv4: "100.64.0.5",
  publicName: id,
  routeKey: `${id}${"0".repeat(16 - id.length)}`,
  proxmoxVmId: "101",
  ...over,
});

test("the table: shared services that are ACTIVE or SUSPENDED, by name, nothing else", () => {
  const { routes, skipped } = routesFor([
    svc("zeta", { privateIpv4: "100.64.0.9" }),
    svc("alpha", { status: "SUSPENDED", privateIpv4: "100.64.0.6" }),
    svc("ded", { ipv4Mode: "DEDICATED" }),
    svc("gone", { status: "CANCELLED" }),
    svc("new", { status: "INSTALLING" }),
    svc("half", { routeKey: null }),
  ]);
  assert.deepEqual(routes, [
    { host: "alpha.c.sowsicloud.com", key: "alpha00000000000", ipv4: "100.64.0.6" },
    { host: "zeta.c.sowsicloud.com", key: "zeta000000000000", ipv4: "100.64.0.9" },
  ]);
  assert.deepEqual(skipped, ["half (ACTIVE) has no route key"], "a broken row is left out and named, not sent");
});

test("versions only go up: past the clock, the applied version and the last one handed out", () => {
  assert.equal(nextVersion(1_731_234_567_890, null, null), 1_731_234_567_890);
  assert.equal(nextVersion(1_000, BigInt(5_000), null), 5_001);
  assert.equal(nextVersion(1_000, BigInt(5_000), BigInt(7_000)), 7_001, "a version handed to a sync still running isn't reused");
  assert.equal(nextVersion(9_000, BigInt(5_000), BigInt(7_000)), 9_000);
  assert.throws(() => nextVersion(1, BigInt(999_999_999_999_999), null), /out of range/, "never past 15 digits");
});

type World = { applied: bigint | null; issued: bigint | null; services: RoutableService[]; sent: { version: number; table: string }[]; gateway: boolean; refuse?: (v: number) => string | null };

function deps(w: World, now = 1_731_234_567_890): GatewaySyncDeps {
  return {
    async issue(nodeId, nowMs) {
      if (!w.gateway) return null;
      const version = nextVersion(nowMs, w.applied, w.issued);
      w.issued = BigInt(version);
      return { node: { id: nodeId, name: "sowsi-test-07", ip: "203.0.113.20", gatewayIpv4: "198.51.100.7" }, version, services: w.services.map((s) => ({ ...s })) };
    },
    async send(_node, version, table) {
      const refused = w.refuse?.(version);
      if (refused) throw new Error(`gateway-sync ${version} on sowsi-test-07 failed (exit 2):\n${refused}`);
      w.sent.push({ version, table });
      return `gateway: version ${version} applied`;
    },
    async applied(_id, version) {
      if (w.applied === null || BigInt(version) > w.applied) w.applied = BigInt(version);
    },
    now: () => now,
  };
}

test("a sync sends the whole table with a new version, and records it as applied", async () => {
  const w: World = { applied: BigInt(1_731_000_000_000), issued: null, services: [svc("shop", { privateIpv4: "100.64.0.5" })], sent: [], gateway: true };
  const r = await syncGateway(deps(w), "node_1");
  assert.equal(r.status, "applied");
  assert.deepEqual(w.sent, [{ version: 1_731_234_567_890, table: "shop.c.sowsicloud.com shop000000000000 100.64.0.5 0\n" }]);
  assert.equal(w.applied, BigInt(1_731_234_567_890));
  assert.equal(describeSync(r), "sowsi-test-07: gateway table version 1731234567890 applied (1 route)");

  // The same clock reading again (two syncs in one millisecond): still a higher version.
  const again = await syncGateway(deps(w), "node_1");
  assert.equal(again.status === "applied" && again.version, 1_731_234_567_891);

  w.services = [];
  const empty = await syncGateway(deps(w), "node_1");
  assert.equal(empty.status, "applied");
  assert.equal(w.sent.at(-1)!.table, "", "the last service gone: an empty table, so its route goes too");
});

test("a newer table already applied isn't a failure; anything else the gateway refuses is", async () => {
  const w: World = { applied: null, issued: null, services: [svc("shop")], sent: [], gateway: true, refuse: (v) => `refused: version ${v} is older than the applied version ${v + 5}` };
  const r = await syncGateway(deps(w), "node_1");
  assert.equal(r.status, "superseded");
  assert.equal(w.applied, BigInt(1_731_234_567_895), "the newer applied version is recorded");
  assert.match(describeSync(r), /not needed, the gateway already has the newer 1731234567895/);

  for (const refused of ["refused: line 1: 100.64.0.5 isn't a container on this node", "gateway: version 7 didn't come up: rolled back to version 6", "refused: version 5 is older than the applied version 9"]) {
    const f: World = { applied: null, issued: null, services: [svc("shop")], sent: [], gateway: true, refuse: () => refused };
    const out = await syncGateway(deps(f), "node_1");
    assert.equal(out.status, "failed", refused);
    assert.match(describeSync(out), /FAILED/);
    assert.equal(f.applied, null, "nothing recorded as applied");
  }
});

test("no gateway: nothing sent; a table that can't be built: nothing sent and it says why; a database error: failed, not thrown", async () => {
  const none: World = { applied: null, issued: null, services: [], sent: [], gateway: false };
  assert.deepEqual(await syncGateway(deps(none), "node_1"), { node: "node_1", status: "no-gateway" });

  const twice: World = { applied: null, issued: null, services: [svc("shop"), svc("shop", { id: "other", routeKey: "other00000000000" })], sent: [], gateway: true };
  const r = await syncGateway(deps(twice), "node_1");
  assert.equal(r.status, "failed");
  assert.match(r.status === "failed" ? r.error : "", /can't be built: gateway route: shop\.c\.sowsicloud\.com is listed twice/);
  assert.deepEqual(twice.sent, []);

  const broken = deps(none);
  broken.issue = async () => { throw new Error("database down"); };
  assert.deepEqual(await syncGateway(broken, "node_1"), { node: "node_1", status: "failed", error: "database down" });
});
