#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  extractMygitTodaySnapshotItems,
  fetchVideoSongList,
} = require("../update-songlist");
const {
  buildStaticSite,
  compactCandidate,
  initialState,
  persistCompleted,
  readDayVideos,
} = require("./collect-and-build");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const SOURCES = require("./recovery-sources.json");
const MODE = argument("--mode") || process.env.STATIC_RECOVERY_MODE || "legacy";
const DATE = argument("--date") || process.env.STATIC_RECOVERY_DATE || "";
const LIMIT = positiveInt(process.env.STATIC_RECOVERY_LIMIT, 700);
const BUDGET_MS = positiveInt(process.env.STATIC_RECOVERY_BUDGET_MS, 20 * 60 * 1000);
const MAX_SHARD_BYTES = positiveInt(process.env.STATIC_MAX_SHARD_BYTES, 4_000_000);
const NOW = new Date(process.env.STATIC_NOW || Date.now());
const TARGET_DATES = Object.keys(SOURCES.dates).sort();

if (require.main === module) {
  main().catch((error) => {
    console.error(`[static-recovery] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  assertOwnedRoot(DATA_ROOT);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const statePath = path.join(DATA_ROOT, "state.json");
  const state = readJsonIfExists(statePath) || initialState(NOW);
  migrateRecoveryState(state);
  let outcome;
  if (MODE === "legacy") outcome = await recoverLegacy(state);
  else if (MODE === "date") outcome = await recoverDate(state, DATE);
  else throw new Error(`unsupported recovery mode: ${MODE}`);
  state.historyGaps = computeHistoryGaps(state.historyDays);
  state.updatedAt = NOW.toISOString();
  writeJson(statePath, state);
  const meta = buildStaticSite(DATA_ROOT, state, NOW, { maxShardBytes: MAX_SHARD_BYTES });
  const result = { schemaVersion: 1, mode: MODE, date: DATE || null, at: NOW.toISOString(), ...outcome };
  writeJson(path.join(DATA_ROOT, "recovery", "last-run.json"), result);
  console.log(`[static-recovery] mode=${MODE} date=${DATE || "-"} status=${result.status} videos=${meta.videoCount} allSongs=${meta.ranges.all.songs.totalCount}`);
}

async function recoverLegacy(state) {
  const source = SOURCES.legacyAll;
  const url = rawUrl(source.repository, source.commit, source.path);
  const bytes = await fetchBytes(url);
  const proof = verifySourceBytes(bytes, source);
  const document = JSON.parse(bytes.toString("utf8"));
  const summary = importLegacyDocument(DATA_ROOT, state, document, source, NOW, MAX_SHARD_BYTES);
  state.legacyBaseline = { status: "COMPLETE", ...source, rawSha256: proof.sha256, ...summary };
  state.sourceCoverage = { provider: "GitHub immutable legacy all", status: "success", commit: source.commit, gitBlobSha1: source.gitBlobSha1 };
  return { status: "COMPLETE", proof, ...summary };
}

async function recoverDate(state, date) {
  if (!TARGET_DATES.includes(date)) throw new Error(`date must be one of ${TARGET_DATES.join(",")}`);
  if (state.legacyBaseline?.status !== "COMPLETE") throw new Error("legacy baseline must be recovered before date recovery");
  const source = SOURCES.dates[date];
  const sourcePath = `data/today-snapshots/${source.snapshotId}.json`;
  const bytes = await fetchBytes(rawUrl("Marica7731/mygit", source.commit, sourcePath));
  const proof = verifySourceBytes(bytes, source);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  if (snapshot.snapshotId !== source.snapshotId) throw new Error(`snapshot identity mismatch: ${snapshot.snapshotId}`);
  const coverage = snapshotCoverage(snapshot);
  const items = extractMygitTodaySnapshotItems(snapshot, {
    snapshotId: source.snapshotId,
    snapshotUrl: rawUrl("Marica7731/mygit", source.commit, sourcePath),
    capturedAt: source.capturedAt,
  });
  const progress = state.recoveryDates[date] || { attempts: 0, noProgressAttempts: 0, processedEligibleVideos: 0 };
  const processed = new Set(state.processedVideoIds || []);
  const pending = items.filter((item) => !processed.has(item.videoId));
  const batch = pending.slice(0, LIMIT);
  const completed = [];
  const failures = [];
  const startedAtMs = Date.now();
  let inspected = 0;
  let checkpointReason = batch.length
    ? pending.length > batch.length ? "video_limit" : "batch_exhausted"
    : "no_pending_videos";
  for (const candidate of batch) {
    if (recoveryBudgetExpired(startedAtMs, BUDGET_MS, Date.now(), inspected)) {
      checkpointReason = "time_budget";
      break;
    }
    console.log(`[static-recovery] date=${date} video=${candidate.videoId} checkpoint=${inspected + 1}/${batch.length} elapsedMs=${Date.now() - startedAtMs}`);
    try {
      const result = await fetchVideoSongList(candidate);
      completed.push({ candidate: compactCandidate(candidate, { snapshotId: source.snapshotId, capturedAt: source.capturedAt }), result });
      console.log(`[static-recovery] date=${date} video=${candidate.videoId} result=${result.audit?.result || "unknown"} songs=${result.detail?.songs?.length || 0}`);
    } catch (error) {
      failures.push({ videoId: candidate.videoId, message: error.message });
    } finally {
      inspected += 1;
    }
    if (recoveryBudgetExpired(startedAtMs, BUDGET_MS, Date.now(), inspected)) {
      checkpointReason = "time_budget";
      break;
    }
  }
  persistCompleted(state, completed, NOW, DATA_ROOT);
  const remaining = items.filter((item) => !(state.processedVideoIds || []).includes(item.videoId)).length;
  progress.attempts += 1;
  progress.noProgressAttempts = completed.length ? 0 : progress.noProgressAttempts + 1;
  progress.status = remaining === 0 && coverage.complete ? "COMPLETE" : "MISSING";
  progress.processingStatus = remaining === 0 ? "PROCESSED" : "IN_PROGRESS";
  progress.source = { ...source, path: sourcePath, rawSha256: proof.sha256 };
  progress.eligibleVideos = items.length;
  progress.processedEligibleVideos = items.length - remaining;
  progress.remainingVideos = remaining;
  progress.coverage = coverage;
  progress.lastCompleted = completed.length;
  progress.lastInspected = inspected;
  progress.lastFailures = failures.slice(0, 20);
  progress.checkpointReason = checkpointReason;
  progress.checkpointElapsedMs = Date.now() - startedAtMs;
  progress.updatedAt = NOW.toISOString();
  state.recoveryDates[date] = progress;
  state.historyDays[date] = progress.status;
  state.lastSourceSnapshotId = source.snapshotId;
  state.lastSourceCapturedAt = source.capturedAt;
  return { status: progress.status, processingStatus: progress.processingStatus, remaining, inspected, completed: completed.length, failures: failures.length, checkpointReason, checkpointElapsedMs: progress.checkpointElapsedMs, noProgressAttempts: progress.noProgressAttempts, coverage, proof };
}

function importLegacyDocument(dataRoot, state, document, source, now, maxShardBytes) {
  if (document.id !== "all" || document.retentionPolicy !== "permanent") throw new Error("legacy document is not the permanent all dataset");
  if (document.generatedAt !== source.generatedAt) throw new Error(`legacy generatedAt mismatch: ${document.generatedAt}`);
  if (!Array.isArray(document.items) || document.items.length === 0) throw new Error("legacy all is empty");
  const existingIds = new Set(readDayVideos(dataRoot).map((item) => item.videoId));
  const byDay = new Map();
  const seenVideos = new Set();
  const seenOccurrences = new Set();
  const identityAudit = { derivedOccurrenceIds: 0, rejectedEmptyTitles: 0, missingChannelIds: 0 };
  let occurrences = 0;
  let reviewedUnknown = 0;
  for (const item of document.items) {
    const video = normalizeLegacyVideo(item, source, document.generatedAt, identityAudit);
    if (seenVideos.has(video.videoId)) throw new Error(`duplicate legacy video: ${video.videoId}`);
    seenVideos.add(video.videoId);
    for (const song of video.songs) {
      const key = `${video.videoId}\u001f${song.occurrenceId}`;
      if (seenOccurrences.has(key)) throw new Error(`duplicate legacy occurrence: ${key}`);
      seenOccurrences.add(key);
      occurrences += 1;
      if (song.needsReview && !song.artist) reviewedUnknown += 1;
    }
    if (existingIds.has(video.videoId)) continue;
    const day = video.publishedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(video);
  }
  let shardCount = 0;
  for (const [day, videos] of [...byDay.entries()].sort()) {
    shardCount += writeDayParts(dataRoot, day, videos, now, maxShardBytes);
  }
  state.processedVideoIds = [...new Set([...(state.processedVideoIds || []), ...seenVideos])].sort();
  const timestamps = document.items.map((item) => Number(item.publishedTimestamp)).filter(Number.isFinite);
  state.continuityStart = new Date(Math.min(...timestamps)).toISOString();
  return { videoCount: seenVideos.size, occurrenceCount: occurrences, reviewedUnknown, ...identityAudit, dayCount: byDay.size, shardCount, importedAt: now.toISOString() };
}

function normalizeLegacyVideo(item, source, generatedAt, identityAudit = { derivedOccurrenceIds: 0, rejectedEmptyTitles: 0, missingChannelIds: 0 }) {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(String(item.videoId || ""))) throw new Error(`invalid legacy videoId: ${item.videoId}`);
  if (!item.title || !item.channelName) throw new Error(`legacy video metadata incomplete: ${item.videoId}`);
  if (!item.channelId) identityAudit.missingChannelIds += 1;
  const publishedMs = Number(item.publishedTimestamp);
  if (!Number.isFinite(publishedMs)) throw new Error(`legacy eventTime missing: ${item.videoId}`);
  if (publishedMs > Date.parse(generatedAt) + 6 * 3600000) throw new Error(`legacy eventTime is future: ${item.videoId}`);
  if (!Array.isArray(item.songs)) throw new Error(`legacy songs missing: ${item.videoId}`);
  return {
    videoId: item.videoId,
    title: item.title,
    channelName: item.channelName,
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    channelIdentityStatus: item.channelId ? "known" : "legacy-missing",
    publishedAt: new Date(publishedMs).toISOString(),
    thumbnailUrl: item.thumbnailUrl || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
    watchUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
    keyword: "legacy-all",
    keywords: item.sourceGroups || [],
    sourceSnapshotId: source.commit,
    sourceCapturedAt: generatedAt,
    songs: item.songs.flatMap((song) => {
      if (!song.title) {
        identityAudit.rejectedEmptyTitles += 1;
        return [];
      }
      if (typeof song.artist !== "string" || !song.sourceHash) throw new Error(`legacy occurrence incomplete: video=${item.videoId} index=${song.index || ""}`);
      let occurrenceId = song.occurrenceId || "";
      if (!occurrenceId) {
        const sourceId = song.sourceId || item.selectedSourceId || "";
        const seconds = Number(song.seconds);
        if (!sourceId || !Number.isFinite(seconds) || !song.rawHash) throw new Error(`legacy occurrence identity unavailable: video=${item.videoId} index=${song.index || ""}`);
        occurrenceId = `${item.videoId}:${sourceId}:${seconds}:${song.rawHash.slice(0, 16)}`;
        identityAudit.derivedOccurrenceIds += 1;
      }
      return {
        occurrenceId,
        time: song.time || "",
        seconds: Number.isFinite(Number(song.seconds)) ? Number(song.seconds) : 0,
        title: song.title,
        artist: song.artist,
        raw: song.raw || "",
        sourceId: song.sourceId || item.selectedSourceId || "",
        sourceHash: song.sourceHash,
        needsReview: song.needsReview === true,
      };
    }),
  };
}

function writeDayParts(dataRoot, day, videos, now, maxShardBytes) {
  const dayRoot = path.join(dataRoot, "days", day);
  fs.rmSync(dayRoot, { recursive: true, force: true });
  fs.mkdirSync(dayRoot, { recursive: true });
  const parts = [];
  let current = [];
  for (const video of videos.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.videoId.localeCompare(b.videoId))) {
    const candidate = [...current, video];
    const bytes = Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1, day, updatedAt: now.toISOString(), videos: candidate }, null, 2)}\n`);
    if (current.length && bytes > maxShardBytes) {
      parts.push(current);
      current = [video];
    } else current = candidate;
  }
  if (current.length) parts.push(current);
  parts.forEach((part, index) => {
    const file = path.join(dayRoot, `part-${String(index + 1).padStart(4, "0")}.json`);
    writeJson(file, { schemaVersion: 1, day, updatedAt: now.toISOString(), videos: part });
    if (fs.statSync(file).size > maxShardBytes) throw new Error(`legacy day shard exceeds limit: ${file}`);
  });
  return parts.length;
}

function migrateRecoveryState(state) {
  state.historyDays ||= Object.fromEntries(TARGET_DATES.map((date) => [date, "MISSING"]));
  for (const date of TARGET_DATES) if (!['COMPLETE', 'MISSING'].includes(state.historyDays[date])) state.historyDays[date] = "MISSING";
  state.recoveryDates ||= {};
}

function computeHistoryGaps(historyDays) {
  const missing = TARGET_DATES.filter((date) => historyDays?.[date] !== "COMPLETE");
  const gaps = [];
  let start = "";
  let previous = "";
  for (const date of missing) {
    if (!start) { start = date; previous = date; continue; }
    const expected = new Date(`${previous}T00:00:00Z`); expected.setUTCDate(expected.getUTCDate() + 1);
    if (expected.toISOString().slice(0, 10) === date) previous = date;
    else { gaps.push({ from: start, through: previous, status: "MISSING" }); start = previous = date; }
  }
  if (start) gaps.push({ from: start, through: previous, status: "MISSING" });
  return gaps;
}

function snapshotCoverage(snapshot) {
  const sources = Array.isArray(snapshot?.groups?.today?.sources) ? snapshot.groups.today.sources : [];
  const incomplete = sources.filter((source) => source.truncatedByLimit === true || source.reachedBottom !== true)
    .map((source) => ({ keyword: source.keyword || "", itemCount: source.itemCount || 0, limit: source.limit || 0, reachedBottom: source.reachedBottom === true, truncatedByLimit: source.truncatedByLimit === true }));
  return {
    complete: sources.length > 0 && incomplete.length === 0,
    status: sources.length > 0 && incomplete.length === 0 ? "COMPLETE" : "MISSING",
    sourceCount: sources.length,
    incomplete,
  };
}

function verifySourceBytes(bytes, source) {
  if (bytes.length !== source.bytes) throw new Error(`source size mismatch: ${bytes.length} != ${source.bytes}`);
  const blobSha1 = gitBlobSha1(bytes);
  if (blobSha1 !== source.gitBlobSha1) throw new Error(`source blob mismatch: ${blobSha1} != ${source.gitBlobSha1}`);
  return { bytes: bytes.length, gitBlobSha1: blobSha1, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function gitBlobSha1(bytes) { return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); }
async function fetchBytes(url) { const response = await fetch(url); if (!response.ok) throw new Error(`source HTTP ${response.status}: ${url}`); return Buffer.from(await response.arrayBuffer()); }
function rawUrl(repository, commit, file) { return `https://raw.githubusercontent.com/${repository}/${commit}/${file}`; }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? String(process.argv[index + 1] || "") : ""; }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function recoveryBudgetExpired(startedAtMs, budgetMs, nowMs = Date.now(), inspected = 0) { return inspected > 0 && nowMs - startedAtMs >= budgetMs; }
function assertOwnedRoot(root) { const normalized = path.resolve(root); if (normalized === path.parse(normalized).root || !normalized.replaceAll("\\", "/").endsWith("/data/static/v1")) throw new Error(`refusing unsafe static data root: ${normalized}`); }
function readJsonIfExists(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(temporary, file); }

module.exports = { computeHistoryGaps, gitBlobSha1, importLegacyDocument, migrateRecoveryState, normalizeLegacyVideo, recoveryBudgetExpired, snapshotCoverage, verifySourceBytes };
