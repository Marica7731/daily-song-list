#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  fetchMygitTodaySnapshotSource,
  fetchVideoSongList,
} = require("../update-songlist");
const { isLikelyNonSongEntry } = require("../song-utils");
const {
  applyCurationToSources,
  hashNormalizedText,
  loadCurationContext,
} = require("../curation");
const { cleanStaticVideos } = require("./quality-guard");
const { buildQualityReview } = require("./quality-review");
const { canonicalizeStaticSong, shouldPublishStaticSong } = require("./yorushika-catalog");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const VIDEO_LIMIT = positiveInt(process.env.STATIC_VIDEO_LIMIT, 24);
const PAGE_SIZE = positiveInt(process.env.STATIC_PAGE_SIZE, 50);
const PAGE_NUMBER_WIDTH = 4;
const MAX_SHARD_BYTES = positiveInt(process.env.STATIC_MAX_SHARD_BYTES, 4_000_000);
const COLLECTED_CHANNELS_PATH = path.resolve(process.env.STATIC_COLLECTED_CHANNELS || path.join(ROOT, "config/collected-vtubers.json"));
const RECENT_PRIORITY_DAYS = positiveInt(process.env.STATIC_RECENT_PRIORITY_DAYS, 8);
const NOW = new Date(process.env.STATIC_NOW || Date.now());
const HISTORY_GAP = Object.freeze({ from: "2026-08-23", through: "2026-08-31", status: "MISSING" });
// A zero-song inspection is not proof that a video carries no songs: watch-page scrapes fail
// transiently (429s, missing comment continuations, partial renders). Marking such a video as
// processed permanently amputates it, because enqueueSnapshot skips anything already listed in
// processedVideoIds. Retry a bounded number of times before giving up, and record every attempt
// in state.noSongAttempts so the outcome stays auditable instead of vanishing.
const MAX_NO_SONG_ATTEMPTS = positiveInt(process.env.STATIC_MAX_NO_SONG_ATTEMPTS, 3);
// Repair runs drain the historical backlog before fresh candidates; the hourly cadence
// deliberately reserves only a small slice of each batch for older entries.
const REPAIR_MODE = /^(?:1|true|yes|on)$/iu.test(String(process.env.STATIC_REPAIR_MODE || ""));
// Repair candidates are re-queued by videoId alone, so they carry no trustworthy publish
// timestamp. Tag them so batch selection files them under backlog instead of "recent".
const REPAIR_SOURCE_GROUP = "static_repair";

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
  const channelSetlistImports = reconcileChannelSetlistImports(state, DATA_ROOT);
  const batch = selectInspectionBatch(state.queue, VIDEO_LIMIT, NOW);
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
    console.warn(
      `[static-update] batch_degraded attempted=${batch.length} failed=${failures.length}; continuing with last successful state`,
    );
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
  const summary = buildStaticSite(DATA_ROOT, state, NOW, {
    pageSize: PAGE_SIZE,
    maxShardBytes: MAX_SHARD_BYTES,
    channelSetlistImports,
  });
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

function candidateTimestampMs(candidate) {
  const raw = candidate?.publishedTimestamp ?? candidate?.snapshotCapturedAt ?? "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1_000_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function candidatePublishedTimestampMs(candidate) {
  return candidateTimestampMs({ publishedTimestamp: candidate?.publishedTimestamp });
}

function inspectionPriorityFallbackIds() {
  const priorityPath = path.join(DATA_ROOT, "imports", "inspection-priority-ids.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(priorityPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requestedInspectionPriorityIds(value = process.env.STATIC_PRIORITY_VIDEO_IDS || "") {
  const requested = value || inspectionPriorityFallbackIds().join(",");
  return [...new Set(
    String(requested)
      .split(",")
      .map((videoId) => videoId.trim())
      .filter((videoId) => /^[A-Za-z0-9_-]{11}$/u.test(videoId)),
  )];
}

function selectInspectionBatch(queue, limit, now = NOW, priorityVideoIds = requestedInspectionPriorityIds()) {
  const boundedLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
  if (!boundedLimit || !Array.isArray(queue) || queue.length === 0) return [];

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const cutoff = nowMs - RECENT_PRIORITY_DAYS * 86400000;
  const recent = [];
  const backlog = [];
  const explicitPriority = [];
  const prioritySet = new Set(priorityVideoIds);

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    const entry = { candidate, index, timestamp: candidateTimestampMs(candidate) };
    if (prioritySet.has(candidate?.videoId)) explicitPriority.push(entry);
    else if (candidate?.sourceGroup !== REPAIR_SOURCE_GROUP && entry.timestamp >= cutoff) recent.push(entry);
    else backlog.push(entry);
  }

  explicitPriority.sort((a, b) => a.index - b.index);
  recent.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
  const backlogReserve = boundedLimit >= 6 ? Math.max(1, Math.floor(boundedLimit / 6)) : 0;
  const chosen = explicitPriority.slice(0, boundedLimit);
  const remainingLimit = Math.max(0, boundedLimit - chosen.length);
  const recentTarget = REPAIR_MODE ? 0 : Math.max(0, remainingLimit - backlogReserve);
  chosen.push(...recent.slice(0, recentTarget));

  chosen.push(...backlog.slice(0, Math.max(0, boundedLimit - chosen.length)));
  if (!REPAIR_MODE && chosen.length < boundedLimit) {
    chosen.push(...recent.slice(recentTarget, recentTarget + (boundedLimit - chosen.length)));
  }

  return chosen.slice(0, boundedLimit).map((entry) => entry.candidate);
}

function persistCompleted(state, completed, now, dataRoot = DATA_ROOT) {
  const processed = new Set(state.processedVideoIds || []);
  const noSongAttempts = { ...(state.noSongAttempts || {}) };
  const daysRoot = path.join(dataRoot, "days");
  let videoDayIndex = null;
  // A repair candidate can be re-published onto the real publish date after watch metadata is
  // backfilled, while an earlier pass stored it under the capture date. Without removing the
  // old copy the same song occurrence would be counted in two day shards.
  const readVideoDayIndex = () => {
    if (videoDayIndex) return videoDayIndex;
    videoDayIndex = new Map();
    if (!fs.existsSync(daysRoot)) return videoDayIndex;
    for (const name of fs.readdirSync(daysRoot).sort()) {
      const target = path.join(daysRoot, name);
      const singleDay = /^\d{4}-\d{2}-\d{2}\.json$/u.test(name) ? name.slice(0, -5) : null;
      const partDay = /^\d{4}-\d{2}-\d{2}$/u.test(name) && fs.statSync(target).isDirectory() ? name : null;
      const files = singleDay
        ? [{ day: singleDay, file: target }]
        : partDay
          ? fs.readdirSync(target)
              .filter((part) => /^part-\d{4}\.json$/u.test(part))
              .sort()
              .map((part) => ({ day: partDay, file: path.join(target, part) }))
          : [];
      for (const entry of files) {
        try {
          for (const video of readJson(entry.file).videos || []) {
            if (!video?.videoId) continue;
            const days = videoDayIndex.get(video.videoId) || [];
            days.push(entry);
            videoDayIndex.set(video.videoId, days);
          }
        } catch {
          // A malformed shard is reported by the repair audit; it must not stop this build.
        }
      }
    }
    return videoDayIndex;
  };
  for (const { candidate, result } of completed) {
    const detail = result.detail;
    if (!detail?.songs?.length) {
      const record = noSongAttempts[candidate.videoId] || { attempts: 0, firstSeenAt: new Date(now).toISOString() };
      record.attempts += 1;
      record.lastAttemptAt = new Date(now).toISOString();
      record.lastResult = result.audit?.result || "unknown";
      noSongAttempts[candidate.videoId] = record;
      if (record.attempts < MAX_NO_SONG_ATTEMPTS) continue;
      processed.add(candidate.videoId);
      continue;
    }
    processed.add(candidate.videoId);
    delete noSongAttempts[candidate.videoId];
    const day = isoDay(detail.publishedTimestamp || candidate.publishedTimestamp || candidate.snapshotCapturedAt || now);
    const dayPath = path.join(dataRoot, "days", `${day}.json`);
    const shard = readJsonIfExists(dayPath) || { schemaVersion: 1, day, videos: [] };
    const normalized = normalizeVideo(detail, candidate, now);
    if (String(candidate.snapshotId || "").startsWith("repair-")) {
      for (const stale of readVideoDayIndex().get(normalized.videoId) || []) {
        if (stale.day === day) continue;
        try {
          const staleShard = readJson(stale.file);
          if (!(staleShard.videos || []).some((item) => item.videoId === normalized.videoId)) continue;
          staleShard.videos = (staleShard.videos || []).filter((item) => item.videoId !== normalized.videoId);
          staleShard.updatedAt = now.toISOString();
          writeJson(stale.file, staleShard);
        } catch {
          // Same rule as above: never let one bad shard block republishing the good copy.
        }
      }
    }
    const existing = shard.videos.find((item) => item.videoId === normalized.videoId);
    if (existing && rawDayContentEquals(existing, normalized)) {
      // A repeated repair inspection may refresh only its source receipt. Preserve the
      // immutable day record byte-for-byte when the published video content is unchanged.
      continue;
    }
    shard.videos = [...shard.videos.filter((item) => item.videoId !== normalized.videoId), normalized]
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)) || a.videoId.localeCompare(b.videoId));
    shard.updatedAt = now.toISOString();
    writeJson(dayPath, shard);
  }
  state.processedVideoIds = [...processed].sort();
  state.noSongAttempts = noSongAttempts;
}

function rawDayContentEquals(left, right) {
  const stripSource = (video) => Object.fromEntries(
    Object.entries(video).filter(([key]) => key !== "sourceSnapshotId" && key !== "sourceCapturedAt"),
  );
  return JSON.stringify(stripSource(left)) === JSON.stringify(stripSource(right));
}

function normalizeVideo(detail, candidate, now) {
  const publishedAt = new Date(detail.publishedTimestamp || candidate.publishedTimestamp || candidate.snapshotCapturedAt || now).toISOString();
  return {
    videoId: detail.videoId,
    title: detail.title || candidate.title || "",
    channelName: detail.channelName || candidate.channelName || "",
    channelId: detail.channelId || candidate.channelId || "",
    channelHandle: detail.channelHandle || candidate.channelHandle || "",
    channelUrl: youtubeChannelHomeUrl(detail.channelUrl || detail.authorUrl || detail.ownerUrl || candidate.channelUrl || candidate.sourceUrl),
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
  const channelSetlistImports = options.channelSetlistImports || readChannelSetlistImports(dataRoot);
  const inputVideos = readDayVideos(dataRoot, channelSetlistImports);
  const { videos: cleanedVideos, audit } = cleanStaticVideos(inputVideos);
  const collectedChannels = loadCollectedChannels();
  const videos = cleanedVideos.map((video) => hydrateCollectedChannel(video, collectedChannels));
  const review = buildQualityReview(videos, audit, now);
  const generatedRoots = ["rankings", "entities", "sources", "search"];
  for (const name of generatedRoots) resetGeneratedRoot(dataRoot, name);
  const ranges = [
    { id: "today", calendarDays: 1 },
    { id: "3d", calendarDays: 3 },
    { id: "7d", days: 7 },
    { id: "30d", days: 30 },
    { id: "all", days: null },
  ];
  const rangeManifest = {};
  for (const range of ranges) {
    const selected = filterRange(videos, now, range.days, range.calendarDays);
    const selectedInput = filterRange(inputVideos, now, range.days, range.calendarDays);
    const pending = filterCandidateRange(state.queue || [], now, range.days, range.calendarDays);
    rangeManifest[range.id] = {
      stats: {
        videoCount: selected.length,
        songOccurrenceCount: selected.reduce((sum, item) => sum + item.songs.length, 0),
        pendingVideoCount: pending.length,
        quarantinedOccurrences: selectedInput.reduce(
          (sum, item) => sum + Number(audit.byVideo?.[item.videoId]?.quarantinedOccurrences || 0),
          0,
        ),
        deduplicatedOccurrences: selectedInput.reduce(
          (sum, item) => sum + Number(audit.byVideo?.[item.videoId]?.deduplicatedOccurrences || 0),
          0,
        ),
      },
    };
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
    quality: {
      quarantinedOccurrences: audit.quarantinedOccurrences,
      quarantinedVideos: audit.quarantinedVideos,
      normalizedArtistOccurrences: audit.normalizedArtistOccurrences,
      normalizedReleaseMetadataOccurrences: audit.normalizedReleaseMetadataOccurrences,
      repairedDateCreditOccurrences: audit.repairedDateCreditOccurrences,
      repairedStructuredCreditOccurrences: audit.repairedStructuredCreditOccurrences,
      repairedKnownSourceCreditOccurrences: audit.repairedKnownSourceCreditOccurrences,
      deduplicatedOccurrences: audit.deduplicatedOccurrences,
      repeatedDescriptionSources: audit.repeatedDescriptionSources.length,
      byReason: audit.byReason,
      reviewedDayCount: review.scannedDays.length,
      reviewOnlyCandidateCount: review.candidates.length,
      mixedStructuredSourceCount: review.mixedStructuredSetlistSources.length,
    },
    ranges: rangeManifest,
    channelSetlistImports: channelSetlistImports.map((entry) => ({ path: entry.path, ...entry.summary })),
  };
  writeJson(path.join(dataRoot, "quality-audit.json"), { generatedAt: now.toISOString(), ...audit });
  writeJson(path.join(dataRoot, "quality-review.json"), review);
  writeJson(path.join(dataRoot, "meta.json"), meta);
  return meta;
}

function loadCollectedChannels() {
  const payload = readJsonIfExists(COLLECTED_CHANNELS_PATH);
  if (!payload || !Array.isArray(payload.channels)) return [];
  return payload.channels.filter((channel) => channel && channel.collected !== false);
}

function normalizeChannelHandle(value) {
  const text = String(value || "").trim().replace(/^\/+/, "");
  return text ? (text.startsWith("@") ? text : `@${text}`) : "";
}

function hydrateCollectedChannel(video, channels) {
  const handle = normalizeChannelHandle(video.channelHandle);
  const name = normalizeKey(video.channelName);
  const match = channels.find((channel) => {
    if (video.channelId && channel.channelId && String(video.channelId) === String(channel.channelId)) return true;
    const channelHandle = normalizeChannelHandle(channel.channelHandle);
    return Boolean(handle && channelHandle && handle === channelHandle)
      || Boolean(name && [channel.channelName, ...(channel.aliases || [])].some((alias) => normalizeKey(alias) === name));
  });
  if (!match) return { ...video, collected: false };
  return {
    ...video,
    channelId: String(match.channelId || video.channelId || ""),
    channelHandle: normalizeChannelHandle(match.channelHandle || video.channelHandle),
    channelUrl: String(match.channelUrl || video.channelUrl || ""),
    collected: true,
    collectionId: String(match.collectionId || ""),
  };
}

function rankRecords(type, videos) {
  const groups = new Map();
  for (const video of videos) {
    if (type === "vtubers") {
      const name = video.channelName || video.channelHandle || video.videoId;
      for (const song of video.songs || []) {
        addGroup(groups, `${name}\u001f${video.channelId || video.channelHandle}`, name, "", video, song, video.keywords);
      }
      continue;
    }
    for (const song of video.songs) {
      const canonicalSong = canonicalizeStaticSong(song);
      if (!shouldPublishStaticSong(canonicalSong)) continue;
      if (type === "songs") addGroup(groups, `${canonicalSong.title}\u001f${canonicalSong.artist}`, canonicalSong.title, canonicalSong.artist, video, canonicalSong, video.keywords);
      if (type === "artists") {
        const artist = canonicalSong.artist || "未知歌手";
        addGroup(groups, artist, artist, "", video, canonicalSong, video.keywords);
      }
    }
  }
  return [...groups.values()]
    .map((group) => ({
      id: hashId(`${type}\u001f${group.key}`),
      name: group.name,
      secondary: group.secondary,
      channelId: group.channelId || "",
      channelHandle: group.channelHandle || "",
      channelUrl: group.channelUrl || "",
      occurrenceCount: group.occurrences.length,
      videoCount: group.videoIds.size,
      songCount: group.songKeys.size,
      keywords: [...group.keywords].sort(),
      collected: type === "vtubers" && group.collected === true,
      collectionId: type === "vtubers" ? group.collectionId || "" : "",
      sourcesPreview: sourcePreviews(group.occurrences),
      detailPath: `entities/${type}/${hashId(`${type}\u001f${group.key}`)}.json`,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || b.videoCount - a.videoCount || a.name.localeCompare(b.name, "ja"))
    .map((record, index) => ({ rank: index + 1, ...record }));
}

function addGroup(groups, key, name, secondary, video, song, keywords = []) {
  const normalizedKey = normalizeKey(key);
  const group = groups.get(normalizedKey) || {
    key: normalizedKey,
    name,
    secondary,
    channelId: video.channelId || "",
    channelHandle: video.channelHandle || "",
    channelUrl: video.channelUrl || "",
    collected: video.collected === true,
    collectionId: video.collectionId || "",
    occurrences: [],
    videoIds: new Set(),
    songKeys: new Set(),
    keywords: new Set(),
  };
  group.occurrences.push({
    videoId: video.videoId,
    videoTitle: video.title || "",
    channelName: video.channelName || "",
    channelId: video.channelId || "",
    channelHandle: video.channelHandle || "",
    channelUrl: video.channelUrl || "",
    publishedAt: video.publishedAt || "",
    thumbnailUrl: video.thumbnailUrl || "",
    sourcePath: `sources/${video.videoId.slice(0, 2)}/${video.videoId}.json`,
    time: song?.time || "",
    seconds: song?.seconds ?? null,
    songTitle: song?.title || "",
    artist: song?.artist || "",
  });
  group.videoIds.add(video.videoId);
  if (video.collected === true) {
    group.collected = true;
    group.collectionId = video.collectionId || group.collectionId || "";
  }
  if (song?.title) group.songKeys.add(normalizeKey(`${song.title}\u001f${song.artist || ""}`));
  for (const keyword of keywords || []) if (keyword) group.keywords.add(keyword);
  groups.set(normalizedKey, group);
}

function sourcePreviews(occurrences) {
  const output = [];
  const seen = new Set();
  const sorted = [...(occurrences || [])].sort(
    (a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")) ||
      Number(a.seconds || 0) - Number(b.seconds || 0),
  );
  for (const item of sorted) {
    if (!item.videoId || seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    output.push({
      videoId: item.videoId,
      videoTitle: item.videoTitle || "",
      channelName: item.channelName || "",
      publishedAt: item.publishedAt || "",
      thumbnailUrl: item.thumbnailUrl || "",
      sourcePath: item.sourcePath || "",
      time: item.time || "",
      seconds: item.seconds ?? null,
      songTitle: item.songTitle || "",
      artist: item.artist || "",
    });
    if (output.length >= 3) break;
  }
  return output;
}

function writePagedRanking(dataRoot, range, type, records, pageSize, now, state) {
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  for (let index = 0; index < pages; index += 1) {
    const file = path.join(dataRoot, "rankings", range, type, `page-${String(index + 1).padStart(PAGE_NUMBER_WIDTH, "0")}.json`);
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
  const manifest = {
    totalCount: records.length,
    pageCount: pages,
    pageSize,
    pageNumberWidth: PAGE_NUMBER_WIDTH,
    path: `rankings/${range}/${type}/page-{page:04d}.json`,
  };
  writeJson(path.join(dataRoot, "rankings", range, type, "manifest.json"), manifest);
  return manifest;
}

function writeEntities(dataRoot, videos, now) {
  const maps = { songs: new Map(), artists: new Map(), vtubers: new Map() };
  const rangeStarts = {
    today: shanghaiCalendarStart(now, 1),
    "3d": shanghaiCalendarStart(now, 3),
    "7d": now.getTime() - 7 * 86400000,
    "30d": now.getTime() - 30 * 86400000,
  };
  for (const video of videos) {
    writeJson(path.join(dataRoot, "sources", video.videoId.slice(0, 2), `${video.videoId}.json`), { schemaVersion: 1, generatedAt: now.toISOString(), ...video });
    const vtuberKey = normalizeKey(`${video.channelName}\u001f${video.channelId || video.channelHandle}`);
    for (const song of video.songs) {
      pushEntity(maps.vtubers, vtuberKey, video.channelName || video.channelHandle || video.videoId, "", video, song, "vtubers");
    }
    for (const song of video.songs) {
      const canonicalSong = canonicalizeStaticSong(song);
      if (!shouldPublishStaticSong(canonicalSong)) continue;
      pushEntity(maps.songs, normalizeKey(`${canonicalSong.title}\u001f${canonicalSong.artist}`), canonicalSong.title, canonicalSong.artist, video, canonicalSong, "songs");
      pushEntity(maps.artists, normalizeKey(canonicalSong.artist || "未知歌手"), canonicalSong.artist || "未知歌手", "", video, canonicalSong, "artists");
    }
  }
  const search = [];
  for (const [type, map] of Object.entries(maps)) {
    for (const entity of map.values()) {
      const id = hashId(`${type}\u001f${entity.key}`);
      const detailPath = `entities/${type}/${id}.json`;
      const occurrenceCount = entity.occurrences.length;
      const videoCount = new Set(entity.occurrences.map((item) => item.videoId)).size;
      const rangeMetrics = {};
      for (const [rangeId, start] of Object.entries(rangeStarts)) {
        const end = now.getTime() + (rangeId === "today" || rangeId === "3d" ? 300000 : 21600000);
        const occurrences = entity.occurrences.filter((item) => {
          const date = Date.parse(item.publishedAt);
          return Number.isFinite(date) && date >= start && date <= end;
        });
        if (occurrences.length) {
          rangeMetrics[rangeId] = {
            occurrenceCount: occurrences.length,
            videoCount: new Set(occurrences.map((item) => item.videoId)).size,
          };
        }
      }
      const payload = {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        id,
        type,
        name: entity.name,
        secondary: entity.secondary,
        channelId: entity.channelId || "",
        channelHandle: entity.channelHandle || "",
        channelUrl: entity.channelUrl || "",
        occurrenceCount,
        videoCount,
        keywords: [...entity.keywords].sort(),
        collected: type === "vtubers" && entity.collected === true,
        collectionId: type === "vtubers" ? entity.collectionId || "" : "",
        sourcesPreview: sourcePreviews(entity.occurrences),
        occurrences: entity.occurrences,
      };
      writeJson(path.join(dataRoot, detailPath), payload);
      search.push({
        id,
        channelId: entity.channelId || "",
        channelHandle: entity.channelHandle || "",
        channelUrl: entity.channelUrl || "",
        type,
        name: entity.name,
        secondary: entity.secondary,
        occurrenceCount,
        videoCount,
        keywords: [...entity.keywords].sort(),
        collected: type === "vtubers" && entity.collected === true,
        collectionId: type === "vtubers" ? entity.collectionId || "" : "",
        detailPath,
        rangeMetrics,
        text: normalizeKey(`${entity.name} ${entity.secondary}`),
      });
    }
  }
  return search;
}

function pushEntity(map, key, name, secondary, video, song, type) {
  const entity = map.get(key) || { key, name, secondary, occurrences: [], keywords: new Set() };
  if (type === "vtubers") {
    if (!entity.channelId && video.channelId) entity.channelId = video.channelId;
    if (!entity.channelHandle && video.channelHandle) entity.channelHandle = video.channelHandle;
    if (!entity.channelUrl && video.channelUrl) entity.channelUrl = video.channelUrl;
  }
  entity.occurrences.push({
    videoId: video.videoId,
    videoTitle: video.title,
    channelName: video.channelName,
    channelId: video.channelId || "",
    channelHandle: video.channelHandle || "",
    channelUrl: video.channelUrl || "",
    publishedAt: video.publishedAt,
    thumbnailUrl: video.thumbnailUrl,
    sourcePath: `sources/${video.videoId.slice(0, 2)}/${video.videoId}.json`,
    time: song?.time || "",
    seconds: song?.seconds ?? null,
    songTitle: song?.title || "",
    artist: song?.artist || "",
  });
  for (const keyword of video.keywords || []) if (keyword) entity.keywords.add(keyword);
  if (type === "vtubers" && video.collected === true) {
    entity.collected = true;
    entity.collectionId = video.collectionId || entity.collectionId || "";
  }
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

function readChannelSetlistImports(dataRoot = DATA_ROOT) {
  const importsRoot = path.join(dataRoot, "imports");
  if (!fs.existsSync(importsRoot)) return [];
  if (!fs.statSync(importsRoot).isDirectory()) throw new Error("channel setlist imports root is not a directory");
  const files = fs.readdirSync(importsRoot)
    .filter((name) => name.endsWith(".json") && name !== "inspection-priority-ids.json")
    .sort();
  return files.map((name) => {
    const payload = readJson(path.join(importsRoot, name));
    if (payload.schemaVersion !== 1 || payload.kind !== "channel-setlists") {
      throw new Error(`unsupported channel setlist import: ${name}`);
    }
    if (!payload.summary || !Array.isArray(payload.videos) || !Array.isArray(payload.audits)) {
      throw new Error(`incomplete channel setlist import: ${name}`);
    }
    const summary = payload.summary;
    const candidateCount = Number(summary.candidateCount);
    const inspectedCount = Number(summary.inspectedCount);
    const setlistVideoCount = Number(summary.setlistVideoCount);
    const auditCount = Number(summary.auditCount);
    const occurrenceCount = Number(summary.occurrenceCount);
    const noSongCount = Number(summary.noSongCount);
    const failedCount = Number(summary.failedCount);
    const auditedVideoIds = payload.audits.map((audit) => String(audit?.videoId || ""));
    const videoIds = payload.videos.map((video) => String(video?.videoId || ""));
    const actualOccurrenceCount = payload.videos.reduce(
      (total, video) => total + (Array.isArray(video?.songs) ? video.songs.length : 0),
      0,
    );
    const actualNoSongCount = payload.audits.filter(
      (audit) => Number(audit?.selectedSongCount || 0) === 0 && audit?.result !== "fetch_error",
    ).length;
    const auditedIdSet = new Set(auditedVideoIds);
    if (!Number.isInteger(candidateCount) || candidateCount <= 0 ||
        inspectedCount !== candidateCount || auditCount !== candidateCount ||
        payload.audits.length !== candidateCount || new Set(auditedVideoIds).size !== candidateCount ||
        auditedVideoIds.some((id) => !/^[A-Za-z0-9_-]{11}$/u.test(id))) {
      throw new Error(`channel setlist audit coverage mismatch: ${name}`);
    }
    if (summary.allCandidatesAccounted !== true || failedCount !== 0 ||
        payload.audits.some((audit) => audit?.result === "fetch_error")) {
      throw new Error(`channel setlist import contains failed candidates: ${name}`);
    }
    if (setlistVideoCount !== payload.videos.length || occurrenceCount !== actualOccurrenceCount ||
        noSongCount !== actualNoSongCount ||
        payload.videos.some((video) => !Array.isArray(video?.songs) || !video.songs.length)) {
      throw new Error(`channel setlist summary mismatch: ${name}`);
    }
    if (videoIds.some((id) => !auditedIdSet.has(id)) || new Set(videoIds).size !== videoIds.length) {
      throw new Error(`channel setlist videos do not match audits: ${name}`);
    }
    const videos = payload.videos.map((video) => ({
      ...video,
      watchUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      keyword: "",
      keywords: unique([...(video.keywords || []), ...(video.matchedKeywords || [])]),
      sourceSnapshotId: payload.source?.runId ? `channel-setlist:${payload.source.runId}` : "",
      sourceCapturedAt: payload.generatedAt || "",
      songs: video.songs.map((song, index) => ({
        ...song,
        index: Number(song.index) || index + 1,
        occurrenceId: `${video.videoId}:${Number(song.seconds) || 0}:${Number(song.index) || index + 1}`,
      })),
    }));
    return { path: `imports/${name}`, summary, auditedVideoIds, videos };
  });
}

function reconcileChannelSetlistImports(state, dataRoot = DATA_ROOT) {
  const imports = readChannelSetlistImports(dataRoot);
  const audited = new Set(imports.flatMap((entry) => entry.auditedVideoIds));
  if (audited.size) {
    state.processedVideoIds = [...new Set([...(state.processedVideoIds || []), ...audited])].sort();
    state.queue = (state.queue || []).filter((candidate) => !audited.has(String(candidate?.videoId || "")));
    state.noSongAttempts = { ...(state.noSongAttempts || {}) };
    for (const videoId of audited) delete state.noSongAttempts[videoId];
  }
  state.channelSetlistImports = imports.map((entry) => ({ path: entry.path, ...entry.summary }));
  return imports;
}

function curatePublishedVideo(video, curationContext) {
  const sourceContext = { channelName: video.channelName || "", title: video.title || "" };
  const songs = (video.songs || []).filter((song) => !isLikelyNonSongEntry(song, sourceContext));
  const sourceId = video.selectedSourceId || video.sourceId || `legacy:${video.videoId}`;
  const sourceHash = video.selectedSourceHash || video.sourceHash ||
    hashNormalizedText(JSON.stringify((video.songs || []).map((song) => [song.seconds, song.title, song.artist, song.raw || ""])));
  const curatedSongs = songs.map((song, index) => ({
    ...song,
    __staticOriginalIndex: index,
    sourceId: song.sourceId || sourceId,
    sourceHash: song.sourceHash || sourceHash,
    rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`),
  }));
  // Apply only reviewed manual source rules; heuristic classification and near-duplicate
  // cleanup remain owned by the publication quality layer.
  const curated = applyCurationToSources([{ sourceId, sourceHash, songs: curatedSongs }], curationContext, { videoId: video.videoId });
  const publishedSongs = (curated[0]?.songs || []).map((song) => {
    const original = songs[song.__staticOriginalIndex] || {};
    const published = { ...song };
    delete published.__staticOriginalIndex;
    for (const field of ["sourceId", "sourceHash", "rawHash"]) if (!(field in original)) delete published[field];
    return published;
  });
  return { ...video, songs: publishedSongs };
}

function readDayVideos(dataRoot, channelSetlistImports = readChannelSetlistImports(dataRoot)) {
  const curationContext = loadCurationContext();
  const daysRoot = path.join(dataRoot, "days");
  const files = [];
  if (fs.existsSync(daysRoot)) {
    for (const name of fs.readdirSync(daysRoot).sort()) {
      const target = path.join(daysRoot, name);
      if (/^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && fs.statSync(target).isFile()) files.push(target);
      if (/^\d{4}-\d{2}-\d{2}$/u.test(name) && fs.statSync(target).isDirectory()) {
        for (const part of fs.readdirSync(target).filter((item) => /^part-\d{4}\.json$/u.test(item)).sort()) files.push(path.join(target, part));
      }
    }
  }
  const byVideoId = new Map();
  for (const file of files) {
    for (const video of readJson(file).videos || []) {
      byVideoId.set(video.videoId, curatePublishedVideo(video, curationContext));
    }
  }
  for (const channelImport of channelSetlistImports) {
    for (const video of channelImport.videos) {
      byVideoId.set(video.videoId, curatePublishedVideo(video, curationContext));
    }
  }
  return [...byVideoId.values()];
}

function shanghaiCalendarStart(now, lookbackDays = 1) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const midnight = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  return midnight - (lookbackDays - 1) * 86400000;
}

function timestampInRange(timestamp, now, days, calendarDays = null) {
  const start = calendarDays ? shanghaiCalendarStart(now, calendarDays)
    : days ? now.getTime() - days * 86400000 : Number.NEGATIVE_INFINITY;
  const end = now.getTime() + (calendarDays ? 300000 : 6 * 3600000);
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
}

function filterRange(videos, now, days, calendarDays = null) {
  return videos.filter((video) => timestampInRange(Date.parse(video.publishedAt), now, days, calendarDays));
}

function filterCandidateRange(candidates, now, days, calendarDays = null) {
  if (!days && !calendarDays) return [...candidates];
  return candidates.filter((candidate) => timestampInRange(candidatePublishedTimestampMs(candidate), now, days, calendarDays));
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
  REPAIR_SOURCE_GROUP,
  buildStaticSite,
  compactCandidate,
  canonicalizeStaticSong,
  enqueueSnapshot,
  fixtureSource,
  hashId,
  initialState,
  normalizeKey,
  persistCompleted,
  readChannelSetlistImports,
  readDayVideos,
  reconcileChannelSetlistImports,
  filterRange,
  shanghaiCalendarStart,
  selectInspectionBatch,
};
function youtubeChannelHomeUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return ""; }
  if (parsed.protocol !== "https:" || !/(^|\.)youtube\.com$/u.test(parsed.hostname)) return "";
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (!/^\/(?:channel\/UC[\w-]+|@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)$/u.test(pathname)) return "";
  return `${parsed.origin}${pathname}/streams`;
}
