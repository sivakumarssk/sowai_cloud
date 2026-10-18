import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./EventBus";
import { subjectForNode, subjectForService, type ContainerEventType, type EngineEvent, type EventInput } from "./events";

const vmEvent = (type: ContainerEventType, vmid = 104, pct = 88): EventInput => ({
  type,
  subject: subjectForService(`svc_${vmid}`),
  source: "test",
  data: { vmid, serviceId: "svc_1", nodeId: "node_1", pct, used: 1802, limit: 2048, unit: "MB" },
});
const ramCritical = (vmid = 104, pct = 88) => vmEvent("RAM_CRITICAL", vmid, pct);

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("delivers to type subscribers and wildcard subscribers, after publish returns", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe("RAM_CRITICAL", (e) => void seen.push(`typed:${e.data.pct}`));
  bus.subscribe("*", (e) => void seen.push(`all:${e.type}`));
  bus.subscribe("DISK_FULL", () => void seen.push("wrong"));

  const event = bus.publish(ramCritical());
  assert.ok(event?.id);
  assert.deepEqual(seen, [], "handlers must not run synchronously inside publish()");
  await bus.drain();
  assert.deepEqual(seen.sort(), ["all:RAM_CRITICAL", "typed:88"]);
});

test("drops the same type + subject within the window, delivers again after it", async () => {
  const clock = fakeClock();
  const bus = new EventBus({ now: clock.now, defaultDedupeMs: 60_000 });
  let count = 0;
  bus.subscribe("RAM_CRITICAL", () => void count++);

  assert.ok(bus.publish(ramCritical()));
  clock.advance(30_000);
  assert.equal(bus.publish(ramCritical()), null, "30s later: duplicate");
  clock.advance(30_000);
  assert.ok(bus.publish(ramCritical()), "60s later: window over");
  await bus.drain();

  assert.equal(count, 2);
  assert.equal(bus.stats().deduplicated, 1);
});

test("other subjects and more severe types are not treated as duplicates", async () => {
  const bus = new EventBus();
  assert.ok(bus.publish(ramCritical(104)));
  assert.ok(bus.publish(ramCritical(105)), "different container");
  assert.ok(bus.publish(vmEvent("RAM_EMERGENCY", 104)), "escalation for the same container");
  assert.equal(bus.stats().published, 3);
});

test("per-type windows override the default", () => {
  const clock = fakeClock();
  const bus = new EventBus({ now: clock.now, defaultDedupeMs: 60_000, dedupeMs: { RAM_EMERGENCY: 0 } });
  const emergency = vmEvent("RAM_EMERGENCY");
  assert.ok(bus.publish(emergency));
  assert.ok(bus.publish(emergency), "0 ms window: every emergency gets through");
});

test("reset() re-arms an event so the next crossing is delivered immediately", () => {
  const bus = new EventBus();
  assert.ok(bus.publish(ramCritical()));
  assert.equal(bus.publish(ramCritical()), null);
  bus.reset(subjectForService(`svc_${104}`), "RAM_CRITICAL");
  assert.ok(bus.publish(ramCritical()));

  // Without a type: every event type for that subject.
  bus.publish(vmEvent("RAM_WARNING"));
  bus.reset(subjectForService(`svc_${104}`));
  assert.ok(bus.publish(vmEvent("RAM_WARNING")));
  assert.ok(bus.publish(ramCritical()));
});

test("a throwing handler doesn't stop other handlers and is counted", async () => {
  const errors: unknown[] = [];
  const bus = new EventBus({ onHandlerError: (err) => void errors.push(err) });
  let reached = false;
  bus.subscribe("RAM_CRITICAL", () => {
    throw new Error("boom");
  });
  bus.subscribe("RAM_CRITICAL", async () => {
    await Promise.reject(new Error("async boom"));
  });
  bus.subscribe("RAM_CRITICAL", () => void (reached = true));

  bus.publish(ramCritical());
  await bus.drain();
  assert.equal(reached, true);
  assert.equal(errors.length, 2);
  assert.equal(bus.stats().handlerErrors, 2);
  assert.equal(bus.stats().delivered, 1);
});

test("runExclusive skips a second action on the same key while the first runs", async () => {
  const bus = new EventBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runs = 0;

  const first = bus.runExclusive(subjectForService(`svc_${104}`), async () => {
    runs++;
    await gate;
    return "scaled";
  });
  const second = await bus.runExclusive(subjectForService(`svc_${104}`), async () => void runs++);
  const otherVm = await bus.runExclusive(subjectForService(`svc_${105}`), async () => "other");

  assert.deepEqual(second, { ran: false });
  assert.deepEqual(otherVm, { ran: true, result: "other" });
  assert.deepEqual(bus.stats().inFlight, [subjectForService(`svc_${104}`)]);
  release();
  assert.deepEqual(await first, { ran: true, result: "scaled" });
  assert.equal(runs, 1);
  assert.deepEqual(bus.stats().inFlight, []);

  // The key is free again afterwards — even if the action threw.
  await assert.rejects(bus.runExclusive(subjectForService(`svc_${104}`), async () => Promise.reject(new Error("fail"))));
  assert.deepEqual(await bus.runExclusive(subjectForService(`svc_${104}`), async () => 1), { ran: true, result: 1 });
});

test("unsubscribe stops delivery; stats and recent events are reported", async () => {
  const bus = new EventBus({ recentLimit: 2 });
  let count = 0;
  const off = bus.subscribe("*", () => void count++);
  bus.publish(ramCritical(1));
  off();
  bus.publish(ramCritical(2));
  bus.publish({
    type: "SERVER_RAM_CRITICAL",
    subject: subjectForNode("sowsi-proxmox-01"),
    source: "test",
    data: { nodeId: "node_1", nodeName: "sowsi-proxmox-01", pct: 82, resource: "RAM" },
  });
  await bus.drain();

  assert.equal(count, 1);
  const stats = bus.stats();
  assert.equal(stats.published, 3);
  assert.deepEqual(stats.byType, { RAM_CRITICAL: 2, SERVER_RAM_CRITICAL: 1 });
  const recent: EngineEvent[] = bus.recentEvents();
  assert.deepEqual(
    recent.map((e) => e.subject),
    ["node:sowsi-proxmox-01", "service:svc_2"],
    "newest first, capped at recentLimit"
  );
});

test("a handler that publishes doesn't re-enter publish()", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe("RAM_CRITICAL", (e) => {
    order.push("critical-handler");
    bus.publish(vmEvent("RAM_EMERGENCY", e.data.vmid));
    order.push("after-nested-publish");
  });
  bus.subscribe("RAM_EMERGENCY", () => void order.push("emergency-handler"));

  bus.publish(ramCritical());
  order.push("after-publish");
  await bus.drain();
  assert.deepEqual(order, ["after-publish", "critical-handler", "after-nested-publish", "emergency-handler"]);
});
