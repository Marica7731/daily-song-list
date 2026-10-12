const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const VERSIONED_ASSETS = [
  "assets/styles.css",
  "assets/blocked-vtuber-meta.js",
  "assets/blocked-vtuber-channels.js",
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
updateHtmlAssetVersions(INDEX_PATH, version);
console.log(`[asset-version] ${version}`);

function updateHtmlAssetVersions(filePath, version) {
  let html = fs.readFileSync(filePath, "utf8");
  for (const assetPath of VERSIONED_ASSETS) {
    const extension = path.extname(assetPath);
    const assetStem = assetPath.slice(0, -extension.length);
    const escapedStem = escapeRegExp(assetStem);
    const escapedExtension = escapeRegExp(extension);
    const versionedPath = versionedAssetPath(assetPath, version);
    html = html.replace(
      new RegExp(`${escapedStem}(?:-h[0-9a-f]+)?${escapedExtension}(?:\\?v=[^"']+)?`, "g"),
      versionedPath,
    );
    removeOldVersionedAssetCopies(assetPath, versionedPath);
    fs.copyFileSync(path.join(ROOT, assetPath), path.join(ROOT, versionedPath));
  }
  fs.writeFileSync(filePath, html, "utf8");
}

function versionedAssetPath(assetPath, version) {
  const extension = path.extname(assetPath);
  return `${assetPath.slice(0, -extension.length)}-${version}${extension}`;
}

function removeOldVersionedAssetCopies(assetPath, currentVersionedPath) {
  const extension = path.extname(assetPath);
  const absoluteDir = path.join(ROOT, path.dirname(assetPath));
  const baseName = path.basename(assetPath, extension);
  const currentName = path.basename(currentVersionedPath);
  for (const entry of fs.readdirSync(absoluteDir)) {
    if (!entry.startsWith(`${baseName}-h`) || !entry.endsWith(extension) || entry === currentName) continue;
    fs.rmSync(path.join(absoluteDir, entry), { force: true });
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
