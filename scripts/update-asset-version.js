const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const REVIEW_PATH = path.join(ROOT, "review.html");
const VERSIONED_ASSETS = [
  "assets/styles.css",
  "assets/source-filter.js",
  "assets/frontend-utils.js",
  "assets/ranking-utils.js",
  "assets/app.js",
  "assets/review.js",
];

const hash = crypto.createHash("sha256");
for (const assetPath of VERSIONED_ASSETS) {
  hash.update(assetPath);
  hash.update(fs.readFileSync(path.join(ROOT, assetPath)));
}
const version = `h${hash.digest("hex").slice(0, 12)}`;
updateHtmlAssetVersions(INDEX_PATH, version);
updateHtmlAssetVersions(REVIEW_PATH, version);
console.log(`[asset-version] ${version}`);

function updateHtmlAssetVersions(filePath, version) {
  let html = fs.readFileSync(filePath, "utf8");
  for (const assetPath of VERSIONED_ASSETS) {
    const escaped = escapeRegExp(assetPath);
    html = html.replace(new RegExp(`${escaped}(?:\\?v=[^"']+)?`, "g"), `${assetPath}?v=${version}`);
  }
  fs.writeFileSync(filePath, html, "utf8");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
