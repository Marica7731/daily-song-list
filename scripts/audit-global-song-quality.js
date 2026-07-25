#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { finished } = require("node:stream/promises");
const { once } = require("node:events");

const RankingUtils = require("../assets/ranking-utils");
const {
  applyCurationToVideos,
  buildTitleOccurrenceStats,
  hashNormalizedText,
  isUnknownArtist,
  loadCurationContext,
} = require("./curation");
const { repairParsedEntry } = require("./entry-repair");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { normalizeParsedSong, normalizeSourceAwareArtist } = require("./song-utils");
const { groupForRange } = require("./range-config");
const {
  loadVsingerBackfillRuntimeVideos,
  mergeVideoItems,
  sortVideos,
} = require("./vsinger-http/runtime-importer");
const {
  loadYoutubeChannelDiscoveryRuntimeVideos,
} = require("./youtube-channel-discovery-runtime");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_BATCH_TAG = "global-singleton-20260726";
const UNKNOWN_ARTIST = "未記載";
const INVENTORY_SCHEMA_VERSION = 1;
const REPORT_SCHEMA_VERSION = 1;

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_GLOBAL_SONG_AUDIT_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.mkdirSync(args.checkpointDir, { recursive: true });
  const inventoryPath = path.join(args.checkpointDir, "inventory.jsonl.gz");
  const inventoryMetaPath = path.join(args.checkpointDir, "inventory-meta.json");
  const inventoryKey = computeInventoryKey(args);

  let inventoryMeta = readJsonIfExists(inventoryMetaPath);
  const canResume = Boolean(
    args.resume
      && inventoryMeta?.schemaVersion === INVENTORY_SCHEMA_VERSION
      && inventoryMeta.inventoryKey === inventoryKey
      && fs.existsSync(inventoryPath),
  );
  if (canResume) {
    logPhase("inventory_resume", { videos: inventoryMeta.videoCount, occurrences: inventoryMeta.occurrenceCount });
  } else {
    inventoryMeta = await buildInventory(args, inventoryPath, inventoryKey);
    writeJsonAtomic(inventoryMetaPath, inventoryMeta);
  }

  const report = await analyzeInventory(args, inventoryPath, inventoryMeta);
  writeReportArtifacts(args, inventoryMeta, report);
  console.log(
    `CODEX_GLOBAL_SONG_AUDIT_OK output=${args.outputDir} `
      + `videos=${report.after.counts.videos} songs=${report.after.counts.songs} `
      + `occurrences=${report.after.counts.occurrences} singleton=${report.after.counts.singletonSongs} `
      + `unknownOccurrences=${report.after.counts.unknownArtistOccurrences}`,
  );
}

function parseArgs(argv) {
  const args = {
    input: path.join(ROOT, "data", "latest.json"),
    outputDir: "",
    checkpointDir: "",
    vsingerDir: path.join(ROOT, "data", "external", "vsinger-http", "backfill"),
    youtubeDir: path.join(ROOT, "data", "external", "youtube-channel-discovery"),
    batchTag: DEFAULT_BATCH_TAG,
    resume: true,
    requireVsinger: false,
    requireYoutube: false,
    allowPartialVsinger: false,
    yoshikaHandle: "@YOSHIKA-Ch",
    expectedSelectorCount: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--input") args.input = requireValue(argv, ++index, name);
    else if (name === "--output-dir") args.outputDir = requireValue(argv, ++index, name);
    else if (name === "--checkpoint-dir") args.checkpointDir = requireValue(argv, ++index, name);
    else if (name === "--vsinger-dir") args.vsingerDir = requireValue(argv, ++index, name);
    else if (name === "--youtube-dir") args.youtubeDir = requireValue(argv, ++index, name);
    else if (name === "--batch-tag") args.batchTag = requireValue(argv, ++index, name);
    else if (name === "--yoshika-handle") args.yoshikaHandle = requireValue(argv, ++index, name);
    else if (name === "--expected-selector-count") args.expectedSelectorCount = positiveInteger(requireValue(argv, ++index, name), 0);
    else if (name === "--require-vsinger") args.requireVsinger = true;
    else if (name === "--allow-partial-vsinger") args.allowPartialVsinger = true;
    else if (name === "--require-youtube-channel-discovery") args.requireYoutube = true;
    else if (name === "--no-resume") args.resume = false;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!args.outputDir) throw new Error("--output-dir is required");
  args.input = path.resolve(args.input);
  args.outputDir = path.resolve(args.outputDir);
  args.checkpointDir = path.resolve(args.checkpointDir || path.join(args.outputDir, "checkpoint"));
  args.vsingerDir = path.resolve(args.vsingerDir);
  args.youtubeDir = path.resolve(args.youtubeDir);
  return args;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function computeInventoryKey(args) {
  return sha256Json({
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    input: contentIdentity(args.input),
    vsingerDirectory: contentIdentity(args.vsingerDir),
    youtubeDirectory: contentIdentity(args.youtubeDir),
    inventoryCode: [
      contentIdentity(__filename),
      contentIdentity(path.join(__dirname, "range-config.js")),
      contentIdentity(path.join(__dirname, "vsinger-http", "runtime-importer.js")),
      contentIdentity(path.join(__dirname, "youtube-channel-discovery-runtime.js")),
    ],
  });
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function contentIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const relativePath = path.relative(ROOT, filePath).replace(/\\/gu, "/");
    const gitObject = gitObjectIdentity(relativePath);
    if (gitObject) {
      return {
        path: relativePath,
        kind: stat.isDirectory() ? "directory" : "file",
        gitObject,
      };
    }
    if (stat.isDirectory()) return directoryIdentity(filePath);
    return {
      path: relativePath,
      bytes: stat.size,
      sha256: sha256File(filePath),
    };
  } catch {
    return null;
  }
}

function gitObjectIdentity(relativePath) {
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return "";
  }
  try {
    return execFileSync(
      "git",
      ["rev-parse", `HEAD:${relativePath}`],
      { cwd: ROOT, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "";
  }
}

function directoryIdentity(directoryPath) {
  try {
    const files = [];
    const pending = [""];
    while (pending.length) {
      const relativeDirectory = pending.pop();
      const absoluteDirectory = path.join(directoryPath, relativeDirectory);
      const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativeEntry = path.join(relativeDirectory, entry.name);
        const absoluteEntry = path.join(directoryPath, relativeEntry);
        if (entry.isDirectory()) {
          pending.push(relativeEntry);
        } else if (entry.isFile()) {
          const stat = fs.statSync(absoluteEntry);
          files.push([
            relativeEntry.replace(/\\/gu, "/"),
            stat.size,
            sha256File(absoluteEntry),
          ]);
        }
      }
    }
    files.sort((left, right) => left[0].localeCompare(right[0]));
    return { path: path.relative(ROOT, directoryPath).replace(/\\/gu, "/"), files };
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

async function buildInventory(args, inventoryPath, inventoryKey) {
  logPhase("inventory_load_start", { input: args.input });
  const payload = readJson(args.input);
  const group = groupForRange(payload.groups, "all") || {};
  const baseItems = tagAuditSource(Array.isArray(group.items) ? group.items : [], "base");
  const youtube = loadYoutubeChannelDiscoveryRuntimeVideos({
    importDir: args.youtubeDir,
    required: args.requireYoutube,
  });
  const vsinger = loadVsingerBackfillRuntimeVideos({
    backfillDir: args.vsingerDir,
    required: args.requireVsinger,
    allowPartial: args.allowPartialVsinger,
  });
  logPhase("inventory_load_ok", {
    baseVideos: baseItems.length,
    youtubeVideos: youtube?.videos?.length || 0,
    vsingerVideos: vsinger?.videos?.length || 0,
  });

  let merged = { items: baseItems };
  if (youtube) merged = mergeVideoItems(merged.items, tagAuditSource(youtube.videos, "youtube_channel_discovery"));
  if (vsinger) merged = mergeVideoItems(merged.items, tagAuditSource(vsinger.videos, "vsinger_moment_http"));
  const items = sortVideos(merged.items);

  const tempPath = `${inventoryPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  const output = fs.createWriteStream(tempPath);
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(output);
  let occurrenceCount = 0;
  for (const [index, item] of items.entries()) {
    occurrenceCount += Array.isArray(item.songs) ? item.songs.length : 0;
    if (!gzip.write(`${JSON.stringify(item)}\n`)) await once(gzip, "drain");
    if ((index + 1) % 5_000 === 0) {
      logPhase("inventory_write_progress", { videos: index + 1, occurrences: occurrenceCount });
    }
  }
  gzip.end();
  await finished(output);
  fs.renameSync(tempPath, inventoryPath);
  const meta = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    inventoryKey,
    headSha: gitHead(),
    createdAt: new Date().toISOString(),
    input: path.relative(ROOT, args.input).replace(/\\/gu, "/"),
    sources: {
      baseVideos: baseItems.length,
      youtubeVideos: youtube?.videos?.length || 0,
      vsingerVideos: vsinger?.videos?.length || 0,
    },
    videoCount: items.length,
    occurrenceCount,
    bytes: fs.statSync(inventoryPath).size,
    sha256: sha256(fs.readFileSync(inventoryPath)),
  };
  logPhase("inventory_write_ok", { videos: meta.videoCount, occurrences: meta.occurrenceCount, bytes: meta.bytes });
  return meta;
}

function tagAuditSource(videos, sourceName) {
  return (videos || []).map((video) => ({
    ...video,
    auditSources: uniqueTextValues([...(video.auditSources || []), sourceName]),
    songs: (video.songs || []).map((song) => ({
      ...song,
      auditSource: song.auditSource || sourceName,
    })),
  }));
}

async function analyzeInventory(args, inventoryPath, inventoryMeta) {
  const curationContext = loadCurationContext();
  const aliasContext = loadSongAliasContext();
  if (aliasContext.errors?.length) throw new Error(`song alias config invalid: ${aliasContext.errors.join("; ")}`);
  const batchRecords = curationContext.overrides.records.filter((record) => recordIncludesBatchTag(record, args.batchTag));
  if (args.expectedSelectorCount && batchRecords.length !== args.expectedSelectorCount) {
    throw new Error(`expected ${args.expectedSelectorCount} batch selectors, found ${batchRecords.length}`);
  }
  const baselineContext = {
    ...curationContext,
    overrides: {
      ...curationContext.overrides,
      records: curationContext.overrides.records.filter((record) => !recordIncludesBatchTag(record, args.batchTag)),
    },
  };

  logPhase("title_stats_start");
  const titleStats = await buildInventoryTitleStats(inventoryPath);
  logPhase("title_stats_ok", { titles: titleStats.size });
  baselineContext.titleStats = titleStats;
  curationContext.titleStats = titleStats;

  const raw = createAccumulator("raw");
  const before = createAccumulator("before");
  const after = createAccumulator("after");
  const selectorMatches = batchRecords.map((record, index) => ({
    index,
    selector: record,
    matchCount: 0,
    matches: [],
  }));
  const changes = {
    removed: [],
    replaced: [],
    removedCount: 0,
    replacedCount: 0,
  };

  let videoCount = 0;
  await forEachInventoryVideo(inventoryPath, (video) => {
    videoCount += 1;
    const enriched = enrichVideoSelectors(video);
    addVideoToAccumulator(raw, enriched);
    recordSelectorMatches(selectorMatches, enriched);

    const beforeVideos = applyCurationToVideos([enriched], baselineContext);
    const afterVideos = applyCurationToVideos([enriched], curationContext);
    const beforeVideo = canonicalizeVideo(beforeVideos[0], aliasContext);
    const afterVideo = canonicalizeVideo(afterVideos[0], aliasContext);
    if (beforeVideo) addVideoToAccumulator(before, beforeVideo);
    if (afterVideo) addVideoToAccumulator(after, afterVideo);
    recordVideoChanges(changes, beforeVideo, afterVideo);

    if (videoCount % 5_000 === 0) logPhase("analyze_progress", { videos: videoCount });
  });

  const badSelectors = selectorMatches.filter((item) => item.matchCount !== 1);
  if (badSelectors.length) {
    const summary = badSelectors.map((item) => `${item.selector.videoId}@${item.selector.seconds}:${item.matchCount}`).join(",");
    throw new Error(`batch selectors must match exactly one inventory row: ${summary}`);
  }

  const finalized = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    headSha: inventoryMeta.headSha,
    generatedAt: new Date().toISOString(),
    batchTag: args.batchTag,
    inventory: inventoryMeta,
    curation: {
      version: curationContext.version,
      hash: curationContext.hash,
      totalOverrideCount: curationContext.overrides.records.length,
      batchOverrideCount: batchRecords.length,
      aliasVersion: aliasContext.aliasVersion,
    },
    raw: finalizeAccumulator(raw),
    before: finalizeAccumulator(before),
    after: finalizeAccumulator(after),
    changes: {
      removedCount: changes.removedCount,
      replacedCount: changes.replacedCount,
      removedSamples: changes.removed.slice(0, 100),
      replacedSamples: changes.replaced.slice(0, 100),
    },
    selectorMatches,
  };
  finalized.yoshika = buildYoshikaReport(finalized, args.yoshikaHandle);
  return finalized;
}

async function buildInventoryTitleStats(inventoryPath) {
  const videos = [];
  await forEachInventoryVideo(inventoryPath, (video) => {
    videos.push({
      videoId: video.videoId,
      songs: (video.songs || []).map((song) => ({ title: song.title })),
    });
  });
  return buildTitleOccurrenceStats(videos);
}

async function forEachInventoryVideo(inventoryPath, callback) {
  const input = fs.createReadStream(inventoryPath).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    callback(JSON.parse(line));
  }
}

function enrichVideoSelectors(video) {
  const videoSource = {
    sourceId: cleanText(video.selectedSourceId || video.sourceId || (video.videoId ? `legacy:${video.videoId}` : "")),
    sourceHash: cleanText(
      video.selectedSourceHash
        || video.sourceHash
        || hashNormalizedText(JSON.stringify((video.songs || []).map((song) => [song.seconds, song.title, song.artist, song.raw || ""]))),
    ),
  };
  return {
    ...video,
    songs: (video.songs || []).map((song) => ({
      ...song,
      sourceId: cleanText(song.sourceId || videoSource.sourceId),
      sourceHash: cleanText(song.sourceHash || videoSource.sourceHash),
      rawHash: cleanText(song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`)),
    })),
  };
}

function recordSelectorMatches(selectorMatches, video) {
  for (const item of selectorMatches) {
    const record = item.selector;
    if (record.videoId !== video.videoId) continue;
    if (record.action === "drop_video") {
      item.matchCount += 1;
      item.matches.push(selectorEvidence(video, null));
      continue;
    }
    for (const song of video.songs || []) {
      if (!selectorMatchesSong(record, video, song)) continue;
      item.matchCount += 1;
      if (item.matches.length < 5) item.matches.push(selectorEvidence(video, song));
    }
  }
}

function selectorMatchesSong(record, video, song) {
  if (record.videoId !== video.videoId) return false;
  const sourceIds = new Set([song.sourceId, video.selectedSourceId, video.sourceId].map(cleanText).filter(Boolean));
  const sourceHashes = new Set([song.sourceHash, video.selectedSourceHash, video.sourceHash].map(cleanText).filter(Boolean));
  if (record.sourceId && !sourceIds.has(record.sourceId)) return false;
  if (record.sourceHash && !sourceHashes.has(record.sourceHash)) return false;
  if (Number.isInteger(record.seconds) && Number(song.seconds) !== record.seconds) return false;
  if (record.rawHash && song.rawHash !== record.rawHash) return false;
  return true;
}

function selectorEvidence(video, song) {
  return {
    videoId: video.videoId,
    channelName: cleanText(video.channelName),
    channelHandle: cleanText(video.channelHandle),
    seconds: song ? Number(song.seconds) || 0 : null,
    title: cleanText(song?.title),
    artist: normalizedArtist(song?.artist),
    raw: cleanText(song?.raw),
    sourceId: cleanText(song?.sourceId || video.selectedSourceId || video.sourceId),
    sourceHash: cleanText(song?.sourceHash || video.selectedSourceHash || video.sourceHash),
    rawHash: cleanText(song?.rawHash),
    auditSource: cleanText(song?.auditSource || auditSourceForVideo(video)),
  };
}

function canonicalizeVideo(video, aliasContext) {
  if (!video) return null;
  return {
    ...video,
    songs: (video.songs || []).map((song) => canonicalizeSongIdentity(normalizeAuditSong(song, video), aliasContext)),
  };
}

function normalizeAuditSong(song, video) {
  return normalizeSourceAwareArtist(repairParsedEntry(normalizeParsedSong(song)), video);
}

function createAccumulator(label) {
  return {
    label,
    videos: new Set(),
    occurrences: 0,
    identities: new Map(),
    titles: new Map(),
    unknownIdentities: new Set(),
    unknownVideos: new Set(),
    layers: new Map(),
    channels: new Map(),
    titlePatterns: new Map(),
    titleArtists: new Map(),
    variantGroups: new Map(),
    samples: {
      unknown: [],
      singletonCandidate: [],
      numeric: [],
      conversation: [],
      featOrAnnotation: [],
    },
  };
}

function addVideoToAccumulator(accumulator, video) {
  const songs = Array.isArray(video.songs) ? video.songs : [];
  if (!songs.length) return;
  const channelKey = channelIdentity(video);
  const channel = getChannelAccumulator(accumulator.channels, channelKey, video);
  accumulator.videos.add(video.videoId);
  channel.videos.add(video.videoId);
  for (const originalSong of songs) {
    const sourceTitle = cleanText(originalSong.canonicalTitle || originalSong.title);
    const song = normalizeAuditSong(originalSong, video);
    const title = cleanText(song.canonicalTitle || song.title);
    if (!title) continue;
    const artist = normalizedArtist(song.canonicalArtist || song.artist);
    const titleKey = titleIdentity(title);
    const identity = songIdentity(title, artist);
    const unknown = isUnknownArtist(artist);
    const layer = cleanText(song.auditSource || auditSourceForVideo(video)) || "unknown";
    const pattern = classifyTitlePattern(title, artist);
    const evidence = selectorEvidence(video, { ...song, title, artist });

    accumulator.occurrences += 1;
    incrementMap(accumulator.identities, identity);
    incrementMap(accumulator.titles, titleKey);
    if (unknown) {
      accumulator.unknownIdentities.add(identity);
      accumulator.unknownVideos.add(video.videoId);
      pushSample(accumulator.samples.unknown, evidence, 100);
    }
    incrementLayer(accumulator.layers, layer, identity, unknown, video.videoId);
    incrementChannel(channel, identity, unknown, pattern, evidence);
    incrementMap(accumulator.titlePatterns, pattern);
    recordTitleArtist(accumulator.titleArtists, titleKey, title, artist, unknown, evidence);
    recordTitleVariant(accumulator.variantGroups, sourceTitle || title, artist, unknown, evidence);

    if (pattern === "numeric_only") pushSample(accumulator.samples.numeric, evidence, 100);
    if (pattern === "conversation_or_transition") pushSample(accumulator.samples.conversation, evidence, 100);
    if (pattern === "feat_or_annotation") pushSample(accumulator.samples.featOrAnnotation, evidence, 100);
  }
}

function getChannelAccumulator(channels, key, video) {
  if (!channels.has(key)) {
    channels.set(key, {
      key,
      name: cleanText(video.channelName),
      channelId: cleanText(video.channelId),
      handle: normalizeHandle(video.channelHandle || video.channelUrl || video.sourceUrl),
      videos: new Set(),
      occurrences: 0,
      identities: new Map(),
      unknownIdentities: new Set(),
      unknownOccurrences: 0,
      patterns: new Map(),
      samples: [],
      flaggedSamples: {
        numeric: [],
        conversationOrTransition: [],
        unknownArtist: [],
      },
    });
  }
  return channels.get(key);
}

function incrementChannel(channel, identity, unknown, pattern, evidence) {
  channel.occurrences += 1;
  incrementMap(channel.identities, identity);
  if (unknown) {
    channel.unknownOccurrences += 1;
    channel.unknownIdentities.add(identity);
    pushSample(channel.flaggedSamples.unknownArtist, evidence, 250);
  }
  incrementMap(channel.patterns, pattern);
  if (pattern === "numeric_only") pushSample(channel.flaggedSamples.numeric, evidence, 250);
  if (pattern === "conversation_or_transition") pushSample(channel.flaggedSamples.conversationOrTransition, evidence, 250);
  pushSample(channel.samples, evidence, 20);
}

function incrementLayer(layers, name, identity, unknown, videoId) {
  if (!layers.has(name)) {
    layers.set(name, {
      videos: new Set(),
      occurrences: 0,
      identities: new Map(),
      unknownIdentities: new Set(),
      unknownOccurrences: 0,
    });
  }
  const layer = layers.get(name);
  layer.videos.add(videoId);
  layer.occurrences += 1;
  incrementMap(layer.identities, identity);
  if (unknown) {
    layer.unknownOccurrences += 1;
    layer.unknownIdentities.add(identity);
  }
}

function recordTitleArtist(records, titleKey, title, artist, unknown, evidence) {
  if (!records.has(titleKey)) {
    records.set(titleKey, {
      title,
      knownArtists: new Map(),
      unknownCount: 0,
      unknownSamples: [],
    });
  }
  const record = records.get(titleKey);
  if (unknown) {
    record.unknownCount += 1;
    pushSample(record.unknownSamples, evidence, 5);
  } else {
    incrementMap(record.knownArtists, artist);
  }
}

function recordTitleVariant(records, title, artist, unknown, evidence) {
  const key = titleVariantKey(title);
  if (!key) return;
  if (!records.has(key)) {
    records.set(key, {
      canonicalKey: key,
      variants: new Map(),
      variantSamples: new Map(),
      knownArtists: new Map(),
      unknownOccurrences: 0,
    });
  }
  const record = records.get(key);
  incrementMap(record.variants, title);
  if (!record.variantSamples.has(title)) record.variantSamples.set(title, []);
  pushSample(record.variantSamples.get(title), evidence, 5);
  if (unknown) record.unknownOccurrences += 1;
  else incrementMap(record.knownArtists, artist);
}

function finalizeAccumulator(accumulator) {
  const singletonIdentities = new Set(
    Array.from(accumulator.identities.entries()).filter(([, count]) => count === 1).map(([identity]) => identity),
  );
  const unknownSingletonIdentities = new Set(
    Array.from(singletonIdentities).filter((identity) => accumulator.unknownIdentities.has(identity)),
  );
  const channels = Array.from(accumulator.channels.values()).map((channel) => finalizeChannel(channel));
  const layers = Object.fromEntries(
    Array.from(accumulator.layers.entries()).map(([name, layer]) => [name, finalizeLayer(layer)]),
  );
  const unknownFillCandidates = [];
  const conflictingArtistTitles = [];
  const titleVariantCandidates = [];
  for (const record of accumulator.titleArtists.values()) {
    const artists = sortedCountEntries(record.knownArtists);
    if (artists.length > 1) {
      conflictingArtistTitles.push({
        title: record.title,
        unknownOccurrences: record.unknownCount,
        knownArtists: artists,
        unknownSamples: record.unknownSamples,
      });
    }
    if (!record.unknownCount || !artists.length) continue;
    const candidate = {
      title: record.title,
      unknownOccurrences: record.unknownCount,
      knownArtists: artists,
      unknownSamples: record.unknownSamples,
    };
    if (artists.length === 1 && artists[0].count >= 3) unknownFillCandidates.push(candidate);
  }
  for (const record of accumulator.variantGroups.values()) {
    const variants = sortedCountEntries(record.variants).map((variant) => ({
      ...variant,
      samples: record.variantSamples.get(variant.name) || [],
    }));
    if (variants.length <= 1) continue;
    titleVariantCandidates.push({
      canonicalKey: record.canonicalKey,
      variants,
      knownArtists: sortedCountEntries(record.knownArtists),
      unknownOccurrences: record.unknownOccurrences,
    });
  }
  unknownFillCandidates.sort((a, b) => b.unknownOccurrences - a.unknownOccurrences || b.knownArtists[0].count - a.knownArtists[0].count);
  conflictingArtistTitles.sort((a, b) => b.unknownOccurrences - a.unknownOccurrences);
  titleVariantCandidates.sort((a, b) => (
    b.variants.reduce((sum, item) => sum + item.count, 0)
      - a.variants.reduce((sum, item) => sum + item.count, 0)
      || b.variants.length - a.variants.length
  ));

  const singletonSamples = channels
    .flatMap((channel) => channel.samples)
    .filter((sample) => singletonIdentities.has(songIdentity(sample.title, sample.artist)))
    .filter((sample) => classifyTitlePattern(sample.title, sample.artist) === "normal")
    .slice(0, 100);
  accumulator.samples.singletonCandidate = singletonSamples;

  return {
    counts: {
      videos: accumulator.videos.size,
      songs: accumulator.identities.size,
      canonicalTitles: accumulator.titles.size,
      occurrences: accumulator.occurrences,
      unknownArtistSongs: accumulator.unknownIdentities.size,
      unknownArtistOccurrences: Array.from(accumulator.channels.values()).reduce((sum, channel) => sum + channel.unknownOccurrences, 0),
      unknownArtistVideos: accumulator.unknownVideos.size,
      singletonSongs: singletonIdentities.size,
      singletonUnknownSongs: unknownSingletonIdentities.size,
    },
    bySource: layers,
    byTitlePattern: Object.fromEntries(sortedCountEntries(accumulator.titlePatterns).map(({ name, count }) => [name, count])),
    channels: channels.sort(compareChannelAuditRows),
    unknownFillCandidates: unknownFillCandidates.slice(0, 250),
    conflictingArtistTitles: conflictingArtistTitles.slice(0, 250),
    titleVariantCandidates: titleVariantCandidates.slice(0, 500),
    samples: accumulator.samples,
  };
}

function finalizeChannel(channel) {
  const singletonSongs = Array.from(channel.identities.values()).filter((count) => count === 1).length;
  const singletonUnknownSongs = Array.from(channel.identities.entries())
    .filter(([, count]) => count === 1)
    .filter(([identity]) => channel.unknownIdentities.has(identity))
    .length;
  return {
    key: channel.key,
    name: channel.name,
    channelId: channel.channelId,
    handle: channel.handle,
    videos: channel.videos.size,
    songs: channel.identities.size,
    occurrences: channel.occurrences,
    unknownArtistSongs: channel.unknownIdentities.size,
    unknownArtistOccurrences: channel.unknownOccurrences,
    singletonSongs,
    singletonUnknownSongs,
    titlePatterns: Object.fromEntries(sortedCountEntries(channel.patterns).map(({ name, count }) => [name, count])),
    flaggedSamples: channel.flaggedSamples,
    samples: channel.samples,
  };
}

function finalizeLayer(layer) {
  return {
    videos: layer.videos.size,
    songs: layer.identities.size,
    occurrences: layer.occurrences,
    unknownArtistSongs: layer.unknownIdentities.size,
    unknownArtistOccurrences: layer.unknownOccurrences,
    singletonSongs: Array.from(layer.identities.values()).filter((count) => count === 1).length,
  };
}

function recordVideoChanges(changes, beforeVideo, afterVideo) {
  if (!beforeVideo) return;
  const afterBySelector = new Map((afterVideo?.songs || []).map((song) => [stableSongSelector(afterVideo, song), song]));
  for (const song of beforeVideo.songs || []) {
    const selector = stableSongSelector(beforeVideo, song);
    const next = afterBySelector.get(selector);
    if (!next) {
      changes.removedCount += 1;
      pushSample(changes.removed, selectorEvidence(beforeVideo, song), 100);
      continue;
    }
    if (cleanText(next.title) !== cleanText(song.title) || normalizedArtist(next.artist) !== normalizedArtist(song.artist)) {
      changes.replacedCount += 1;
      pushSample(changes.replaced, {
        before: selectorEvidence(beforeVideo, song),
        after: selectorEvidence(afterVideo, next),
      }, 100);
    }
  }
}

function stableSongSelector(video, song) {
  return [
    video.videoId,
    cleanText(song.sourceId || video.selectedSourceId || video.sourceId),
    Number(song.seconds) || 0,
    cleanText(song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`)),
  ].join("\u0001");
}

function buildYoshikaReport(report, handle) {
  const match = (row) => normalizeHandle(row.handle) === normalizeHandle(handle)
    || cleanText(row.channelId) === "UC3xQCiEPSkco54WhuiDcngw"
    || /YOSHIKA/u.test(cleanText(row.name));
  const unknownFillCandidates = report.before.unknownFillCandidates.filter((candidate) => (
    candidate.unknownSamples.some((sample) => match({
      handle: sample.channelHandle,
      channelId: "",
      name: sample.channelName,
    }))
  ));
  return {
    handle: normalizeHandle(handle),
    raw: aggregateMatchedChannels(report.raw.channels, match),
    before: aggregateMatchedChannels(report.before.channels, match),
    after: aggregateMatchedChannels(report.after.channels, match),
    removedSamples: report.changes.removedSamples.filter((sample) => match({
      handle: sample.channelHandle,
      channelId: "",
      name: sample.channelName,
    })),
    replacedSamples: report.changes.replacedSamples.filter((sample) => match({
      handle: sample.before?.channelHandle,
      channelId: "",
      name: sample.before?.channelName,
    })),
    unknownFillCandidates,
  };
}

function aggregateMatchedChannels(channels, match) {
  const rows = channels.filter(match);
  if (!rows.length) return null;
  const aggregated = {
    key: rows[0].key,
    keys: rows.map((row) => row.key),
    name: rows.find((row) => row.name)?.name || "",
    channelId: rows.find((row) => row.channelId)?.channelId || "",
    handle: rows.find((row) => row.handle)?.handle || "",
    titlePatterns: {},
    flaggedSamples: {
      numeric: [],
      conversationOrTransition: [],
      unknownArtist: [],
    },
    samples: [],
  };
  for (const field of [
    "videos",
    "songs",
    "occurrences",
    "unknownArtistSongs",
    "unknownArtistOccurrences",
    "singletonSongs",
    "singletonUnknownSongs",
  ]) {
    aggregated[field] = rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
  }
  for (const row of rows) {
    for (const [pattern, count] of Object.entries(row.titlePatterns || {})) {
      aggregated.titlePatterns[pattern] = (aggregated.titlePatterns[pattern] || 0) + (Number(count) || 0);
    }
    for (const name of Object.keys(aggregated.flaggedSamples)) {
      aggregated.flaggedSamples[name].push(...(row.flaggedSamples?.[name] || []));
      aggregated.flaggedSamples[name] = aggregated.flaggedSamples[name].slice(0, 250);
    }
    aggregated.samples.push(...(row.samples || []));
    aggregated.samples = aggregated.samples.slice(0, 100);
  }
  return aggregated;
}

function writeReportArtifacts(args, inventoryMeta, report) {
  const globalReport = {
    schemaVersion: report.schemaVersion,
    headSha: report.headSha,
    generatedAt: report.generatedAt,
    batchTag: report.batchTag,
    inventory: report.inventory,
    curation: report.curation,
    raw: report.raw,
    before: report.before,
    after: report.after,
    changes: report.changes,
  };
  writeJsonAtomic(path.join(args.outputDir, "global-before-after.json"), globalReport);
  writeJsonAtomic(path.join(args.outputDir, "selector-matches.json"), {
    schemaVersion: REPORT_SCHEMA_VERSION,
    batchTag: args.batchTag,
    records: report.selectorMatches,
  });
  writeJsonAtomic(path.join(args.outputDir, "yoshika-before-after.json"), report.yoshika);
  writeJsonAtomic(path.join(args.outputDir, "flagged-samples.json"), {
    before: report.before.samples,
    after: report.after.samples,
    unknownFillCandidates: report.before.unknownFillCandidates,
    conflictingArtistTitles: report.before.conflictingArtistTitles,
    titleVariantCandidates: report.before.titleVariantCandidates,
  });
  fs.writeFileSync(path.join(args.outputDir, "audit.md"), renderMarkdown(report), "utf8");
  const artifactNames = [
    "global-before-after.json",
    "selector-matches.json",
    "yoshika-before-after.json",
    "flagged-samples.json",
    "audit.md",
  ];
  const manifest = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: "complete",
    headSha: report.headSha,
    generatedAt: report.generatedAt,
    batchTag: args.batchTag,
    inventory: inventoryMeta,
    artifacts: Object.fromEntries(artifactNames.map((name) => [name, fileDigest(path.join(args.outputDir, name))])),
  };
  writeJsonAtomic(path.join(args.outputDir, "manifest.json"), manifest);
}

function renderMarkdown(report) {
  const before = report.before.counts;
  const after = report.after.counts;
  const yoshikaBefore = report.yoshika.before || {};
  const yoshikaAfter = report.yoshika.after || {};
  const lines = [
    "# Global singleton and unknown-artist audit",
    "",
    `- Head: \`${report.headSha}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Batch tag: \`${report.batchTag}\``,
    `- Inventory checkpoint: ${report.inventory.videoCount} videos / ${report.inventory.occurrenceCount} occurrences`,
    "",
    "## Global before / after",
    "",
    "| Metric | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const key of [
    "videos",
    "songs",
    "occurrences",
    "unknownArtistSongs",
    "unknownArtistOccurrences",
    "unknownArtistVideos",
    "singletonSongs",
    "singletonUnknownSongs",
  ]) {
    lines.push(`| ${key} | ${before[key]} | ${after[key]} | ${after[key] - before[key]} |`);
  }
  lines.push(
    "",
    "## YOSHIKA-Ch before / after",
    "",
    "| Metric | Before | After | Delta |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const key of ["videos", "songs", "occurrences", "unknownArtistSongs", "unknownArtistOccurrences", "singletonSongs"]) {
    const left = Number(yoshikaBefore[key]) || 0;
    const right = Number(yoshikaAfter[key]) || 0;
    lines.push(`| ${key} | ${left} | ${right} | ${right - left} |`);
  }
  lines.push(
    "",
    "## Selector verification",
    "",
    ...report.selectorMatches.map((item) => (
      `- \`${item.selector.action}\` ${item.selector.videoId}@${item.selector.seconds ?? "-"}: ${item.matchCount} exact match`
    )),
    "",
    "## Highest-risk channels before",
    "",
    "| Channel | Videos | Songs | Occurrences | Unknown occurrences | Singleton songs |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.before.channels.slice(0, 50).map((row) => (
      `| ${escapeMarkdown(row.name || row.handle || row.key)} | ${row.videos} | ${row.songs} | ${row.occurrences} | `
        + `${row.unknownArtistOccurrences} | ${row.singletonSongs} |`
    )),
    "",
    "Singleton and unknown-artist rows are candidates only. No entry is removed by frequency alone.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function classifyTitlePattern(title, artist = "") {
  const text = cleanText(title);
  if (/^\d{3,}$/u.test(text)) return "numeric_only";
  if (/(?:雑談|トーク|休憩|戻り|開始|終了|閉会|挨拶|お知らせ|告知|自己紹介|コメント|アンケート|リアクション|突破)/u.test(text)
      && isUnknownArtist(normalizedArtist(artist))) return "conversation_or_transition";
  if (/(?:feat\.?|ft\.?|cover|ver\.?|version|\([^)]{2,}\)|（[^）]{2,}）|\[[^\]]{2,}\]|【[^】]{2,}】)/iu.test(text)) {
    return "feat_or_annotation";
  }
  if (/[\p{Extended_Pictographic}\uFE0F]/gu.test(text)) return "emoji";
  if (/^(?:[?？!！…・~～\-ー]){1,8}$/u.test(text)) return "punctuation_only";
  if (text.length <= 2) return "very_short";
  return "normal";
}

function auditSourceForVideo(video) {
  if ((video.sourceGroups || []).includes("youtube_channel_discovery") || video.discoveryImport) return "youtube_channel_discovery";
  if ((video.sourceGroups || []).includes("vsinger-moment") || video.sourceQuality?.sourceSystem === "vsinger_moment_http") {
    return "vsinger_moment_http";
  }
  return "base";
}

function songIdentity(title, artist) {
  return `${titleIdentity(title)}\u0001${RankingUtils.normalizeArtistKey(normalizedArtist(artist))}`;
}

function titleIdentity(title) {
  return RankingUtils.songWorkTitleKey(cleanText(title)) || RankingUtils.normalizeSongTitleKey(cleanText(title));
}

function titleVariantKey(title) {
  return cleanText(title)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦♪♫♬♩]/gu, "");
}

function normalizedArtist(value) {
  const artist = RankingUtils.canonicalizeArtistName(cleanText(value));
  return isUnknownArtist(artist) ? UNKNOWN_ARTIST : artist;
}

function channelIdentity(video) {
  const handle = normalizeHandle(video.channelHandle || video.channelUrl || video.sourceUrl);
  return cleanText(video.channelId) || handle || cleanText(video.channelName) || cleanText(video.videoId);
}

function normalizeHandle(value) {
  const match = cleanText(value).match(/(?:youtube\.com\/)?(@[^/?#\s]+)/iu);
  return match ? match[1].toLocaleLowerCase() : (cleanText(value).startsWith("@") ? cleanText(value).toLocaleLowerCase() : "");
}

function compareChannelAuditRows(left, right) {
  return right.unknownArtistOccurrences - left.unknownArtistOccurrences
    || right.singletonSongs - left.singletonSongs
    || right.occurrences - left.occurrences
    || cleanText(left.name).localeCompare(cleanText(right.name));
}

function sortedCountEntries(map) {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || cleanText(left.name).localeCompare(cleanText(right.name)));
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function uniqueTextValues(values) {
  return Array.from(new Set((values || []).map(cleanText).filter(Boolean)));
}

function pushSample(target, value, limit) {
  if (target.length < limit) target.push(value);
}

function recordIncludesBatchTag(record, batchTag) {
  const haystack = `${record.reason || ""} ${record.note || ""}`;
  return Boolean(batchTag && haystack.includes(batchTag));
}

function fileDigest(filePath) {
  const buffer = fs.readFileSync(filePath);
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function escapeMarkdown(value) {
  return cleanText(value).replace(/\|/gu, "\\|");
}

function logPhase(phase, fields = {}) {
  const suffix = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
  console.log(`CODEX_GLOBAL_SONG_AUDIT_PHASE phase=${phase}${suffix ? ` ${suffix}` : ""}`);
}

module.exports = {
  addVideoToAccumulator,
  aggregateMatchedChannels,
  classifyTitlePattern,
  computeInventoryKey,
  createAccumulator,
  enrichVideoSelectors,
  finalizeAccumulator,
  normalizeHandle,
  recordIncludesBatchTag,
  selectorMatchesSong,
  songIdentity,
};
