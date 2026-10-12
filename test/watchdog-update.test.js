const assert = require("node:assert/strict");
const test = require("node:test");

const { freshnessTimestampFromPayload } = require("../scripts/watchdog-update");

test("watchdog reads API runtime freshness metadata first", () => {
  assert.equal(
    freshnessTimestampFromPayload({
      meta: {
        latest_captured_at: "2026-07-19T10:00:00Z",
        latest_generated_at: "2026-07-19T09:59:00Z",
        built_at: "2026-07-19T10:01:00Z",
      },
    }),
    "2026-07-19T10:00:00Z",
  );
});

test("watchdog keeps the static runtime meta fallback shape", () => {
  assert.equal(
    freshnessTimestampFromPayload({
      dataCapturedAt: "2026-07-19T08:00:00Z",
      capturedAt: "2026-07-19T07:59:00Z",
      generatedAt: "2026-07-19T08:01:00Z",
    }),
    "2026-07-19T08:00:00Z",
  );
});

test("watchdog falls back across API freshness fields", () => {
  assert.equal(
    freshnessTimestampFromPayload({
      meta: {
        latest_generated_at: "2026-07-19T09:59:00Z",
        built_at: "2026-07-19T10:01:00Z",
      },
    }),
    "2026-07-19T09:59:00Z",
  );
});
