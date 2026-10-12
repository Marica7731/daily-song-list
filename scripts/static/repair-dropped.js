#!/usr/bin/env node
"use strict";

// Audits videos that state.json claims are processed but that never landed in any day shard,
// publishes an auditable ledger, and optionally re-queues them by videoId alone.
//
// Why this exists: persistCompleted used to mark every inspected video as processed before
// checking whether the inspection actually produced songs. A zero-song scrape (429, missing
// comment continuation, partial render) therefore removed the video from every future run
// without leaving a trace anywhere: not in the shards, not in lastFailures, not in review.
// Those videos are recoverable because fetchVideoSongList only needs the id - channel, title
// and publish time are backfilled from the watch page - but they are no longer offered by the
// live source, so they have to be re-queued from this ledger.
//
// Two inputs make that re-queue honest rather than optimistic:
// - recovery/priority-ids.json hoists named videos ahead of the id-sorted backlog, so a
//   reported video does not wait behind thousands of others to be retried.
// - noSongAttemptsSchema invalidates zero-song verdicts recorded before the parser learned
//   to read attributedDescription content; those verdicts cannot spend a retry budget.
// A 429 leaves state untouched, so a throttled pass loses nothing and is retried later.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const NOW = new Date(process.env.STATIC_NOW || Date.now());
const SEED_LIMIT = boundedInt(process.env.STATIC_REPAIR_SEED_LIMIT, 0);
const MAX_ATTEMPTS = boundedInt(process.env.STATIC_MAX_NO_SONG_ATTEMPTS, 3);
const LEDGER_PATH = path.join(DATA_ROOT, "recovery", "dropped-videos.json");
const PRIORITY_PATH = path.join(DATA_ROOT, "recovery", "priority-ids.json");
const REPAIR_SOURCE_GROUP = "static_repair";
// Bump whenever the song parser gains a source field it could not read before. Retry
// counters were produced by the old parser, so a zero-song verdict from a lower schema
// says nothing about the video and must not be able to spend the budget or go terminal.
const NO_SONG_ATTEMPTS_SCHEMA = 2;

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[static-repair] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function main() {
  assertOwnedRoot(DATA_ROOT);
  const statePath = path.join(DATA_ROOT, "state.json");
  const state = readJsonIfExists(statePath) || { processedVideoIds: [], queue: [] };
  if (Number(state.noSongAttemptsSchema || 0) !== NO_SONG_ATTEMPTS_SCHEMA) {
    state.noSongAttempts = {};
    state.noSongAttemptsSchema = NO_SONG_ATTEMPTS_SCHEMA;
    writeJson(statePath, state);
  }
  const { ids: published, metadataIncomplete, unreadable } = collectPublishedVideoIds(DATA_ROOT);
  const processed = [...new Set(state.processedVideoIds || [])].sort();
  const noSongAttempts = state.noSongAttempts || {};
  const queuedVideoIds = new Set((state.queue || []).map((entry) => entry.videoId));
  const queuedMetadataRepairCount = metadataIncomplete.filter((videoId) => queuedVideoIds.has(videoId)).length;
  const dropped = processed.filter((videoId) => !published.has(videoId));
  const attemptsFor = (videoId) => Number(noSongAttempts[videoId]?.attempts || 0);
  const priorityIds = readPriorityIds();
  const prioritySet = new Set(priorityIds);
  // A video that spent its whole retry budget without ever yielding songs will never
  // recover. Counting it as repairable would keep droppedVideoCount above zero forever
  // and make the continuation step chain indefinitely, so it is reported separately.
  // Explicitly reported ids are the exception: throttling produces partial watch pages that
  // look exactly like "no songs", so a named video must not be retired by one bad window.
  const repairable = dropped.filter((videoId) => prioritySet.has(videoId) || attemptsFor(videoId) < MAX_ATTEMPTS);
  const incompleteSet = new Set(metadataIncomplete);

  const ledger = {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    processedVideoCount: processed.length,
    publishedVideoCount: published.size,
    unpublishedVideoCount: dropped.length,
    droppedVideoCount: repairable.length,
    abandonedVideoCount: dropped.length - repairable.length,
    metadataIncompleteVideoCount: metadataIncomplete.length,
    metadataIncompleteVideoIds: metadataIncomplete.slice(0, 200),
    maxNoSongAttempts: MAX_ATTEMPTS,
    unreadableShardCount: unreadable.length,
    unreadableShards: unreadable.slice(0, 10),
    dropped: dropped.map((videoId) => ({
      videoId,
      attempts: attemptsFor(videoId),
      repairable: attemptsFor(videoId) < MAX_ATTEMPTS,
      lastResult: noSongAttempts[videoId]?.lastResult || null,
      lastAttemptAt: noSongAttempts[videoId]?.lastAttemptAt || null,
    })),
  };
  writeJson(LEDGER_PATH, ledger);

  let seeded = 0;
  if (SEED_LIMIT > 0) {
    const queued = new Set((state.queue || []).map((entry) => entry.videoId));
    const capturedAt = state.lastSourceCapturedAt || NOW.toISOString();
    // Reported videos are seeded first: the dropped list is id-sorted, so a video whose id
    // starts with a lowercase letter would otherwise wait behind thousands of others.
    const droppedSet = new Set(dropped);
    const priority = priorityIds.filter((videoId) => droppedSet.has(videoId) || incompleteSet.has(videoId));
    // Published records that shipped without title/channel are already "done" as far as the
    // dropped audit is concerned, but they sit in the wrong day shard and are invisible to
    // search. Re-queue them right behind the reported ids.
    const metadataFirst = metadataIncomplete.filter((videoId) => !prioritySet.has(videoId));
    const frontSet = new Set([...priority, ...metadataFirst]);
    const seedOrder = [
      ...priority,
      ...metadataFirst,
      ...dropped.filter((videoId) => !frontSet.has(videoId)),
    ];
    // Priority means "processed in this pass": an id already sitting behind a long queue
    // has to move to the front, otherwise it waits several passes anyway.
    state.queue = [
      ...state.queue.filter((entry) => frontSet.has(entry.videoId)),
      ...state.queue.filter((entry) => !frontSet.has(entry.videoId)),
    ];
    const priorityEntries = [];
    const backlogEntries = [];
    for (const videoId of seedOrder) {
      if (seeded >= SEED_LIMIT) break;
      if (queued.has(videoId)) continue;
      if (!frontSet.has(videoId) && attemptsFor(videoId) >= MAX_ATTEMPTS) continue;
      const entry = {
        videoId,
        title: "",
        channelName: "",
        channelId: "",
        channelHandle: "",
        keyword: "",
        keywords: [],
        sourceGroup: REPAIR_SOURCE_GROUP,
        sourceGroups: [REPAIR_SOURCE_GROUP],
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        sourceUrls: [`https://www.youtube.com/watch?v=${videoId}`],
        publishedText: "",
        publishedTimestamp: null,
        durationText: "",
        thumbnailUrl: "",
        snapshotId: `repair-${NOW.toISOString().replace(/[-:.]/gu, "").slice(0, 15)}Z`,
        snapshotCapturedAt: capturedAt,
      };
      if (frontSet.has(videoId)) priorityEntries.push(entry);
      else backlogEntries.push(entry);
      queued.add(videoId);
      seeded += 1;
    }
    if (priorityEntries.length) {
      state.queue = [...priorityEntries, ...state.queue.filter((entry) => !frontSet.has(entry.videoId))];
    }
    state.queue.push(...backlogEntries);
    state.updatedAt = NOW.toISOString();
    writeJson(statePath, state);
    writePriorityIds(priority.filter((videoId) => droppedSet.has(videoId) || incompleteSet.has(videoId)));
  }

  console.log(
    `[static-repair] processed=${processed.length} published=${published.size} unpublished=${dropped.length} repairable=${repairable.length} abandoned=${dropped.length - repairable.length} priority=${priorityIds.length} priorityRepairable=${dropped.filter((videoId) => prioritySet.has(videoId) && attemptsFor(videoId) >= MAX_ATTEMPTS).length} noSongSchema=${state.noSongAttemptsSchema} unreadable=${unreadable.length} seeded=${seeded} queue=${(state.queue || []).length}`,
  );
}

// Reads every day shard and keeps only the ids, so a 70MB tree does not have to be held in
// memory at once. Handles both shard layouts: single YYYY-MM-DD.json files and legacy
// YYYY-MM-DD/part-NNNN.json directories.
function collectPublishedVideoIds(dataRoot) {
  const daysRoot = path.join(dataRoot, "days");
  const ids = new Set();
  const metadataIncomplete = [];
  if (!fs.existsSync(daysRoot)) return { ids, metadataIncomplete, unreadable: [] };
  const files = [];
  for (const name of fs.readdirSync(daysRoot).sort()) {
    const target = path.join(daysRoot, name);
    if (/^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && fs.statSync(target).isFile()) files.push(target);
    if (/^\d{4}-\d{2}-\d{2}$/u.test(name) && fs.statSync(target).isDirectory()) {
      for (const part of fs.readdirSync(target).filter((item) => /^part-\d{4}\.json$/u.test(item)).sort()) {
        files.push(path.join(target, part));
      }
    }
  }
  const unreadable = [];
  for (const file of files) {
    // One malformed or truncated shard must not abort the whole audit: the repair pass
    // depends on this number, and a single bad file used to block every recovery run.
    try {
      const shard = readJson(file);
      for (const video of shard.videos || []) {
        if (!video?.videoId) continue;
        ids.add(video.videoId);
        // An id-only repair whose watch metadata was unavailable still publishes its songs,
        // but with an empty title/channel and the capture time as the publish date, which puts
        // it in the wrong day shard. Those records need one more inspection.
        if (!String(video.title || "").trim() || !String(video.channelName || "").trim()) {
          metadataIncomplete.push(video.videoId);
        }
      }
    } catch (error) {
      unreadable.push({ file: path.relative(dataRoot, file), message: error.message });
    }
  }
  return { ids, metadataIncomplete, unreadable };
}

function assertOwnedRoot(root) {
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root || !normalized.replaceAll("\\", "/").endsWith("/data/static/v1")) {
    throw new Error(`refusing unsafe static data root: ${normalized}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfExists(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function boundedInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}


function readPriorityIds() {
  try {
    const parsed = readJsonIfExists(PRIORITY_PATH);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && /^[\w-]{11}$/u.test(id)) : [];
  } catch {
    return [];
  }
}

function writePriorityIds(ids) {
  if (!fs.existsSync(PRIORITY_PATH)) return;
  writeJson(PRIORITY_PATH, [...new Set(ids)]);
}

module.exports = { collectPublishedVideoIds };
