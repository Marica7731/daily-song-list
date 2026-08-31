#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  fetchMygitTodaySnapshotSource,
  fetchVideoSongList,
} = require("../update-songlist");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const VIDEO_LIMIT = positiveInt(process.env.STATIC_VIDEO_LIMIT, 24);
const PAGE_SIZE = positiveInt(process.env.STATIC_PAGE_SIZE, 50);
const MAX_SHARD_BYTES = positiveInt(process.env.STATIC_MAX_SHARD_BYTES, 4_000_000);
const NOW = new Date(process.env.STATIC_NOW || Date.now());
const HISTORY_GAP = Object.freeze({ from: "2026-08-23", through: "2026-08-31", status: "MISSING" });

if (require.main === module) {
  main().catch((error) => {
    console.error(`[static-update] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  assertOwnedRoot(DATA_ROOT);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const fixture = process.env.STATIC_SOURCE_FIXTURE ? readJson(path.resolve(process.env.STATIC_SOURCE_FIXTURE)) : null;
  const source = fixture ? fixtureSource(fixture) : await liveSource(NOW);
  if (!source.complete) throw new Error(`source coverage is not complete: ${source.reason || "unknown"}`);
  if (!source.snapshotId || !source.items.length) throw new Error("source snapshot is empty or has no identity");

  const statePath = path.join(DATA_ROOT, "state.json");
  const state = readJsonIfExists(statePath) || initialState(NOW);
  enqueueSnapshot(state, source, NOW);
  const batch = state.queue.slice(0, VIDEO_LIMIT);
  const completed = [];
  const failures = [];
  for (const candidate of batch) {
    try {
      const result = candidate.fixtureDetail
        ? { detail: candidate.fixtureDetail, audit: { result: candidate.fixtureDetail.songs?.length ? "selected" : "no_usable_song_source" } }
        : await fetchVideoSongList(candidate);
      completed.push({ candidate, result });
      console.log(`[static-update] video=${candidate.videoId} result=${result.audit?.result || "unknown"} songs=${result.detail?.songs?.length || 0}`);
    } catch (error) {
      failures.push({ videoId: candidate.videoId, message: error.message });
      console.warn(`[static-update] retry-later video=${candidate.videoId}: ${error.message}`);
    }
  }

  if (batch.length > 0 && completed.length === 0) {
    throw new Error(`all ${batch.length} bounded inspections failed; preserving last successful state`);
  }

  persistCompleted(state, completed, NOW);
  state.lastAttemptAt = NOW.toISOString();
  state.lastSourceSnapshotId = source.snapshotId;
  state.lastSourceCapturedAt = source.capturedAt;
  state.sourceCoverage = source.coverage;
  state.lastFailures = failures.slice(0, 20);
  state.queue = state.queue.filter((entry) => !completed.some(({ candidate }) => candidate.videoId === entry.videoId));
  state.updatedAt = NOW.toISOString();
  writeJson(statePath, state);
  const summary = buildStaticSite(DATA_ROOT, state, NOW, { pageSize: PAGE_SIZE, maxShardBytes: MAX_SHARD_BYTES });
  if (summary.songOccurrenceCount < 1) throw new Error("first static release has no song occurrences");
  console.log(
    `[static-update] snapshot=${source.snapshotId} processed=${completed.length}/${batch.length} pending=${state.queue.length} videos=${summary.videoCount} songs=${summary.songOccurrenceCount}`,
  );
}

async function liveSource(now) {
  const result = await fetchMygitTodaySnapshotSource(now, {
    enabled: true,
    lookbackDays: 1,
    maxSnapshots: 1,
    persistState: false,
  });
  const snapshotId = result.summary?.fetchedSnapshotIds?.[0] || result.items?.[0]?.snapshotId || "";
  return {
    complete: result.summary?.status === "success" && result.summary?.fetchedSnapshotCount === 1,
    reason: result.summary?.status || "missing",
    snapshotId,
    capturedAt: result.items?.[0]?.snapshotCapturedAt || result.summary?.collectedAt || now.toISOString(),
    coverage: {
      provider: "Marica7731/mygit today snapshot",
      status: result.summary?.status || "missing",
      fetchedSnapshots: result.summary?.fetchedSnapshotCount || 0,
      selectedSnapshots: result.summary?.snapshotCount || 0,
      candidateVideos: result.items.length,
    },
    items: result.items,
  };
}

function fixtureSource(fixture) {
  return {
    complete: fixture.complete === true,
    reason: fixture.complete ? "success" : "fixture-incomplete",
    snapshotId: String(fixture.snapshotId || ""),
    capturedAt: String(fixture.capturedAt || NOW.toISOString()),
    coverage: fixture.coverage || { provider: "fixture", status: fixture.complete ? "success" : "missing", candidateVideos: fixture.items?.length || 0 },
    items: Array.isArray(fixture.items) ? fixture.items : [],
  };
}

function initialState(now) {
  return {
    schemaVersion: 1,
    continuityStart: now.toISOString(),
    historyGaps: [HISTORY_GAP],
    processedVideoIds: [],
    sourceSnapshots: [],
    queue: [],
    updatedAt: now.toISOString(),
  };
}

function enqueueSnapshot(state, source, now) {
  const processed = new Set(state.processedVideoIds || []);
  const queued = new Set((state.queue || []).map((item) => item.videoId));
  for (const item of source.items) {
    if (!item?.videoId || processed.has(item.videoId) || queued.has(item.videoId)) continue;
    state.queue.push(compactCandidate(item, source));
    queued.add(item.videoId);
  }
  state.sourceSnapshots = [...(state.sourceSnapshots || []).filter((item) => item.id !== source.snapshotId), {
    id: source.snapshotId,
    capturedAt: source.capturedAt,
    importedAt: now.toISOString(),
    candidateVideos: source.items.length,
    coverage: source.coverage,
  }].slice(-60);
}

function compactCandidate(item, source) {
  return {
    videoId: item.videoId,
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    keyword: item.keyword || "",
    keywords: item.keywords || [],
    sourceGroup: item.sourceGroup || "mygit_today_snapshot",
    sourceGroups: item.sourceGroups || [item.sourceGroup].filter(Boolean),
    sourceUrl: item.sourceUrl || "",
    sourceUrls: item.sourceUrls || [],
    publishedText: item.publishedText || "",
    publishedTimestamp: item.publishedTimestamp || null,
    durationText: item.durationText || "",
    thumbnailUrl: item.thumbnailUrl || "",
    snapshotId: source.snapshotId,
    snapshotCapturedAt: source.capturedAt,
    ...(item.fixtureDetail ? { fixtureDetail: item.fixtureDetail } : {}),
  };
}

function persistCompleted(state, completed, now, dataRoot = DATA_ROOT) {
  const processed = new Set(state.processedVideoIds || []);
  for (const { candidate, result } of completed) {
    processed.add(candidate.videoId);
    const detail = result.detail;
    if (!detail?.songs?.length) continue;
    const day = isoDay(detail.publishedTimestamp || candidate.publishedTimestamp || candidate.snapshotCapturedAt || now);
    const dayPath = path.join(dataRoot, "days", `${day}.json`);
    const shard = readJsonIfExists(dayPath) || { schemaVersion: 1, day, videos: [] };
    const normalized = normalizeVideo(detail, candidate, now);
    shard.videos = [...shard.videos.filter((item) => item.videoId !== normalized.videoId), normalized]
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)) || a.videoId.localeCompare(b.videoId));
    shard.updatedAt = now.toISOString();
    writeJson(dayPath, shard);
  }
  state.processedVideoIds = [...processed].sort();
}

function normalizeVideo(detail, candidate, now) {
  const publishedAt = new Date(detail.publishedTimestamp || candidate.publishedTimestamp || candidate.snapshotCapturedAt || now).toISOString();
  return {
    videoId: detail.videoId,
    title: detail.title || candidate.title || "",
    channelName: detail.channelName || candidate.channelName || "",
    channelId: detail.channelId || candidate.channelId || "",
    channelHandle: detail.channelHandle || candidate.channelHandle || "",
    publishedAt,
    thumbnailUrl: detail.thumbnailUrl || candidate.thumbnailUrl || `https://i.ytimg.com/vi/${detail.videoId}/hqdefault.jpg`,
    watchUrl: `https://www.youtube.com/watch?v=${detail.videoId}`,
    keyword: detail.keyword || candidate.keyword || "",
    keywords: unique([...(detail.keywords || []), ...(candidate.keywords || [])]),
    sourceSnapshotId: candidate.snapshotId || "",
    sourceCapturedAt: candidate.snapshotCapturedAt || "",
    songs: detail.songs.map((song) => ({
      occurrenceId: song.occurrenceId || `${detail.videoId}:${song.seconds}:${song.index || 0}`,
      time: song.time || "",
      seconds: Number(song.seconds) || 0,
      title: String(song.title || "").trim(),
      artist: String(song.artist || "").trim(),
      raw: String(song.raw || ""),
      sourceId: song.sourceId || detail.selectedSourceId || "",
      sourceHash: song.sourceHash || detail.selectedSourceHash || "",
    })).filter((song) => song.title),
  };
}

function buildStaticSite(dataRoot, state, now, options = {}) {
  const videos = readDayVideos(dataRoot);
  const generatedRoots = ["rankings", "entities", "sources", "search"];
  for (const name of generatedRoots) resetGeneratedRoot(dataRoot, name);
  const ranges = [
    { id: "7d", days: 7 },
    { id: "30d", days: 30 },
    { id: "all", days: null },
  ];
  const rangeManifest = {};
  for (const range of ranges) {
    const selected = filterRange(videos, now, range.days);
    rangeManifest[range.id] = {};
    for (const type of ["songs", "artists", "vtubers"]) {
      const records = rankRecords(type, selected);
      rangeManifest[range.id][type] = writePagedRanking(dataRoot, range.id, type, records, options.pageSize || PAGE_SIZE, now, state);
    }
  }
  const entities = writeEntities(dataRoot, videos, now);
  writeSearch(dataRoot, entities, now, options.maxShardBytes || MAX_SHARD_BYTES);
  const meta = {
    schemaVersion: 1,
    architecture: "github-actions-static-shards-v1",
    generatedAt: now.toISOString(),
    continuityStart: state.continuityStart,
    historyGaps: state.historyGaps || [HISTORY_GAP],
    historyDays: state.historyDays || null,
    historyRecovery: state.recoveryDates || {},
    legacyBaseline: state.legacyBaseline || null,
    sourceSnapshotId: state.lastSourceSnapshotId || "",
    sourceCapturedAt: state.lastSourceCapturedAt || "",
    sourceCoverage: state.sourceCoverage || {},
    pendingVideoCount: state.queue?.length || 0,
    processedVideoCount: state.processedVideoIds?.length || 0,
    videoCount: videos.length,
    songOccurrenceCount: videos.reduce((sum, item) => sum + item.songs.length, 0),
    ranges: rangeManifest,
  };
  writeJson(path.join(dataRoot, "meta.json"), meta);
  return meta;
}

function rankRecords(type, videos) {
  const groups = new Map();
  for (const video of videos) {
    if (type === "vtubers") {
      const name = video.channelName || video.channelHandle || video.videoId;
      addGroup(groups, `${name}\u001f${video.channelId || video.channelHandle}`, name, "", video, null, video.keywords);
      continue;
    }
    for (const song of video.songs) {
      if (type === "songs") addGroup(groups, `${song.title}\u001f${song.artist}`, song.title, song.artist, video, song, video.keywords);
      if (type === "artists") {
        const artist = song.artist || "未知歌手";
        addGroup(groups, artist, artist, "", video, song, video.keywords);
      }
    }
  }
  return [...groups.values()]
    .map((group) => ({
      id: hashId(`${type}\u001f${group.key}`),
      name: group.name,
      secondary: group.secondary,
      occurrenceCount: group.occurrences.length,
      videoCount: group.videoIds.size,
      keywords: [...group.keywords].sort(),
      detailPath: `entities/${type}/${hashId(`${type}\u001f${group.key}`)}.json`,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || b.videoCount - a.videoCount || a.name.localeCompare(b.name, "ja"))
    .map((record, index) => ({ rank: index + 1, ...record }));
}

function addGroup(groups, key, name, secondary, video, song, keywords = []) {
  const normalizedKey = normalizeKey(key);
  const group = groups.get(normalizedKey) || { key: normalizedKey, name, secondary, occurrences: [], videoIds: new Set(), keywords: new Set() };
  group.occurrences.push({ videoId: video.videoId, seconds: song?.seconds ?? null });
  group.videoIds.add(video.videoId);
  for (const keyword of keywords || []) if (keyword) group.keywords.add(keyword);
  groups.set(normalizedKey, group);
}

function writePagedRanking(dataRoot, range, type, records, pageSize, now, state) {
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  for (let index = 0; index < pages; index += 1) {
    const file = path.join(dataRoot, "rankings", range, type, `page-${String(index + 1).padStart(4, "0")}.json`);
    writeJson(file, {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      range,
      type,
      page: index + 1,
      pageSize,
      pageCount: pages,
      totalCount: records.length,
      continuityStart: state.continuityStart,
      items: records.slice(index * pageSize, (index + 1) * pageSize),
    });
  }
  const manifest = { totalCount: records.length, pageCount: pages, pageSize, path: `rankings/${range}/${type}/page-{page}.json` };
  writeJson(path.join(dataRoot, "rankings", range, type, "manifest.json"), manifest);
  return manifest;
}

function writeEntities(dataRoot, videos, now) {
  const maps = { songs: new Map(), artists: new Map(), vtubers: new Map() };
  for (const video of videos) {
    writeJson(path.join(dataRoot, "sources", video.videoId.slice(0, 2), `${video.videoId}.json`), { schemaVersion: 1, generatedAt: now.toISOString(), ...video });
    const vtuberKey = normalizeKey(`${video.channelName}\u001f${video.channelId || video.channelHandle}`);
    pushEntity(maps.vtubers, vtuberKey, video.channelName || video.channelHandle || video.videoId, "", video, null);
    for (const song of video.songs) {
      pushEntity(maps.songs, normalizeKey(`${song.title}\u001f${song.artist}`), song.title, song.artist, video, song);
      pushEntity(maps.artists, normalizeKey(song.artist || "未知歌手"), song.artist || "未知歌手", "", video, song);
    }
  }
  const search = [];
  for (const [type, map] of Object.entries(maps)) {
    for (const entity of map.values()) {
      const id = hashId(`${type}\u001f${entity.key}`);
      const detailPath = `entities/${type}/${id}.json`;
      const payload = { schemaVersion: 1, generatedAt: now.toISOString(), id, type, name: entity.name, secondary: entity.secondary, occurrenceCount: entity.occurrences.length, videoCount: new Set(entity.occurrences.map((item) => item.videoId)).size, occurrences: entity.occurrences };
      writeJson(path.join(dataRoot, detailPath), payload);
      search.push({ id, type, name: entity.name, secondary: entity.secondary, detailPath, text: normalizeKey(`${entity.name} ${entity.secondary}`) });
    }
  }
  return search;
}

function pushEntity(map, key, name, secondary, video, song) {
  const entity = map.get(key) || { key, name, secondary, occurrences: [] };
  entity.occurrences.push({
    videoId: video.videoId,
    videoTitle: video.title,
    channelName: video.channelName,
    publishedAt: video.publishedAt,
    thumbnailUrl: video.thumbnailUrl,
    sourcePath: `sources/${video.videoId.slice(0, 2)}/${video.videoId}.json`,
    time: song?.time || "",
    seconds: song?.seconds ?? null,
    songTitle: song?.title || "",
    artist: song?.artist || "",
  });
  map.set(key, entity);
}

function writeSearch(dataRoot, entities, now, maxShardBytes) {
  const buckets = new Map();
  for (const entity of entities) {
    const bucket = entity.id.slice(0, 1);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(entity);
  }
  const shards = [];
  for (const [bucket, items] of [...buckets.entries()].sort()) {
    const relative = `search/${bucket}.json`;
    const file = path.join(dataRoot, relative);
    writeJson(file, { schemaVersion: 1, generatedAt: now.toISOString(), items });
    const bytes = fs.statSync(file).size;
    if (bytes > maxShardBytes) throw new Error(`search shard exceeds limit: ${relative} bytes=${bytes}`);
    shards.push({ bucket, path: relative, itemCount: items.length, bytes });
  }
  writeJson(path.join(dataRoot, "search", "manifest.json"), { schemaVersion: 1, generatedAt: now.toISOString(), shards });
}

function readDayVideos(dataRoot) {
  const daysRoot = path.join(dataRoot, "days");
  if (!fs.existsSync(daysRoot)) return [];
  const files = [];
  for (const name of fs.readdirSync(daysRoot).sort()) {
    const target = path.join(daysRoot, name);
    if (/^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && fs.statSync(target).isFile()) files.push(target);
    if (/^\d{4}-\d{2}-\d{2}$/u.test(name) && fs.statSync(target).isDirectory()) {
      for (const part of fs.readdirSync(target).filter((item) => /^part-\d{4}\.json$/u.test(item)).sort()) files.push(path.join(target, part));
    }
  }
  const byVideoId = new Map();
  for (const file of files) {
    for (const video of readJson(file).videos || []) byVideoId.set(video.videoId, video);
  }
  return [...byVideoId.values()];
}

function filterRange(videos, now, days) {
  const start = days ? now.getTime() - days * 86400000 : Number.NEGATIVE_INFINITY;
  return videos.filter((video) => Date.parse(video.publishedAt) >= start && Date.parse(video.publishedAt) <= now.getTime() + 6 * 3600000);
}

function resetGeneratedRoot(dataRoot, name) {
  const target = path.resolve(dataRoot, name);
  if (path.dirname(target) !== dataRoot) throw new Error(`unsafe generated root: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
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

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readJsonIfExists(file) { try { return readJson(file); } catch { return null; } }
function hashId(value) { return crypto.createHash("sha256").update(normalizeKey(value)).digest("hex").slice(0, 16); }
function normalizeKey(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu, "").trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function isoDay(value) { return new Date(value).toISOString().slice(0, 10); }

module.exports = {
  HISTORY_GAP,
  buildStaticSite,
  compactCandidate,
  enqueueSnapshot,
  fixtureSource,
  hashId,
  initialState,
  normalizeKey,
  persistCompleted,
  readDayVideos,
};
