#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "";

try {
  if (command === "select") {
    selectCandidates(args);
  } else if (command === "verify") {
    verifyDetailArtifact(args);
  } else {
    fail("usage: channel-discovery-detail-artifact-gate.mjs <select|verify> [options]");
  }
} catch (error) {
  console.error(`CHANNEL_DETAIL_GATE_FAIL ${error.message}`);
  process.exitCode = 78;
}

function selectCandidates(options) {
  const candidateRoot = safeDirectory(required(options, "candidate-root"));
  const outputPath = safeOutputPath(required(options, "output"));
  const expected = expectedIdentity(options);
  const expectedSourceCommit = exactGitSha(required(options, "expected-source-commit"), "expected source commit");
  const videoIds = readExactVideoIds(required(options, "video-ids-file"));
  const request = readJson(path.join(candidateRoot, "request.json"));
  const manifest = readJson(path.join(candidateRoot, "manifest.json"));
  const checkpoint = readJson(path.join(candidateRoot, "checkpoint.json"));
  const records = readNdjson(path.join(candidateRoot, "candidate-manifest.ndjson"));

  assert(request.candidateOnly === true, "candidate request is not candidate-only");
  assert(manifest.candidateOnly === true, "candidate manifest is not candidate-only");
  assert(manifest.complete === true, "candidate manifest is incomplete");
  assert(manifest.partial === false, "candidate manifest is partial");
  assert(manifest.sourceReachedEnd === true, "candidate source did not reach end");
  assert(checkpoint.complete === true, "candidate checkpoint is incomplete");
  assert(checkpoint.partial === false, "candidate checkpoint is partial");
  for (const sourceCommit of [request.sourceCommit, manifest.sourceCommit, checkpoint.sourceCommit]) {
    assert(sourceCommit === expectedSourceCommit, "candidate source commit mismatch");
  }
  validateIdentity(request, expected, true);
  validateIdentity(manifest, expected, true);
  validateIdentity(checkpoint, expected, true);
  assert(manifest.candidateCount === records.length, "candidate count mismatch");
  assert(manifest.uniqueCandidateCount === records.length, "candidate unique count mismatch");

  const counts = countBy(records, (record) => record.youtubeVideoId);
  const selected = videoIds.map((videoId) => {
    assert(counts.get(videoId) === 1, `selected video ID must occur exactly once: ${videoId}`);
    const record = records.find((entry) => entry.youtubeVideoId === videoId);
    validateCandidateRecord(record, expected, candidateRoot);
    return record;
  });
  assert(new Set(selected.map((record) => record.rawHash)).size === selected.length, "selected rawHash is not unique");
  writeNdjson(outputPath, selected);
  console.log(
    `CHANNEL_DETAIL_SELECTION_OK videos=${selected.length} ids=${selected.map((record) => record.youtubeVideoId).join(",")}`,
  );
}

function verifyDetailArtifact(options) {
  const detailRoot = safeDirectory(required(options, "detail-root"));
  const selectedPath = safeFile(required(options, "selected-candidates"));
  const requestPath = safeFile(required(options, "request"));
  const resourcePath = safeFile(required(options, "resource"));
  const sourceEvidenceOut = safeOutputPath(required(options, "source-evidence-out"));
  const manifestOut = safeOutputPath(required(options, "manifest-out"));
  const expected = expectedIdentity(options);
  const expectedSourceCommit = exactGitSha(required(options, "expected-source-commit"), "expected source commit");
  const videoIds = readExactVideoIds(required(options, "video-ids-file"));
  const selected = readNdjson(selectedPath);
  const request = readJson(requestPath);
  const resources = readJson(resourcePath);
  const manifest = readJson(path.join(detailRoot, "manifest.json"));
  const checkpoint = readJson(path.join(detailRoot, "checkpoint.json"));
  const rawVideos = readJson(path.join(detailRoot, "raw-videos.json"));
  const details = readJson(path.join(detailRoot, "video-details.json"));
  const occurrences = readJson(path.join(detailRoot, "occurrences.json"));
  const audits = readJson(path.join(detailRoot, "audits.json"));

  assert(request.kind === "channel-discovery-detail-request", "invalid detail request kind");
  assert(request.reviewOnly === true, "detail request must be review-only");
  assert(request.candidateOnly === true, "detail request must retain candidate-only semantics");
  assert(request.maxInspect === 3, "detail request maxInspect must equal 3");
  assert(equalArrays(request.videoIds, videoIds), "detail request video IDs mismatch");
  validateIdentity(request, expected, true);
  exactSha(request.candidateZipSha256, "candidate ZIP SHA-256");
  exactGitSha(request.candidateSourceCommit, "candidate source commit");
  exactGitSha(request.detailSourceCommit, "detail source commit");

  assert(manifest.candidateOnly === false, "detail extractor unexpectedly remained candidate-only");
  assert(manifest.sourceCommit === expectedSourceCommit, "detail source commit mismatch");
  assert(manifest.maxInspect === 3, "detail manifest maxInspect must equal 3");
  assert(equalArrays(manifest.requestedVideoIds, videoIds), "detail manifest requested IDs mismatch");
  assert(manifest.inspectedInLatestRun === 3, "detail manifest inspected count mismatch");
  assert(manifest.sourceReachedEnd === true, "detail source lineage is incomplete");
  assert(selected.length === 3, "selected candidate count must equal 3");
  assert(equalArrays(selected.map((record) => record.youtubeVideoId), videoIds), "selected candidate order mismatch");
  assert(Array.isArray(rawVideos) && rawVideos.length === 3, "raw video count mismatch");
  assert(equalArrays(rawVideos.map((record) => record.youtubeVideoId), videoIds), "raw video IDs mismatch");
  assert(Array.isArray(details), "details must be an array");
  assert(Array.isArray(occurrences), "occurrences must be an array");
  assert(Array.isArray(audits) && audits.length === 3, "audits must contain one terminal result per video");
  assert(new Set(audits.map((audit) => audit.videoId)).size === 3, "audit video IDs are not unique");
  assert(sameSet(audits.map((audit) => audit.videoId), videoIds), "audit video IDs mismatch");
  assert(sameSet(checkpoint.completedVideoIds, videoIds), "checkpoint completed video IDs mismatch");
  assert(checkpoint.detailCount === 3, "checkpoint inspected count mismatch");

  for (const record of rawVideos) validateCandidateRecord(record, expected, null);
  const detailIds = new Set();
  for (const detail of details) {
    assert(videoIds.includes(detail.videoId), `detail has unexpected video ID: ${detail.videoId}`);
    assert(!detailIds.has(detail.videoId), `duplicate detail video ID: ${detail.videoId}`);
    detailIds.add(detail.videoId);
    assert(detail.channelId === expected.channelId, `detail channelId mismatch: ${detail.videoId}`);
    assert(detail.channelHandle === expected.channelHandle, `detail channelHandle mismatch: ${detail.videoId}`);
    assert(detail.discoveryChannelUrl === expected.channelUrl, `detail channel URL mismatch: ${detail.videoId}`);
    assert(Array.isArray(detail.songs) && detail.songs.length > 0, `usable detail has no songs: ${detail.videoId}`);
  }

  const sourceEvidence = [];
  for (const audit of audits) {
    const detail = details.find((entry) => entry.videoId === audit.videoId);
    if (!detail) {
      assert(audit.result !== "selected", `selected audit is missing detail: ${audit.videoId}`);
      assert(Number(audit.selectedSongCount || 0) === 0, `terminal no-detail audit has selected songs: ${audit.videoId}`);
      continue;
    }
    const selectedSources = (audit.sources || []).filter((source) => source.selected === true);
    assert(selectedSources.length === 1, `detail must have one selected source: ${audit.videoId}`);
    const source = selectedSources[0];
    assert(typeof source.sourceText === "string" && source.sourceText.trim(), `selected source text missing: ${audit.videoId}`);
    exactSha(source.sourceHash, `selected source hash ${audit.videoId}`);
    assert(hashNormalizedText(source.sourceText) === source.sourceHash, `selected source hash mismatch: ${audit.videoId}`);
    assert(source.sourceId, `selected source ID missing: ${audit.videoId}`);
    assert(detail.selectedSourceId === source.sourceId, `detail source ID mismatch: ${audit.videoId}`);
    assert(detail.selectedSourceHash === source.sourceHash, `detail source hash mismatch: ${audit.videoId}`);
    sourceEvidence.push({
      videoId: audit.videoId,
      sourceId: source.sourceId,
      sourceHash: source.sourceHash,
      sourceType: source.sourceType,
      sourceText: source.sourceText,
      selected: true,
    });
  }

  for (const occurrence of occurrences) {
    assert(videoIds.includes(occurrence.youtubeVideoId), `occurrence has unexpected video ID: ${occurrence.youtubeVideoId}`);
    assert(detailIds.has(occurrence.youtubeVideoId), `occurrence has no usable detail: ${occurrence.youtubeVideoId}`);
    assert(occurrence.channelId === expected.channelId, `occurrence channelId mismatch: ${occurrence.youtubeVideoId}`);
    assert(occurrence.channelHandle === expected.channelHandle, `occurrence channelHandle mismatch: ${occurrence.youtubeVideoId}`);
    assert(occurrence.channelUrl === expected.channelUrl, `occurrence channel URL mismatch: ${occurrence.youtubeVideoId}`);
    assert(typeof occurrence.cleanedTitle === "string" && occurrence.cleanedTitle.trim(), "occurrence title missing");
    assert(typeof occurrence.cleanedArtist === "string", "occurrence artist type invalid");
    assert(Number.isFinite(occurrence.seconds), "occurrence seconds invalid");
    assert(typeof occurrence.sourceText === "string" && occurrence.sourceText.trim(), "occurrence raw source line missing");
    exactSha(occurrence.provenance?.sourceHash, "occurrence sourceHash");
    exactSha(occurrence.provenance?.rawHash, "occurrence rawHash");
    assert(occurrence.provenance?.sourceId, "occurrence sourceId missing");
    const matchingSource = sourceEvidence.find(
      (source) =>
        source.videoId === occurrence.youtubeVideoId &&
        source.sourceId === occurrence.provenance.sourceId &&
        source.sourceHash === occurrence.provenance.sourceHash,
    );
    assert(matchingSource, `occurrence source tuple mismatch: ${occurrence.youtubeVideoId}`);
  }

  assert(Number(resources.taskCapBytes) === 2147483648, "resource task cap mismatch");
  assert(Number(resources.maxInspect) === 3, "resource maxInspect mismatch");
  assert(Number(resources.peakTaskBytes) <= Number(resources.taskCapBytes), "task peak exceeded cap");
  assert(Number(resources.peakDetailRssBytes) <= Number(resources.taskCapBytes), "detail RSS exceeded cap");
  assert(Number(resources.cleanupExpectedAfterBytes) === 0, "cleanup expected after bytes must equal zero");
  assert(resources.cleanupStatus === "pending_owned_temp_root_removal", "cleanup pre-upload status mismatch");
  assertNoAcceptedFiles(path.dirname(manifestOut));
  assertNoAcceptedFiles(detailRoot);

  writeJson(sourceEvidenceOut, sourceEvidence);
  const files = [
    selectedPath,
    requestPath,
    resourcePath,
    path.join(detailRoot, "checkpoint.json"),
    path.join(detailRoot, "manifest.json"),
    path.join(detailRoot, "raw-videos.json"),
    path.join(detailRoot, "video-details.json"),
    path.join(detailRoot, "occurrences.json"),
    path.join(detailRoot, "audits.json"),
    sourceEvidenceOut,
  ].map(fileEvidence);
  const reviewManifest = {
    schemaVersion: 1,
    kind: "channel-discovery-detail-review-artifact",
    generatedAt: new Date().toISOString(),
    reviewOnly: true,
    acceptedEligible: false,
    acceptedJsonIncluded: false,
    sourceCommit: expectedSourceCommit,
    candidateRunId: request.candidateRunId,
    candidateArtifactId: request.candidateArtifactId,
    candidateArtifactName: request.candidateArtifactName,
    candidateZipSha256: request.candidateZipSha256,
    channelId: expected.channelId,
    channelHandle: expected.channelHandle,
    channelUrl: expected.channelUrl,
    videoIds,
    selectedCandidateCount: selected.length,
    terminalAuditCount: audits.length,
    usableDetailCount: details.length,
    occurrenceCount: occurrences.length,
    sourceEvidenceCount: sourceEvidence.length,
    resources,
    files,
  };
  writeJson(manifestOut, reviewManifest);
  console.log(
    `CHANNEL_DETAIL_ARTIFACT_OK videos=${videoIds.length} details=${details.length} occurrences=${occurrences.length} sources=${sourceEvidence.length} reviewOnly=true`,
  );
}

function validateCandidateRecord(record, expected, candidateRoot) {
  assert(record && typeof record === "object", "candidate record is invalid");
  assert(/^[A-Za-z0-9_-]{11}$/u.test(record.youtubeVideoId), "candidate video ID is invalid");
  assert(record.youtubeUrl === `https://www.youtube.com/watch?v=${record.youtubeVideoId}`, "candidate video URL mismatch");
  assert(record.thumbnailUrl?.includes(`/vi/${record.youtubeVideoId}/`), "candidate thumbnail video ID mismatch");
  assert(/^[a-f0-9]{64}$/u.test(record.rawHash || ""), "candidate rawHash is invalid");
  validateIdentity(record, expected, false);
  assert(Array.isArray(record.discoveryEvidenceRefs) && record.discoveryEvidenceRefs.length > 0, "candidate evidence refs missing");
  for (const evidence of record.discoveryEvidenceRefs) {
    assert(evidence.rendererOwnerChannelId === expected.channelId, "candidate evidence owner channelId mismatch");
    assert(evidence.rendererOwnerChannelHandle === expected.channelHandle, "candidate evidence owner handle mismatch");
    assert(evidence.rendererOwnerIdentityInherited === true, "candidate owner inheritance flag mismatch");
    assert(exactChannelUrl(evidence.sourceUrl) === expected.channelUrl, "candidate evidence source URL mismatch");
    exactSha(evidence.sha256, "candidate evidence SHA-256");
    assert(Number.isSafeInteger(evidence.bytes) && evidence.bytes >= 0, "candidate evidence bytes invalid");
    if (candidateRoot) {
      const evidencePath = safeChildPath(candidateRoot, evidence.path);
      assert(fs.existsSync(evidencePath), `candidate evidence file missing: ${evidence.path}`);
      assert(fs.statSync(evidencePath).size === evidence.bytes, `candidate evidence bytes mismatch: ${evidence.path}`);
      assert(sha256File(evidencePath) === evidence.sha256, `candidate evidence hash mismatch: ${evidence.path}`);
      assert(fs.readFileSync(evidencePath).includes(Buffer.from(record.youtubeVideoId)), `candidate evidence body misses video ID: ${record.youtubeVideoId}`);
    }
  }
}

function validateIdentity(value, expected, includeExpectedFields) {
  assert(value.channelId === expected.channelId, "channelId mismatch");
  assert(value.channelHandle === expected.channelHandle, "channelHandle mismatch");
  assert(exactChannelUrl(value.channelUrl) === expected.channelUrl, "channel URL mismatch");
  if (value.observedChannelId != null) assert(value.observedChannelId === expected.channelId, "observed channelId mismatch");
  if (value.observedChannelHandle != null) assert(value.observedChannelHandle === expected.channelHandle, "observed handle mismatch");
  if (value.observedChannelUrl != null) assert(exactChannelUrl(value.observedChannelUrl) === expected.channelUrl, "observed channel URL mismatch");
  if (includeExpectedFields) {
    assert(value.expectedChannelId === expected.channelId, "expected channelId mismatch");
    assert(value.expectedChannelHandle === expected.channelHandle, "expected handle mismatch");
    assert(exactChannelUrl(value.expectedChannelUrl) === expected.channelUrl, "expected channel URL mismatch");
  }
}

function expectedIdentity(options) {
  const channelId = required(options, "expected-channel-id");
  const channelHandle = required(options, "expected-channel-handle");
  const channelUrl = exactChannelUrl(required(options, "expected-channel-url"));
  assert(/^UC[A-Za-z0-9_-]{22}$/u.test(channelId), "expected channelId is invalid");
  assert(/^@[A-Za-z0-9._-]{3,30}$/u.test(channelHandle), "expected channel handle is invalid");
  assert(channelUrl.endsWith(`/${channelHandle}`), "expected channel URL/handle mismatch");
  return { channelId, channelHandle, channelUrl };
}

function readExactVideoIds(filePath) {
  const values = fs
    .readFileSync(safeFile(filePath), "utf8")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  assert(values.length === 3, "exactly three explicit video IDs are required");
  assert(new Set(values).size === values.length, "video IDs must be unique");
  for (const videoId of values) assert(/^[A-Za-z0-9_-]{11}$/u.test(videoId), `invalid video ID: ${videoId}`);
  return values;
}

function normalizeSourceText(text) {
  return String(text || "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\u200b/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function hashNormalizedText(text) {
  return crypto.createHash("sha256").update(normalizeSourceText(text), "utf8").digest("hex");
}

function exactChannelUrl(value) {
  const parsed = new URL(String(value || ""));
  assert(["www.youtube.com", "youtube.com"].includes(parsed.hostname.toLowerCase()), "channel URL host mismatch");
  const match = parsed.pathname.match(/^\/(@[A-Za-z0-9._-]{3,30})(?:\/.*)?$/u);
  assert(match, "channel URL is not a canonical handle URL");
  return `https://www.youtube.com/${match[1]}`;
}

function safeDirectory(value) {
  const resolved = path.resolve(value);
  assert(fs.existsSync(resolved) && fs.statSync(resolved).isDirectory(), `directory missing: ${resolved}`);
  assert(!fs.lstatSync(resolved).isSymbolicLink(), `directory must not be a symlink: ${resolved}`);
  return resolved;
}

function safeFile(value) {
  const resolved = path.resolve(value);
  assert(fs.existsSync(resolved) && fs.statSync(resolved).isFile(), `file missing: ${resolved}`);
  assert(!fs.lstatSync(resolved).isSymbolicLink(), `file must not be a symlink: ${resolved}`);
  return resolved;
}

function safeOutputPath(value) {
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  assert(fs.statSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(), `unsafe output parent: ${parent}`);
  return resolved;
}

function safeChildPath(root, relativePath) {
  assert(typeof relativePath === "string" && relativePath && !path.isAbsolute(relativePath), "unsafe relative evidence path");
  const resolved = path.resolve(root, relativePath);
  assert(resolved.startsWith(`${root}${path.sep}`), "evidence path escapes candidate root");
  return resolved;
}

function assertNoAcceptedFiles(root) {
  for (const name of walkFiles(root)) {
    assert(!/(^|[._-])accepted([._-]|$)/iu.test(path.basename(name)), `accepted output is forbidden: ${name}`);
  }
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`artifact symlink is forbidden: ${current}`);
    if (entry.isDirectory()) result.push(...walkFiles(current));
    if (entry.isFile()) result.push(current);
  }
  return result;
}

function fileEvidence(filePath) {
  return {
    name: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function exactSha(value, label) {
  const text = String(value || "");
  assert(/^[a-f0-9]{64}$/u.test(text), `${label} is invalid`);
  return text;
}

function exactGitSha(value, label) {
  const text = String(value || "");
  assert(/^[a-f0-9]{40}$/u.test(text), `${label} is invalid`);
  return text;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(safeFile(filePath), "utf8"));
}

function readNdjson(filePath) {
  return fs
    .readFileSync(safeFile(filePath), "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeNdjson(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    right.every((value) => left.includes(value))
  );
}

function equalArrays(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function required(options, name) {
  const value = options[name];
  assert(typeof value === "string" && value.trim(), `--${name} is required`);
  return value.trim();
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const name = item.slice(2);
    const value = argv[index + 1];
    assert(value && !value.startsWith("--"), `--${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(message);
}
