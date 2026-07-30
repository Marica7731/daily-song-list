import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts/migration/derive-curation-conservative-subset.mjs");
const workflow = path.join(repo, ".github/workflows/transport-pg-curation-artifact.yml");
const scratchParent = path.resolve(process.env.CURATION_TRANSPORT_TEST_TMPDIR || os.tmpdir());
const scratch = fs.mkdtempSync(path.join(scratchParent, "curation-artifact-transport-"));
const source = path.join(scratch, "source");
const videoId = "AbCdEf123_-";
const occurrenceId = "fixture-occurrence-unsafe";
const activeRevision = "accepted_fixture_1";
const snapshotSha = "a".repeat(64);
const EXPECTED_FIXTURE_MANIFEST_SHA256 = "9e0277706eb42201959ea93598d06483f8b12e0f2fdc385931cb4f2aa02cc46e";
const EXPECTED_FIXTURE_ROW_SHA256 = "16ba7d1a635bc4697c55995e86c1336143ef0c59e2696664658e7cd543b9afd4";

after(() => {
  assert.ok(scratch.startsWith(`${path.resolve(scratchParent)}${path.sep}`));
  fs.rmSync(scratch, { recursive: true, force: true });
});

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const canonicalSha = (value) => sha(Buffer.from(`${JSON.stringify(canonical(value))}\n`, "utf8"));
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const write = (name, bytes) => fs.writeFileSync(path.join(source, name), bytes);

function extractLiteralRunBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const parentIndent = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const indent = /^(\s*)/.exec(line)[1].length;
      if (line.trim() && indent <= parentIndent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    const contentIndent = Math.min(
      ...body.filter((line) => line.trim()).map((line) => /^(\s*)/.exec(line)[1].length),
    );
    assert.ok(Number.isFinite(contentIndent) && contentIndent > parentIndent);
    blocks.push(body.map((line) => line.slice(Math.min(contentIndent, line.length))).join("\n"));
  }
  return blocks;
}

function identity(row, originalTitle) {
  return {
    rangeId: "all",
    videoId: row.payload.videoId,
    occurrenceId: row.payload.occurrenceId,
    sourceId: "",
    storedRangeId: "all",
    originalGroupKey: `${originalTitle.toLowerCase()}::ado`,
    originalSourceDetailKey: "1111111111111111",
    replacementGroupKey: "canonical::ado",
    replacementSourceDetailKey: "2222222222222222",
    originalTitle,
    originalArtist: "Ado",
    replacementTitle: "Canonical",
    replacementArtist: "Ado",
    seconds: row.payload.seconds,
  };
}

function buildSourceFixture() {
  fs.mkdirSync(source);
  const unsafe = {
    kind: "runtime",
    entityType: "occurrences",
    entityKey: occurrenceId,
    sourceSystem: "fixture",
    rangeId: "all",
    sourceId: "",
    occurrenceId,
    tombstone: false,
    payload: {
      videoId,
      occurrenceId,
      seconds: 100,
      title: "Canonical",
      artist: "Ado",
      originalIdentity: {
        videoId,
        occurrenceId,
        seconds: 100,
        title: "Unsafe Alias",
        artist: "Ado",
        sourceId: "",
        sourceHash: null,
        rawHash: null,
        rangeId: "all",
      },
    },
  };
  const safe = {
    kind: "runtime",
    entityType: "occurrences",
    entityKey: "fixture-occurrence-safe",
    sourceSystem: "fixture",
    rangeId: "all",
    sourceId: "",
    occurrenceId: "fixture-occurrence-safe",
    tombstone: false,
    payload: {
      videoId: "ZyXwVu987_-",
      occurrenceId: "fixture-occurrence-safe",
      seconds: 200,
      title: "Canonical",
      artist: "Ado",
      originalIdentity: {
        videoId: "ZyXwVu987_-",
        occurrenceId: "fixture-occurrence-safe",
        seconds: 200,
        title: "Safe Alias",
        artist: "Ado",
        sourceId: "",
        sourceHash: null,
        rawHash: null,
        rangeId: "all",
      },
    },
  };
  const patchBytes = Buffer.from(`${JSON.stringify(unsafe)}\n${JSON.stringify(safe)}\n`, "utf8");
  write("candidate.ndjson", patchBytes);
  const unsafeIdentity = identity(unsafe, "Unsafe Alias");
  const safeIdentity = identity(safe, "Safe Alias");
  const identities = [unsafeIdentity, safeIdentity];
  const groups = [
    {
      rangeId: "all",
      originalGroupKey: "safe alias::ado",
      originalSourceDetailKey: "1111111111111111",
      replacementGroupKey: "canonical::ado",
      replacementSourceDetailKey: "2222222222222222",
      count: 1,
    },
    {
      rangeId: "all",
      originalGroupKey: "unsafe alias::ado",
      originalSourceDetailKey: "1111111111111111",
      replacementGroupKey: "canonical::ado",
      replacementSourceDetailKey: "2222222222222222",
      count: 1,
    },
  ];
  const rules = {
    schemaVersion: 1,
    kind: "curation-rules-manifest",
    status: "ready",
    ready: true,
    expectedAliasMutationCount: 2,
    currentActiveEvidence: {
      activeRevisionId: activeRevision,
      snapshotSha256: snapshotSha,
      snapshotOccurrenceCount: 2,
    },
    records: [],
    artistScopedAliases: [{
      ruleId: "fixture-alias",
      artist: "Ado",
      canonicalTitle: "Canonical",
      aliases: ["Unsafe Alias", "Safe Alias"],
      expectedMatchCount: 2,
    }],
    safetyAssertions: [],
  };
  const rulesBytes = pretty(rules);
  write("bound-rules-manifest.json", rulesBytes);
  const review = {
    schemaVersion: 1,
    summary: { accepted: 1 },
    results: [{
      kind: "artist_scoped_alias",
      status: "accepted",
      matchCount: 2,
      expectedMatchCount: 2,
      occurrenceIds: [occurrenceId, "fixture-occurrence-safe"],
      selectedIdentities: identities,
    }],
  };
  const reviewBytes = pretty(review);
  write("review.json", reviewBytes);
  const binding = {
    schemaVersion: 1,
    kind: "curation-current-active-evidence-binding",
    status: "ready",
    activeRevisionId: activeRevision,
    snapshotSha256: snapshotSha,
    snapshotOccurrenceCount: 2,
    expectedAliasMutationCount: 2,
    boundRulesManifestSha256: sha(rulesBytes),
  };
  write("current-active-binding.json", pretty(binding));
  const manifest = {
    schemaVersion: 1,
    kind: "curation-accepted-increment",
    status: "ready",
    activeSnapshotRevisionId: activeRevision,
    snapshotSha256: snapshotSha,
    snapshotRowCount: 2,
    curationMutationCount: 2,
    aliasMutationCount: 2,
    patch_sha256: sha(patchBytes),
    patch_bytes: patchBytes.length,
    rulesManifestSha256: sha(rulesBytes),
    overridesSha256: sha(rulesBytes),
    reviewSha256: sha(reviewBytes),
    sourceManifestSha256: sha(Buffer.from(`${sha(rulesBytes)}${snapshotSha}`, "ascii")),
    aliasSourceGroups: groups,
    aliasSourceGroupCount: groups.length,
    aliasSourceGroupsSha256: canonicalSha(groups),
    aliasSourceReview: {
      schemaVersion: 1,
      selectedIdentityCount: identities.length,
      selectedIdentitiesSha256: canonicalSha(identities),
      selectedIdentities: identities,
    },
  };
  const manifestBytes = pretty(manifest);
  write("manifest.json", manifestBytes);
  const checkpoint = {
    schemaVersion: 1,
    kind: "curation-pg-producer-checkpoint",
    complete: true,
    activeSnapshotRevisionId: activeRevision,
    snapshot: { rows: 2, bytes: 1, sha256: snapshotSha, artifactIncluded: false },
    rulesManifestSha256: sha(rulesBytes),
    outputs: {
      candidate: { file: "candidate.ndjson", bytes: patchBytes.length, sha256: sha(patchBytes) },
      manifest: { file: "manifest.json", bytes: manifestBytes.length, sha256: sha(manifestBytes) },
      review: { file: "review.json", bytes: reviewBytes.length, sha256: sha(reviewBytes) },
    },
  };
  write("producer-checkpoint.json", pretty(checkpoint));
  write("producer-status.txt", Buffer.from("producerStatus=success\n", "utf8"));
  write("storage.txt", Buffer.from("artifactBytes=fixture\n", "utf8"));
  const digestNames = fs.readdirSync(source).sort();
  write("artifact-sha256.txt", Buffer.from(
    `${digestNames.map((name) => `${sha(fs.readFileSync(path.join(source, name)))}  /fixture/${name}`).join("\n")}\n`,
    "utf8",
  ));
  return {
    manifestSha256: sha(manifestBytes),
    excludedRowSha256: sha(Buffer.from(`${JSON.stringify(unsafe)}\n`, "utf8")),
  };
}

const fixture = buildSourceFixture();
assert.equal(fixture.manifestSha256, EXPECTED_FIXTURE_MANIFEST_SHA256);
assert.equal(fixture.excludedRowSha256, EXPECTED_FIXTURE_ROW_SHA256);

const common = [
  "--source-root", source,
  "--expected-source-manifest-sha256", EXPECTED_FIXTURE_MANIFEST_SHA256,
  "--expected-source-row-sha256", EXPECTED_FIXTURE_ROW_SHA256,
  "--expected-active-revision-id", activeRevision,
  "--exclude-video-id", videoId,
  "--exclude-occurrence-id", occurrenceId,
  "--exclusion-reason", "fixture_conservative_keep",
  "--source-run-id", "123456789",
  "--source-artifact-name", "fixture-artifact",
  "--transport-run-id", "987654321",
  "--transport-run-attempt", "1",
  "--transport-commit-sha", "7db0cb00a593cbba8120a889ac2c25844a08f536",
];
const run = (extra, argsOverride = common) => spawnSync(
  process.execPath,
  [script, ...argsOverride, ...extra],
  { cwd: repo, encoding: "utf8", timeout: 20_000 },
);

test("derives exactly the hash-bound one-row conservative subset", () => {
  const output = path.join(scratch, "positive");
  const resultPath = path.join(scratch, "positive-result.json");
  const result = run(["--output-root", output, "--result-output", resultPath]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(summary.status, "ready_artifact_only_no_deploy");
  assert.equal(summary.sourceMutationCount, 2);
  assert.equal(summary.outputMutationCount, 1);
  const patch = fs.readFileSync(path.join(output, "candidate.ndjson"), "utf8");
  assert.equal(patch.trim().split("\n").length, 1);
  assert.equal(patch.includes(videoId), false);
  assert.equal(patch.includes(occurrenceId), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.activeSnapshotRevisionId, activeRevision);
  assert.equal(manifest.aliasMutationCount, 1);
  assert.equal(manifest.aliasSourceReview.selectedIdentityCount, 1);
  const digestRows = fs.readFileSync(path.join(output, "artifact-sha256.txt"), "utf8").trim().split("\n");
  assert.equal(digestRows.length, 9);
  for (const row of digestRows) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(row);
    assert.ok(match);
    assert.equal(sha(fs.readFileSync(path.join(output, match[2]))), match[1]);
  }
});

test("fails closed on source manifest drift", () => {
  const altered = common.map((value, index) => (
    common[index - 1] === "--expected-source-manifest-sha256" ? "0".repeat(64) : value
  ));
  const result = run(["--output-root", path.join(scratch, "bad-manifest")], altered);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected source manifest hash mismatch/);
});

test("fails closed on excluded source row drift", () => {
  const altered = common.map((value, index) => (
    common[index - 1] === "--expected-source-row-sha256" ? "f".repeat(64) : value
  ));
  const result = run(["--output-root", path.join(scratch, "bad-row")], altered);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected source row hash mismatch/);
});

test("formal workflow is artifact-only, least-privilege, pinned and bounded", () => {
  const text = fs.readFileSync(workflow, "utf8");
  const runBlocks = extractLiteralRunBlocks(text);
  assert.ok(runBlocks.length > 0);
  assert.equal((text.match(/^\s+shell:\s*bash\s*$/gm) ?? []).length, runBlocks.length);
  for (const [index, block] of runBlocks.entries()) {
    const syntax = spawnSync("bash", ["-n"], { input: block, encoding: "utf8", timeout: 5_000 });
    assert.equal(syntax.status, 0, `run block ${index}: ${syntax.stderr}`);
  }
  assert.match(text, /^on:\n  workflow_dispatch:\n    inputs:\n      retention_days:/m);
  assert.match(text, /^permissions:\n  actions: read\n  contents: read$/m);
  assert.match(text, /^concurrency:\n  group: pg-curation-artifact-transport-30514755176-M4iBwhm_hRI-ffca0d2f8e3f1d0b5aa3fd75\n  cancel-in-progress: false$/m);
  assert.match(text, /^\s{4}runs-on: ubuntu-latest$/m);
  assert.match(text, /^\s{4}timeout-minutes: 10$/m);
  assert.match(text, /^\s{10}retention-days: \$\{\{ inputs\.retention_days \}\}$/m);
  const pinnedActions = [
    ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
    ["actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093"],
    ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
  ];
  for (const [action, commit] of pinnedActions) {
    const pinnedUsesLine = new RegExp(
      `^\\s{8}uses: ${action}@${commit}(?:\\s+#\\s+[^\\r\\n]+)?$`,
      "mu",
    );
    assert.match(text, pinnedUsesLine);
    const spoofed = text.replace(
      pinnedUsesLine,
      `        uses: ${action}@v4 # ${commit}`,
    );
    assert.notEqual(spoofed, text);
    assert.doesNotMatch(spoofed, pinnedUsesLine);
  }
  assert.match(text, /run-id:\s*"30514755176"/);
  assert.match(text, /name:\s*pg-curation-patch-30514755176-1/);
  assert.doesNotMatch(text, /deploy-pg|activate-pg|ssh |psql |environment:/i);
});
