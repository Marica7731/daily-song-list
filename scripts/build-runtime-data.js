const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BLOCKLIST_HASH, BLOCKLIST_VERSION } = require("../assets/source-filter");

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
  const baseRangePayloads = Object.fromEntries(RANGES.map((rangeId) => [rangeId, buildRuntimeRangePayload(payload, rangeId)]));
  const dataVersion = computeRuntimeDataVersion(payload, baseRangePayloads);
  const rangePayloads = Object.fromEntries(
    RANGES.map((rangeId) => [rangeId, { ...baseRangePayloads[rangeId], dataVersion }]),
  );
  const rangeFiles = {};
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
  }
  cleanupOldRuntimeRangeFiles(rangeFiles);

  for (const rangeId of RANGES) {
    const diffPath = diffPathForRange(rangeId);
    if (!fs.existsSync(diffPath)) continue;
    writeRuntimeJson(diffPath, compactRankDiff(readJson(diffPath)));
  }

  writeRuntimeJson(META_PATH, buildRuntimeMeta(payload, rangePayloads, { dataVersion, rangeFiles }));
  console.log(
    `[runtime-data] wrote ${path.relative(ROOT, META_PATH)} ${RANGES.map((rangeId) => rangeFiles[rangeId].path).join(" ")}`,
  );
}

function buildRuntimeMeta(payload, rangePayloads, options = {}) {
  const dataVersion = options.dataVersion || commonRangeDataVersion(rangePayloads) || computeRuntimeDataVersion(payload, rangePayloads);
  const rangeFiles = options.rangeFiles || {};
  const itemCounts = Object.fromEntries(RANGES.map((rangeId) => [rangeId, rangePayloads[rangeId]?.items?.length || 0]));
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
    filterVersion: CURRENT_FILTER_VERSION,
    nicheAnnotated: RANGES.every((rangeId) => rangePayloads[rangeId]?.nicheAnnotated === true),
    ranges: Object.fromEntries(
      RANGES.map((rangeId) => [
        rangeId,
        {
          path: rangeFiles[rangeId]?.path || `data/ui/${rangeId}.json`,
          legacyPath: rangeFiles[rangeId]?.legacyPath || `data/ui/${rangeId}.json`,
          sha256: rangeFiles[rangeId]?.sha256 || sha256Text(stringifyRuntimeJson(rangePayloads[rangeId] || {})),
          bytes: rangeFiles[rangeId]?.bytes || Buffer.byteLength(stringifyRuntimeJson(rangePayloads[rangeId] || {}), "utf8"),
          generatedAt: rangeFiles[rangeId]?.generatedAt || rangePayloads[rangeId]?.generatedAt || "",
          dataVersion,
          itemCount: itemCounts[rangeId],
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
  const group = payload.groups?.[rangeId] || { id: rangeId, title: rangeId, items: [] };
  const clientGroup = buildClientGroup(group);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    id: rangeId,
    title: clientGroup.title,
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

module.exports = {
  buildClientGroup,
  buildClientSong,
  buildClientVideo,
  buildRuntimeMeta,
  buildRuntimeRangePayload,
  compactRankDiff,
  compactRankDiffEntries,
  computeRuntimeDataVersion,
  CURRENT_FILTER_VERSION,
  sha256Text,
  writeRuntimeJson,
};
