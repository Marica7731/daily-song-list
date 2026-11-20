"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { filterRange } = require("../scripts/static/collect-and-build");

const browserFile = path.join(__dirname, "../assets/static-app.js");
const source = fs.readFileSync(browserFile, "utf8");
const startup = "initTheme();\nstart().catch(showError);";
assert.ok(source.includes(startup), "remove only UI bootstrap for the test");
const { detailRangeBounds } = vm.runInNewContext(
  source.replace(startup, "") + "\n({ detailRangeBounds });",
  { document: { getElementById: () => null } },
  { filename: browserFile },
);

test("7/30-day detail lists use the same inclusive Shanghai window as rankings", () => {
  const fixtures = [
    ["2026-11-20T04:00:00Z", "2026-11-13T16:00:00Z", "2026-10-21T16:00:00Z", "2026-11-20T15:59:59.999Z"],
    ["2026-11-20T15:59:59.999Z", "2026-11-13T16:00:00Z", "2026-10-21T16:00:00Z", "2026-11-20T15:59:59.999Z"],
    ["2026-11-20T16:00:00Z", "2026-11-14T16:00:00Z", "2026-10-22T16:00:00Z", "2026-11-21T15:59:59.999Z"],
    ["2026-01-01T04:00:00Z", "2025-12-25T16:00:00Z", "2025-12-02T16:00:00Z", "2026-01-01T15:59:59.999Z"],
  ];
  for (const [stamp, sevenStart, thirtyStart, endStamp] of fixtures) {
    for (const [days, startStamp] of [[7, sevenStart], [30, thirtyStart]]) {
      const now = new Date(stamp);
      const start = Date.parse(startStamp);
      const end = Date.parse(endStamp);
      const detail = detailRangeBounds(days + "d", now);
      assert.equal(detail.start, start);
      assert.equal(detail.end, end);
      const rows = [start - 1, start, start + 1, end - 1, end, end + 1, now.getTime() + 21600000]
        .map((ms, index) => ({ index, publishedAt: new Date(ms).toISOString() }));
      const ranked = filterRange(rows, now, null, days);
      const displayed = rows.filter(({ publishedAt }) => {
        const ms = Date.parse(publishedAt);
        return ms >= detail.start && ms <= detail.end;
      });
      assert.deepEqual(displayed, ranked);
    }
  }
});

test("today, 3-day, and all detail ranges retain their prior boundaries", () => {
  const now = new Date("2026-11-20T04:00:00Z");
  for (const [range, start, grace] of [
    ["today", Date.parse("2026-11-19T16:00:00Z"), 300000],
    ["3d", Date.parse("2026-11-17T16:00:00Z"), 300000],
    ["all", Number.NEGATIVE_INFINITY, 21600000],
  ]) {
    const bounds = detailRangeBounds(range, now);
    assert.equal(bounds.start, start);
    assert.equal(bounds.end, now.getTime() + grace);
  }
});
