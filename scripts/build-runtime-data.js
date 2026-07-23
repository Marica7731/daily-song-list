const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION } = require("../assets/source-filter");
const RankingUtils = require("../assets/ranking-utils");
const { isActivityMarkerTitle } = require("./curation");
const { isLikelyNonSongEntry, normalizeSourceAwareArtist } = require("./song-utils");
const { augmentPayloadWithVsingerBackfill } = require("./vsinger-http/runtime-importer");
const {
  CANONICAL_RANGES,
  LEGACY_RANGE_ALIASES,
  LEGACY_RANGE_IDS,
  RANGE_TITLES,
  canonicalRangeId,
  groupForRange,
} = require("./range-config");
const { hydratePayloadWithChannelMetadata, thumbnailUrlForVideo } = require("./channel-metadata-cache");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UI_DIR = path.join(DATA_DIR, "ui");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const META_PATH = path.join(UI_DIR, "meta.json");
const RANGES = CANONICAL_RANGES;
const LEGACY_RANGES = Object.keys(LEGACY_RANGE_ALIASES);
const CURRENT_FILTER_VERSION = 4;
const RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_RANK_DIFF_LIMIT = 200;
const RUNTIME_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_RUNTIME_PAGE_SIZE, 80);
const SOURCE_DETAIL_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_SOURCE_DETAIL_PAGE_SIZE, 120);
const SEARCH_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_SEARCH_PAGE_SIZE, 240);
const REQUEST_PAGE_SIZE = positiveInteger(process.env.DAILY_SONG_REQUEST_PAGE_SIZE, 50);
const REQUEST_DETAIL_SHARD_SIZE = positiveInteger(process.env.DAILY_SONG_REQUEST_DETAIL_SHARD_SIZE, 96);
const REQUEST_SOURCE_SHARD_SIZE = positiveInteger(process.env.DAILY_SONG_REQUEST_SOURCE_SHARD_SIZE, 48);
const REQUEST_SEARCH_SHARD_SIZE = positiveInteger(process.env.DAILY_SONG_REQUEST_SEARCH_SHARD_SIZE, 2000);
const REQUEST_SEARCH_SHARD_MAX_BYTES = positiveInteger(process.env.DAILY_SONG_REQUEST_SEARCH_SHARD_MAX_BYTES, 8 * 1024 * 1024);
const REQUEST_PREVIEW_SOURCE_LIMIT = positiveInteger(process.env.DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT, 3);
const REQUEST_DETAIL_SHARD_MAX_BYTES = positiveInteger(process.env.DAILY_SONG_REQUEST_DETAIL_SHARD_MAX_BYTES, 8 * 1024 * 1024);
const REQUEST_SOURCE_SHARD_MAX_BYTES = positiveInteger(process.env.DAILY_SONG_REQUEST_SOURCE_SHARD_MAX_BYTES, 8 * 1024 * 1024);

if (require.main === module) {
  main();
}

function main() {
  const payload = hydratePayloadWithChannelMetadata(augmentPayloadWithVsingerBackfill(readJson(LATEST_PATH)));
  const baseRangePayloads = Object.fromEntries(RANGES.map((rangeId) => [rangeId, buildRuntimeRangePayload(payload, rangeId)]));
  const dataVersion = computeRuntimeDataVersion(payload, baseRangePayloads);
  const rangePayloads = Object.fromEntries(
    RANGES.map((rangeId) => [rangeId, { ...baseRangePayloads[rangeId], dataVersion }]),
  );
  const rangeFiles = {};
  const shardFiles = {};
  for (const [rangeId, rangePayload] of Object.entries(rangePayloads)) {
    const rangeJson = stringifyRuntimeJson(rangePayload);
    const sha256 = sha256Text(rangeJson);
    const shortHash = sha256.slice(0, 12);
    const hashedPath = `data/ui/${rangeId}.${shortHash}.json`;
    const legacyPath = `data/ui/${rangeId}.json`;
    rangeFiles[rangeId] = {
      path: hashedPath,
      legacyPath,
      sha256,
      bytes: Buffer.byteLength(rangeJson, "utf8"),
      generatedAt: rangePayload.generatedAt || "",
      itemCount: rangePayload.items?.length || 0,
      dataVersion,
    };
    writeRuntimeJsonText(path.join(ROOT, hashedPath), rangeJson);
    writeRuntimeJsonText(path.join(ROOT, legacyPath), rangeJson);
    shardFiles[rangeId] = summarizeRuntimeShardSet(writeRuntimeShardSet(payload, rangePayload, rangeId, { dataVersion }));
  }
  writeRuntimeAliasFiles(rangeFiles, rangePayloads);
  cleanupOldRuntimeRangeFiles(rangeFiles);

  for (const rangeId of RANGES) {
    const diffPath = diffPathForRange(rangeId);
    if (!fs.existsSync(diffPath)) continue;
    writeRuntimeJson(diffPath, compactRankDiff(readJson(diffPath)));
  }

  writeRuntimeJson(META_PATH, buildRuntimeMeta(payload, rangePayloads, { dataVersion, rangeFiles, shardFiles }));
  console.log(
    `[runtime-data] wrote ${path.relative(ROOT, META_PATH)} ${RANGES.map((rangeId) => rangeFiles[rangeId].path).join(" ")}`,
  );
}

function buildRuntimeMeta(payload, rangePayloads, options = {}) {
  const dataVersion = options.dataVersion || commonRangeDataVersion(rangePayloads) || computeRuntimeDataVersion(payload, rangePayloads);
  const rangeFiles = options.rangeFiles || {};
  const shardFiles = options.shardFiles || {};
  const rangeIds = runtimeRangeIds(rangePayloads, rangeFiles);
  const itemCounts = Object.fromEntries(rangeIds.map((rangeId) => [rangeId, rangePayloads[rangeId]?.items?.length || 0]));
  const capturedAt = payload.capturedAt || payload.generatedAt || "";
  const rebuiltDerivedAt = payload.source?.rebuiltDerivedAt || "";
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    dataVersion,
    generatedAt: payload.generatedAt || "",
    capturedAt,
    dataCapturedAt: capturedAt,
    rebuiltDerivedAt,
    derivedBuiltAt: payload.generatedAt || rebuiltDerivedAt || capturedAt,
    curationVersion: payload.curationVersion || "",
    curationHash: payload.curationHash || "",
    blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
    blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
    catalog: payload.source?.videoCatalog || null,
    externalSources: payload.source?.externalSources || null,
    status: runtimeStatus(payload, { capturedAt, rebuiltDerivedAt, dataVersion, itemCounts }),
    latestCapture: {
      capturedAt,
      completedAt: payload.status?.completedAt || capturedAt,
      itemCounts,
    },
    latestDerived: {
      builtAt: payload.generatedAt || rebuiltDerivedAt || capturedAt,
      rebuiltDerivedAt,
      dataVersion,
      itemCounts,
    },
    rangeAliases: LEGACY_RANGE_ALIASES,
    canonicalRanges: CANONICAL_RANGES,
    legacyRanges: LEGACY_RANGE_IDS,
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: rangeIds.every((rangeId) => rangePayloads[rangeId]?.nicheAnnotated === true),
    ranges: Object.fromEntries(
      rangeIds.map((rangeId) => [
        rangeId,
        {
          canonicalRangeId: canonicalRangeId(rangeId),
          legacyRangeIds: LEGACY_RANGE_IDS[rangeId] || [],
          path: rangeFiles[rangeId]?.path || `data/ui/${rangeId}.json`,
          legacyPath: rangeFiles[rangeId]?.legacyPath || `data/ui/${rangeId}.json`,
          sha256: rangeFiles[rangeId]?.sha256 || sha256Text(stringifyRuntimeJson(rangePayloads[rangeId] || {})),
          bytes: rangeFiles[rangeId]?.bytes || Buffer.byteLength(stringifyRuntimeJson(rangePayloads[rangeId] || {}), "utf8"),
          generatedAt: rangeFiles[rangeId]?.generatedAt || rangePayloads[rangeId]?.generatedAt || "",
          dataVersion,
          itemCount: itemCounts[rangeId],
          shards: shardFiles[rangeId] || null,
        },
      ]),
    ),
    diffs: Object.fromEntries(
      rangeIds.map((rangeId) => [
        rangeId,
        {
          path: `data/diff/latest-${rangeId}.json`,
        },
      ]),
    ),
  };
}

function runtimeRangeIds(rangePayloads, rangeFiles = {}) {
  const ids = RANGES.filter((rangeId) => rangePayloads?.[rangeId] || rangeFiles?.[rangeId]);
  return ids.length ? ids : LEGACY_RANGES;
}

function runtimeStatus(payload, runtime = {}) {
  if (!payload.status) return null;
  return {
    ...payload.status,
    capturedAt: runtime.capturedAt || payload.capturedAt || payload.generatedAt || "",
    dataCapturedAt: runtime.capturedAt || payload.capturedAt || payload.generatedAt || "",
    rebuiltDerivedAt: runtime.rebuiltDerivedAt || payload.source?.rebuiltDerivedAt || payload.status.rebuiltDerivedAt || "",
    dataVersion: runtime.dataVersion || "",
    itemCounts: runtime.itemCounts || null,
  };
}

function buildRuntimeRangePayload(payload, rangeId) {
  const group = groupForRange(payload.groups, rangeId) || { id: rangeId, title: rangeId, items: [] };
  const clientGroup = buildClientGroup(group);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: rangeId,
    canonicalRangeId: canonicalRangeId(rangeId),
    legacyRangeIds: LEGACY_RANGE_IDS[rangeId] || [],
    title: RANGE_TITLES[rangeId] || clientGroup.title,
    generatedAt: clientGroup.generatedAt || payload.generatedAt || "",
    capturedAt: payload.capturedAt || payload.generatedAt || "",
    curationVersion: payload.curationVersion || "",
    blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
    blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: groupHasNicheAnnotations(clientGroup),
    items: clientGroup.items,
  };
}

function buildClientGroup(group) {
  const items = (group.items || []).map(buildClientVideo).filter(Boolean);
  const titleArtistFallbacks = buildRuntimeTitleArtistFallbacks(items);
  return {
    id: group.id || "",
    title: group.title || group.id || "",
    generatedAt: group.generatedAt || "",
    updatedAt: group.updatedAt || "",
    items: items.map((item) => withRuntimeArtistFallbacks(item, titleArtistFallbacks)).filter(Boolean),
  };
}

function buildClientVideo(item) {
  const publishedTimestamp = finiteTimestamp(item.publishedTimestamp);
  const songs = (item.songs || []).map(buildClientSong).map((song) => cleanRuntimeSong(song, item)).filter(Boolean);
  if (songs.length === 0) return null;
  const result = {
    videoId: item.videoId || "",
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || channelIdFromChannelText(item.channelName),
    channelHandle: cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelName) || cleanChannelHandle(item.channelUrl || item.authorUrl || item.ownerUrl || item.sourceUrl),
    channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl || "",
    avatarUrl: item.avatarUrl || item.channelAvatarUrl || "",
    sourceUrl: item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl || "",
    knownSourceType: item.knownSourceType || knownSourceTypeForVideo(item),
    isCollected: isCollectedSource(item),
    keyword: item.keyword || "",
    publishedText: item.publishedText || "",
    publishedTimestamp,
    publishedAt: timestampToIso(publishedTimestamp),
    timeMissingReason: publishedTimestamp ? "" : timeMissingReasonForVideo(item),
    catalogFirstSeenAt: item.catalogFirstSeenAt || item.firstSeenAt || "",
    catalogLastSeenAt: item.catalogLastSeenAt || item.lastSeenAt || "",
    catalogLastInspectedAt: item.catalogLastInspectedAt || item.lastInspectedAt || "",
    thumbnailUrl: runtimeThumbnailUrl(item),
    songs,
  };
  const channelAliases = channelAliasValues(item.channelAliases);
  if (channelAliases.length) result.channelAliases = channelAliases;
  if (!result.channelUrl) delete result.channelUrl;
  return result;
}

function withRuntimeArtistFallbacks(item, titleArtistFallbacks = null) {
  if (!item || !titleArtistFallbacks?.size) return item;
  const songs = dedupeRuntimeSameSecondSongs(
    (item.songs || [])
      .map((song) => applyRuntimeArtistFallback(song, titleArtistFallbacks))
      .filter(Boolean),
  );
  if (!songs.length) return null;
  return {
    ...item,
    songs,
  };
}

function applyRuntimeArtistFallback(song, titleArtistFallbacks = null) {
  if (!song || !titleArtistFallbacks?.size || !RankingUtils.isUnknownArtistName(song.artist)) return song;
  const fallback = titleArtistFallbacks.get(runtimeSongWorkTitleKey(song.title));
  if (!fallback) return song;
  const title = cleanText(fallback.title) || cleanText(song.title);
  const artist = RankingUtils.canonicalizeArtistName(fallback.artist);
  if (!title || !artist || RankingUtils.isUnknownArtistName(artist)) return song;
  return {
    ...song,
    title,
    artist,
  };
}

function buildRuntimeTitleArtistFallbacks(items) {
  const records = new Map();
  for (const item of items || []) {
    for (const song of item?.songs || []) {
      const title = cleanRuntimeSafeTitleCandidate(song?.title);
      const artist = RankingUtils.canonicalizeArtistName(song?.artist);
      if (!title || !artist || RankingUtils.isUnknownArtistName(artist)) continue;
      const key = runtimeSongWorkTitleKey(title);
      if (!key) continue;
      if (!records.has(key)) {
        records.set(key, {
          titles: new Map(),
          artists: new Map(),
        });
      }
      const record = records.get(key);
      incrementCount(record.titles, title);
      incrementCount(record.artists, artist);
    }
  }

  const fallbacks = new Map();
  for (const [key, record] of records) {
    const title = dominantRuntimeCountName(record.titles);
    const artist = dominantRuntimeCountName(record.artists);
    if (title && artist) fallbacks.set(key, { title, artist });
  }
  return fallbacks;
}

function runtimeSongWorkTitleKey(value) {
  return RankingUtils.songWorkTitleKey(cleanRuntimeSafeTitleCandidate(value));
}

function dominantRuntimeCountName(map) {
  return Array.from(map.values()).sort((a, b) => b.count - a.count || compareValues(a.name, b.name))[0]?.name || "";
}

function dedupeRuntimeSameSecondSongs(songs) {
  const result = [];
  const seen = new Set();
  for (const song of songs || []) {
    const seconds = Math.max(0, Number(song?.seconds) || 0);
    const key = [Math.trunc(seconds), RankingUtils.songWorkTitleKey(song?.title), RankingUtils.normalizeArtistKey(song?.artist)].join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

function knownSourceTypeForVideo(item) {
  if (item.knownSourceType) return item.knownSourceType;
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  if (sourceGroups.includes("youtube_channel_discovery")) return "youtube_channel_discovery";
  if (sourceGroups.includes("vsinger-moment")) return "vsinger_moment_http";
  return item.sourceQuality?.sourceSystem || "";
}

function isCollectedSource(item) {
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  const knownType = String(item.knownSourceType || knownSourceTypeForVideo(item) || "").trim().toLocaleLowerCase();
  const sourceSystem = String(item.sourceQuality?.sourceSystem || "").trim().toLocaleLowerCase();
  const trueTypes = new Set(["manual", "verified", "song-search", "song_search", "youtube_channel_discovery"]);
  if (
    sourceGroups.includes("youtube_channel_discovery") ||
    trueTypes.has(knownType) ||
    (item.sourceQuality?.sourceType === "external" && !isMomentSourceType(sourceSystem))
  ) {
    return true;
  }
  if (isMomentSource(item)) return false;
  const explicit = item.isCollected;
  return explicit === true || explicit === 1 || String(explicit).toLocaleLowerCase() === "true";
}

function isMomentSource(item) {
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  const sourceSystem = String(item.sourceQuality?.sourceSystem || "").trim().toLocaleLowerCase();
  const knownType = String(item.knownSourceType || sourceSystem || "").trim().toLocaleLowerCase();
  return sourceGroups.includes("vsinger-moment") || isMomentSourceType(sourceSystem) || isMomentSourceType(knownType);
}

function isMomentSourceType(value) {
  const type = String(value || "").trim().toLocaleLowerCase();
  return type === "vsinger_moment_http" || type === "vsinger-moment" || type === "moment";
}

function timestampToIso(value) {
  return value ? new Date(value).toISOString() : "";
}

function timeMissingReasonForVideo(item) {
  if (!item?.videoId) return "missing_video_id";
  return "youtube_published_timestamp_unavailable";
}

function runtimeThumbnailUrl(item) {
  const videoId = item.videoId || "";
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return item.thumbnailUrl || "";
}

function buildClientSong(song) {
  return {
    seconds: Math.max(0, Number(song.seconds) || 0),
    title: song.title || "",
    artist: song.artist || "",
    isNiche: song.isNiche === true,
  };
}

function cleanRuntimeSong(song, source = {}) {
  const title = cleanRuntimeTitle(song?.title);
  if (!title) return null;
  let artist = String(song?.artist || "").trim();
  const normalized = normalizeSourceAwareArtist({ ...song, title, artist }, source);
  artist = String(normalized?.artist || "").trim();
  if (shouldDropRuntimeSong({ ...normalized, title, artist }, source)) return null;
  artist = cleanRuntimeArtist(artist);
  return {
    seconds: Math.max(0, Number(normalized.seconds) || 0),
    title,
    artist,
    isNiche: normalized.isNiche === true,
  };
}

function cleanRuntimeTitle(title) {
  let value = String(title || "").trim();
  value = value.replace(/^開始\s*[~〜～・･:：\-—–−/／|｜￤∣丨]+\s*/u, "").trim();
  return value;
}

function cleanRuntimeSafeTitleCandidate(title) {
  let value = cleanRuntimeTitle(title);
  for (let index = 0; index < 4; index += 1) {
    const next = value
      .normalize("NFKC")
      .replace(/^\s*[⟦［\[]\s*#?\d{1,4}\s*[⟧］\]]\s*/u, "")
      .replace(/^\s*[#＃]?\d{1,4}\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□]+/u, "")
      .replace(/^\s*[＊*]?\s*(?:[#＃]?\d{1,4}|[０-９]{1,4})\s*(?:曲目|曲|番目)?\s*[.)．。、,,:：)）\]\-|｜/／]+\s*/u, "")
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

function shouldDropRuntimeSong(song, source = {}) {
  const artist = cleanRuntimeArtist(song.artist);
  if (isKnownStartSong(song.title, artist)) return false;
  if (isLikelyNonSongEntry(song, source)) return true;
  if (isActivityMarkerTitle(song.title, artist || "未記載")) return true;
  if (isRuntimeActivityTitle(song.title, artist)) return true;
  return false;
}

function isKnownStartSong(title, artist) {
  if (normalizeRuntimeMarker(title) !== "start") return false;
  return Boolean(artist && artist !== "未記載");
}

function isRuntimeActivityTitle(title, artist) {
  const value = normalizeRuntimeMarker(title);
  const unknownArtist = !cleanRuntimeArtist(artist) || cleanRuntimeArtist(artist) === "未記載";
  if (/^(?:枠)?(?:start|streamstart|karaokestart|配信start|配信スタート|開始|配信開始|本編開始)$/iu.test(value)) return true;
  if (/^(?:setlist|セットリスト|セトリ|タイムスタンプ|曲名|歌唱開始時間)$/iu.test(value)) return true;
  if (/(?:setlist|セットリスト|セトリ|タイムスタンプ|曲名|歌唱開始時間)/iu.test(value)) {
    return true;
  }
  if (/(?:耐久開始を宣言|開始ツイート|開始前トーク|ツイートしてな|同時視聴開始|閉会式開始)/u.test(value)) return true;
  if (unknownArtist && /(?:同時視聴開始|復習タイム開始|後編開始|前編開始|謁見開始|閉会式開始|作成時間|セトリ変更|練習開始|耐久開始を宣言|開始$)/u.test(value)) {
    return true;
  }
  return false;
}

function cleanRuntimeArtist(artist) {
  let value = String(artist || "").trim();
  if (!value || value === "未記載") return "未記載";
  value = value.replace(/\s*[\(（][^()（）]*(?:開始|耐久|途中|ラグ|歌唱時間|歌えるまで)[^()（）]*[\)）]\s*/gu, "").trim();
  const marker = normalizeRuntimeMarker(value);
  if (!value || /^(?:未記載|未记载|不明|unknown|なし|-|歌唱開始時間|ラグにより途中開始)$/iu.test(marker)) return "未記載";
  if (/^(?:開始|配信開始|本編開始|歌唱開始時間|ラグにより途中開始|耐久開始)$/iu.test(marker)) return "未記載";
  return value;
}

function normalizeRuntimeMarker(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[【】[\]「」『』"'“”‘’]/gu, "")
    .replace(/^[\s~〜～・･:：\-—–−/／|｜￤∣丨]+|[\s~〜～・･:：\-—–−/／|｜￤∣丨]+$/gu, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function compactRankDiff(diff) {
  return {
    schemaVersion: diff.schemaVersion || RUNTIME_SCHEMA_VERSION,
    generatedAt: diff.generatedAt || "",
    capturedAt: diff.capturedAt || diff.generatedAt || "",
    range: diff.range || "",
    current: diff.current || null,
    previous: diff.previous || null,
    songRank: compactRankDiffEntries(diff.songRank),
    artistRank: compactRankDiffEntries(diff.artistRank),
  };
}

function compactRankDiffEntries(entries) {
  return (entries || [])
    .map((entry) => ({
      entityKey: entry.entityKey || "",
      rankDelta: entry.rankDelta ?? null,
      countDelta: Number(entry.countDelta) || 0,
      isNew: entry.isNew === true,
      currentRank: entry.currentRank,
    }))
    .filter((entry) => entry.entityKey)
    .filter((entry) => entry.currentRank == null || entry.currentRank <= RUNTIME_RANK_DIFF_LIMIT || entry.isNew)
    .filter((entry) => !(entry.rankDelta === 0 && entry.countDelta === 0 && entry.isNew === false))
    .map(({ currentRank, ...entry }) => entry);
}

function groupHasNicheAnnotations(group) {
  let songCount = 0;
  for (const item of group.items || []) {
    for (const song of item.songs || []) {
      songCount += 1;
      if (typeof song.isNiche !== "boolean") return false;
    }
  }
  return songCount > 0;
}

function diffPathForRange(rangeId) {
  return path.join(DATA_DIR, "diff", `latest-${rangeId}.json`);
}

function writeRuntimeShardSet(payload, rangePayload, rangeId, options = {}) {
  const sourceGroup = groupForRange(payload.groups, rangeId) || { items: [] };
  const dataVersion = options.dataVersion || rangePayload.dataVersion || "";
  const runtime = writePagedShard({
    kind: "runtime-page",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/ranges/${rangeId}`,
    pageSize: RUNTIME_PAGE_SIZE,
    records: rangePayload.items || [],
    recordName: "items",
  });
  const sourceDetails = writePagedShard({
    kind: "source-detail",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/source-details/${rangeId}`,
    pageSize: SOURCE_DETAIL_PAGE_SIZE,
    records: buildSourceDetailRecords(sourceGroup.items || []),
    recordName: "sources",
  });
  const search = writePagedShard({
    kind: "search",
    rangeId,
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
    baseDir: `data/ui/search/${rangeId}`,
    pageSize: SEARCH_PAGE_SIZE,
    records: buildSearchRecords(rangePayload.items || []),
    recordName: "records",
  });
  const request = writeRequestRuntimeSet(rangePayload, rangeId, {
    dataVersion,
    generatedAt: rangePayload.generatedAt || payload.generatedAt || "",
    capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
  });
  return { runtime, sourceDetails, search, request };
}

function summarizeRuntimeShardSet(shardSet) {
  return {
    runtime: summarizePagedShardSet(shardSet.runtime),
    sourceDetails: summarizePagedShardSet(shardSet.sourceDetails),
    search: summarizePagedShardSet(shardSet.search),
    request: shardSet.request,
  };
}

function writeRequestRuntimeSet(rangePayload, rangeId, options = {}) {
  const model = buildRequestRuntimeModel(rangePayload, rangeId, options);
  const { generatedAt, capturedAt, dataVersion, items, occurrences, occurrenceScopes, songScopes, artistScopes, vtuberScopes, videoScopes, sourceRecords, detailRecords, views } = model;
  cleanupRequestRuntimeFiles(rangeId);

  const sourceShardSet = writeKeyedRequestShardSet({
    kind: "request-source-detail",
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    baseDir: `data/ui/ranges/${rangeId}/sources`,
    pageSize: REQUEST_SOURCE_SHARD_SIZE,
    maxBytes: REQUEST_SOURCE_SHARD_MAX_BYTES,
    records: sourceRecords,
    recordName: "records",
  });
  const sourcePathByKey = new Map(sourceShardSet.records.map((record) => [record.key, record.path]));
  for (const recordMap of Object.values(detailRecords)) {
    for (const record of recordMap.values()) {
      if (!record.sourceDetailKey) continue;
      record.sourceDetailPath = sourcePathByKey.get(record.sourceDetailKey) || "";
    }
  }

  const detailShardSets = Object.fromEntries(
    Object.entries(detailRecords).map(([type, recordMap]) => [
      type,
      writeKeyedRequestShardSet({
        kind: `request-${type}-detail`,
        rangeId,
        dataVersion,
        generatedAt,
        capturedAt,
        baseDir: `data/ui/ranges/${rangeId}/records/${type}`,
        pageSize: REQUEST_DETAIL_SHARD_SIZE,
        maxBytes: REQUEST_DETAIL_SHARD_MAX_BYTES,
        records: Array.from(recordMap.values()),
        recordName: "records",
      }),
    ]),
  );
  applyDetailPathsToViews(views, detailShardSets);

  const summary = writeRequestSummary({
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    rangePayload: { ...rangePayload, items },
    occurrenceScopes,
    songScopes,
    artistScopes,
    vtuberScopes,
    videoScopes,
  });
  const viewArtifacts = writeRequestViews({
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    views,
    detailRecords,
  });
  const search = writeRequestSearch({
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    records: collectRequestSearchRecords(detailRecords),
  });

  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize: REQUEST_PAGE_SIZE,
    summary: summarizeRequestSummary(summary),
    views: summarizeRequestViews(viewArtifacts),
    records: Object.fromEntries(Object.entries(detailShardSets).map(([type, shardSet]) => [type, summarizeRequestShardSet(shardSet)])),
    sources: summarizeRequestShardSet(sourceShardSet),
    search: summarizeRequestSearch(search),
  };
}

function buildRequestRuntimeModel(rangePayload, rangeId, options = {}) {
  const generatedAt = options.generatedAt || rangePayload.generatedAt || "";
  const capturedAt = options.capturedAt || rangePayload.capturedAt || generatedAt;
  const dataVersion = options.dataVersion || rangePayload.dataVersion || "";
  const items = Array.isArray(rangePayload.items) ? rangePayload.items : [];
  const occurrences = collectRuntimeOccurrences(items);
  const sourceRecords = [];
  const detailRecords = {
    song: new Map(),
    artist: new Map(),
    vtuber: new Map(),
    video: new Map(),
  };
  const views = {};

  const occurrenceScopes = {
    all: occurrences,
    visible: filterUnknownRuntimeOccurrences(occurrences),
    niche: filterNicheRuntimeOccurrences(occurrences),
  };
  occurrenceScopes.visibleNiche = filterUnknownRuntimeOccurrences(occurrenceScopes.niche);

  const songScopes = {
    all: buildSongRequestRecords(occurrenceScopes.all),
    visible: buildSongRequestRecords(occurrenceScopes.visible),
    niche: buildSongRequestRecords(occurrenceScopes.niche),
    visibleNiche: buildSongRequestRecords(occurrenceScopes.visibleNiche),
  };
  const artistScopes = {
    all: buildArtistRequestRecords(occurrenceScopes.all),
    niche: buildArtistRequestRecords(occurrenceScopes.niche),
  };
  const videoScopes = {
    all: buildVideoRequestItems(items, { nicheOnly: false, hideUnknownArtists: false }),
    visible: buildVideoRequestItems(items, { nicheOnly: false, hideUnknownArtists: true }),
    niche: buildVideoRequestItems(items, { nicheOnly: true, hideUnknownArtists: false }),
    visibleNiche: buildVideoRequestItems(items, { nicheOnly: true, hideUnknownArtists: true }),
  };
  const vtuberScopes = {
    all: buildVtuberRequestItems(items, { nicheOnly: false }),
    niche: buildVtuberRequestItems(items, { nicheOnly: true }),
  };
  validateVtuberDisplayImages(vtuberScopes, rangeId);

  for (const [scopeKey, records] of Object.entries(songScopes)) {
    const occurrenceRecords = sortRankRecords(records, "occurrences");
    const videoRecords = sortRankRecords(records, "videos");
    setNestedView(views, ["songRank", "occurrences", scopeKey], buildRequestRecordView({
      type: "song",
      records: occurrenceRecords,
      metric: "occurrences",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
    }));
    setNestedView(views, ["songRank", "videos", scopeKey], buildRequestRecordView({
      type: "song",
      records: videoRecords,
      metric: "videos",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
    }));
    setNestedView(views, ["songAz", "index", scopeKey], buildRequestRecordView({
      type: "song",
      records: [...records].sort(compareSongAzRecords),
      metric: "occurrences",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
    }));
  }

  for (const [scopeKey, result] of Object.entries(artistScopes)) {
    const records = result.records || [];
    setNestedView(views, ["artistRank", "occurrences", scopeKey], buildRequestRecordView({
      type: "artist",
      records: sortRankRecords(records, "occurrences"),
      metric: "occurrences",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
      missingArtistCount: result.missingArtistCount,
    }));
    setNestedView(views, ["artistRank", "videos", scopeKey], buildRequestRecordView({
      type: "artist",
      records: sortRankRecords(records, "videos"),
      metric: "videos",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
      missingArtistCount: result.missingArtistCount,
    }));
  }

  for (const [scopeKey, records] of Object.entries(vtuberScopes)) {
    setNestedView(views, ["vtuberRank", "occurrences", scopeKey], buildRequestRecordView({
      type: "vtuber",
      records: sortRankRecords(records, "occurrences"),
      metric: "occurrences",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
    }));
    setNestedView(views, ["vtuberRank", "videos", scopeKey], buildRequestRecordView({
      type: "vtuber",
      records: sortRankRecords(records, "videos"),
      metric: "videos",
      scopeKey,
      pageSize: REQUEST_PAGE_SIZE,
      detailRecords,
      sourceRecords,
    }));
  }

  for (const [scopeKey, records] of Object.entries(videoScopes)) {
    setNestedView(views, ["videos", "index", scopeKey], buildRequestRecordView({
      type: "video",
      records,
      metric: "occurrences",
      scopeKey,
      pageSize: 24,
      detailRecords,
      sourceRecords,
    }));
  }

  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    items,
    occurrences,
    occurrenceScopes,
    songScopes,
    artistScopes,
    vtuberScopes,
    videoScopes,
    views,
    sourceRecords,
    detailRecords,
  };
}

function validateVtuberDisplayImages(vtuberScopes, rangeId) {
  for (const [scopeKey, records] of Object.entries(vtuberScopes || {})) {
    const missing = (records || []).filter((record) => !cleanText(record.avatarUrl) && !cleanText(record.thumbnailUrl || record.videoThumbnailUrl));
    if (missing.length) {
      const sample = missing
        .slice(0, 10)
        .map((record) => [record.channelHandle, record.channelId, record.name].filter(Boolean).join(" ") || record.key)
        .join(", ");
      throw new Error(`VTuber display image missing: range=${rangeId} scope=${scopeKey} count=${missing.length} sample=${sample}`);
    }
  }
}

function buildRequestRecordView(options) {
  const {
    type,
    records,
    metric,
    scopeKey,
    pageSize,
    detailRecords,
    sourceRecords,
    missingArtistCount = 0,
  } = options;
  const ranks = buildRequestRanks(records, metric);
  const frequencies = buildRequestCountFrequencies(records, metric);
  return {
    type,
    metric,
    scopeKey,
    pageSize,
    totalCount: records.length,
    missingArtistCount,
    indexEntries: records.map((record) => {
      const detailKey = registerRequestDetailRecord({ type, record, scopeKey, detailRecords, sourceRecords });
      return compactRequestIndexEntry(record, { type, metric, scopeKey, detailKey, rank: ranks.get(record.key || record.videoId), frequency: frequencies.get(requestRankValue(record, metric)) || 0 });
    }),
  };
}

function registerRequestDetailRecord({ type, record, scopeKey, detailRecords, sourceRecords }) {
  const sourceKey = record.key || record.videoId || "";
  const detailKey = `${scopeKey}:${sourceKey}`;
  const recordMap = detailRecords[type];
  if (recordMap.has(detailKey)) return detailKey;
  if (type === "song") {
    const sourceDetailKey = stableRequestKey(`song:${scopeKey}:${record.key}`);
    sourceRecords.push({
      key: sourceDetailKey,
      occurrences: (record.occurrences || []).map((occurrence) => serializeOccurrence(occurrence, { includeSongs: true })),
    });
    recordMap.set(detailKey, serializeSongRequestRecord(record, { detailKey, sourceDetailKey }));
  } else if (type === "artist") {
    const sourceDetailKey = stableRequestKey(`artist:${scopeKey}:${record.key}`);
    sourceRecords.push({
      key: sourceDetailKey,
      occurrences: (record.occurrences || []).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    });
    recordMap.set(detailKey, serializeArtistRequestRecord(record, { detailKey, sourceDetailKey }));
  } else if (type === "vtuber") {
    recordMap.set(detailKey, serializeVtuberRequestRecord(record, { detailKey }));
  } else {
    recordMap.set(detailKey, serializeVideoRequestRecord(record, { detailKey }));
  }
  return detailKey;
}

function compactRequestIndexEntry(record, options = {}) {
  const type = options.type || "song";
  const metric = options.metric || "occurrences";
  const count = Number(record.count) || 0;
  const videoCount = Number(record.videoCount) || 0;
  const key = record.key || record.videoId || "";
  const entry = {
    type,
    key,
    detailKey: options.detailKey || key,
    count,
    videoCount,
    rank: Number(options.rank) || 0,
    isTied: Number(options.frequency) > 1,
    rankValue: requestRankValue(record, metric),
    isNiche: type === "video" ? recordHasOnlyNicheSongs(record) : requestRecordIsNiche(record),
    hasUnknownArtist: requestRecordHasUnknownArtist(record),
    searchText: requestRecordSearchText(record, type),
  };
  if (type === "song") {
    entry.bucket = songIndexBucketForRequest(record);
    entry.sortKey = record.sortKey || record.title || "";
  } else if (type === "artist") {
    entry.songCount = record.songs?.size || record.songs?.length || 0;
  } else if (type === "vtuber") {
    entry.songCount = record.songs?.size || record.songs?.length || 0;
    entry.name = record.name || record.channelName || "";
    entry.channelName = record.channelName || record.name || "";
    entry.channelId = record.channelId || "";
    entry.channelHandle = record.channelHandle || "";
    entry.channelUrl = record.channelUrl || "";
    entry.avatarUrl = record.avatarUrl || "";
    entry.thumbnailUrl = record.thumbnailUrl || record.videoThumbnailUrl || "";
    entry.videoThumbnailUrl = record.videoThumbnailUrl || record.thumbnailUrl || "";
  } else if (type === "video") {
    entry.videoId = record.videoId || "";
    entry.publishedTimestamp = finiteTimestamp(record.publishedTimestamp);
    entry.songCount = Array.isArray(record.songs) ? record.songs.length : 0;
  }
  return entry;
}

function writeRequestSummary(options) {
  const { rangeId, dataVersion, generatedAt, capturedAt, rangePayload, occurrenceScopes, songScopes, artistScopes, vtuberScopes, videoScopes } = options;
  const summaryPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: "request-summary",
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    title: rangePayload.title || RANGE_TITLES[rangeId] || rangeId,
    itemCount: Array.isArray(rangePayload.items) ? rangePayload.items.length : 0,
    scopes: {
      all: requestScopeSummary(occurrenceScopes.all, songScopes.all, artistScopes.all, vtuberScopes.all, videoScopes.all),
      visible: requestScopeSummary(occurrenceScopes.visible, songScopes.visible, artistScopes.all, vtuberScopes.all, videoScopes.visible),
      niche: requestScopeSummary(occurrenceScopes.niche, songScopes.niche, artistScopes.niche, vtuberScopes.niche, videoScopes.niche),
      visibleNiche: requestScopeSummary(occurrenceScopes.visibleNiche, songScopes.visibleNiche, artistScopes.niche, vtuberScopes.niche, videoScopes.visibleNiche),
    },
  };
  const text = stringifyRuntimeJson(summaryPayload);
  const sha256 = sha256Text(text);
  const pathName = `data/ui/ranges/${rangeId}/summary.${sha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, pathName), text);
  return {
    path: pathName,
    sha256,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function requestScopeSummary(occurrences, songRecords, artistResult, vtuberRecords, videos) {
  return {
    occurrenceCount: occurrences.length,
    songCount: songRecords.length,
    artistCount: artistResult.records?.length || 0,
    vtuberCount: Array.isArray(vtuberRecords) ? vtuberRecords.length : 0,
    missingArtistCount: artistResult.missingArtistCount || 0,
    videoCount: Array.isArray(videos) ? videos.length : uniqueRuntimeVideoCount(occurrences),
  };
}

function writeRequestViews(options) {
  const { rangeId, dataVersion, generatedAt, capturedAt, views, detailRecords } = options;
  const result = {};
  for (const [viewName, viewValue] of Object.entries(views)) {
    result[viewName] = writeRequestViewNode({
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      viewName,
      node: viewValue,
      baseParts: ["data/ui/ranges", rangeId, "views", viewName],
      detailRecords,
    });
  }
  return result;
}

function writeRequestViewNode(options) {
  const { node } = options;
  if (node && Array.isArray(node.indexEntries)) return writeRequestViewVariant(options);
  const result = {};
  for (const [key, value] of Object.entries(node || {})) {
    result[key] = writeRequestViewNode({
      ...options,
      node: value,
      baseParts: [...options.baseParts, key],
    });
  }
  return result;
}

function writeRequestViewVariant(options) {
  const { rangeId, dataVersion, generatedAt, capturedAt, viewName, node, baseParts, detailRecords } = options;
  const baseDir = baseParts.join("/");
  const indexPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: "request-view-index",
    rangeId,
    view: viewName,
    metric: node.metric,
    scopeKey: node.scopeKey,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize: node.pageSize,
    totalCount: node.indexEntries.length,
    missingArtistCount: node.missingArtistCount || 0,
    records: node.indexEntries,
  };
  const indexText = stringifyRuntimeJson(indexPayload);
  const indexSha256 = sha256Text(indexText);
  const indexPath = `${baseDir}/index.${indexSha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, indexPath), indexText);

  const pages = chunkArray(node.indexEntries, node.pageSize).map((entries, index) => {
    const pageIndex = index + 1;
    const pagePayload = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind: "request-view-page",
      rangeId,
      view: viewName,
      metric: node.metric,
      scopeKey: node.scopeKey,
      dataVersion,
      generatedAt,
      capturedAt,
      page: pageIndex,
      pageCount: Math.ceil(node.indexEntries.length / node.pageSize) || 1,
      pageSize: node.pageSize,
      totalCount: node.indexEntries.length,
      indexEntries: entries,
      records: entries.map(compactRequestPageRecord),
    };
    const text = stringifyRuntimeJson(pagePayload);
    const sha256 = sha256Text(text);
    const pagePath = `${baseDir}/page-${String(pageIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
    writeRuntimeJsonText(path.join(ROOT, pagePath), text);
    return {
      index: pageIndex,
      path: pagePath,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: entries.length,
    };
  });
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: "request-view-manifest",
    rangeId,
    view: viewName,
    metric: node.metric,
    scopeKey: node.scopeKey,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize: node.pageSize,
    totalCount: node.indexEntries.length,
    pageCount: pages.length,
    indexPath,
    bootstrapPath: pages[0]?.path || "",
    pages,
  };
  const manifestText = stringifyRuntimeJson(manifestPayload);
  const manifestSha256 = sha256Text(manifestText);
  const manifestPath = `${baseDir}/manifest.${manifestSha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), manifestText);
  writeRuntimeJsonText(path.join(ROOT, `${baseDir}/manifest.json`), manifestText);
  return {
    manifestPath,
    manifestLegacyPath: `${baseDir}/manifest.json`,
    view: viewName,
    metric: node.metric,
    scopeKey: node.scopeKey,
    indexPath,
    bootstrapPath: pages[0]?.path || "",
    sha256: manifestSha256,
    bytes: Buffer.byteLength(manifestText, "utf8"),
    pageSize: node.pageSize,
    totalCount: node.indexEntries.length,
    pageCount: pages.length,
    pages,
  };
}

function compactRequestPageRecord(entry) {
  return { ...entry };
}

function summarizeRequestViews(node) {
  if (!node || typeof node !== "object") return node;
  if (node.manifestPath) {
    return {
      manifestPath: node.manifestPath,
      view: node.view,
      metric: node.metric,
      scopeKey: node.scopeKey,
      bootstrapPath: node.bootstrapPath,
      pageSize: node.pageSize,
      totalCount: node.totalCount,
      pageCount: node.pageCount,
    };
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, summarizeRequestViews(value)]));
}

function summarizeRequestSummary(summary) {
  return {
    path: summary.path,
  };
}

function summarizeRequestSearch(search) {
  return {
    manifestPath: search.manifestPath,
    bucketCount: search.bucketCount,
  };
}

function writeRequestSearch(options) {
  const { rangeId, dataVersion, generatedAt, capturedAt, records } = options;
  const buckets = new Map();
  for (const record of records) {
    for (const bucket of requestSearchBuckets(record.searchText)) {
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(record);
    }
  }
  const bucketEntries = [];
  for (const [bucket, bucketRecords] of Array.from(buckets.entries()).sort((a, b) => a[0].localeCompare(b[0], "en"))) {
    const payloadBase = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind: "request-search-page",
      rangeId,
      bucket,
      dataVersion,
      generatedAt,
      capturedAt,
    };
    const chunks = chunkRecordsByPayloadBytes(bucketRecords, {
      maxBytes: REQUEST_SEARCH_SHARD_MAX_BYTES,
      pageSize: REQUEST_SEARCH_SHARD_SIZE,
      payloadBase,
      recordName: "records",
    });
    const pages = chunks.map((chunk, index) => {
      const pageIndex = index + 1;
      const payload = {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        kind: "request-search-page",
        rangeId,
        bucket,
        dataVersion,
        generatedAt,
        capturedAt,
        page: pageIndex,
        pageCount: chunks.length,
        records: chunk,
      };
      const text = stringifyRuntimeJson(payload);
      const sha256 = sha256Text(text);
      const pagePath = `data/ui/ranges/${rangeId}/search/${requestBucketPathSegment(bucket)}/page-${String(pageIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
      writeRuntimeJsonText(path.join(ROOT, pagePath), text);
      return {
        index: pageIndex,
        path: pagePath,
        sha256,
        bytes: Buffer.byteLength(text, "utf8"),
        itemCount: chunk.length,
      };
    });
    bucketEntries.push([bucket, { pageCount: pages.length, itemCount: bucketRecords.length, pages }]);
  }
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: "request-search-manifest",
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    bucketCount: bucketEntries.length,
    buckets: Object.fromEntries(bucketEntries),
  };
  const manifestText = stringifyRuntimeJson(manifestPayload);
  const sha256 = sha256Text(manifestText);
  const manifestPath = `data/ui/ranges/${rangeId}/search/manifest.${sha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), manifestText);
  writeRuntimeJsonText(path.join(ROOT, `data/ui/ranges/${rangeId}/search/manifest.json`), manifestText);
  return {
    manifestPath,
    manifestLegacyPath: `data/ui/ranges/${rangeId}/search/manifest.json`,
    sha256,
    bytes: Buffer.byteLength(manifestText, "utf8"),
    bucketCount: bucketEntries.length,
  };
}

function writeRequestSourceFiles(options) {
  const { rangeId, dataVersion, generatedAt, capturedAt, records } = options;
  const entries = [];
  for (const record of records) {
    const payload = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind: "request-source-detail",
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      key: record.key,
      occurrences: record.occurrences || [],
    };
    const text = stringifyRuntimeJson(payload);
    const sha256 = sha256Text(text);
    const pathName = `data/ui/ranges/${rangeId}/sources/${encodeURIComponent(record.key)}.${sha256.slice(0, 12)}.json`;
    writeRuntimeJsonText(path.join(ROOT, pathName), text);
    entries.push({
      key: record.key,
      path: pathName,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: record.occurrences?.length || 0,
    });
  }
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: "request-source-detail-manifest",
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    itemCount: records.length,
    totalOccurrenceCount: entries.reduce((sum, entry) => sum + entry.itemCount, 0),
  };
  const manifestText = stringifyRuntimeJson(manifestPayload);
  const sha256 = sha256Text(manifestText);
  const manifestPath = `data/ui/ranges/${rangeId}/sources/manifest.${sha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), manifestText);
  writeRuntimeJsonText(path.join(ROOT, `data/ui/ranges/${rangeId}/sources/manifest.json`), manifestText);
  return {
    records: entries,
    summary: {
      manifestPath,
      manifestLegacyPath: `data/ui/ranges/${rangeId}/sources/manifest.json`,
      sha256,
      bytes: Buffer.byteLength(manifestText, "utf8"),
      itemCount: records.length,
      totalOccurrenceCount: manifestPayload.totalOccurrenceCount,
    },
  };
}

function writeKeyedRequestShardSet(options) {
  const { kind, rangeId, dataVersion, generatedAt, capturedAt, baseDir, pageSize, records, recordName } = options;
  const maxBytes = Number(options.maxBytes) || 0;
  const chunks = maxBytes
    ? chunkRecordsByPayloadBytes(records, {
        maxBytes,
        pageSize,
        buildPayload: (chunk, pageIndex, pageCount) => ({
          schemaVersion: RUNTIME_SCHEMA_VERSION,
          kind,
          rangeId,
          dataVersion,
          generatedAt,
          capturedAt,
          page: pageIndex,
          pageCount,
          pageSize,
          itemCount: chunk.length,
          [recordName]: chunk,
        }),
      })
    : chunkArray(records, pageSize);
  const pageCount = chunks.length || 1;
  const pages = chunks.map((chunk, index) => {
    const pageIndex = index + 1;
    const payload = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind,
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      page: pageIndex,
      pageCount,
      pageSize,
      itemCount: chunk.length,
      [recordName]: chunk,
    };
    const text = stringifyRuntimeJson(payload);
    const sha256 = sha256Text(text);
    const pathName = `${baseDir}/shard-${String(pageIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
    writeRuntimeJsonText(path.join(ROOT, pathName), text);
    return {
      index: pageIndex,
      path: pathName,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: chunk.length,
      keys: chunk.map((record) => record.detailKey || record.key).filter(Boolean),
    };
  });
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: `${kind}-manifest`,
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages: pages.map(({ keys, ...page }) => page),
  };
  const text = stringifyRuntimeJson(manifestPayload);
  const sha256 = sha256Text(text);
  const manifestPath = `${baseDir}/manifest.${sha256.slice(0, 12)}.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), text);
  writeRuntimeJsonText(path.join(ROOT, `${baseDir}/manifest.json`), text);
  const pathByKey = new Map();
  for (const page of pages) {
    for (const key of page.keys) pathByKey.set(key, page.path);
  }
  return {
    manifestPath,
    manifestLegacyPath: `${baseDir}/manifest.json`,
    sha256,
    bytes: Buffer.byteLength(text, "utf8"),
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages,
    records: Array.from(pathByKey.entries()).map(([key, pathName]) => ({ key, path: pathName })),
    pathByKey,
  };
}

function chunkRecordsByPayloadBytes(records, options = {}) {
  if (options.payloadBase && options.recordName) {
    return chunkRecordsByPayloadBytesFast(records, options);
  }
  const pageSize = positiveInteger(options.pageSize, records.length || 1);
  const maxBytes = positiveInteger(options.maxBytes, Number.MAX_SAFE_INTEGER);
  const buildPayload = options.buildPayload;
  const chunks = [];
  let chunk = [];
  for (const record of records || []) {
    if (chunk.length >= pageSize) {
      chunks.push(chunk);
      chunk = [];
    }
    if (chunk.length) {
      const nextPayload = buildPayload([...chunk, record], 1, 1);
      const nextBytes = Buffer.byteLength(stringifyRuntimeJson(nextPayload), "utf8");
      if (nextBytes > maxBytes) {
        chunks.push(chunk);
        chunk = [];
      }
    }
    chunk.push(record);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function chunkRecordsByPayloadBytesFast(records, options = {}) {
  const pageSize = positiveInteger(options.pageSize, records.length || 1);
  const maxBytes = positiveInteger(options.maxBytes, Number.MAX_SAFE_INTEGER);
  const payloadBase = options.payloadBase || {};
  const recordName = options.recordName || "records";
  const chunks = [];
  let chunk = [];
  let chunkRecordsBytes = 0;
  const overheadPayload = { ...payloadBase, page: 999999, pageCount: 999999, [recordName]: [] };
  const overheadBytes = Buffer.byteLength(stringifyRuntimeJson(overheadPayload), "utf8");
  for (const record of records || []) {
    const recordBytes = Buffer.byteLength(stringifyRuntimeJson(record), "utf8");
    const separatorBytes = chunk.length ? 1 : 0;
    const nextBytes = overheadBytes + chunkRecordsBytes + separatorBytes + recordBytes;
    if (chunk.length && (chunk.length >= pageSize || nextBytes > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      chunkRecordsBytes = 0;
    }
    chunkRecordsBytes += (chunk.length ? 1 : 0) + recordBytes;
    chunk.push(record);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function cleanupRequestRuntimeFiles(rangeId) {
  const rangeDir = path.join(UI_DIR, "ranges", rangeId);
  for (const dirName of ["records", "sources", "views", "search"]) {
    fs.rmSync(path.join(rangeDir, dirName), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
  if (!fs.existsSync(rangeDir)) return;
  for (const file of fs.readdirSync(rangeDir, { withFileTypes: true })) {
    if (file.isFile() && /^summary\.[a-f0-9]{12}\.json$/u.test(file.name)) {
      fs.unlinkSync(path.join(rangeDir, file.name));
    }
  }
}

function summarizePagedShardSet(shardSet) {
  if (!shardSet) return null;
  return {
    manifestPath: shardSet.manifestPath,
    manifestLegacyPath: shardSet.manifestLegacyPath,
    sha256: shardSet.sha256,
    bytes: shardSet.bytes,
    pageSize: shardSet.pageSize,
    itemCount: shardSet.itemCount,
    pageCount: shardSet.pageCount,
  };
}

function summarizeRequestShardSet(shardSet) {
  return {
    manifestPath: shardSet.manifestPath,
    manifestLegacyPath: shardSet.manifestLegacyPath,
    sha256: shardSet.sha256,
    bytes: shardSet.bytes,
    pageSize: shardSet.pageSize,
    itemCount: shardSet.itemCount,
    pageCount: shardSet.pageCount,
  };
}

function applyDetailPathsToViews(views, detailShardSets) {
  walkRequestViews(views, (view) => {
    for (const entry of view.indexEntries || []) {
      const pathName = detailShardSets[entry.type]?.pathByKey?.get(entry.detailKey) || "";
      entry.detailShard = pathName;
    }
  });
}

function walkRequestViews(node, callback) {
  if (node && Array.isArray(node.indexEntries)) {
    callback(node);
    return;
  }
  for (const value of Object.values(node || {})) walkRequestViews(value, callback);
}

function collectRequestSearchRecords(detailRecords) {
  const result = [];
  for (const [type, recordMap] of Object.entries(detailRecords)) {
    for (const record of recordMap.values()) {
      result.push({
        type,
        key: record.key || record.videoId || "",
        detailKey: record.detailKey,
        label: record.title || record.name || record.videoId || "",
        meta: record.displayArtist || record.channelName || "",
        searchText: record.searchText || requestRecordSearchText(record, type),
      });
    }
  }
  return result;
}

function requestSearchBuckets(searchText) {
  const normalized = normalizeSearchText(searchText);
  const buckets = new Set();
  for (const token of normalized.split(/\s+/u)) {
    const char = token[0] || "";
    if (!char) continue;
    buckets.add(requestSearchBucketId(char));
    if (buckets.size >= 64) break;
  }
  if (!buckets.size) buckets.add("_");
  return buckets;
}

function requestBucketPathSegment(bucket) {
  return Buffer.from(String(bucket || "_"), "utf8").toString("hex") || "5f";
}

function requestSearchBucketId(value) {
  const char = String(value || "_");
  const code = char.codePointAt(0) || 95;
  return `b${String(code % 64).padStart(2, "0")}`;
}

function collectRuntimeOccurrences(items) {
  const occurrences = [];
  for (const item of items || []) {
    for (const song of item.songs || []) {
      if (!cleanText(song.title)) continue;
      occurrences.push({
        item,
        song,
        searchText: normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  return occurrences;
}

function filterNicheRuntimeOccurrences(occurrences) {
  return (occurrences || []).filter((occurrence) => occurrence.song?.isNiche === true);
}

function filterUnknownRuntimeOccurrences(occurrences) {
  return (occurrences || []).filter((occurrence) => !RankingUtils.isUnknownArtistName(occurrence.song?.artist));
}

function buildSongRequestRecords(occurrences) {
  return addRequestRecordFields(RankingUtils.buildSongRecords(occurrences));
}

function buildArtistRequestRecords(occurrences) {
  const result = RankingUtils.buildArtistRecords(occurrences);
  return {
    ...result,
    records: addRequestRecordFields(result.records || []),
  };
}

function addRequestRecordFields(records) {
  for (const record of records || []) {
    if (typeof record.videoCount !== "number") record.videoCount = uniqueRuntimeVideoCount(record.occurrences || []);
    record.searchText = requestRecordSearchText(record, record.type || (record.name ? "artist" : "song"));
  }
  return records;
}

function buildVideoRequestItems(items, options = {}) {
  const nicheOnly = Boolean(options.nicheOnly);
  const hideUnknownArtists = Boolean(options.hideUnknownArtists);
  const result = [];
  for (const item of items || []) {
    const scopedSongs = (item.songs || [])
      .filter((song) => !nicheOnly || song.isNiche === true)
      .filter((song) => !hideUnknownArtists || !RankingUtils.isUnknownArtistName(song.artist));
    if (!scopedSongs.length) continue;
    result.push({
      ...item,
      songs: scopedSongs,
      _allSongs: item.songs || [],
      count: scopedSongs.length,
      videoCount: 1,
      key: item.videoId || stableRequestKey(`${item.channelName}:${item.title}`),
      searchText: normalizeSearchText(
        [item.videoId, item.title, ...channelSearchParts(item), item.keyword, ...scopedSongs.flatMap((song) => [song.title, song.artist])].join(" "),
      ),
    });
  }
  return result;
}

function buildVtuberRequestItems(items, options = {}) {
  const nicheOnly = Boolean(options.nicheOnly);
  const records = new Map();
  const identityLookup = buildChannelIdentityLookup(items, { nicheOnly });
  for (const item of items || []) {
    const scopedSongs = (item.songs || [])
      .filter((song) => cleanText(song.title))
      .filter((song) => !nicheOnly || song.isNiche === true);
    if (!scopedSongs.length) continue;
    const key = channelRecordKey(item, identityLookup);
    if (!key) continue;
    if (!records.has(key)) {
      records.set(key, {
        type: "vtuber",
        key,
        name: cleanText(item.channelName || cleanChannelHandle(item.channelHandle) || item.channelId || "未知频道"),
        channelName: cleanText(item.channelName),
        channelId: cleanText(item.channelId),
        channelHandle: cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelUrl || item.authorUrl || item.ownerUrl || item.sourceUrl),
        channelUrl: cleanText(item.channelUrl || item.authorUrl || item.ownerUrl),
        avatarUrl: cleanText(item.avatarUrl || item.channelAvatarUrl),
        thumbnailUrl: vtuberThumbnailCandidate(item),
        videoThumbnailUrl: vtuberThumbnailCandidate(item),
        count: 0,
        videoCount: 0,
        timestampCount: 0,
        videos: new Set(),
        songs: new Map(),
        occurrences: [],
        aliases: new Set(),
      });
    }
    const record = records.get(key);
    mergeChannelRecordIdentity(record, item);
    const videoKey = item.videoId || stableRequestKey(`${item.channelName}:${item.title}:${item.publishedTimestamp || ""}`);
    if (videoKey) record.videos.add(videoKey);
    for (const song of scopedSongs) {
      record.count += 1;
      record.timestampCount += 1;
      incrementCount(record.songs, cleanText(song.title));
      record.occurrences.push({
        item,
        song,
        searchText: normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  return Array.from(records.values()).map((record) => {
    record.videoCount = record.videos.size;
    record.aliases = Array.from(record.aliases.values());
    record.searchText = requestRecordSearchText(record, "vtuber");
    return record;
  });
}

function buildChannelIdentityLookup(items, options = {}) {
  const nicheOnly = Boolean(options.nicheOnly);
  const nameToKey = new Map();
  const ambiguousNames = new Set();
  for (const item of items || []) {
    const scopedSongs = (item.songs || [])
      .filter((song) => cleanText(song.title))
      .filter((song) => !nicheOnly || song.isNiche === true);
    if (!scopedSongs.length) continue;
    const nameKey = channelNameIdentityKey(item);
    const directKey = directChannelRecordKey(item);
    if (!nameKey || !directKey) continue;
    const existing = nameToKey.get(nameKey);
    if (existing && existing !== directKey) {
      ambiguousNames.add(nameKey);
      continue;
    }
    nameToKey.set(nameKey, directKey);
  }
  for (const nameKey of ambiguousNames) nameToKey.delete(nameKey);
  return { nameToKey };
}

function channelRecordKey(item, identityLookup = null) {
  const nameKey = channelNameIdentityKey(item);
  if (nameKey && identityLookup?.nameToKey?.has(nameKey)) return identityLookup.nameToKey.get(nameKey);
  return directChannelRecordKey(item) || nameKey;
}

function directChannelRecordKey(item) {
  const channelId = cleanText(item?.channelId) || channelIdFromChannelText(item?.channelName);
  if (channelId) return channelId;
  const handle = (cleanChannelHandle(item?.channelHandle) || cleanChannelHandle(item?.channelName)).replace(/^\/+/, "");
  if (handle) return normalizeSearchText(handle);
  const urlHandle = handleFromChannelUrl(item?.channelUrl || item?.authorUrl || item?.ownerUrl);
  if (urlHandle) return normalizeSearchText(urlHandle);
  return "";
}

function channelIdFromChannelText(value) {
  const text = cleanText(value);
  const direct = text.match(/^UC[A-Za-z0-9_-]{20,}$/u);
  if (direct) return direct[0];
  const path = text.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})$/u);
  if (path) return path[1];
  const url = text.match(/^https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})(?:[/?#]|$)/iu);
  return url ? url[1] : "";
}

function handleFromChannelUrl(value) {
  const match = String(value || "").match(/youtube\.com\/(@[A-Za-z0-9._%~-]+)/iu);
  return match ? match[1] : "";
}

function channelNameIdentityKey(item) {
  const name = cleanText(item?.channelName);
  return name ? normalizeSearchText(name) : "";
}

function mergeChannelRecordIdentity(record, item) {
  const channelName = cleanText(item.channelName);
  const channelId = cleanText(item.channelId) || channelIdFromChannelText(channelName);
  const channelHandle = cleanChannelHandle(item.channelHandle) || cleanChannelHandle(channelName);
  const channelUrl = cleanText(item.channelUrl || item.authorUrl || item.ownerUrl);
  const avatarUrl = cleanText(item.avatarUrl || item.channelAvatarUrl);
  const thumbnailUrl = vtuberThumbnailCandidate(item);
  if (channelName) {
    record.aliases.add(channelName);
    record.channelName = preferredChannelDisplayName(record.channelName, channelName);
    record.name = preferredChannelDisplayName(record.name === "未知频道" ? "" : record.name, record.channelName || channelName);
  }
  if (channelId) {
    record.aliases.add(channelId);
    if (!record.channelId) record.channelId = channelId;
  }
  if (channelHandle) {
    record.aliases.add(channelHandle);
    record.aliases.add(channelHandle.replace(/^\/?@/u, ""));
    if (!record.channelHandle) record.channelHandle = channelHandle;
  }
  if (channelUrl) {
    record.aliases.add(channelUrl);
    if (!record.channelUrl) record.channelUrl = channelUrl;
  }
  if (avatarUrl && !record.avatarUrl) record.avatarUrl = avatarUrl;
  if (thumbnailUrl && shouldUseVtuberThumbnail(record, item)) {
    record.thumbnailUrl = thumbnailUrl;
    record.videoThumbnailUrl = thumbnailUrl;
  }
  for (const alias of knownChannelSearchAliases(channelName)) record.aliases.add(alias);
}

function vtuberThumbnailCandidate(item) {
  return cleanText(item.thumbnailUrl || item.videoThumbnail || item.videoThumbnailUrl || item.thumbnail || thumbnailUrlForVideo(item));
}

function shouldUseVtuberThumbnail(record, item) {
  if (!record.thumbnailUrl) {
    record.thumbnailPublishedTimestamp = Number(item.publishedTimestamp) || 0;
    return true;
  }
  const incomingTimestamp = Number(item.publishedTimestamp) || 0;
  const currentTimestamp = Number(record.thumbnailPublishedTimestamp) || 0;
  if (incomingTimestamp >= currentTimestamp) {
    record.thumbnailPublishedTimestamp = incomingTimestamp;
    return true;
  }
  return false;
}

function knownChannelSearchAliases(channelName) {
  const key = normalizeSearchText(channelName);
  if (key === normalizeSearchText("Haru Ch. 花前ハル")) return ["HanamaeHaru", "Hanamae Haru", "花前ハル"];
  return [];
}

function serializeSongRequestRecord(record, options = {}) {
  const occurrences = record.occurrences || [];
  return {
    type: "song",
    detailKey: options.detailKey,
    key: record.key || "",
    title: record.title || "",
    workTitle: record.workTitle || record.title || "",
    sortKey: record.sortKey || record.title || "",
    count: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || uniqueRuntimeVideoCount(occurrences),
    displayArtist: record.displayArtist || "",
    artists: serializeCountMap(record.artists),
    channels: serializeCountMap(record.channels),
    variantLabels: Array.isArray(record.variantLabels) ? record.variantLabels : [],
    occurrences: occurrences.slice(0, REQUEST_PREVIEW_SOURCE_LIMIT).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    sourceDetailKey: options.sourceDetailKey || "",
    sourceDetailPath: "",
    searchText: requestRecordSearchText(record, "song"),
  };
}

function serializeArtistRequestRecord(record, options = {}) {
  const occurrences = record.occurrences || [];
  return {
    type: "artist",
    detailKey: options.detailKey,
    key: record.key || "",
    name: record.name || "",
    count: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || uniqueRuntimeVideoCount(occurrences),
    songs: serializeCountMap(record.songs),
    channels: serializeCountMap(record.channels),
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    occurrences: occurrences.slice(0, REQUEST_PREVIEW_SOURCE_LIMIT).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    sourceDetailKey: options.sourceDetailKey || "",
    sourceDetailPath: "",
    searchText: requestRecordSearchText(record, "artist"),
  };
}

function serializeVtuberRequestRecord(record, options = {}) {
  return {
    type: "vtuber",
    detailKey: options.detailKey,
    key: record.key || "",
    name: record.name || record.channelName || "",
    channelName: record.channelName || record.name || "",
    channelId: record.channelId || "",
    channelHandle: record.channelHandle || "",
    channelUrl: record.channelUrl || "",
    avatarUrl: record.avatarUrl || "",
    thumbnailUrl: record.thumbnailUrl || record.videoThumbnailUrl || "",
    videoThumbnailUrl: record.videoThumbnailUrl || record.thumbnailUrl || "",
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    count: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || 0,
    timestampCount: Number(record.timestampCount ?? record.count) || 0,
    songs: serializeCountMap(record.songs),
    occurrences: (record.occurrences || []).slice(0, REQUEST_PREVIEW_SOURCE_LIMIT).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    sourceDetailKey: "",
    sourceDetailPath: "",
    searchText: requestRecordSearchText(record, "vtuber"),
  };
}

function serializeVideoRequestRecord(record, options = {}) {
  const item = buildClientVideo({
    ...record,
    songs: record.songs || [],
  });
  return {
    ...item,
    type: "video",
    detailKey: options.detailKey,
    key: record.key || record.videoId || "",
    count: Number(record.count) || item.songs.length,
    videoCount: 1,
    _allSongs: Array.isArray(record._allSongs) ? record._allSongs.map(buildClientSong) : item.songs,
    _displaySongs: item.songs,
    searchText: record.searchText || requestRecordSearchText(record, "video"),
  };
}

function serializeOccurrence(occurrence, options = {}) {
  const item = occurrence.item || {};
  const itemSongs = options.includeSongs
    ? item.songs || []
    : options.includeCurrentSong && occurrence.song
      ? [occurrence.song]
      : [];
  const serializedItem = buildClientVideo({
    ...item,
    songs: itemSongs,
  });
  if (options.includeSongs && !serializedItem._allSongs) serializedItem._allSongs = serializedItem.songs;
  return {
    item: serializedItem,
    song: buildClientSong(occurrence.song || {}),
    searchText:
      occurrence.searchText ||
      normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, occurrence.song?.title, occurrence.song?.artist].join(" ")),
  };
}

function serializeCountMap(value) {
  if (value instanceof Map) {
    return Array.from(value.values()).map((entry) => ({
      key: entry.key || normalizeSearchText(entry.name),
      name: entry.name || entry.title || "",
      count: Number(entry.count) || 0,
    }));
  }
  if (Array.isArray(value)) return value;
  return [];
}

function requestRecordSearchText(record, type) {
  if (type === "artist") {
    return normalizeSearchText([record.name, ...(record.aliases || [])].join(" "));
  }
  if (type === "vtuber") {
    return normalizeSearchText([record.name, ...channelSearchParts(record), ...(record.aliases || [])].join(" "));
  }
  if (type === "video") {
    return normalizeSearchText([record.videoId, record.title, ...channelSearchParts(record), record.keyword, ...(record.songs || []).flatMap((song) => [song.title, song.artist])].join(" "));
  }
  return normalizeSearchText([record.title, record.displayArtist, ...mapNames(record.artists), ...mapNames(record.channels), ...(record.variantLabels || []), ...occurrenceSearchParts(record.occurrences)].join(" "));
}

function mapNames(value) {
  if (value instanceof Map) return Array.from(value.values()).map((entry) => entry.name || entry.title || "");
  if (Array.isArray(value)) return value.map((entry) => entry.name || entry.title || "");
  if (value && typeof value === "object") return Object.values(value).map((entry) => entry?.name || entry?.title || entry || "");
  return [];
}

function occurrenceSearchParts(occurrences) {
  return (occurrences || []).flatMap((occurrence) => {
    const item = occurrence.item || {};
    const song = occurrence.song || {};
    return [item.videoId, item.title, ...channelSearchParts(item), item.keyword, song.title, song.artist];
  });
}

function sortRankRecords(records, metric) {
  return [...records].sort((a, b) => requestRankValue(b, metric) - requestRankValue(a, metric) || compareValues(a.name || a.sortKey || a.title || a.key, b.name || b.sortKey || b.title || b.key));
}

function compareSongAzRecords(a, b) {
  return compareValues(a.sortKey, b.sortKey) || (Number(b.count) || 0) - (Number(a.count) || 0) || compareValues(a.title, b.title);
}

function requestRankValue(record, metric) {
  return metric === "videos" ? Number(record.videoCount) || 0 : Number(record.count) || 0;
}

function buildRequestRanks(records, metric) {
  const ranks = new Map();
  let previousValue = null;
  let currentRank = 0;
  records.forEach((record, index) => {
    const value = requestRankValue(record, metric);
    if (value !== previousValue) {
      currentRank = index + 1;
      previousValue = value;
    }
    ranks.set(record.key || record.videoId, currentRank);
  });
  return ranks;
}

function buildRequestCountFrequencies(records, metric) {
  const frequencies = new Map();
  for (const record of records) {
    const value = requestRankValue(record, metric);
    frequencies.set(value, (frequencies.get(value) || 0) + 1);
  }
  return frequencies;
}

function requestRecordIsNiche(record) {
  const occurrences = record.occurrences || [];
  return occurrences.length > 0 && occurrences.every((occurrence) => occurrence.song?.isNiche === true);
}

function recordHasOnlyNicheSongs(record) {
  const songs = record.songs || [];
  return songs.length > 0 && songs.every((song) => song.isNiche === true);
}

function requestRecordHasUnknownArtist(record) {
  const occurrences = record.occurrences || [];
  if (occurrences.length) return occurrences.some((occurrence) => RankingUtils.isUnknownArtistName(occurrence.song?.artist));
  return (record.songs || []).some((song) => RankingUtils.isUnknownArtistName(song.artist));
}

function uniqueRuntimeVideoCount(occurrences) {
  return new Set((occurrences || []).map((occurrence) => occurrence.item?.videoId).filter(Boolean)).size;
}

function songIndexBucketForRequest(record) {
  const title = cleanText(record.title);
  const first = title[0] || "";
  if (/^[A-Za-z]$/u.test(first)) return first.toUpperCase();
  if (/^\d$/u.test(first)) return "0-9";
  if (/^\p{Script=Han}$/u.test(first)) return "汉字";
  if (/^[ぁ-ん]/u.test(first)) return kanaBucketForRequest(first);
  return "其他";
}

function kanaBucketForRequest(value) {
  if (/^[ぁ-お]/u.test(value)) return "あ";
  if (/^[か-ご]/u.test(value)) return "か";
  if (/^[さ-ぞ]/u.test(value)) return "さ";
  if (/^[た-ど]/u.test(value)) return "た";
  if (/^[な-の]/u.test(value)) return "な";
  if (/^[は-ぽ]/u.test(value)) return "は";
  if (/^[ま-も]/u.test(value)) return "ま";
  if (/^[ゃ-よ]/u.test(value)) return "や";
  if (/^[ら-ろ]/u.test(value)) return "ら";
  if (/^[わ-ん]/u.test(value)) return "わ";
  return "其他";
}

function setNestedView(target, pathParts, value) {
  let cursor = target;
  for (const part of pathParts.slice(0, -1)) {
    if (!cursor[part]) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

function stableRequestKey(value) {
  return sha256Text(String(value || "")).slice(0, 16);
}

function writePagedShard({ kind, rangeId, dataVersion, generatedAt, capturedAt, baseDir, pageSize, records, recordName }) {
  const chunks = chunkArray(records, pageSize);
  const pages = chunks.map((chunk, index) => {
    const pageIndex = index + 1;
    const pagePayload = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind,
      rangeId,
      dataVersion,
      generatedAt,
      capturedAt,
      pageIndex,
      pageCount: chunks.length,
      pageSize,
      itemCount: chunk.length,
      [recordName]: chunk,
    };
    const text = stringifyRuntimeJson(pagePayload);
    const sha256 = sha256Text(text);
    const pathName = `${baseDir}/page-${String(pageIndex).padStart(4, "0")}.${sha256.slice(0, 12)}.json`;
    writeRuntimeJsonText(path.join(ROOT, pathName), text);
    return {
      index: pageIndex,
      path: pathName,
      sha256,
      bytes: Buffer.byteLength(text, "utf8"),
      itemCount: chunk.length,
    };
  });
  const manifestPayload = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    kind: `${kind}-manifest`,
    rangeId,
    dataVersion,
    generatedAt,
    capturedAt,
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages,
  };
  const manifestText = stringifyRuntimeJson(manifestPayload);
  const manifestSha256 = sha256Text(manifestText);
  const manifestPath = `${baseDir}/manifest.${manifestSha256.slice(0, 12)}.json`;
  const manifestLegacyPath = `${baseDir}/manifest.json`;
  writeRuntimeJsonText(path.join(ROOT, manifestPath), manifestText);
  writeRuntimeJsonText(path.join(ROOT, manifestLegacyPath), manifestText);
  cleanupOldPagedShardFiles(baseDir, {
    manifestPath,
    pages,
  });
  return {
    manifestPath,
    manifestLegacyPath,
    sha256: manifestSha256,
    bytes: Buffer.byteLength(manifestText, "utf8"),
    pageSize,
    itemCount: records.length,
    pageCount: pages.length,
    pages,
  };
}

function buildSourceDetailRecords(items) {
  return (items || []).map((item) => ({
    videoId: item.videoId || "",
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelUrl || item.authorUrl || item.ownerUrl || item.sourceUrl),
    channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl || "",
    keyword: item.keyword || "",
    keywords: listValues(item.keywords),
    keywordKeys: listValues(item.keywordKeys),
    thumbnailUrl: runtimeThumbnailUrl(item),
    publishedText: item.publishedText || "",
    publishedTimestamp: Number.isFinite(item.publishedTimestamp) ? item.publishedTimestamp : null,
    durationText: item.durationText || "",
    sourceGroups: listValues(item.sourceGroups),
    sourceUrls: listValues(item.sourceUrls),
    selectedSourceId: item.selectedSourceId || item.sourceId || "",
    selectedSourceHash: item.selectedSourceHash || item.sourceHash || "",
    sourceQuality: item.sourceQuality || null,
    songCount: Array.isArray(item.songs) ? item.songs.length : 0,
    catalogFirstSeenAt: item.catalogFirstSeenAt || "",
    catalogLastSeenAt: item.catalogLastSeenAt || "",
    catalogLastInspectedAt: item.catalogLastInspectedAt || "",
    carriedFromPrevious: item.carriedFromPrevious === true,
  }));
}

function buildSearchRecords(items) {
  const records = [];
  for (const item of items || []) {
    records.push({
      type: "video",
      videoId: item.videoId || "",
      title: item.title || "",
      channelName: item.channelName || "",
      keyword: item.keyword || "",
      searchText: normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword].join(" ")),
    });
    for (const song of item.songs || []) {
      records.push({
        type: "song",
        videoId: item.videoId || "",
        seconds: Math.max(0, Number(song.seconds) || 0),
        title: song.title || "",
        artist: song.artist || "",
        isNiche: song.isNiche === true,
        searchText: normalizeSearchText([item.videoId, song.title, song.artist, item.title, ...channelSearchParts(item)].join(" ")),
      });
    }
  }
  return records;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function channelSearchParts(item = {}) {
  return [item.channelName, ...channelAliasValues(item.channelAliases), item.channelId, cleanChannelHandle(item.channelHandle), item.channelUrl || item.authorUrl || item.ownerUrl];
}

function channelAliasValues(value) {
  return listValues(value).map((item) => cleanText(item)).filter((item) => item && !isChannelPathAlias(item));
}

function isChannelPathAlias(value) {
  const text = cleanText(value).toLocaleLowerCase();
  return text.startsWith("/channel/") || text.includes("youtube.com/channel/");
}

function cleanChannelHandle(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text)) return text.startsWith("/") ? text : `/${text}`;
  const match = text.match(/youtube\.com\/(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  return match ? `/${match[1]}` : "";
}

function preferredChannelDisplayName(current, candidate) {
  const currentText = cleanText(current);
  const candidateText = cleanText(candidate);
  if (!currentText) return candidateText;
  if (!candidateText) return currentText;
  return channelDisplayNameScore(candidateText) > channelDisplayNameScore(currentText) ? candidateText : currentText;
}

function channelDisplayNameScore(value) {
  const text = cleanText(value);
  if (!text) return -1;
  let score = Math.min(text.length, 80);
  if (/[ぁ-ゖァ-ヺ一-龯々〆〤]/u.test(text)) score += 1000;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text) || /^\/channel\/UC[A-Za-z0-9_-]+$/u.test(text) || /^UC[A-Za-z0-9_-]{20,}$/u.test(text)) score -= 1000;
  return score;
}

function incrementCount(map, name) {
  if (!name) return;
  if (!map.has(name)) map.set(name, { name, count: 0 });
  map.get(name).count += 1;
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function compareValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function chunkArray(items, pageSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += pageSize) {
    chunks.push(items.slice(index, index + pageSize));
  }
  return chunks.length ? chunks : [[]];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stringifyRuntimeJson(value) {
  return JSON.stringify(value);
}

function writeRuntimeJson(filePath, value) {
  writeRuntimeJsonText(filePath, stringifyRuntimeJson(value));
}

function writeRuntimeJsonText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function computeRuntimeDataVersion(payload, rangePayloads) {
  return sha256Text(
    stringifyRuntimeJson({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      generatedAt: payload.generatedAt || "",
      capturedAt: payload.capturedAt || payload.generatedAt || "",
      rebuiltDerivedAt: payload.source?.rebuiltDerivedAt || "",
      curationVersion: payload.curationVersion || "",
      curationHash: payload.curationHash || "",
      blocklistVersion: payload.blocklistVersion || payload.source?.blocklistVersion || BLOCKLIST_VERSION,
      blocklistHash: payload.blocklistHash || payload.source?.blocklistHash || BLOCKLIST_HASH,
      filterVersion: CURRENT_FILTER_VERSION,
      ranges: Object.fromEntries(RANGES.map((rangeId) => [rangeId, rangePayloads[rangeId] || null])),
    }),
  );
}

function commonRangeDataVersion(rangePayloads) {
  const versions = RANGES.map((rangeId) => rangePayloads[rangeId]?.dataVersion).filter(Boolean);
  return versions.length && versions.every((version) => version === versions[0]) ? versions[0] : "";
}

function cleanupOldRuntimeRangeFiles(rangeFiles) {
  if (!fs.existsSync(UI_DIR)) return;
  const current = new Set(Object.values(rangeFiles).map((entry) => path.basename(entry.path)));
  for (const rangeId of RANGES) {
    const files = fs
      .readdirSync(UI_DIR)
      .filter((name) => new RegExp(`^${rangeId}\\.[0-9a-f]{12}\\.json$`, "u").test(name))
      .map((name) => ({
        name,
        mtimeMs: fs.statSync(path.join(UI_DIR, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set([...files.slice(0, 4).map((file) => file.name), ...current]);
    for (const file of files) {
      if (!keep.has(file.name)) fs.unlinkSync(path.join(UI_DIR, file.name));
    }
  }
}

function cleanupOldPagedShardFiles(baseDir, currentShard) {
  const dirPath = path.join(ROOT, baseDir);
  if (!fs.existsSync(dirPath)) return;
  const keep = new Set([
    path.basename(currentShard.manifestPath || ""),
    "manifest.json",
    ...(currentShard.pages || []).map((page) => path.basename(page.path || "")),
  ]);
  for (const name of fs.readdirSync(dirPath)) {
    if (!/^(manifest|page-[0-9]{4})\.[0-9a-f]{12}\.json$/u.test(name)) continue;
    if (!keep.has(name)) fs.unlinkSync(path.join(dirPath, name));
  }
}

function writeRuntimeAliasFiles(rangeFiles, rangePayloads) {
  for (const [legacyId, targetId] of Object.entries(LEGACY_RANGE_ALIASES)) {
    const target = rangeFiles[targetId] || {};
    const targetPayload = rangePayloads[targetId] || {};
    writeRuntimeJson(path.join(UI_DIR, `${legacyId}.json`), {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      id: legacyId,
      aliasOf: targetId,
      path: target.path || `data/ui/${targetId}.json`,
      legacyPath: target.legacyPath || `data/ui/${targetId}.json`,
      generatedAt: targetPayload.generatedAt || target.generatedAt || "",
      capturedAt: targetPayload.capturedAt || "",
      itemCount: targetPayload.items?.length || 0,
      dataVersion: targetPayload.dataVersion || "",
    });
  }
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CANONICAL_RANGES,
  buildClientGroup,
  buildClientSong,
  buildClientVideo,
  buildRequestRuntimeModel,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  buildSearchRecords,
  buildSourceDetailRecords,
  compactRankDiff,
  compactRankDiffEntries,
  computeRuntimeDataVersion,
  CURRENT_FILTER_VERSION,
  chunkRecordsByPayloadBytes,
  LEGACY_RANGE_ALIASES,
  LEGACY_RANGE_IDS,
  RANGES,
  requestSearchBucketId,
  requestSearchBuckets,
  SEARCH_PAGE_SIZE,
  SOURCE_DETAIL_PAGE_SIZE,
  RUNTIME_PAGE_SIZE,
  sha256Text,
  writeRuntimeJson,
};
