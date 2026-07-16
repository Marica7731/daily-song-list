const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const LEGACY_FILE_BUDGETS = [
  { path: "data/ui/1m.json", gzipBudget: 800 * 1024 },
  { path: "data/diff/latest-72h.json", gzipBudget: 120 * 1024 },
  { path: "data/diff/latest-1m.json", gzipBudget: 120 * 1024 },
];
const BASE_FIRST_SCREEN_ASSETS = [
  { path: "index.html", gzipBudget: 24 * 1024 },
  { path: "assets/styles.css", gzipBudget: 36 * 1024 },
  { path: "assets/blocked-vtuber-meta.js", gzipBudget: 2 * 1024 },
  { path: "assets/frontend-utils.js", gzipBudget: 40 * 1024 },
  { path: "assets/ranking-utils.js", gzipBudget: 28 * 1024 },
  { path: "assets/app.js", gzipBudget: 110 * 1024 },
  { path: "data/ui/meta.json", gzipBudget: 16 * 1024 },
];
const LEGACY_FIRST_SCREEN_RUNTIME_ASSETS = [
  { path: "data/ui/72h.json", gzipBudget: 800 * 1024 },
];
const FALLBACK_FILTER_ASSETS = [
  { path: "assets/blocked-vtuber-channels.js", gzipBudget: 70 * 1024 },
  { path: "assets/source-filter.js", gzipBudget: 18 * 1024 },
];
const FIRST_SCREEN_GZIP_BUDGET = 980 * 1024;
const FALLBACK_FILTER_GZIP_BUDGET = 88 * 1024;
const SHARD_MANIFEST_GZIP_BUDGET = 96 * 1024;
const RUNTIME_PAGE_GZIP_BUDGET = 260 * 1024;
const SOURCE_DETAIL_PAGE_GZIP_BUDGET = 220 * 1024;
const SEARCH_PAGE_GZIP_BUDGET = 220 * 1024;

const meta = readJsonIfExists("data/ui/meta.json");
const shardBudgetEntries = runtimeShardBudgetEntries(meta);
const rows = [...legacyOrShardFileBudgets(meta), ...shardBudgetEntries].map((entry) => measureFile(entry.path, entry.gzipBudget));
const firstScreenRows = firstScreenBudgetEntries(meta).map((entry) => measureFile(entry.path, entry.gzipBudget));
const fallbackRows = FALLBACK_FILTER_ASSETS.map((entry) => measureFile(entry.path, entry.gzipBudget));
const firstScreenGzipTotal = firstScreenRows.reduce((sum, row) => sum + row.gzipBytes, 0);
const fallbackGzipTotal = fallbackRows.reduce((sum, row) => sum + row.gzipBytes, 0);
let failed = false;

for (const row of [...rows, ...firstScreenRows, ...fallbackRows]) {
  console.log(`[budget] ${row.path} raw=${row.rawBytes} gzip=${row.gzipBytes} budget=${row.gzipBudget}`);
  if (row.gzipBytes > row.gzipBudget) {
    console.error(`[budget] ${row.path} exceeds gzip budget by ${row.gzipBytes - row.gzipBudget} bytes`);
    failed = true;
  }
}

console.log(`[budget] first-screen gzip=${firstScreenGzipTotal} budget=${FIRST_SCREEN_GZIP_BUDGET}`);
if (firstScreenGzipTotal > FIRST_SCREEN_GZIP_BUDGET) {
  console.error(`[budget] first-screen exceeds gzip budget by ${firstScreenGzipTotal - FIRST_SCREEN_GZIP_BUDGET} bytes`);
  failed = true;
}
console.log(`[budget] fallback-filter gzip=${fallbackGzipTotal} budget=${FALLBACK_FILTER_GZIP_BUDGET}`);
if (fallbackGzipTotal > FALLBACK_FILTER_GZIP_BUDGET) {
  console.error(`[budget] fallback-filter exceeds gzip budget by ${fallbackGzipTotal - FALLBACK_FILTER_GZIP_BUDGET} bytes`);
  failed = true;
}

if (failed) process.exit(1);

function measureFile(relativePath, gzipBudget = 0) {
  const absolutePath = path.join(ROOT, relativePath);
  const buffer = fs.readFileSync(absolutePath);
  return {
    path: relativePath,
    rawBytes: buffer.length,
    gzipBytes: zlib.gzipSync(buffer).length,
    gzipBudget,
  };
}

function legacyOrShardFileBudgets(meta) {
  if (hasRuntimeShards(meta)) {
    return [
      { path: "data/diff/latest-72h.json", gzipBudget: 120 * 1024 },
      { path: "data/diff/latest-1m.json", gzipBudget: 120 * 1024 },
      ...(fs.existsSync(path.join(ROOT, "data/diff/latest-7d.json")) ? [{ path: "data/diff/latest-7d.json", gzipBudget: 120 * 1024 }] : []),
      ...(fs.existsSync(path.join(ROOT, "data/diff/latest-all.json")) ? [{ path: "data/diff/latest-all.json", gzipBudget: 120 * 1024 }] : []),
    ];
  }
  return LEGACY_FILE_BUDGETS;
}

function firstScreenBudgetEntries(meta) {
  if (!hasRuntimeShards(meta)) return [...BASE_FIRST_SCREEN_ASSETS, ...LEGACY_FIRST_SCREEN_RUNTIME_ASSETS];
  const rangeId = meta.ranges?.["7d"] ? "7d" : "72h";
  const firstPage = runtimeShardsForRange(meta, rangeId)?.runtime?.pages?.[0]?.path;
  return firstPage
    ? [...BASE_FIRST_SCREEN_ASSETS, { path: firstPage, gzipBudget: RUNTIME_PAGE_GZIP_BUDGET }]
    : [...BASE_FIRST_SCREEN_ASSETS, ...LEGACY_FIRST_SCREEN_RUNTIME_ASSETS];
}

function runtimeShardBudgetEntries(meta) {
  if (!hasRuntimeShards(meta)) return [];
  const entries = [];
  for (const [rangeId, rangeMeta] of Object.entries(meta.ranges || {})) {
    const shards = rangeMeta?.shards;
    if (!shards) continue;
    appendShardBudgetEntries(entries, rangeId, "runtime", shards.runtime, RUNTIME_PAGE_GZIP_BUDGET);
    appendShardBudgetEntries(entries, rangeId, "sourceDetails", shards.sourceDetails, SOURCE_DETAIL_PAGE_GZIP_BUDGET);
    appendShardBudgetEntries(entries, rangeId, "search", shards.search, SEARCH_PAGE_GZIP_BUDGET);
  }
  return entries;
}

function appendShardBudgetEntries(entries, rangeId, shardName, shard, pageBudget) {
  if (!shard) return;
  if (shard.manifestPath) {
    entries.push({ path: shard.manifestPath, gzipBudget: SHARD_MANIFEST_GZIP_BUDGET, label: `${rangeId}.${shardName}.manifest` });
  }
  for (const page of shard.pages || []) {
    if (page.path) entries.push({ path: page.path, gzipBudget: pageBudget, label: `${rangeId}.${shardName}.page` });
  }
}

function hasRuntimeShards(meta) {
  return Object.values(meta?.ranges || {}).some((rangeMeta) => Boolean(rangeMeta?.shards));
}

function runtimeShardsForRange(meta, rangeId) {
  return meta?.ranges?.[rangeId]?.shards || meta?.shards?.ranges?.[rangeId] || null;
}

function readJsonIfExists(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch {
    return null;
  }
}
