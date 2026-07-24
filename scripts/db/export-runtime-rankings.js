#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const RankingUtils = require("../../assets/ranking-utils");
const {
  loadVsingerBackfillRuntimeVideos,
  mergeVideoItems,
  sortVideos,
  videoBelongsToRange,
} = require("../vsinger-http/runtime-importer");
const {
  loadYoutubeChannelDiscoveryRuntimeVideos,
} = require("../youtube-channel-discovery-runtime");
const { hydratePayloadWithChannelMetadata, thumbnailUrlForVideo } = require("../channel-metadata-cache");
const { groupForRange, RANGE_TITLES } = require("../range-config");
const {
  RANGES,
  buildClientSong,
  buildClientVideo,
  buildRuntimeRangePayload,
} = require("../build-runtime-data");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("../song-aliases");
const { repairParsedEntry } = require("../entry-repair");
const { isLikelyNonSongEntry, normalizeParsedSong, normalizeSourceAwareArtist } = require("../song-utils");
const { dropSameSecondTranslatedAliasSongs, filterBlockedVideos, isBlockedSongEntry, isSingletonPseudoSongEntry } = require("../../assets/source-filter");
const { assertRecentAllContinuity } = require("../recent-all-continuity");

const ROOT = path.resolve(__dirname, "..", "..");
const REQUEST_PREVIEW_SOURCE_LIMIT = positiveInteger(process.env.DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT, 3);

if (require.main === module) {
  main();
}

function logPhase(phase, fields = {}) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`CODEX_RUNTIME_RANKINGS_EXPORT_PHASE phase=${phase}${suffix ? ` ${suffix}` : ""}`);
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    logPhase("payload_load_start", { input: args.input });
    const payload = hydratePayloadWithChannelMetadata(readJson(args.input), {
      metadataPath: path.join(args.youtubeChannelDiscoveryDir, "channel-metadata.json"),
    });
    assertRecentAllContinuity(payload);
    logPhase("payload_load_ok", {
      inputBytes: fileSize(args.input),
      groups: Object.keys(payload.groups || {}).length,
    });
    logPhase("runtime_imports_start", {
      vsinger: args.noVsinger ? "disabled" : args.vsingerDir,
      youtubeChannelDiscovery: args.noYoutubeChannelDiscovery ? "disabled" : args.youtubeChannelDiscoveryDir,
    });
    const runtimeImports = loadRuntimeImports(args);
    logPhase("runtime_imports_ok", {
      vsingerVideos: runtimeImports.vsinger?.videos?.length || 0,
      youtubeVideos: runtimeImports.youtubeChannelDiscovery?.videos?.length || 0,
    });
    const songAliasContext = loadSongAliasContext();
    if (songAliasContext.errors?.length) {
      throw new Error(`song alias config invalid: ${songAliasContext.errors.join("; ")}`);
    }
    logPhase("data_version_start");
    const dataVersion = computeExportDataVersion(payload, args, runtimeImports, songAliasContext);
    logPhase("data_version_ok", { dataVersion });
    logPhase("write_start", { output: args.output, ranges: args.ranges.join(",") });
    writeJsonlExport(args.output, payload, runtimeImports, dataVersion, args, songAliasContext);
  } catch (error) {
    console.error(`CODEX_RUNTIME_RANKINGS_EXPORT_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function parseArgs(argv) {
  const args = {
    input: path.join(ROOT, "data", "latest.json"),
    output: "",
    vsingerDir: path.join(ROOT, "data", "external", "vsinger-http", "backfill"),
    youtubeChannelDiscoveryDir: path.join(ROOT, "data", "external", "youtube-channel-discovery"),
    ranges: [],
    limitPerRange: 0,
    noVsinger: false,
    requireVsinger: false,
    allowPartialVsinger: false,
    noYoutubeChannelDiscovery: false,
    requireYoutubeChannelDiscovery: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--input") args.input = requireValue(argv, ++index, name);
    else if (name === "--output") args.output = requireValue(argv, ++index, name);
    else if (name === "--vsinger-dir") args.vsingerDir = requireValue(argv, ++index, name);
    else if (name === "--youtube-channel-discovery-dir") args.youtubeChannelDiscoveryDir = requireValue(argv, ++index, name);
    else if (name === "--range") args.ranges.push(...requireValue(argv, ++index, name).split(",").map((value) => value.trim()).filter(Boolean));
    else if (name === "--limit-per-range") args.limitPerRange = positiveInteger(requireValue(argv, ++index, name), 0);
    else if (name === "--no-vsinger") args.noVsinger = true;
    else if (name === "--require-vsinger") args.requireVsinger = true;
    else if (name === "--allow-partial-vsinger") args.allowPartialVsinger = true;
    else if (name === "--no-youtube-channel-discovery") args.noYoutubeChannelDiscovery = true;
    else if (name === "--require-youtube-channel-discovery") args.requireYoutubeChannelDiscovery = true;
    else throw new Error(`Unknown argument: ${name}`);
  }

  if (!args.output) throw new Error("--output is required");
  args.input = path.resolve(args.input);
  args.output = path.resolve(args.output);
  args.vsingerDir = path.resolve(args.vsingerDir);
  args.youtubeChannelDiscoveryDir = path.resolve(args.youtubeChannelDiscoveryDir);
  args.ranges = args.ranges.length ? args.ranges : RANGES;
  for (const rangeId of args.ranges) {
    if (!RANGES.includes(rangeId)) throw new Error(`Unsupported range: ${rangeId}`);
  }
  return args;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function loadRuntimeImports(args) {
  return {
    vsinger: args.noVsinger ? null : loadVsingerBackfillRuntimeVideos({
      backfillDir: args.vsingerDir,
      required: args.requireVsinger,
      allowPartial: args.allowPartialVsinger,
    }),
    youtubeChannelDiscovery: args.noYoutubeChannelDiscovery ? null : loadYoutubeChannelDiscoveryRuntimeVideos({
      importDir: args.youtubeChannelDiscoveryDir,
      required: args.requireYoutubeChannelDiscovery,
    }),
  };
}

function writeJsonlExport(outputPath, payload, runtimeImports, dataVersion, args, songAliasContext = null) {
  const writer = createJsonlWriter(outputPath);
  let rankingRowCount = 0;
  let sourceDetailCount = 0;
  let sourceOccurrenceCount = 0;
  let runtimeVideoCount = 0;

  try {
    writer.write({
      kind: "meta",
      schemaVersion: 1,
      source: "runtime-js",
      dataVersion,
      generatedAt: payload.generatedAt || "",
      capturedAt: payload.capturedAt || payload.generatedAt || "",
      ranges: args.ranges,
      vsingerIncluded: Boolean(runtimeImports.vsinger),
      youtubeChannelDiscoveryIncluded: Boolean(runtimeImports.youtubeChannelDiscovery),
      songAliases: songAliasContext
        ? {
            schemaVersion: songAliasContext.schemaVersion,
            aliasVersion: songAliasContext.aliasVersion,
            recordCount: songAliasContext.records.length,
          }
        : null,
    });

    for (const rangeId of args.ranges) {
      logPhase("range_start", { range: rangeId });
      const rangePayload = buildRangePayload(payload, rangeId, args, runtimeImports);
      rangePayload.dataVersion = dataVersion;
      const baseItems = Array.isArray(rangePayload.items) ? rangePayload.items.map((item) => withRuntimeScopedSongs(item, null, songAliasContext)) : [];
      const sourceFilteredItems = filterBlockedVideos(baseItems);
      logPhase("range_items_ready", { range: rangeId, items: sourceFilteredItems.length, blockedSources: baseItems.length - sourceFilteredItems.length });
      const titleStats = buildRuntimeTitleStats(sourceFilteredItems);
      logPhase("range_title_stats_ready", { range: rangeId, titles: titleStats.size });
      const filteredItems = sourceFilteredItems.map((item) => withRuntimeScopedSongs(item, titleStats));
      const titleArtistFallbacks = buildRuntimeTitleArtistFallbacks(filteredItems);
      logPhase("range_artist_fallbacks_ready", { range: rangeId, titles: titleArtistFallbacks.size });
      const itemsBeforeChannelHydration = filteredItems.map((item) => withRuntimeArtistFallbacks(item, titleArtistFallbacks));
      const channelIdentityLookup = buildChannelIdentityLookup(itemsBeforeChannelHydration);
      const items = itemsBeforeChannelHydration.map((item) => hydrateRuntimeItemChannelIdentity(item, channelIdentityLookup));
      const occurrences = collectRuntimeOccurrences(items);
      logPhase("range_occurrences_ready", { range: rangeId, occurrences: occurrences.length });
      const writtenSourceKeys = new Set();
      writer.write({
        kind: "range",
        rangeId,
        itemCount: items.length,
        occurrenceCount: occurrences.length,
        dataVersion,
        generatedAt: rangePayload.generatedAt || "",
        capturedAt: rangePayload.capturedAt || payload.capturedAt || payload.generatedAt || "",
      });
      items.forEach((item, itemIndex) => {
        writer.write({
          kind: "runtimeVideo",
          rangeId,
          itemIndex,
          item,
        });
        runtimeVideoCount += 1;
      });

      logPhase("song_records_start", { range: rangeId, occurrences: occurrences.length });
      const songRecords = addRequestRecordFields(RankingUtils.buildSongRecords(occurrences));
      logPhase("song_records_ok", { range: rangeId, records: songRecords.length });
      logPhase("artist_records_start", { range: rangeId, occurrences: occurrences.length });
      const artistResult = RankingUtils.buildArtistRecords(occurrences);
      const artistRecords = addRequestRecordFields(artistResult.records || []);
      logPhase("artist_records_ok", { range: rangeId, records: artistRecords.length });
      logPhase("video_records_start", { range: rangeId, items: items.length });
      const videoRecords = buildVideoRequestItems(items);
      logPhase("video_records_ok", { range: rangeId, records: videoRecords.length });
      logPhase("vtuber_records_start", { range: rangeId, items: items.length });
      const vtuberSongIdentityLookup = buildVtuberSongIdentityLookup(songRecords);
      const vtuberRecords = buildVtuberRequestItems(items, vtuberSongIdentityLookup);
      logPhase("vtuber_records_ok", { range: rangeId, records: vtuberRecords.length });
      logPhase("range_records_ready", {
        range: rangeId,
        songs: songRecords.length,
        artists: artistRecords.length,
        videos: videoRecords.length,
        vtubers: vtuberRecords.length,
      });
      const specs = [
        { type: "song", view: "songs", records: sortRankRecords(songRecords, "occurrences"), metric: "count", sourcePrefix: "song", order: "rank" },
        { type: "song", view: "songs", records: sortRankRecords(songRecords, "videos"), metric: "videos", sourcePrefix: "song", order: "rank" },
        { type: "song", view: "songIndex", records: [...songRecords].sort(compareSongAzRecords), metric: "count", sourcePrefix: "song", order: "position" },
        { type: "artist", view: "artists", records: sortRankRecords(artistRecords, "occurrences"), metric: "count", sourcePrefix: "artist", order: "rank" },
        { type: "artist", view: "artists", records: sortRankRecords(artistRecords, "videos"), metric: "videos", sourcePrefix: "artist", order: "rank" },
        { type: "vtuber", view: "vtubers", records: sortRankRecords(vtuberRecords, "occurrences"), metric: "count", sourcePrefix: "vtuber", order: "rank" },
        { type: "vtuber", view: "vtubers", records: sortRankRecords(vtuberRecords, "songs"), metric: "songs", sourcePrefix: "vtuber", order: "rank" },
        { type: "vtuber", view: "vtubers", records: sortRankRecords(vtuberRecords, "videos"), metric: "videos", sourcePrefix: "vtuber", order: "rank" },
        { type: "video", view: "videos", records: videoRecords, metric: "count", sourcePrefix: "video", order: "position" },
      ];

      for (const spec of specs) {
        logPhase("spec_start", { range: rangeId, view: spec.view, metric: spec.metric, records: spec.records.length });
        const ranks = buildRequestRanks(spec.records, spec.metric);
        spec.records.forEach((record, index) => {
          const sourceDetailKey = spec.type === "video" ? "" : stableRequestKey(`${rangeId}:${spec.sourcePrefix}:all:${record.key || record.videoId || ""}`);
          const payloadRecord = serializeRecord(spec.type, record, {
            detailKey: `all:${record.key || record.videoId || ""}`,
            sourceDetailKey,
          });
          const entityKey = payloadRecord.key || payloadRecord.videoId || stableRequestKey(`${rangeId}:${spec.view}:${index}`);
          const row = {
            kind: "ranking",
            rowId: stableDbKey(["ranking-row", rangeId, spec.view, spec.metric, "all", entityKey].join("\0")),
            rangeId,
            view: spec.view,
            metric: spec.metric,
            scopeKey: "all",
            rank: spec.order === "position" ? index + 1 : ranks.get(record.key || record.videoId) || index + 1,
            detailKey: entityKey,
            title: payloadRecord.title || "",
            artist: payloadRecord.displayArtist || payloadRecord.artist || "",
            name: payloadRecord.name || payloadRecord.channelName || "",
            count: Number(payloadRecord.count) || 0,
            songCount: Number(payloadRecord.songCount) || 0,
            videoCount: Number(payloadRecord.videoCount) || 0,
            timestampCount: Number(payloadRecord.timestampCount ?? payloadRecord.count) || 0,
            payload: payloadRecord,
            searchText: payloadRecord.searchText || requestRecordSearchText(payloadRecord, spec.type),
          };
          writer.write(row);
          rankingRowCount += 1;
          if (sourceDetailKey && !writtenSourceKeys.has(sourceDetailKey)) {
            const recordOccurrences = record.sourceOccurrences || record.occurrences || [];
            writer.write({
              kind: "sourceDetail",
              rangeId,
              sourceKey: sourceDetailKey,
              entityType: spec.type,
              entityKey,
              payload: {
                ...payloadRecord,
                occurrenceCount: recordOccurrences.length,
                occurrencePreviewLimited: recordOccurrences.length > REQUEST_PREVIEW_SOURCE_LIMIT,
              },
            });
            recordOccurrences.forEach((occurrence, position) => {
              writer.write({
                kind: "sourceOccurrence",
                rangeId,
                sourceKey: sourceDetailKey,
                position,
                payload: serializeSourceOccurrence(occurrence),
              });
              sourceOccurrenceCount += 1;
            });
            writtenSourceKeys.add(sourceDetailKey);
            sourceDetailCount += 1;
          }
        });
        logPhase("spec_done", {
          range: rangeId,
          view: spec.view,
          metric: spec.metric,
          rankingRows: rankingRowCount,
          sourceDetails: sourceDetailCount,
          sourceOccurrences: sourceOccurrenceCount,
        });
      }
      if (typeof global.gc === "function") global.gc();
      logPhase("range_done", {
        range: rangeId,
        rankingRows: rankingRowCount,
        sourceDetails: sourceDetailCount,
        sourceOccurrences: sourceOccurrenceCount,
      });
    }
  } finally {
    writer.close();
  }
  console.log(
    `CODEX_RUNTIME_RANKINGS_EXPORT_OK output=${outputPath} ranges=${args.ranges.join(",")} videos=${runtimeVideoCount} rows=${rankingRowCount} sources=${sourceDetailCount} sourceOccurrences=${sourceOccurrenceCount}`,
  );
}

function buildRangePayload(payload, rangeId, args, runtimeImports = {}) {
  if (!runtimeImports.vsinger && !runtimeImports.youtubeChannelDiscovery) {
    const base = buildRuntimeRangePayload(payload, rangeId);
    return args.limitPerRange > 0 ? { ...base, items: (base.items || []).slice(0, args.limitPerRange) } : base;
  }

  const sourceGroup = groupForRange(payload.groups, rangeId) || {};
  const capturedAt = new Date(payload.capturedAt || payload.generatedAt || Date.now());
  const capturedMs = capturedAt.getTime();
  const baseItems = Array.isArray(sourceGroup.items) ? sourceGroup.items : [];
  const importItems = [];
  if (runtimeImports.youtubeChannelDiscovery) {
    importItems.push(...runtimeImports.youtubeChannelDiscovery.videos.filter((item) => videoBelongsToRange(item, rangeId, capturedMs)));
  }
  if (runtimeImports.vsinger) {
    importItems.push(...runtimeImports.vsinger.videos.filter((item) => videoBelongsToRange(item, rangeId, capturedMs)));
  }
  const merged = mergeVideoItems(baseItems, importItems);
  const generatedAt = latestIso(
    sourceGroup.generatedAt,
    runtimeImports.youtubeChannelDiscovery?.summary?.generatedAt,
    runtimeImports.vsinger?.summary?.generatedAt,
  ) || sourceGroup.generatedAt || payload.generatedAt || "";
  const group = {
    ...sourceGroup,
    id: rangeId,
    title: sourceGroup.title || RANGE_TITLES[rangeId] || rangeId,
    generatedAt,
    updatedAt: latestIso(sourceGroup.updatedAt, generatedAt) || generatedAt,
    items: sortVideos(merged.items),
  };
  const rangePayload = buildRuntimeRangePayload({ ...payload, groups: { ...(payload.groups || {}), [rangeId]: group } }, rangeId);
  return args.limitPerRange > 0 ? { ...rangePayload, items: (rangePayload.items || []).slice(0, args.limitPerRange) } : rangePayload;
}

function computeExportDataVersion(payload, args, runtimeImports = {}, songAliasContext = null) {
  return stableDbKey(JSON.stringify({
    schemaVersion: 1,
    generatedAt: payload.generatedAt || "",
    capturedAt: payload.capturedAt || payload.generatedAt || "",
    rebuiltDerivedAt: payload.source?.rebuiltDerivedAt || "",
    curationVersion: payload.curationVersion || "",
    curationHash: payload.curationHash || "",
    ranges: args.ranges,
    limitPerRange: args.limitPerRange,
    vsinger: runtimeImports.vsinger?.summary || null,
    youtubeChannelDiscovery: runtimeImports.youtubeChannelDiscovery?.summary || null,
    songAliases: songAliasContext
      ? {
          aliasVersion: songAliasContext.aliasVersion,
          recordCount: songAliasContext.records.length,
        }
      : null,
  }));
}

function latestIso(...values) {
  let selected = "";
  let selectedMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms) && ms >= selectedMs) {
      selected = text;
      selectedMs = ms;
    } else if (!Number.isFinite(ms) && !selected) {
      selected = text;
    }
  }
  return selected;
}

function createJsonlWriter(outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const fd = fs.openSync(outputPath, "w");
  let closed = false;
  return {
    write(value) {
      fs.writeSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  };
}

function serializeSourceOccurrence(occurrence) {
  const item = occurrence.item || {};
  const serializedItem = buildClientVideo({
    ...item,
    songs: occurrence.song ? [occurrence.song] : [],
  });
  return {
    item: serializedItem,
    song: buildClientSong(occurrence.song || {}),
    searchText: occurrence.searchText || normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, occurrence.song?.title, occurrence.song?.artist].join(" ")),
  };
}

function serializeRecord(type, record, options = {}) {
  if (type === "song") return serializeSongRequestRecord(record, options);
  if (type === "artist") return serializeArtistRequestRecord(record, options);
  if (type === "vtuber") return serializeVtuberRequestRecord(record, options);
  return serializeVideoRequestRecord(record, options);
}

function collectRuntimeOccurrences(items) {
  const occurrences = [];
  for (const item of items || []) {
    for (const song of runtimeScopedSongs(item.songs, item)) {
      occurrences.push({
        item,
        song,
        searchText: normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  return occurrences;
}

function buildVideoRequestItems(items) {
  const result = [];
  for (const item of items || []) {
    const scopedSongs = runtimeScopedSongs(item.songs, item);
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

function buildVtuberRequestItems(items, songIdentityLookup = null) {
  const records = new Map();
  const identityLookup = buildChannelIdentityLookup(items);
  for (const item of items || []) {
    const scopedSongs = runtimeScopedSongs(item.songs, item);
    if (!scopedSongs.length) continue;
    const key = channelRecordKey(item, identityLookup);
    if (!key) continue;
    if (!records.has(key)) {
      records.set(key, {
        type: "vtuber",
        key,
        name: RankingUtils.cleanText(item.channelName || item.channelHandle || item.channelId || "未知频道"),
        channelName: RankingUtils.cleanText(item.channelName),
        channelId: RankingUtils.cleanText(item.channelId),
        channelHandle: cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelUrl || item.authorUrl || item.ownerUrl || item.sourceUrl),
        channelUrl: RankingUtils.cleanText(item.channelUrl || item.authorUrl || item.ownerUrl),
        avatarUrl: RankingUtils.cleanText(item.avatarUrl || item.channelAvatarUrl),
        thumbnailUrl: vtuberThumbnailCandidate(item),
        videoThumbnailUrl: vtuberThumbnailCandidate(item),
        sourceUrl: RankingUtils.cleanText(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl),
        knownSourceType: RankingUtils.cleanText(item.knownSourceType),
        isCollected: isCollectedSource(item),
        count: 0,
        songCount: 0,
        videoCount: 0,
        timestampCount: 0,
        videos: new Set(),
        songs: new Map(),
        occurrences: [],
        sourceOccurrences: [],
        aliases: new Set(),
      });
    }
    const record = records.get(key);
    mergeChannelRecordIdentity(record, item);
    const videoKey = item.videoId || stableRequestKey(`${item.channelName}:${item.title}:${item.publishedTimestamp || ""}`);
    record.videos.add(videoKey);
    for (const song of scopedSongs) {
      record.count += 1;
      record.timestampCount += 1;
      incrementVtuberSongCount(record.songs, song, songIdentityLookup);
      record.sourceOccurrences.push({
        item,
        song,
        searchText: normalizeSearchText([item.videoId, item.title, ...channelSearchParts(item), item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  const result = Array.from(records.values()).map((record) => {
    record.videoCount = record.videos.size;
    record.songCount = record.songs.size;
    record.occurrences = previewOccurrences(record.sourceOccurrences, REQUEST_PREVIEW_SOURCE_LIMIT);
    record.aliases = Array.from(record.aliases.values());
    record.searchText = requestRecordSearchText(record, "vtuber");
    return record;
  });
  validateVtuberDisplayImages(result);
  return result;
}

function validateVtuberDisplayImages(records) {
  const missing = (records || []).filter((record) => !RankingUtils.cleanText(record.avatarUrl) && !RankingUtils.cleanText(record.thumbnailUrl || record.videoThumbnailUrl));
  if (!missing.length) return;
  const sample = missing
    .slice(0, 10)
    .map((record) => [record.channelHandle, record.channelId, record.name].filter(Boolean).join(" ") || record.key)
    .join(", ");
  throw new Error(`VTuber display image missing: count=${missing.length} sample=${sample}`);
}

function buildChannelIdentityLookup(items) {
  const nameToKey = new Map();
  const keyToRecord = new Map();
  const ambiguousNames = new Set();
  for (const item of items || []) {
    const scopedSongs = runtimeScopedSongs(item.songs, item);
    if (!scopedSongs.length) continue;
    const nameKey = channelNameIdentityKey(item);
    const directKey = directChannelRecordKey(item);
    if (directKey) keyToRecord.set(directKey, mergeRuntimeChannelIdentityRecord(keyToRecord.get(directKey), item));
    if (!nameKey || !directKey) continue;
    const existing = nameToKey.get(nameKey);
    if (existing && existing !== directKey) {
      ambiguousNames.add(nameKey);
      continue;
    }
    nameToKey.set(nameKey, directKey);
  }
  for (const nameKey of ambiguousNames) nameToKey.delete(nameKey);
  return { nameToKey, keyToRecord };
}

function mergeRuntimeChannelIdentityRecord(existing, item) {
  const record = existing || {
    type: "vtuber",
    key: directChannelRecordKey(item),
    name: "",
    channelName: "",
    channelId: "",
    channelHandle: "",
    channelUrl: "",
    avatarUrl: "",
    thumbnailUrl: "",
    videoThumbnailUrl: "",
    sourceUrl: "",
    knownSourceType: "",
    isCollected: false,
    aliases: new Set(),
  };
  mergeChannelRecordIdentity(record, item);
  return record;
}

function hydrateRuntimeItemChannelIdentity(item, identityLookup) {
  if (!item || typeof item !== "object" || !identityLookup?.keyToRecord?.size) return item;
  const key = channelRecordKey(item, identityLookup);
  const record = key ? identityLookup.keyToRecord.get(key) : null;
  if (!record) return item;
  const channelName = preferredChannelDisplayName(item.channelName, record.channelName || record.name);
  const channelHandle = cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelName) || record.channelHandle || "";
  const channelUrl = RankingUtils.cleanText(item.channelUrl || item.authorUrl || item.ownerUrl) || record.channelUrl || "";
  const channelId = RankingUtils.cleanText(item.channelId) || record.channelId || "";
  return {
    ...item,
    channelName,
    channelAliases: runtimeChannelAliasValues(item, record, { channelName, channelId, channelHandle, channelUrl }),
    channelId,
    channelHandle,
    channelUrl,
    avatarUrl: RankingUtils.cleanText(item.avatarUrl || item.channelAvatarUrl) || record.avatarUrl || "",
    sourceUrl: RankingUtils.cleanText(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl) || record.sourceUrl || record.channelUrl || "",
    thumbnailUrl: RankingUtils.cleanText(item.thumbnailUrl || item.thumbnail) || record.thumbnailUrl || record.videoThumbnailUrl || "",
  };
}

function runtimeChannelAliasValues(item, record, identity = {}) {
  const recordAliases = record?.aliases instanceof Set ? Array.from(record.aliases.values()) : record?.aliases || [];
  return channelAliasValues(
    [
      ...(Array.isArray(item?.channelAliases) ? item.channelAliases : []),
      item?.channelName,
      record?.channelName,
      record?.name,
      record?.channelHandle,
      ...recordAliases,
    ],
    identity,
  );
}

function withRuntimeScopedSongs(item, titleStats = null, aliasContext = null) {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    songs: runtimeScopedSongs(item.songs, item, titleStats, aliasContext),
  };
}

function withRuntimeArtistFallbacks(item, titleArtistFallbacks = null) {
  if (!item || typeof item !== "object" || !titleArtistFallbacks?.size) return item;
  return {
    ...item,
    songs: dedupeCanonicalSameSecondSongs(
      (Array.isArray(item.songs) ? item.songs : [])
        .map((song) => applyRuntimeArtistFallback(song, titleArtistFallbacks))
        .filter(Boolean),
    ),
  };
}

function applyRuntimeArtistFallback(song, titleArtistFallbacks = null) {
  if (!song || typeof song !== "object" || !titleArtistFallbacks?.size || !RankingUtils.isUnknownArtistName(song.artist)) return song;
  const fallback = titleArtistFallbacks.get(runtimeSongWorkTitleKey(song.canonicalTitle || song.title));
  if (!fallback) return song;
  const title = RankingUtils.cleanText(fallback.title) || RankingUtils.cleanText(song.title);
  const artist = RankingUtils.canonicalizeArtistName(fallback.artist);
  if (!title || !artist || RankingUtils.isUnknownArtistName(artist)) return song;
  const next = {
    ...song,
    title,
    artist,
  };
  if (!RankingUtils.cleanText(next.canonicalTitle)) next.canonicalTitle = title;
  if (RankingUtils.isUnknownArtistName(next.canonicalArtist)) next.canonicalArtist = artist;
  return next;
}

function runtimeScopedSongs(songs, source = {}, titleStats = null, aliasContext = null) {
  const scoped = [];
  for (const song of Array.isArray(songs) ? songs : []) {
    if (!song || typeof song !== "object") continue;
    const normalizedSong = normalizeSourceAwareArtist(repairParsedEntry(normalizeParsedSong(song)), source);
    if (!RankingUtils.cleanText(normalizedSong.title)) continue;
    if (isBlockedSongEntry(normalizedSong, source)) continue;
    if (titleStats && isSingletonPseudoSongEntry(normalizedSong, titleStats)) continue;
    if (isLikelyNonSongEntry(normalizedSong, source)) continue;
    scoped.push(normalizedSong);
  }
  const deduped = dropSameSecondTranslatedAliasSongs(scoped);
  const canonicalized = aliasContext ? deduped.map((song) => canonicalizeSongIdentity(song, aliasContext)) : deduped;
  return dedupeCanonicalSameSecondSongs(canonicalized);
}

function dedupeCanonicalSameSecondSongs(songs) {
  const result = [];
  const seen = new Set();
  for (const song of Array.isArray(songs) ? songs : []) {
    const seconds = Number(song?.seconds);
    const key = Number.isFinite(seconds)
      ? [
          Math.trunc(seconds),
          RankingUtils.songWorkTitleKey(song?.canonicalTitle || song?.title),
          RankingUtils.normalizeArtistKey(song?.canonicalArtist || song?.artist),
        ].join("\u0001")
      : "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(song);
  }
  return result;
}

function buildRuntimeTitleStats(items) {
  const records = new Map();
  for (const item of items || []) {
    const sourceKey = RankingUtils.cleanText(item?.videoId || item?.selectedSourceId || item?.sourceId || item?.title);
    for (const song of Array.isArray(item?.songs) ? item.songs : []) {
      const key = singletonTitleKey(song?.title);
      if (!key) continue;
      if (!records.has(key)) records.set(key, { rows: 0, sources: new Set() });
      const record = records.get(key);
      record.rows += 1;
      record.sources.add(sourceKey || `${key}:${record.rows}`);
    }
  }
  for (const record of records.values()) {
    record.sourceCount = record.sources.size;
    delete record.sources;
  }
  return records;
}

function buildRuntimeTitleArtistFallbacks(items) {
  const records = new Map();
  for (const item of items || []) {
    for (const song of Array.isArray(item?.songs) ? item.songs : []) {
      const title = vtuberCanonicalSongTitle(song?.canonicalTitle || song?.title) || RankingUtils.cleanText(song?.title);
      const artist = RankingUtils.canonicalizeArtistName(song?.canonicalArtist || song?.artist);
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
      incrementRuntimeCount(record.titles, title);
      incrementRuntimeCount(record.artists, artist);
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

function incrementRuntimeCount(map, name) {
  const cleanName = RankingUtils.cleanText(name);
  if (!cleanName) return;
  if (!map.has(cleanName)) map.set(cleanName, { name: cleanName, count: 0 });
  map.get(cleanName).count += 1;
}

function dominantRuntimeCountName(map) {
  return Array.from(map.values()).sort((a, b) => b.count - a.count || compareValues(a.name, b.name))[0]?.name || "";
}

function runtimeSongWorkTitleKey(value) {
  const title = vtuberCanonicalSongTitle(value) || RankingUtils.cleanText(value);
  return RankingUtils.songWorkTitleKey(title);
}

function singletonTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦♪♫♬♩]+/gu, "")
    .trim();
}

function channelRecordKey(item, identityLookup = null) {
  const nameKey = channelNameIdentityKey(item);
  if (nameKey && identityLookup?.nameToKey?.has(nameKey)) return identityLookup.nameToKey.get(nameKey);
  const directKey = directChannelRecordKey(item);
  if (directKey) return directKey;
  if (isCompositeChannelName(item?.channelName)) return "";
  return nameKey;
}

function directChannelRecordKey(item) {
  const channelId = RankingUtils.cleanText(item.channelId) || channelIdFromChannelText(item.channelName);
  if (channelId) return channelId;
  const handle = (cleanChannelHandle(item.channelHandle) || cleanChannelHandle(item.channelName)).replace(/^\/+/, "");
  if (handle) return normalizeSearchText(handle);
  const urlHandle = handleFromChannelUrl(item.channelUrl || item.authorUrl || item.ownerUrl);
  if (urlHandle) return normalizeSearchText(urlHandle);
  return "";
}

function channelIdFromChannelText(value) {
  const text = RankingUtils.cleanText(value);
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
  const name = RankingUtils.cleanText(item.channelName);
  return name ? normalizeSearchText(name) : "";
}

function isCompositeChannelName(value) {
  const text = RankingUtils.cleanText(value);
  if (!text) return false;
  return /(?:、|，|,|\s+\+\s+|\s+×\s+)/u.test(text) && /(?:ch\.?|channel|music|ちゃんねる|チャンネル)/iu.test(text);
}

function mergeChannelRecordIdentity(record, item) {
  const channelName = RankingUtils.cleanText(item.channelName);
  const channelId = RankingUtils.cleanText(item.channelId) || channelIdFromChannelText(channelName);
  const channelHandle = cleanChannelHandle(item.channelHandle) || cleanChannelHandle(channelName);
  const channelUrl = RankingUtils.cleanText(item.channelUrl || item.authorUrl || item.ownerUrl);
  const avatarUrl = RankingUtils.cleanText(item.avatarUrl || item.channelAvatarUrl);
  const thumbnailUrl = vtuberThumbnailCandidate(item);
  const sourceUrl = RankingUtils.cleanText(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl);
  const knownSourceType = RankingUtils.cleanText(item.knownSourceType || knownSourceTypeForVideo(item));
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
  if (sourceUrl && !record.sourceUrl) record.sourceUrl = sourceUrl;
  const itemIsCollected = isCollectedSource(item);
  if (
    (!record.isCollected && itemIsCollected) ||
    (!record.knownSourceType && knownSourceType) ||
    (itemIsCollected && shouldReplaceKnownSourceType(record.knownSourceType, knownSourceType))
  ) {
    record.knownSourceType = knownSourceType;
  }
  record.isCollected = record.isCollected === true || itemIsCollected;
  for (const alias of knownChannelSearchAliases(channelName)) record.aliases.add(alias);
}

function vtuberThumbnailCandidate(item) {
  return RankingUtils.cleanText(item.thumbnailUrl || item.videoThumbnail || item.videoThumbnailUrl || item.thumbnail || thumbnailUrlForVideo(item));
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

function knownSourceTypeForVideo(item) {
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  if (sourceGroups.includes("youtube_channel_discovery")) return "youtube_channel_discovery";
  if (sourceGroups.includes("vsinger-moment")) return "vsinger_moment_http";
  return item.sourceQuality?.sourceSystem || "";
}

function shouldReplaceKnownSourceType(current, incoming) {
  const nextType = RankingUtils.cleanText(incoming);
  if (!nextType) return false;
  const currentType = RankingUtils.cleanText(current);
  if (!currentType) return true;
  return isMomentSourceType(currentType) && !isMomentSourceType(nextType);
}

function isMomentSourceType(value) {
  const type = RankingUtils.cleanText(value).toLocaleLowerCase();
  return type === "vsinger_moment_http" || type === "vsinger-moment" || type === "moment";
}

function isCollectedSource(item) {
  const sourceGroups = (Array.isArray(item.sourceGroups) ? item.sourceGroups : [])
    .map((value) => RankingUtils.cleanText(value).toLocaleLowerCase())
    .filter(Boolean);
  const knownType = RankingUtils.cleanText(item.knownSourceType || knownSourceTypeForVideo(item)).toLocaleLowerCase();
  const explicit = explicitCollectionFlag(item);
  if (explicit === false) return false;

  const discoveryTypes = new Set([
    "youtube_channel_discovery",
    "youtube-channel-discovery",
    "youtube_discovery",
    "youtube-discovery",
  ]);
  const importedTypes = new Set([
    "library",
    "manual",
    "song-search",
    "song_search",
    "verified",
    "daily_song_list",
    "daily-song-list",
  ]);
  const sourceTypes = [knownType, ...sourceGroups];
  if (sourceTypes.some((type) => importedTypes.has(type))) return true;
  if (sourceTypes.some((type) => discoveryTypes.has(type))) {
    return explicit === true || sourceGroups.some((type) => discoveryTypes.has(type));
  }
  return false;
}

function explicitCollectionFlag(item) {
  const explicit = item?.isCollected;
  const normalized = String(explicit ?? "").trim().toLocaleLowerCase();
  if (explicit === true || explicit === 1 || normalized === "true") return true;
  if (explicit === false || explicit === 0 || normalized === "false") return false;
  return null;
}

function knownChannelSearchAliases(channelName) {
  const key = normalizeSearchText(channelName);
  if (key === normalizeSearchText("Haru Ch. 花前ハル")) return ["HanamaeHaru", "Hanamae Haru", "花前ハル"];
  return [];
}

function buildVtuberSongIdentityLookup(songRecords) {
  const lookup = new WeakMap();
  for (const record of songRecords || []) {
    const identityKey = RankingUtils.cleanText(record.canonicalWorkTitleKey || record.titleKey || RankingUtils.songWorkTitleKey(record.title));
    const displayTitle = vtuberCanonicalSongTitle(record.workTitle || record.title) || record.workTitle || record.title || "";
    if (!identityKey) continue;
    for (const occurrence of record.occurrences || []) {
      if (occurrence?.song && typeof occurrence.song === "object") {
        lookup.set(occurrence.song, {
          key: identityKey,
          name: displayTitle,
        });
      }
    }
  }
  return lookup;
}

function incrementVtuberSongCount(map, song, songIdentityLookup = null) {
  const lookupIdentity = song && typeof song === "object" ? songIdentityLookup?.get(song) : null;
  const fallbackTitle = vtuberCanonicalSongTitle(song?.title);
  const key = RankingUtils.songWorkTitleKey(fallbackTitle || song?.title) || lookupIdentity?.key;
  const name = fallbackTitle || lookupIdentity?.name || RankingUtils.cleanText(song?.title);
  if (!key || !name) return;
  if (!map.has(key)) map.set(key, { key, name, count: 0 });
  const entry = map.get(key);
  entry.count += 1;
  const canonicalName = vtuberCanonicalSongTitle(entry.name) || entry.name;
  if (canonicalName && canonicalName !== entry.name) entry.name = canonicalName;
}

function vtuberCanonicalSongTitle(value) {
  let title = RankingUtils.cleanText(value);
  if (!title) return "";
  for (let index = 0; index < 4; index += 1) {
    const next = title
      .normalize("NFKC")
      .replace(/^\s*[#＃]?\d{1,4}\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□]+/u, "")
      .replace(/^\s*[＊*]?\s*(?:[#＃]?\d{1,4}|[０-９]{1,4})\s*(?:曲目|曲|番目)?\s*[.)．。、,,:：)）\]\-|｜/／]+\s*/u, "")
      .trim();
    if (next === title) break;
    title = next;
  }
  title = stripTrailingLatinGloss(title);
  const work = RankingUtils.normalizeSongWorkTitle(title).workTitle || title;
  return stripTrailingLatinGloss(work);
}

function stripTrailingLatinGloss(value) {
  const text = RankingUtils.cleanText(value).normalize("NFKC");
  if (!text) return "";
  const separated = text.match(/^(.+?)\s+(?:[-–—])\s+([A-Za-z][A-Za-z0-9 .,'’"“”&+_/!?()[\]-]{1,80})$/u);
  if (separated && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(separated[1])) return separated[1].trim();
  const bracketed = text.match(/^(.+?)\s*[(（［\[]\s*([A-Za-z][A-Za-z0-9 .,'’"“”&+_/!?()[\]-]{1,80})\s*[)）］\]]$/u);
  if (bracketed && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(bracketed[1])) return bracketed[1].trim();
  return text;
}

function incrementNamedCount(map, name) {
  const cleanName = RankingUtils.cleanText(name);
  const key = normalizeSearchText(cleanName);
  if (!key) return;
  if (!map.has(key)) map.set(key, { key, name: cleanName, count: 0 });
  map.get(key).count += 1;
}

function addRequestRecordFields(records) {
  for (const record of records || []) {
    if (typeof record.videoCount !== "number") record.videoCount = uniqueRuntimeVideoCount(record.occurrences || []);
    if (!record.searchText) record.searchText = requestRecordSearchText(record, record.type || (record.name ? "artist" : "song"));
  }
  return records;
}

function serializeSongRequestRecord(record, options = {}) {
  const occurrences = previewOccurrences(record.occurrences || [], REQUEST_PREVIEW_SOURCE_LIMIT);
  return {
    type: "song",
    detailKey: options.detailKey || "",
    key: record.key || "",
    title: record.title || "",
    workTitle: record.workTitle || record.title || "",
    sortKey: record.sortKey || record.title || "",
    count: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || uniqueRuntimeVideoCount(occurrences),
    timestampCount: Number(record.count) || 0,
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
  const occurrences = previewOccurrences(record.occurrences || [], REQUEST_PREVIEW_SOURCE_LIMIT);
  return {
    type: "artist",
    detailKey: options.detailKey || "",
    key: record.key || "",
    name: record.name || "",
    count: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || uniqueRuntimeVideoCount(occurrences),
    timestampCount: Number(record.count) || 0,
    songs: serializeCountMap(record.songs),
    channels: serializeCountMap(record.channels),
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    occurrences: occurrences.slice(0, REQUEST_PREVIEW_SOURCE_LIMIT).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    sourceDetailKey: options.sourceDetailKey || "",
    sourceDetailPath: "",
    searchText: requestRecordSearchText(record, "artist"),
  };
}

function serializeVideoRequestRecord(record, options = {}) {
  const payload = buildClientVideo(record);
  return {
    ...payload,
    type: "video",
    detailKey: options.detailKey || "",
    key: record.key || record.videoId || "",
    count: Number(record.count) || (Array.isArray(record.songs) ? record.songs.length : 0),
    videoCount: 1,
    timestampCount: Number(record.count) || (Array.isArray(record.songs) ? record.songs.length : 0),
    searchText: requestRecordSearchText(record, "video"),
  };
}

function serializeVtuberRequestRecord(record, options = {}) {
  const occurrences = previewOccurrences(record.occurrences || [], REQUEST_PREVIEW_SOURCE_LIMIT);
  return {
    type: "vtuber",
    detailKey: options.detailKey || "",
    key: record.key || "",
    name: record.name || record.channelName || "",
    channelName: record.channelName || record.name || "",
    channelId: record.channelId || "",
    channelHandle: record.channelHandle || "",
    channelUrl: record.channelUrl || "",
    avatarUrl: record.avatarUrl || "",
    thumbnailUrl: record.thumbnailUrl || record.videoThumbnailUrl || "",
    videoThumbnailUrl: record.videoThumbnailUrl || record.thumbnailUrl || "",
    sourceUrl: record.sourceUrl || record.channelUrl || "",
    knownSourceType: record.knownSourceType || "",
    isCollected: record.isCollected === true,
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    count: Number(record.count) || 0,
    songCount: Number(record.songCount) || 0,
    videoCount: Number(record.videoCount) || 0,
    timestampCount: Number(record.timestampCount ?? record.count) || 0,
    songs: serializeCountMap(record.songs),
    occurrences: occurrences.slice(0, REQUEST_PREVIEW_SOURCE_LIMIT).map((occurrence) => serializeOccurrence(occurrence, { includeCurrentSong: true })),
    sourceDetailKey: options.sourceDetailKey || "",
    sourceDetailPath: "",
    searchText: requestRecordSearchText(record, "vtuber"),
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

function previewOccurrences(occurrences, limit) {
  const sourceOccurrences = Array.isArray(occurrences) ? occurrences.filter(Boolean) : [];
  const maxItems = Math.max(1, Number(limit) || 1);
  const preview = [];
  const seenVideos = new Set();
  for (const occurrence of sourceOccurrences) {
    const videoKey = RankingUtils.cleanText(occurrence?.item?.videoId);
    if (videoKey && seenVideos.has(videoKey)) continue;
    if (videoKey) seenVideos.add(videoKey);
    preview.push(occurrence);
    if (preview.length >= maxItems) return preview;
  }
  return preview;
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

function sortRankRecords(records, metric) {
  return [...records].sort((a, b) => requestRankValue(b, metric) - requestRankValue(a, metric) || compareValues(a.name || a.sortKey || a.title || a.key, b.name || b.sortKey || b.title || b.key));
}

function compareSongAzRecords(a, b) {
  return compareValues(a.sortKey, b.sortKey) || (Number(b.count) || 0) - (Number(a.count) || 0) || compareValues(a.title, b.title);
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

function requestRankValue(record, metric) {
  if (metric === "songs") return Number(record.songCount) || 0;
  return metric === "videos" ? Number(record.videoCount) || 0 : Number(record.count) || 0;
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

function uniqueRuntimeVideoCount(occurrences) {
  return new Set((occurrences || []).map((occurrence) => occurrence.item?.videoId).filter(Boolean)).size;
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

function channelAliasValues(value, identity = {}) {
  const aliases = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  const identityTexts = new Set(
    [identity.channelName, identity.channelId, identity.channelHandle, identity.channelUrl]
      .map((item) => normalizeSearchText(RankingUtils.cleanText(item)))
      .filter(Boolean),
  );
  for (const alias of aliases) {
    const text = RankingUtils.cleanText(alias);
    const key = normalizeSearchText(text);
    if (!text || !key || isChannelPathAlias(text) || identityTexts.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function isChannelPathAlias(value) {
  const text = RankingUtils.cleanText(value).toLocaleLowerCase();
  return text.startsWith("/channel/") || text.includes("youtube.com/channel/");
}

function cleanChannelHandle(value) {
  const text = RankingUtils.cleanText(value);
  if (!text) return "";
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text)) return text.startsWith("/") ? text : `/${text}`;
  const match = text.match(/youtube\.com\/(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  return match ? `/${match[1]}` : "";
}

function preferredChannelDisplayName(current, candidate) {
  const currentText = RankingUtils.cleanText(current);
  const candidateText = RankingUtils.cleanText(candidate);
  if (!currentText) return candidateText;
  if (!candidateText) return currentText;
  return channelDisplayNameScore(candidateText) > channelDisplayNameScore(currentText) ? candidateText : currentText;
}

function channelDisplayNameScore(value) {
  const text = RankingUtils.cleanText(value);
  if (!text) return -1;
  let score = Math.min(text.length, 80);
  if (/[ぁ-ゖァ-ヺ一-龯々〆〤]/u.test(text)) score += 1000;
  if (isCompositeChannelName(text)) score -= 1200;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text) || /^\/channel\/UC[A-Za-z0-9_-]+$/u.test(text) || /^UC[A-Za-z0-9_-]{20,}$/u.test(text)) score -= 1000;
  return score;
}

function compareValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableRequestKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function stableDbKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
