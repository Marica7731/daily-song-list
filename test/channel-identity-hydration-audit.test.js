const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildMetadataContext,
  classifyGroup,
  groupMissingIdentityRecords,
  mergeReports,
  normalizeSourceRecords,
  parseArgs,
  parseChannelPage,
  parseWatchPage,
  runAudit,
} = require("../scripts/audit-channel-identity-hydration");

const CHANNEL_A = "UCabcdefghijklmnopqrstuv";
const CHANNEL_B = "UCzyxwvutsrqponmlkjihgfe";

test("official watch and channel HTML parsers recover strong and canonical identity", () => {
  const videoId = "abcdefghijk";
  const watch = parseWatchPage(
    `<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: {
        videoId,
        channelId: CHANNEL_A,
        author: "Old Romanized Name",
      },
    })};</script></html>`,
    `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  );
  assert.deepEqual(watch, {
    channelId: CHANNEL_A,
    author: "Old Romanized Name",
    reason: "",
  });

  const channel = parseChannelPage(
    `<html>
      <meta property="og:title" content="æ–°ã—ã„åå‰ / New Name">
      <link rel="canonical" href="https://www.youtube.com/@new_handle">
      <script>{"channelMetadataRenderer":{"title":"æ–°ã—ã„åå‰ / New Name","externalId":"${CHANNEL_A}"},"canonicalBaseUrl":"/@new_handle"}</script>
    </html>`,
    `https://www.youtube.com/channel/${CHANNEL_A}`,
  );
  assert.equal(channel.channelId, CHANNEL_A);
  assert.equal(channel.channelHandle, "/@new_handle");
  assert.equal(channel.channelUrl, `https://www.youtube.com/channel/${CHANNEL_A}`);
  assert.equal(channel.sourceUrl, "https://www.youtube.com/@new_handle");
});

test("missing identity records are grouped provisionally and retain ranking counts", () => {
  const inventory = groupMissingIdentityRecords([
    {
      videoId: "abcdefghijk",
      videoIds: ["abcdefghijk"],
      channelName: "Felicia Ch",
      channelId: "",
      channelHandle: "",
      channelUrl: "",
      sourceUrl: "",
      occurrenceCount: 10,
      videoCount: 1,
    },
    {
      videoId: "lmnopqrstuv",
      videoIds: ["lmnopqrstuv"],
      channelName: "Felicia Ch",
      channelId: "",
      channelHandle: "",
      channelUrl: "",
      sourceUrl: "",
      occurrenceCount: 20,
      videoCount: 1,
    },
  ]);
  assert.equal(inventory.summary.missingRecordCount, 2);
  assert.equal(inventory.summary.missingAllIdentityCount, 2);
  assert.equal(inventory.groups.length, 1);
  assert.equal(inventory.groups[0].videoCount, 2);
  assert.equal(inventory.groups[0].occurrenceCount, 30);
  assert.deepEqual(inventory.groups[0].missingFieldCounts, {
    channelId: 2,
    channelHandle: 2,
    channelUrl: 2,
  });
});

test("field coverage audits stored handle and URL fields instead of silently deriving them", () => {
  const records = normalizeSourceRecords({
    view: "videos",
    records: [
      {
        videoId: "abcdefghijk",
        channelName: "Partial Identity",
        channelId: CHANNEL_A,
        channelHandle: "",
        channelUrl: "",
        sourceUrl: "https://www.youtube.com/@partial_identity",
        count: 2,
      },
      {
        videoId: "lmnopqrstuv",
        channelName: "URL Identity",
        channelId: "",
        channelHandle: "",
        channelUrl: "https://www.youtube.com/@url_identity",
        count: 3,
      },
      {
        videoId: "zyxwvutsrqp",
        channelName: "Invalid Stored URL",
        channelId: "",
        channelHandle: "",
        channelUrl: "https://example.invalid/not-a-youtube-channel",
        count: 4,
      },
    ],
  });
  assert.equal(records[0].channelHandle, "");
  assert.equal(records[1].channelHandle, "");
  const inventory = groupMissingIdentityRecords(records);
  assert.equal(inventory.summary.missingRecordCount, 3);
  assert.equal(inventory.summary.fieldCoverageBefore.fields.channelUrl.present, 1);
  const partial = inventory.groups.find((group) => group.groupKey === `id:${CHANNEL_A}`);
  assert.deepEqual(partial.missingFieldCounts, {
    channelId: 0,
    channelHandle: 1,
    channelUrl: 1,
  });
  const fromUrl = inventory.groups.find((group) => group.groupKey === "handle:/@url_identity");
  assert.deepEqual(fromUrl.missingFieldCounts, {
    channelId: 1,
    channelHandle: 1,
    channelUrl: 0,
  });
  const invalidUrl = inventory.groups.find((group) => group.groupKey === "name:invalid stored url");
  assert.deepEqual(invalidUrl.missingFieldCounts, {
    channelId: 1,
    channelHandle: 1,
    channelUrl: 1,
  });
});

test("high confidence requires watch identity plus canonical channel confirmation and can exclude a known positive", async () => {
  const group = fixtureGroup("Felicia Ch", ["abcdefghijk", "lmnopqrstuv"]);
  const result = await classifyGroup(group, {
    cacheContext: buildMetadataContext([]),
    maxVideosPerGroup: 2,
    excludeNames: ["Felicia"],
    resolver: {
      resolveVideo: async (videoId) => ({
        status: "resolved",
        videoId,
        channelId: CHANNEL_A,
        author: "Old Name",
        source: "fixture",
      }),
      resolveChannelById: async () => ({
        status: "resolved",
        channelId: CHANNEL_A,
        channelHandle: "/@felicia_canonical",
        channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
        displayName: "ãƒ•ã‚§ãƒªã‚·ã‚¢ / Felicia Ch",
        sourceUrl: "https://www.youtube.com/@felicia_canonical",
      }),
      resolveChannelByHandle: async () => {
        throw new Error("unexpected handle lookup");
      },
    },
  });
  assert.equal(result.classification, "high-confidence");
  assert.equal(result.deliveryDisposition, "excluded_known_positive");
  assert.equal(result.proposed.channelId, CHANNEL_A);
  assert.equal(result.proposed.channelHandle, "/@felicia_canonical");
  assert.equal(result.evidence.direct.filter((item) => item.kind === "youtube_watch").length, 2);
});

test("conflicting watch identities remain ambiguous", async () => {
  const group = fixtureGroup("Shared Display Name", ["abcdefghijk", "lmnopqrstuv"]);
  const ids = new Map([
    ["abcdefghijk", CHANNEL_A],
    ["lmnopqrstuv", CHANNEL_B],
  ]);
  const result = await classifyGroup(group, {
    cacheContext: buildMetadataContext([]),
    maxVideosPerGroup: 2,
    excludeNames: [],
    resolver: {
      resolveVideo: async (videoId) => ({
        status: "resolved",
        videoId,
        channelId: ids.get(videoId),
        source: "fixture",
      }),
      resolveChannelById: async () => {
        throw new Error("conflicts must stop before channel lookup");
      },
      resolveChannelByHandle: async () => {
        throw new Error("unexpected handle lookup");
      },
    },
  });
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.confidenceReason, "conflicting_strong_identities");
});

test("display-name-only cache hints never become high confidence", async () => {
  const group = fixtureGroup("Same Name", ["abcdefghijk"]);
  const result = await classifyGroup(group, {
    cacheContext: buildMetadataContext([
      {
        displayName: "Same Name",
        channelId: CHANNEL_A,
        handle: "@same_name",
        channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
      },
    ]),
    maxVideosPerGroup: 1,
    excludeNames: [],
    resolver: {
      resolveVideo: async (videoId) => ({
        status: "unresolved",
        videoId,
        reason: "private_video",
        source: "fixture",
      }),
      resolveChannelById: async () => {
        throw new Error("name-only hint must not be promoted");
      },
      resolveChannelByHandle: async () => {
        throw new Error("name-only hint must not be promoted");
      },
    },
  });
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.confidenceReason, "canonical_channel_unconfirmed");
  assert.equal(result.evidence.nameOnlyCacheHints.length, 1);
});

test("deleted or private videos without another identity source remain unresolved", async () => {
  const result = await classifyGroup(fixtureGroup("Unavailable Channel", ["abcdefghijk"]), {
    cacheContext: buildMetadataContext([]),
    maxVideosPerGroup: 1,
    excludeNames: [],
    resolver: {
      resolveVideo: async (videoId) => ({
        status: "unresolved",
        videoId,
        reason: "private_or_deleted",
        source: "fixture",
      }),
      resolveChannelById: async () => {
        throw new Error("unexpected channel lookup");
      },
      resolveChannelByHandle: async () => {
        throw new Error("unexpected handle lookup");
      },
    },
  });
  assert.equal(result.classification, "unresolved");
  assert.equal(result.confidenceReason, "no_channel_identity_evidence");
});

test("runAudit writes review JSON, Markdown, checkpoint, manifest, and completion state without metadata mutation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-identity-audit-"));
  const inputPath = path.join(tempDir, "runtime.json");
  const metadataPath = path.join(tempDir, "channel-metadata.json");
  const outputDir = path.join(tempDir, "output");
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      view: "videos",
      records: [
        {
          videoId: "abcdefghijk",
          channelName: "Fixture Channel",
          channelId: "",
          channelHandle: "",
          channelUrl: "",
          count: 4,
        },
      ],
    }),
  );
  fs.writeFileSync(metadataPath, `${JSON.stringify({ channels: [] }, null, 2)}\n`);
  const metadataBefore = fs.readFileSync(metadataPath, "utf8");
  const options = parseArgs([
    "--input-json",
    inputPath,
    "--metadata",
    metadataPath,
    "--output-dir",
    outputDir,
    "--exclude-name",
    "Fixture",
  ]);
  const fetchImpl = async (url) => {
    if (url.includes("/watch?")) {
      return fakeResponse(
        url,
        `<script>var ytInitialPlayerResponse = ${JSON.stringify({
          playabilityStatus: {
            status: "LOGIN_REQUIRED",
            reason: "Sign in to confirm you're not a bot",
          },
          videoDetails: {
            videoId: "abcdefghijk",
          },
        })};</script>`,
      );
    }
    if (url.includes("/oembed?")) {
      return fakeResponse(
        url,
        JSON.stringify({
          author_name: "Fixture Old",
          author_url: "https://www.youtube.com/@fixture",
        }),
      );
    }
    if (url.includes("/@fixture")) {
      return fakeResponse(
        url,
        `<script>{"channelMetadataRenderer":{"title":"Fixture Canonical","externalId":"${CHANNEL_A}"},"canonicalBaseUrl":"/@fixture"}</script>`,
      );
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const report = await runAudit(options, { fetchImpl });
  assert.equal(report.highConfidence.length, 1);
  assert.equal(report.highConfidence[0].deliveryDisposition, "excluded_known_positive");
  assert.equal(report.highConfidence[0].evidence.direct[0].kind, "youtube_oembed");
  assert.equal(fs.readFileSync(metadataPath, "utf8"), metadataBefore);
  assert.equal(JSON.parse(fs.readFileSync(options.manifestPath, "utf8")).status, "completed");
  const checkpoint = JSON.parse(fs.readFileSync(options.checkpointPath, "utf8"));
  assert.equal(checkpoint.videos.abcdefghijk.status, "resolved");
  assert.equal(checkpoint.videos.abcdefghijk.source, "youtube_oembed");
  assert.match(fs.readFileSync(options.outputMarkdown, "utf8"), /write\/import\/deploy mode/u);
  assert.equal(JSON.parse(fs.readFileSync(options.outputJson, "utf8")).dryRun, true);
});

test("shard reports merge without double-counting candidates and recompute projected coverage", () => {
  const base = {
    schemaVersion: 1,
    generatedAt: "2026-07-26T00:00:00.000Z",
    source: { kind: "fixture", meta: {} },
    shard: { index: 0, count: 2 },
    summary: {
      sourceRecordCount: 2,
      missingRecordCount: 2,
      fieldCoverageBefore: {
        totalRecords: 2,
        fields: {
          channelId: { present: 0, missing: 2, percent: 0 },
          channelHandle: { present: 0, missing: 2, percent: 0 },
          channelUrl: { present: 0, missing: 2, percent: 0 },
        },
      },
    },
    rankings: { byVideoCount: [], byOccurrenceCount: [] },
    ambiguous: [],
    unresolved: [],
  };
  const candidate = {
    classification: "high-confidence",
    groupKey: "name:fixture",
    videoCount: 1,
    occurrenceCount: 2,
    missingFieldCounts: { channelId: 1, channelHandle: 1, channelUrl: 1 },
    deliveryDisposition: "review_then_hydrate",
    evidence: { direct: [{ kind: "youtube_watch" }], failures: [] },
  };
  const merged = mergeReports([
    { ...base, highConfidence: [candidate] },
    { ...base, shard: { index: 1, count: 2 }, highConfidence: [candidate] },
  ]);
  assert.equal(merged.highConfidence.length, 1);
  assert.equal(merged.summary.deliverableHighConfidenceCount, 1);
  assert.equal(merged.summary.projectedCoverageAfterHighConfidence.fields.channelId.present, 1);
  assert.equal(
    merged.summary.projectedCoverageAfterDeliverableHighConfidence.fields.channelId.present,
    1,
  );
});

test("CLI rejects mutation flags", () => {
  assert.throws(() => parseArgs(["--apply"]), /intentionally unsupported/u);
});

function fixtureGroup(name, videoIds) {
  return {
    groupKey: `name:${name.toLowerCase()}`,
    sourceNames: [name],
    records: videoIds.map((videoId) => ({
      videoId,
      videoIds: [videoId],
      channelName: name,
      channelId: "",
      channelHandle: "",
      channelUrl: "",
      sourceUrl: "",
    })),
    videoIds,
    recordCount: videoIds.length,
    videoCount: videoIds.length,
    occurrenceCount: videoIds.length * 2,
    missingFieldCounts: {
      channelId: videoIds.length,
      channelHandle: videoIds.length,
      channelUrl: videoIds.length,
    },
  };
}

function fakeResponse(url, body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => body,
  };
}
