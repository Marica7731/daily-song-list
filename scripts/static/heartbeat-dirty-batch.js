#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const REVIEW_ROOT = path.resolve(process.env.STATIC_REVIEW_ROOT || path.join(ROOT, "data/review"));
const SOURCES_ROOT = path.join(REVIEW_ROOT, "sources");
const OVERRIDES_PATH = path.resolve(
  process.env.STATIC_CURATION_OVERRIDES_PATH || path.join(ROOT, "config/curation-overrides.json"),
);
const STATE_PATH = path.resolve(process.env.STATIC_HEARTBEAT_STATE_PATH || path.join(REVIEW_ROOT, "heartbeat-state.json"));
const PATCH_PATH = path.resolve(process.env.STATIC_HEARTBEAT_PATCH_PATH || path.join(REVIEW_ROOT, "heartbeat-patch.json"));
const MAX_RECORDS = 50;
const APPROVED_TYPES = new Set(["confirmed_noise", "parser_corruption"]);
const SCOPE_ORDER = ["current", "history"];
const TYPE_ORDER = ["confirmed_noise", "parser_corruption"];

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[dirty-heartbeat] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const existing = readJsonIfExists(OVERRIDES_PATH) || { schemaVersion: 1, records: [] };
  const state = readJsonIfExists(STATE_PATH) || initialState();
  const candidates = collectCandidates(REVIEW_ROOT, options.types, options.scope);
  const selected = selectBatch(candidates, existing.records || [], options.maxRecords, state);
  const patch = {
    schemaVersion: 1,
    generatedAt: options.now,
    source: "codex-heartbeat",
    records: selected.map((item) => item.record),
  };
  const summary = {
    schemaVersion: 1,
    generatedAt: options.now,
    requestedScope: options.scope,
    requestedTypes: options.types,
    maxRecords: options.maxRecords,
    availableCounts: countByPool(candidates),
    selectedCounts: countByPool(selected),
    selected: selected.map((item) => ({
      scope: item.scope,
      classification: item.classification,
      videoId: item.videoId,
      sourceId: item.sourceId,
      sourceHash: item.sourceHash,
      seconds: item.seconds,
      rawHash: item.rawHash,
      action: item.record.action,
    })),
    skippedExistingCount: candidates.filter((item) => matchesExisting(existing.records || [], item)).length,
    rawHistoryTouched: false,
  };

  writeJson(PATCH_PATH, patch);
  writeJson(path.join(REVIEW_ROOT, "heartbeat-summary.json"), summary);
  state.schemaVersion = 1;
  state.updatedAt = options.now;
  state.lastBatch = summary;
  state.batches = [...(Array.isArray(state.batches) ? state.batches : []), {
    generatedAt: options.now,
    selectedCounts: summary.selectedCounts,
    maxRecords: options.maxRecords,
    scope: options.scope,
    types: options.types,
  }].slice(-50);
  writeJson(STATE_PATH, state);

  console.log(
    `[dirty-heartbeat] available=${JSON.stringify(summary.availableCounts)} selected=${JSON.stringify(summary.selectedCounts)} skippedExisting=${summary.skippedExistingCount} patch=${path.relative(ROOT, PATCH_PATH)}`,
  );
}

function parseOptions(argv) {
  const options = {
    maxRecords: 25,
    scope: "all",
    types: [...TYPE_ORDER],
    now: new Date().toISOString(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--max-records") options.maxRecords = Number.parseInt(argv[++index], 10);
    else if (argument === "--scope") options.scope = String(argv[++index] || "");
    else if (argument === "--types") options.types = String(argv[++index] || "").split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--now") options.now = String(argv[++index] || "");
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1 || options.maxRecords > MAX_RECORDS) {
    throw new Error(`--max-records must be an integer from 1 to ${MAX_RECORDS}`);
  }
  if (!["all", "current", "history"].includes(options.scope)) {
    throw new Error("--scope must be one of all, current, history");
  }
  if (!options.types.length || options.types.some((type) => !APPROVED_TYPES.has(type))) {
    throw new Error("--types may only contain confirmed_noise and parser_corruption");
  }
  options.types = [...new Set(options.types)];
  if (Number.isNaN(Date.parse(options.now))) throw new Error("--now must be an ISO timestamp");
  return options;
}

function collectCandidates(reviewRoot, allowedTypes, scope) {
  const sourcesRoot = path.join(reviewRoot, "sources");
  const result = [];
  if (!fs.existsSync(sourcesRoot)) return result;
  for (const name of fs.readdirSync(sourcesRoot).sort()) {
    if (!name.endsWith(".json")) continue;
    const candidateScope = name.startsWith("history-") ? "history" : "current";
    if (scope !== "all" && scope !== candidateScope) continue;
    const file = path.join(sourcesRoot, name);
    let payload;
    try {
      payload = readJson(file);
    } catch {
      continue;
    }
    const videoId = String(payload?.video?.videoId || "").trim();
    const sourceId = String(payload?.source?.sourceId || "").trim();
    const sourceHash = String(payload?.source?.sourceHash || "").trim();
    if (!isValidVideoId(videoId) || !sourceId || !sourceHash) continue;
    for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
      const classification = String(entry?.classification || "");
      if (!allowedTypes.includes(classification)) continue;
      const seconds = Number(entry?.seconds);
      const rawHash = String(entry?.rawHash || "").trim();
      if (!Number.isInteger(seconds) || seconds < 0 || !rawHash) continue;
      const expectedAction = classification === "confirmed_noise" ? "drop_entry" : "replace_entry";
      if (String(entry?.suggestedAction || "") !== expectedAction) continue;
      const replacement = classification === "parser_corruption" ? entry?.replacementSuggestion : null;
      if (classification === "parser_corruption" && !hasReplacement(replacement)) continue;
      const item = {
        scope: candidateScope,
        classification,
        videoId,
        sourceId,
        sourceHash,
        seconds,
        rawHash,
        sourceFile: path.relative(reviewRoot, file).replace(/\\/g, "/"),
        record: {
          action: expectedAction,
          videoId,
          occurrenceId: "",
          sourceId,
          sourceHash,
          seconds,
          rawHash,
          ...(replacement ? { replacement: normalizeReplacement(replacement) } : {}),
          reason: classification === "confirmed_noise" ? "heartbeat_confirmed_noise" : "heartbeat_parser_corruption",
          note: `Codex heartbeat approved ${classification} from ${path.relative(reviewRoot, file).replace(/\\/g, "/")}`,
          reviewedAt: "",
          reviewedBy: "codex-heartbeat",
        },
      };
      result.push(item);
    }
  }
  return dedupeCandidates(result);
}

function selectBatch(candidates, existingRecords, maxRecords, state) {
  const offsets = state.offsets && typeof state.offsets === "object" ? state.offsets : {};
  const pools = new Map();
  for (const candidate of candidates) {
    if (matchesExisting(existingRecords, candidate)) continue;
    const key = poolKey(candidate);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(candidate);
  }
  for (const pool of pools.values()) {
    pool.sort((left, right) => stableKey(left).localeCompare(stableKey(right)));
  }

  const orderedKeys = [];
  for (const scope of SCOPE_ORDER) {
    for (const type of TYPE_ORDER) {
      const key = `${scope}:${type}`;
      if (pools.has(key)) orderedKeys.push(key);
    }
  }

  const selected = [];
  const used = new Set();
  let progressed = true;
  while (selected.length < maxRecords && progressed && orderedKeys.length) {
    progressed = false;
    for (const key of orderedKeys) {
      if (selected.length >= maxRecords) break;
      const pool = pools.get(key) || [];
      if (!pool.length) continue;
      const rawOffset = Number(offsets[key] || 0);
      const start = ((rawOffset % pool.length) + pool.length) % pool.length;
      let chosen = null;
      let chosenIndex = -1;
      let considered = 0;
      for (let step = 0; step < pool.length; step += 1) {
        const index = (start + step) % pool.length;
        const candidate = pool[index];
        considered += 1;
        const candidateKey = stableKey(candidate);
        if (used.has(candidateKey)) continue;
        chosen = candidate;
        chosenIndex = index;
        break;
      }
      if (!chosen) continue;
      used.add(stableKey(chosen));
      selected.push(chosen);
      offsets[key] = (chosenIndex + 1) % pool.length;
      progressed = true;
    }
  }

  state.offsets = offsets;
  return selected;
}

function matchesExisting(records, candidate) {
  return (records || []).some((record) => {
    if (String(record?.videoId || "") !== candidate.videoId) return false;
    if (record?.sourceId && String(record.sourceId) !== candidate.sourceId) return false;
    if (record?.sourceHash && String(record.sourceHash) !== candidate.sourceHash) return false;
    if (Number(record?.seconds) !== candidate.seconds) return false;
    if (record?.rawHash && String(record.rawHash) !== candidate.rawHash) return false;
    return true;
  });
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = stableKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countByPool(items) {
  const counts = {};
  for (const item of items || []) {
    const key = poolKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function poolKey(item) {
  return `${item.scope}:${item.classification}`;
}

function stableKey(item) {
  return [item.videoId, item.sourceId, item.sourceHash, item.seconds, item.rawHash].join("|");
}

function hasReplacement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(
    (typeof value.title === "string" && value.title.trim()) ||
      (typeof value.artist === "string" && value.artist.trim()) ||
      (Number.isInteger(value.seconds) && value.seconds >= 0),
  );
}

function normalizeReplacement(value) {
  const replacement = {};
  if (typeof value.title === "string" && value.title.trim()) replacement.title = value.title.trim();
  if (typeof value.artist === "string" && value.artist.trim()) replacement.artist = value.artist.trim();
  if (Number.isInteger(value.seconds) && value.seconds >= 0) replacement.seconds = value.seconds;
  return replacement;
}

function isValidVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/u.test(value);
}

function initialState() {
  return { schemaVersion: 1, offsets: {}, batches: [] };
}

function readJsonIfExists(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

module.exports = {
  APPROVED_TYPES,
  MAX_RECORDS,
  collectCandidates,
  matchesExisting,
  parseOptions,
  selectBatch,
};
