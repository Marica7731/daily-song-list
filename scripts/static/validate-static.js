#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.env.STATIC_DATA_ROOT || path.join(__dirname, "../../data/static/v1"));
const maxBytes = Number.parseInt(process.env.STATIC_MAX_SHARD_BYTES || "4000000", 10);
const meta = read("meta.json");
const state = read("state.json");

if (meta.architecture !== "github-actions-static-shards-v1") fail("unexpected architecture");
if (!meta.continuityStart || !state.continuityStart) fail("continuityStart missing");
if (!Array.isArray(meta.historyGaps) || !meta.historyGaps.some((gap) => gap.from === "2026-08-23" && gap.through === "2026-08-31" && gap.status === "MISSING")) fail("required history gap missing");
for (const range of ["7d", "30d", "all"]) {
  for (const type of ["songs", "artists", "vtubers"]) {
    const manifest = read(`rankings/${range}/${type}/manifest.json`);
    if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) fail(`${range}/${type} pageCount invalid`);
    for (let page = 1; page <= manifest.pageCount; page += 1) {
      const relative = `rankings/${range}/${type}/page-${String(page).padStart(4, "0")}.json`;
      const payload = read(relative);
      if (payload.range !== range || payload.type !== type || payload.page !== page) fail(`${relative} identity mismatch`);
      checkSize(relative);
    }
  }
}
const search = read("search/manifest.json");
for (const shard of search.shards || []) {
  read(shard.path);
  checkSize(shard.path);
}
if ((meta.sourceCoverage?.status || "") !== "success") fail("source coverage is not success");
console.log(`STATIC_DATA_OK videos=${meta.videoCount} songs=${meta.songOccurrenceCount} processed=${meta.processedVideoCount} pending=${meta.pendingVideoCount}`);

function read(relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) fail(`unsafe path: ${relative}`);
  try { return JSON.parse(fs.readFileSync(target, "utf8")); }
  catch (error) { fail(`${relative}: ${error.message}`); }
}
function checkSize(relative) {
  const bytes = fs.statSync(path.resolve(root, relative)).size;
  if (bytes > maxBytes) fail(`${relative} exceeds ${maxBytes}: ${bytes}`);
}
function fail(message) { throw new Error(message); }
