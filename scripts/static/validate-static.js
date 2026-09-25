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
if (!Array.isArray(meta.historyGaps)) fail("historyGaps missing");
if (meta.historyDays) {
  for (const date of dates("2026-08-23", "2026-08-31")) {
    if (!['COMPLETE', 'MISSING'].includes(meta.historyDays[date])) fail(`history day status invalid: ${date}`);
  }
}
for (const range of ["today", "3d", "7d", "30d", "all"]) {
  if (!meta.ranges?.[range]) fail(`${range} meta range missing`);
  for (const type of ["songs", "artists", "vtubers"]) {
    const manifest = read(`rankings/${range}/${type}/manifest.json`);
    if (!Number.isInteger(manifest.pageCount) || manifest.pageCount < 1) fail(`${range}/${type} pageCount invalid`);
    if (manifest.totalCount !== meta.ranges[range][type]?.totalCount || manifest.pageCount !== meta.ranges[range][type]?.pageCount) fail(`${range}/${type} manifest vs meta mismatch`);
    if (manifest.pageNumberWidth !== 4) fail(`${range}/${type} pageNumberWidth invalid`);
    if (manifest.path !== `rankings/${range}/${type}/page-{page:04d}.json`) fail(`${range}/${type} page path contract invalid`);
    for (let page = 1; page <= manifest.pageCount; page += 1) {
      const relative = manifest.path.replace("{page:04d}", String(page).padStart(manifest.pageNumberWidth, "0"));
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
const quality = read("quality-audit.json");
if (quality.quarantinedOccurrences !== meta.quality?.quarantinedOccurrences) fail("quality audit vs meta mismatch");
if (quality.visibleOccurrences !== meta.songOccurrenceCount) fail("quality audit vs published count mismatch");
if (quality.visibleVideos !== meta.videoCount) fail("quality visible video count mismatch");
const review = read("quality-review.json");
if (review.status !== "REVIEW_ONLY_NO_AUTO_DELETION") fail("quality review is not explicitly review-only");
if (review.scannedVideoCount !== meta.videoCount || review.scannedOccurrenceCount !== meta.songOccurrenceCount) fail("quality review scan vs published counts mismatch");
if (review.scannedDays.length !== meta.quality?.reviewedDayCount) fail("quality review day count mismatch");
if (review.candidates.length !== meta.quality?.reviewOnlyCandidateCount) fail("quality review candidate count mismatch");
if (review.scannedDays.reduce((sum, day) => sum + day.occurrences, 0) !== meta.songOccurrenceCount) fail("quality review daily totals mismatch");
if (review.scannedDays.reduce((sum, day) => sum + day.quarantinedOccurrences, 0) !== quality.quarantinedOccurrences) fail("quality audit daily quarantines mismatch");
for (const range of ["today", "3d", "7d", "30d", "all"]) {
  for (const type of ["songs", "artists", "vtubers"]) {
    const ranking = read(`rankings/${range}/${type}/page-0001.json`);
    if (ranking.totalCount !== meta.ranges[range][type].totalCount) fail(`${range}/${type} rank count mismatch`);
  }
}
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
function dates(from, through) {
  const values = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${through}T00:00:00Z`);
  while (cursor <= end) { values.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return values;
}
function fail(message) { throw new Error(message); }
