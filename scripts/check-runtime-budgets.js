const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const FILE_BUDGETS = [
  { path: "data/ui/1m.json", gzipBudget: 800 * 1024 },
  { path: "data/diff/latest-72h.json", gzipBudget: 120 * 1024 },
  { path: "data/diff/latest-1m.json", gzipBudget: 120 * 1024 },
];
const FIRST_SCREEN_ASSETS = [
  { path: "index.html", gzipBudget: 24 * 1024 },
  { path: "assets/styles.css", gzipBudget: 36 * 1024 },
  { path: "assets/blocked-vtuber-meta.js", gzipBudget: 2 * 1024 },
  { path: "assets/frontend-utils.js", gzipBudget: 40 * 1024 },
  { path: "assets/ranking-utils.js", gzipBudget: 28 * 1024 },
  { path: "assets/app.js", gzipBudget: 110 * 1024 },
  { path: "data/ui/meta.json", gzipBudget: 16 * 1024 },
  { path: "data/ui/72h.json", gzipBudget: 800 * 1024 },
];
const FALLBACK_FILTER_ASSETS = [
  { path: "assets/blocked-vtuber-channels.js", gzipBudget: 70 * 1024 },
  { path: "assets/source-filter.js", gzipBudget: 18 * 1024 },
];
const FIRST_SCREEN_GZIP_BUDGET = 980 * 1024;
const FALLBACK_FILTER_GZIP_BUDGET = 88 * 1024;

const rows = FILE_BUDGETS.map((entry) => measureFile(entry.path, entry.gzipBudget));
const firstScreenRows = FIRST_SCREEN_ASSETS.map((entry) => measureFile(entry.path, entry.gzipBudget));
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
