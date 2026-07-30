#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) {
    throw new Error(`invalid argument at index ${index}`);
  }
  args.set(name.slice(2), value);
}
const required = (name) => {
  const value = args.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
};
const sourceRoot = path.resolve(required("source-root"));
const outputRoot = path.resolve(required("output-root"));
const expectedManifestSha = required("expected-source-manifest-sha256");
const expectedRowSha = required("expected-source-row-sha256");
const expectedActive = required("expected-active-revision-id");
const excluded = {
  videoId: required("exclude-video-id"),
  occurrenceId: required("exclude-occurrence-id"),
  reason: required("exclusion-reason"),
};
const transport = {
  sourceRunId: required("source-run-id"),
  sourceArtifactName: required("source-artifact-name"),
  transportRunId: required("transport-run-id"),
  transportRunAttempt: required("transport-run-attempt"),
  transportCommitSha: required("transport-commit-sha"),
};

for (const [label, value] of [
  ["expected source manifest SHA", expectedManifestSha],
  ["expected source row SHA", expectedRowSha],
  ["transport commit SHA", transport.transportCommitSha],
]) {
  if (!/^[0-9a-f]{40}$/.test(value) && label === "transport commit SHA") {
    throw new Error(`${label} is invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(value) && label !== "transport commit SHA") {
    throw new Error(`${label} is invalid`);
  }
}
if (!/^[A-Za-z0-9_-]{11}$/.test(excluded.videoId)) throw new Error("video id is invalid");
if (!/^[A-Za-z0-9:._-]{8,128}$/.test(excluded.occurrenceId)) throw new Error("occurrence id is invalid");
if (!/^[0-9]+$/.test(transport.sourceRunId) || !/^[0-9]+$/.test(transport.transportRunId)) {
  throw new Error("run id is invalid");
}
if (outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}${path.sep}`)) {
  throw new Error("output root must not overlap source root");
}
if (!fs.statSync(sourceRoot).isDirectory()) throw new Error("source root is not a directory");
if (fs.existsSync(outputRoot)) throw new Error("output root already exists");
fs.mkdirSync(outputRoot, { recursive: false });

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readSource = (name) => fs.readFileSync(path.join(sourceRoot, name));
const sourceJson = (name) => JSON.parse(readSource(name).toString("utf8"));
const pretty = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`, "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const write = (name, bytes) => {
  fs.writeFileSync(path.join(outputRoot, name), bytes);
  return { file: name, bytes: bytes.length, sha256: sha(bytes) };
};

const requiredSourceFiles = [
  "artifact-sha256.txt",
  "bound-rules-manifest.json",
  "candidate.ndjson",
  "current-active-binding.json",
  "manifest.json",
  "producer-checkpoint.json",
  "producer-status.txt",
  "review.json",
  "storage.txt",
];
for (const name of requiredSourceFiles) {
  assert(fs.statSync(path.join(sourceRoot, name)).isFile(), `missing source file ${name}`);
}
const sourceDigestRows = readSource("artifact-sha256.txt").toString("utf8").trim().split(/\n/);
const sourceDigests = new Map();
for (const row of sourceDigestRows) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(row);
  assert(match, "source artifact digest syntax is invalid");
  const name = path.basename(match[2]);
  assert(!sourceDigests.has(name), `duplicate source digest ${name}`);
  sourceDigests.set(name, match[1]);
}
for (const name of requiredSourceFiles.filter((name) => name !== "artifact-sha256.txt")) {
  assert(sourceDigests.get(name) === sha(readSource(name)), `source artifact digest mismatch ${name}`);
}
assert(sha(readSource("manifest.json")) === expectedManifestSha, "expected source manifest hash mismatch");

const sourceManifest = sourceJson("manifest.json");
const sourceRules = sourceJson("bound-rules-manifest.json");
const sourceReview = sourceJson("review.json");
const sourceBinding = sourceJson("current-active-binding.json");
const sourceCheckpoint = sourceJson("producer-checkpoint.json");
assert(sourceManifest.status === "ready", "source manifest is not ready");
assert(sourceManifest.activeSnapshotRevisionId === expectedActive, "source active revision mismatch");
assert(sourceBinding.activeRevisionId === expectedActive, "source binding active revision mismatch");
assert(sourceCheckpoint.activeSnapshotRevisionId === expectedActive, "source checkpoint active mismatch");
assert(sourceManifest.patch_sha256 === sha(readSource("candidate.ndjson")), "source patch hash mismatch");
assert(sourceManifest.patch_bytes === readSource("candidate.ndjson").length, "source patch bytes mismatch");
assert(sourceManifest.rulesManifestSha256 === sha(readSource("bound-rules-manifest.json")), "source rules hash mismatch");
assert(sourceManifest.reviewSha256 === sha(readSource("review.json")), "source review hash mismatch");
assert(sourceBinding.boundRulesManifestSha256 === sourceManifest.rulesManifestSha256, "source binding rules mismatch");
assert(sourceCheckpoint.outputs.candidate.sha256 === sourceManifest.patch_sha256, "source checkpoint patch mismatch");
assert(sourceCheckpoint.outputs.manifest.sha256 === expectedManifestSha, "source checkpoint manifest mismatch");
assert(sourceCheckpoint.outputs.review.sha256 === sourceManifest.reviewSha256, "source checkpoint review mismatch");
assert(
  sourceManifest.aliasSourceReview.selectedIdentitiesSha256
    === sha(canonicalBytes(sourceManifest.aliasSourceReview.selectedIdentities)),
  "source identity ledger hash mismatch",
);
assert(
  sourceManifest.aliasSourceGroupsSha256 === sha(canonicalBytes(sourceManifest.aliasSourceGroups)),
  "source group ledger hash mismatch",
);

const rawLines = readSource("candidate.ndjson").toString("utf8").split(/\n/).filter(Boolean);
const rows = rawLines.map((line) => JSON.parse(line));
const matchingIndexes = rows.flatMap((row, index) => (
  row.entityKey === excluded.occurrenceId && row.payload?.videoId === excluded.videoId
    ? [index]
    : []
));
assert(matchingIndexes.length === 1, "excluded patch tuple is missing or ambiguous");
const excludedIndex = matchingIndexes[0];
const excludedLine = Buffer.from(`${rawLines[excludedIndex]}\n`, "utf8");
assert(sha(excludedLine) === expectedRowSha, "expected source row hash mismatch");
const removed = rows[excludedIndex];
const original = removed.payload?.originalIdentity;
assert(
  original?.videoId === excluded.videoId && original?.occurrenceId === excluded.occurrenceId,
  "excluded original identity mismatch",
);
const sourceIdentities = sourceManifest.aliasSourceReview.selectedIdentities;
assert(
  sourceIdentities.filter((row) => row.videoId === excluded.videoId && row.occurrenceId === excluded.occurrenceId).length === 1,
  "source manifest excluded identity is missing or ambiguous",
);
assert(
  sourceIdentities.filter((row) => row.originalTitle === original.title).length === 1,
  "excluded title is not unique in selected source identities",
);

const targetLines = rawLines.filter((_line, index) => index !== excludedIndex);
const patchOutput = write("candidate.ndjson", Buffer.from(`${targetLines.join("\n")}\n`, "utf8"));

const rules = structuredClone(sourceRules);
assert(rules.artistScopedAliases?.length === 1, "source alias rule shape mismatch");
const aliasRule = rules.artistScopedAliases[0];
assert(aliasRule.aliases.filter((title) => title === original.title).length === 1, "excluded alias is not unique");
aliasRule.aliases = aliasRule.aliases.filter((title) => title !== original.title);
aliasRule.expectedMatchCount = rows.length - 1;
rules.expectedAliasMutationCount = rows.length - 1;
const keep = {
  ...excluded,
  rangeId: removed.rangeId,
  seconds: original.seconds,
  originalTitle: original.title,
  originalArtist: original.artist,
  sourceId: original.sourceId,
  sourceHash: original.sourceHash,
  rawHash: original.rawHash,
  expectedSourceRowSha256: expectedRowSha,
};
rules.conservativeKeeps = [keep];
rules.transport = transport;
const rulesOutput = write("bound-rules-manifest.json", pretty(rules));

const binding = structuredClone(sourceBinding);
binding.expectedAliasMutationCount = rows.length - 1;
binding.boundRulesManifestSha256 = rulesOutput.sha256;
binding.conservativeKeeps = [keep];
binding.transport = transport;
const bindingOutput = write("current-active-binding.json", pretty(binding));

const review = structuredClone(sourceReview);
const aliasReviews = review.results.filter((row) => row.kind === "artist_scoped_alias");
assert(aliasReviews.length === 1, "source alias review shape mismatch");
const aliasReview = aliasReviews[0];
assert(
  aliasReview.selectedIdentities.filter((row) => row.videoId === excluded.videoId && row.occurrenceId === excluded.occurrenceId).length === 1,
  "source review excluded identity is missing or ambiguous",
);
aliasReview.matchCount = rows.length - 1;
aliasReview.expectedMatchCount = rows.length - 1;
aliasReview.occurrenceIds = aliasReview.occurrenceIds.filter((value) => value !== excluded.occurrenceId);
aliasReview.selectedIdentities = aliasReview.selectedIdentities.filter(
  (row) => row.videoId !== excluded.videoId || row.occurrenceId !== excluded.occurrenceId,
);
review.conservativeKeeps = [keep];
review.transport = transport;
const reviewOutput = write("review.json", pretty(review));

const manifest = structuredClone(sourceManifest);
const identities = sourceIdentities.filter(
  (row) => row.videoId !== excluded.videoId || row.occurrenceId !== excluded.occurrenceId,
);
const groupFields = [
  "rangeId",
  "originalGroupKey",
  "originalSourceDetailKey",
  "replacementGroupKey",
  "replacementSourceDetailKey",
];
const groupsByKey = new Map();
for (const identity of identities) {
  const key = JSON.stringify(groupFields.map((name) => identity[name]));
  const group = groupsByKey.get(key) ?? {
    ...Object.fromEntries(groupFields.map((name) => [name, identity[name]])),
    count: 0,
  };
  group.count += 1;
  groupsByKey.set(key, group);
}
const groups = [...groupsByKey.values()].sort((left, right) =>
  JSON.stringify(left).localeCompare(JSON.stringify(right))
);
manifest.curationMutationCount = rows.length - 1;
manifest.aliasMutationCount = rows.length - 1;
manifest.aliasSourceGroups = groups;
manifest.aliasSourceGroupCount = groups.length;
manifest.aliasSourceGroupsSha256 = sha(canonicalBytes(groups));
manifest.aliasSourceReview = {
  schemaVersion: 1,
  selectedIdentityCount: identities.length,
  selectedIdentitiesSha256: sha(canonicalBytes(identities)),
  selectedIdentities: identities,
};
manifest.overridesSha256 = rulesOutput.sha256;
manifest.rulesManifestSha256 = rulesOutput.sha256;
manifest.reviewSha256 = reviewOutput.sha256;
manifest.sourceManifestSha256 = sha(
  Buffer.from(`${rulesOutput.sha256}${manifest.snapshotSha256}`, "ascii"),
);
manifest.patch_sha256 = patchOutput.sha256;
manifest.patch_bytes = patchOutput.bytes;
manifest.conservativeKeeps = [keep];
manifest.transport = {
  ...transport,
  expectedSourceManifestSha256: expectedManifestSha,
  expectedSourceRowSha256: expectedRowSha,
  sourceArtifactFilesSha256: Object.fromEntries([...sourceDigests].sort()),
};
const manifestOutput = write("manifest.json", pretty(manifest));

const checkpoint = structuredClone(sourceCheckpoint);
checkpoint.rulesManifestSha256 = rulesOutput.sha256;
checkpoint.outputs.candidate = patchOutput;
checkpoint.outputs.manifest = manifestOutput;
checkpoint.outputs.review = reviewOutput;
checkpoint.transport = manifest.transport;
const checkpointOutput = write("producer-checkpoint.json", pretty(checkpoint));

write("producer-status.txt", Buffer.from(
  `${readSource("producer-status.txt").toString("utf8")}transportStatus=success-artifact-only\n`
  + `transportRunId=${transport.transportRunId}\ntransportRunAttempt=${transport.transportRunAttempt}\n`
  + `sourceRunId=${transport.sourceRunId}\nsourceArtifactName=${transport.sourceArtifactName}\n`
  + `derivedMutationCount=${rows.length - 1}\nexcludedMutationCount=1\n`,
  "utf8",
));
write("storage.txt", Buffer.from(
  `${readSource("storage.txt").toString("utf8")}transportMode=bounded-ubuntu-artifact-only\n`
  + `derivedCandidateBytes=${patchOutput.bytes}\nsourceSnapshotReusedBySha256=${manifest.snapshotSha256}\n`,
  "utf8",
));

const evidence = {
  schemaVersion: 1,
  kind: "curation-conservative-subset-transport",
  status: "ready_artifact_only_no_deploy",
  activeRevisionId: manifest.activeSnapshotRevisionId,
  snapshotSha256: manifest.snapshotSha256,
  snapshotRowCount: manifest.snapshotRowCount,
  sourceMutationCount: rows.length,
  outputMutationCount: rows.length - 1,
  excludedMutation: keep,
  source: {
    ...transport,
    expectedSourceManifestSha256: expectedManifestSha,
    expectedSourceRowSha256: expectedRowSha,
    artifactFilesSha256: Object.fromEntries([...sourceDigests].sort()),
  },
  outputs: {
    candidate: patchOutput,
    rules: rulesOutput,
    binding: bindingOutput,
    review: reviewOutput,
    manifest: manifestOutput,
    checkpoint: checkpointOutput,
  },
};
const evidenceOutput = write("transport-evidence.json", pretty(evidence));

const artifactFiles = fs.readdirSync(outputRoot).sort();
const digestText = artifactFiles.map((name) => {
  const bytes = fs.readFileSync(path.join(outputRoot, name));
  return `${sha(bytes)}  ${name}`;
}).join("\n");
write("artifact-sha256.txt", Buffer.from(`${digestText}\n`, "utf8"));

const result = {
  status: "ready_artifact_only_no_deploy",
  activeRevisionId: manifest.activeSnapshotRevisionId,
  sourceMutationCount: rows.length,
  outputMutationCount: rows.length - 1,
  candidate: patchOutput,
  manifest: manifestOutput,
  evidence: evidenceOutput,
};
const resultPath = args.get("result-output");
if (resultPath) fs.writeFileSync(path.resolve(resultPath), pretty(result));
process.stdout.write(`${JSON.stringify(result)}\n`);
