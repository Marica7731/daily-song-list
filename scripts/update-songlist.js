const fs = require("node:fs");
const path = require("node:path");
const {
  BLOCKED_REGIONAL_VTUBER_CHANNELS,
  BLOCKLIST_HASH,
  BLOCKLIST_VERSION,
  assertNoBlockedVideos,
  createBlockedSourceAudit,
  filterBlockedVideos,
  isBlockedSource,
  matchBlockedSource,
} = require("../assets/source-filter");
const { createSongSearchLookup, normalizeSongSearchText } = require("../assets/frontend-utils");
const { buildArtistRecords, buildCompetitionRanks, buildSongRecords } = require("../assets/ranking-utils");
const { compactRankDiff, writeRuntimeJson } = require("./build-runtime-data");
const { repairParsedEntry } = require("./entry-repair");
const { canonicalizePayloadSongAliases, canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { mergeSupplementalKnownSongs } = require("./song-search-index");
const {
  VIDEO_CATALOG_PATH,
  catalogSummary,
  catalogToVideos,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  rebuildVideoCatalogFromVideos,
  writeCatalogSegments,
  writeVideoCatalog,
} = require("./video-catalog");
const {
  CANONICAL_RANGES,
  DIFF_RANGES,
  RANGE_TITLES,
  WEEK_MS,
  canonicalItemCounts,
  groupForRange,
  legacyAliasManifest,
} = require("./range-config");
const {
  applyCurationToSources,
  applyCurationToVideos,
  collectForceRefreshVideoIds,
  createSourceRecord,
  hashNormalizedText,
  isActivityMarkerTitle,
  isCandidateActivityTitle,
  isConversationEntry,
  isParserCorruptionEntry,
  isUnknownArtist,
  loadCurationContext,
  riskLevel,
  riskScoreFromReasons,
  sourceRiskReasons,
} = require("./curation");
const { isLikelyNonSongEntry, isTimestampCandidateText, normalizeParsedSong, normalizeSourceAwareArtist, parseTimestampSongs } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SNAPSHOT_INDEX_PATH = path.join(SNAPSHOT_DIR, "index.json");
const DIFF_DIR = path.join(DATA_DIR, "diff");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");
const AUDIT_PATH = path.join(DATA_DIR, "audit.json");
const INSPECTION_CACHE_PATH = path.join(DATA_DIR, "inspection-cache.json");
const MYGIT_TODAY_SNAPSHOT_STATE_PATH = path.join(DATA_DIR, "mygit-today-snapshot-import-state.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const DISPLAY_TIME_ZONE = "Asia/Shanghai";

const KEYWORDS = [
  {
    keyword: "歌枠",
    key: "utawaku",
    urls: {
      today: "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBAgCGAI%253D",
      month: "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBggEEAEYAg%253D%253D",
    },
  },
  {
    keyword: "弾き語り",
    key: "hikigatari",
    urls: {
      today: "https://www.youtube.com/results?search_query=%E5%BC%BE%E3%81%8D%E8%AA%9E%E3%82%8A&sp=CAMSBAgCGAI%253D",
      month: "https://www.youtube.com/results?search_query=%E5%BC%BE%E3%81%8D%E8%AA%9E%E3%82%8A&sp=CAMSBggEEAEYAg%253D%253D",
    },
  },
];
const MONTH_SEARCH_URLS = new Set(KEYWORDS.map((keyword) => keyword.urls.month));
const MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP = "mygit_today_snapshot";
const MYGIT_TODAY_SNAPSHOT_SOURCE_LABEL = "Marica7731/mygit today snapshots";
const MYGIT_TODAY_SNAPSHOT_KEYWORD = "mygit今日快照";
const MYGIT_TODAY_SNAPSHOT_KEYWORD_KEY = "mygit_today_snapshot";
const MYGIT_RAW_BASE_URL = String(
  process.env.DAILY_SONG_MYGIT_RAW_BASE_URL || "https://raw.githubusercontent.com/Marica7731/mygit/main",
).replace(/\/+$/u, "");
const MYGIT_TODAY_SNAPSHOT_INDEX_URL = joinUrl(MYGIT_RAW_BASE_URL, "data/today-snapshots/index.json");

const SEARCH_GROUPS = {
  today: {
    id: "today",
    label: "YouTube today filter",
    description: "Same YouTube search filter used by Marica7731/mygit for today's ranking.",
  },
  month: {
    id: "month",
    label: "YouTube month filter",
    description: "Same YouTube search filter used by Marica7731/mygit for monthly ranking.",
  },
};

const SEARCH_LIMIT = positiveInteger(process.env.DAILY_SONG_SEARCH_LIMIT, 160);
const VIDEO_LIMIT = positiveInteger(process.env.DAILY_SONG_VIDEO_LIMIT, 160);
const RECENT_BUCKET_LIMIT = positiveInteger(process.env.DAILY_SONG_RECENT_BUCKET_LIMIT, Math.max(40, Math.floor(VIDEO_LIMIT / 4)));
const VIDEO_CONCURRENCY = positiveInteger(process.env.DAILY_SONG_VIDEO_CONCURRENCY, 2);
const REPLY_LIMIT = positiveInteger(process.env.DAILY_SONG_COMMENT_REPLY_LIMIT, 12);
const SEARCH_CONTINUATION_ROUNDS = positiveInteger(process.env.DAILY_SONG_SEARCH_CONTINUATION_ROUNDS, 40);
const FETCH_RETRIES = positiveInteger(process.env.DAILY_SONG_FETCH_RETRIES, 3);
  const REQUEST_TIMEOUT_MS = positiveInteger(process.env.DAILY_SONG_REQUEST_TIMEOUT_MS, 15_000);
const REQUEST_DELAY_MS = nonNegativeInteger(process.env.DAILY_SONG_REQUEST_DELAY_MS, 0);
const REQUEST_JITTER_MS = nonNegativeInteger(process.env.DAILY_SONG_REQUEST_JITTER_MS, 0);
const RATE_LIMIT_COOLDOWN_MS = nonNegativeInteger(process.env.DAILY_SONG_429_COOLDOWN_MS, 15_000);
const RETRY_JITTER_MS = nonNegativeInteger(process.env.DAILY_SONG_RETRY_JITTER_MS, 0);
const MAX_429_ERRORS = nonNegativeInteger(process.env.DAILY_SONG_MAX_429_ERRORS, 8);
const SNAPSHOT_RETENTION_DAYS = nonNegativeInteger(process.env.DAILY_SONG_SNAPSHOT_RETENTION_DAYS, 0);
const INSPECTION_CACHE_RETENTION_DAYS = positiveInteger(process.env.DAILY_SONG_INSPECTION_CACHE_RETENTION_DAYS, 35);
const INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS = positiveInteger(process.env.DAILY_SONG_INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS, 6);
const INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS = positiveInteger(process.env.DAILY_SONG_INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS, 48);
const CARRY_FORWARD_MAX_AGE_HOURS = positiveInteger(process.env.DAILY_SONG_CARRY_FORWARD_MAX_AGE_HOURS, 36);
const MONTH_REFRESH_LIMIT = positiveInteger(process.env.DAILY_SONG_MONTH_REFRESH_LIMIT, Math.max(20, Math.floor(VIDEO_LIMIT / 8)));
const MONTH_BACKFILL_TARGET = positiveInteger(process.env.DAILY_SONG_MONTH_BACKFILL_TARGET, VIDEO_LIMIT * 18);
const MONTH_BACKFILL_RECENT_BUCKET_LIMIT = positiveInteger(
  process.env.DAILY_SONG_MONTH_BACKFILL_RECENT_BUCKET_LIMIT,
  Math.max(1, Math.floor(VIDEO_LIMIT / 8)),
);
const MYGIT_TODAY_SNAPSHOTS_ENABLED = !isDisabledEnv(process.env.DAILY_SONG_MYGIT_TODAY_SNAPSHOTS);
const MYGIT_TODAY_SNAPSHOT_LOOKBACK_DAYS = parseOptionalLimit(process.env.DAILY_SONG_MYGIT_TODAY_SNAPSHOT_DAYS, 0);
const MYGIT_TODAY_SNAPSHOT_LIMIT = parseOptionalLimit(process.env.DAILY_SONG_MYGIT_TODAY_SNAPSHOT_LIMIT, 0);
const RECENT_WINDOW_DAYS = positiveInteger(process.env.DAILY_SONG_RECENT_WINDOW_DAYS, 7);
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS === 7 ? WEEK_MS : RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const RECENT_WINDOW_HOURS = RECENT_WINDOW_DAYS * 24;
const H72_MS = RECENT_WINDOW_MS;
const rankCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
  ignorePunctuation: true,
});
const requestLimiter = createRequestLimiter({ requestDelayMs: REQUEST_DELAY_MS, requestJitterMs: REQUEST_JITTER_MS, max429Errors: MAX_429_ERRORS });

if (require.main === module) {
  main().catch((error) => {
    console.error(`[update] ${error.stack || error.message}`);
    markFailure(error).finally(() => process.exit(2));
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const startedAt = new Date();
  const songAliasContext = loadSongAliasContext();
  const curationContext = { ...loadCurationContext(), songSearchLookup: loadSongSearchLookup(), songAliasContext };
  const blockedSourceAudit = createBlockedSourceAudit();
  const forceRefreshVideoIds = collectForceRefreshVideoIds(curationContext);
  const previousPayload = readJsonIfExists(LATEST_PATH);
  const previousAudit = readJsonIfExists(AUDIT_PATH);
  const previousInspectionCache = readJsonIfExists(INSPECTION_CACHE_PATH);
  const carryForward = collectCarryForwardVideos(previousPayload, previousAudit, startedAt, {
    forceRefreshVideoIds,
    inspectionCache: previousInspectionCache,
  });
  const { candidates, searchSummaries } = await collectCandidates(startedAt);
  const selection = selectCandidatesForInspection(candidates, startedAt, {
    carryForwardEnabled: carryForward.enabled,
    excludeVideoIds: carryForward.skipVideoIds,
    carriedMonthVideoCount: carryForward.counts.month,
  });
  const inspectionCandidates = selection.items;
  console.log(
    `[update] candidates=${candidates.length} inspect=${inspectionCandidates.length} carry=${carryForward.videos.length} skippedKnown=${selection.skippedKnownCandidateCount} mode=${selection.mode}`,
  );

  const { inspected, videos: fetchedVideos, audits } = await inspectCandidates(inspectionCandidates, curationContext);
  const capturedAt = new Date();
  const inspectionCache = mergeInspectionCache(previousInspectionCache, audits, capturedAt);
  const curatedMergedVideos = applyCurationToVideos(mergeFetchedAndCarriedVideos(fetchedVideos, carryForward.videos), curationContext);
  const videos = filterBlockedVideos(curatedMergedVideos, { audit: blockedSourceAudit });

  const catalogUpdate = mergeVideosIntoCatalog(loadVideoCatalog(), videos, capturedAt, {
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  const catalogVideos = filterBlockedVideos(applyCurationToVideos(catalogToVideos(catalogUpdate.catalog), curationContext), { audit: blockedSourceAudit });
  const catalogRefresh = rebuildVideoCatalogFromVideos(catalogVideos, capturedAt, {
    previousCatalog: catalogUpdate.catalog,
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
  });
  writeVideoCatalog(catalogRefresh.catalog, VIDEO_CATALOG_PATH);
  const catalogSegments = writeCatalogSegments(catalogRefresh.catalog);

  const groupVideos = catalogToVideos(catalogRefresh.catalog);
  assertNoBlockedVideos(groupVideos, "catalogRefresh");
  const groups = applyGroupQualityFilters(buildGroups(groupVideos, capturedAt));
  const totalItems = Object.values(groups).reduce((sum, group) => sum + group.items.length, 0);
  if (totalItems <= 0) {
    throw new Error(`No usable timestamp song lists found after inspecting ${inspected.length} videos.`);
  }
  const previousSnapshot = selectPreviousSnapshotForDiff(readPreviousSuccessfulSnapshot(), previousPayload);

  let payload = {
    schemaVersion: 1,
    generatedAt: capturedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
    blocklistVersion: BLOCKLIST_VERSION,
    blocklistHash: BLOCKLIST_HASH,
    source: {
      name: "YouTube search + watch comments/descriptions",
      keywords: KEYWORDS.map((keyword) => ({ keyword: keyword.keyword, key: keyword.key })),
      searchGroups: SEARCH_GROUPS,
      searches: searchSummaries,
      inspectedCount: inspected.length,
      fetchedUsableVideoCount: fetchedVideos.length,
      carriedVideoCount: carryForward.videos.length,
      carried72hVideoCount: carryForward.counts.h72,
      carried7dVideoCount: carryForward.counts.h72,
      carriedMonthVideoCount: carryForward.counts.month,
      carriedAllVideoCount: carryForward.counts.month,
      blocklistVersion: BLOCKLIST_VERSION,
      blocklistHash: BLOCKLIST_HASH,
      blacklistedSourceCount: BLOCKED_REGIONAL_VTUBER_CHANNELS.entries.length,
      blacklistedSources: BLOCKED_REGIONAL_VTUBER_CHANNELS.entries.map((entry) => entry.name),
      blockedSourceAudit: blockedSourceAudit.summary(),
      skippedBlacklistedSearchCount: sumBy(searchSummaries, (summary) => summary.skippedBlacklistedSource || 0),
      skippedBlacklistedCandidateCount: selection.skippedBlacklistedCandidateCount,
      carryForwardEnabled: carryForward.enabled,
      carryForwardFrom: carryForward.from,
      carryForwardAgeHours: carryForward.ageHours,
      carryForwardReason: carryForward.reason,
      knownVideoSkipCount: carryForward.skipVideoIds.size,
      inspectionCacheSkipCount: carryForward.inspectionCacheSkipCount,
      skippedKnownCandidateCount: selection.skippedKnownCandidateCount,
      usableVideoCount: videos.length,
      catalogVideoCount: catalogRefresh.stats.catalogVideoCount,
      candidateCount: candidates.length,
      inspectionLimit: VIDEO_LIMIT,
      videoConcurrency: VIDEO_CONCURRENCY,
      requestDelayMs: REQUEST_DELAY_MS,
      requestJitterMs: REQUEST_JITTER_MS,
      rateLimitCooldownMs: RATE_LIMIT_COOLDOWN_MS,
      retryJitterMs: RETRY_JITTER_MS,
      max429Errors: MAX_429_ERRORS,
      rateLimitErrorCount: requestLimiter.error429Count,
      curationVersion: curationContext.version,
      curationHash: curationContext.hash,
      curationSummary: {
        manualDroppedEntryCount: curatedMergedVideos.curationStats?.droppedEntries || 0,
        manualReplacedEntryCount: curatedMergedVideos.curationStats?.replacedEntries || 0,
        manualDroppedVideoCount: curatedMergedVideos.curationStats?.droppedVideos || 0,
        ruleDroppedEntryCount: curatedMergedVideos.curationStats?.ruleDroppedEntries || 0,
        conversationDroppedEntryCount: curatedMergedVideos.curationStats?.conversationDroppedEntries || 0,
        nearDuplicateDroppedEntryCount: curatedMergedVideos.curationStats?.nearDuplicateDroppedEntries || 0,
        nearDuplicateGroupCount: curatedMergedVideos.curationStats?.nearDuplicateGroups || 0,
        forceRefreshVideoCount: forceRefreshVideoIds.size,
      },
      recentBucketLimit: RECENT_BUCKET_LIMIT,
      monthRefreshLimit: MONTH_REFRESH_LIMIT,
      monthBackfillTarget: MONTH_BACKFILL_TARGET,
      monthBackfillRecentBucketLimit: selection.monthBackfillRecentBucketLimit,
      monthRefreshReserveLimit: selection.monthRefreshReserveLimit,
      monthBackfillEnabled: selection.monthBackfillEnabled,
      recentScanHorizonHours: selection.recentScanHorizonHours,
      auditPath: "data/audit.json",
      auditSummary: summarizeAudits(audits),
      videoCatalog: {
        ...catalogSummary(catalogRefresh.catalog, capturedAt),
        segments: {
          path: "data/catalog-segments/manifest.json",
          segmentSize: catalogSegments.segmentSize,
          segmentCount: catalogSegments.segmentCount,
          itemCount: catalogSegments.itemCount,
        },
        addedVideoCount: catalogRefresh.stats.addedVideoCount,
        updatedVideoCount: catalogRefresh.stats.updatedVideoCount,
        expiredVideoCount: catalogRefresh.stats.expiredVideoCount,
        fromCurrentRunVideoCount: videos.length,
        h72VideoCount: groups["7d"]?.items?.length || 0,
        recent7dVideoCount: groups["7d"]?.items?.length || 0,
        monthVideoCount: groups.all?.items?.length || 0,
        allVideoCount: groups.all?.items?.length || 0,
      },
      inspectionCache: {
        path: "data/inspection-cache.json",
        videoCount: inspectionCache.stats.videoCount,
        retainedVideoCount: inspectionCache.stats.retainedVideoCount,
        updatedVideoCount: inspectionCache.stats.updatedVideoCount,
        skippedKnownVideoCount: carryForward.inspectionCacheSkipCount,
        retentionDays: INSPECTION_CACHE_RETENTION_DAYS,
        fetchErrorTtlHours: INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS,
        noUsableMinAgeHours: INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS,
      },
    },
    status: {
      status: "success",
      attemptedAt: startedAt.toISOString(),
      completedAt: capturedAt.toISOString(),
      capturedAt: capturedAt.toISOString(),
      dataCapturedAt: capturedAt.toISOString(),
      message: `Captured ${totalItems} videos with timestamp song lists.`,
    },
    groups,
  };
  payload = canonicalizePayloadSongAliases(payload, songAliasContext);

  writeJson(LATEST_PATH, payload);
  writeJson(AUDIT_PATH, {
    schemaVersion: 1,
    generatedAt: capturedAt.toISOString(),
    curationVersion: curationContext.version,
    curationHash: curationContext.hash,
    candidateCount: candidates.length,
    inspectedCount: inspected.length,
    fetchedUsableVideoCount: fetchedVideos.length,
    carriedVideoCount: carryForward.videos.length,
    carryForward: {
      enabled: carryForward.enabled,
      from: carryForward.from,
      ageHours: carryForward.ageHours,
      reason: carryForward.reason,
      counts: carryForward.counts,
      knownVideoSkipCount: carryForward.skipVideoIds.size,
      inspectionCacheSkipCount: carryForward.inspectionCacheSkipCount,
      skippedKnownCandidateCount: selection.skippedKnownCandidateCount,
      monthBackfillEnabled: selection.monthBackfillEnabled,
      monthRefreshReserveLimit: selection.monthRefreshReserveLimit,
      forceRefreshVideoCount: forceRefreshVideoIds.size,
    },
    usableVideoCount: videos.length,
    searches: searchSummaries,
    summary: payload.source.auditSummary,
    blacklistedSources: payload.source.blacklistedSources,
    skippedBlacklistedSearchCount: payload.source.skippedBlacklistedSearchCount,
    skippedBlacklistedCandidateCount: payload.source.skippedBlacklistedCandidateCount,
    videos: audits,
  });
  writeJson(INSPECTION_CACHE_PATH, inspectionCache.cache);
  writeRangeArtifacts(groups);
  writeRankDiffFiles(payload, previousSnapshot, curationContext);
  writeSnapshot(payload, capturedAt);
  writeJson(STATUS_PATH, payload.status);
  console.log(`[update] success totalItems=${totalItems} snapshot=${hourSnapshotId(capturedAt)}`);
}

async function collectCandidates(now) {
  const nowMs = now.getTime();
  const byVideoId = new Map();
  const searchSummaries = [];
  for (const search of buildSearchSources()) {
    let result;
    try {
      result = await fetchSearchSource(search);
    } catch (error) {
      const summary = createFailedSearchSummary(search, error);
      searchSummaries.push(summary);
      console.warn(`[search:${search.sourceGroup}] ${search.keyword} failed=${summary.error}`);
      continue;
    }
    searchSummaries.push(result.summary);
    for (const item of result.items) {
      mergeCandidate(byVideoId, item, search, nowMs);
    }
  }
  const mygitResult = await fetchMygitTodaySnapshotSource(now, { persistState: true });
  if (mygitResult.summary) searchSummaries.push(mygitResult.summary);
  for (const item of mygitResult.items) {
    mergeCandidate(
      byVideoId,
      item,
      {
        sourceGroup: MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP,
        sourceLabel: MYGIT_TODAY_SNAPSHOT_SOURCE_LABEL,
        keyword: MYGIT_TODAY_SNAPSHOT_KEYWORD,
        keywordKey: MYGIT_TODAY_SNAPSHOT_KEYWORD_KEY,
        url: MYGIT_TODAY_SNAPSHOT_INDEX_URL,
      },
      nowMs,
    );
  }

  return {
    candidates: [...byVideoId.values()].sort(candidateSort),
    searchSummaries,
  };
}

function buildSearchSources() {
  return Object.keys(SEARCH_GROUPS).flatMap((sourceGroup) =>
    KEYWORDS.map((keyword) => ({
      sourceGroup,
      sourceLabel: SEARCH_GROUPS[sourceGroup].label,
      keyword: keyword.keyword,
      keywordKey: keyword.key,
      url: keyword.urls[sourceGroup],
    })),
  );
}

function createFailedSearchSummary(search, error) {
  return {
    sourceGroup: search.sourceGroup,
    sourceLabel: search.sourceLabel,
    keyword: search.keyword,
    keywordKey: search.keywordKey,
    url: search.url,
    itemCount: 0,
    limit: SEARCH_LIMIT,
    continuationRounds: 0,
    reachedEnd: false,
    truncatedByLimit: false,
    skippedBlacklistedSource: 0,
    skippedActiveLiveOrUpcoming: 0,
    failed: true,
    error: error?.message || String(error),
    collectedAt: new Date().toISOString(),
  };
}

async function fetchSearchSource(search) {
  const collectedAt = new Date().toISOString();
  const seenContinuations = new Set();
  const items = [];
  let continuation = "";
  let apiKey = "";
  let clientVersion = "";
  let reachedEnd = false;
  let continuationRounds = 0;

  const html = await fetchText(search.url);
  apiKey = extractRegex(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
  clientVersion = extractRegex(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || "2.20260601.00.00";
  const initialData = extractJsonAfter(html, "ytInitialData");
  addSearchItems(items, extractSearchItems(initialData));
  continuation = findSearchContinuation(initialData);

  while (items.length < SEARCH_LIMIT && continuation && apiKey && continuationRounds < SEARCH_CONTINUATION_ROUNDS) {
    if (seenContinuations.has(continuation)) break;
    seenContinuations.add(continuation);
    continuationRounds += 1;
    const response = await fetchYouTubeSearchContinuation(apiKey, clientVersion, continuation);
    addSearchItems(items, extractSearchItems(response));
    continuation = findSearchContinuation(response);
  }

  if (!continuation || items.length < SEARCH_LIMIT) reachedEnd = true;
  const deduped = dedupeByVideoId(items);
  const skippedBlacklistedSource = deduped.filter((item) => isBlockedSource(item)).length;
  const skippedActiveLiveOrUpcoming = deduped.filter((item) => isActiveLiveOrUpcomingCandidate(item)).length;
  const finalItems = deduped.filter((item) => !isBlockedSource(item) && !isActiveLiveOrUpcomingCandidate(item)).slice(0, SEARCH_LIMIT);
  const summary = {
    sourceGroup: search.sourceGroup,
    sourceLabel: search.sourceLabel,
    keyword: search.keyword,
    keywordKey: search.keywordKey,
    url: search.url,
    itemCount: finalItems.length,
    limit: SEARCH_LIMIT,
    continuationRounds,
    reachedEnd,
    truncatedByLimit: finalItems.length >= SEARCH_LIMIT && !reachedEnd,
    skippedBlacklistedSource,
    skippedActiveLiveOrUpcoming,
    collectedAt,
  };
  console.log(
    `[search:${search.sourceGroup}] ${search.keyword} items=${summary.itemCount} skippedBlocked=${skippedBlacklistedSource} skippedLive=${skippedActiveLiveOrUpcoming} rounds=${continuationRounds} reachedEnd=${reachedEnd}`,
  );
  return { summary, items: finalItems };
}

async function fetchMygitTodaySnapshotSource(now, options = {}) {
  const enabled = options.enabled ?? MYGIT_TODAY_SNAPSHOTS_ENABLED;
  const collectedAt = new Date().toISOString();
  const indexUrl = options.indexUrl || MYGIT_TODAY_SNAPSHOT_INDEX_URL;
  const rawBaseUrl = String(options.rawBaseUrl || MYGIT_RAW_BASE_URL).replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl || fetch;
  const lookbackDays = parseOptionalLimit(options.lookbackDays, MYGIT_TODAY_SNAPSHOT_LOOKBACK_DAYS);
  const maxSnapshots = parseOptionalLimit(options.maxSnapshots, MYGIT_TODAY_SNAPSHOT_LIMIT);
  const statePath = options.statePath || MYGIT_TODAY_SNAPSHOT_STATE_PATH;
  const importState = options.persistState ? loadMygitSnapshotImportState(statePath) : createMygitSnapshotImportState();
  const baseSummary = {
    sourceGroup: MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP,
    sourceLabel: MYGIT_TODAY_SNAPSHOT_SOURCE_LABEL,
    keyword: MYGIT_TODAY_SNAPSHOT_KEYWORD,
    keywordKey: MYGIT_TODAY_SNAPSHOT_KEYWORD_KEY,
    url: indexUrl,
    limit: maxSnapshots,
    lookbackDays,
    collectedAt,
  };
  if (!enabled) {
    return {
      summary: {
        ...baseSummary,
        status: "disabled",
        itemCount: 0,
        snapshotCount: 0,
        fetchedSnapshotCount: 0,
      },
      items: [],
    };
  }

  try {
    const index = await fetchJsonUrl(fetchImpl, indexUrl);
    const selectedEntries = selectMygitTodaySnapshotEntries(index, now, {
      lookbackDays,
      maxSnapshots,
      importedSnapshotIds: importState.importedSnapshotIds,
    });
    const byVideoId = new Map();
    const fetchedSnapshotIds = [];
    const snapshotErrors = [];
    let rawItemCount = 0;
    for (const entry of selectedEntries) {
      const snapshotUrl = mygitSnapshotEntryUrl(rawBaseUrl, entry);
      if (!snapshotUrl) continue;
      try {
        const snapshot = await fetchJsonUrl(fetchImpl, snapshotUrl);
        const items = extractMygitTodaySnapshotItems(snapshot, {
          snapshotId: entry.id || snapshot.snapshotId || "",
          snapshotUrl,
          capturedAt: entry.capturedAt || snapshot.collectedAt || snapshot.generatedAt || "",
        });
        rawItemCount += items.length;
        fetchedSnapshotIds.push(entry.id || snapshot.snapshotId || snapshotUrl);
        for (const item of items) upsertMygitSnapshotCandidate(byVideoId, item);
      } catch (error) {
        snapshotErrors.push({
          snapshotId: entry.id || "",
          path: entry.path || entry.file || "",
          message: error.message,
        });
      }
    }
    const items = [...byVideoId.values()].sort(candidateSort);
    const status = snapshotErrors.length
      ? fetchedSnapshotIds.length
        ? "partial"
        : "error"
      : "success";
    console.log(
      `[mygit:${status}] snapshots=${fetchedSnapshotIds.length}/${selectedEntries.length} rawItems=${rawItemCount} items=${items.length} errors=${snapshotErrors.length}`,
    );
    if (options.persistState) {
      writeMygitSnapshotImportState(statePath, updateMygitSnapshotImportState(importState, {
        attemptedAt: collectedAt,
        status,
        selectedEntries,
        fetchedSnapshotIds,
        itemCount: items.length,
        snapshotErrors,
      }));
    }
    return {
      summary: {
        ...baseSummary,
        status,
        itemCount: items.length,
        rawItemCount,
        availableSnapshotCount: listValues(index?.snapshots).length,
        snapshotCount: selectedEntries.length,
        fetchedSnapshotCount: fetchedSnapshotIds.length,
        selectedSnapshotIds: selectedEntries.map((entry) => entry.id || entry.file || entry.path).filter(Boolean),
        fetchedSnapshotIds,
        snapshotErrors: snapshotErrors.slice(0, 5),
      },
      items,
    };
  } catch (error) {
    console.warn(`[mygit:error] ${error.message}`);
    if (options.persistState) {
      writeMygitSnapshotImportState(statePath, updateMygitSnapshotImportState(importState, {
        attemptedAt: collectedAt,
        status: "error",
        selectedEntries: [],
        fetchedSnapshotIds: [],
        itemCount: 0,
        snapshotErrors: [{ message: error.message }],
      }));
    }
    return {
      summary: {
        ...baseSummary,
        status: "error",
        itemCount: 0,
        snapshotCount: 0,
        fetchedSnapshotCount: 0,
        error: error.message,
      },
      items: [],
    };
  }
}

function selectMygitTodaySnapshotEntries(index, now, options = {}) {
  const lookbackDays = parseOptionalLimit(options.lookbackDays, MYGIT_TODAY_SNAPSHOT_LOOKBACK_DAYS);
  const maxSnapshots = parseOptionalLimit(options.maxSnapshots, MYGIT_TODAY_SNAPSHOT_LIMIT);
  const importedSnapshotIds = new Set(listValues(options.importedSnapshotIds));
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return [];
  const earliestMs = lookbackDays > 0 ? nowMs - lookbackDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  const latestAllowedMs = nowMs + 6 * 60 * 60 * 1000;
  const sorted = listValues(index?.snapshots)
    .map((entry) => ({ entry, timestamp: mygitSnapshotEntryTimestamp(entry) }))
    .filter(({ entry, timestamp }) => entry && Number.isFinite(timestamp))
    .filter(({ timestamp }) => timestamp >= earliestMs && timestamp <= latestAllowedMs)
    .sort((a, b) => b.timestamp - a.timestamp);
  const byDay = new Map();
  for (const item of sorted) {
    const snapshotId = item.entry?.id || item.entry?.file || item.entry?.path || "";
    if (snapshotId && importedSnapshotIds.has(snapshotId)) continue;
    const day = mygitSnapshotEntryDay(item.entry, item.timestamp);
    if (!day || byDay.has(day)) continue;
    byDay.set(day, item.entry);
    if (maxSnapshots > 0 && byDay.size >= maxSnapshots) break;
  }
  return [...byDay.values()];
}

function extractMygitTodaySnapshotItems(snapshot, context = {}) {
  const groups = snapshot?.groups?.today?.keywords || snapshot?.keywords || {};
  const groupEntries = Object.entries(groups).filter(([, items]) => Array.isArray(items));
  if (Array.isArray(snapshot?.items)) groupEntries.push(["", snapshot.items]);
  const byVideoId = new Map();
  for (const [keyword, items] of groupEntries) {
    for (const item of items) {
      const normalized = normalizeMygitTodaySnapshotItem(item, { ...context, keyword });
      if (!normalized || isBlockedSource(normalized) || isActiveLiveOrUpcomingCandidate(normalized)) continue;
      upsertMygitSnapshotCandidate(byVideoId, normalized);
    }
  }
  return [...byVideoId.values()];
}

function normalizeMygitTodaySnapshotItem(item, context = {}) {
  const videoId = String(item?.videoId || extractVideoIdFromWatchUrl(item?.watchUrl) || "").trim();
  const title = normalizeWhitespace(item?.title || "");
  if (!isValidVideoId(videoId) || !title) return null;
  const keyword = normalizeWhitespace(item.keyword || context.keyword || "");
  const keywordKey = normalizeWhitespace(item.keywordKey || keyword || MYGIT_TODAY_SNAPSHOT_KEYWORD_KEY);
  const publishedTimestamp = finiteTimestamp(item.publishedTimestamp);
  const channelName = normalizeWhitespace(item.channelName || "");
  const sourceUrls = uniqueValues([context.snapshotUrl, item.sourceUrl, item.watchUrl]);
  return {
    videoId,
    title,
    channelName,
    channelId: normalizeWhitespace(item.channelId || ""),
    channelHandle: normalizeChannelHandle(item.channelHandle || item.channelUrl || ""),
    keyword: keyword || MYGIT_TODAY_SNAPSHOT_KEYWORD,
    keywords: uniqueValues([keyword, MYGIT_TODAY_SNAPSHOT_KEYWORD]),
    keywordKeys: uniqueValues([keywordKey, MYGIT_TODAY_SNAPSHOT_KEYWORD_KEY]),
    sourceGroup: MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP,
    sourceGroups: [MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP],
    sourceUrls,
    sourceUrl: context.snapshotUrl || item.sourceUrl || item.watchUrl || "",
    publishedText: item.publishedText || "",
    publishedTimestamp,
    durationText: item.durationText || "",
    thumbnailUrl: item.thumbnailUrl || "",
    viewText: item.viewText || "",
    statusText: item.statusText || "",
    snapshotId: context.snapshotId || "",
    snapshotCapturedAt: context.capturedAt || "",
  };
}

function upsertMygitSnapshotCandidate(byVideoId, item) {
  const existing = byVideoId.get(item.videoId);
  if (!existing) {
    byVideoId.set(item.videoId, { ...item });
    return;
  }
  existing.keywords = uniqueValues([...listValues(existing.keywords), existing.keyword, ...listValues(item.keywords), item.keyword]);
  existing.keywordKeys = uniqueValues([...listValues(existing.keywordKeys), ...listValues(item.keywordKeys)]);
  existing.sourceGroups = uniqueValues([...listValues(existing.sourceGroups), ...listValues(item.sourceGroups), item.sourceGroup]);
  existing.sourceUrls = uniqueValues([...listValues(existing.sourceUrls), ...listValues(item.sourceUrls), item.sourceUrl]);
  if (!existing.publishedTimestamp && item.publishedTimestamp) existing.publishedTimestamp = item.publishedTimestamp;
  if (!existing.publishedText && item.publishedText) existing.publishedText = item.publishedText;
  if (!existing.durationText && item.durationText) existing.durationText = item.durationText;
  if (!existing.thumbnailUrl && item.thumbnailUrl) existing.thumbnailUrl = item.thumbnailUrl;
  if (!existing.viewText && item.viewText) existing.viewText = item.viewText;
  if (!existing.channelName && item.channelName) existing.channelName = item.channelName;
  if (!existing.channelId && item.channelId) existing.channelId = item.channelId;
  existing.channelHandle = mergedChannelHandle(existing.channelHandle, item.channelHandle || item.channelUrl);
  if (!existing.snapshotId && item.snapshotId) existing.snapshotId = item.snapshotId;
}

function createMygitSnapshotImportState() {
  return {
    schemaVersion: 1,
    importedSnapshotIds: [],
    nextCursor: "",
    lastSuccessfulAt: "",
    failedSnapshots: [],
    importedVideoCount: 0,
  };
}

function loadMygitSnapshotImportState(filePath = MYGIT_TODAY_SNAPSHOT_STATE_PATH) {
  const state = readJsonIfExists(filePath) || createMygitSnapshotImportState();
  return {
    schemaVersion: 1,
    importedSnapshotIds: uniqueValues(listValues(state.importedSnapshotIds)),
    nextCursor: normalizeWhitespace(state.nextCursor || ""),
    lastSuccessfulAt: normalizeWhitespace(state.lastSuccessfulAt || ""),
    failedSnapshots: listValues(state.failedSnapshots).slice(0, 100),
    importedVideoCount: nonNegativeInteger(state.importedVideoCount, 0),
  };
}

function updateMygitSnapshotImportState(state, update) {
  const importedSnapshotIds = new Set(listValues(state.importedSnapshotIds));
  for (const snapshotId of update.fetchedSnapshotIds || []) importedSnapshotIds.add(snapshotId);
  const selectedIds = listValues(update.selectedEntries).map((entry) => entry?.id || entry?.file || entry?.path).filter(Boolean);
  const nextCursor = selectedIds.find((id) => !importedSnapshotIds.has(id)) || selectedIds.at(-1) || state.nextCursor || "";
  const failures = [
    ...listValues(update.snapshotErrors).map((error) => ({
      at: update.attemptedAt || new Date().toISOString(),
      snapshotId: error.snapshotId || "",
      path: error.path || "",
      message: error.message || String(error),
    })),
    ...listValues(state.failedSnapshots),
  ].slice(0, 100);
  return {
    schemaVersion: 1,
    importedSnapshotIds: [...importedSnapshotIds].sort(),
    nextCursor,
    lastSuccessfulAt: update.status === "success" || update.status === "partial" ? update.attemptedAt || new Date().toISOString() : state.lastSuccessfulAt || "",
    failedSnapshots: failures,
    importedVideoCount: nonNegativeInteger(state.importedVideoCount, 0) + nonNegativeInteger(update.itemCount, 0),
  };
}

function writeMygitSnapshotImportState(filePath, state) {
  writeJson(filePath, state);
}

function addSearchItems(target, items) {
  target.push(...items.filter((item) => item.videoId && item.title && !isBlockedSource(item)));
}

function mergeCandidate(byVideoId, item, search, nowMs) {
  if (isBlockedSource(item)) return;
  const publishedTimestamp = finiteTimestamp(item.publishedTimestamp) || parsePublishedTimestamp(item.publishedText, nowMs);
  const keywords = uniqueValues([...listValues(item.keywords), item.keyword, search.keyword]);
  const keywordKeys = uniqueValues([...listValues(item.keywordKeys), item.keywordKey, search.keywordKey]);
  const sourceGroups = uniqueValues([...listValues(item.sourceGroups), item.sourceGroup, search.sourceGroup]);
  const sourceUrls = uniqueValues([...listValues(item.sourceUrls), item.sourceUrl, search.url]);
  const existing = byVideoId.get(item.videoId);
  if (!existing) {
    byVideoId.set(item.videoId, {
      ...item,
      channelHandle: normalizeChannelHandle(item.channelHandle || item.channelUrl || ""),
      keyword: item.keyword || search.keyword,
      keywords,
      keywordKeys,
      sourceGroup: item.sourceGroup || search.sourceGroup,
      sourceGroups,
      sourceUrls,
      publishedTimestamp,
    });
    return;
  }

  for (const keyword of keywords) addUnique(existing.keywords, keyword);
  for (const keywordKey of keywordKeys) addUnique(existing.keywordKeys, keywordKey);
  for (const sourceGroup of sourceGroups) addUnique(existing.sourceGroups, sourceGroup);
  for (const sourceUrl of sourceUrls) addUnique(existing.sourceUrls, sourceUrl);
  if (!existing.publishedTimestamp && publishedTimestamp) existing.publishedTimestamp = publishedTimestamp;
  if (!existing.publishedText && item.publishedText) existing.publishedText = item.publishedText;
  if (!existing.durationText && item.durationText) existing.durationText = item.durationText;
  if (!existing.thumbnailUrl && item.thumbnailUrl) existing.thumbnailUrl = item.thumbnailUrl;
  if (!existing.viewText && item.viewText) existing.viewText = item.viewText;
  if (!existing.channelName && item.channelName) existing.channelName = item.channelName;
  if (!existing.channelId && item.channelId) existing.channelId = item.channelId;
  existing.channelHandle = mergedChannelHandle(existing.channelHandle, item.channelHandle || item.channelUrl);
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function candidateSort(a, b) {
  const timeDiff = (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0);
  if (timeDiff) return timeDiff;
  const aIsRecent = a.sourceGroups?.includes("today") ? 1 : 0;
  const bIsRecent = b.sourceGroups?.includes("today") ? 1 : 0;
  if (aIsRecent !== bIsRecent) return bIsRecent - aIsRecent;
  return (b.sourceGroups?.length || 0) - (a.sourceGroups?.length || 0);
}

function collectCarryForwardVideos(previousPayload, previousAudit, now, options = {}) {
  const nowMs = now.getTime();
  const counts = { h72: 0, month: 0 };
  const inspectionCacheSkipIds = collectInspectionCacheSkipIds(options.inspectionCache, nowMs);
  for (const videoId of options.forceRefreshVideoIds || []) inspectionCacheSkipIds.delete(videoId);
  const empty = (reason, from = "", ageHours = null) => ({
    enabled: false,
    reason,
    from,
    ageHours,
    videos: [],
    counts,
    skipVideoIds: new Set(inspectionCacheSkipIds),
    inspectionCacheSkipCount: inspectionCacheSkipIds.size,
  });

  if (!previousPayload?.groups) return empty("no_previous_latest");
  const from = previousPayload.generatedAt || previousPayload.capturedAt || "";
  const previousMs = Date.parse(from);
  if (!Number.isFinite(previousMs)) return empty("invalid_previous_timestamp", from);
  const ageHours = roundNumber((nowMs - previousMs) / (60 * 60 * 1000), 2);
  if (ageHours < 0) return empty("previous_timestamp_in_future", from, ageHours);
  if (ageHours > CARRY_FORWARD_MAX_AGE_HOURS) return empty("previous_latest_too_old", from, ageHours);

  const videos = new Map();
  for (const item of rangeItems(previousPayload, "7d")) {
    if (isBlockedSource(item)) continue;
    if (!isWithinAgeWindow(item.publishedTimestamp, nowMs, RECENT_WINDOW_MS)) continue;
    if (upsertCarriedVideo(videos, item, ["today"], from)) counts.h72 += 1;
  }
  for (const item of rangeItems(previousPayload, "all")) {
    if (isBlockedSource(item)) continue;
    if (upsertCarriedVideo(videos, item, ["month"], from)) counts.month += 1;
  }

  if (!videos.size) return empty("no_carryable_previous_videos", from, ageHours);
  const skipVideoIds = new Set(
    [...videos.values()]
      .filter((video) => !video.needsRefreshFromDirtyCarryForward && !video.needsMetadataRefresh)
      .map((video) => video.videoId),
  );
  addKnownAuditSkipIds(skipVideoIds, previousAudit);
  for (const videoId of inspectionCacheSkipIds) skipVideoIds.add(videoId);
  for (const video of videos.values()) {
    if (video.needsMetadataRefresh) skipVideoIds.delete(video.videoId);
  }
  for (const videoId of options.forceRefreshVideoIds || []) skipVideoIds.delete(videoId);
  return {
    enabled: true,
    reason: "previous_latest_fresh",
    from,
    ageHours,
    videos: [...videos.values()],
    counts,
    skipVideoIds,
    inspectionCacheSkipCount: inspectionCacheSkipIds.size,
  };
}

function rangeItems(payload, rangeId) {
  const group = groupForRange(payload?.groups, rangeId);
  return Array.isArray(group?.items) ? group.items : [];
}

function upsertCarriedVideo(videos, item, sourceGroups, from) {
  const carried = normalizeCarryForwardItem(item, sourceGroups, from);
  if (!carried) return false;
  const existing = videos.get(carried.videoId);
  if (!existing) {
    videos.set(carried.videoId, carried);
    return true;
  }
  mergeVideoMetadata(existing, carried);
  return true;
}

function normalizeCarryForwardItem(item, sourceGroups, from) {
  if (!isValidVideoId(item?.videoId)) return null;
  const originalSongs = item.songs || [];
  const sourceContext = { candidate: item, sourceRecord: item, source: item };
  const normalizedSongs = originalSongs
    .map(normalizeParsedSong)
    .map((song) => normalizeSourceAwareArtist(repairParsedEntry(song), sourceContext))
    .filter(isValidSong)
    .filter((song) => !isLikelyNonSongEntry(song, sourceContext))
    .filter((song) => !isActivityMarkerTitle(song.title, song.artist));
  const { songs } = filterArtistRichMixedSourceSongs(normalizedSongs);
  if (!songs.length) return null;
  const needsRefreshFromDirtyCarryForward = hasDirtyCarriedSongs(originalSongs, songs);
  const publishedTimestamp = finiteTimestamp(item.publishedTimestamp);
  const mergedSourceGroups = uniqueValues([...listValues(item.sourceGroups), item.sourceGroup, ...sourceGroups]);
  return {
    ...item,
    songs,
    publishedTimestamp,
    sourceGroups: mergedSourceGroups,
    carriedFromPrevious: true,
    carriedFromSnapshot: from,
    needsRefreshFromDirtyCarryForward,
    needsMetadataRefresh: !publishedTimestamp,
  };
}

function hasDirtyCarriedSongs(originalSongs, normalizedSongs) {
  if (originalSongs.length !== normalizedSongs.length) return true;
  for (let index = 0; index < originalSongs.length; index += 1) {
    const original = originalSongs[index] || {};
    const normalized = normalizedSongs[index] || {};
    if (original.title !== normalized.title || (original.artist || "未記載") !== normalized.artist) return true;
  }
  return false;
}

function addKnownAuditSkipIds(skipVideoIds, previousAudit) {
  for (const audit of previousAudit?.videos || []) {
    if (!isValidVideoId(audit.videoId) || audit.result !== "selected") continue;
    skipVideoIds.add(audit.videoId);
  }
}

function collectInspectionCacheSkipIds(cache, nowMs) {
  const skipVideoIds = new Set();
  const retentionMs = INSPECTION_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const fetchErrorTtlMs = INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS * 60 * 60 * 1000;
  const noUsableMinAgeMs = INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS * 60 * 60 * 1000;
  for (const item of listValues(cache?.videos)) {
    if (!isValidVideoId(item?.videoId)) continue;
    const inspectedMs = Date.parse(item.lastInspectedAt || item.updatedAt || item.firstInspectedAt || "");
    if (!Number.isFinite(inspectedMs)) continue;
    const ageMs = nowMs - inspectedMs;
    if (ageMs < 0) continue;
    const publishedTimestamp = finiteTimestamp(item.publishedTimestamp);
    const videoAgeMs = Number.isFinite(publishedTimestamp) ? nowMs - publishedTimestamp : null;
    if (isAgedNegativeInspectionResult(item.result) && ageMs <= retentionMs && videoAgeMs !== null && videoAgeMs >= noUsableMinAgeMs) {
      skipVideoIds.add(item.videoId);
    } else if (item.result === "fetch_error" && ageMs <= fetchErrorTtlMs) {
      skipVideoIds.add(item.videoId);
    }
  }
  return skipVideoIds;
}

function isAgedNegativeInspectionResult(result) {
  return result === "no_usable_song_source" || result === "no_timestamp_candidates";
}

function mergeInspectionCache(previousCache, audits, capturedAt) {
  const capturedAtIso = capturedAt.toISOString();
  const cutoffMs = capturedAt.getTime() - INSPECTION_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const fetchErrorCutoffMs = capturedAt.getTime() - INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS * 60 * 60 * 1000;
  const byVideoId = new Map();
  for (const item of listValues(previousCache?.videos)) {
    if (!isRetainedInspectionCacheItem(item, cutoffMs, fetchErrorCutoffMs)) continue;
    byVideoId.set(item.videoId, { ...item });
  }
  let updatedVideoCount = 0;
  for (const audit of audits || []) {
    if (!isValidVideoId(audit?.videoId)) continue;
    updatedVideoCount += 1;
    const existing = byVideoId.get(audit.videoId);
    if (audit.result === "selected") {
      byVideoId.delete(audit.videoId);
      continue;
    }
    byVideoId.set(audit.videoId, {
      videoId: audit.videoId,
      title: audit.title || existing?.title || "",
      channelName: audit.channelName || existing?.channelName || "",
      publishedText: audit.publishedText || existing?.publishedText || "",
      publishedTimestamp: finiteTimestamp(audit.publishedTimestamp) || finiteTimestamp(existing?.publishedTimestamp) || null,
      durationText: audit.durationText || existing?.durationText || "",
      result: audit.result || existing?.result || "unknown",
      firstInspectedAt: existing?.firstInspectedAt || capturedAtIso,
      lastInspectedAt: capturedAtIso,
      attemptCount: (existing?.attemptCount || 0) + 1,
      rejectedEntryCount: audit.rejectedEntryCount || 0,
      rejectedSourceCount: audit.rejectedSourceCount || 0,
      acceptedSourceCount: audit.acceptedSourceCount || 0,
      selectedSongCount: audit.selectedSongCount || 0,
    });
  }
  const videos = [...byVideoId.values()].filter((item) => isRetainedInspectionCacheItem(item, cutoffMs, fetchErrorCutoffMs)).sort((a, b) => {
    const timeDiff = Date.parse(b.lastInspectedAt || "") - Date.parse(a.lastInspectedAt || "");
    if (Number.isFinite(timeDiff) && timeDiff) return timeDiff;
    return String(a.videoId).localeCompare(String(b.videoId));
  });
  return {
    cache: {
      schemaVersion: 1,
      generatedAt: capturedAtIso,
      retentionDays: INSPECTION_CACHE_RETENTION_DAYS,
      fetchErrorTtlHours: INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS,
      noUsableMinAgeHours: INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS,
      videos,
    },
    stats: {
      videoCount: videos.length,
      retainedVideoCount: byVideoId.size,
      updatedVideoCount,
    },
  };
}

function isRetainedInspectionCacheItem(item, cutoffMs, fetchErrorCutoffMs) {
  if (!isValidVideoId(item?.videoId)) return false;
  const lastInspectedMs = Date.parse(item.lastInspectedAt || item.updatedAt || item.firstInspectedAt || "");
  if (!Number.isFinite(lastInspectedMs)) return false;
  if (item.result === "selected") return false;
  if (item.result === "fetch_error") return lastInspectedMs >= fetchErrorCutoffMs;
  return lastInspectedMs >= cutoffMs;
}

function mergeFetchedAndCarriedVideos(fetchedVideos, carriedVideos) {
  const byVideoId = new Map();
  for (const video of filterBlockedVideos(fetchedVideos)) {
    if (!isValidVideoId(video.videoId)) continue;
    byVideoId.set(video.videoId, video);
  }
  for (const carried of filterBlockedVideos(carriedVideos)) {
    const existing = byVideoId.get(carried.videoId);
    if (existing) {
      mergeVideoMetadata(existing, carried);
      continue;
    }
    byVideoId.set(carried.videoId, { ...carried, channelHandle: normalizeChannelHandle(carried.channelHandle || carried.channelUrl || "") });
  }
  return [...byVideoId.values()];
}

function mergeVideoMetadata(target, source) {
  target.sourceGroups = uniqueValues([...listValues(target.sourceGroups), target.sourceGroup, ...listValues(source.sourceGroups), source.sourceGroup]);
  target.sourceUrls = uniqueValues([...listValues(target.sourceUrls), ...listValues(source.sourceUrls)]);
  target.keywords = uniqueValues([...listValues(target.keywords), ...listValues(source.keywords)]);
  target.keywordKeys = uniqueValues([...listValues(target.keywordKeys), ...listValues(source.keywordKeys)]);
  if (!target.publishedTimestamp && source.publishedTimestamp) target.publishedTimestamp = source.publishedTimestamp;
  if (!target.publishedText && source.publishedText) target.publishedText = source.publishedText;
  if (!target.thumbnailUrl && source.thumbnailUrl) target.thumbnailUrl = source.thumbnailUrl;
  if (!target.durationText && source.durationText) target.durationText = source.durationText;
  if (!target.channelName && source.channelName) target.channelName = source.channelName;
  if (!target.channelId && source.channelId) target.channelId = source.channelId;
  if (!target.channelUrl && source.channelUrl) target.channelUrl = source.channelUrl;
  target.channelHandle = mergedChannelHandle(target.channelHandle, source.channelHandle || source.channelUrl);
}

function selectCandidatesForInspection(candidates, now, options = {}) {
  const nowMs = now.getTime();
  const carryForwardEnabled = Boolean(options.carryForwardEnabled);
  const excludeVideoIds = options.excludeVideoIds || new Set();
  const recentScanHorizonMs = RECENT_WINDOW_MS;
  const carriedMonthVideoCount = Number(options.carriedMonthVideoCount);
  const monthBackfillEnabled =
    carryForwardEnabled && Number.isFinite(carriedMonthVideoCount) && carriedMonthVideoCount < MONTH_BACKFILL_TARGET;
  const bucketDefinitions = recentBuckets(nowMs, recentScanHorizonMs);
  const monthRefreshReserveLimit = carryForwardEnabled && !monthBackfillEnabled ? Math.min(MONTH_REFRESH_LIMIT, VIDEO_LIMIT) : 0;
  const reservedRecentBucketLimit = Math.max(
    1,
    Math.floor((VIDEO_LIMIT - monthRefreshReserveLimit) / Math.max(1, bucketDefinitions.length)),
  );
  const recentBucketLimit = monthBackfillEnabled
    ? Math.min(RECENT_BUCKET_LIMIT, MONTH_BACKFILL_RECENT_BUCKET_LIMIT)
    : carryForwardEnabled
      ? Math.min(RECENT_BUCKET_LIMIT, reservedRecentBucketLimit)
      : RECENT_BUCKET_LIMIT;
  let skippedBlacklistedCandidateCount = 0;
  let skippedKnownCandidateCount = 0;
  const sourceAllowedCandidates = candidates.filter((item) => {
    if (!isBlockedSource(item)) return true;
    skippedBlacklistedCandidateCount += 1;
    return false;
  });
  const availableCandidates = sourceAllowedCandidates.filter((item) => {
    if (!excludeVideoIds.has(item.videoId)) return true;
    skippedKnownCandidateCount += 1;
    return false;
  });
  const selected = [];
  const seen = new Set();
  const bucketCounts = new Map();
  const add = (items, limit) => {
    let addedFromThisCall = 0;
    for (const item of items) {
      if (selected.length >= VIDEO_LIMIT || seen.has(item.videoId)) continue;
      if (limit != null && item.__bucket) {
        const bucketCount = bucketCounts.get(item.__bucket) || 0;
        if (bucketCount >= limit) continue;
        bucketCounts.set(item.__bucket, bucketCount + 1);
      } else if (limit != null && addedFromThisCall >= limit) {
        continue;
      }
      seen.add(item.videoId);
      selected.push(item);
      addedFromThisCall += 1;
    }
  };

  for (const bucket of bucketDefinitions) {
    const bucketItems = availableCandidates
      .filter((item) => item.publishedTimestamp && item.publishedTimestamp >= bucket.from && item.publishedTimestamp < bucket.to)
      .map((item) => ({ ...item, __bucket: bucket.id }))
      .sort(candidateSort);
    add(bucketItems, recentBucketLimit);
  }

  const recentCandidates = availableCandidates
    .filter((item) => item.publishedTimestamp && nowMs - item.publishedTimestamp >= 0 && nowMs - item.publishedTimestamp <= recentScanHorizonMs)
    .sort(candidateSort);

  const monthCandidates = availableCandidates.filter((item) => hasMonthlyDiscoverySource(item)).sort(candidateSort);
  if (monthBackfillEnabled) {
    add(monthCandidates, null);
    add(recentCandidates, null);
  } else {
    if (carryForwardEnabled) add(monthCandidates, MONTH_REFRESH_LIMIT);
    add(recentCandidates, null);
    if (!carryForwardEnabled) add(monthCandidates, null);
    if (!carryForwardEnabled) add(availableCandidates, null);
  }

  return {
    items: selected.map(({ __bucket, ...item }) => item),
    mode: monthBackfillEnabled
      ? "incremental_month_backfill_with_carry_forward"
      : carryForwardEnabled
        ? "incremental_7d_with_carry_forward"
        : "full_7d_recovery",
    recentScanHorizonHours: Math.round(recentScanHorizonMs / (60 * 60 * 1000)),
    monthBackfillEnabled,
    monthBackfillTarget: MONTH_BACKFILL_TARGET,
    monthBackfillRecentBucketLimit: recentBucketLimit,
    monthRefreshReserveLimit,
    skippedBlacklistedCandidateCount,
    skippedKnownCandidateCount,
  };
}

function recentBuckets(nowMs, horizonMs = RECENT_WINDOW_MS) {
  const cutoff = nowMs - horizonMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const dayCount = Math.max(1, Math.ceil(horizonMs / dayMs));
  const buckets = Array.from({ length: dayCount }, (_, index) => {
    const to = index === 0 ? nowMs + 1 : nowMs - index * dayMs;
    const from = Math.max(cutoff, nowMs - (index + 1) * dayMs);
    return {
      id: recentBucketId(index),
      from,
      to,
    };
  });
  return buckets.filter((bucket) => bucket.to > cutoff);
}

function recentBucketId(index) {
  if (index === 0) return "today";
  if (index === 1) return "one_day_ago";
  if (index === 2) return "two_days_ago";
  return `${index}_days_ago`;
}

async function inspectCandidates(candidates, curationContext = loadCurationContext()) {
  const results = new Array(candidates.length);
  let nextIndex = 0;
  const workerCount = Math.min(VIDEO_CONCURRENCY, Math.max(1, candidates.length));
  async function worker() {
    while (nextIndex < candidates.length && !requestLimiter.shouldStop()) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      try {
        const result = await fetchVideoSongList(candidate, curationContext);
        const detail = result?.detail || null;
        results[index] = {
          inspected: { videoId: candidate.videoId, ok: Boolean(detail), songCount: detail?.songs.length || 0 },
          detail,
          audit: result?.audit || null,
        };
        console.log(`[update] ${index + 1}/${candidates.length} ${candidate.videoId} songs=${detail?.songs.length || 0} ${candidate.title}`);
      } catch (error) {
        results[index] = {
          inspected: { videoId: candidate.videoId, ok: false, error: error.message },
          detail: null,
          audit: {
            videoId: candidate.videoId,
            title: candidate.title,
            channelName: candidate.channelName,
            keyword: candidate.keyword,
            keywords: candidate.keywords || [],
            sourceGroups: candidate.sourceGroups || [],
            publishedText: candidate.publishedText || "",
            publishedTimestamp: candidate.publishedTimestamp || null,
            durationText: candidate.durationText || "",
            result: "fetch_error",
            error: error.message,
            sources: [],
          },
        };
        console.warn(`[update] ${index + 1}/${candidates.length} skip ${candidate.videoId}: ${error.message}`);
        if (error instanceof RateLimitAbortError || requestLimiter.shouldStop()) break;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    inspected: results.map((result) => result.inspected).filter(Boolean),
    videos: results.map((result) => result.detail).filter(Boolean),
    audits: results.map((result) => result.audit).filter(Boolean),
  };
}

async function fetchVideoSongList(candidate, curationContext = loadCurationContext()) {
  curationContext = ensureInspectionContext(curationContext);
  const html = await fetchText(`https://www.youtube.com/watch?v=${candidate.videoId}&hl=ja&persist_hl=1`);
  candidate = mergeCandidateWithWatchMetadata(candidate, extractWatchVideoMetadata(html));
  const apiKey = extractRegex(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientVersion = extractRegex(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || "2.20260601.00.00";
  const initialData = extractJsonAfter(html, "ytInitialData");
  const comments = extractDescriptionCandidates(initialData).map((text, index) =>
    createSourceRecord({ videoId: candidate.videoId, sourceType: "description", text, index }),
  );
  const titleKnownSongSource = createVideoTitleKnownSongSourceRecord(candidate, curationContext);
  if (titleKnownSongSource) comments.push(titleKnownSongSource);
  const continuation = findCommentsContinuation(initialData);
  if (apiKey && continuation) {
    const response = await fetchYouTubeContinuation(apiKey, clientVersion, continuation);
    comments.push(...extractCommentTexts(response, "comment", candidate.videoId));
    comments.push(...(await fetchCommentReplyTexts(apiKey, clientVersion, response, REPLY_LIMIT, candidate.videoId)));
  }

  const audit = {
    videoId: candidate.videoId,
    title: candidate.title,
    channelName: candidate.channelName,
    keyword: candidate.keyword,
    keywords: candidate.keywords,
    sourceGroups: candidate.sourceGroups,
    publishedText: candidate.publishedText,
    publishedTimestamp: candidate.publishedTimestamp || null,
    durationText: candidate.durationText,
    commentCandidateCount: comments.length,
    result: "no_timestamp_candidates",
    selectedSongCount: 0,
    acceptedSourceCount: 0,
    rejectedSourceCount: 0,
    rejectedEntryCount: 0,
    sources: [],
  };
  const sources = [];
  const rejectedSources = [];
  for (const sourceRecord of comments) {
    const { text } = sourceRecord;
    const rejectedEntries = [];
    const songs = parseTimestampSongs([text], {
      onReject: (entry) => rejectedEntries.push(compactRejectedEntry(entry)),
    });
    if (!songs.length && !rejectedEntries.length) continue;
    const source = buildSongSource(songs, rejectedEntries, sourceRecord, candidate, curationContext);
    audit.sources.push(source.summary);
    audit.rejectedEntryCount += source.summary.rejectedEntryCount;
    if (source.rejected) {
      rejectedSources.push(source.summary);
      continue;
    }
    sources.push(source);
  }
  const selected = selectBestSongs(withMergedOrderedSource(sources));
  audit.acceptedSourceCount = sources.length;
  audit.rejectedSourceCount = rejectedSources.length;
  audit.result = selected.length ? "selected" : audit.sources.length ? "no_usable_song_source" : audit.result;
  audit.selectedSongCount = selected.length;
  const selectedSourceId = selected.sourceQuality?.sourceId || "";
  const selectedSourceHash = selected.sourceQuality?.sourceHash || "";
  for (const source of audit.sources) {
    source.selected = Boolean(
      (selectedSourceId && source.sourceId === selectedSourceId) || (selectedSourceHash && source.sourceHash === selectedSourceHash),
    );
  }
  if (!selected.length) return { detail: null, audit };

  return {
    detail: {
      videoId: candidate.videoId,
      title: candidate.title,
      channelName: candidate.channelName,
      channelId: candidate.channelId || "",
      channelHandle: candidate.channelHandle || "",
      keyword: candidate.keyword,
      keywords: candidate.keywords || [candidate.keyword].filter(Boolean),
      sourceGroups: candidate.sourceGroups || [candidate.sourceGroup].filter(Boolean),
      sourceUrls: candidate.sourceUrls || [],
      publishedText: candidate.publishedText,
      publishedTimestamp: candidate.publishedTimestamp || null,
      durationText: candidate.durationText,
      thumbnailUrl: candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
      sourceCount: sources.length,
      rejectedSourceCount: rejectedSources.length,
      rejectedSources: rejectedSources.slice(0, 5),
      rejectedEntryCount: audit.rejectedEntryCount,
      sourceQuality: selected.sourceQuality || null,
      selectedSourceId,
      selectedSourceHash,
      songs: selected.map(normalizeParsedSong).map((song, index) => ({
        index: index + 1,
        time: song.time,
        seconds: song.seconds,
        title: song.title,
        artist: displayArtist(song.artist),
        raw: song.raw,
        rawHash: song.rawHash || hashNormalizedText(song.raw || ""),
        sourceId: song.sourceId || selectedSourceId,
        sourceHash: song.sourceHash || selectedSourceHash,
        ...(selected.sourceQuality?.singleSongIdentification
          ? {
              identificationSource: selected.sourceQuality.singleSongIdentification.identificationSource,
              confidence: selected.sourceQuality.singleSongIdentification.confidence,
              identificationReason: selected.sourceQuality.singleSongIdentification.reason,
              rawVideoTitle: selected.sourceQuality.singleSongIdentification.rawVideoTitle || "",
              matchedKnownSong: selected.sourceQuality.singleSongIdentification.matchedKnownSong || "",
              matchedArtist: selected.sourceQuality.singleSongIdentification.matchedArtist || "",
            }
          : {}),
      })),
    },
    audit,
  };
}

function mergeCandidateWithWatchMetadata(candidate, metadata = {}) {
  return {
    ...candidate,
    channelName: candidate.channelName || metadata.channelName || "",
    channelId: candidate.channelId || metadata.channelId || "",
    channelHandle: normalizeChannelHandle(candidate.channelHandle) || metadata.channelHandle || "",
    channelUrl: candidate.channelUrl || metadata.channelUrl || "",
    publishedText: candidate.publishedText || metadata.publishedText || "",
    publishedTimestamp: finiteTimestamp(candidate.publishedTimestamp) || finiteTimestamp(metadata.publishedTimestamp) || null,
    thumbnailUrl: candidate.thumbnailUrl || metadata.thumbnailUrl || "",
  };
}

function extractWatchVideoMetadata(html) {
  const player = tryExtractJsonAfter(html, "ytInitialPlayerResponse");
  const videoDetails = player?.videoDetails || {};
  const microformat = player?.microformat?.playerMicroformatRenderer || {};
  const channelId = String(videoDetails.channelId || microformat.externalChannelId || "").trim();
  const channelUrl = String(microformat.ownerProfileUrl || (channelId ? `https://www.youtube.com/channel/${channelId}` : "")).trim();
  const publishedText = normalizeWhitespace(microformat.publishDate || microformat.uploadDate || "");
  const publishedTimestamp = finiteTimestamp(Date.parse(publishedText));
  return {
    channelName: normalizeWhitespace(microformat.ownerChannelName || videoDetails.author || ""),
    channelId,
    channelHandle: normalizeChannelHandle(channelUrl),
    channelUrl,
    publishedText,
    publishedTimestamp,
    thumbnailUrl: bestThumbnail(videoDetails.thumbnail || microformat.thumbnail),
  };
}

function buildSongSource(songs, rejectedEntries, sourceRecord, candidate, curationContext = loadCurationContext()) {
  const sourceText = sourceRecord.text || "";
  const sourceType = sourceRecord.sourceType || "unknown";
  const sourceId = sourceRecord.sourceId || "";
  const sourceHash = sourceRecord.sourceHash || hashNormalizedText(sourceText);
  const lookup = curationContext.songSearchLookup || null;
  const aliasContext = curationContext.songAliasContext || loadSongAliasContext();
  const sourceContext = { candidate, sourceRecord };
  const identifiedSongs = songs
    .map((song) => ({
      ...song,
      sourceId,
      sourceHash,
      sourceType,
      rawHash: hashNormalizedText(song.raw || `${song.time || ""} ${song.title || ""}`),
    }))
    .map((song) => canonicalizeSongIdentity(normalizeSourceAwareArtist(repairParsedEntry(song, lookup), sourceContext), aliasContext));
  const preSource = {
    sourceId,
    sourceHash,
    sourceType,
    songs: identifiedSongs,
    stats: { sourceType, keptCount: identifiedSongs.length },
  };
  const curatedSources = applyCurationToSources([preSource], curationContext, candidate);
  const curatedSongs = curatedSources[0]?.songs || [];
  const manuallyRejectedSource = !curatedSources.length && identifiedSongs.length > 0;
  const likelySongEntries = curatedSongs.filter((song) => song.forceKept || !isLikelyNonSongEntry(song, sourceContext));
  const curatedByRawHash = new Map(curatedSongs.map((song) => [song.rawHash, song]));
  const additionallyRejected = identifiedSongs
    .filter((song) => {
      const curated = curatedByRawHash.get(song.rawHash);
      return !curated || (!curated.forceKept && isLikelyNonSongEntry(song, sourceContext));
    })
    .map((song) =>
      compactRejectedEntry({
        reason: "source_level_likely_non_song_entry",
        line: song.raw,
        time: song.time,
        title: song.title,
        artist: song.artist,
      }),
    );
  const mixedSourceFilter = filterArtistRichMixedSourceSongs(likelySongEntries);
  const cleaned = mixedSourceFilter.songs;
  const allRejectedEntries = [...rejectedEntries, ...additionallyRejected, ...mixedSourceFilter.rejectedEntries];
  const stats = sourceStats(cleaned, songs, allRejectedEntries, sourceText, sourceType, sourceContext);
  stats.sourceId = sourceId;
  stats.sourceHash = sourceHash;
  const riskReasons = sourceRiskReasons({ songs: cleaned, stats });
  stats.riskReasons = riskReasons;
  stats.riskScore = riskScoreFromReasons(riskReasons, stats);
  stats.riskLevel = riskLevel(stats.riskScore);
  stats.singleSongIdentification = singleSongIdentification(stats, candidate, cleaned, sourceText, sourceContext);
  const rejectedReason = manuallyRejectedSource ? "manual_reject_source" : rejectedSongSourceReason(stats, candidate);
  const sourceTextIsNeeded = stats.riskScore > 0 || Boolean(rejectedReason) || stats.sourceType === "video_title" || Boolean(stats.singleSongIdentification);
  return {
    songs: cleaned,
    stats,
    rejected: Boolean(rejectedReason),
    rejectedReason,
    summary: {
      sourceId,
      sourceHash,
      sourceType,
      sourceIndex: sourceRecord.sourceIndex || 0,
      commentId: sourceRecord.commentId || "",
      authorName: sourceRecord.authorName || "",
      reason: rejectedReason,
      sourceScore: sourceScore({ songs: cleaned, stats }),
      riskScore: stats.riskScore,
      riskLevel: stats.riskLevel,
      riskReasons,
      singleSongIdentification: stats.singleSongIdentification,
      originalCount: stats.originalCount,
      keptCount: cleaned.length,
      knownSongCount: stats.knownSongCount,
      repairedKnownSongCount: stats.repairedKnownSongCount,
      artistCount: stats.artistCount,
      unknownArtistCount: stats.unknownArtistCount,
      activityMarkerCount: stats.activityMarkerCount,
      activityMarkerRatio: stats.activityMarkerRatio,
      conversationEntryCount: stats.conversationEntryCount,
      conversationRatio: stats.conversationRatio,
      parserCorruptionCount: stats.parserCorruptionCount,
      nicheCount: stats.nicheCount,
      nicheRatio: stats.nicheRatio,
      topicCount: stats.topicCount,
      structuralCount: stats.structuralCount,
      sentenceLikeCount: stats.sentenceLikeCount,
      sample: songs.slice(0, 8).map((song) => `${song.time} ${song.title}`),
      entries: cleaned.map(compactAcceptedEntry),
      rejectedEntryCount: allRejectedEntries.length,
      rejectedEntryReasons: countBy(allRejectedEntries, (entry) => entry.reason),
      rejectedSamples: allRejectedEntries.slice(0, 8),
      rejectedEntries: allRejectedEntries,
      ...(sourceTextIsNeeded ? { sourceText } : {}),
    },
  };
}

function filterArtistRichMixedSourceSongs(songs) {
  const entries = Array.isArray(songs) ? songs : [];
  const artistCount = entries.filter((song) => isUsableArtist(song.artist)).length;
  const titleOnlyCount = entries.length - artistCount;
  const artistRatio = entries.length ? artistCount / entries.length : 0;
  if (artistCount < 8 || titleOnlyCount < 2 || artistRatio < 0.35) {
    return { songs: entries, rejectedEntries: [] };
  }

  const kept = [];
  const rejectedEntries = [];
  for (const song of entries) {
    if (isUsableArtist(song.artist)) {
      kept.push(song);
      continue;
    }
    rejectedEntries.push(
      compactRejectedEntry({
        reason: "artist_rich_source_title_only_entry",
        line: song.raw,
        time: song.time,
        title: song.title,
        artist: song.artist,
      }),
    );
  }
  return { songs: kept, rejectedEntries };
}

function sourceStats(cleaned, original, rejectedEntries, sourceText, sourceType, sourceContext = {}) {
  const rawCount = original.length + rejectedEntries.length;
  const topicCount =
    original.filter((song) => isTopicLikeEntry(song, sourceContext)).length +
    rejectedEntries.filter((entry) => isTopicLikeEntry(entry, sourceContext)).length;
  const sentenceLikeCount = original.filter((song) => isSentenceLikeNoArtistEntry(song)).length;
  const artistCount = cleaned.filter((song) => isUsableArtist(song.artist)).length;
  const unknownArtistCount = cleaned.filter((song) => isUnknownArtist(song.artist)).length;
  const activityMarkerCount =
    cleaned.filter((song) => isCandidateActivityTitle(song.title)).length +
    rejectedEntries.filter((entry) => entry.reason === "activity_marker_title" || isCandidateActivityTitle(entry.title)).length;
  const conversationEntryCount =
    cleaned.filter((song) => isConversationEntry(song)).length +
    rejectedEntries.filter((entry) => entry.reason === "conversation_entry" || isConversationEntry(entry)).length;
  const parserCorruptionCount =
    cleaned.filter((song) => isParserCorruptionEntry(song)).length +
    rejectedEntries.filter((entry) => entry.reason === "parser_corruption" || isParserCorruptionEntry(entry)).length;
  const nicheCount = cleaned.filter((song) => song.isNiche === true).length;
  const knownSongCount = cleaned.filter((song) => isUsableArtist(song.artist) || song.isNiche === false).length;
  const repairedKnownSongCount = cleaned.filter((song) => song.repair?.knownTitle || song.repair?.knownTitleArtist).length;
  const structuralCount =
    original.filter((song) => hasSetlistStructure(song.raw)).length +
    rejectedEntries.filter((entry) => hasSetlistStructure(entry.line)).length;
  return {
    sourceType,
    originalCount: rawCount,
    keptCount: cleaned.length,
    knownSongCount,
    repairedKnownSongCount,
    artistCount,
    artistRatio: cleaned.length ? artistCount / cleaned.length : 0,
    unknownArtistCount,
    unknownArtistRatio: cleaned.length ? unknownArtistCount / cleaned.length : 0,
    activityMarkerCount,
    activityMarkerRatio: rawCount ? activityMarkerCount / rawCount : 0,
    conversationEntryCount,
    conversationRatio: rawCount ? conversationEntryCount / rawCount : 0,
    parserCorruptionCount,
    nicheCount,
    nicheRatio: cleaned.length ? nicheCount / cleaned.length : 0,
    topicCount,
    topicRatio: rawCount ? topicCount / rawCount : 0,
    sentenceLikeCount,
    sentenceLikeRatio: cleaned.length ? sentenceLikeCount / cleaned.length : 0,
    structuralCount,
    hasSetlistKeyword: /(?:セトリ|セットリスト|set\s*list|song\s*list|歌った曲|曲目|歌唱曲|タイムスタンプ|timestamps?)/iu.test(sourceText),
  };
}

function rejectedSongSourceReason(stats, candidate) {
  if (stats.keptCount <= 0) return "no_song_after_filter";
  if (stats.riskLevel === "high") return "high_risk_source";
  if (stats.keptCount < 2 && !stats.hasSetlistKeyword && !stats.singleSongIdentification) return "too_few_timestamp_songs";
  if (stats.originalCount >= 6 && stats.artistCount === 0 && stats.topicCount >= 2 && !stats.hasSetlistKeyword) {
    return "topic_timeline_without_artists";
  }
  if (stats.conversationEntryCount >= 3 && stats.conversationRatio >= 0.35 && stats.knownSongCount <= 2) {
    return "activity_session_timeline";
  }
  if (stats.parserCorruptionCount >= 2) {
    return "parser_corruption_source";
  }
  if (stats.originalCount >= 10 && stats.topicRatio >= 0.25 && stats.artistRatio < 0.25) {
    return "topic_heavy_low_artist_source";
  }
  if (stats.originalCount >= 8 && stats.artistCount === 0 && stats.structuralCount <= 1 && !stats.hasSetlistKeyword) {
    return "unstructured_title_only_timeline";
  }
  if (
    stats.originalCount >= 12 &&
    stats.artistRatio < 0.1 &&
    stats.sentenceLikeRatio >= 0.25 &&
    !stats.hasSetlistKeyword &&
    !isKnownNoArtistSongListTheme(candidate)
  ) {
    return "mixed_comment_timeline_low_song_density";
  }
  if (/音魂ヒビク|Hibiku Otodama/i.test(candidate.channelName || "") && stats.artistRatio < 0.4 && stats.topicCount > 0) {
    return "hibiku_topic_timeline_specialized_filter";
  }
  return "";
}

function singleSongIdentification(stats, candidate, songs, sourceText, sourceContext = {}) {
  if (stats.keptCount !== 1 || !Array.isArray(songs) || songs.length !== 1) return null;
  const song = songs[0];
  const title = normalizeWhitespace(song.title || "");
  if (!title || isLikelyNonSongEntry(song, sourceContext) || isCandidateActivityTitle(title, song.artist) || isConversationEntry(song)) return null;
  const titleCue = /(?:歌ってみた|歌いました|cover|covered|カバー|弾き語り|歌枠|karaoke|shorts?|short|歌唱|singing|song)/iu.test(
    `${candidate.title || ""} ${sourceText || ""}`,
  );
  const knownSong = song.isNiche === false || song.repair?.knownTitle || song.repair?.knownTitleArtist || stats.knownSongCount > 0;
  const hasReliableTimestamp = stats.structuralCount > 0 && Number.isInteger(song.seconds) && song.seconds >= 0;
  const hasArtist = isUsableArtist(song.artist);
  if (stats.sourceType === "video_title" && knownSong && hasArtist) {
    return {
      identificationSource: "video_title_known_song",
      confidence: 0.92,
      reason: "single_song_video_title",
      sourceHash: song.sourceHash || stats.sourceHash || "",
      sourceId: song.sourceId || stats.sourceId || "",
      rawVideoTitle: candidate.title || "",
      matchedKnownSong: title,
      matchedArtist: song.artist || "",
    };
  }
  if (hasReliableTimestamp && (knownSong || hasArtist || titleCue)) {
    return {
      identificationSource: "timestamp_comment",
      confidence: knownSong || hasArtist ? 0.86 : 0.72,
      reason: knownSong ? "timestamp_known_song" : hasArtist ? "timestamp_title_artist" : "timestamp_single_song_cue",
      sourceHash: song.sourceHash || stats.sourceHash || "",
      sourceId: song.sourceId || stats.sourceId || "",
      rawTitle: candidate.title || "",
      rawSourceText: truncateAuditText(sourceText || "", 240),
    };
  }
  if (titleCue && knownSong) {
    return {
      identificationSource: "video_title_known_song",
      confidence: 0.8,
      reason: "single_song_video_title",
      sourceHash: song.sourceHash || stats.sourceHash || "",
      sourceId: song.sourceId || stats.sourceId || "",
      rawTitle: candidate.title || "",
      rawSourceText: truncateAuditText(sourceText || "", 240),
    };
  }
  return null;
}

function ensureInspectionContext(context = loadCurationContext()) {
  return {
    ...context,
    songSearchLookup: context?.songSearchLookup || loadSongSearchLookup(),
    songAliasContext: context?.songAliasContext || loadSongAliasContext(),
  };
}

function createVideoTitleKnownSongSourceRecord(candidate, curationContext = loadCurationContext()) {
  if (!isHighConfidenceSingleSongVideoCandidate(candidate)) return null;
  const lookup = curationContext?.songSearchLookup || loadSongSearchLookup();
  const match = matchKnownTitleArtistFromVideoTitle(candidate?.title || "", lookup);
  if (!match) return null;
  return createSourceRecord({
    videoId: candidate.videoId,
    sourceType: "video_title",
    text: `0:00 ${match.title} / ${match.artist}`,
    index: -1,
  });
}

function matchKnownTitleArtistFromVideoTitle(title, lookupInput = null) {
  const lookup = lookupInput?.titleArtistKeys instanceof Set ? lookupInput : createSongSearchLookup(lookupInput || {});
  if (!lookup?.titleArtistKeys?.size) return null;
  const matches = new Map();
  for (const pair of titleArtistPairsFromVideoTitle(title)) {
    for (const candidate of [pair, { title: pair.artist, artist: pair.title }]) {
      const titleKey = normalizeSongSearchText(candidate.title);
      const artistKey = normalizeSongSearchText(candidate.artist);
      if (!titleKey || !artistKey) continue;
      const key = `${titleKey}::${artistKey}`;
      if (lookup.titleArtistKeys.has(key)) {
        matches.set(key, { title: cleanTitleKnownSongPart(candidate.title), artist: cleanTitleKnownSongPart(candidate.artist), key });
      }
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function titleArtistPairsFromVideoTitle(title) {
  const source = normalizeWhitespace(title).replace(/[\r\n]+/g, " ");
  const cleaned = cleanVideoTitleForSongMatch(source);
  const pairs = [];
  const quoted = source.match(/[「『｢【\["'“‘]\s*([^」』｣】\]"'”’]{2,60})\s*[」』｣】\]"'”’]\s*(?:by|\/|／|\||｜|-|－|ー|covered by)?\s*([^#【】「」『』\[\]\(\)（）]{2,60})/iu);
  if (quoted) pairs.push({ title: quoted[1], artist: quoted[2] });
  const parts = cleaned
    .split(/\s*(?:\/|／|\||｜| - | – | — |-|－)\s*/u)
    .map(cleanTitleKnownSongPart)
    .filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    pairs.push({ title: parts[index], artist: parts[index + 1] });
  }
  return pairs
    .map((pair) => ({ title: cleanTitleKnownSongPart(pair.title), artist: cleanTitleKnownSongPart(pair.artist) }))
    .filter((pair) => pair.title && pair.artist && pair.title !== pair.artist);
}

function cleanVideoTitleForSongMatch(title) {
  return normalizeWhitespace(title)
    .replace(/[【\[][^】\]]*(?:歌ってみた|歌いました|cover|covered|カバー|shorts?|short|singing|song)[^】\]]*[】\]]/giu, " ")
    .replace(/(?:#\S+|歌ってみた|歌いました|covered?\s*by|cover|カバー|shorts?|short|弾き語り|歌唱|singing|song|official|mv|music\s*video)/giu, " ");
}

function cleanTitleKnownSongPart(value) {
  return normalizeWhitespace(value)
    .replace(/[【\[\(（][^】\]\)）]*(?:歌ってみた|歌いました|cover|covered|カバー|shorts?|short|singing|song)[^】\]\)）]*[】\]\)）]/giu, " ")
    .replace(/(?:#\S+|covered?\s*by|cover|カバー|歌ってみた|歌いました|shorts?|short|弾き語り|歌唱|singing|song|official|mv|music\s*video)$/iu, "")
    .replace(/^[「『｢【\["'“‘]+|[」』｣】\]"'”’]+$/gu, "")
    .trim();
}

function isHighConfidenceSingleSongVideoCandidate(candidate) {
  const title = normalizeWhitespace(candidate?.title || "");
  if (!title) return false;
  const renderer = String(candidate?.sourceRendererType || "");
  const text = `${title} ${candidate?.keyword || ""}`;
  const hasSingleSongCue =
    /(?:歌ってみた|歌いました|cover|covered|カバー|弾き語り|歌唱|singing|song|#shorts|shorts?)/iu.test(text) ||
    renderer === "shortsLockupViewModel" ||
    renderer === "reelItemRenderer";
  if (!hasSingleSongCue) return false;
  if (/(?:歌枠|セトリ|セットリスト|歌った曲|曲目|雑談|トーク|配信|ライブ|耐久|メドレー|medley|mashup|同時視聴|切り抜き|clip|告知)/iu.test(title)) {
    return false;
  }
  return true;
}

function isKnownNoArtistSongListTheme(candidate) {
  return /(?:縛り|全曲|耐久|歌唱耐久|歌った曲|曲目|セトリ|セットリスト|リクエスト|\d+\s*回)/iu.test(
    `${candidate.title || ""} ${candidate.keyword || ""}`,
  );
}

function isTopicLikeEntry(song, sourceContext = {}) {
  return (
    isLikelyNonSongEntry(song, sourceContext) ||
    /(?:曲始まり|お話|話$|話①|話②|スケジュール|おすすめ|コメント|チャット|ギフト|設定|手癖|腰|良い音|到着|お土産|先生|予想|コンディション|休暇中|気圧|体調|動画|映画|クリップ|バランス|スパチャ読み|読み開始|告知|開始|終了|高評価|ch登録|チャンネル登録|登録者(?:数)?|視聴者|OBS)/iu.test(
      `${song.title || ""} ${song.raw || song.line || ""}`,
    )
  );
}

function isSentenceLikeNoArtistEntry(song) {
  if (isUsableArtist(song.artist)) return false;
  const title = String(song.title || "").trim();
  const raw = String(song.raw || song.line || "");
  if (!title) return false;
  return /(?:と思|だった|でした|です|ます|して|した|する|取る|開かない|気になる|喉|小皺|お年頃|水が|動き|ポーズ|マイク|スタンド|年齢|歳|歌録り|企画|ゲスト|登場|楽しい|どうだった|さみしく|歌いたい|聞ける|お祝い|憧れ|出てこいや|おかげ|機会|友情出演|公開|目標|リハ|テイク|ざぶぅん|イントロ|おめでとう|ズル|かわい|好き|おもろ|すぎ|くん|さん|ちゃん|笑|ww|ｗｗ|練習|告知|MV|グッズ|誕生日|手紙|最後まで|ありがとう|お疲れ|おつかれ)/iu.test(
    `${title} ${raw}`,
  );
}

function hasSetlistStructure(raw) {
  return /(?:^|[\s　])(?:#?\d{1,3}|[０-９]{1,3})[.)．、）:：]\s*\S/u.test(raw || "");
}

function compactRejectedEntry(entry) {
  return {
    reason: entry.reason || "unknown",
    time: entry.time || "",
    seconds: entry.time ? timeStringToSeconds(entry.time) : null,
    title: entry.title || entry.tail || "",
    artist: entry.artist || "",
    line: truncateAuditText(entry.line || entry.tail || "", 180),
    rawHash: hashNormalizedText(entry.line || entry.tail || ""),
  };
}

function compactAcceptedEntry(song) {
  return {
    status: "accepted",
    time: song.time || "",
    seconds: song.seconds,
    title: song.title || "",
    artist: song.artist || "",
    raw: song.raw || "",
    rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || ""} ${song.title || ""}`),
    sourceId: song.sourceId || "",
    sourceHash: song.sourceHash || "",
    riskReasons: sourceRiskReasons({ songs: [song], stats: { keptCount: 1, unknownArtistCount: isUnknownArtist(song.artist) ? 1 : 0 } }),
  };
}

function timeStringToSeconds(time) {
  const parts = String(time || "")
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function truncateAuditText(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function summarizeAudits(audits) {
  const summary = {
    inspectedVideos: audits.length,
    selectedVideos: audits.filter((audit) => audit.result === "selected").length,
    noUsableSongSourceVideos: audits.filter((audit) => audit.result === "no_usable_song_source").length,
    fetchErrorVideos: audits.filter((audit) => audit.result === "fetch_error").length,
    rejectedEntries: 0,
    rejectedSources: 0,
    acceptedSources: 0,
    rejectedEntryReasons: {},
    rejectedSourceReasons: {},
    topRejectedChannels: [],
  };
  const channels = new Map();
  for (const audit of audits) {
    summary.rejectedEntries += audit.rejectedEntryCount || 0;
    summary.rejectedSources += audit.rejectedSourceCount || 0;
    summary.acceptedSources += audit.acceptedSourceCount || 0;

    const channel = audit.channelName || "unknown";
    if (!channels.has(channel)) {
      channels.set(channel, {
        channelName: channel,
        videos: 0,
        selectedVideos: 0,
        rejectedEntries: 0,
        rejectedSources: 0,
        noUsableSongSourceVideos: 0,
        samples: [],
      });
    }
    const channelStats = channels.get(channel);
    channelStats.videos += 1;
    if (audit.result === "selected") channelStats.selectedVideos += 1;
    if (audit.result === "no_usable_song_source") channelStats.noUsableSongSourceVideos += 1;
    channelStats.rejectedEntries += audit.rejectedEntryCount || 0;
    channelStats.rejectedSources += audit.rejectedSourceCount || 0;

    for (const source of audit.sources || []) {
      if (source.reason) incrementPlainCount(summary.rejectedSourceReasons, source.reason);
      for (const [reason, count] of Object.entries(source.rejectedEntryReasons || {})) {
        incrementPlainCount(summary.rejectedEntryReasons, reason, count);
      }
      for (const sample of source.rejectedSamples || []) {
        if (channelStats.samples.length >= 3) break;
        channelStats.samples.push(`${sample.time} ${sample.title}`.trim());
      }
    }
  }
  summary.topRejectedChannels = [...channels.values()]
    .filter((entry) => entry.rejectedEntries || entry.rejectedSources || entry.noUsableSongSourceVideos)
    .sort(
      (a, b) =>
        b.rejectedEntries - a.rejectedEntries ||
        b.rejectedSources - a.rejectedSources ||
        b.noUsableSongSourceVideos - a.noUsableSongSourceVideos ||
        a.channelName.localeCompare(b.channelName, "ja"),
    )
    .slice(0, 12);
  return summary;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    incrementPlainCount(counts, key);
  }
  return counts;
}

function sumBy(items, valueFn) {
  return (items || []).reduce((sum, item) => sum + valueFn(item), 0);
}

function incrementPlainCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function buildGroups(videos, capturedAt) {
  const nowMs = capturedAt.getTime();
  const inRecentWindow = (item) =>
    Boolean(item.publishedTimestamp && nowMs - item.publishedTimestamp >= 0 && nowMs - item.publishedTimestamp <= RECENT_WINDOW_MS);
  const sortVideos = (items) =>
    [...items].sort((a, b) => {
      const timeDiff = (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0);
      if (timeDiff) return timeDiff;
      return b.songs.length - a.songs.length;
    });

  return {
    "7d": {
      id: "7d",
      title: RANGE_TITLES["7d"],
      windowDays: RECENT_WINDOW_DAYS,
      generatedAt: capturedAt.toISOString(),
      updatedAt: capturedAt.toISOString(),
      items: sortVideos(videos.filter((item) => inRecentWindow(item))),
    },
    all: {
      id: "all",
      title: RANGE_TITLES.all,
      retentionPolicy: "permanent",
      generatedAt: capturedAt.toISOString(),
      updatedAt: capturedAt.toISOString(),
      items: sortVideos(videos),
    },
  };
}

function hasMonthlySearchSource(item) {
  return listValues(item?.sourceUrls).some((url) => MONTH_SEARCH_URLS.has(url));
}

function hasMonthlyDiscoverySource(item) {
  return (
    hasMonthlySearchSource(item) ||
    item?.sourceGroup === MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP ||
    listValues(item?.sourceGroups).includes(MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP)
  );
}

function applyGroupQualityFilters(groups) {
  return Object.fromEntries(
    Object.entries(groups).map(([groupId, group]) => [
      groupId,
      {
        ...group,
        items: group.items
          .map((item) => applyItemSongQualityFilters(item))
          .filter((item) => !isLowQualitySelectedItem(item)),
      },
    ]),
  );
}

function applyItemSongQualityFilters(item) {
  const sourceContext = { candidate: item, sourceRecord: item, source: item };
  return {
    ...item,
    songs: (item.songs || [])
      .map(normalizeParsedSong)
      .map((song) => normalizeSourceAwareArtist(song, sourceContext))
      .filter((song) => !isLikelyNonSongEntry(song, sourceContext))
      .filter((song) => !isActivityMarkerTitle(song.title, song.artist))
      .filter((song) => !isConversationEntry(song)),
  };
}

function writeRankDiffFiles(payload, previousSnapshot = readPreviousSuccessfulSnapshot(payload), curationContext = null) {
  const diffs = buildRankDiffs(payload, previousSnapshot, curationContext);
  for (const range of DIFF_RANGES) {
    writeRuntimeJson(path.join(DIFF_DIR, range.file), compactRankDiff(diffs[range.id]));
  }
  if (diffs["7d"]) writeRuntimeJson(path.join(DIFF_DIR, "latest-72h.json"), { ...compactRankDiff(diffs["7d"]), range: "72h", aliasOf: "7d" });
  if (diffs.all) writeRuntimeJson(path.join(DIFF_DIR, "latest-1m.json"), { ...compactRankDiff(diffs.all), range: "1m", aliasOf: "all" });
  return diffs;
}

function buildRankDiffs(payload, previousSnapshot = null, curationContext = null) {
  const aliasContext = curationContext?.songAliasContext || loadSongAliasContext();
  const previousPayload = cleanSnapshotPayloadForCuration(previousSnapshotPayload(previousSnapshot), curationContext);
  const previous = previousSnapshotMetadata(previousSnapshot, curationContext);
  const current = currentSnapshotMetadata(payload, curationContext);
  return Object.fromEntries(
    DIFF_RANGES.map((range) => [
      range.id,
      buildRankDiffForRange({
        rangeId: range.id,
        current,
        previous,
        currentGroup: groupForRange(payload?.groups, range.id),
        previousGroup: groupForRange(previousPayload?.groups, range.id),
        aliasContext,
      }),
    ]),
  );
}

function buildRankDiffForRange({ rangeId, current, previous, currentGroup, previousGroup, aliasContext = null }) {
  return {
    schemaVersion: 1,
    generatedAt: current.generatedAt,
    capturedAt: current.capturedAt,
    range: rangeId,
    current,
    previous,
    songRank: buildRankDiffEntries(buildSongRankState(currentGroup, aliasContext), buildSongRankState(previousGroup, aliasContext)),
    artistRank: buildRankDiffEntries(buildArtistRankState(currentGroup), buildArtistRankState(previousGroup)),
  };
}

function buildSongRankState(group, aliasContext = null) {
  const records = buildSongRecords(canonicalizeSongOccurrences(collectSongOccurrences(group?.items || []), aliasContext)).sort(compareSongRankRecords);
  return buildRankState(records, (record) => record.title || record.key);
}

function buildArtistRankState(group) {
  const { records } = buildArtistRecords(collectSongOccurrences(group?.items || []));
  records.sort(compareCountRecords);
  return buildRankState(records, (record) => record.name || record.key);
}

function buildRankState(records, labelFn) {
  const ranks = buildCompetitionRanks(records);
  return new Map(
    records.map((record) => [
      record.key,
      {
        entityKey: record.key,
        label: labelFn(record),
        rank: ranks.get(record.key),
        count: record.count,
      },
    ]),
  );
}

function buildRankDiffEntries(currentState, previousState) {
  return [...currentState.values()].map((current) => {
    const previous = previousState.get(current.entityKey) || null;
    const previousRank = previous?.rank ?? null;
    const previousCount = previous?.count ?? 0;
    return {
      entityKey: current.entityKey,
      label: current.label,
      previousRank,
      currentRank: current.rank,
      rankDelta: previousRank == null ? null : previousRank - current.rank,
      previousCount,
      currentCount: current.count,
      countDelta: current.count - previousCount,
      isNew: previousRank == null,
    };
  });
}

function writeRangeArtifacts(groups) {
  for (const rangeId of CANONICAL_RANGES) {
    const group = groupForRange(groups, rangeId);
    if (group) writeJson(path.join(DATA_DIR, `${rangeId}.json`), group);
  }
  writeJson(path.join(DATA_DIR, "72h.json"), legacyAliasManifest("72h", groupForRange(groups, "7d")));
  writeJson(path.join(DATA_DIR, "1m.json"), legacyAliasManifest("1m", groupForRange(groups, "all")));
}

function collectSongOccurrences(items) {
  const occurrences = [];
  for (const item of items || []) {
    for (const song of item.songs || []) {
      if (!normalizeWhitespace(song?.title)) continue;
      occurrences.push({ item, song });
    }
  }
  return occurrences;
}

function canonicalizeSongOccurrences(occurrences, aliasContext = null) {
  if (!aliasContext?.aliasesByKey?.size) return occurrences || [];
  return (occurrences || []).map((occurrence) => ({
    ...occurrence,
    song: canonicalizeSongIdentity(occurrence.song, aliasContext),
  }));
}

function compareSongRankRecords(a, b) {
  return b.count - a.count || compareValues(a.sortKey, b.sortKey) || compareValues(a.title, b.title);
}

function compareCountRecords(a, b) {
  return b.count - a.count || compareValues(a.name || a.title || a.key, b.name || b.title || b.key);
}

function compareValues(a, b) {
  return rankCollator.compare(String(a || ""), String(b || ""));
}

function currentSnapshotMetadata(payload, curationContext = null) {
  const generatedAt = payload?.generatedAt || payload?.capturedAt || "";
  const capturedAt = payload?.capturedAt || payload?.generatedAt || "";
  const capturedDate = new Date(capturedAt);
  return {
    snapshotId: payload?.snapshotId || (Number.isFinite(capturedDate.getTime()) ? hourSnapshotId(capturedDate) : ""),
    path: "",
    generatedAt,
    capturedAt,
    curationVersion: curationContext?.version || payload?.curationVersion || "",
    curationHash: curationContext?.hash || payload?.curationHash || "",
  };
}

function previousSnapshotPayload(previousSnapshot) {
  if (!previousSnapshot) return null;
  if (previousSnapshot.payload?.groups) return previousSnapshot.payload;
  return previousSnapshot.groups ? previousSnapshot : null;
}

function selectPreviousSnapshotForDiff(previousSnapshot, previousPayload) {
  if (previousSnapshotPayload(previousSnapshot)) return previousSnapshot;
  return previousPayload?.groups ? previousPayload : null;
}

function previousSnapshotMetadata(previousSnapshot, curationContext = null) {
  const payload = previousSnapshotPayload(previousSnapshot);
  if (!payload) return null;
  const entry = previousSnapshot?.entry || {};
  return {
    snapshotId: payload.snapshotId || entry.id || "",
    path: entry.path || "",
    generatedAt: payload.generatedAt || entry.generatedAt || "",
    capturedAt: payload.capturedAt || entry.capturedAt || payload.generatedAt || entry.generatedAt || "",
    curationVersion: curationContext?.version || payload.curationVersion || "",
    curationHash: curationContext?.hash || payload.curationHash || "",
  };
}

function cleanSnapshotPayloadForCuration(payload, curationContext = null) {
  if (!payload?.groups) return payload;
  const cleanedGroups = {};
  for (const [groupId, group] of Object.entries(payload.groups)) {
    const items = applyCurationToVideos(group.items || [], curationContext || loadCurationContext());
    cleanedGroups[groupId] = {
      ...group,
      items: applyGroupQualityFilters({
        [groupId]: {
          ...group,
          items,
        },
      })[groupId].items,
    };
  }
  return {
    ...payload,
    groups: cleanedGroups,
  };
}

function readPreviousSuccessfulSnapshot(currentPayload = null) {
  const index = readJsonIfExists(SNAPSHOT_INDEX_PATH);
  const entries = Array.isArray(index?.snapshots) ? index.snapshots : [];
  const latestEntry = entries.find((entry) => entry?.id && entry.id === index?.latestSnapshotId);
  const orderedEntries = [...(latestEntry ? [latestEntry] : []), ...entries.filter((entry) => entry !== latestEntry)];
  for (const entry of orderedEntries) {
    const snapshot = readSnapshotEntry(entry);
    if (snapshot && !isSameSnapshotPayload(snapshot.payload, currentPayload)) return snapshot;
  }
  return null;
}

function readSnapshotEntry(entry) {
  if (!entry?.path) return null;
  const snapshotPath = path.resolve(ROOT, entry.path);
  if (!isPathInsideRoot(snapshotPath)) return null;
  const payload = readJsonIfExists(snapshotPath);
  return payload?.groups ? { entry, payload } : null;
}

function isPathInsideRoot(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSameSnapshotPayload(snapshotPayload, currentPayload) {
  if (!snapshotPayload || !currentPayload) return false;
  const snapshotTime = snapshotPayload.capturedAt || snapshotPayload.generatedAt || "";
  const currentTime = currentPayload.capturedAt || currentPayload.generatedAt || "";
  return Boolean(snapshotTime && currentTime && snapshotTime === currentTime && snapshotPayload.generatedAt === currentPayload.generatedAt);
}

function isLowQualitySelectedItem(item) {
  if (!Array.isArray(item.songs) || item.songs.length < 2) return true;
  const artistCount = item.songs.filter((song) => isUsableArtist(song.artist)).length;
  const sentenceLikeCount = item.songs.filter((song) => isSentenceLikeNoArtistEntry(song)).length;
  const artistRatio = item.songs.length ? artistCount / item.songs.length : 0;
  const sentenceLikeRatio = item.songs.length ? sentenceLikeCount / item.songs.length : 0;
  const topicCount = item.sourceQuality?.topicCount || 0;
  if (artistRatio < 0.1 && topicCount >= 4 && !isKnownNoArtistSongListTheme(item)) return true;
  return artistRatio < 0.1 && sentenceLikeRatio >= 0.25 && !isKnownNoArtistSongListTheme(item);
}

function writeSnapshot(payload, capturedAt) {
  const snapshotId = hourSnapshotId(capturedAt);
  const snapshotPath = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);
  writeJson(snapshotPath, { ...payload, snapshotId });
  const itemCounts = canonicalItemCounts(payload.groups);

  const index = readJsonIfExists(SNAPSHOT_INDEX_PATH) || { snapshots: [] };
  const entries = new Map();
  for (const entry of retainedSnapshotIndexEntries(index)) {
    entries.set(entry.id, entry);
  }
  entries.set(snapshotId, {
    id: snapshotId,
    file: `${snapshotId}.json`,
    path: `data/snapshots/${snapshotId}.json`,
    generatedAt: payload.generatedAt,
    capturedAt: payload.capturedAt,
    curationVersion: payload.curationVersion || "",
    curationHash: payload.curationHash || "",
    label: formatSnapshotLabel(capturedAt),
    itemCounts,
  });

  const snapshots = [...entries.values()].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const shardManifest = writeSnapshotIndexShards(snapshots);
  writeJson(SNAPSHOT_INDEX_PATH, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    retentionPolicy: "permanent",
    retentionDays: null,
    cadence: "hourly",
    latestSnapshotId: snapshots[0]?.id || "",
    snapshotCount: snapshots.length,
    shards: shardManifest,
    snapshots,
  });
}

function retainedSnapshotIndexEntries(index) {
  return (Array.isArray(index?.snapshots) ? index.snapshots : []).filter((entry) => {
    if (!entry || !/^[0-9]{8}T[0-9]{4}00Z$/.test(entry.id)) return false;
    return Number.isFinite(Date.parse(entry.capturedAt || entry.generatedAt || entry.id));
  });
}

function writeSnapshotIndexShards(snapshots) {
  const shardDir = path.join(SNAPSHOT_DIR, "index");
  const byMonth = new Map();
  for (const entry of snapshots || []) {
    const id = entry?.id || "";
    const match = id.match(/^([0-9]{4})([0-9]{2})/u);
    const key = match ? `${match[1]}-${match[2]}` : "unknown";
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(entry);
  }
  const shards = [];
  for (const [key, entries] of [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const [year, month] = key.split("-");
    const fileName = key === "unknown" ? "unknown.json" : path.join(year, `${month}.json`);
    const relativePath = `data/snapshots/index/${fileName.replace(/\\/g, "/")}`;
    writeJson(path.join(shardDir, fileName), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      retentionPolicy: "permanent",
      shard: key,
      snapshotCount: entries.length,
      snapshots: entries,
    });
    shards.push({
      id: key,
      path: relativePath,
      snapshotCount: entries.length,
      latestSnapshotId: entries[0]?.id || "",
    });
  }
  return shards;
}

async function markFailure(error) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previous = readJsonIfExists(LATEST_PATH);
  const attemptedAt = new Date().toISOString();
  const status = {
    status: "failed",
    attemptedAt,
    completedAt: attemptedAt,
    message: error.message,
    fallback: previous ? "kept previous data/latest.json" : "no previous data available",
  };
  writeJson(STATUS_PATH, status);
}

function extractSearchItems(data) {
  const items = [];
  for (const node of walkDicts(data)) {
    for (const item of searchItemsFromNode(node)) items.push(item);
  }
  return dedupeByVideoId(items).filter((item) => item.title);
}

function searchItemsFromNode(node) {
  if (!node || typeof node !== "object") return [];
  if (node.videoRenderer) return [searchItemFromRenderer(node.videoRenderer, "videoRenderer")].filter(Boolean);
  if (node.reelItemRenderer) return [searchItemFromRenderer(node.reelItemRenderer, "reelItemRenderer")].filter(Boolean);
  if (node.shortsLockupViewModel) return [searchItemFromRenderer(node.shortsLockupViewModel, "shortsLockupViewModel")].filter(Boolean);
  if (node.lockupViewModel) return [searchItemFromLockupViewModel(node.lockupViewModel)].filter(Boolean);
  if (node.richItemRenderer) return richItemRendererSearchItems(node.richItemRenderer);
  const generic = searchItemFromGenericEndpointNode(node);
  return generic ? [generic] : [];
}

function richItemRendererSearchItems(renderer) {
  const items = [];
  for (const child of walkDicts(renderer.content || renderer.contents || renderer)) {
    if (child === renderer) continue;
    if (child.videoRenderer || child.reelItemRenderer || child.shortsLockupViewModel) {
      items.push(...searchItemsFromNode(child));
    }
  }
  return items;
}

function searchItemFromRenderer(renderer, sourceRendererType) {
  const videoId = videoIdFromRenderer(renderer);
  if (!isValidVideoId(videoId)) return null;
  return {
    videoId,
    title: rendererTitle(renderer),
    channelName: textFrom(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText || renderer.channelName || renderer.shortByline),
    channelId: channelIdFromRenderer(renderer),
    channelHandle: channelHandleFromRenderer(renderer),
    publishedText: textFrom(renderer.publishedTimeText || renderer.publishedTime || renderer.timestampText),
    publishedTimestamp: finiteTimestamp(renderer.publishedTimestamp),
    durationText: textFrom(renderer.lengthText || renderer.lengthTextAccessibility || renderer.durationText || renderer.thumbnailOverlays),
    statusText: statusTextFromRenderer(renderer),
    thumbnailUrl: bestThumbnail(renderer.thumbnail || renderer.thumbnailViewModel?.image || renderer.thumbnailViewModel),
    viewText: textFrom(renderer.viewCountText || renderer.shortViewCountText || renderer.viewCountText?.content),
    sourceRendererType,
  };
}

function searchItemFromLockupViewModel(renderer) {
  const videoId = firstValidVideoId(
    renderer.contentId,
    renderer.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId,
    videoIdFromRenderer(renderer),
  );
  if (!isValidVideoId(videoId)) return null;
  const metadata = renderer.metadata?.lockupMetadataViewModel || {};
  const metadataTexts = [];
  collectTextSnippets(metadata.metadata?.contentMetadataViewModel?.metadataRows, metadataTexts);
  const overlayTexts = [];
  collectTextSnippets(renderer.contentImage?.thumbnailViewModel?.overlays, overlayTexts);
  return {
    videoId,
    title: textFrom(metadata.title || renderer.title || renderer.accessibilityText),
    channelName: textFrom(metadata.subtitle || metadata.byline || renderer.ownerText || renderer.channelName),
    channelId: channelIdFromRenderer(renderer),
    channelHandle: channelHandleFromRenderer(renderer),
    publishedText: firstPublishedText(metadataTexts),
    publishedTimestamp: finiteTimestamp(renderer.publishedTimestamp),
    durationText: firstDurationText(overlayTexts),
    statusText: normalizeWhitespace([...new Set([...overlayTexts, ...metadataTexts])].join(" / ")),
    thumbnailUrl: bestThumbnail(
      renderer.contentImage?.thumbnailViewModel?.image ||
        renderer.contentImage?.thumbnailViewModel ||
        renderer.thumbnailViewModel?.image ||
        renderer.thumbnailViewModel,
    ),
    viewText: firstViewText(metadataTexts),
    sourceRendererType: "lockupViewModel",
  };
}

function searchItemFromGenericEndpointNode(node) {
  const videoId = videoIdFromRenderer(node);
  if (!isValidVideoId(videoId)) return null;
  const title = rendererTitle(node);
  const thumbnailUrl = bestThumbnail(node.thumbnail || node.thumbnailViewModel?.image || node.thumbnailViewModel);
  if (!title || !thumbnailUrl) return null;
  return {
    videoId,
    title,
    channelName: textFrom(node.ownerText || node.longBylineText || node.shortBylineText || node.channelName),
    channelId: channelIdFromRenderer(node),
    channelHandle: channelHandleFromRenderer(node),
    publishedText: textFrom(node.publishedTimeText || node.timestampText),
    durationText: textFrom(node.lengthText || node.durationText || node.thumbnailOverlays),
    statusText: statusTextFromRenderer(node),
    thumbnailUrl,
    viewText: textFrom(node.viewCountText || node.shortViewCountText),
    sourceRendererType: "genericWatchEndpoint",
  };
}

function rendererTitle(renderer) {
  return textFrom(
    renderer.title ||
      renderer.headline ||
      renderer.videoTitle ||
      renderer.accessibilityText ||
      renderer.overlayMetadata?.primaryText ||
      renderer.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.title,
  );
}

function videoIdFromRenderer(renderer) {
  const direct = firstValidVideoId(
    renderer.videoId,
    renderer.videoId?.videoId,
    renderer.navigationEndpoint?.watchEndpoint?.videoId,
    renderer.navigationEndpoint?.reelWatchEndpoint?.videoId,
    renderer.onTap?.innertubeCommand?.watchEndpoint?.videoId,
    renderer.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId,
    renderer.command?.watchEndpoint?.videoId,
    renderer.command?.reelWatchEndpoint?.videoId,
  );
  if (direct) return direct;
  for (const item of walkDicts(renderer)) {
    const endpointId = firstValidVideoId(item.watchEndpoint?.videoId, item.reelWatchEndpoint?.videoId);
    if (endpointId) return endpointId;
    const url = item.commandMetadata?.webCommandMetadata?.url || item.url || item.webPageTypeUrl;
    const urlId = extractVideoIdFromWatchUrl(url);
    if (urlId) return urlId;
  }
  return "";
}

function firstValidVideoId(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value : "";
    if (isValidVideoId(text)) return text;
  }
  return "";
}

function channelIdFromRenderer(renderer) {
  return channelEndpointFromRenderer(renderer)?.browseId || "";
}

function channelHandleFromRenderer(renderer) {
  return normalizeChannelHandle(channelEndpointFromRenderer(renderer)?.canonicalBaseUrl || "");
}

function channelEndpointFromRenderer(renderer) {
  for (const source of [renderer.ownerText, renderer.longBylineText, renderer.shortBylineText]) {
    for (const run of source?.runs || []) {
      const endpoint = run?.navigationEndpoint?.browseEndpoint;
      if (endpoint?.browseId || endpoint?.canonicalBaseUrl) return endpoint;
    }
  }
  return renderer.ownerEndpoint?.browseEndpoint || renderer.navigationEndpoint?.browseEndpoint || null;
}

function statusTextFromRenderer(renderer) {
  const values = [];
  collectTextSnippets(renderer.thumbnailOverlays, values);
  collectTextSnippets(renderer.badges, values);
  collectTextSnippets(renderer.ownerBadges, values);
  collectTextSnippets(renderer.upcomingEventData, values);
  collectTextSnippets(renderer.publishedTimeText, values);
  return normalizeWhitespace([...new Set(values)].join(" / "));
}

function collectTextSnippets(value, target) {
  if (!value) return;
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectTextSnippets(child, target);
    return;
  }
  if (typeof value !== "object") return;
  if (typeof value.simpleText === "string") target.push(value.simpleText);
  if (typeof value.content === "string") target.push(value.content);
  if (Array.isArray(value.runs)) target.push(value.runs.map((run) => run?.text || "").join(""));
  for (const child of Object.values(value)) collectTextSnippets(child, target);
}

function firstPublishedText(values) {
  return normalizeWhitespace(
    (values || []).find((value) =>
      /(?:\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年|second|seconds|minute|minutes|min|hour|hours|day|days|week|weeks|month|months|year|years)\s*前|公開予定|配信予定|に公開予定|premiere|scheduled)/iu.test(
        value,
      ),
    ) || "",
  );
}

function firstDurationText(values) {
  return normalizeWhitespace((values || []).find((value) => /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/u.test(value)) || "");
}

function firstViewText(values) {
  return normalizeWhitespace((values || []).find((value) => /(?:視聴|views?|回(?:再生|視聴))/iu.test(value)) || "");
}

function isActiveLiveOrUpcomingCandidate(item) {
  const status = normalizeWhitespace(`${item.statusText || ""} ${item.publishedText || ""} ${item.durationText || ""}`);
  const title = normalizeWhitespace(item.title || "");
  const hasDuration = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(item.durationText || "");
  if (!hasDuration && /(?:がライブ配信中|ライブ配信中[!！]?|配信中です|is live|streaming now)/iu.test(title)) return true;
  if (/(?:upcoming|scheduled|premiere|公開予定|配信予定|ライブ配信予定|予定|予約|待機|まもなく|即将|預約|预约)/iu.test(status)) {
    return !hasDuration;
  }
  if (/(?:LIVE|ライブ|配信中|生放送|視聴中|watching|直播中|正在观看|正在觀看|실시간|시청 중)/iu.test(status)) {
    return !hasDuration;
  }
  return false;
}

function extractDescriptionCandidates(data) {
  const texts = [];
  for (const item of walkDicts(data)) {
    if (typeof item.simpleText === "string" && isTimestampCandidateText(item.simpleText)) texts.push(item.simpleText);
    if (Array.isArray(item.runs)) {
      const joined = item.runs.map((run) => (run && typeof run.text === "string" ? run.text : "")).join("");
      if (isTimestampCandidateText(joined)) texts.push(joined);
    }
  }
  return [...new Set(texts)];
}

function findCommentsContinuation(data) {
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token;
    if (token && looksLikeCommentsContinuation(item)) return token;
  }
  for (const item of walkDicts(data)) {
    const token = item.continuationCommand?.token;
    if (token) return token;
  }
  return "";
}

function looksLikeCommentsContinuation(item) {
  const text = JSON.stringify(item);
  return /comment|コメント/i.test(text);
}

async function fetchCommentReplyTexts(apiKey, clientVersion, commentsResponse, maxContinuations, videoId = "") {
  const comments = [];
  const seen = new Set();
  const pending = extractCommentReplyContinuationTokens(commentsResponse);
  while (pending.length && seen.size < maxContinuations) {
    const token = pending.shift();
    if (seen.has(token)) continue;
    seen.add(token);
    const response = await fetchYouTubeContinuation(apiKey, clientVersion, token);
    comments.push(...extractCommentTexts(response, "reply", videoId));
    for (const nextToken of extractCommentReplyContinuationTokens(response)) {
      if (!seen.has(nextToken)) pending.push(nextToken);
    }
  }
  return comments;
}

function extractCommentReplyContinuationTokens(data) {
  const tokens = [];
  for (const item of walkDicts(data)) {
    const replies = item.commentRepliesRenderer;
    if (!replies || !Array.isArray(replies.contents)) continue;
    for (const content of replies.contents) {
      const token = content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

function extractCommentTexts(data, sourceType = "comment", videoId = "") {
  const comments = [];
  for (const item of walkDicts(data)) {
    const commentId = commentIdFromItem(item);
    const authorName = authorNameFromItem(item);
    const entityContent = item.commentEntityPayload?.properties?.content?.content;
    if (typeof entityContent === "string") {
      comments.push(createSourceRecord({ videoId, sourceType, commentId, authorName, text: entityContent, index: comments.length }));
    }
    const rendererRuns = item.commentRenderer?.contentText?.runs;
    if (Array.isArray(rendererRuns)) {
      const text = rendererRuns.map((run) => run.text || "").join("");
      if (text) comments.push(createSourceRecord({ videoId, sourceType, commentId, authorName, text, index: comments.length }));
    }
  }
  return dedupeSourceRecords(comments);
}

function dedupeSourceRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records || []) {
    const key = `${record.sourceId}:${record.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function commentIdFromItem(item) {
  return (
    item.commentEntityPayload?.properties?.commentId ||
    item.commentEntityPayload?.properties?.commentKey ||
    item.commentRenderer?.commentId ||
    item.commentRenderer?.comment?.commentId ||
    item.commentThreadRenderer?.comment?.commentRenderer?.commentId ||
    ""
  );
}

function authorNameFromItem(item) {
  return (
    item.commentEntityPayload?.author?.displayName ||
    item.commentRenderer?.authorText?.simpleText ||
    textFrom(item.commentRenderer?.authorText) ||
    textFrom(item.commentThreadRenderer?.comment?.commentRenderer?.authorText) ||
    ""
  );
}

async function fetchYouTubeContinuation(apiKey, clientVersion, continuation) {
  const response = await fetchWithRetry(`https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      ...headers(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion,
          hl: "ja",
          gl: "JP",
        },
      },
      continuation,
    }),
  });
  if (!response.ok) throw new Error(`youtubei continuation HTTP ${response.status}`);
  return response.json();
}

async function fetchYouTubeSearchContinuation(apiKey, clientVersion, continuation) {
  const response = await fetchWithRetry(`https://www.youtube.com/youtubei/v1/search?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      ...headers(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion,
          hl: "ja",
          gl: "JP",
        },
      },
      continuation,
    }),
  });
  if (!response.ok) throw new Error(`youtubei search continuation HTTP ${response.status}`);
  return response.json();
}

function findSearchContinuation(data) {
  for (const item of walkDicts(data)) {
    const renderer = item.continuationItemRenderer;
    const token = renderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
  }
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token;
    const apiUrl = endpoint?.commandMetadata?.webCommandMetadata?.apiUrl || "";
    if (token && /\/youtubei\/v1\/search/i.test(apiUrl)) return token;
  }
  return "";
}

function selectBestSongs(sources) {
  if (!sources.length) return [];
  const best = [...sources].sort((a, b) => {
    const scoreDiff = sourceScore(b) - sourceScore(a);
    if (scoreDiff) return scoreDiff;
    const lenDiff = b.songs.length - a.songs.length;
    if (lenDiff) return lenDiff;
    const artistDiff = b.stats.artistCount - a.stats.artistCount;
    if (artistDiff) return artistDiff;
    return a.songs[0].seconds - b.songs[0].seconds;
  })[0];
  best.songs.sourceQuality = {
    sourceId: best.stats.sourceId || "",
    sourceHash: best.stats.sourceHash || "",
    sourceType: best.stats.sourceType,
    sourceScore: sourceScore(best),
    riskScore: best.stats.riskScore || 0,
    riskLevel: best.stats.riskLevel || "low",
    riskReasons: best.stats.riskReasons || [],
    originalCount: best.stats.originalCount,
    keptCount: best.stats.keptCount,
    knownSongCount: best.stats.knownSongCount,
    artistCount: best.stats.artistCount,
    unknownArtistCount: best.stats.unknownArtistCount,
    activityMarkerCount: best.stats.activityMarkerCount,
    activityMarkerRatio: best.stats.activityMarkerRatio,
    nicheCount: best.stats.nicheCount,
    nicheRatio: best.stats.nicheRatio,
    topicCount: best.stats.topicCount,
    structuralCount: best.stats.structuralCount,
    sentenceLikeCount: best.stats.sentenceLikeCount,
    conversationEntryCount: best.stats.conversationEntryCount,
    conversationRatio: best.stats.conversationRatio,
    parserCorruptionCount: best.stats.parserCorruptionCount,
    singleSongIdentification: best.stats.singleSongIdentification || null,
  };
  return best.songs;
}

function withMergedOrderedSource(sources) {
  const merged = mergeOrderedSources(sources);
  if (!merged || !merged.songs.length) return sources;
  const largest = Math.max(0, ...sources.map((source) => source.songs.length));
  return merged.songs.length > largest ? [merged, ...sources] : sources;
}

function mergeOrderedSources(sources) {
  const longSources = sources.filter((source) => source.songs.length >= 10);
  if (longSources.length < 2) return null;
  const merged = [];
  let lastSeconds = -1;
  for (const source of longSources.sort((a, b) => a.songs[0].seconds - b.songs[0].seconds)) {
    const start = source.songs[0].seconds;
    const end = source.songs[source.songs.length - 1].seconds;
    if (start <= lastSeconds || end <= start) continue;
    merged.push(...source.songs);
    lastSeconds = end;
  }
  const songs = merged.length >= 20 ? dedupeMergedSongs(merged) : [];
  if (!songs.length) return null;
  return {
    songs,
    stats: {
      sourceType: "merged",
      originalCount: songs.length,
      keptCount: songs.length,
      artistCount: countArtists(songs),
      artistRatio: songs.length ? countArtists(songs) / songs.length : 0,
      topicCount: 0,
      topicRatio: 0,
      structuralCount: songs.length,
      conversationEntryCount: 0,
      conversationRatio: 0,
      parserCorruptionCount: 0,
      hasSetlistKeyword: true,
    },
  };
}

function dedupeMergedSongs(songs) {
  const seen = new Set();
  const result = [];
  for (const song of songs) {
    const key = `${song.seconds}:${song.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

function countArtists(songs) {
  return songs.filter((song) => isUsableArtist(song.artist)).length;
}

function displayArtist(artist) {
  return isUsableArtist(artist) ? String(artist).trim() : "";
}

function isUsableArtist(artist) {
  const value = String(artist || "").trim();
  if (!value || /^(?:未記載|未记载|待补歌手|待補歌手|待补|待補)$/u.test(value)) return false;
  if (/^(ソロ|全員|みんな|ゲスト|本人|原曲|オリジナル|ラジオ|仮の日程|20\d{2}年?)$/iu.test(value)) return false;
  if (/^\d+\s*(?:人|名)$/u.test(value)) return false;
  return true;
}

function isValidVideoId(videoId) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ""));
}

function isValidSong(song) {
  return (
    song &&
    String(song.title || "").trim() &&
    Number.isInteger(song.seconds) &&
    song.seconds >= 0 &&
    /^\d+:\d{2}:\d{2}$/.test(song.time || "")
  );
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isWithinAgeWindow(timestamp, nowMs, windowMs) {
  const value = finiteTimestamp(timestamp);
  if (!value) return false;
  const ageMs = nowMs - value;
  return ageMs >= 0 && ageMs <= windowMs;
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function isDisabledEnv(value) {
  return /^(?:0|false|off|no)$/iu.test(String(value || "").trim());
}

function joinUrl(base, relative) {
  return `${String(base || "").replace(/\/+$/u, "")}/${String(relative || "").replace(/^\/+/u, "")}`;
}

function mygitSnapshotEntryUrl(rawBaseUrl, entry) {
  const entryPath = entry?.path || (entry?.file ? `data/today-snapshots/${entry.file}` : "");
  return entryPath ? joinUrl(rawBaseUrl, entryPath) : "";
}

function mygitSnapshotEntryTimestamp(entry) {
  const direct = Date.parse(entry?.capturedAt || entry?.generatedAt || "");
  if (Number.isFinite(direct)) return direct;
  const idValue = String(entry?.id || entry?.file || "").match(/(\d{8})T(\d{6})Z/u);
  if (!idValue) return NaN;
  const [, datePart, timePart] = idValue;
  return Date.parse(
    `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(
      2,
      4,
    )}:${timePart.slice(4, 6)}Z`,
  );
}

function mygitSnapshotEntryDay(entry, timestamp) {
  const direct = String(entry?.capturedAt || entry?.generatedAt || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(direct)) return direct;
  const idValue = String(entry?.id || entry?.file || "").match(/(\d{4})(\d{2})(\d{2})T/u);
  if (idValue) return `${idValue[1]}-${idValue[2]}-${idValue[3]}`;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function extractVideoIdFromWatchUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const byQuery = parsed.searchParams.get("v");
    if (isValidVideoId(byQuery)) return byQuery;
    const shortsMatch = parsed.pathname.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/u);
    return shortsMatch?.[1] || "";
  } catch {
    const match =
      value.match(/[?&]v=([A-Za-z0-9_-]{11})/u) ||
      value.match(/(?:youtu\.be|youtube\.com\/watch)\/?([A-Za-z0-9_-]{11})/u) ||
      value.match(/\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/u);
    return match?.[1] || "";
  }
}

function normalizeChannelHandle(value) {
  const text = normalizeWhitespace(value || "");
  const match = text.match(/(?:^|\/)(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/u);
  if (match) return match[1];
  return /^@[A-Za-z0-9._%~-]+$/u.test(text) ? text : "";
}

function mergedChannelHandle(current, candidate) {
  const currentHandle = normalizeChannelHandle(current);
  return currentHandle || normalizeChannelHandle(candidate);
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sourceScore(source) {
  const stats = source.stats;
  if (stats.riskLevel === "high") return -100000 + (stats.knownSongCount || 0);
  return (
    (stats.repairedKnownSongCount || 0) * 9 +
    (stats.knownSongCount || 0) * 7 +
    (stats.artistCount || 0) * 4 +
    (stats.structuralCount || 0) * 1.5 +
    (stats.hasSetlistKeyword ? 5 : 0) +
    (stats.keptCount || 0) * 0.5 -
    (stats.activityMarkerCount || 0) * 24 -
    (stats.conversationEntryCount || 0) * 20 -
    (stats.parserCorruptionCount || 0) * 28 -
    (stats.topicCount || 0) * 8 -
    (stats.sentenceLikeCount || 0) * 3
  );
}

function loadSongSearchLookup() {
  return createSongSearchLookup(mergeSupplementalKnownSongs(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {}));
}

function parsePublishedTimestamp(text, nowMs) {
  const normalized = normalizeDigits(String(text || "")).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/昨日|yesterday/i.test(normalized)) return nowMs - 24 * 60 * 60 * 1000;
  const directDate = normalized.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (directDate) {
    const value = new Date(Number(directDate[1]), Number(directDate[2]) - 1, Number(directDate[3])).getTime();
    return Number.isFinite(value) ? value : null;
  }
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|minutes?|mins?|分|hours?|hrs?|時間|小时|小時|days?|日|天|weeks?|週間|週|周|months?|か月|ヶ月|月|years?|年)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  let multiplier = 0;
  if (/second|sec|秒/.test(unit)) multiplier = 1000;
  else if (/minute|min|分/.test(unit)) multiplier = 60 * 1000;
  else if (/hour|hr|時間|小时|小時/.test(unit)) multiplier = 60 * 60 * 1000;
  else if (/day|日|天/.test(unit)) multiplier = 24 * 60 * 60 * 1000;
  else if (/week|週間|週|周/.test(unit)) multiplier = 7 * 24 * 60 * 60 * 1000;
  else if (/month|か月|ヶ月|月/.test(unit)) multiplier = 30 * 24 * 60 * 60 * 1000;
  else if (/year|年/.test(unit)) multiplier = 365 * 24 * 60 * 60 * 1000;
  return multiplier ? nowMs - amount * multiplier : null;
}

function normalizeDigits(text) {
  return String(text || "").replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, { headers: headers() });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

async function fetchJsonUrl(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: headers() });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function fetchWithRetry(url, options) {
  let response;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    if (requestLimiter.shouldStop()) {
      throw new RateLimitAbortError(`YouTube HTTP 429 limit reached (${requestLimiter.error429Count}/${MAX_429_ERRORS}); stopped further inspections`);
    }
    await requestLimiter.beforeRequest();
    if (requestLimiter.shouldStop()) {
      throw new RateLimitAbortError(`YouTube HTTP 429 limit reached (${requestLimiter.error429Count}/${MAX_429_ERRORS}); stopped further inspections`);
    }
    try {
      const controller = new AbortController();`r`n        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);`r`n        try {`r`n          response = await fetch(url, { ...options, signal: options?.signal || controller.signal });`r`n        } finally {`r`n          clearTimeout(timeout);`r`n        }
    } catch (error) {
      if (attempt >= FETCH_RETRIES) throw error;
      await delay(networkRetryDelayMs(attempt));
      continue;
    }
    if (response.status === 429) {
      requestLimiter.note429();
      if (requestLimiter.shouldStop()) {
        throw new RateLimitAbortError(`YouTube HTTP 429 limit reached (${requestLimiter.error429Count}/${MAX_429_ERRORS}); stopped further inspections`);
      }
    }
    if (response.ok || !isRetryableHttpStatus(response.status) || attempt >= FETCH_RETRIES) return response;
    const waitMs = retryDelayMs(response, attempt);
    if (response.status === 429) requestLimiter.cooldown(waitMs);
    await delay(waitMs);
  }
  return response;
}

function networkRetryDelayMs(attempt, random = Math.random, retryJitterMs = RETRY_JITTER_MS) {
  return 750 * attempt * attempt + randomJitterMs(retryJitterMs, random);
}

function isRetryableHttpStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response, attempt, nowMs = Date.now(), random = Math.random, retryJitterMs = RETRY_JITTER_MS) {
  const retryAfterMs = parseRetryAfterMs(response?.headers?.get?.("retry-after"), nowMs);
  const baseDelayMs = 750 * attempt * attempt;
  const cooldownMs = response?.status === 429 ? RATE_LIMIT_COOLDOWN_MS : 0;
  return Math.max(baseDelayMs, retryAfterMs, cooldownMs) + randomJitterMs(retryJitterMs, random);
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (!value) return 0;
  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric)) return Math.max(0, Math.ceil(numeric * 1000));
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : 0;
}

function randomJitterMs(maxJitterMs, random = Math.random) {
  const max = nonNegativeInteger(maxJitterMs, 0);
  return max > 0 ? Math.floor(random() * (max + 1)) : 0;
}

function createRequestLimiter({ requestDelayMs, requestJitterMs = 0, max429Errors, random = Math.random }) {
  return {
    pending: Promise.resolve(),
    nextRequestAt: 0,
    cooldownUntil: 0,
    error429Count: 0,
    stopped: false,
    async beforeRequest(now = Date.now) {
      const queued = this.pending.then(async () => {
        const waitUntil = Math.max(this.nextRequestAt, this.cooldownUntil);
        const waitMs = waitUntil - now();
        if (waitMs > 0) await delay(waitMs);
        this.nextRequestAt = now() + requestDelayMs + randomJitterMs(requestJitterMs, random);
      });
      this.pending = queued.catch(() => {});
      await queued;
    },
    note429() {
      this.error429Count += 1;
      if (max429Errors > 0 && this.error429Count >= max429Errors) this.stopped = true;
    },
    cooldown(waitMs, now = Date.now) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now() + Math.max(0, waitMs));
    },
    shouldStop() {
      return this.stopped;
    },
  };
}

class RateLimitAbortError extends Error {}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers() {
  return {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "accept-language": "ja,en-US;q=0.8,en;q=0.6",
  };
}

function extractJsonAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${marker} not found`);
  const start = text.indexOf("{", idx);
  if (start < 0) throw new Error(`${marker} object start not found`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let pos = start; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, pos + 1));
    }
  }
  throw new Error(`${marker} object end not found`);
}

function tryExtractJsonAfter(text, marker) {
  try {
    return extractJsonAfter(text, marker);
  } catch {
    return null;
  }
}

function extractRegex(text, regex) {
  return text.match(regex)?.[1] || "";
}

function* walkDicts(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* walkDicts(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walkDicts(child);
  }
}

function textFrom(value) {
  if (!value) return "";
  if (typeof value === "string") return normalizeWhitespace(value);
  if (typeof value.simpleText === "string") return normalizeWhitespace(value.simpleText);
  if (typeof value.content === "string") return normalizeWhitespace(value.content);
  if (Array.isArray(value.runs)) return normalizeWhitespace(value.runs.map((run) => run.text || "").join(""));
  if (Array.isArray(value.accessibility?.accessibilityData?.label)) return normalizeWhitespace(value.accessibility.accessibilityData.label);
  return "";
}

function bestThumbnail(thumbnail) {
  const list = thumbnail?.thumbnails || thumbnail?.sources;
  if (!Array.isArray(list) || !list.length) return "";
  return [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url || "";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeByVideoId(items) {
  const seen = new Map();
  const result = [];
  for (const item of items) {
    if (!item.videoId) continue;
    const previousIndex = seen.get(item.videoId);
    if (previousIndex !== undefined) {
      if (searchItemScore(item) > searchItemScore(result[previousIndex])) result[previousIndex] = item;
      continue;
    }
    seen.set(item.videoId, result.length);
    result.push(item);
  }
  return result;
}

function searchItemScore(item) {
  const rendererScore =
    item?.sourceRendererType === "shortsLockupViewModel"
      ? 4
      : item?.sourceRendererType === "videoRenderer" || item?.sourceRendererType === "reelItemRenderer"
        ? 3
        : item?.sourceRendererType === "genericWatchEndpoint"
          ? 1
          : 0;
  return (
    rendererScore * 100 +
    (item?.title ? 12 : 0) +
    (item?.thumbnailUrl ? 8 : 0) +
    (item?.channelName ? 4 : 0) +
    (item?.publishedText || item?.publishedTimestamp ? 2 : 0) +
    (item?.durationText ? 1 : 0)
  );
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

function hourSnapshotId(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}0000Z`;
}

function formatSnapshotLabel(date) {
  return new Intl.DateTimeFormat("zh-Hant", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalLimit(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) throw new Error(`Expected optional limit to be 0 or a positive integer, got ${value}`);
  return parsed;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

module.exports = {
  applyGroupQualityFilters,
  buildGroups,
  buildRankDiffForRange,
  buildRankDiffs,
  collectCarryForwardVideos,
  collectInspectionCacheSkipIds,
  createVideoTitleKnownSongSourceRecord,
  createRequestLimiter,
  extractSearchItems,
  extractMygitTodaySnapshotItems,
  extractWatchVideoMetadata,
  extractCommentTexts,
  filterBlockedVideos,
  filterArtistRichMixedSourceSongs,
  fetchMygitTodaySnapshotSource,
  fetchWithRetry,
  fetchVideoSongList,
  hasMonthlyDiscoverySource,
  isBlockedSource,
  matchBlockedSource,
  mergeInspectionCache,
  mergeFetchedAndCarriedVideos,
  mergeCandidateWithWatchMetadata,
  matchKnownTitleArtistFromVideoTitle,
  normalizeMygitTodaySnapshotItem,
  networkRetryDelayMs,
  parseRetryAfterMs,
  parseOptionalLimit,
  randomJitterMs,
  retryDelayMs,
  retainedSnapshotIndexEntries,
  selectMygitTodaySnapshotEntries,
  selectCandidatesForInspection,
  selectPreviousSnapshotForDiff,
  selectBestSongs,
  sourceScore,
  writeRankDiffFiles,
  BLOCKED_REGIONAL_VTUBER_CHANNELS,
  BLOCKLIST_HASH,
  BLOCKLIST_VERSION,
  MYGIT_TODAY_SNAPSHOT_SOURCE_GROUP,
};
