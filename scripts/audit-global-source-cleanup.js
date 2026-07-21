#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { isUnknownArtist } = require("./curation");
const { extractReliableRawArtistCredit } = require("./artist-backfill");
const { loadYoutubeChannelDiscoveryRuntimeVideos } = require("./youtube-channel-discovery-runtime");
const { buildSongRecords, normalizeArtistKey, normalizeSongTitleKey } = require("../assets/ranking-utils");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DISCOVERY_DIR = path.join(ROOT, "data", "external", "youtube-channel-discovery");
const DEFAULT_LATEST_PATH = path.join(ROOT, "data", "latest.json");
const DEFAULT_QUERIES = ["Calc", "晴る", "晴るる", "晩餐歌", "花になって", "群像夏", "私になれ", "pannomimimi"];
const TARGET_CHANNELS = [
  { key: "naraetan", labels: ["@naraetanV", "naraetan", "なれたん"] },
  { key: "kanaruhanon", labels: ["@kanaruhanon", "kanaruhanon"] },
  { key: "aruma", labels: ["@ArumaCh", "Aruma Ch.", "薬袋アルマ", "藥袋アルマ"] },
  { key: "isakiRiona", labels: ["@IsakiRiona", "Isaki Riona"] },
];
const PROBES = [
  { key: "isakiRiona_chat", videoId: "ZEAgcWCnkwQ", seconds: 3362 },
  { key: "taiwan_vtuber_dirty", videoId: "okW2MlmPGe8", seconds: 6697 },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discoveryDir = path.resolve(args["discovery-dir"] || DEFAULT_DISCOVERY_DIR);
  const latestPath = path.resolve(args["latest"] || DEFAULT_LATEST_PATH);
  const queries = listArg(args.query) || DEFAULT_QUERIES;
  const rawImport = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir: discoveryDir, required: args.required === true, cleanup: false });
  const cleanedImport = loadYoutubeChannelDiscoveryRuntimeVideos({ importDir: discoveryDir, required: args.required === true });
  const latest = readJsonIfExists(latestPath);
  const latestVideos = latest ? collectPayloadVideos(latest) : [];

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputs: {
      discoveryDir: projectRelativePath(discoveryDir),
      latestPath: fs.existsSync(latestPath) ? projectRelativePath(latestPath) : "",
      onlineBase: args["online-base"] || "",
    },
    youtubeChannelDiscovery: compareVideoSets(rawImport?.videos || [], cleanedImport?.videos || [], queries),
    latest: summarizeLatest(latestVideos, queries),
    probes: {
      youtubeChannelDiscovery: probeVideoSets(rawImport?.videos || [], cleanedImport?.videos || []),
      latest: probeLatestVideos(latestVideos),
    },
    summaries: {
      rawYoutubeChannelDiscovery: rawImport?.summary || null,
      cleanedYoutubeChannelDiscovery: cleanedImport?.summary || null,
    },
  };

  if (args["online-base"]) {
    result.online = await auditOnline(args["online-base"], queries);
    console.log(`CODEX_ONLINE_AUDIT_OK base=${args["online-base"]} queries=${queries.length}`);
  }

  const text = JSON.stringify(result, null, 2);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${text}\n`, "utf8");
  }
  console.log(text);
  console.log(
    [
      "CODEX_GLOBAL_CLEANUP_AUDIT_OK",
      `rawVideos=${result.youtubeChannelDiscovery.before.videoCount}`,
      `rawOccurrences=${result.youtubeChannelDiscovery.before.occurrenceCount}`,
      `cleanVideos=${result.youtubeChannelDiscovery.after.videoCount}`,
      `cleanOccurrences=${result.youtubeChannelDiscovery.after.occurrenceCount}`,
      `artistBackfilled=${result.summaries.cleanedYoutubeChannelDiscovery?.cleanup?.artistBackfill?.filledCount || 0}`,
    ].join(" "),
  );
}

function compareVideoSets(beforeVideos, afterVideos, queries) {
  return {
    before: summarizeVideos(beforeVideos),
    after: summarizeVideos(afterVideos),
    delta: {
      videoCount: afterVideos.length - beforeVideos.length,
      occurrenceCount: countSongs(afterVideos) - countSongs(beforeVideos),
      placeholderArtistCount: countPlaceholderArtists(afterVideos) - countPlaceholderArtists(beforeVideos),
    },
    channels: Object.fromEntries(TARGET_CHANNELS.map((target) => [target.key, compareChannel(beforeVideos, afterVideos, target)])),
    queries: Object.fromEntries(queries.map((query) => [query, compareQuery(beforeVideos, afterVideos, query)])),
  };
}

function summarizeLatest(videos, queries) {
  return {
    summary: summarizeVideos(videos),
    channels: Object.fromEntries(TARGET_CHANNELS.map((target) => [target.key, summarizeVideos(filterByChannel(videos, target))])),
    queries: Object.fromEntries(queries.map((query) => [query, summarizeQuery(videos, query)])),
  };
}

function compareChannel(beforeVideos, afterVideos, target) {
  return {
    before: summarizeVideos(filterByChannel(beforeVideos, target)),
    after: summarizeVideos(filterByChannel(afterVideos, target)),
  };
}

function compareQuery(beforeVideos, afterVideos, query) {
  return {
    before: summarizeQuery(beforeVideos, query),
    after: summarizeQuery(afterVideos, query),
  };
}

function summarizeVideos(videos) {
  const songs = flattenSongs(videos);
  const uniqueSongKeys = new Set();
  const uniqueTitleKeys = new Set();
  let placeholderArtistCount = 0;
  let rawCreditBackfillableCount = 0;
  for (const { song } of songs) {
    const titleKey = normalizeSongTitleKey(song.title);
    const artistKey = isUnknownArtist(song.artist) ? "unknown" : normalizeArtistKey(song.artist);
    if (titleKey) uniqueTitleKeys.add(titleKey);
    if (titleKey || artistKey) uniqueSongKeys.add(`${titleKey}::${artistKey}`);
    if (isUnknownArtist(song.artist)) {
      placeholderArtistCount += 1;
      if (extractReliableRawArtistCredit(song).artist) rawCreditBackfillableCount += 1;
    }
  }
  return {
    videoCount: videos.length,
    occurrenceCount: songs.length,
    rankSongRecordCount: buildSongRecords(songs).length,
    uniqueTitleCount: uniqueTitleKeys.size,
    uniqueSongIdentityCount: uniqueSongKeys.size,
    placeholderArtistCount,
    rawCreditBackfillableCount,
    topUnknownTitles: topUnknownTitles(songs),
  };
}

function summarizeQuery(videos, query) {
  const normalized = normalizeNeedle(query);
  const matches = flattenSongs(videos).filter(({ item, song }) => {
    const haystack = normalizeNeedle([song.title, song.artist, song.raw, item.channelName, item.channelHandle].filter(Boolean).join(" "));
    return haystack.includes(normalized);
  });
  const titleArtist = new Set();
  const artists = new Map();
  const titles = new Map();
  for (const { song } of matches) {
    const title = cleanText(song.title);
    const artist = isUnknownArtist(song.artist) ? "未記載" : cleanText(song.artist);
    titleArtist.add(`${title}\u0001${artist}`);
    increment(titles, title);
    increment(artists, artist);
  }
  return {
    occurrenceCount: matches.length,
    placeholderArtistCount: matches.filter(({ song }) => isUnknownArtist(song.artist)).length,
    variantCount: titleArtist.size,
    topTitles: topEntries(titles, 8),
    topArtists: topEntries(artists, 8),
    samples: matches.slice(0, 5).map(({ item, song }) => sampleOccurrence(item, song)),
  };
}

function probeVideoSets(beforeVideos, afterVideos) {
  return Object.fromEntries(
    PROBES.map((probe) => [
      probe.key,
      {
        before: findProbeOccurrences(beforeVideos, probe),
        after: findProbeOccurrences(afterVideos, probe),
      },
    ]),
  );
}

function probeLatestVideos(videos) {
  return Object.fromEntries(PROBES.map((probe) => [probe.key, findProbeOccurrences(videos, probe)]));
}

function findProbeOccurrences(videos, probe) {
  return flattenSongs(videos)
    .filter(({ item, song }) => item.videoId === probe.videoId && Math.abs((Number(song.seconds) || 0) - probe.seconds) <= 3)
    .map(({ item, song }) => sampleOccurrence(item, song));
}

async function auditOnline(base, queries) {
  const baseUrl = base.replace(/\/+$/u, "");
  const health = await fetchJson(`${baseUrl}/healthz`);
  const queryResults = {};
  for (const query of queries) {
    queryResults[query] = {
      songs: await fetchJson(`${baseUrl}/api/rankings?range=all&view=songs&pageSize=100&q=${encodeURIComponent(query)}`),
      vtubers: await fetchJson(`${baseUrl}/api/rankings?range=all&view=vtubers&pageSize=100&q=${encodeURIComponent(query)}`),
    };
  }
  return {
    queriedAt: new Date().toISOString(),
    baseUrl,
    health: compactOnlineHealth(health),
    queries: Object.fromEntries(
      Object.entries(queryResults).map(([query, payload]) => [
        query,
        {
          songs: compactOnlineRanking(payload.songs),
          vtubers: compactOnlineRanking(payload.vtubers),
        },
      ]),
    ),
  };
}

function compactOnlineHealth(payload) {
  return {
    status: payload?.status || "",
    schemaVersion: payload?.schemaVersion || 0,
    builtAt: payload?.builtAt || "",
    latestGeneratedAt: payload?.latestGeneratedAt || "",
    counts: payload?.counts || {},
  };
}

function compactOnlineRanking(payload) {
  return {
    totalCount: payload?.totalCount || 0,
    totalOccurrenceCount: payload?.totalOccurrenceCount || 0,
    totalVideoCount: payload?.totalVideoCount || 0,
    records: (payload?.records || []).slice(0, 10).map((record) => ({
      title: record.title || "",
      artist: record.displayArtist || record.artist || "",
      name: record.name || record.channelName || "",
      count: record.count || 0,
      videoCount: record.videoCount || 0,
    })),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function flattenSongs(videos) {
  const rows = [];
  for (const item of videos || []) {
    for (const song of item.songs || []) rows.push({ item, song });
  }
  return rows;
}

function filterByChannel(videos, target) {
  return (videos || []).filter((video) => {
    const haystack = normalizeNeedle([video.channelName, video.channelHandle, video.channelUrl, video.title].filter(Boolean).join(" "));
    return target.labels.some((label) => haystack.includes(normalizeNeedle(label)));
  });
}

function topUnknownTitles(rows) {
  const counts = new Map();
  for (const { song } of rows || []) {
    if (isUnknownArtist(song.artist)) increment(counts, cleanText(song.title));
  }
  return topEntries(counts, 10);
}

function topEntries(map, limit) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function sampleOccurrence(item, song) {
  return {
    videoId: item.videoId || "",
    seconds: Number(song.seconds) || 0,
    title: cleanText(song.title),
    artist: cleanText(song.artist),
    channelName: cleanText(item.channelName),
    channelHandle: cleanText(item.channelHandle),
    raw: cleanText(song.raw).slice(0, 160),
  };
}

function collectPayloadVideos(payload) {
  const byVideoId = new Map();
  for (const group of Object.values(payload?.groups || {})) {
    for (const item of group.items || []) {
      if (!item.videoId) continue;
      const existing = byVideoId.get(item.videoId);
      if (!existing || (item.songs?.length || 0) > (existing.songs?.length || 0)) byVideoId.set(item.videoId, item);
    }
  }
  return [...byVideoId.values()];
}

function countSongs(videos) {
  return (videos || []).reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0);
}

function countPlaceholderArtists(videos) {
  return flattenSongs(videos).filter(({ song }) => isUnknownArtist(song.artist)).length;
}

function normalizeNeedle(value) {
  return cleanText(value).normalize("NFKC").toLocaleLowerCase();
}

function increment(map, value) {
  const key = cleanText(value);
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function listArg(value) {
  if (!value) return null;
  const values = Array.isArray(value) ? value : [value];
  const result = values.flatMap((item) => String(item).split(",")).map(cleanText).filter(Boolean);
  return result.length ? result : null;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--required") {
      args.required = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`Unknown argument: ${item}`);
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${item} requires a value`);
    index += 1;
    if (key === "query") {
      if (!args.query) args.query = [];
      args.query.push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function projectRelativePath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/") || ".";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_GLOBAL_CLEANUP_AUDIT_ERROR ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  compareVideoSets,
  summarizeQuery,
  summarizeVideos,
};
