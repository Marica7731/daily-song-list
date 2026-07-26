#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { finished } = require("node:stream/promises");
const { once } = require("node:events");

const {
  auditSourceForVideo,
  enrichVideoSelectors,
  forEachInventoryVideo,
  normalizeAuditSong,
  recordIncludesBatchTag,
  selectorEvidence,
  selectorMatchesSong,
  songIdentity,
  stableSongSelector,
} = require("./audit-global-song-quality");
const {
  isUnknownArtist,
  loadCurationContext,
} = require("./curation");
const {
  canonicalizeSongIdentity,
  createSongAliasContext,
  loadSongAliasContext,
} = require("./song-aliases");
const RankingUtils = require("../assets/ranking-utils");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA_VERSION = 1;
const DEFAULT_BATCH_TAG = "global-singleton-followup-20260726";
const CLASSIFICATIONS = Object.freeze({
  CHAT: "confirmed_chat_or_translation",
  MERGE: "merge_same_song_high_frequency",
  VERIFIED_SONG: "verified_real_song",
  CHANNEL_ORIGINAL: "channel_original",
  KEEP: "insufficient_evidence_keep",
});

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_GLOBAL_QUALITY_EXPORT_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await exportGlobalQualityCandidates(args);
  console.log(
    `CODEX_GLOBAL_QUALITY_EXPORT_OK candidates=${result.candidateCount} `
      + `runtimeSingletons=${result.cohorts.runtimeSingleton} `
      + `sourceUnknown=${result.cohorts.sourceUnknownArtist} `
      + `targetedReviews=${result.cohorts.targetedReview} `
      + `output=${result.output.path} sha256=${result.output.sha256}`,
  );
}

function parseArgs(argv) {
  const args = {
    inventory: "",
    inventoryMeta: "",
    runtimeSingletons: "",
    runtimeMeta: "",
    outputDir: "",
    checkpointDir: "",
    curationOverrides: path.join(ROOT, "config", "curation-overrides.json"),
    songAliases: path.join(ROOT, "config", "song-aliases.json"),
    batchTag: DEFAULT_BATCH_TAG,
    resume: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--inventory") args.inventory = requireValue(argv, ++index, name);
    else if (name === "--inventory-meta") args.inventoryMeta = requireValue(argv, ++index, name);
    else if (name === "--runtime-singletons") args.runtimeSingletons = requireValue(argv, ++index, name);
    else if (name === "--runtime-meta") args.runtimeMeta = requireValue(argv, ++index, name);
    else if (name === "--output-dir") args.outputDir = requireValue(argv, ++index, name);
    else if (name === "--checkpoint-dir") args.checkpointDir = requireValue(argv, ++index, name);
    else if (name === "--curation-overrides") args.curationOverrides = requireValue(argv, ++index, name);
    else if (name === "--song-aliases") args.songAliases = requireValue(argv, ++index, name);
    else if (name === "--batch-tag") args.batchTag = requireValue(argv, ++index, name);
    else if (name === "--no-resume") args.resume = false;
    else throw new Error(`Unknown argument: ${name}`);
  }
  for (const field of ["inventory", "inventoryMeta", "runtimeSingletons", "runtimeMeta", "outputDir"]) {
    if (!args[field]) throw new Error(`--${camelToKebab(field)} is required`);
  }
  for (const field of ["inventory", "inventoryMeta", "runtimeSingletons", "runtimeMeta", "curationOverrides", "songAliases"]) {
    args[field] = path.resolve(args[field]);
  }
  args.outputDir = path.resolve(args.outputDir);
  args.checkpointDir = path.resolve(args.checkpointDir || path.join(args.outputDir, "checkpoint"));
  return args;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/gu, (character) => `-${character.toLocaleLowerCase()}`);
}

async function exportGlobalQualityCandidates(inputArgs) {
  const args = normalizeArgs(inputArgs);
  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.mkdirSync(args.checkpointDir, { recursive: true });

  const inventoryMeta = readJson(args.inventoryMeta);
  const runtimeMeta = readJson(args.runtimeMeta);
  assertCompleteRuntimeMeta(runtimeMeta);
  const inputs = validateInputArtifacts(args, inventoryMeta, runtimeMeta);
  const contexts = loadContexts(args);
  const analysisKey = sha256Json({
    schemaVersion: SCHEMA_VERSION,
    inventory: inputs.inventory,
    runtimeSingletons: inputs.runtimeSingletons,
    curation: inputs.curationOverrides,
    aliases: inputs.songAliases,
    batchTag: args.batchTag,
    exporter: fileDigest(__filename),
  });
  const outputPath = path.join(args.outputDir, "candidate-classifications.jsonl.gz");
  const manifestPath = path.join(args.outputDir, "manifest.json");

  const resumed = args.resume && validateCompletedOutput(manifestPath, outputPath, analysisKey);
  if (resumed) {
    console.log(`CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=output_resume candidates=${resumed.candidateCount}`);
    return resumed;
  }

  const runtime = await loadRuntimeSingletons(args.runtimeSingletons, runtimeMeta);
  const stats = await loadOrBuildIdentityStats({
    args,
    analysisKey,
    inventoryMeta,
    contexts,
  });
  const exportState = await writeCandidates({
    args,
    analysisKey,
    inventoryMeta,
    runtime,
    stats,
    contexts,
    outputPath,
  });
  const output = fileDigest(outputPath);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    status: "complete",
    analysisKey,
    generatedAt: new Date().toISOString(),
    batchTag: args.batchTag,
    inventory: {
      ...inputs.inventory,
      videoCount: exportState.inventoryVideoCount,
      occurrenceCount: exportState.inventoryOccurrenceCount,
    },
    runtimeSingletons: {
      ...inputs.runtimeSingletons,
      rowCount: runtime.rows.length,
      matchedCount: exportState.runtimeMatchedCount,
      unmatchedCount: runtime.rows.length - exportState.runtimeMatchedCount,
    },
    curation: {
      taggedOverrideCount: contexts.taggedOverrides.length,
      taggedAliasCount: contexts.taggedAliasRecords.length,
    },
    candidateCount: exportState.candidateCount,
    cohorts: exportState.cohorts,
    classifications: exportState.classifications,
    decisions: exportState.decisions,
    output: {
      path: outputPath,
      ...output,
    },
    checkpoint: stats.checkpoint,
  };
  writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

function normalizeArgs(inputArgs) {
  const args = {
    inventory: path.resolve(inputArgs.inventory),
    inventoryMeta: path.resolve(inputArgs.inventoryMeta),
    runtimeSingletons: path.resolve(inputArgs.runtimeSingletons),
    runtimeMeta: path.resolve(inputArgs.runtimeMeta),
    outputDir: path.resolve(inputArgs.outputDir),
    checkpointDir: path.resolve(inputArgs.checkpointDir || path.join(inputArgs.outputDir, "checkpoint")),
    curationOverrides: path.resolve(inputArgs.curationOverrides || path.join(ROOT, "config", "curation-overrides.json")),
    songAliases: path.resolve(inputArgs.songAliases || path.join(ROOT, "config", "song-aliases.json")),
    batchTag: inputArgs.batchTag || DEFAULT_BATCH_TAG,
    resume: inputArgs.resume !== false,
  };
  for (const filePath of [
    args.inventory,
    args.inventoryMeta,
    args.runtimeSingletons,
    args.runtimeMeta,
    args.curationOverrides,
    args.songAliases,
  ]) {
    if (!fs.existsSync(filePath)) throw new Error(`required file not found: ${filePath}`);
  }
  return args;
}

function validateInputArtifacts(args, inventoryMeta, runtimeMeta) {
  const inventory = fileDigest(args.inventory);
  const runtimeSingletons = fileDigest(args.runtimeSingletons);
  const expectedInventorySha = cleanText(inventoryMeta.sha256 || inventoryMeta.output?.sha256);
  const expectedInventoryBytes = Number(inventoryMeta.bytes || inventoryMeta.output?.bytes || 0);
  if (expectedInventorySha && expectedInventorySha !== inventory.sha256) {
    throw new Error(`inventory sha256 mismatch: expected=${expectedInventorySha} actual=${inventory.sha256}`);
  }
  if (expectedInventoryBytes && expectedInventoryBytes !== inventory.bytes) {
    throw new Error(`inventory byte size mismatch: expected=${expectedInventoryBytes} actual=${inventory.bytes}`);
  }
  const expectedRuntimeSha = cleanText(runtimeMeta.output?.sha256);
  const expectedRuntimeBytes = Number(runtimeMeta.output?.bytes || 0);
  if (expectedRuntimeSha && expectedRuntimeSha !== runtimeSingletons.sha256) {
    throw new Error(`runtime singleton sha256 mismatch: expected=${expectedRuntimeSha} actual=${runtimeSingletons.sha256}`);
  }
  if (expectedRuntimeBytes && expectedRuntimeBytes !== runtimeSingletons.bytes) {
    throw new Error(`runtime singleton byte size mismatch: expected=${expectedRuntimeBytes} actual=${runtimeSingletons.bytes}`);
  }
  return {
    inventory,
    runtimeSingletons,
    curationOverrides: fileDigest(args.curationOverrides),
    songAliases: fileDigest(args.songAliases),
  };
}

function assertCompleteRuntimeMeta(meta) {
  if (meta.schemaVersion !== SCHEMA_VERSION) throw new Error(`runtime meta schemaVersion must be ${SCHEMA_VERSION}`);
  if (meta.status !== "complete") throw new Error(`runtime meta status is not complete: ${meta.status || "(missing)"}`);
  if (!Number.isInteger(meta.rowCount) || meta.rowCount < 0) throw new Error("runtime meta rowCount is invalid");
  if (meta.db?.quickCheck !== "ok") throw new Error("runtime database quickCheck is not ok");
}

function loadContexts(args) {
  const curationContext = loadCurationContext({ overridesPath: args.curationOverrides });
  const aliasContext = loadSongAliasContext(args.songAliases);
  if (aliasContext.errors?.length) throw new Error(`song alias config invalid: ${aliasContext.errors.join("; ")}`);
  const taggedOverrides = curationContext.overrides.records.filter((record) => recordIncludesBatchTag(record, args.batchTag));
  const taggedAliasRecords = aliasContext.records.filter((record) => recordIncludesBatchTag(record, args.batchTag));
  const baselineAliases = createSongAliasContext({
    schemaVersion: aliasContext.schemaVersion,
    records: aliasContext.records.filter((record) => !recordIncludesBatchTag(record, args.batchTag)),
  });
  if (baselineAliases.errors?.length) throw new Error(`baseline song alias config invalid: ${baselineAliases.errors.join("; ")}`);
  return {
    curationContext,
    aliasContext,
    baselineAliases,
    taggedOverrides,
    taggedAliasRecords,
  };
}

async function loadRuntimeSingletons(filePath, meta) {
  const rows = [];
  const byVideoSecond = new Map();
  const candidateIds = new Set();
  await forEachGzipJsonLine(filePath, (row) => {
    if (row.schemaVersion !== SCHEMA_VERSION || row.cohort !== "runtime_singleton") {
      throw new Error(`invalid runtime singleton row at index ${rows.length}`);
    }
    if (!row.candidateId || candidateIds.has(row.candidateId)) {
      throw new Error(`duplicate or missing runtime candidateId at index ${rows.length}`);
    }
    candidateIds.add(row.candidateId);
    const normalized = {
      ...row,
      sourceEvidence: [],
      matchedSourceSelectors: new Set(),
      classifications: [],
    };
    rows.push(normalized);
    const key = videoSecondKey(row.videoId, row.seconds);
    if (!byVideoSecond.has(key)) byVideoSecond.set(key, []);
    byVideoSecond.get(key).push(normalized);
  });
  if (rows.length !== meta.rowCount) {
    throw new Error(`runtime singleton row count mismatch: meta=${meta.rowCount} actual=${rows.length}`);
  }
  return { rows, byVideoSecond };
}

async function loadOrBuildIdentityStats({ args, analysisKey, inventoryMeta, contexts }) {
  const checkpointPath = path.join(args.checkpointDir, "identity-stats.json.gz");
  const checkpointMetaPath = path.join(args.checkpointDir, "identity-stats.meta.json");
  if (args.resume && fs.existsSync(checkpointPath) && fs.existsSync(checkpointMetaPath)) {
    const meta = readJson(checkpointMetaPath);
    const digest = fileDigest(checkpointPath);
    if (
      meta.schemaVersion === SCHEMA_VERSION
      && meta.status === "complete"
      && meta.analysisKey === analysisKey
      && meta.output?.sha256 === digest.sha256
      && meta.output?.bytes === digest.bytes
    ) {
      const payload = await readSingleGzipJson(checkpointPath);
      console.log(
        `CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=identity_stats_resume `
          + `videos=${payload.videoCount} occurrences=${payload.occurrenceCount}`,
      );
      return hydrateStats(payload, { path: checkpointPath, ...digest, resumed: true });
    }
  }

  console.log("CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=identity_stats_start");
  const currentIdentityCounts = new Map();
  const knownArtistsByTitle = new Map();
  let videoCount = 0;
  let occurrenceCount = 0;
  await forEachInventoryVideo(args.inventory, (rawVideo) => {
    videoCount += 1;
    const video = enrichVideoSelectors(rawVideo);
    for (const song of video.songs || []) {
      occurrenceCount += 1;
      const normalized = normalizeAuditSong(song, video);
      const current = canonicalizeSongIdentity(normalized, contexts.aliasContext);
      incrementMap(currentIdentityCounts, songIdentity(current.title, current.artist));
      if (!isUnknownArtist(current.artist)) {
        const titleKey = titleKeyForArtistCandidates(current.title);
        if (!knownArtistsByTitle.has(titleKey)) knownArtistsByTitle.set(titleKey, new Map());
        incrementMap(knownArtistsByTitle.get(titleKey), cleanText(current.artist));
      }
    }
    if (videoCount % 5_000 === 0) {
      console.log(
        `CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=identity_stats_progress `
          + `videos=${videoCount} occurrences=${occurrenceCount}`,
      );
    }
  });
  assertInventoryCounts(inventoryMeta, videoCount, occurrenceCount);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    analysisKey,
    videoCount,
    occurrenceCount,
    currentIdentityCounts: Array.from(currentIdentityCounts.entries()).sort(compareFirstField),
    knownArtistsByTitle: Array.from(knownArtistsByTitle.entries())
      .map(([titleKey, artists]) => [titleKey, Array.from(artists.entries()).sort(compareCountEntry)])
      .sort(compareFirstField),
  };
  writeSingleGzipJsonAtomic(checkpointPath, payload);
  const digest = fileDigest(checkpointPath);
  writeJsonAtomic(checkpointMetaPath, {
    schemaVersion: SCHEMA_VERSION,
    status: "complete",
    analysisKey,
    videoCount,
    occurrenceCount,
    output: { path: checkpointPath, ...digest },
  });
  console.log(
    `CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=identity_stats_ok `
      + `videos=${videoCount} occurrences=${occurrenceCount}`,
  );
  return hydrateStats(payload, { path: checkpointPath, ...digest, resumed: false });
}

function hydrateStats(payload, checkpoint) {
  return {
    videoCount: payload.videoCount,
    occurrenceCount: payload.occurrenceCount,
    currentIdentityCounts: new Map(payload.currentIdentityCounts || []),
    knownArtistsByTitle: new Map(
      (payload.knownArtistsByTitle || []).map(([titleKey, artists]) => [titleKey, new Map(artists)]),
    ),
    checkpoint,
  };
}

async function writeCandidates({
  args,
  analysisKey,
  inventoryMeta,
  runtime,
  stats,
  contexts,
  outputPath,
}) {
  console.log("CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=candidate_export_start");
  const writer = createGzipJsonlWriter(outputPath);
  const state = {
    candidateCount: 0,
    cohorts: {
      runtimeSingleton: runtime.rows.length,
      sourceUnknownArtist: 0,
      targetedReview: 0,
    },
    classifications: {},
    decisions: {},
    inventoryVideoCount: 0,
    inventoryOccurrenceCount: 0,
    runtimeMatchedIds: new Set(),
  };

  try {
    await forEachInventoryVideo(args.inventory, async (rawVideo) => {
      state.inventoryVideoCount += 1;
      const video = enrichVideoSelectors(rawVideo);
      for (const song of video.songs || []) {
        state.inventoryOccurrenceCount += 1;
        const review = reviewSourceOccurrence(video, song, contexts, stats);
        const runtimeMatches = matchRuntimeRows(
          review,
          runtime.byVideoSecond.get(videoSecondKey(video.videoId, song.seconds)) || [],
        );
        for (const runtimeRow of runtimeMatches) {
          const selector = stableSongSelector(video, song);
          if (runtimeRow.matchedSourceSelectors.has(selector)) continue;
          runtimeRow.matchedSourceSelectors.add(selector);
          runtimeRow.sourceEvidence.push(review.evidence);
          runtimeRow.classifications.push(review);
          state.runtimeMatchedIds.add(runtimeRow.candidateId);
        }

        if (isUnknownArtist(review.current.artist)) {
          const candidate = sourceCandidate(review, runtimeMatches, "source_unknown_artist");
          await writeCandidate(writer, candidate, state);
          state.cohorts.sourceUnknownArtist += 1;
        }
        if (review.isTargeted && !isUnknownArtist(review.current.artist)) {
          const candidate = sourceCandidate(review, runtimeMatches, "targeted_review");
          await writeCandidate(writer, candidate, state);
          state.cohorts.targetedReview += 1;
        }
      }
      if (state.inventoryVideoCount % 5_000 === 0) {
        console.log(
          `CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=candidate_export_progress `
            + `videos=${state.inventoryVideoCount} candidates=${state.candidateCount}`,
        );
      }
    });

    assertInventoryCounts(inventoryMeta, state.inventoryVideoCount, state.inventoryOccurrenceCount);
    for (const runtimeRow of runtime.rows) {
      const classification = chooseRuntimeClassification(runtimeRow);
      const candidate = {
        schemaVersion: SCHEMA_VERSION,
        candidateId: runtimeRow.candidateId,
        cohorts: ["runtime_singleton"],
        classification: classification.classification,
        decision: classification.decision,
        classificationReason: classification.reason,
        occurrenceCount: 1,
        runtime: runtimeCandidateFields(runtimeRow),
        sourceEvidence: runtimeRow.sourceEvidence.sort(compareEvidence),
        sourceEvidenceCount: runtimeRow.sourceEvidence.length,
        evidenceUrls: uniqueText([
          ...runtimeRow.sourceEvidence.flatMap((evidence) => evidence.evidenceUrls || []),
          youtubeTimestampUrl(runtimeRow.videoId, runtimeRow.seconds),
        ]),
      };
      await writeCandidate(writer, candidate, state);
    }
    await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }

  console.log(
    `CODEX_GLOBAL_QUALITY_EXPORT_PHASE phase=candidate_export_ok `
      + `videos=${state.inventoryVideoCount} candidates=${state.candidateCount}`,
  );
  return {
    candidateCount: state.candidateCount,
    cohorts: state.cohorts,
    classifications: state.classifications,
    decisions: state.decisions,
    inventoryVideoCount: state.inventoryVideoCount,
    inventoryOccurrenceCount: state.inventoryOccurrenceCount,
    runtimeMatchedCount: state.runtimeMatchedIds.size,
    analysisKey,
  };
}

function reviewSourceOccurrence(video, sourceSong, contexts, stats) {
  const normalized = normalizeAuditSong(sourceSong, video);
  const baseline = canonicalizeSongIdentity(normalized, contexts.baselineAliases);
  const current = canonicalizeSongIdentity(normalized, contexts.aliasContext);
  const matchingOverrides = contexts.taggedOverrides.filter((record) => selectorMatchesSong(record, video, sourceSong));
  const exactDrop = matchingOverrides.find((record) => record.action === "drop_entry");
  const exactReplace = matchingOverrides.find((record) => record.action === "replace_entry");
  const aliasChanged = cleanText(baseline.title) !== cleanText(current.title)
    || cleanText(baseline.artist) !== cleanText(current.artist);
  const identityCount = stats.currentIdentityCounts.get(songIdentity(current.title, current.artist)) || 0;
  const knownArtists = knownArtistsForTitle(stats.knownArtistsByTitle, current.title);
  let classification = CLASSIFICATIONS.KEEP;
  let decision = "keep";
  let reason = "no primary evidence sufficient for mutation";
  if (exactDrop) {
    classification = CLASSIFICATIONS.CHAT;
    decision = "drop_entry";
    reason = exactDrop.reason || "reviewed exact selector is non-song commentary";
  } else if (aliasChanged && identityCount >= 2) {
    classification = CLASSIFICATIONS.MERGE;
    decision = "merge";
    reason = `reviewed artist-scoped alias joins ${identityCount} source occurrences`;
  } else if (exactReplace && !isUnknownArtist(current.artist) && identityCount >= 2) {
    classification = CLASSIFICATIONS.MERGE;
    decision = "merge";
    reason = exactReplace.reason || `reviewed replacement joins ${identityCount} source occurrences`;
  }
  const matchingAliasRecords = aliasChanged
    ? contexts.taggedAliasRecords.filter((record) => aliasRecordMatches(record, baseline))
    : [];
  const evidence = {
    ...selectorEvidence(video, sourceSong),
    videoTitle: cleanText(video.title),
    time: cleanText(sourceSong.time),
    sourcePath: sourcePathFor(video),
    sourceUrl: cleanText(video.sourceUrl || video.channelUrl),
    youtubeTimestampUrl: youtubeTimestampUrl(video.videoId, sourceSong.seconds),
    evidenceUrls: uniqueText([
      ...matchingOverrides.flatMap(extractEvidenceUrls),
      ...matchingAliasRecords.flatMap(extractEvidenceUrls),
      youtubeTimestampUrl(video.videoId, sourceSong.seconds),
    ]),
  };
  return {
    video,
    sourceSong,
    baseline,
    current,
    classification,
    decision,
    reason,
    identityCount,
    knownArtists,
    evidence,
    matchingOverrides,
    matchingAliasRecords,
    isTargeted: matchingOverrides.length > 0 || matchingAliasRecords.length > 0,
  };
}

function sourceCandidate(review, runtimeMatches, cohort) {
  const selector = stableSongSelector(review.video, review.sourceSong);
  return {
    schemaVersion: SCHEMA_VERSION,
    candidateId: sha256(`${cohort}\u0000${selector}`).slice(0, 24),
    cohorts: [cohort],
    classification: review.classification,
    decision: review.decision,
    classificationReason: review.reason,
    runtimeSingletonCandidateIds: runtimeMatches.map((row) => row.candidateId).sort(),
    baseline: songFields(review.baseline),
    current: songFields(review.current),
    canonicalOccurrenceCount: review.identityCount,
    sameTitleKnownArtists: review.knownArtists,
    mergePriority: review.knownArtists.length
      ? "review_same_title_known_artist_before_artist_fill"
      : "no_known_same_title_artist",
    evidence: review.evidence,
    evidenceUrls: review.evidence.evidenceUrls,
  };
}

function matchRuntimeRows(review, rows) {
  if (!rows.length) return [];
  const sourceTitleKeys = new Set(
    [
      review.baseline.title,
      review.current.title,
      ...review.matchingOverrides.map((record) => record.replacement?.title),
    ]
      .map(titleKeyForArtistCandidates)
      .filter(Boolean),
  );
  return rows.filter((row) => sourceTitleKeys.has(titleKeyForArtistCandidates(row.title)));
}

function chooseRuntimeClassification(runtimeRow) {
  const ranked = [...runtimeRow.classifications].sort((left, right) => (
    classificationRank(left.classification) - classificationRank(right.classification)
  ));
  const selected = ranked[0];
  if (selected) {
    return {
      classification: selected.classification,
      decision: selected.decision,
      reason: selected.reason,
    };
  }
  return {
    classification: CLASSIFICATIONS.KEEP,
    decision: "keep",
    reason: runtimeRow.sourceEvidence.length
      ? "source evidence did not justify mutation"
      : "runtime singleton had no exact raw inventory match; retain pending provenance recovery",
  };
}

function classificationRank(value) {
  if (value === CLASSIFICATIONS.CHAT) return 0;
  if (value === CLASSIFICATIONS.MERGE) return 1;
  if (value === CLASSIFICATIONS.VERIFIED_SONG) return 2;
  if (value === CLASSIFICATIONS.CHANNEL_ORIGINAL) return 3;
  return 4;
}

function runtimeCandidateFields(row) {
  return {
    occurrenceId: cleanText(row.occurrenceId),
    songKey: cleanText(row.songKey),
    videoId: cleanText(row.videoId),
    seconds: Number(row.seconds) || 0,
    title: cleanText(row.title),
    artist: cleanText(row.artist),
    isUnknownArtist: Boolean(row.isUnknownArtist),
    sourceSystem: cleanText(row.sourceSystem),
    sourceId: cleanText(row.sourceId),
  };
}

function songFields(song) {
  return {
    title: cleanText(song.title),
    artist: cleanText(song.artist),
    isUnknownArtist: isUnknownArtist(song.artist),
  };
}

function knownArtistsForTitle(knownArtistsByTitle, title) {
  const artists = knownArtistsByTitle.get(titleKeyForArtistCandidates(title));
  if (!artists) return [];
  return Array.from(artists.entries())
    .map(([artist, count]) => ({ artist, count }))
    .sort((left, right) => right.count - left.count || left.artist.localeCompare(right.artist))
    .slice(0, 10);
}

function titleKeyForArtistCandidates(title) {
  return RankingUtils.songWorkTitleKey(cleanText(title))
    || RankingUtils.normalizeSongTitleKey(cleanText(title));
}

function aliasRecordMatches(record, song) {
  const artistKey = RankingUtils.normalizeArtistKey(record.artist);
  const songArtistKey = RankingUtils.normalizeArtistKey(song.artist);
  if (!artistKey || artistKey !== songArtistKey) return false;
  const titleKey = RankingUtils.normalizeSongTitleKey(song.title);
  return [record.canonicalTitle, ...(record.aliases || [])]
    .some((title) => RankingUtils.normalizeSongTitleKey(title) === titleKey);
}

function extractEvidenceUrls(record) {
  const values = Array.isArray(record.evidenceUrls) ? record.evidenceUrls : [];
  const noteUrls = cleanText(record.note).match(/https?:\/\/[^\s)]+/gu) || [];
  return uniqueText([...values, ...noteUrls]);
}

function sourcePathFor(video) {
  const acceptedFile = cleanText(video.discoveryImport?.acceptedFile);
  if (acceptedFile) return `data/external/youtube-channel-discovery/accepted/${acceptedFile}`;
  const source = auditSourceForVideo(video);
  if (source === "vsinger_moment_http") return "data/external/vsinger-http/backfill";
  return "data/latest.json";
}

function youtubeTimestampUrl(videoId, seconds) {
  const id = cleanText(videoId);
  if (!id) return "";
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${Math.max(0, Number(seconds) || 0)}s`;
}

function assertInventoryCounts(meta, videoCount, occurrenceCount) {
  const expectedVideos = Number(meta.videoCount || 0);
  const expectedOccurrences = Number(meta.occurrenceCount || 0);
  if (expectedVideos && expectedVideos !== videoCount) {
    throw new Error(`inventory video count mismatch: meta=${expectedVideos} actual=${videoCount}`);
  }
  if (expectedOccurrences && expectedOccurrences !== occurrenceCount) {
    throw new Error(`inventory occurrence count mismatch: meta=${expectedOccurrences} actual=${occurrenceCount}`);
  }
}

function validateCompletedOutput(manifestPath, outputPath, analysisKey) {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(outputPath)) return null;
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.status !== "complete" || manifest.analysisKey !== analysisKey) {
    return null;
  }
  const digest = fileDigest(outputPath);
  if (manifest.output?.sha256 !== digest.sha256 || manifest.output?.bytes !== digest.bytes) return null;
  return manifest;
}

function createGzipJsonlWriter(outputPath) {
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = fs.createWriteStream(tempPath);
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(output);
  let closed = false;
  return {
    async write(value) {
      if (!gzip.write(`${JSON.stringify(value)}\n`)) await once(gzip, "drain");
    },
    async finish() {
      gzip.end();
      await finished(output);
      fs.renameSync(tempPath, outputPath);
      closed = true;
    },
    async abort() {
      if (!closed) {
        gzip.destroy();
        output.destroy();
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup of this process's temporary output only.
        }
      }
    },
  };
}

async function writeCandidate(writer, candidate, state) {
  await writer.write(candidate);
  state.candidateCount += 1;
  incrementObject(state.classifications, candidate.classification);
  incrementObject(state.decisions, candidate.decision);
}

async function forEachGzipJsonLine(filePath, callback) {
  const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    await callback(JSON.parse(line), index);
    index += 1;
  }
}

function writeSingleGzipJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  const compressed = zlib.gzipSync(raw, { level: 6, mtime: 0 });
  try {
    fs.writeFileSync(tempPath, compressed);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of this process's temporary checkpoint only.
    }
    throw error;
  }
}

async function readSingleGzipJson(filePath) {
  const compressed = fs.readFileSync(filePath);
  return JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
}

function fileDigest(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of this process's temporary manifest only.
    }
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function incrementObject(object, key) {
  object[key] = (object[key] || 0) + 1;
}

function compareFirstField(left, right) {
  return String(left[0]).localeCompare(String(right[0]));
}

function compareCountEntry(left, right) {
  return right[1] - left[1] || String(left[0]).localeCompare(String(right[0]));
}

function compareEvidence(left, right) {
  return cleanText(left.sourceId).localeCompare(cleanText(right.sourceId))
    || Number(left.seconds) - Number(right.seconds)
    || cleanText(left.rawHash).localeCompare(cleanText(right.rawHash));
}

function videoSecondKey(videoId, seconds) {
  return `${cleanText(videoId)}\u0001${Math.max(0, Number(seconds) || 0)}`;
}

function uniqueText(values) {
  return Array.from(new Set((values || []).map(cleanText).filter(Boolean)));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

module.exports = {
  CLASSIFICATIONS,
  exportGlobalQualityCandidates,
  parseArgs,
};
