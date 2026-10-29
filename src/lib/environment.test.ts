import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEnvironment, environmentProblems, isLiveEnvironment, productionOnlyProblem } from "./environment";

const dev = { APP_ENV: "development", RAZORPAY_KEY_ID: "rzp_test_abc", NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_abc", PROVISIONER: "simulated" };
const prod = { APP_ENV: "production", RAZORPAY_KEY_ID: "rzp_live_abc", NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_live_abc", PROVISIONER: "proxmox", HETZNER_API_TOKEN: "h", PROXMOX_TOKEN_ID: "t", PROXMOX_TOKEN_SECRET: "s" };

test("APP_ENV must say development or production", () => {
  for (const APP_ENV of [undefined, "", "prod", "Production", "staging"]) {
    assert.throws(() => assertEnvironment({ ...dev, APP_ENV }), /APP_ENV is/, String(APP_ENV));
  }
  assert.doesNotThrow(() => assertEnvironment(dev));
  assert.doesNotThrow(() => assertEnvironment(prod));
});

test("development refuses a live Razorpay key, real infrastructure tokens without ALLOW_REAL_INFRA=1, and any provisioner but the simulator", () => {
  assert.match(environmentProblems({ ...dev, RAZORPAY_KEY_ID: "rzp_live_x" }).join(), /^RAZORPAY_KEY_ID is a live Razorpay key/);
  assert.match(environmentProblems({ ...dev, NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_live_x" }).join(), /NEXT_PUBLIC_RAZORPAY_KEY_ID is a live Razorpay key/);

  for (const token of ["HETZNER_API_TOKEN", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET"]) {
    assert.match(environmentProblems({ ...dev, [token]: "x" }).join(), new RegExp(`${token} is set.*ALLOW_REAL_INFRA=1`), token);
    assert.deepEqual(environmentProblems({ ...dev, [token]: "x", ALLOW_REAL_INFRA: "1" }), [], `${token} with ALLOW_REAL_INFRA=1`);
    assert.equal(environmentProblems({ ...dev, [token]: "x", ALLOW_REAL_INFRA: "true" }).length, 1, "only the exact value 1");
  }
  assert.deepEqual(environmentProblems({ ...dev, HETZNER_API_TOKEN: "   " }), [], "an empty token is no token");

  for (const PROVISIONER of [undefined, "", "proxmox", "Simulated"]) {
    assert.match(environmentProblems({ ...dev, PROVISIONER }).join(), /development requires PROVISIONER=simulated/, String(PROVISIONER));
  }
  // Even with ALLOW_REAL_INFRA=1, development never builds real servers for orders.
  assert.match(environmentProblems({ ...dev, ALLOW_REAL_INFRA: "1", PROVISIONER: "proxmox" }).join(), /PROVISIONER=simulated/);
});

test("production refuses a test Razorpay key and any provisioner but proxmox", () => {
  assert.match(environmentProblems({ ...prod, RAZORPAY_KEY_ID: "rzp_test_x" }).join(), /^RAZORPAY_KEY_ID \(rzp_test_…\) is not a live key/);
  assert.match(environmentProblems({ ...prod, NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_x" }).join(), /not a live key/);
  assert.match(environmentProblems({ ...prod, RAZORPAY_KEY_ID: undefined, NEXT_PUBLIC_RAZORPAY_KEY_ID: undefined }).join(), /RAZORPAY_KEY_ID is not set/);
  for (const PROVISIONER of [undefined, "simulated", "Proxmox"]) {
    assert.match(environmentProblems({ ...prod, PROVISIONER }).join(), /production requires PROVISIONER=proxmox/, String(PROVISIONER));
  }
  // The secret part of a key is never printed.
  assert.doesNotMatch(environmentProblems({ ...prod, RAZORPAY_KEY_ID: "rzp_test_SECRETPART" }).join(), /SECRETPART/);
});

test("the billing cron and the engine run only in a valid production environment", () => {
  assert.equal(productionOnlyProblem("the billing cron", prod), null);
  assert.match(productionOnlyProblem("the billing cron", dev)!, /Refusing to run the billing cron: it only runs with APP_ENV=production \(this is development\)/);
  assert.match(productionOnlyProblem("the engine", { ...dev, APP_ENV: undefined })!, /this is unset/);
  assert.match(productionOnlyProblem("the engine", { ...prod, PROVISIONER: "simulated" })!, /PROVISIONER=proxmox/);
});

test("live = production or taking real money", () => {
  assert.equal(isLiveEnvironment(prod), true);
  assert.equal(isLiveEnvironment(dev), false);
  assert.equal(isLiveEnvironment({ ...dev, RAZORPAY_KEY_ID: "rzp_live_x" }), true);
});
