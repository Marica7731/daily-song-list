const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const VERSIONED_ASSETS = [
  "assets/styles.css",
  "assets/source-filter.js",
  "assets/frontend-utils.js",
  "assets/ranking-utils.js",
  "assets/app.js",
];

const hash = crypto.createHash("sha256");
for (const assetPath of VERSIONED_ASSETS) {
  hash.update(assetPath);
  hash.update(fs.readFileSync(path.join(ROOT, assetPath)));
}
const version = `h${hash.digest("hex").slice(0, 12)}`;
let html = fs.readFileSync(INDEX_PATH, "utf8");
for (const assetPath of VERSIONED_ASSETS) {
  const pattern = new RegExp(`${escapeRegExp(assetPath)}\\?v=[^"']+`, "g");
  html = html.replace(pattern, `${assetPath}?v=${version}`);
}
fs.writeFileSync(INDEX_PATH, html, "utf8");
console.log(`[asset-version] ${version}`);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
