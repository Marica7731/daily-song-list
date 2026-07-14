const fs = require("node:fs");
const path = require("node:path");
const { createSongSearchLookup, isSongSearchKnown } = require("../assets/frontend-utils");
const { repairParsedEntry } = require("./entry-repair");
const { mergeSupplementalKnownSongs } = require("./song-search-index");
const {
  classifyEntry,
  hashNormalizedText,
  isCandidateActivityTitle,
  isConversationEntry,
  isParserCorruptionEntry,
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
const LEGACY_QUEUE_PATH = path.join(REVIEW_DIR, "queue.json");
const QUEUE_CURRENT_PATH = path.join(REVIEW_DIR, "queue-current.json");
const QUEUE_HISTORY_PATH = path.join(REVIEW_DIR, "queue-history.json");
const CURRENT_ENTRY_INDEX_PATH = path.join(REVIEW_DIR, "current-entry-index.json");
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
  const lookup = createSongSearchLookup(mergeSupplementalKnownSongs(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {}));

  fs.mkdirSync(REVIEW_SOURCE_DIR, { recursive: true });
  clearReviewSources();

  const currentVideoIds = new Set(iteratePayloadItems(latest).map(({ item }) => item.videoId).filter(Boolean));
  const currentQueueById = new Map();
  const historyQueueById = new Map();
  addLatestRiskSources(currentQueueById, latest, lookup, generatedAt);
  addAuditRiskSources(currentQueueById, audit, lookup, generatedAt, { currentVideoIds });
  addSnapshotRiskSources(historyQueueById, lookup, generatedAt);

  const currentQueue = [...currentQueueById.values()].sort(compareQueueItems);
  const historyQueue = [...historyQueueById.values()].sort(compareQueueItems);
  for (const item of [...currentQueue, ...historyQueue]) writeSourceFile(item);
  const currentEntryIndex = buildCurrentEntryIndex(currentQueue);

  const qualityReport = buildQualityReport({
    generatedAt,
    latest,
    audit,
    queue: currentQueue,
    curation,
    previousReport: readJsonIfExists(QUALITY_REPORT_PATH),
  });
  const currentQueuePayload = queuePayload({ generatedAt, curation, queue: currentQueue, scope: "current" });
  writeJson(QUEUE_CURRENT_PATH, currentQueuePayload);
  writeJson(LEGACY_QUEUE_PATH, currentQueuePayload);
  writeJson(QUEUE_HISTORY_PATH, queuePayload({ generatedAt, curation, queue: historyQueue, scope: "history" }));
  writeCompactJson(CURRENT_ENTRY_INDEX_PATH, {
    schemaVersion: 1,
    generatedAt,
    curationVersion: curation.version,
    curationHash: curation.hash,
    itemCount: currentEntryIndex.length,
    items: currentEntryIndex,
  });
  writeJson(MANIFEST_PATH, {
    schemaVersion: 1,
    generatedAt,
    curationVersion: curation.version,
    curationHash: curation.hash,
    currentQueuePath: "data/review/queue-current.json",
    historyQueuePath: "data/review/queue-history.json",
    legacyQueuePath: "data/review/queue.json",
    currentEntryIndexPath: "data/review/current-entry-index.json",
    qualityReportPath: "data/quality-report.json",
    sourceDir: "data/review/sources",
    currentSourceCount: currentQueue.length,
    currentEntryCount: currentEntryIndex.length,
    currentHighRiskCount: currentQueue.filter((item) => item.riskLevel === "high").length,
    historySourceCount: historyQueue.length,
    historyEntryCount: countSourceEntries(historyQueue),
    itemCount: currentQueue.length,
    highRiskSourceCount: currentQueue.filter((item) => item.riskLevel === "high").length,
  });
  writeJson(QUALITY_REPORT_PATH, qualityReport);

  const previousHighRisk = qualityReport.history?.[1]?.highRiskSourceCount;
  if (Number.isInteger(previousHighRisk) && qualityReport.highRiskSourceCount > previousHighRisk * 1.5 + 5) {
    console.warn(
      `[review-queue] warning highRiskSourceCount increased ${previousHighRisk} -> ${qualityReport.highRiskSourceCount}`,
    );
  }
  console.log(
    `[review-queue] current=${currentQueue.length} history=${historyQueue.length} entries=${currentEntryIndex.length} high=${qualityReport.highRiskSourceCount} nicheUnknown=${qualityReport.nicheUnknownArtistCount}`,
  );
}

function addLatestRiskSources(queueById, latest, lookup, generatedAt) {
  const seenVideoSources = new Set();
  for (const { groupId, item } of iteratePayloadItems(latest)) {
    const source = sourceFromVideoItem(item, lookup);
    const key = `${item.videoId}:${source.sourceHash}`;
    if (seenVideoSources.has(key)) continue;
    seenVideoSources.add(key);
    const risk = analyzeSourceRisk(source, lookup);
    if (!risk.riskReasons.length) continue;
    upsertQueue(queueById, {
      ...baseQueueItem({ generatedAt, item, source, risk }),
      scope: "current",
      ranges: [groupId],
      sourcePath: sourcePathFor(item.videoId, source.sourceHash, "current"),
      sourceFilePayload: buildSourcePayload({ generatedAt, item, source, risk, lookup, sourceTextAvailable: false }),
      forceRefreshSuggested: true,
    });
  }
}

function addAuditRiskSources(queueById, audit, lookup, generatedAt, options = {}) {
  const currentVideoIds = options.currentVideoIds || null;
  for (const video of audit.videos || []) {
    if (currentVideoIds && !currentVideoIds.has(video.videoId)) continue;
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
        scope: "current",
        sourcePath: sourcePathFor(video.videoId, source.sourceHash, "current"),
        sourceFilePayload: buildSourcePayload({
          generatedAt,
          item,
          source,
          risk,
          lookup,
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
      const source = sourceFromVideoItem(item, lookup);
      const risk = analyzeSourceRisk(source, lookup);
      if (!risk.riskReasons.length) continue;
      upsertQueue(queueById, {
        ...baseQueueItem({ generatedAt, item, source, risk }),
        scope: "history",
        snapshotIds: [entry.id],
        sourcePath: sourcePathFor(item.videoId, source.sourceHash, "history"),
        sourceFilePayload: buildSourcePayload({ generatedAt, item, source, risk, lookup, sourceTextAvailable: false, snapshotId: entry.id }),
        forceRefreshSuggested: true,
      });
    }
  }
}

function sourceFromVideoItem(item, lookup = null) {
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
      knownArtistCount: songs.filter((song) => !isUnknownArtist(song.artist)).length,
      unknownArtistCount: songs.filter((song) => isUnknownArtist(song.artist)).length,
      activityMarkerCount: songs.filter((song) => isCandidateActivityTitle(song.title)).length,
      conversationEntryCount: songs.filter((song) => isConversationEntry(song)).length,
      parserCorruptionCount: songs.filter((song) => isParserCorruptionEntry(song)).length,
      nicheCount: songs.filter((song) => song.isNiche === true).length,
      knownSongCount: songs.filter((song) => isKnownSong(song, lookup)).length,
    },
    sourceText: "",
  };
}

function analyzeSourceRisk(source, lookup) {
  const stats = completeStats(source, lookup);
  const sourceForRisk = { ...source, stats };
  const riskReasons = sourceRiskReasons(sourceForRisk, (song) => isKnownSong(song, lookup));
  for (const song of source.songs || []) {
    for (const reason of entryReasons(song, stats, lookup)) addUnique(riskReasons, reason);
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
  const knownArtistCount = source.stats?.knownArtistCount ?? source.stats?.artistCount ?? songs.filter((song) => !isUnknownArtist(song.artist)).length;
  const unknownArtistCount = source.stats?.unknownArtistCount ?? songs.filter((song) => isUnknownArtist(song.artist)).length;
  const activityMarkerCount = source.stats?.activityMarkerCount ?? songs.filter((song) => isCandidateActivityTitle(song.title)).length;
  const conversationEntryCount = source.stats?.conversationEntryCount ?? songs.filter((song) => isConversationEntry(song)).length;
  const parserCorruptionCount = source.stats?.parserCorruptionCount ?? songs.filter((song) => isParserCorruptionEntry(song)).length;
  const nicheCount = source.stats?.nicheCount ?? songs.filter((song) => song.isNiche === true).length;
  const knownSongCount = source.stats?.knownSongCount ?? songs.filter((song) => isKnownSong(song, lookup)).length;
  return {
    ...(source.stats || {}),
    keptCount: source.stats?.keptCount ?? songs.length,
    parsedEntryCount: source.stats?.parsedEntryCount ?? songs.length + listValues(source.rejectedEntries).length,
    knownArtistCount,
    artistCount: knownArtistCount,
    unknownArtistCount,
    unknownArtistRatio: songs.length ? unknownArtistCount / songs.length : 0,
    activityMarkerCount,
    activityMarkerRatio: songs.length ? activityMarkerCount / songs.length : 0,
    conversationEntryCount,
    conversationRatio: songs.length ? conversationEntryCount / songs.length : 0,
    parserCorruptionCount,
    parserCorruptionRatio: songs.length ? parserCorruptionCount / songs.length : 0,
    nicheCount,
    nicheRatio: songs.length ? nicheCount / songs.length : 0,
    knownSongCount,
    knownSongRatio: songs.length ? knownSongCount / songs.length : 0,
  };
}

function entryReasons(song, stats, lookup) {
  const reasons = [];
  const knownSong = isKnownSong(song, lookup);
  if (isParserCorruptionEntry(song)) reasons.push("parser_corruption");
  if (!knownSong && isConversationEntry(song)) reasons.push("conversation_entry");
  if (!knownSong && isCandidateActivityTitle(song.title)) reasons.push("activity_marker_title");
  if (!knownSong && song.isNiche === true && isUnknownArtist(song.artist)) reasons.push("niche_unknown_artist");
  if (normalizeCurationTitle(song.title).length <= 4 && !knownSong && isUnknownArtist(song.artist)) reasons.push("short_unknown_title");
  if ((stats.unknownArtistCount || 0) >= 3 && isUnknownArtist(song.artist) && !knownSong) reasons.push("source_multiple_unknown_artists");
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

function buildSourcePayload({ generatedAt, item, source, risk, lookup, sourceTextAvailable, snapshotId = "" }) {
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
      ...(source.songs || []).map((song) => {
        const fields = classificationFields(song, lookup, risk.stats);
        return {
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
          ...fields,
          riskReasons: uniqueValues([...entryReasons(song, risk.stats, lookup), ...(fields.riskReasons || [])]),
        };
      }),
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
        classification: entry.reason === "parser_corruption" ? "parser_corruption" : "confirmed_noise",
        suggestedAction: entry.reason === "parser_corruption" ? "replace_entry" : "drop_entry",
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

function sourcePathFor(videoId, sourceHash, scope = "current") {
  const prefix = scope === "history" ? "history-" : "";
  return `data/review/sources/${prefix}${videoId}-${sourceHash.slice(0, 20)}.json`;
}

function queuePayload({ generatedAt, curation, queue, scope }) {
  return {
    schemaVersion: 1,
    generatedAt,
    curationVersion: curation.version,
    curationHash: curation.hash,
    scope,
    itemCount: queue.length,
    items: queue.map(({ sourceFilePayload, sourceText, ...item }) => ({
      ...item,
      entryPreview: entryPreview(sourceFilePayload.entries || []),
    })),
  };
}

function entryPreview(entries, limit = 3) {
  return entries
    .filter((entry) => entry.riskReasons?.length || entry.classification !== "likely_song")
    .slice(0, limit)
    .map((entry) => ({
      rawHash: entry.rawHash,
      time: entry.time,
      title: entry.title,
      artist: entry.artist,
      classification: entry.classification,
      riskReasons: entry.riskReasons || [],
    }));
}

function buildCurrentEntryIndex(queue) {
  const entries = [];
  const seen = new Set();
  for (const item of queue || []) {
    for (const entry of item.sourceFilePayload?.entries || []) {
      const key = `${item.reviewId}:${entry.rawHash || ""}:${entry.seconds ?? ""}:${entry.status || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        reviewId: item.reviewId,
        sourcePath: item.sourcePath,
        videoId: item.videoId,
        videoTitle: item.videoTitle,
        channelName: item.channelName,
        sourceId: item.sourceId,
        sourceHash: item.sourceHash,
        rawHash: entry.rawHash || "",
        seconds: Number.isInteger(entry.seconds) ? entry.seconds : null,
        time: entry.time || "",
        title: entry.title || "",
        artist: entry.artist || "",
        raw: entry.raw || "",
        status: entry.status || "",
        isNiche: entry.isNiche === true,
        classification: entry.classification || "needs_review",
        suggestedAction: entry.suggestedAction || "manual_review",
        riskReasons: entry.riskReasons || [],
      });
    }
  }
  return entries.sort((a, b) => a.videoTitle.localeCompare(b.videoTitle, "ja") || (a.seconds ?? 0) - (b.seconds ?? 0));
}

function countSourceEntries(queue) {
  return (queue || []).reduce((sum, item) => sum + (item.sourceFilePayload?.entries?.length || 0), 0);
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
  const sourceEntries = queue.flatMap((item) => item.sourceFilePayload.entries || []);
  const topRiskTitles = topRiskTitleSummary(sourceEntries.filter((entry) => entry.riskReasons?.length));
  const classificationCounts = countClassifications(sourceEntries);
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
    ruleDroppedEntryCount: latest.source?.curationSummary?.ruleDroppedEntryCount || countAuditRejectedEntries(audit, "activity_marker_title"),
    conversationDroppedEntryCount: latest.source?.curationSummary?.conversationDroppedEntryCount || 0,
    qualityDroppedEntryCount: latest.source?.curationSummary?.qualityDroppedEntryCount || 0,
    forceRefreshVideoCount: latest.source?.curationSummary?.forceRefreshVideoCount || 0,
    confirmedNoiseCount: classificationCounts.confirmed_noise || 0,
    parserCorruptionCount: classificationCounts.parser_corruption || 0,
    likelyNoiseCount: classificationCounts.likely_noise || 0,
    needsReviewCount: classificationCounts.needs_review || 0,
    likelySongCount: classificationCounts.likely_song || 0,
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

function topRiskTitleSummary(entries, limit = 20) {
  const byTitle = new Map();
  for (const entry of entries || []) {
    const title = String(entry.title || "").trim();
    if (!title) continue;
    if (!byTitle.has(title)) {
      byTitle.set(title, {
        value: title,
        count: 0,
        classifications: {},
        riskReasons: {},
      });
    }
    const summary = byTitle.get(title);
    summary.count += 1;
    if (entry.classification) summary.classifications[entry.classification] = (summary.classifications[entry.classification] || 0) + 1;
    for (const reason of entry.riskReasons || []) summary.riskReasons[reason] = (summary.riskReasons[reason] || 0) + 1;
  }
  return [...byTitle.values()]
    .map((entry) => ({
      ...entry,
      classifications: Object.fromEntries(Object.entries(entry.classifications).sort(([a], [b]) => a.localeCompare(b))),
      riskReasons: Object.fromEntries(Object.entries(entry.riskReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "ja"))
    .slice(0, limit);
}

function countClassifications(entries) {
  const counts = {
    confirmed_noise: 0,
    parser_corruption: 0,
    likely_noise: 0,
    needs_review: 0,
    likely_song: 0,
  };
  for (const entry of entries || []) {
    if (entry.classification && entry.classification in counts) counts[entry.classification] += 1;
  }
  return counts;
}

function isKnownSong(song, lookup) {
  if (!lookup?.available) return song?.isNiche === false;
  return isSongSearchKnown(song, lookup);
}

function classificationFields(song, lookup, sourceStats = {}) {
  const repaired = repairParsedEntry(song, lookup);
  const repairChanged = Boolean(repaired.repair?.changed);
  const knownSong = isKnownSong(repaired, lookup);
  const classification = repairChanged
    ? { classification: "parser_corruption", suggestedAction: "replace_entry", riskReasons: ["parser_corruption"] }
    : classifyEntry(repaired, { knownSong });
  const evidence = positiveEvidence(repaired, knownSong, sourceStats);
  if (classification.classification === "likely_song" && !evidence.length) {
    return {
      classification: "needs_review",
      suggestedAction: "manual_review",
      riskReasons: ["no_positive_song_evidence"],
      positiveEvidence: [],
    };
  }
  return {
    classification: classification.classification,
    suggestedAction: classification.suggestedAction,
    replacementSuggestion: buildReplacementSuggestion(song, repaired, classification.classification),
    riskReasons: uniqueValues(classification.riskReasons || []),
    positiveEvidence: evidence,
  };
}

function buildReplacementSuggestion(original, repaired, classification) {
  if (classification !== "parser_corruption") return null;
  const replacement = {};
  if (String(repaired.title || "") !== String(original.title || "")) replacement.title = repaired.title || "";
  if (String(repaired.artist || "") !== String(original.artist || "")) replacement.artist = repaired.artist || "";
  if (Number.isInteger(repaired.seconds) && repaired.seconds !== original.seconds) replacement.seconds = repaired.seconds;
  return Object.keys(replacement).length ? replacement : null;
}

function positiveEvidence(song, knownSong, sourceStats = {}) {
  const evidence = [];
  if (knownSong) evidence.push("known_song");
  if (song?.forceKept === true) evidence.push("force_keep");
  if (!isUnknownArtist(song?.artist)) evidence.push("known_artist");
  if ((sourceStats.structuralCount || 0) > 0) evidence.push("structured_setlist");
  return evidence;
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

function writeCompactJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
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
