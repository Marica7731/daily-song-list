#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATIC_COMMON_PATHS = [
  ".github/workflows/deploy-vps-static.yml",
  "index.html",
  "assets",
  "data/status.json",
  "data/diff/latest-7d.json",
  "data/diff/latest-all.json",
  "scripts/compact-static-index.js",
  "scripts/resolve-static-deploy-paths.js",
  ".nojekyll",
  "CNAME",
];

function addDataUiPath(value, paths) {
  if (typeof value === "string" && value.startsWith("data/ui/")) paths.add(value);
}

function collectDataUiPaths(value, paths, key = "") {
  if (/legacy/i.test(key)) return;
  if (typeof value === "string") {
    addDataUiPath(value, paths);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDataUiPaths(item, paths, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) collectDataUiPaths(item, paths, childKey);
  }
}

function collectStaticPaths(meta) {
  const paths = new Set(["data/ui/meta.json"]);
  collectDataUiPaths(meta?.ranges, paths);
  return [...paths].sort();
}

function readJson(repoRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function collectManifestPaths(repoRoot, paths) {
  const expanded = new Set(paths);
  for (const relativePath of paths) {
    if (!/(?:^|\/)manifest(?:\.[^/]+)?\.json$/u.test(relativePath)) continue;
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    collectDataUiPaths(readJson(repoRoot, relativePath), expanded);
  }
  return [...expanded].sort();
}

function resolvePaths({ metaPath = "data/ui/meta.json", repoRoot = process.cwd(), includeManifestPaths = false } = {}) {
  const meta = readJson(repoRoot, metaPath);
  let dataUiPaths = collectStaticPaths(meta);
  if (includeManifestPaths) dataUiPaths = collectManifestPaths(repoRoot, dataUiPaths);
  return [...new Set([...STATIC_COMMON_PATHS, ...dataUiPaths])].sort();
}

function main() {
  const includeManifestPaths = process.argv.includes("--include-manifest-paths");
  const metaPathArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const paths = resolvePaths({
    metaPath: metaPathArg || "data/ui/meta.json",
    includeManifestPaths,
  });
  process.stdout.write(`${paths.join("\n")}\n`);
  process.stderr.write(`CODEX_STATIC_PATHS_OK count=${paths.length} includeManifestPaths=${includeManifestPaths}\n`);
}

if (require.main === module) main();

module.exports = { collectStaticPaths, resolvePaths };
