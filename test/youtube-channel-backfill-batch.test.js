const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  assertSafeCleanOutputRoot,
  discoveryArgs,
  parseArgs,
  safeSlug,
  selectTargets,
  summarizeManifest,
} = require("../scripts/run-youtube-channel-backfill-batch");

test("batch runner parses bounded options", () => {
  const args = parseArgs([
    "--target",
    "RirisyaMusic",
    "--max-channel-pages",
    "2",
    "--max-candidates",
    "3",
    "--max-inspect",
    "4",
    "--inspect-max-attempts",
    "1",
    "--per-channel-timeout-ms",
    "60000",
    "--audit-exceptions",
    "config/youtube-channel-import-audit-exceptions.json",
    "--no-export",
  ]);

  assert.deepEqual(args.channels, ["RirisyaMusic"]);
  assert.equal(args.maxChannelPages, 2);
  assert.equal(args.maxCandidates, 3);
  assert.equal(args.maxInspect, 4);
  assert.equal(args.inspectMaxAttempts, 1);
  assert.equal(args.perChannelTimeoutMs, 60000);
  assert.ok(args.auditExceptionsPath.endsWith(path.join("config", "youtube-channel-import-audit-exceptions.json")));
  assert.equal(args.noExport, true);
});

test("batch runner selects targets by slug or URL and builds discovery args", () => {
  const targets = [
    { slug: "RirisyaMusic", channelUrl: "https://www.youtube.com/@RirisyaMusic", singerName: "Ririsya", tabs: [] },
    { slug: "KumahachiEma", channelUrl: "https://www.youtube.com/@KumahachiEma/streams", singerName: "Kumahachi", tabs: ["streams"] },
  ];
  const selected = selectTargets(targets, ["https://www.youtube.com/@KumahachiEma/streams"]);
  const args = parseArgs(["--max-channel-pages", "1", "--max-candidates", "0", "--max-inspect", "2", "--inspect-max-attempts", "1", "--candidate-only"]);
  const commandArgs = discoveryArgs(selected[0], args, path.resolve("artifacts/channel-discovery/source-rescan/KumahachiEma"));

  assert.equal(selected.length, 1);
  assert.equal(selected[0].slug, "KumahachiEma");
  assert.ok(commandArgs.includes("--channel-url"));
  assert.ok(commandArgs.includes("https://www.youtube.com/@KumahachiEma/streams"));
  assert.ok(commandArgs.includes("--tab"));
  assert.ok(commandArgs.includes("streams"));
  assert.ok(commandArgs.includes("--candidate-only"));
  assert.equal(commandArgs[commandArgs.indexOf("--inspect-max-attempts") + 1], "1");
});

test("batch runner summaries and safe clean guard stay bounded", () => {
  assert.equal(safeSlug("https://www.youtube.com/@RirisyaMusic/streams"), "www.youtube.com-@RirisyaMusic-streams");
  assert.doesNotThrow(() => assertSafeCleanOutputRoot(path.resolve("artifacts/channel-discovery/source-rescan")));
  assert.throws(() => assertSafeCleanOutputRoot(path.resolve(".")), /refusing to clean/u);

  const summary = summarizeManifest({
    channels: {
      a: {
        status: "completed",
        timedOut: false,
        discovery: { candidateCount: 2, inspectedInLatestRun: 1, usableVideoCount: 1, occurrenceCount: 3 },
        import: { imported: 1, skipped: 0, failed: 0, suspicious: 2, increments: { videos: 1, songs: 2, occurrences: 3 } },
      },
      b: {
        status: "failed",
        timedOut: true,
        discovery: { candidateCount: 4, inspectedInLatestRun: 2, usableVideoCount: 0, occurrenceCount: 0 },
      },
    },
  });

  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.suspicious, 2);
  assert.equal(summary.importedVideos, 1);
  assert.equal(summary.importedOccurrences, 3);
});
