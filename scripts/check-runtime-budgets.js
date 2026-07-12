const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const FILE_BUDGETS = [
  { path: "data/ui/72h.json", gzipBudget: 800 * 1024 },
  { path: "data/ui/1m.json", gzipBudget: 800 * 1024 },
  { path: "data/diff/latest-72h.json", gzipBudget: 120 * 1024 },
  { path: "data/diff/latest-1m.json", gzipBudget: 120 * 1024 },
];
const FIRST_SCREEN_JS = ["assets/frontend-utils.js", "assets/ranking-utils.js", "assets/app.js"];
const FIRST_SCREEN_JS_GZIP_BUDGET = 180 * 1024;

const rows = FILE_BUDGETS.map((entry) => measureFile(entry.path, entry.gzipBudget));
const jsRows = FIRST_SCREEN_JS.map((filePath) => measureFile(filePath));
const jsGzipTotal = jsRows.reduce((sum, row) => sum + row.gzipBytes, 0);
let failed = false;

for (const row of rows) {
  console.log(`[budget] ${row.path} raw=${row.rawBytes} gzip=${row.gzipBytes} budget=${row.gzipBudget}`);
  if (row.gzipBytes > row.gzipBudget) {
    console.error(`[budget] ${row.path} exceeds gzip budget by ${row.gzipBytes - row.gzipBudget} bytes`);
    failed = true;
  }
}

for (const row of jsRows) {
  console.log(`[budget] ${row.path} raw=${row.rawBytes} gzip=${row.gzipBytes}`);
}
console.log(`[budget] first-screen-js gzip=${jsGzipTotal} budget=${FIRST_SCREEN_JS_GZIP_BUDGET}`);
if (jsGzipTotal > FIRST_SCREEN_JS_GZIP_BUDGET) {
  console.error(`[budget] first-screen-js exceeds gzip budget by ${jsGzipTotal - FIRST_SCREEN_JS_GZIP_BUDGET} bytes`);
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
