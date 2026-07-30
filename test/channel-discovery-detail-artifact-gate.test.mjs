import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const gatePath = path.resolve("scripts/channel-discovery-detail-artifact-gate.mjs");
const sourceCommit = "4".repeat(40);
const detailCommit = "5".repeat(40);
const channelId = "UCahlYbdb3AHrNQdojztSMvQ";
const channelHandle = "@natori_hinata";
const channelUrl = `https://www.youtube.com/${channelHandle}`;
const videoIds = ["y0KqY2Wgaiw", "OG_Td-kXSzE", "DtKGpOOZBIE"];

test("selection binds exact source identity, evidence bytes/hash, and three requested IDs", () => {
  const fixture = candidateFixture();
  try {
    const output = path.join(fixture.root, "selected.ndjson");
    const success = runGate([
      "select",
      "--candidate-root", fixture.candidateRoot,
      "--video-ids-file", fixture.videoIdsFile,
      "--output", output,
      ...identityArgs(),
      "--expected-source-commit", sourceCommit,
    ]);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /CHANNEL_DETAIL_SELECTION_OK videos=3/u);
    assert.deepEqual(readNdjson(output).map((record) => record.youtubeVideoId), videoIds);

    const manifestPath = path.join(fixture.candidateRoot, "candidate-manifest.ndjson");
    const records = readNdjson(manifestPath);
    records[0].channelId = "UCxxxxxxxxxxxxxxxxxxxxxx";
    writeNdjson(manifestPath, records);
    const wrongIdentity = runGate([
      "select",
      "--candidate-root", fixture.candidateRoot,
      "--video-ids-file", fixture.videoIdsFile,
      "--output", output,
      ...identityArgs(),
      "--expected-source-commit", sourceCommit,
    ]);
    assert.equal(wrongIdentity.status, 78);
    assert.match(wrongIdentity.stderr, /channelId mismatch/u);

    records[0].channelId = channelId;
    writeNdjson(manifestPath, records);
    fs.appendFileSync(fixture.evidencePath, "tampered", "utf8");
    const wrongEvidence = runGate([
      "select",
      "--candidate-root", fixture.candidateRoot,
      "--video-ids-file", fixture.videoIdsFile,
      "--output", output,
      ...identityArgs(),
      "--expected-source-commit", sourceCommit,
    ]);
    assert.equal(wrongEvidence.status, 78);
    assert.match(wrongEvidence.stderr, /candidate evidence bytes mismatch/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review verification recomputes selected source hash and forbids accepted output", () => {
  const fixture = detailFixture();
  try {
    const success = runVerify(fixture);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /CHANNEL_DETAIL_ARTIFACT_OK videos=3 details=1 occurrences=1 sources=1 reviewOnly=true/u);
    const reviewManifest = readJson(fixture.manifestOut);
    assert.equal(reviewManifest.reviewOnly, true);
    assert.equal(reviewManifest.acceptedEligible, false);
    assert.equal(reviewManifest.acceptedJsonIncluded, false);
    assert.equal(reviewManifest.sourceCommit, detailCommit);
    assert.deepEqual(reviewManifest.videoIds, videoIds);
    const sources = readJson(fixture.sourceEvidenceOut);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].sourceHash, normalizedHash(sources[0].sourceText));

    const auditsPath = path.join(fixture.detailRoot, "audits.json");
    const audits = readJson(auditsPath);
    audits[0].sources[0].sourceHash = "f".repeat(64);
    writeJson(auditsPath, audits);
    const wrongSourceHash = runVerify(fixture);
    assert.equal(wrongSourceHash.status, 78);
    assert.match(wrongSourceHash.stderr, /selected source hash mismatch/u);

    audits[0].sources[0].sourceHash = normalizedHash(audits[0].sources[0].sourceText);
    writeJson(auditsPath, audits);
    fs.writeFileSync(path.join(fixture.detailRoot, "accepted.json"), "{}\n", "utf8");
    const acceptedOutput = runVerify(fixture);
    assert.equal(acceptedOutput.status, 78);
    assert.match(acceptedOutput.stderr, /accepted output is forbidden/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function candidateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-detail-candidate-"));
  const candidateRoot = path.join(root, "candidate");
  const pages = path.join(candidateRoot, "pages");
  fs.mkdirSync(pages, { recursive: true });
  const evidencePath = path.join(pages, "videos.html");
  fs.writeFileSync(evidencePath, `<html>${videoIds.join(" ")}</html>\n`, "utf8");
  const evidence = {
    path: "pages/videos.html",
    sha256: sha256File(evidencePath),
    bytes: fs.statSync(evidencePath).size,
    sourceUrl: `${channelUrl}/videos`,
    rendererOwnerChannelId: channelId,
    rendererOwnerChannelHandle: channelHandle,
    rendererOwnerIdentityInherited: true,
  };
  const records = videoIds.map((videoId, index) => candidateRecord(videoId, index, evidence));
  const identity = fullIdentity();
  writeJson(path.join(candidateRoot, "request.json"), {
    ...identity,
    candidateOnly: true,
    sourceCommit,
  });
  writeJson(path.join(candidateRoot, "manifest.json"), {
    ...identity,
    candidateOnly: true,
    complete: true,
    partial: false,
    sourceReachedEnd: true,
    sourceCommit,
    candidateCount: records.length,
    uniqueCandidateCount: records.length,
  });
  writeJson(path.join(candidateRoot, "checkpoint.json"), {
    ...identity,
    complete: true,
    partial: false,
    sourceCommit,
  });
  writeNdjson(path.join(candidateRoot, "candidate-manifest.ndjson"), records);
  const videoIdsFile = path.join(root, "video-ids.txt");
  fs.writeFileSync(videoIdsFile, `${videoIds.join("\n")}\n`, "utf8");
  return { root, candidateRoot, evidencePath, videoIdsFile, records };
}

function detailFixture() {
  const candidate = candidateFixture();
  const detailRoot = path.join(candidate.root, "release");
  fs.mkdirSync(detailRoot, { recursive: true });
  const selectedPath = path.join(candidate.root, "selected.ndjson");
  writeNdjson(selectedPath, candidate.records);
  const sourceText = "0:01 Song A / Artist A\u00a0\r\n";
  const sourceHash = normalizedHash(sourceText);
  const sourceId = `description:${videoIds[0]}`;
  writeJson(path.join(detailRoot, "manifest.json"), {
    candidateOnly: false,
    sourceCommit: detailCommit,
    maxInspect: 3,
    requestedVideoIds: videoIds,
    inspectedInLatestRun: 3,
    sourceReachedEnd: true,
  });
  writeJson(path.join(detailRoot, "checkpoint.json"), {
    completedVideoIds: videoIds,
    inspectedInLatestRun: 3,
  });
  writeJson(path.join(detailRoot, "raw-videos.json"), candidate.records);
  writeJson(path.join(detailRoot, "video-details.json"), [{
    videoId: videoIds[0],
    channelId,
    channelHandle,
    discoveryChannelUrl: channelUrl,
    selectedSourceId: sourceId,
    selectedSourceHash: sourceHash,
    songs: [{ title: "Song A", artist: "Artist A", seconds: 1 }],
  }]);
  writeJson(path.join(detailRoot, "audits.json"), [
    {
      videoId: videoIds[0],
      result: "selected",
      selectedSongCount: 1,
      sources: [{
        selected: true,
        sourceId,
        sourceType: "description",
        sourceText,
        sourceHash,
      }],
    },
    { videoId: videoIds[1], result: "no_timestamp_source", selectedSongCount: 0, sources: [] },
    { videoId: videoIds[2], result: "no_timestamp_source", selectedSongCount: 0, sources: [] },
  ]);
  writeJson(path.join(detailRoot, "occurrences.json"), [{
    youtubeVideoId: videoIds[0],
    channelId,
    channelHandle,
    channelUrl,
    cleanedTitle: "Song A",
    cleanedArtist: "Artist A",
    seconds: 1,
    sourceText: "0:01 Song A / Artist A",
    provenance: {
      sourceId,
      sourceHash,
      rawHash: candidate.records[0].rawHash,
    },
  }]);
  const requestPath = path.join(detailRoot, "request.json");
  writeJson(requestPath, {
    ...fullIdentity(),
    kind: "channel-discovery-detail-request",
    reviewOnly: true,
    candidateOnly: true,
    maxInspect: 3,
    candidateRunId: 30519379147,
    candidateArtifactId: 123456,
    candidateArtifactName: "channel-discovery-natori-hinata",
    candidateZipSha256: "6".repeat(64),
    candidateSourceCommit: sourceCommit,
    detailSourceCommit: detailCommit,
    videoIds,
  });
  const resourcePath = path.join(detailRoot, "resource-usage.json");
  writeJson(resourcePath, {
    beforeBytes: 100,
    peakTaskBytes: 1000,
    peakDetailRssBytes: 2000,
    afterBytes: 3000,
    taskCapBytes: 2147483648,
    maxInspect: 3,
    cleanupExpectedAfterBytes: 0,
    cleanupStatus: "pending_owned_temp_root_removal",
  });
  return {
    ...candidate,
    detailRoot,
    selectedPath,
    requestPath,
    resourcePath,
    sourceEvidenceOut: path.join(detailRoot, "source-evidence.json"),
    manifestOut: path.join(detailRoot, "review-ready-manifest.json"),
  };
}

function candidateRecord(videoId, index, evidence) {
  return {
    youtubeVideoId: videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    rawHash: crypto.createHash("sha256").update(`raw-${index}-${videoId}`).digest("hex"),
    channelId,
    channelHandle,
    channelUrl,
    discoveryEvidenceRefs: [{ ...evidence }],
  };
}

function runVerify(fixture) {
  return runGate([
    "verify",
    "--detail-root", fixture.detailRoot,
    "--selected-candidates", fixture.selectedPath,
    "--video-ids-file", fixture.videoIdsFile,
    "--request", fixture.requestPath,
    "--resource", fixture.resourcePath,
    "--source-evidence-out", fixture.sourceEvidenceOut,
    "--manifest-out", fixture.manifestOut,
    ...identityArgs(),
    "--expected-source-commit", detailCommit,
  ]);
}

function runGate(args) {
  return spawnSync(process.execPath, [gatePath, ...args], {
    cwd: path.dirname(path.dirname(gatePath)),
    encoding: "utf8",
    timeout: 10000,
  });
}

function fullIdentity() {
  return {
    channelId,
    channelHandle,
    channelUrl,
    expectedChannelId: channelId,
    expectedChannelHandle: channelHandle,
    expectedChannelUrl: channelUrl,
  };
}

function identityArgs() {
  return [
    "--expected-channel-id", channelId,
    "--expected-channel-handle", channelHandle,
    "--expected-channel-url", channelUrl,
  ];
}

function normalizedHash(text) {
  const normalized = String(text)
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\u200b/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function writeNdjson(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
