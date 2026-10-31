import { test } from "node:test";
import assert from "node:assert/strict";
import { measuredHostRamMB, placementConfig } from "./placementDeps";

test("HOST_RAM_RESERVE_MB is 1536 unless set, and a bad value is refused", () => {
  const before = process.env.HOST_RAM_RESERVE_MB;
  try {
    delete process.env.HOST_RAM_RESERVE_MB;
    assert.equal(placementConfig().hostRamReserveMB, 1536);
    process.env.HOST_RAM_RESERVE_MB = "2048";
    assert.equal(placementConfig().hostRamReserveMB, 2048);
    for (const bad of ["0", "-1", "lots"]) {
      process.env.HOST_RAM_RESERVE_MB = bad;
      assert.throws(() => placementConfig(), /HOST_RAM_RESERVE_MB must be a positive number/);
    }
  } finally {
    if (before === undefined) delete process.env.HOST_RAM_RESERVE_MB;
    else process.env.HOST_RAM_RESERVE_MB = before;
  }
});

test("a host reading only counts while the monitor is recent", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const ago = (minutes: number) => new Date(now - minutes * 60_000);
  assert.equal(measuredHostRamMB({ lastSeenAt: ago(1), hostUsedRamMB: 900 }, now), 900);
  assert.equal(measuredHostRamMB({ lastSeenAt: ago(11), hostUsedRamMB: 900 }, now), null, "stale");
  assert.equal(measuredHostRamMB({ lastSeenAt: null, hostUsedRamMB: 900 }, now), null, "never seen");
  assert.equal(measuredHostRamMB({ lastSeenAt: ago(1), hostUsedRamMB: null }, now), null, "no reading");
});
