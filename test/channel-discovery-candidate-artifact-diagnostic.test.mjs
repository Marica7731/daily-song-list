import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(candidateRoot, "..");
const diagnosticPath = path.join(
  candidateRoot,
  "scripts",
  "channel-discovery-candidate-artifact-diagnostic.jq",
);
const authoritativeGate = spawnSync(
  "git",
  ["show", "0e670fd15cc960e3b1cac43bc89bd76164a4e5a6:scripts/channel-discovery-candidate-artifact-gate.jq"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
assert.equal(authoritativeGate.status, 0, authoritativeGate.stderr);
const sourceCommit = "a".repeat(40);
const channelId = "UCAAAAAAAAAAAAAAAAAAAAAA";
const channelHandle = "@fixture_channel";
const channelUrl = `https://www.youtube.com/${channelHandle}`;
const hash = "b".repeat(64);

function page(tab, pageIndex) {
  return {
    tab,
    pageIndex,
    pageUrl: `${channelUrl}/${tab}`,
    status: 200,
    pageCount: 1,
    rawItemCount: tab === "streams" ? 1 : 0,
    candidateCount: tab === "streams" ? 1 : 0,
    continuationRounds: 0,
    requiresContinuation: false,
    reachedEnd: true,
    continuationEvidence: [],
    inheritedInitialOwnerVideoIds: tab === "streams" ? ["AAAAAAAAAAA"] : [],
    bytes: 123,
    rawSha256: hash,
    evidencePath: `pages/0${pageIndex}-${tab}.html`,
    observedChannelId: channelId,
    observedChannelHandle: channelHandle,
    observedChannelUrl: channelUrl,
    observedChannelResponseUrl: `${channelUrl}/${tab}`,
  };
}

function fixture() {
  const pages = [page("streams", 0), page("videos", 1)];
  const request = {
    schemaVersion: 1,
    kind: "channel-discovery-candidate-run",
    sourceCommit,
    channelId,
    channelHandle,
    channelSlug: "fixture-channel",
    channelUrl,
    maxChannelPages: 10,
    maxVideos: 250,
    forceRefresh: true,
    candidateOnly: true,
  };
  const manifest = {
    schemaVersion: 1,
    kind: "channel-discovery-source-manifest",
    sourceCommit,
    channelId,
    channelHandle,
    channelSlug: request.channelSlug,
    channelUrl,
    forceRefresh: true,
    candidateOnly: true,
    complete: true,
    partial: false,
    sourceReachedEnd: true,
    candidateCount: 1,
    pageSummaries: pages,
    pageEvidenceFiles: pages.map((entry) => ({
      path: entry.evidencePath,
      sha256: entry.rawSha256,
      bytes: entry.bytes,
    })),
  };
  const discoveryCheckpoint = {
    schemaVersion: 1,
    channelUrl,
    candidateCount: 1,
    sourceReachedEnd: true,
    complete: true,
    partial: false,
    pageSummaries: pages,
  };
  const checkpoint = {
    schemaVersion: 1,
    kind: "channel-discovery-candidate-checkpoint",
    sourceCommit,
    channelId,
    channelHandle,
    channelSlug: request.channelSlug,
    channelUrl,
    forceRefresh: true,
    complete: true,
    partial: false,
    candidateCount: 1,
    discoveryCheckpoint,
  };
  const record = {
    youtubeVideoId: "AAAAAAAAAAA",
    channelId,
    channelHandle,
    channelUrl,
    observedChannelId: channelId,
    observedChannelHandle: channelHandle,
    observedChannelUrl: channelUrl,
    discoverySourceUrl: `${channelUrl}/streams`,
    observedChannelSourceUrl: `${channelUrl}/streams`,
    observedChannelResponseUrl: `${channelUrl}/streams`,
    discoveryEvidenceRefs: [{
      kind: "initial-html",
      path: pages[0].evidencePath,
      sha256: pages[0].rawSha256,
      bytes: pages[0].bytes,
      sourceUrl: pages[0].pageUrl,
      responseUrl: pages[0].observedChannelResponseUrl,
      rendererOwnerChannelId: channelId,
      rendererOwnerChannelHandle: channelHandle,
      rendererOwnerIdentityInherited: true,
    }],
  };
  return { request, manifest, checkpoint, records: [record] };
}

function runDiagnostic(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-diagnostic-"));
  try {
    const requestPath = path.join(dir, "request.json");
    const manifestPath = path.join(dir, "manifest.json");
    const checkpointPath = path.join(dir, "checkpoint.json");
    const recordsPath = path.join(dir, "candidate.ndjson");
    const authoritativeGatePath = path.join(dir, "authoritative-gate.jq");
    fs.writeFileSync(requestPath, `${JSON.stringify(value.request)}\n`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(value.manifest)}\n`);
    fs.writeFileSync(checkpointPath, `${JSON.stringify(value.checkpoint)}\n`);
    fs.writeFileSync(recordsPath, value.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    fs.writeFileSync(authoritativeGatePath, authoritativeGate.stdout);
    const commonArgs = [
      "-s",
      "--arg", "expectedSourceCommit", sourceCommit,
      "--arg", "expectedChannelId", channelId,
      "--arg", "expectedChannelHandle", channelHandle,
      "--arg", "expectedChannelUrl", channelUrl,
      "--slurpfile", "requestFile", requestPath,
      "--slurpfile", "sourceManifestFile", manifestPath,
      "--slurpfile", "checkpointFile", checkpointPath,
    ];
    const gateResult = spawnSync("jq", [
      "-e",
      ...commonArgs,
      "-f", authoritativeGatePath,
      recordsPath,
    ], { encoding: "utf8" });
    const result = spawnSync("jq", [
      ...commonArgs,
      "-f", diagnosticPath,
      recordsPath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return {
      gateStatus: gateResult.status,
      raw: result.stdout,
      payload: JSON.parse(result.stdout),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("diagnostic reports no failed groups for an inherited-owner artifact that satisfies the gate", () => {
  const { gateStatus, raw, payload } = runDiagnostic(fixture());
  assert.equal(gateStatus, 0);
  assert.deepEqual(payload.failedChecks, []);
  assert.equal(payload.counts.recordCount, 1);
  assert.equal(payload.counts.inheritedInitialOwnerCount, 1);
  assert.equal(payload.counts.inheritedContinuationOwnerCount, 0);
  assert.equal(payload.counts.invalidRecordIdentityCount, 0);
  assert.equal(payload.counts.invalidRecordEvidenceCount, 0);
  assert.doesNotMatch(raw, /AAAAAAAAAAA|fixture_channel|youtube\.com|bbbbbbbb/u);
});

test("diagnostic names count and evidence failures without exposing record content", () => {
  const value = fixture();
  value.checkpoint.candidateCount = 2;
  value.records[0].discoveryEvidenceRefs[0].path = "pages/99-secret.html";
  value.records[0].videoTitle = "DO_NOT_LOG_PRIVATE_TITLE";
  const { gateStatus, raw, payload } = runDiagnostic(value);
  assert.notEqual(gateStatus, 0);
  assert.deepEqual(payload.failedChecks, ["checkpoint-binding", "record-evidence"]);
  assert.equal(payload.counts.invalidRecordEvidenceCount, 1);
  assert.doesNotMatch(raw, /DO_NOT_LOG_PRIVATE_TITLE|pages\/99-secret|AAAAAAAAAAA/u);
});

test("diagnostic coerces hostile non-numeric count fields to null", () => {
  const value = fixture();
  value.manifest.candidateCount = "DO_NOT_LOG_HOSTILE_COUNT";
  const { gateStatus, raw, payload } = runDiagnostic(value);
  assert.notEqual(gateStatus, 0);
  assert.equal(payload.counts.sourceCandidateCount, null);
  assert.match(payload.failedChecks.join(","), /checkpoint-binding|candidate-count-binding/u);
  assert.doesNotMatch(raw, /DO_NOT_LOG_HOSTILE_COUNT/u);
});
