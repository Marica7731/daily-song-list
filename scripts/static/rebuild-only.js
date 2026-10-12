#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildStaticSite } = require("./collect-and-build");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const NOW = new Date(process.env.STATIC_NOW || Date.now());
const PAGE_SIZE = positiveInt(process.env.STATIC_PAGE_SIZE, 50);
const MAX_SHARD_BYTES = positiveInt(process.env.STATIC_MAX_SHARD_BYTES, 4_000_000);

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[static-rebuild-only] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function main() {
  assertOwnedRoot(DATA_ROOT);
  const statePath = path.join(DATA_ROOT, "state.json");
  if (!fs.existsSync(statePath)) throw new Error(`missing state: ${statePath}`);
  const state = readJson(statePath);
  const stateBefore = fs.readFileSync(statePath, "utf8");
  const meta = buildStaticSite(DATA_ROOT, state, NOW, {
    pageSize: PAGE_SIZE,
    maxShardBytes: MAX_SHARD_BYTES,
  });
  const stateAfter = fs.readFileSync(statePath, "utf8");
  if (stateBefore !== stateAfter) throw new Error("rebuild-only must not modify collector state");
  console.log(
    `[static-rebuild-only] generatedAt=${meta.generatedAt} videos=${meta.videoCount} songs=${meta.songOccurrenceCount} pending=${meta.pendingVideoCount}`,
  );
}

function assertOwnedRoot(root) {
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root || !normalized.replaceAll("\\", "/").endsWith("/data/static/v1")) {
    throw new Error(`refusing unsafe static data root: ${normalized}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
