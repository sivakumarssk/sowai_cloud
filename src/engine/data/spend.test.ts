import { test } from "node:test";
import assert from "node:assert/strict";
import { istMonthStart } from "./spend";

test("the spend month starts at midnight IST on the 1st", () => {
  // 2026-10-21 08:00 UTC → October in IST → 2026-09-30 18:30 UTC
  assert.equal(istMonthStart(new Date("2026-10-21T08:00:00Z")).toISOString(), "2026-09-30T18:30:00.000Z");
  // 2026-10-31 19:00 UTC is already 1 Nov 00:30 IST → November
  assert.equal(istMonthStart(new Date("2026-10-31T19:00:00Z")).toISOString(), "2026-10-31T18:30:00.000Z");
});
