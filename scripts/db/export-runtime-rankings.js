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
const { groupForRange, RANGE_TITLES } = require("../range-config");
const {
  RANGES,
  buildClientSong,
  buildClientVideo,
  buildRuntimeRangePayload,
} = require("../build-runtime-data");

const ROOT = path.resolve(__dirname, "..", "..");
const REQUEST_PREVIEW_SOURCE_LIMIT = positiveInteger(process.env.DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT, 3);

if (require.main === module) {
  main();
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const payload = readJson(args.input);
    const runtimeImports = loadRuntimeImports(args);
    const dataVersion = computeExportDataVersion(payload, args, runtimeImports);
    writeJsonlExport(args.output, payload, runtimeImports, dataVersion, args);
  } catch (error) {
    console.error(`CODEX_RUNTIME_RANKINGS_EXPORT_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
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

function writeJsonlExport(outputPath, payload, runtimeImports, dataVersion, args) {
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
    });

    for (const rangeId of args.ranges) {
      const rangePayload = buildRangePayload(payload, rangeId, args, runtimeImports);
      rangePayload.dataVersion = dataVersion;
      const items = Array.isArray(rangePayload.items) ? rangePayload.items : [];
      const occurrences = collectRuntimeOccurrences(items);
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

      const songRecords = addRequestRecordFields(RankingUtils.buildSongRecords(occurrences));
      const artistResult = RankingUtils.buildArtistRecords(occurrences);
      const artistRecords = addRequestRecordFields(artistResult.records || []);
      const videoRecords = buildVideoRequestItems(items);
      const vtuberRecords = buildVtuberRequestItems(items);
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
        const ranks = buildRequestRanks(spec.records, spec.metric);
        spec.records.forEach((record, index) => {
          const sourceDetailKey = spec.type === "video" || spec.type === "vtuber" ? "" : stableRequestKey(`${rangeId}:${spec.sourcePrefix}:all:${record.key || record.videoId || ""}`);
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
            const recordOccurrences = record.occurrences || [];
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
      }
      if (typeof global.gc === "function") global.gc();
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

function computeExportDataVersion(payload, args, runtimeImports = {}) {
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
    searchText: occurrence.searchText || normalizeSearchText([item.videoId, item.title, item.channelName, item.keyword, occurrence.song?.title, occurrence.song?.artist].join(" ")),
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
    for (const song of item.songs || []) {
      if (!RankingUtils.cleanText(song.title)) continue;
      occurrences.push({
        item,
        song,
        searchText: normalizeSearchText([item.videoId, item.title, item.channelName, item.channelId, item.channelHandle, item.channelUrl, item.keyword, song.title, song.artist].join(" ")),
      });
    }
  }
  return occurrences;
}

function buildVideoRequestItems(items) {
  const result = [];
  for (const item of items || []) {
    const scopedSongs = (item.songs || []).filter((song) => RankingUtils.cleanText(song.title));
    if (!scopedSongs.length) continue;
    result.push({
      ...item,
      songs: scopedSongs,
      _allSongs: item.songs || [],
      count: scopedSongs.length,
      videoCount: 1,
      key: item.videoId || stableRequestKey(`${item.channelName}:${item.title}`),
      searchText: normalizeSearchText(
        [item.videoId, item.title, item.channelName, item.channelId, item.channelHandle, item.channelUrl, item.keyword, ...scopedSongs.flatMap((song) => [song.title, song.artist])].join(" "),
      ),
    });
  }
  return result;
}

function buildVtuberRequestItems(items) {
  const records = new Map();
  const identityLookup = buildChannelIdentityLookup(items);
  for (const item of items || []) {
    const scopedSongs = (item.songs || []).filter((song) => RankingUtils.cleanText(song.title));
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
        channelHandle: RankingUtils.cleanText(item.channelHandle),
        channelUrl: RankingUtils.cleanText(item.channelUrl || item.authorUrl || item.ownerUrl),
        avatarUrl: RankingUtils.cleanText(item.avatarUrl || item.channelAvatarUrl),
        sourceUrl: RankingUtils.cleanText(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl),
        knownSourceType: RankingUtils.cleanText(item.knownSourceType),
        isCollected: item.isCollected === true || isCollectedSource(item),
        count: 0,
        songCount: 0,
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
    record.videos.add(videoKey);
    for (const song of scopedSongs) {
      record.count += 1;
      record.timestampCount += 1;
      incrementNamedCount(record.songs, RankingUtils.cleanText(song.title));
      if (record.occurrences.length < REQUEST_PREVIEW_SOURCE_LIMIT) {
        record.occurrences.push({
          item,
          song,
          searchText: normalizeSearchText([item.videoId, item.title, item.channelName, item.channelId, item.channelHandle, item.channelUrl, item.keyword, song.title, song.artist].join(" ")),
        });
      }
    }
  }
  return Array.from(records.values()).map((record) => {
    record.videoCount = record.videos.size;
    record.songCount = record.songs.size;
    record.aliases = Array.from(record.aliases.values());
    record.searchText = requestRecordSearchText(record, "vtuber");
    return record;
  });
}

function buildChannelIdentityLookup(items) {
  const nameToKey = new Map();
  const ambiguousNames = new Set();
  for (const item of items || []) {
    const scopedSongs = (item.songs || []).filter((song) => RankingUtils.cleanText(song.title));
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
  const channelId = RankingUtils.cleanText(item.channelId);
  if (channelId) return channelId;
  const handle = RankingUtils.cleanText(item.channelHandle).replace(/^\/+/, "");
  if (handle) return normalizeSearchText(handle);
  const urlHandle = handleFromChannelUrl(item.channelUrl || item.authorUrl || item.ownerUrl);
  if (urlHandle) return normalizeSearchText(urlHandle);
  return "";
}

function handleFromChannelUrl(value) {
  const match = String(value || "").match(/youtube\.com\/(@[A-Za-z0-9._-]+)/iu);
  return match ? match[1] : "";
}

function channelNameIdentityKey(item) {
  const name = RankingUtils.cleanText(item.channelName);
  return name ? normalizeSearchText(name) : "";
}

function mergeChannelRecordIdentity(record, item) {
  const channelName = RankingUtils.cleanText(item.channelName);
  const channelId = RankingUtils.cleanText(item.channelId);
  const channelHandle = RankingUtils.cleanText(item.channelHandle);
  const channelUrl = RankingUtils.cleanText(item.channelUrl || item.authorUrl || item.ownerUrl);
  const avatarUrl = RankingUtils.cleanText(item.avatarUrl || item.channelAvatarUrl);
  const sourceUrl = RankingUtils.cleanText(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl);
  const knownSourceType = RankingUtils.cleanText(item.knownSourceType || knownSourceTypeForVideo(item));
  if (channelName) {
    record.aliases.add(channelName);
    if (!record.channelName) record.channelName = channelName;
    if (!record.name || record.name === "未知频道") record.name = channelName;
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
  if (sourceUrl && !record.sourceUrl) record.sourceUrl = sourceUrl;
  if (knownSourceType && !record.knownSourceType) record.knownSourceType = knownSourceType;
  record.isCollected = record.isCollected === true || isCollectedSource(item);
  for (const alias of knownChannelSearchAliases(channelName)) record.aliases.add(alias);
}

function knownSourceTypeForVideo(item) {
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  if (sourceGroups.includes("youtube_channel_discovery")) return "youtube_channel_discovery";
  if (sourceGroups.includes("vsinger-moment")) return "vsinger_moment_http";
  return item.sourceQuality?.sourceSystem || "";
}

function isCollectedSource(item) {
  const sourceGroups = Array.isArray(item.sourceGroups) ? item.sourceGroups : [];
  return (
    sourceGroups.includes("youtube_channel_discovery") ||
    sourceGroups.includes("vsinger-moment") ||
    item.sourceQuality?.sourceType === "external" ||
    item.sourceQuality?.sourceSystem === "vsinger_moment_http"
  );
}

function knownChannelSearchAliases(channelName) {
  const key = normalizeSearchText(channelName);
  if (key === normalizeSearchText("Haru Ch. 花前ハル")) return ["HanamaeHaru", "Hanamae Haru", "花前ハル"];
  return [];
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
  const occurrences = record.occurrences || [];
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
  const occurrences = record.occurrences || [];
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
  const occurrences = record.occurrences || [];
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
    sourceDetailKey: "",
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
      normalizeSearchText([item.videoId, item.title, item.channelName, item.channelId, item.channelHandle, item.channelUrl, item.keyword, occurrence.song?.title, occurrence.song?.artist].join(" ")),
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
    return normalizeSearchText([record.name, record.channelName, record.channelId, record.channelHandle, record.channelUrl, ...(record.aliases || [])].join(" "));
  }
  if (type === "video") {
    return normalizeSearchText([record.videoId, record.title, record.channelName, record.channelId, record.channelHandle, record.channelUrl, record.keyword, ...(record.songs || []).flatMap((song) => [song.title, song.artist])].join(" "));
  }
  return normalizeSearchText([record.title, record.displayArtist, ...mapNames(record.artists), ...mapNames(record.channels), ...(record.variantLabels || [])].join(" "));
}

function mapNames(value) {
  if (value instanceof Map) return Array.from(value.values()).map((entry) => entry.name || entry.title || "");
  if (Array.isArray(value)) return value.map((entry) => entry.name || entry.title || "");
  return [];
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
