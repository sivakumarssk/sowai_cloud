import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, loadEngineSettings, stricter, DEFAULT_ACTION_MODES, type EngineSettings, type GateInput } from "./policy";

const settings = (over: Partial<EngineSettings> = {}): EngineSettings => ({
  mode: "AUTO",
  actions: { ...DEFAULT_ACTION_MODES },
  spendCapPaise: 500_000,
  ...over,
});
const verdict = (input: Partial<GateInput>) =>
  gate({ kind: "RAM_SCALE", settings: settings(), monthlyCostPaise: 0, spentThisMonthPaise: 0, trigger: "AUTO_ENGINE", ...input }).verdict;

test("defaults are OBSERVE with the agreed per-action modes and a ₹5,000 cap", () => {
  const s = loadEngineSettings({});
  assert.equal(s.mode, "OBSERVE");
  assert.deepEqual(s.actions, {
    RAM_SCALE: "AUTO",
    DISK_EXPAND: "ASSISTED",
    VOLUME_PURCHASE: "MANUAL",
    SERVER_PURCHASE: "MANUAL",
    MIGRATION: "ASSISTED",
    OVERAGE_BILLING: "OFF",
    NOTIFY_CLIENT: "ASSISTED",
    ALERT_ADMIN: "AUTO",
    STOP_SIGNUPS: "AUTO",
  });
  assert.equal(s.spendCapPaise, 500_000);
});

test("OBSERVE overrides every action setting — even RAM scaling set to AUTO only logs", () => {
  const observe = settings({ mode: "OBSERVE" });
  for (const kind of ["RAM_SCALE", "DISK_EXPAND", "VOLUME_PURCHASE", "SERVER_PURCHASE", "MIGRATION"] as const) {
    assert.equal(verdict({ kind, settings: observe }), "LOG_ONLY", kind);
  }
});

test("the stricter of global mode and action mode wins", () => {
  assert.equal(stricter("AUTO", "ASSISTED"), "ASSISTED");
  assert.equal(stricter("MANUAL", "ASSISTED"), "MANUAL");
  // Global ASSISTED + RAM AUTO → ASSISTED
  assert.equal(verdict({ settings: settings({ mode: "ASSISTED" }) }), "REQUEST_APPROVAL");
  // Global AUTO: each action's own default
  assert.equal(verdict({ kind: "RAM_SCALE" }), "EXECUTE");
  assert.equal(verdict({ kind: "DISK_EXPAND" }), "REQUEST_APPROVAL");
  assert.equal(verdict({ kind: "VOLUME_PURCHASE", monthlyCostPaise: 53_000 }), "RECOMMEND");
  assert.equal(verdict({ kind: "SERVER_PURCHASE", monthlyCostPaise: 330_000 }), "RECOMMEND");
  assert.equal(verdict({ kind: "MIGRATION" }), "REQUEST_APPROVAL");
});

test("OFF blocks always — including admin-triggered", () => {
  assert.equal(verdict({ kind: "OVERAGE_BILLING" }), "BLOCKED");
  assert.equal(verdict({ kind: "OVERAGE_BILLING", trigger: "MANUAL" }), "BLOCKED");
});

test("anything over the monthly spend cap needs approval, regardless of mode", () => {
  const autoVolumes = settings({ actions: { ...DEFAULT_ACTION_MODES, VOLUME_PURCHASE: "AUTO" } });
  const under = gate({ kind: "VOLUME_PURCHASE", settings: autoVolumes, monthlyCostPaise: 53_000, spentThisMonthPaise: 400_000, trigger: "AUTO_ENGINE" });
  assert.equal(under.verdict, "REQUEST_APPROVAL");
  assert.match(under.reason, /purchases always need admin approval/);
  const over = gate({
    kind: "VOLUME_PURCHASE",
    settings: autoVolumes,
    monthlyCostPaise: 53_000,
    spentThisMonthPaise: 460_000,
    trigger: "AUTO_ENGINE",
  });
  assert.equal(over.verdict, "REQUEST_APPROVAL");
  assert.match(over.reason, /₹5,130.*₹5,000 cap/);
});

test("admin-triggered actions run (approval given), even in OBSERVE", () => {
  assert.equal(verdict({ kind: "DISK_EXPAND", settings: settings({ mode: "OBSERVE" }), trigger: "MANUAL" }), "EXECUTE");
});

test("settings from env are validated", () => {
  const s = loadEngineSettings({ ENGINE_MODE: "assisted", ENGINE_ACTION_DISK_EXPAND: "auto", ENGINE_SPEND_CAP_PAISE: "250000" });
  assert.equal(s.mode, "ASSISTED");
  assert.equal(s.actions.DISK_EXPAND, "AUTO");
  assert.equal(s.spendCapPaise, 250_000);
  assert.throws(() => loadEngineSettings({ ENGINE_MODE: "YOLO" }), /ENGINE_MODE/);
  assert.throws(() => loadEngineSettings({ ENGINE_ACTION_MIGRATION: "sometimes" }), /ENGINE_ACTION_MIGRATION/);
  assert.throws(() => loadEngineSettings({ ENGINE_SPEND_CAP_PAISE: "5k" }), /ENGINE_SPEND_CAP_PAISE/);
});

test("purchases never run on their own — even set to AUTO, under the cap, in AUTO mode", () => {
  const allAuto = settings({ actions: { ...DEFAULT_ACTION_MODES, VOLUME_PURCHASE: "AUTO", SERVER_PURCHASE: "AUTO" } });
  for (const kind of ["VOLUME_PURCHASE", "SERVER_PURCHASE"] as const) {
    const g = gate({ kind, settings: allAuto, monthlyCostPaise: 53_000, spentThisMonthPaise: 0, trigger: "AUTO_ENGINE" });
    assert.equal(g.verdict, "REQUEST_APPROVAL", kind);
    assert.match(g.reason, /always need admin approval/);
  }
  // An admin can still start one.
  assert.equal(verdict({ kind: "VOLUME_PURCHASE", settings: allAuto, monthlyCostPaise: 53_000, trigger: "MANUAL" }), "EXECUTE");
});

test("non-spend kinds: alerts and stop-signups run in AUTO mode, client emails need approval", () => {
  assert.equal(verdict({ kind: "ALERT_ADMIN" }), "EXECUTE");
  assert.equal(verdict({ kind: "STOP_SIGNUPS" }), "EXECUTE");
  assert.equal(verdict({ kind: "NOTIFY_CLIENT" }), "REQUEST_APPROVAL");
  assert.equal(verdict({ kind: "ALERT_ADMIN", settings: settings({ mode: "OBSERVE" }) }), "LOG_ONLY");
});
