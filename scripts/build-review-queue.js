const fs = require("node:fs");
const path = require("node:path");
const { createSongSearchLookup, isSongSearchKnown } = require("../assets/frontend-utils");
const {
  hashNormalizedText,
  isCandidateActivityTitle,
  isUnknownArtist,
  loadCurationContext,
  normalizeCurationTitle,
  riskLevel,
  riskScoreFromReasons,
  sourceRiskReasons,
} = require("./curation");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const REVIEW_DIR = path.join(DATA_DIR, "review");
const REVIEW_SOURCE_DIR = path.join(REVIEW_DIR, "sources");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const AUDIT_PATH = path.join(DATA_DIR, "audit.json");
const SNAPSHOT_INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const QUALITY_REPORT_PATH = path.join(DATA_DIR, "quality-report.json");
const QUEUE_PATH = path.join(REVIEW_DIR, "queue.json");
const MANIFEST_PATH = path.join(REVIEW_DIR, "manifest.json");

if (require.main === module) {
  main();
}

function main() {
  const generatedAt = new Date().toISOString();
  const latest = readJsonIfExists(LATEST_PATH);
  if (!latest?.groups) throw new Error("data/latest.json missing groups");
  const audit = readJsonIfExists(AUDIT_PATH) || {};
  const curation = loadCurationContext();
  const lookup = createSongSearchLookup(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {});

  fs.mkdirSync(REVIEW_SOURCE_DIR, { recursive: true });
  clearReviewSources();

  const queueById = new Map();
  addLatestRiskSources(queueById, latest, lookup, generatedAt);
  addAuditRiskSources(queueById, audit, lookup, generatedAt);
  addSnapshotRiskSources(queueById, lookup, generatedAt);

  const queue = [...queueById.values()].sort(compareQueueItems);
  for (const item of queue) writeSourceFile(item);

  const qualityReport = buildQualityReport({
    generatedAt,
    latest,
    audit,
    queue,
    curation,
    previousReport: readJsonIfExists(QUALITY_REPORT_PATH),
  });
  writeJson(QUEUE_PATH, {
    schemaVersion: 1,
    generatedAt,
    curationVersion: curation.version,
    curationHash: curation.hash,
    itemCount: queue.length,
    items: queue.map(({ sourceFilePayload, sourceText, ...item }) => item),
  });
  writeJson(MANIFEST_PATH, {
    schemaVersion: 1,
    generatedAt,
    curationVersion: curation.version,
    queuePath: "data/review/queue.json",
    qualityReportPath: "data/quality-report.json",
    sourceDir: "data/review/sources",
    itemCount: queue.length,
    highRiskSourceCount: queue.filter((item) => item.riskLevel === "high").length,
  });
  writeJson(QUALITY_REPORT_PATH, qualityReport);

  const previousHighRisk = qualityReport.history?.[1]?.highRiskSourceCount;
  if (Number.isInteger(previousHighRisk) && qualityReport.highRiskSourceCount > previousHighRisk * 1.5 + 5) {
    console.warn(
      `[review-queue] warning highRiskSourceCount increased ${previousHighRisk} -> ${qualityReport.highRiskSourceCount}`,
    );
  }
  console.log(
    `[review-queue] items=${queue.length} high=${qualityReport.highRiskSourceCount} nicheUnknown=${qualityReport.nicheUnknownArtistCount}`,
  );
}

function addLatestRiskSources(queueById, latest, lookup, generatedAt) {
  const seenVideoSources = new Set();
  for (const { groupId, item } of iteratePayloadItems(latest)) {
    const source = sourceFromVideoItem(item);
    const key = `${item.videoId}:${source.sourceId || source.sourceHash}`;
    if (seenVideoSources.has(key)) continue;
    seenVideoSources.add(key);
    const risk = analyzeSourceRisk(source, lookup);
    if (!risk.riskReasons.length) continue;
    upsertQueue(queueById, {
      ...baseQueueItem({ generatedAt, item, source, risk }),
      ranges: [groupId],
      sourcePath: sourcePathFor(item.videoId, source.sourceHash),
      sourceFilePayload: buildSourcePayload({ generatedAt, item, source, risk, sourceTextAvailable: false }),
      forceRefreshSuggested: true,
    });
  }
}

function addAuditRiskSources(queueById, audit, lookup, generatedAt) {
  for (const video of audit.videos || []) {
    for (const summary of video.sources || []) {
      const entries = listValues(summary.entries).map((entry) => ({
        ...entry,
        sourceId: summary.sourceId || entry.sourceId || "",
        sourceHash: summary.sourceHash || entry.sourceHash || "",
      }));
      const source = {
        sourceId: summary.sourceId || "",
        sourceHash: summary.sourceHash || hashNormalizedText(JSON.stringify(entries)),
        sourceType: summary.sourceType || "unknown",
        sourceIndex: summary.sourceIndex || 0,
        selected: summary.selected === true,
        songs: entries,
        rejectedEntries: listValues(summary.rejectedEntries),
        stats: {
          ...summary,
          keptCount: summary.keptCount || entries.length,
          unknownArtistCount: summary.unknownArtistCount || entries.filter((entry) => isUnknownArtist(entry.artist)).length,
          activityMarkerCount: summary.activityMarkerCount || entries.filter((entry) => isCandidateActivityTitle(entry.title)).length,
          nicheCount: summary.nicheCount || entries.filter((entry) => entry.isNiche === true).length,
          knownSongCount: summary.knownSongCount || entries.filter((entry) => isKnownSong(entry, lookup)).length,
        },
        sourceText: summary.sourceText || "",
      };
      const item = {
        videoId: video.videoId,
        title: video.title,
        channelName: video.channelName,
        channelId: video.channelId || "",
        channelHandle: video.channelHandle || "",
      };
      const risk = analyzeSourceRisk(source, lookup);
      if (!risk.riskReasons.length && !summary.reason) continue;
      upsertQueue(queueById, {
        ...baseQueueItem({ generatedAt, item, source, risk }),
        sourcePath: sourcePathFor(video.videoId, source.sourceHash),
        sourceFilePayload: buildSourcePayload({
          generatedAt,
          item,
          source,
          risk,
          sourceTextAvailable: Boolean(source.sourceText),
        }),
        forceRefreshSuggested: !source.sourceText,
      });
    }
  }
}

function addSnapshotRiskSources(queueById, lookup, generatedAt) {
  const index = readJsonIfExists(SNAPSHOT_INDEX_PATH);
  for (const entry of index?.snapshots || []) {
    if (!entry?.path) continue;
    const snapshot = readJsonIfExists(path.join(ROOT, entry.path));
    if (!snapshot?.groups) continue;
    for (const { item } of iteratePayloadItems(snapshot)) {
      const source = sourceFromVideoItem(item);
      const risk = analyzeSourceRisk(source, lookup);
      if (!risk.riskReasons.length) continue;
      upsertQueue(queueById, {
        ...baseQueueItem({ generatedAt, item, source, risk }),
        snapshotIds: [entry.id],
        sourcePath: sourcePathFor(item.videoId, source.sourceHash),
        sourceFilePayload: buildSourcePayload({ generatedAt, item, source, risk, sourceTextAvailable: false, snapshotId: entry.id }),
        forceRefreshSuggested: true,
      });
    }
  }
}

function sourceFromVideoItem(item) {
  const sourceId = item.selectedSourceId || item.sourceQuality?.sourceId || item.sourceId || "";
  const sourceHash =
    item.selectedSourceHash ||
    item.sourceQuality?.sourceHash ||
    item.sourceHash ||
    hashNormalizedText(JSON.stringify((item.songs || []).map((song) => [song.seconds, song.title, song.artist, song.raw || ""])));
  const songs = (item.songs || []).map((song) => ({
    ...song,
    sourceId: song.sourceId || sourceId,
    sourceHash: song.sourceHash || sourceHash,
    rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`),
  }));
  return {
    sourceId: sourceId || `selected:${item.videoId}:${sourceHash.slice(0, 16)}`,
    sourceHash,
    sourceType: item.sourceQuality?.sourceType || "selected",
    selected: true,
    songs,
    stats: {
      ...(item.sourceQuality || {}),
      keptCount: songs.length,
      unknownArtistCount: songs.filter((song) => isUnknownArtist(song.artist)).length,
      activityMarkerCount: songs.filter((song) => isCandidateActivityTitle(song.title)).length,
      nicheCount: songs.filter((song) => song.isNiche === true).length,
      knownSongCount: songs.filter((song) => isKnownSong(song, null)).length,
    },
    sourceText: "",
  };
}

function analyzeSourceRisk(source, lookup) {
  const stats = completeStats(source, lookup);
  const sourceForRisk = { ...source, stats };
  const riskReasons = sourceRiskReasons(sourceForRisk, (song) => isKnownSong(song, lookup));
  for (const song of source.songs || []) {
    if (isCandidateActivityTitle(song.title)) addUnique(riskReasons, "activity_marker_title");
    if (song.isNiche === true && isUnknownArtist(song.artist)) addUnique(riskReasons, "niche_unknown_artist");
  }
  const riskScore = riskScoreFromReasons(riskReasons, stats);
  return {
    stats,
    riskReasons,
    riskScore,
    riskLevel: riskLevel(riskScore),
    entryRisks: (source.songs || []).map((song) => ({
      rawHash: song.rawHash,
      seconds: song.seconds,
      title: song.title,
      reasons: entryReasons(song, stats, lookup),
    })),
  };
}

function completeStats(source, lookup) {
  const songs = source.songs || [];
  const unknownArtistCount = source.stats?.unknownArtistCount ?? songs.filter((song) => isUnknownArtist(song.artist)).length;
  const activityMarkerCount = source.stats?.activityMarkerCount ?? songs.filter((song) => isCandidateActivityTitle(song.title)).length;
  const nicheCount = source.stats?.nicheCount ?? songs.filter((song) => song.isNiche === true).length;
  const knownSongCount = source.stats?.knownSongCount ?? songs.filter((song) => isKnownSong(song, lookup)).length;
  return {
    ...(source.stats || {}),
    keptCount: source.stats?.keptCount ?? songs.length,
    parsedEntryCount: source.stats?.parsedEntryCount ?? songs.length + listValues(source.rejectedEntries).length,
    unknownArtistCount,
    unknownArtistRatio: songs.length ? unknownArtistCount / songs.length : 0,
    activityMarkerCount,
    activityMarkerRatio: songs.length ? activityMarkerCount / songs.length : 0,
    nicheCount,
    nicheRatio: songs.length ? nicheCount / songs.length : 0,
    knownSongCount,
  };
}

function entryReasons(song, stats, lookup) {
  const reasons = [];
  if (song.isNiche === true && isUnknownArtist(song.artist)) reasons.push("niche_unknown_artist");
  if (isCandidateActivityTitle(song.title)) reasons.push("activity_marker_title");
  if (normalizeCurationTitle(song.title).length <= 4 && !isKnownSong(song, lookup)) reasons.push("short_unknown_title");
  if ((stats.unknownArtistCount || 0) >= 3 && isUnknownArtist(song.artist)) reasons.push("source_multiple_unknown_artists");
  return reasons;
}

function baseQueueItem({ generatedAt, item, source, risk }) {
  const sourceHash = source.sourceHash || hashNormalizedText(source.sourceText || JSON.stringify(source.songs || []));
  return {
    reviewId: `review:${item.videoId}:${sourceHash.slice(0, 20)}`,
    generatedAt,
    riskScore: risk.riskScore,
    riskLevel: risk.riskLevel,
    riskReasons: risk.riskReasons,
    videoId: item.videoId,
    videoTitle: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    youtubeUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
    sourceId: source.sourceId || `selected:${item.videoId}:${sourceHash.slice(0, 16)}`,
    sourceHash,
    sourceType: source.sourceType || "unknown",
    sourcePath: "",
    selectedSource: source.selected === true,
    parsedEntryCount: risk.stats.parsedEntryCount || risk.stats.keptCount || 0,
    unknownArtistCount: risk.stats.unknownArtistCount || 0,
    nicheCount: risk.stats.nicheCount || 0,
    knownSongCount: risk.stats.knownSongCount || 0,
    activityMarkerCount: risk.stats.activityMarkerCount || 0,
    acceptedCount: (source.songs || []).length,
    rejectedCount: listValues(source.rejectedEntries).length,
    suspiciousEntryCount: risk.entryRisks.filter((entry) => entry.reasons.length).length,
    sourceTextAvailable: Boolean(source.sourceText),
    forceRefreshSuggested: false,
    ranges: [],
    snapshotIds: [],
  };
}

function buildSourcePayload({ generatedAt, item, source, risk, sourceTextAvailable, snapshotId = "" }) {
  return {
    schemaVersion: 1,
    generatedAt,
    reviewId: `review:${item.videoId}:${source.sourceHash.slice(0, 20)}`,
    video: {
      videoId: item.videoId,
      title: item.title || "",
      channelName: item.channelName || "",
      youtubeUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
    },
    source: {
      sourceId: source.sourceId,
      sourceHash: source.sourceHash,
      sourceType: source.sourceType,
      selected: source.selected === true,
      sourceTextAvailable,
      sourceText: sourceTextAvailable ? source.sourceText || "" : "",
      snapshotId,
    },
    risk: {
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      riskReasons: risk.riskReasons,
    },
    entries: [
      ...(source.songs || []).map((song) => ({
        status: "accepted",
        seconds: song.seconds,
        time: song.time || secondsToTime(song.seconds),
        title: song.title || "",
        artist: song.artist || "",
        raw: song.raw || "",
        rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.seconds}:${song.title}`),
        sourceId: source.sourceId,
        sourceHash: source.sourceHash,
        isNiche: song.isNiche === true,
        riskReasons: entryReasons(song, risk.stats, null),
      })),
      ...listValues(source.rejectedEntries).map((entry) => ({
        status: "rejected",
        reason: entry.reason || "unknown",
        seconds: entry.seconds,
        time: entry.time || "",
        title: entry.title || "",
        artist: entry.artist || "",
        raw: entry.line || "",
        rawHash: entry.rawHash || hashNormalizedText(entry.line || entry.title || ""),
        sourceId: source.sourceId,
        sourceHash: source.sourceHash,
        riskReasons: [entry.reason || "rejected_entry"],
      })),
    ],
  };
}

function upsertQueue(queueById, item) {
  const existing = queueById.get(item.reviewId);
  if (!existing) {
    queueById.set(item.reviewId, item);
    return;
  }
  existing.riskScore = Math.max(existing.riskScore, item.riskScore);
  existing.riskLevel = riskLevel(existing.riskScore);
  existing.riskReasons = uniqueValues([...existing.riskReasons, ...item.riskReasons]);
  existing.ranges = uniqueValues([...existing.ranges, ...listValues(item.ranges)]);
  existing.snapshotIds = uniqueValues([...existing.snapshotIds, ...listValues(item.snapshotIds)]);
  existing.forceRefreshSuggested = existing.forceRefreshSuggested || item.forceRefreshSuggested;
  if (!existing.sourceTextAvailable && item.sourceTextAvailable) {
    existing.sourceTextAvailable = true;
    existing.sourceFilePayload = item.sourceFilePayload;
  }
}

function writeSourceFile(item) {
  writeJson(path.join(ROOT, item.sourcePath), item.sourceFilePayload);
}

function sourcePathFor(videoId, sourceHash) {
  return `data/review/sources/${videoId}-${sourceHash.slice(0, 20)}.json`;
}

function buildQualityReport({ generatedAt, latest, audit, queue, curation, previousReport }) {
  const uniqueSongs = new Map();
  for (const { item } of iteratePayloadItems(latest)) {
    for (const song of item.songs || []) {
      const rawHash = song.rawHash || hashNormalizedText(song.raw || `${song.seconds}:${song.title}:${song.artist}`);
      uniqueSongs.set(`${item.videoId}:${song.seconds}:${rawHash}`, { item, song });
    }
  }
  const songs = [...uniqueSongs.values()];
  const topRiskTitles = topCounts(queue.flatMap((item) => item.sourceFilePayload.entries || []).filter((entry) => entry.riskReasons?.length), (entry) => entry.title);
  const topRiskChannels = topCounts(queue, (item) => item.channelName);
  const topRiskVideos = queue
    .slice()
    .sort(compareQueueItems)
    .slice(0, 20)
    .map((item) => ({
      videoId: item.videoId,
      title: item.videoTitle,
      channelName: item.channelName,
      riskScore: item.riskScore,
      riskLevel: item.riskLevel,
      riskReasons: item.riskReasons,
    }));
  const summary = {
    generatedAt,
    curationVersion: curation.version,
    curationHash: curation.hash,
    totalSongs: songs.length,
    unknownArtistCount: songs.filter(({ song }) => isUnknownArtist(song.artist)).length,
    nicheUnknownArtistCount: songs.filter(({ song }) => song.isNiche === true && isUnknownArtist(song.artist)).length,
    highRiskEntryCount: queue.reduce((sum, item) => sum + (item.riskLevel === "high" ? item.suspiciousEntryCount : 0), 0),
    highRiskSourceCount: queue.filter((item) => item.riskLevel === "high").length,
    manualDroppedEntryCount: latest.source?.curationSummary?.manualDroppedEntryCount || 0,
    manualRejectedSourceCount: countAuditSources(audit, "manual_reject_source"),
    ruleDroppedEntryCount: countAuditRejectedEntries(audit, "activity_marker_title"),
    forceRefreshVideoCount: latest.source?.curationSummary?.forceRefreshVideoCount || 0,
    topRiskTitles,
    topRiskChannels,
    topRiskVideos,
    newUnseenPatterns: topRiskTitles.filter((entry) => isCandidateActivityTitle(entry.value)).map((entry) => entry.value),
  };
  const priorHistory = Array.isArray(previousReport?.history) ? previousReport.history : previousReport ? [compactQualityHistory(previousReport)] : [];
  return {
    schemaVersion: 1,
    ...summary,
    history: [compactQualityHistory(summary), ...priorHistory].slice(0, 20),
  };
}

function compactQualityHistory(report) {
  return {
    generatedAt: report.generatedAt,
    totalSongs: report.totalSongs,
    unknownArtistCount: report.unknownArtistCount,
    nicheUnknownArtistCount: report.nicheUnknownArtistCount,
    highRiskEntryCount: report.highRiskEntryCount,
    highRiskSourceCount: report.highRiskSourceCount,
  };
}

function countAuditSources(audit, reason) {
  let count = 0;
  for (const video of audit.videos || []) {
    for (const source of video.sources || []) {
      if (source.reason === reason) count += 1;
    }
  }
  return count;
}

function countAuditRejectedEntries(audit, reason) {
  let count = 0;
  for (const video of audit.videos || []) {
    for (const source of video.sources || []) {
      count += source.rejectedEntryReasons?.[reason] || 0;
    }
  }
  return count;
}

function iteratePayloadItems(payload) {
  const result = [];
  for (const [groupId, group] of Object.entries(payload.groups || {})) {
    for (const item of group.items || []) result.push({ groupId, item });
  }
  return result;
}

function compareQueueItems(a, b) {
  return b.riskScore - a.riskScore || a.channelName.localeCompare(b.channelName, "ja") || a.videoId.localeCompare(b.videoId);
}

function topCounts(items, keyFn, limit = 20) {
  const counts = new Map();
  for (const item of items || []) {
    const key = String(keyFn(item) || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ja"))
    .slice(0, limit);
}

function isKnownSong(song, lookup) {
  if (!lookup?.available) return song?.isNiche === false;
  return isSongSearchKnown(song, lookup);
}

function clearReviewSources() {
  if (!fs.existsSync(REVIEW_SOURCE_DIR)) return;
  for (const dirent of fs.readdirSync(REVIEW_SOURCE_DIR, { withFileTypes: true })) {
    if (dirent.isFile() && dirent.name.endsWith(".json")) fs.rmSync(path.join(REVIEW_SOURCE_DIR, dirent.name));
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function listValues(value) {
  return Array.isArray(value) ? value : [];
}

function secondsToTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

module.exports = {
  analyzeSourceRisk,
  buildQualityReport,
  sourceFromVideoItem,
};
