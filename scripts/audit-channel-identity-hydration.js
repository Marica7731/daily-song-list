#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildChannelMetadataLookup,
  findChannelMetadata,
  loadChannelMetadataCache,
  normalizeChannelMetadata,
} = require("./channel-metadata-cache");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_API_BASE = "https://ytb-song-rank.culua.com";
const DEFAULT_METADATA_PATH = path.join(ROOT, "data", "external", "youtube-channel-discovery", "channel-metadata.json");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "artifacts", "channel-identity-audit");
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_CONCURRENCY = 3;
const DEFAULT_API_CONCURRENCY = 2;
const DEFAULT_SAMPLE_VIDEOS = 3;
const MAX_NETWORK_CONCURRENCY = 8;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{20,}$/u;
const HANDLE_PATTERN = /^\/?@[A-Za-z0-9._%~-]+$/u;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mergeInputs.length) {
    const reports = options.mergeInputs.map(readJson);
    const merged = mergeReports(reports, options);
    writeReportFiles(merged, options);
    console.log(
      `CODEX_CHANNEL_IDENTITY_AUDIT_MERGE_OK inputs=${reports.length} highConfidence=${merged.highConfidence.length} ambiguous=${merged.ambiguous.length} unresolved=${merged.unresolved.length} dryRun=true`,
    );
    return;
  }
  const report = await runAudit(options);
  console.log(
    `CODEX_CHANNEL_IDENTITY_AUDIT_OK records=${report.summary.sourceRecordCount} missingRecords=${report.summary.missingRecordCount} selectedGroups=${report.summary.selectedGroupCount} highConfidence=${report.highConfidence.length} ambiguous=${report.ambiguous.length} unresolved=${report.unresolved.length} excludedKnownPositive=${report.summary.excludedKnownPositiveCount} dryRun=true shard=${report.shard.index}/${report.shard.count}`,
  );
}

function parseArgs(args) {
  const options = {
    apiBase: DEFAULT_API_BASE,
    apiView: "videos",
    apiQuery: "",
    inputJson: "",
    metadataPath: DEFAULT_METADATA_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    outputJson: "",
    outputMarkdown: "",
    cacheDir: "",
    checkpointPath: "",
    manifestPath: "",
    stageLogPath: "",
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    networkConcurrency: DEFAULT_NETWORK_CONCURRENCY,
    apiConcurrency: DEFAULT_API_CONCURRENCY,
    maxVideosPerGroup: DEFAULT_SAMPLE_VIDEOS,
    shardIndex: 0,
    shardCount: 1,
    onlyNames: [],
    onlyVideoIds: [],
    excludeNames: [],
    retryFailed: false,
    refreshApi: false,
    dryRun: true,
    mergeInputs: [],
    topLimit: 30,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--api-base") {
      options.apiBase = requiredValue(args, ++index, arg).replace(/\/+$/u, "");
    } else if (arg === "--api-view") {
      options.apiView = requiredValue(args, ++index, arg);
    } else if (arg === "--api-query") {
      options.apiQuery = requiredValue(args, ++index, arg);
    } else if (arg === "--input-json") {
      options.inputJson = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--metadata") {
      options.metadataPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--output-json") {
      options.outputJson = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--output-markdown") {
      options.outputMarkdown = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--cache-dir") {
      options.cacheDir = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--checkpoint") {
      options.checkpointPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--manifest") {
      options.manifestPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--stage-log") {
      options.stageLogPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--request-timeout-ms") {
      options.requestTimeoutMs = boundedInt(requiredValue(args, ++index, arg), 1_000, MAX_REQUEST_TIMEOUT_MS, arg);
    } else if (arg === "--concurrency") {
      options.networkConcurrency = boundedInt(requiredValue(args, ++index, arg), 1, MAX_NETWORK_CONCURRENCY, arg);
    } else if (arg === "--api-concurrency") {
      options.apiConcurrency = boundedInt(requiredValue(args, ++index, arg), 1, MAX_NETWORK_CONCURRENCY, arg);
    } else if (arg === "--max-videos-per-group") {
      options.maxVideosPerGroup = boundedInt(requiredValue(args, ++index, arg), 1, 20, arg);
    } else if (arg === "--shard-index") {
      options.shardIndex = boundedInt(requiredValue(args, ++index, arg), 0, 999, arg);
    } else if (arg === "--shard-count") {
      options.shardCount = boundedInt(requiredValue(args, ++index, arg), 1, 1_000, arg);
    } else if (arg === "--only-name") {
      options.onlyNames.push(requiredValue(args, ++index, arg));
    } else if (arg === "--only-video-id") {
      options.onlyVideoIds.push(requiredValue(args, ++index, arg));
    } else if (arg === "--exclude-name") {
      options.excludeNames.push(requiredValue(args, ++index, arg));
    } else if (arg === "--retry-failed") {
      options.retryFailed = true;
    } else if (arg === "--refresh-api") {
      options.refreshApi = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--merge-input") {
      options.mergeInputs.push(path.resolve(requiredValue(args, ++index, arg)));
    } else if (arg === "--top-limit") {
      options.topLimit = boundedInt(requiredValue(args, ++index, arg), 1, 200, arg);
    } else if (arg === "--apply" || arg === "--write-metadata" || arg === "--import") {
      throw new Error(`${arg} is intentionally unsupported; this tool only emits dry-run review candidates`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["videos", "vtubers"].includes(options.apiView)) {
    throw new Error("--api-view must be videos or vtubers");
  }
  if (options.shardIndex >= options.shardCount) {
    throw new Error("--shard-index must be smaller than --shard-count");
  }
  options.cacheDir ||= path.join(options.outputDir, "cache");
  options.checkpointPath ||= path.join(options.cacheDir, "checkpoint.json");
  options.manifestPath ||= path.join(options.cacheDir, "manifest.json");
  options.stageLogPath ||= path.join(options.cacheDir, "stage.log");
  options.outputJson ||= path.join(options.outputDir, `candidates-shard-${String(options.shardIndex).padStart(3, "0")}-of-${String(options.shardCount).padStart(3, "0")}.json`);
  options.outputMarkdown ||= path.join(options.outputDir, `candidates-shard-${String(options.shardIndex).padStart(3, "0")}-of-${String(options.shardCount).padStart(3, "0")}.md`);
  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function boundedInt(value, minimum, maximum, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function runAudit(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  ensureArtifactPaths(options);
  const startedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    dryRun: true,
    shard: { index: options.shardIndex, count: options.shardCount },
    stages: {},
  };
  writeJsonAtomic(options.manifestPath, manifest);
  logStage(options, "audit_started", { shardIndex: options.shardIndex, shardCount: options.shardCount });

  try {
    const source = options.inputJson
      ? {
          kind: "runtime_json",
          input: portablePath(options.inputJson),
          payload: readJson(options.inputJson),
          meta: {},
        }
      : await fetchProductionPayload(options, fetchImpl);
    const records = normalizeSourceRecords(source.payload, options.apiView);
    manifest.stages.input = {
      status: "completed",
      sourceRecordCount: records.length,
      sourceKind: source.kind,
      completedAt: new Date().toISOString(),
    };
    checkpointManifest(options, manifest);

    const inventory = groupMissingIdentityRecords(records);
    let selectedGroups = inventory.groups.filter((group) => matchesSelection(group, options));
    selectedGroups = selectedGroups.filter((group) => shardForKey(group.groupKey, options.shardCount) === options.shardIndex);
    manifest.stages.inventory = {
      status: "completed",
      missingRecordCount: inventory.summary.missingRecordCount,
      missingGroupCount: inventory.groups.length,
      selectedGroupCount: selectedGroups.length,
      completedAt: new Date().toISOString(),
    };
    checkpointManifest(options, manifest);
    logStage(options, "inventory_completed", manifest.stages.inventory);

    const metadataPayload = loadChannelMetadataCache(options.metadataPath);
    const cacheContext = buildMetadataContext(metadataPayload.channels);
    const checkpoint = readCheckpoint(options.checkpointPath);
    const resolver = createIdentityResolver({
      checkpoint,
      checkpointPath: options.checkpointPath,
      fetchImpl,
      options,
    });

    const results = [];
    let completedGroups = 0;
    const classified = await mapLimit(selectedGroups, options.networkConcurrency, async (group) => {
      const result = await classifyGroup(group, {
        cacheContext,
        resolver,
        maxVideosPerGroup: options.maxVideosPerGroup,
        excludeNames: options.excludeNames,
      });
      completedGroups += 1;
      manifest.stages.resolve = {
        status: completedGroups === selectedGroups.length ? "completed" : "running",
        completedGroups,
        selectedGroupCount: selectedGroups.length,
        updatedAt: new Date().toISOString(),
      };
      checkpointManifest(options, manifest);
      logStage(options, "group_classified", {
        groupKey: group.groupKey,
        classification: result.classification,
        completedGroups,
        selectedGroupCount: selectedGroups.length,
      });
      return result;
    });
    results.push(...classified);

    const report = buildReport({
      source,
      records,
      inventory,
      results,
      metadataPayload,
      options,
      startedAt,
    });
    writeReportFiles(report, options);
    manifest.status = "completed";
    manifest.updatedAt = new Date().toISOString();
    manifest.completedAt = manifest.updatedAt;
    manifest.outputs = {
      json: portablePath(options.outputJson),
      markdown: portablePath(options.outputMarkdown),
    };
    manifest.summary = {
      sourceRecordCount: report.summary.sourceRecordCount,
      missingRecordCount: report.summary.missingRecordCount,
      selectedGroupCount: report.summary.selectedGroupCount,
      highConfidence: report.highConfidence.length,
      ambiguous: report.ambiguous.length,
      unresolved: report.unresolved.length,
    };
    writeJsonAtomic(options.manifestPath, manifest);
    logStage(options, "audit_completed", manifest.summary);
    return report;
  } catch (error) {
    manifest.status = "failed";
    manifest.updatedAt = new Date().toISOString();
    manifest.error = sanitizeError(error);
    writeJsonAtomic(options.manifestPath, manifest);
    logStage(options, "audit_failed", { error: manifest.error });
    throw error;
  }
}

function ensureArtifactPaths(options) {
  for (const filePath of [
    options.outputJson,
    options.outputMarkdown,
    options.checkpointPath,
    options.manifestPath,
    options.stageLogPath,
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
}

async function fetchProductionPayload(options, fetchImpl) {
  const metaUrl = `${options.apiBase}/api/meta`;
  const meta = await fetchJson(metaUrl, {
    fetchImpl,
    timeoutMs: options.requestTimeoutMs,
    retries: 1,
  });
  const sourceCommitSha = stringValue(meta?.meta?.source_commit_sha) || "unknown";
  const queryKey = sha256(
    JSON.stringify({
      apiBase: options.apiBase,
      view: options.apiView,
      q: options.apiQuery,
      sourceCommitSha,
    }),
  ).slice(0, 16);
  const pageDir = path.join(options.cacheDir, "api-pages", queryKey);
  fs.mkdirSync(pageDir, { recursive: true });

  const firstPage = await loadApiPage(1, pageDir, options, fetchImpl);
  const pageCount = Math.max(1, Number(firstPage.pageCount) || 1);
  const pages = new Array(pageCount);
  pages[0] = firstPage;
  const pageNumbers = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
  const remaining = await mapLimit(pageNumbers, options.apiConcurrency, (page) => loadApiPage(page, pageDir, options, fetchImpl));
  for (let index = 0; index < remaining.length; index += 1) {
    pages[index + 1] = remaining[index];
  }

  const records = pages.flatMap((page) => (Array.isArray(page.records) ? page.records : []));
  return {
    kind: "production_api",
    apiBase: options.apiBase,
    meta: {
      schemaVersion: meta.schemaVersion,
      sourceCommitSha,
      builtAt: stringValue(meta?.meta?.built_at),
      latestGeneratedAt: stringValue(meta?.meta?.latest_generated_at),
      counts: meta.counts || {},
    },
    payload: {
      schemaVersion: 1,
      view: options.apiView,
      query: options.apiQuery,
      totalCount: Number(firstPage.totalCount) || records.length,
      totalOccurrenceCount: Number(firstPage.totalOccurrenceCount) || 0,
      totalVideoCount: Number(firstPage.totalVideoCount) || 0,
      records,
    },
  };
}

async function loadApiPage(page, pageDir, options, fetchImpl) {
  const cachePath = path.join(pageDir, `page-${String(page).padStart(5, "0")}.json`);
  if (!options.refreshApi && fs.existsSync(cachePath)) {
    const cached = readJson(cachePath);
    validateApiPage(cached, page);
    logStage(options, "api_page_cache_hit", { page, records: cached.records.length });
    return cached;
  }
  const url = new URL(`${options.apiBase}/api/rankings`);
  url.searchParams.set("range", "all");
  url.searchParams.set("view", options.apiView);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", options.apiQuery ? "50" : "200");
  url.searchParams.set("compact", "1");
  if (options.apiQuery) url.searchParams.set("q", options.apiQuery);
  const payload = await fetchJson(url.toString(), {
    fetchImpl,
    timeoutMs: options.requestTimeoutMs,
    retries: 1,
  });
  validateApiPage(payload, page);
  writeJsonAtomic(cachePath, payload);
  logStage(options, "api_page_fetched", { page, records: payload.records.length });
  return payload;
}

function validateApiPage(payload, expectedPage) {
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error(`API page ${expectedPage} is missing records`);
  }
  if (Number(payload.page) !== expectedPage) {
    throw new Error(`API page mismatch: expected ${expectedPage}, got ${payload.page}`);
  }
}

function normalizeSourceRecords(payload, viewHint = "videos") {
  if (Array.isArray(payload)) return payload.map(normalizeRecord);
  if (Array.isArray(payload?.videos)) return payload.videos.map(normalizeRecord);
  if (Array.isArray(payload?.records)) {
    const view = stringValue(payload.view || viewHint);
    if (view === "vtubers") return payload.records.map(normalizeVtuberRecord);
    return payload.records.map(normalizeRecord);
  }
  const groups = payload?.groups && typeof payload.groups === "object" ? payload.groups : {};
  const group = groups.all || groups.ALL || groups["7d"] || Object.values(groups).find((value) => Array.isArray(value?.items));
  return Array.isArray(group?.items) ? group.items.map(normalizeRecord) : [];
}

function normalizeRecord(record = {}) {
  const videoId = stringValue(record.videoId || record.id);
  const videoIds = uniqueStrings([
    videoId,
    ...(Array.isArray(record.videoIds) ? record.videoIds : []),
  ]).filter((value) => VIDEO_ID_PATTERN.test(value));
  const channelUrl = stringValue(record.channelUrl || record.authorUrl || record.ownerUrl);
  const sourceUrl = stringValue(record.sourceUrl || channelUrl);
  return {
    videoId,
    videoIds,
    title: stringValue(record.title || record.videoTitle),
    channelName: stringValue(record.channelName || record.name || record.author),
    channelId: validChannelId(record.channelId || record.authorChannelId || record.ownerChannelId),
    channelHandle: normalizeHandle(record.channelHandle),
    channelUrl,
    sourceUrl,
    occurrenceCount: nonNegativeInt(record.timestampCount ?? record.count ?? record.occurrenceCount),
    videoCount: Math.max(1, nonNegativeInt(record.videoCount) || videoIds.length || (videoId ? 1 : 0)),
    sourceDetailKey: stringValue(record.sourceDetailKey),
  };
}

function normalizeVtuberRecord(record = {}) {
  const occurrences = Array.isArray(record.occurrences) ? record.occurrences : [];
  const videoIds = uniqueStrings(
    occurrences.flatMap((occurrence) => [
      occurrence?.videoId,
      occurrence?.item?.videoId,
      occurrence?.video?.videoId,
    ]),
  ).filter((value) => VIDEO_ID_PATTERN.test(value));
  return normalizeRecord({
    ...record,
    videoIds,
    occurrenceCount: record.timestampCount ?? record.count,
    videoCount: record.videoCount || videoIds.length,
  });
}

function groupMissingIdentityRecords(records) {
  const groups = new Map();
  const summary = {
    sourceRecordCount: records.length,
    missingRecordCount: 0,
    missingAllIdentityCount: 0,
    occurrenceCount: 0,
    fieldCoverageBefore: coverageStats(records),
  };

  for (const record of records) {
    const missingFields = identityMissingFields(record);
    if (!missingFields.length) continue;
    summary.missingRecordCount += 1;
    summary.occurrenceCount += record.occurrenceCount;
    if (missingFields.length === 3) summary.missingAllIdentityCount += 1;
    const groupKey = provisionalGroupKey(record);
    const group = groups.get(groupKey) || {
      groupKey,
      sourceNames: [],
      records: [],
      videoIds: [],
      recordCount: 0,
      videoCount: 0,
      occurrenceCount: 0,
      missingFieldCounts: { channelId: 0, channelHandle: 0, channelUrl: 0 },
    };
    group.records.push(record);
    group.sourceNames.push(record.channelName);
    group.videoIds.push(record.videoId, ...record.videoIds);
    group.recordCount += 1;
    group.videoCount += record.videoCount;
    group.occurrenceCount += record.occurrenceCount;
    for (const field of missingFields) group.missingFieldCounts[field] += 1;
    groups.set(groupKey, group);
  }

  const normalizedGroups = [...groups.values()].map((group) => ({
    ...group,
    sourceNames: uniqueStrings(group.sourceNames),
    videoIds: uniqueStrings(group.videoIds).filter((value) => VIDEO_ID_PATTERN.test(value)),
    videoCount: Math.max(group.videoCount, uniqueStrings(group.videoIds).filter((value) => VIDEO_ID_PATTERN.test(value)).length),
  }));
  normalizedGroups.sort(compareGroups);
  return {
    groups: normalizedGroups,
    summary,
    rankings: buildMissingRankings(normalizedGroups),
  };
}

function coverageStats(records) {
  const total = records.length;
  const fields = {};
  for (const field of ["channelId", "channelHandle", "channelUrl"]) {
    const present = records.filter((record) => hasValidIdentityField(record, field)).length;
    fields[field] = {
      present,
      missing: total - present,
      percent: total ? roundPercent(present, total) : 100,
    };
  }
  return { totalRecords: total, fields };
}

function hasValidIdentityField(record, field) {
  if (field === "channelId") return Boolean(validChannelId(record.channelId));
  if (field === "channelHandle") return Boolean(normalizeHandle(record.channelHandle));
  if (field === "channelUrl") return Boolean(validChannelUrl(record.channelUrl));
  return false;
}

function identityMissingFields(record) {
  const result = [];
  if (!validChannelId(record.channelId)) result.push("channelId");
  if (!normalizeHandle(record.channelHandle)) result.push("channelHandle");
  if (!validChannelUrl(record.channelUrl)) result.push("channelUrl");
  return result;
}

function provisionalGroupKey(record) {
  const channelId = validChannelId(record.channelId) || channelIdFromUrl(record.channelUrl || record.sourceUrl);
  if (channelId) return `id:${channelId}`;
  const handle = normalizeHandle(record.channelHandle || record.channelUrl || record.sourceUrl);
  if (handle) return `handle:${normalizeText(handle)}`;
  const name = normalizeText(record.channelName);
  if (name) return `name:${name}`;
  return `video:${record.videoId || record.videoIds[0] || sha256(JSON.stringify(record)).slice(0, 16)}`;
}

function buildMissingRankings(groups) {
  const byDisplayName = new Map();
  for (const group of groups) {
    const displayName = group.sourceNames[0] || "(missing display name)";
    const key = normalizeText(displayName) || group.groupKey;
    const entry = byDisplayName.get(key) || {
      displayName,
      groupCount: 0,
      recordCount: 0,
      videoCount: 0,
      occurrenceCount: 0,
      missingFieldCounts: { channelId: 0, channelHandle: 0, channelUrl: 0 },
    };
    entry.groupCount += 1;
    entry.recordCount += group.recordCount;
    entry.videoCount += group.videoCount;
    entry.occurrenceCount += group.occurrenceCount;
    for (const field of Object.keys(entry.missingFieldCounts)) {
      entry.missingFieldCounts[field] += group.missingFieldCounts[field];
    }
    byDisplayName.set(key, entry);
  }
  const rows = [...byDisplayName.values()];
  return {
    byVideoCount: [...rows].sort((left, right) => right.videoCount - left.videoCount || right.occurrenceCount - left.occurrenceCount),
    byOccurrenceCount: [...rows].sort((left, right) => right.occurrenceCount - left.occurrenceCount || right.videoCount - left.videoCount),
  };
}

function matchesSelection(group, options) {
  if (options.onlyNames.length) {
    const haystack = normalizeText(group.sourceNames.join(" "));
    if (!options.onlyNames.some((name) => haystack.includes(normalizeText(name)))) return false;
  }
  if (options.onlyVideoIds.length) {
    const videoIds = new Set(group.videoIds);
    if (!options.onlyVideoIds.some((videoId) => videoIds.has(videoId))) return false;
  }
  return true;
}

function shardForKey(key, shardCount) {
  if (shardCount <= 1) return 0;
  const value = Number.parseInt(sha256(key).slice(0, 8), 16);
  return value % shardCount;
}

function buildMetadataContext(channels) {
  const normalizedChannels = (channels || []).map(normalizeChannelMetadata);
  const lookup = buildChannelMetadataLookup(channels || []);
  const videoThumbnailLookup = new Map();
  for (const channel of normalizedChannels) {
    const videoId = videoIdFromThumbnail(channel.thumbnailUrl);
    if (videoId && channel.channelId) videoThumbnailLookup.set(videoId, channel);
  }
  return { lookup, normalizedChannels, videoThumbnailLookup };
}

async function classifyGroup(group, context) {
  const strongChannelIds = new Set();
  const strongHandles = new Set();
  const directEvidence = [];
  const failures = [];
  const recordIdentity = representativeIdentity(group.records);

  for (const record of group.records) {
    const channelId = validChannelId(record.channelId) || channelIdFromUrl(record.channelUrl || record.sourceUrl);
    const handle = normalizeHandle(record.channelHandle || record.channelUrl || record.sourceUrl);
    if (channelId) {
      strongChannelIds.add(channelId);
      directEvidence.push({ kind: "runtime_channel_id", channelId, videoId: record.videoId || "" });
    }
    if (handle) {
      strongHandles.add(handle);
      directEvidence.push({ kind: "runtime_handle", channelHandle: handle, videoId: record.videoId || "" });
    }
  }

  const exactCacheMatch =
    strongChannelIds.size || strongHandles.size || canonicalChannelUrl(recordIdentity.channelUrl, recordIdentity.channelId)
      ? findChannelMetadata(context.cacheContext.lookup, recordIdentity)
      : null;
  if (exactCacheMatch?.channelId) {
    strongChannelIds.add(exactCacheMatch.channelId);
    directEvidence.push({
      kind: "metadata_cache_strong_identity",
      channelId: exactCacheMatch.channelId,
      channelHandle: exactCacheMatch.channelHandle,
    });
  }

  const nameOnlyCacheMatches = [];
  if (!strongChannelIds.size && !strongHandles.size) {
    for (const sourceName of group.sourceNames) {
      const match = findChannelMetadata(context.cacheContext.lookup, { displayName: sourceName });
      if (match) nameOnlyCacheMatches.push(match);
    }
  }

  for (const videoId of group.videoIds) {
    const match = context.cacheContext.videoThumbnailLookup.get(videoId);
    if (!match?.channelId) continue;
    strongChannelIds.add(match.channelId);
    directEvidence.push({
      kind: "metadata_cache_video_thumbnail",
      videoId,
      channelId: match.channelId,
      channelHandle: match.channelHandle,
    });
  }

  const sampledVideoIds = group.videoIds.slice(0, context.maxVideosPerGroup);
  const videoResults = await mapLimit(sampledVideoIds, 1, async (videoId) => {
    const result = await context.resolver.resolveVideo(videoId);
    if (result.status === "resolved" && (result.channelId || result.channelHandle)) {
      if (result.channelId) strongChannelIds.add(result.channelId);
      if (result.channelHandle) strongHandles.add(result.channelHandle);
      directEvidence.push({
        kind: result.source === "youtube_oembed" ? "youtube_oembed" : "youtube_watch",
        videoId,
        channelId: result.channelId || "",
        channelHandle: result.channelHandle || "",
        author: result.author || "",
      });
    } else {
      failures.push({ stage: "watch", videoId, reason: result.reason || result.status });
    }
    return result;
  });

  if (strongChannelIds.size > 1 || strongHandles.size > 1) {
    return candidateResult("ambiguous", group, {
      reason: "conflicting_strong_identities",
      proposed: null,
      directEvidence,
      failures,
      nameOnlyCacheMatches,
      sampledVideoIds,
      videoResults,
      excludeNames: context.excludeNames,
    });
  }

  let channelResult = null;
  const channelId = [...strongChannelIds][0] || "";
  const channelHandle = [...strongHandles][0] || "";
  if (channelId) {
    channelResult = await context.resolver.resolveChannelById(channelId);
  } else if (channelHandle) {
    channelResult = await context.resolver.resolveChannelByHandle(channelHandle);
  }

  if (!channelResult || channelResult.status !== "resolved") {
    if (channelResult) failures.push({ stage: "channel", reason: channelResult.reason || channelResult.status });
    const hasIdentityHint = Boolean(channelId || channelHandle || nameOnlyCacheMatches.length);
    return candidateResult(hasIdentityHint ? "ambiguous" : "unresolved", group, {
      reason: hasIdentityHint ? "canonical_channel_unconfirmed" : "no_channel_identity_evidence",
      proposed: channelId
        ? { channelId, channelHandle: "", channelUrl: `https://www.youtube.com/channel/${channelId}`, displayName: "" }
        : null,
      directEvidence,
      failures,
      nameOnlyCacheMatches,
      sampledVideoIds,
      videoResults,
      excludeNames: context.excludeNames,
    });
  }

  if (channelId && channelResult.channelId !== channelId) {
    return candidateResult("ambiguous", group, {
      reason: "channel_page_id_mismatch",
      proposed: channelResult,
      directEvidence,
      failures,
      nameOnlyCacheMatches,
      sampledVideoIds,
      videoResults,
      excludeNames: context.excludeNames,
    });
  }
  if (channelHandle && normalizeText(channelResult.channelHandle) !== normalizeText(channelHandle)) {
    directEvidence.push({
      kind: "canonical_handle_changed",
      previousHandle: channelHandle,
      canonicalHandle: channelResult.channelHandle,
    });
  }

  const proposed = {
    channelId: channelResult.channelId,
    channelHandle: channelResult.channelHandle,
    channelUrl: channelResult.channelUrl,
    displayName: channelResult.displayName,
    sourceUrl: channelResult.sourceUrl,
  };
  const complete = Boolean(
    validChannelId(proposed.channelId)
      && normalizeHandle(proposed.channelHandle)
      && canonicalChannelUrl(proposed.channelUrl, proposed.channelId)
      && proposed.displayName,
  );
  const hasDirectIdentityEvidence = directEvidence.some((item) =>
    ["runtime_channel_id", "runtime_handle", "metadata_cache_strong_identity", "metadata_cache_video_thumbnail", "youtube_watch", "youtube_oembed"].includes(item.kind),
  );
  if (!complete || !hasDirectIdentityEvidence) {
    return candidateResult("ambiguous", group, {
      reason: complete ? "name_only_identity_not_sufficient" : "canonical_identity_incomplete",
      proposed,
      directEvidence,
      failures,
      nameOnlyCacheMatches,
      sampledVideoIds,
      videoResults,
      excludeNames: context.excludeNames,
    });
  }

  return candidateResult("high-confidence", group, {
    reason: renamedOrMultilingual(group.sourceNames, proposed.displayName)
      ? "official_identity_confirmed_name_changed_or_multilingual"
      : "official_identity_confirmed",
    proposed,
    directEvidence,
    failures,
    nameOnlyCacheMatches,
    sampledVideoIds,
    videoResults,
    excludeNames: context.excludeNames,
  });
}

function representativeIdentity(records) {
  const result = { displayName: "", channelId: "", channelHandle: "", channelUrl: "", sourceUrl: "" };
  for (const record of records) {
    result.displayName ||= record.channelName;
    result.channelId ||= record.channelId;
    result.channelHandle ||= record.channelHandle;
    result.channelUrl ||= record.channelUrl;
    result.sourceUrl ||= record.sourceUrl;
  }
  return result;
}

function candidateResult(classification, group, details) {
  const excluded = details.excludeNames.some((name) =>
    normalizeText([...group.sourceNames, details.proposed?.displayName].filter(Boolean).join(" ")).includes(normalizeText(name)),
  );
  return {
    classification,
    groupKey: group.groupKey,
    sourceNames: group.sourceNames,
    recordCount: group.recordCount,
    videoCount: group.videoCount,
    occurrenceCount: group.occurrenceCount,
    missingFieldCounts: group.missingFieldCounts,
    sampledVideoIds: details.sampledVideoIds,
    proposed: details.proposed,
    confidenceReason: details.reason,
    deliveryDisposition: excluded ? "excluded_known_positive" : classification === "high-confidence" ? "review_then_hydrate" : "manual_review",
    evidence: {
      direct: details.directEvidence,
      nameOnlyCacheHints: uniqueMetadataHints(details.nameOnlyCacheMatches),
      watchResults: details.videoResults.map(compactWatchResult),
      failures: details.failures,
    },
  };
}

function uniqueMetadataHints(matches) {
  const result = new Map();
  for (const match of matches) {
    const normalized = normalizeChannelMetadata(match);
    const key = normalized.channelId || normalized.channelHandle || normalized.displayName;
    if (key) result.set(key, normalized);
  }
  return [...result.values()];
}

function compactWatchResult(result) {
  return {
    status: result.status,
    videoId: result.videoId,
    channelId: result.channelId || "",
    channelHandle: result.channelHandle || "",
    author: result.author || "",
    reason: result.reason || "",
    source: result.source || "",
  };
}

function createIdentityResolver({ checkpoint, checkpointPath, fetchImpl, options }) {
  const save = () => {
    checkpoint.updatedAt = new Date().toISOString();
    writeJsonAtomic(checkpointPath, checkpoint);
  };
  const requestOptions = {
    fetchImpl,
    timeoutMs: options.requestTimeoutMs,
    retries: 1,
  };

  return {
    async resolveVideo(videoId) {
      const existing = checkpoint.videos[videoId];
      if (existing && (!options.retryFailed || existing.status === "resolved")) {
        return { ...existing, cacheHit: true };
      }
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      let result;
      try {
        const page = await fetchText(url, requestOptions);
        const parsed = parseWatchPage(page.text, page.finalUrl, videoId);
        if (parsed.channelId) {
          result = {
            status: "resolved",
            videoId,
            channelId: parsed.channelId,
            channelHandle: "",
            author: parsed.author,
            fetchedAt: new Date().toISOString(),
            source: "youtube_watch_html",
          };
        } else {
          result = await resolveVideoFromOembed(videoId, parsed.reason || "watch_channel_id_missing");
        }
      } catch (error) {
        result = await resolveVideoFromOembed(videoId, sanitizeError(error));
      }
      checkpoint.videos[videoId] = result;
      save();
      return result;
    },

    async resolveChannelById(channelId) {
      const key = `id:${channelId}`;
      const existing = checkpoint.channels[key];
      if (existing && (!options.retryFailed || existing.status === "resolved")) {
        return { ...existing, cacheHit: true };
      }
      return resolveChannel(`https://www.youtube.com/channel/${channelId}`, key, channelId);
    },

    async resolveChannelByHandle(handle) {
      const normalized = normalizeHandle(handle);
      const key = `handle:${normalizeText(normalized)}`;
      const existing = checkpoint.channels[key];
      if (existing && (!options.retryFailed || existing.status === "resolved")) {
        return { ...existing, cacheHit: true };
      }
      return resolveChannel(`https://www.youtube.com${normalized}`, key, "");
    },
  };

  async function resolveVideoFromOembed(videoId, watchReason) {
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("format", "json");
    try {
      const payload = await fetchJson(url.toString(), requestOptions);
      const authorUrl = stringValue(payload.author_url);
      const channelId = channelIdFromUrl(authorUrl);
      const channelHandle = normalizeHandle(authorUrl);
      if (!channelId && !channelHandle) {
        return {
          status: "unresolved",
          videoId,
          reason: `watch=${watchReason}; oembed_author_identity_missing`,
          fetchedAt: new Date().toISOString(),
          source: "youtube_oembed",
        };
      }
      return {
        status: "resolved",
        videoId,
        channelId,
        channelHandle,
        author: stringValue(payload.author_name),
        fetchedAt: new Date().toISOString(),
        source: "youtube_oembed",
      };
    } catch (error) {
      return {
        status: "unresolved",
        videoId,
        reason: `watch=${watchReason}; oembed=${sanitizeError(error)}`.slice(0, 300),
        fetchedAt: new Date().toISOString(),
        source: "youtube_oembed",
      };
    }
  }

  async function resolveChannel(url, key, expectedChannelId) {
    let result;
    try {
      const page = await fetchText(url, requestOptions);
      const parsed = parseChannelPage(page.text, page.finalUrl);
      if (!parsed.channelId) {
        result = {
          status: "unresolved",
          reason: parsed.reason || "channel_id_missing",
          fetchedAt: new Date().toISOString(),
          source: "youtube_channel_html",
        };
      } else if (expectedChannelId && parsed.channelId !== expectedChannelId) {
        result = {
          status: "ambiguous",
          reason: "channel_page_id_mismatch",
          expectedChannelId,
          channelId: parsed.channelId,
          fetchedAt: new Date().toISOString(),
          source: "youtube_channel_html",
        };
      } else {
        result = {
          status: "resolved",
          channelId: parsed.channelId,
          channelHandle: parsed.channelHandle,
          channelUrl: parsed.channelUrl,
          displayName: parsed.displayName,
          sourceUrl: parsed.sourceUrl,
          fetchedAt: new Date().toISOString(),
          source: "youtube_channel_html",
        };
      }
    } catch (error) {
      result = {
        status: "unresolved",
        reason: sanitizeError(error),
        fetchedAt: new Date().toISOString(),
        source: "youtube_channel_html",
      };
    }
    checkpoint.channels[key] = result;
    if (result.channelId) checkpoint.channels[`id:${result.channelId}`] = result;
    if (result.channelHandle) checkpoint.channels[`handle:${normalizeText(result.channelHandle)}`] = result;
    save();
    return result;
  }
}

function readCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), videos: {}, channels: {} };
  }
  const payload = readJson(filePath);
  return {
    schemaVersion: 1,
    updatedAt: stringValue(payload.updatedAt) || new Date().toISOString(),
    videos: payload.videos && typeof payload.videos === "object" ? payload.videos : {},
    channels: payload.channels && typeof payload.channels === "object" ? payload.channels : {},
  };
}

function parseWatchPage(html, finalUrl = "", expectedVideoId = "") {
  const decoded = decodeHtmlEntities(stringValue(html));
  if (/consent\.youtube\.com/iu.test(finalUrl) || /before you continue to youtube/iu.test(decoded)) {
    return { channelId: "", author: "", reason: "youtube_consent_interstitial" };
  }
  const playerResponse = extractJsonObjectAfterMarkers(decoded, [
    "var ytInitialPlayerResponse = ",
    "ytInitialPlayerResponse = ",
    "window.ytInitialPlayerResponse = ",
  ]);
  const details = playerResponse?.videoDetails;
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer;
  const parsedVideoId = stringValue(details?.videoId || expectedVideoId);
  if (expectedVideoId && parsedVideoId && parsedVideoId !== expectedVideoId) {
    return { channelId: "", author: "", reason: "watch_video_id_mismatch" };
  }
  const channelId = validChannelId(
    details?.channelId
      || microformat?.externalChannelId
      || firstRegex(decoded, /"videoDetails"\s*:\s*\{[\s\S]{0,300000}?"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/u)
      || firstRegex(decoded, /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]{20,})["']/iu),
  );
  const author = stringValue(
    details?.author
      || microformat?.ownerChannelName
      || firstRegex(decoded, /"ownerChannelName"\s*:\s*"([^"]+)"/u),
  );
  return {
    channelId,
    author: unescapeJsonString(author),
    reason: channelId ? "" : playerResponse?.playabilityStatus?.reason || "watch_channel_id_missing",
  };
}

function parseChannelPage(html, finalUrl = "") {
  const decoded = decodeHtmlEntities(stringValue(html));
  if (/consent\.youtube\.com/iu.test(finalUrl) || /before you continue to youtube/iu.test(decoded)) {
    return {
      channelId: "",
      channelHandle: "",
      channelUrl: "",
      displayName: "",
      sourceUrl: "",
      reason: "youtube_consent_interstitial",
    };
  }
  const channelId = validChannelId(
    firstRegex(decoded, /"channelMetadataRenderer"\s*:\s*\{[\s\S]{0,120000}?"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/u)
      || firstRegex(decoded, /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/u)
      || firstRegex(decoded, /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/u)
      || channelIdFromUrl(finalUrl)
      || firstRegex(decoded, /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/u),
  );
  const displayName = unescapeJsonString(
    firstRegex(decoded, /"channelMetadataRenderer"\s*:\s*\{\s*"title"\s*:\s*"([^"]+)"/u)
      || metaContent(decoded, "og:title")
      || firstRegex(decoded, /"pageHeaderRenderer"[\s\S]{0,100000}?"pageTitle"\s*:\s*"([^"]+)"/u),
  );
  const canonicalBaseUrl = unescapeJsonString(
    firstRegex(decoded, /"canonicalBaseUrl"\s*:\s*"([^"]+)"/u)
      || canonicalHref(decoded)
      || metaContent(decoded, "og:url")
      || finalUrl,
  );
  const channelHandle = normalizeHandle(canonicalBaseUrl);
  return {
    channelId,
    channelHandle,
    channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
    displayName,
    sourceUrl: channelHandle ? `https://www.youtube.com${channelHandle}` : channelId ? `https://www.youtube.com/channel/${channelId}` : "",
    reason: channelId ? "" : "channel_id_missing",
  };
}

function extractJsonObjectAfterMarkers(text, markers) {
  for (const marker of markers) {
    let offset = 0;
    while (offset < text.length) {
      const markerIndex = text.indexOf(marker, offset);
      if (markerIndex < 0) break;
      const objectStart = text.indexOf("{", markerIndex + marker.length);
      if (objectStart < 0) break;
      const raw = balancedJsonObject(text, objectStart);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          // Continue to another marker occurrence.
        }
      }
      offset = markerIndex + marker.length;
    }
  }
  return null;
}

function balancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return "";
}

async function fetchJson(url, options) {
  const page = await fetchText(url, options);
  try {
    return JSON.parse(page.text);
  } catch {
    throw new Error(`invalid_json_response status=${page.status}`);
  }
}

async function fetchText(url, { fetchImpl, timeoutMs, retries }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "accept-language": "en-US,en;q=0.8,ja;q=0.6",
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 daily-song-list-channel-identity-audit/1.0",
        },
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`http_${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return {
        text,
        status: response.status,
        finalUrl: response.url || url,
      };
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "AbortError" || error?.retryable === true || /fetch failed|socket|network|timeout/iu.test(String(error?.message || error));
      if (!retryable || attempt >= retries) break;
      await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(sanitizeError(lastError || "request_failed"));
}

function buildReport({ source, records, inventory, results, metadataPayload, options, startedAt }) {
  const highConfidence = results.filter((result) => result.classification === "high-confidence").sort(compareCandidates);
  const deliverableHighConfidence = highConfidence.filter((item) => item.deliveryDisposition !== "excluded_known_positive");
  const ambiguous = results.filter((result) => result.classification === "ambiguous").sort(compareCandidates);
  const unresolved = results.filter((result) => result.classification === "unresolved").sort(compareCandidates);
  const projectedCoverage = projectedCoverageStats(records, highConfidence);
  const deliverableProjectedCoverage = projectedCoverageStats(records, deliverableHighConfidence);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    dryRun: true,
    source: {
      kind: source.kind,
      apiBase: source.apiBase || "",
      input: source.input || "",
      meta: source.meta || {},
    },
    hydrationContract: {
      metadataPath: portablePath(options.metadataPath),
      reusedEntrypoint: "scripts/channel-metadata-cache.js",
      identityFields: ["channelId", "channelHandle", "channelUrl"],
      writeMode: "disabled",
    },
    shard: { index: options.shardIndex, count: options.shardCount },
    summary: {
      sourceRecordCount: records.length,
      missingRecordCount: inventory.summary.missingRecordCount,
      missingAllIdentityCount: inventory.summary.missingAllIdentityCount,
      missingGroupCount: inventory.groups.length,
      selectedGroupCount: results.length,
      highConfidenceCount: highConfidence.length,
      deliverableHighConfidenceCount: deliverableHighConfidence.length,
      ambiguousCount: ambiguous.length,
      unresolvedCount: unresolved.length,
      excludedKnownPositiveCount: highConfidence.filter((item) => item.deliveryDisposition === "excluded_known_positive").length,
      metadataCacheChannelCount: Array.isArray(metadataPayload.channels) ? metadataPayload.channels.length : 0,
      missingOccurrenceCount: inventory.summary.occurrenceCount,
      fieldCoverageBefore: inventory.summary.fieldCoverageBefore,
      projectedCoverageAfterHighConfidence: projectedCoverage,
      projectedCoverageAfterDeliverableHighConfidence: deliverableProjectedCoverage,
    },
    rankings: {
      byVideoCount: inventory.rankings.byVideoCount.slice(0, options.topLimit),
      byOccurrenceCount: inventory.rankings.byOccurrenceCount.slice(0, options.topLimit),
    },
    highConfidence,
    ambiguous,
    unresolved,
  };
}

function projectedCoverageStats(records, highConfidence) {
  const projected = records.map((record) => ({ ...record }));
  const byGroupKey = new Map(highConfidence.map((candidate) => [candidate.groupKey, candidate]));
  for (const record of projected) {
    const candidate = byGroupKey.get(provisionalGroupKey(record));
    if (!candidate?.proposed) continue;
    if (!validChannelId(record.channelId)) record.channelId = candidate.proposed.channelId;
    if (!normalizeHandle(record.channelHandle)) record.channelHandle = candidate.proposed.channelHandle;
    if (!validChannelUrl(record.channelUrl)) record.channelUrl = candidate.proposed.channelUrl;
  }
  return coverageStats(projected);
}

function mergeReports(reports, options = {}) {
  if (!reports.length) throw new Error("No reports supplied for merge");
  const first = reports[0];
  const highConfidence = mergeCandidateList(reports.flatMap((report) => report.highConfidence || []));
  const deliverableHighConfidence = highConfidence.filter((item) => item.deliveryDisposition !== "excluded_known_positive");
  const ambiguous = mergeCandidateList(reports.flatMap((report) => report.ambiguous || []));
  const unresolved = mergeCandidateList(reports.flatMap((report) => report.unresolved || []));
  const selectedGroupCount = highConfidence.length + ambiguous.length + unresolved.length;
  const projectedCoverage = JSON.parse(JSON.stringify(first.summary?.fieldCoverageBefore || { totalRecords: 0, fields: {} }));
  const deliverableProjectedCoverage = JSON.parse(JSON.stringify(first.summary?.fieldCoverageBefore || { totalRecords: 0, fields: {} }));
  for (const [coverage, candidates] of [
    [projectedCoverage, highConfidence],
    [deliverableProjectedCoverage, deliverableHighConfidence],
  ]) {
    for (const field of ["channelId", "channelHandle", "channelUrl"]) {
      const fillCount = candidates.reduce((total, candidate) => total + nonNegativeInt(candidate.missingFieldCounts?.[field]), 0);
      const fieldStats = coverage.fields?.[field];
      if (!fieldStats) continue;
      fieldStats.present = Math.min(coverage.totalRecords, nonNegativeInt(fieldStats.present) + fillCount);
      fieldStats.missing = Math.max(0, coverage.totalRecords - fieldStats.present);
      fieldStats.percent = coverage.totalRecords ? roundPercent(fieldStats.present, coverage.totalRecords) : 100;
    }
  }
  return {
    ...first,
    generatedAt: new Date().toISOString(),
    mergedFrom: reports.map((report) => report.shard),
    shard: { index: 0, count: 1, merged: true },
    summary: {
      ...(first.summary || {}),
      selectedGroupCount,
      highConfidenceCount: highConfidence.length,
      deliverableHighConfidenceCount: deliverableHighConfidence.length,
      ambiguousCount: ambiguous.length,
      unresolvedCount: unresolved.length,
      excludedKnownPositiveCount: highConfidence.filter((item) => item.deliveryDisposition === "excluded_known_positive").length,
      projectedCoverageAfterHighConfidence: projectedCoverage,
      projectedCoverageAfterDeliverableHighConfidence: deliverableProjectedCoverage,
    },
    rankings: {
      byVideoCount: (first.rankings?.byVideoCount || []).slice(0, options.topLimit || 30),
      byOccurrenceCount: (first.rankings?.byOccurrenceCount || []).slice(0, options.topLimit || 30),
    },
    highConfidence,
    ambiguous,
    unresolved,
  };
}

function mergeCandidateList(candidates) {
  const lookup = new Map();
  for (const candidate of candidates) {
    const key = candidate.groupKey;
    const existing = lookup.get(key);
    if (!existing || evidenceScore(candidate) > evidenceScore(existing)) lookup.set(key, candidate);
  }
  return [...lookup.values()].sort(compareCandidates);
}

function evidenceScore(candidate) {
  return (candidate.evidence?.direct?.length || 0) * 10 - (candidate.evidence?.failures?.length || 0);
}

function writeReportFiles(report, options) {
  writeJsonAtomic(options.outputJson, report);
  fs.mkdirSync(path.dirname(options.outputMarkdown), { recursive: true });
  fs.writeFileSync(options.outputMarkdown, renderMarkdown(report, options), "utf8");
}

function renderMarkdown(report, options = {}) {
  const topLimit = options.topLimit || 30;
  const lines = [
    "# Channel identity hydration audit",
    "",
    `- Generated at: \`${report.generatedAt}\``,
    `- Source: \`${report.source?.kind || "unknown"}\``,
    `- Source commit: \`${report.source?.meta?.sourceCommitSha || "n/a"}\``,
    `- Dry-run: \`true\``,
    `- Shard: \`${report.shard?.index ?? 0}/${report.shard?.count ?? 1}\``,
    `- Records: ${report.summary.sourceRecordCount}; missing identity fields: ${report.summary.missingRecordCount}; all three identity fields missing: ${report.summary.missingAllIdentityCount}`,
    `- Candidate groups: high-confidence ${report.highConfidence.length}; ambiguous ${report.ambiguous.length}; unresolved ${report.unresolved.length}; excluded known-positive ${report.summary.excludedKnownPositiveCount}`,
    "",
    "## Field coverage",
    "",
    "| Field | Present before | Missing before | Projected present after all high-confidence | Projected present after deliverable high-confidence |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const field of ["channelId", "channelHandle", "channelUrl"]) {
    const before = report.summary.fieldCoverageBefore?.fields?.[field] || {};
    const after = report.summary.projectedCoverageAfterHighConfidence?.fields?.[field] || {};
    const deliverableAfter = report.summary.projectedCoverageAfterDeliverableHighConfidence?.fields?.[field] || {};
    lines.push(`| ${field} | ${before.present || 0} | ${before.missing || 0} | ${after.present || 0} | ${deliverableAfter.present || 0} |`);
  }

  lines.push("", "## Top missing identities by video count", "");
  lines.push("| Display name | Videos | Occurrences | Missing channelId / handle / url |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const row of (report.rankings?.byVideoCount || []).slice(0, topLimit)) {
    lines.push(
      `| ${markdownCell(row.displayName)} | ${row.videoCount} | ${row.occurrenceCount} | ${row.missingFieldCounts.channelId} / ${row.missingFieldCounts.channelHandle} / ${row.missingFieldCounts.channelUrl} |`,
    );
  }

  appendCandidateTable(lines, "High-confidence candidates", report.highConfidence, topLimit);
  appendCandidateTable(lines, "Ambiguous manual review", report.ambiguous, topLimit);
  appendCandidateTable(lines, "Unresolved", report.unresolved, topLimit);
  lines.push(
    "",
    "## Safety",
    "",
    "- This report is candidate evidence only. The tool has no metadata write/import/deploy mode.",
    "- Display-name-only matches never qualify as high-confidence.",
    "- `excluded_known_positive` rows remain evidence samples and must not be delivered as metadata patches by this run.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function appendCandidateTable(lines, title, candidates, limit) {
  lines.push("", `## ${title}`, "");
  lines.push("| Source names | Videos | Occurrences | Proposed identity | Reason | Disposition |");
  lines.push("| --- | ---: | ---: | --- | --- | --- |");
  for (const candidate of candidates.slice(0, limit)) {
    const proposed = candidate.proposed
      ? [candidate.proposed.displayName, candidate.proposed.channelId, candidate.proposed.channelHandle].filter(Boolean).join(" / ")
      : "";
    lines.push(
      `| ${markdownCell(candidate.sourceNames.join("; "))} | ${candidate.videoCount} | ${candidate.occurrenceCount} | ${markdownCell(proposed)} | ${markdownCell(candidate.confidenceReason)} | ${candidate.deliveryDisposition} |`,
    );
  }
  if (candidates.length > limit) lines.push("", `_JSON contains ${candidates.length - limit} additional rows._`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function checkpointManifest(options, manifest) {
  manifest.updatedAt = new Date().toISOString();
  writeJsonAtomic(options.manifestPath, manifest);
}

function logStage(options, event, details = {}) {
  const payload = {
    at: new Date().toISOString(),
    event,
    ...details,
  };
  fs.mkdirSync(path.dirname(options.stageLogPath), { recursive: true });
  fs.appendFileSync(options.stageLogPath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function mapLimit(values, concurrency, worker) {
  if (!values.length) return [];
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function canonicalHref(html) {
  return unescapeJsonString(
    firstRegex(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/iu)
      || firstRegex(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/iu),
  );
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return unescapeJsonString(
    firstRegex(html, new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "iu"))
      || firstRegex(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "iu")),
  );
}

function firstRegex(text, regex) {
  return text.match(regex)?.[1] || "";
}

function normalizeHandle(value) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/(?:https?:\/\/(?:www\.)?youtube\.com)?(\/?@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  if (!match) return HANDLE_PATTERN.test(text) ? (text.startsWith("/") ? text : `/${text}`) : "";
  const handle = match[1].startsWith("/") ? match[1] : `/${match[1]}`;
  return HANDLE_PATTERN.test(handle) ? handle : "";
}

function handleFromUrl(value) {
  return normalizeHandle(value);
}

function validChannelId(value) {
  const text = stringValue(value);
  return CHANNEL_ID_PATTERN.test(text) ? text : "";
}

function channelIdFromUrl(value) {
  return validChannelId(stringValue(value).match(/youtube\.com\/channel\/([^/?#]+)/iu)?.[1]);
}

function canonicalChannelUrl(value, channelId = "") {
  const id = channelIdFromUrl(value) || validChannelId(channelId);
  return id ? `https://www.youtube.com/channel/${id}` : "";
}

function validChannelUrl(value) {
  const text = stringValue(value);
  if (!/^https?:\/\/(?:www\.)?youtube\.com\//iu.test(text)) return "";
  if (channelIdFromUrl(text)) return text;
  return normalizeHandle(text) ? text : "";
}

function videoIdFromThumbnail(value) {
  return stringValue(value).match(/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//iu)?.[1] || "";
}

function normalizeText(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase();
}

function stringValue(value) {
  return String(value || "").trim();
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(stringValue).filter(Boolean))];
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundPercent(value, total) {
  return Math.round((value / total) * 10_000) / 100;
}

function renamedOrMultilingual(sourceNames, canonicalName) {
  if (!canonicalName || !sourceNames.length) return false;
  const canonical = normalizeText(canonicalName);
  return !sourceNames.some((name) => normalizeText(name) === canonical);
}

function compareGroups(left, right) {
  return right.videoCount - left.videoCount || right.occurrenceCount - left.occurrenceCount || left.groupKey.localeCompare(right.groupKey);
}

function compareCandidates(left, right) {
  return right.videoCount - left.videoCount || right.occurrenceCount - left.occurrenceCount || left.groupKey.localeCompare(right.groupKey);
}

function markdownCell(value) {
  return stringValue(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function portablePath(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative && !relative.startsWith("..") ? relative.replace(/\\/gu, "/") : filePath.replace(/\\/gu, "/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function unescapeJsonString(value) {
  const text = stringValue(value);
  if (!text.includes("\\") && !text.includes("&")) return text;
  try {
    return JSON.parse(`"${text.replace(/"/gu, '\\"')}"`);
  } catch {
    return text.replace(/\\\//gu, "/").replace(/\\u0026/gu, "&");
  }
}

function decodeHtmlEntities(value) {
  return stringValue(value)
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown_error")
    .replace(/https?:\/\/[^\s]+/giu, "<url>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "<ip>")
    .replace(/\b(cookie|authorization|token)=?[^\s]*/giu, "$1=<redacted>")
    .slice(0, 300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_CHANNEL_IDENTITY_AUDIT_ERROR ${sanitizeError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  balancedJsonObject,
  buildMetadataContext,
  buildMissingRankings,
  buildReport,
  classifyGroup,
  createIdentityResolver,
  extractJsonObjectAfterMarkers,
  groupMissingIdentityRecords,
  mergeReports,
  normalizeSourceRecords,
  parseArgs,
  parseChannelPage,
  parseWatchPage,
  provisionalGroupKey,
  renderMarkdown,
  runAudit,
  sanitizeError,
};
