const fs = require("node:fs");
const path = require("node:path");
const {
  VIDEO_CATALOG_PATH,
  catalogToVideos,
  loadVideoCatalog,
  rebuildVideoCatalogFromVideos,
  writeCatalogSegments,
} = require("./video-catalog");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SNAPSHOT_INDEX_PATH = path.join(SNAPSHOT_DIR, "index.json");

if (require.main === module) {
  try {
    const result = migratePermanentData({ dryRun: process.argv.includes("--dry-run") });
    console.log(
      `MIGRATE_PERMANENT_DATA_OK dryRun=${result.dryRun ? "1" : "0"} catalogVideos=${result.catalogVideoCount} catalogSegments=${result.catalogSegmentCount} snapshots=${result.snapshotCount}`,
    );
  } catch (error) {
    console.error(`[migrate-permanent-data] ${error.stack || error.message}`);
    process.exit(1);
  }
}

function migratePermanentData(options = {}) {
  const now = asDate(options.now || new Date());
  const previousCatalog = loadVideoCatalog(options.catalogPath || VIDEO_CATALOG_PATH);
  const payloads = collectPayloads(options);
  const videos = [
    ...catalogToVideos(previousCatalog),
    ...payloads.flatMap((payload) => collectPayloadVideos(payload)),
  ];
  const rebuild = rebuildVideoCatalogFromVideos(videos, now, { previousCatalog });
  const catalogSegmentManifest = buildCatalogSegmentPreview(rebuild.catalog);
  const snapshotIndex = rebuildPermanentSnapshotIndex(options);
  const snapshotShards = buildSnapshotIndexShards(snapshotIndex.snapshots);
  if (!options.dryRun) {
    writeJson(options.catalogPath || VIDEO_CATALOG_PATH, rebuild.catalog);
    writeCatalogSegments(rebuild.catalog);
    writeSnapshotIndexShards(snapshotShards, options);
    writeJson(options.snapshotIndexPath || SNAPSHOT_INDEX_PATH, {
      ...snapshotIndex,
      snapshotCount: snapshotIndex.snapshots.length,
      shards: snapshotShards.map(({ payload, ...entry }) => entry),
    });
  }
  return {
    dryRun: Boolean(options.dryRun),
    catalogVideoCount: rebuild.catalog.videos.length,
    catalogSegmentCount: catalogSegmentManifest.segmentCount,
    snapshotCount: snapshotIndex.snapshots.length,
    snapshotShardCount: snapshotShards.length,
  };
}

function buildCatalogSegmentPreview(catalog) {
  const videos = Array.isArray(catalog?.videos) ? catalog.videos : [];
  const segmentSize = 500;
  return {
    segmentSize,
    segmentCount: Math.max(1, Math.ceil(videos.length / segmentSize)),
    itemCount: videos.length,
  };
}

function collectPayloads(options = {}) {
  const payloads = [];
  const latestPath = options.latestPath || LATEST_PATH;
  if (fs.existsSync(latestPath)) payloads.push(readJson(latestPath));
  for (const entry of collectSnapshotEntries(options)) {
    const payload = readJson(path.join(ROOT, entry.path));
    if (payload?.groups) payloads.push(payload);
  }
  return payloads;
}

function collectSnapshotEntries(options = {}) {
  const snapshotDir = options.snapshotDir || SNAPSHOT_DIR;
  if (!fs.existsSync(snapshotDir)) return [];
  return fs
    .readdirSync(snapshotDir)
    .filter((name) => /^[0-9]{8}T[0-9]{4}00Z\.json$/u.test(name))
    .map((name) => {
      const snapshotPath = path.join(snapshotDir, name);
      const payload = readJson(snapshotPath);
      const capturedAt = payload.capturedAt || payload.generatedAt || snapshotIdToIso(name.replace(/\.json$/u, ""));
      return {
        id: name.replace(/\.json$/u, ""),
        file: name,
        path: `data/snapshots/${name}`,
        generatedAt: payload.generatedAt || capturedAt,
        capturedAt,
        curationVersion: payload.curationVersion || "",
        curationHash: payload.curationHash || "",
        label: formatSnapshotLabel(capturedAt),
        itemCounts: snapshotItemCounts(payload),
      };
    })
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
}

function rebuildPermanentSnapshotIndex(options = {}) {
  const snapshots = collectSnapshotEntries(options);
  return {
    schemaVersion: 1,
    generatedAt: asDate(options.now || new Date()).toISOString(),
    retentionPolicy: "permanent",
    retentionDays: null,
    cadence: "hourly",
    latestSnapshotId: snapshots[0]?.id || "",
    snapshotCount: snapshots.length,
    shards: buildSnapshotIndexShards(snapshots).map(({ payload, ...entry }) => entry),
    snapshots,
  };
}

function buildSnapshotIndexShards(snapshots) {
  const byMonth = new Map();
  for (const entry of snapshots || []) {
    const match = String(entry?.id || "").match(/^([0-9]{4})([0-9]{2})/u);
    const key = match ? `${match[1]}-${match[2]}` : "unknown";
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(entry);
  }
  return [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, entries]) => {
      const [year, month] = key.split("-");
      const fileName = key === "unknown" ? "unknown.json" : path.join(year, `${month}.json`);
      const relativePath = `data/snapshots/index/${fileName.replace(/\\/g, "/")}`;
      return {
        id: key,
        path: relativePath,
        snapshotCount: entries.length,
        latestSnapshotId: entries[0]?.id || "",
        payload: {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          retentionPolicy: "permanent",
          shard: key,
          snapshotCount: entries.length,
          snapshots: entries,
        },
      };
    });
}

function writeSnapshotIndexShards(shards, options = {}) {
  const snapshotDir = options.snapshotDir || SNAPSHOT_DIR;
  for (const shard of shards || []) {
    writeJson(path.join(ROOT, shard.path), shard.payload);
  }
}

function collectPayloadVideos(payload) {
  const groups = payload?.groups || {};
  const byVideoId = new Map();
  for (const groupId of ["72h", "7d", "1m", "all"]) {
    for (const item of groups[groupId]?.items || []) {
      if (!item?.videoId || byVideoId.has(item.videoId)) continue;
      byVideoId.set(item.videoId, item);
    }
  }
  return [...byVideoId.values()];
}

function snapshotItemCounts(payload) {
  const h72 = payload?.groups?.["72h"]?.items?.length ?? payload?.groups?.["7d"]?.items?.length ?? 0;
  const all = payload?.groups?.["1m"]?.items?.length ?? payload?.groups?.all?.items?.length ?? 0;
  return {
    "72h": h72,
    "7d": h72,
    "1m": all,
    all,
  };
}

function snapshotIdToIso(id) {
  const match = String(id || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})00Z$/u);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`;
}

function formatSnapshotLabel(value) {
  const date = asDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(5, 16).replace("T", " ") : "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

module.exports = {
  collectPayloadVideos,
  buildSnapshotIndexShards,
  rebuildPermanentSnapshotIndex,
  snapshotItemCounts,
};
