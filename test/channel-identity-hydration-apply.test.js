const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  APPLY_CONFIRMATION,
  buildGeneratedEntriesPayload,
  parseArgs,
  planChannelMetadataHydration,
  validateAuditEnvelope,
  validateOptions,
} = require("../scripts/apply-channel-identity-hydration");

const SCRIPT = path.join(
  __dirname,
  "..",
  "scripts",
  "apply-channel-identity-hydration.js",
);
const CHANNEL_A = "UCabcdefghijklmnopqrstuv";
const CHANNEL_B = "UCzyxwvutsrqponmlkjihgfe";
const FELICIA_ID = "UClHap4tvcYZnyiqgAyEs0BQ";

test("unique strong identity is added while Felicia and manual queues are skipped", () => {
  const audit = auditFixture({
    highConfidence: [
      candidateFixture(),
      candidateFixture({
        groupKey: "name:felicia",
        channelId: FELICIA_ID,
        handle: "/@FeliciaLulufleur",
        displayName: "Felicia Ch",
        disposition: "excluded_known_positive",
      }),
    ],
    ambiguous: [
      manualCandidate("name:ambiguous", "ambiguous"),
    ],
    unresolved: [
      manualCandidate("name:unresolved", "unresolved"),
    ],
    deliverableCount: 1,
  });
  const planned = planChannelMetadataHydration(
    audit,
    metadataFixture([]),
    {
      expectedDeliverableCount: 1,
      now: new Date("2026-07-26T00:00:00.000Z"),
    },
  );
  assert.equal(planned.stats.added, 1);
  assert.equal(planned.stats.excluded, 1);
  assert.equal(planned.stats.ambiguous, 1);
  assert.equal(planned.stats.unresolved, 1);
  assert.equal(planned.metadataAfter.channels.length, 1);
  assert.equal(planned.metadataAfter.channels[0].channelId, CHANNEL_A);
  const generated = buildGeneratedEntriesPayload(planned, {
    now: new Date("2026-07-26T00:00:00.000Z"),
  });
  assert.equal(generated.entryCount, 1);
  assert.deepEqual(generated.channels[0], {
    handle: "/@fixture",
    displayName: "Fixture Canonical",
    channelId: CHANNEL_A,
    channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
    sourceUrl: "https://www.youtube.com/@fixture",
    avatarUrl: "",
    thumbnailUrl:
      "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
  });
  assert.equal(
    planned.metadataAfter.channels.some(
      (channel) => channel.channelId === FELICIA_ID,
    ),
    false,
  );
});

test("existing strong identity conflict fails closed for that candidate", () => {
  const existing = {
    handle: "/@fixture",
    displayName: "Existing Other Channel",
    channelId: CHANNEL_B,
    channelUrl: `https://www.youtube.com/channel/${CHANNEL_B}`,
    sourceUrl: "https://www.youtube.com/@fixture",
    avatarUrl: "https://yt3.googleusercontent.com/existing",
    thumbnailUrl: "",
  };
  const metadata = metadataFixture([existing]);
  const planned = planChannelMetadataHydration(
    auditFixture(),
    metadata,
    { expectedDeliverableCount: 1 },
  );
  assert.equal(planned.stats.conflicts, 1);
  assert.equal(planned.stats.changed, 0);
  assert.deepEqual(planned.metadataAfter, metadata);
  assert.equal(
    planned.results.find((result) => result.status === "conflict")
      .reason,
    "existing_strong_identity_conflict",
  );
});

test("stale linked handle conflicts fail closed without rewriting URLs", () => {
  const existing = metadataEntry();
  existing.sourceUrl = "https://www.youtube.com/@stale_handle";
  const metadata = metadataFixture([existing]);
  const planned = planChannelMetadataHydration(
    auditFixture(),
    metadata,
    { expectedDeliverableCount: 1 },
  );
  assert.equal(planned.stats.conflicts, 1);
  assert.equal(planned.stats.changed, 0);
  assert.deepEqual(planned.metadataAfter, metadata);
});

test("partial existing entry fills only missing identity fields", () => {
  const existing = {
    handle: "/@fixture",
    displayName: "Preserved Existing Name",
    channelId: CHANNEL_A,
    channelUrl: "",
    sourceUrl: "",
    avatarUrl: "https://yt3.googleusercontent.com/existing",
    thumbnailUrl: "https://i.ytimg.com/vi/existing001/hqdefault.jpg",
  };
  const planned = planChannelMetadataHydration(
    auditFixture(),
    metadataFixture([existing]),
    {
      expectedDeliverableCount: 1,
      now: new Date("2026-07-26T01:00:00.000Z"),
    },
  );
  const hydrated = planned.metadataAfter.channels[0];
  assert.equal(planned.stats.filled, 1);
  assert.equal(planned.stats.fieldsFilled, 2);
  assert.equal(
    hydrated.channelUrl,
    `https://www.youtube.com/channel/${CHANNEL_A}`,
  );
  assert.equal(
    hydrated.sourceUrl,
    "https://www.youtube.com/@fixture",
  );
  assert.equal(hydrated.displayName, "Preserved Existing Name");
  assert.equal(
    hydrated.avatarUrl,
    "https://yt3.googleusercontent.com/existing",
  );
  assert.equal(
    hydrated.thumbnailUrl,
    "https://i.ytimg.com/vi/existing001/hqdefault.jpg",
  );
});

test("complete existing identity is byte-for-byte business-field unchanged", () => {
  const existing = metadataEntry();
  const metadata = metadataFixture([existing]);
  const planned = planChannelMetadataHydration(
    auditFixture(),
    metadata,
    { expectedDeliverableCount: 1 },
  );
  assert.equal(planned.stats.unchanged, 1);
  assert.equal(planned.stats.changed, 0);
  assert.deepEqual(planned.metadataAfter, metadata);
  assert.equal(planned.before.sha256, planned.after.sha256);
});

test("second application is idempotent with changed zero", () => {
  const first = planChannelMetadataHydration(
    auditFixture(),
    metadataFixture([]),
    {
      expectedDeliverableCount: 1,
      now: new Date("2026-07-26T02:00:00.000Z"),
    },
  );
  const second = planChannelMetadataHydration(
    auditFixture(),
    first.metadataAfter,
    {
      expectedDeliverableCount: 1,
      now: new Date("2026-07-26T03:00:00.000Z"),
    },
  );
  assert.equal(first.stats.changed, 1);
  assert.equal(second.stats.changed, 0);
  assert.equal(second.stats.unchanged, 1);
  assert.deepEqual(second.metadataAfter, first.metadataAfter);
  assert.equal(second.before.sha256, second.after.sha256);
});

test("duplicate candidates with the same unique mapping create one entry", () => {
  const duplicate = candidateFixture({
    groupKey: "name:renamed-fixture",
    displayName: "Fixture Renamed",
  });
  const planned = planChannelMetadataHydration(
    auditFixture({
      highConfidence: [candidateFixture(), duplicate],
      deliverableCount: 2,
    }),
    metadataFixture([]),
    { expectedDeliverableCount: 2 },
  );
  assert.equal(planned.stats.added, 1);
  assert.equal(planned.stats.duplicateCandidates, 1);
  assert.equal(planned.metadataAfter.channels.length, 1);
});

test("partial shards and expected-count mismatches are rejected", () => {
  const partial = auditFixture();
  partial.shard = { index: 0, count: 8, merged: false };
  assert.throws(
    () => validateAuditEnvelope(partial, 1),
    /merged full-run/u,
  );
  assert.throws(
    () => validateAuditEnvelope(auditFixture(), 492),
    /Expected 492 deliverable candidates, got 1/u,
  );
});

test("apply mode requires explicit confirmation and expected count", () => {
  const noConfirmation = parseArgs([
    "--candidates",
    "fixture.json",
    "--apply-metadata",
    "--expected-deliverable-count",
    "1",
  ]);
  assert.throws(
    () => validateOptions(noConfirmation),
    /requires --confirm-apply/u,
  );
  const valid = parseArgs([
    "--candidates",
    "fixture.json",
    "--apply-metadata",
    "--confirm-apply",
    APPLY_CONFIRMATION,
    "--expected-deliverable-count",
    "1",
  ]);
  assert.doesNotThrow(() => validateOptions(valid));
});

test("CLI dry-run preserves metadata and explicit apply is idempotent", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "channel-identity-hydration-apply-"),
  );
  const candidatesPath = path.join(tempDir, "candidates.json");
  const metadataPath = path.join(tempDir, "channel-metadata.json");
  fs.writeFileSync(
    candidatesPath,
    `${JSON.stringify(auditFixture(), null, 2)}\n`,
  );
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(metadataFixture([]), null, 2)}\n`,
  );
  const before = fs.readFileSync(metadataPath, "utf8");

  const dryRun = runCli([
    "--candidates",
    candidatesPath,
    "--metadata",
    metadataPath,
    "--output-dir",
    path.join(tempDir, "dry-run"),
    "--expected-deliverable-count",
    "1",
  ]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dryRun=true/u);
  assert.equal(fs.readFileSync(metadataPath, "utf8"), before);

  const refused = runCli([
    "--candidates",
    candidatesPath,
    "--metadata",
    metadataPath,
    "--apply-metadata",
    "--expected-deliverable-count",
    "1",
  ]);
  assert.equal(refused.status, 1);
  assert.equal(fs.readFileSync(metadataPath, "utf8"), before);

  const applyArgs = [
    "--candidates",
    candidatesPath,
    "--metadata",
    metadataPath,
    "--apply-metadata",
    "--confirm-apply",
    APPLY_CONFIRMATION,
    "--expected-deliverable-count",
    "1",
  ];
  const first = runCli([
    ...applyArgs,
    "--output-dir",
    path.join(tempDir, "apply"),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /changed=1/u);
  const afterFirst = fs.readFileSync(metadataPath, "utf8");
  assert.notEqual(afterFirst, before);

  const second = runCli([
    ...applyArgs,
    "--output-dir",
    path.join(tempDir, "reapply"),
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /changed=0/u);
  assert.equal(fs.readFileSync(metadataPath, "utf8"), afterFirst);
});

function auditFixture(options = {}) {
  const highConfidence =
    options.highConfidence || [candidateFixture()];
  const ambiguous = options.ambiguous || [];
  const unresolved = options.unresolved || [];
  const deliverableCount =
    options.deliverableCount ??
    highConfidence.filter(
      (candidate) =>
        candidate.deliveryDisposition === "review_then_hydrate" &&
        candidate.proposed.channelId !== FELICIA_ID,
    ).length;
  return {
    schemaVersion: 1,
    source: {
      kind: "fixture",
      meta: { sourceCommitSha: "fixture-source" },
    },
    shard: { index: 0, count: 1, merged: true },
    summary: {
      deliverableHighConfidenceCount: deliverableCount,
      ambiguousCount: ambiguous.length,
      unresolvedCount: unresolved.length,
    },
    highConfidence,
    ambiguous,
    unresolved,
  };
}

function candidateFixture(options = {}) {
  const channelId = options.channelId || CHANNEL_A;
  const handle = options.handle || "/@fixture";
  return {
    classification: "high-confidence",
    groupKey: options.groupKey || "name:fixture",
    sourceNames: [options.sourceName || "Fixture Old Name"],
    sampledVideoIds: ["abcdefghijk"],
    proposed: {
      channelId,
      channelHandle: handle,
      channelUrl: `https://www.youtube.com/channel/${channelId}`,
      sourceUrl: `https://www.youtube.com${handle}`,
      displayName: options.displayName || "Fixture Canonical",
    },
    confidenceReason: "official_identity_confirmed",
    deliveryDisposition:
      options.disposition || "review_then_hydrate",
    evidence: {
      direct: [
        {
          kind: "youtube_watch",
          videoId: "abcdefghijk",
          channelId,
        },
      ],
    },
  };
}

function manualCandidate(groupKey, classification) {
  return {
    classification,
    groupKey,
    sourceNames: [groupKey],
    proposed: null,
    deliveryDisposition: "manual_review",
  };
}

function metadataFixture(channels) {
  return {
    schemaVersion: 1,
    sourceSystem: "youtube_channel_discovery",
    generatedAt: "2026-07-25T00:00:00.000Z",
    source: { kind: "fixture" },
    channels,
  };
}

function metadataEntry() {
  return {
    handle: "/@fixture",
    displayName: "Preserved Existing Name",
    channelId: CHANNEL_A,
    channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
    sourceUrl: "https://www.youtube.com/@fixture",
    avatarUrl: "https://yt3.googleusercontent.com/existing",
    thumbnailUrl: "https://i.ytimg.com/vi/existing001/hqdefault.jpg",
    avatarFetchedAt: "2026-07-25T00:00:00.000Z",
    avatarFetchStatus: "fetched",
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}
