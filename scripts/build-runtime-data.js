const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UI_DIR = path.join(DATA_DIR, "ui");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const META_PATH = path.join(UI_DIR, "meta.json");
const RANGES = ["72h", "1m"];
const CURRENT_FILTER_VERSION = 3;
const RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_RANK_DIFF_LIMIT = 200;

if (require.main === module) {
  main();
}

function main() {
  const payload = readJson(LATEST_PATH);
  const rangePayloads = Object.fromEntries(RANGES.map((rangeId) => [rangeId, buildRuntimeRangePayload(payload, rangeId)]));
  for (const [rangeId, rangePayload] of Object.entries(rangePayloads)) {
    writeRuntimeJson(path.join(UI_DIR, `${rangeId}.json`), rangePayload);
  }

  for (const rangeId of RANGES) {
    const diffPath = diffPathForRange(rangeId);
    if (!fs.existsSync(diffPath)) continue;
    writeRuntimeJson(diffPath, compactRankDiff(readJson(diffPath)));
  }

  writeRuntimeJson(META_PATH, buildRuntimeMeta(payload, rangePayloads));
  console.log(
    `[runtime-data] wrote ${path.relative(ROOT, META_PATH)} ${RANGES.map((rangeId) => `data/ui/${rangeId}.json`).join(" ")}`,
  );
}

function buildRuntimeMeta(payload, rangePayloads) {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    generatedAt: payload.generatedAt || "",
    capturedAt: payload.capturedAt || payload.generatedAt || "",
    status: payload.status || null,
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: RANGES.every((rangeId) => rangePayloads[rangeId]?.nicheAnnotated === true),
    ranges: Object.fromEntries(
      RANGES.map((rangeId) => [
        rangeId,
        {
          path: `data/ui/${rangeId}.json`,
          itemCount: rangePayloads[rangeId]?.items?.length || 0,
        },
      ]),
    ),
    diffs: Object.fromEntries(
      RANGES.map((rangeId) => [
        rangeId,
        {
          path: `data/diff/latest-${rangeId}.json`,
        },
      ]),
    ),
  };
}

function buildRuntimeRangePayload(payload, rangeId) {
  const group = payload.groups?.[rangeId] || { id: rangeId, title: rangeId, items: [] };
  const clientGroup = buildClientGroup(group);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: rangeId,
    title: clientGroup.title,
    generatedAt: clientGroup.generatedAt || payload.generatedAt || "",
    capturedAt: payload.capturedAt || payload.generatedAt || "",
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: groupHasNicheAnnotations(clientGroup),
    items: clientGroup.items,
  };
}

function buildClientGroup(group) {
  return {
    id: group.id || "",
    title: group.title || group.id || "",
    generatedAt: group.generatedAt || "",
    updatedAt: group.updatedAt || "",
    items: (group.items || []).map(buildClientVideo),
  };
}

function buildClientVideo(item) {
  const result = {
    videoId: item.videoId || "",
    title: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl || "",
    keyword: item.keyword || "",
    publishedText: item.publishedText || "",
    thumbnailUrl: runtimeThumbnailUrl(item),
    songs: (item.songs || []).map(buildClientSong),
  };
  if (!result.channelUrl) delete result.channelUrl;
  return result;
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeRuntimeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

module.exports = {
  buildClientGroup,
  buildClientSong,
  buildClientVideo,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  compactRankDiff,
  compactRankDiffEntries,
  CURRENT_FILTER_VERSION,
  writeRuntimeJson,
};
