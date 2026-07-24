#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_GROUP = "youtube_channel_discovery";
const DEFAULT_IMPORT_DIR = path.join(ROOT, "data", "external", "youtube-channel-discovery");
const DEFAULT_METADATA_PATH = path.join(DEFAULT_IMPORT_DIR, "channel-metadata.json");
const DEFAULT_RUNTIME_INPUT = path.join(ROOT, "data", "latest.json");
const DEFAULT_CHECKPOINT_PATH = path.join(ROOT, "artifacts", "channel-avatar-cache", "checkpoint.json");
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_DAILY_MAX_FETCH = 60;
const DEFAULT_STALE_DAYS = 30;
const REQUEST_TIMEOUT_MS = 30000;
const PRIORITY_HANDLES = [
  "@kanaruhanon",
  "@noa_polaris",
  "@naretan",
  "@choma",
  "@Sen_44",
  "@HazukiHina",
  "@karakurinne",
  "@Otokado_Ruki",
  "@itk_tks",
  "@YuNivirtualsinger",
  "@SHALOYAMADA-Vsinger",
  "@Stratia113",
  "@irorinaru",
  "@perucia_ten",
  "@suzuna_subaru",
  "@UtagawaLetora",
  "@SuzuhanaInori",
  "@HoshiHo_HsH",
  "@Tamamachi_Pue",
  "@asuyumekanae",
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const importDir = path.resolve(options.importDir || DEFAULT_IMPORT_DIR);
  const acceptedDir = path.join(importDir, "accepted");
  const metadataPath = path.resolve(options.metadataPath || path.join(importDir, "channel-metadata.json"));
  const runtimeInput = path.resolve(options.runtimeInput || DEFAULT_RUNTIME_INPUT);
  const metadata = readMetadata(metadataPath);
  const before = cacheStats(metadata.channels);
  const checkpoint = readCheckpoint(options);
  const candidates = collectCandidates({
    acceptedDir,
    channels: metadata.channels,
    priorityHandles: options.priorityHandles,
    runtimeInput,
    runtimeRange: options.runtimeRange,
    includeRuntime: options.includeRuntime,
  });
  const lookup = buildChannelLookup(metadata.channels);
  const runtimeStatsBefore = runtimeCoverageStats(candidates, lookup);
  const results = [];
  let fetchCount = 0;

  for (const candidate of candidates) {
    const stableKey = candidateKey(candidate);
    const previous = options.resume ? checkpoint.results[stableKey] : null;
    if (previous?.status === "fetched" && !options.refresh) {
      results.push({ ...previous, status: "already_cached", reason: "checkpoint_fetched" });
      continue;
    }

    const existing = findExistingChannel(lookup, candidate);
    const merged = mergeNormalizedChannels(normalizeChannel(existing || {}), candidate);
    const hasFreshAvatar = merged.avatarUrl && !isStale(existing?.avatarFetchedAt || merged.avatarFetchedAt, options.staleDays);
    if (hasFreshAvatar && !options.refresh) {
      if (existing) mergeChannel(existing, candidate, { preserveAvatar: true });
      results.push(resultFor("already_cached", candidate, existing || merged));
      continue;
    }

    const sourceUrl = bestFetchUrl(candidate, existing);
    if (!sourceUrl) {
      const result = resultFor("skipped_collected_evidence", candidate, existing, "missing_channel_url_or_handle");
      results.push(result);
      updateCheckpoint(checkpoint, stableKey, result, options);
      continue;
    }

    if (options.maxFetch >= 0 && fetchCount >= options.maxFetch) {
      const result = resultFor("skipped_collected_evidence", candidate, existing, "batch_limit_reached");
      results.push(result);
      updateCheckpoint(checkpoint, stableKey, result, options);
      continue;
    }

    if (options.dryRun) {
      const reason = hasFreshAvatar ? "dry_run_stale_refresh" : "dry_run_missing_avatar";
      results.push(resultFor("skipped_collected_evidence", candidate, existing || merged, reason));
      continue;
    }

    fetchCount += 1;
    try {
      const fetched = await fetchChannelMetadata(sourceUrl);
      const target = existing || addChannel(metadata.channels, lookup, candidate);
      mergeChannel(target, { ...candidate, ...fetched, sourceUrl }, { preserveAvatar: false });
      target.avatarFetchedAt = new Date().toISOString();
      target.avatarFetchStatus = "fetched";
      const result = resultFor("fetched", candidate, target);
      results.push(result);
      updateCheckpoint(checkpoint, stableKey, result, options);
    } catch (error) {
      if (existing) {
        mergeChannel(existing, candidate, { preserveAvatar: true });
        existing.avatarFetchStatus = "failed";
        existing.avatarFetchError = error.message || String(error);
      }
      const result = resultFor("failed", candidate, existing || candidate, error.message || String(error));
      results.push(result);
      updateCheckpoint(checkpoint, stableKey, result, options);
    }
    await sleep(options.delayMs);
  }

  normalizeMetadata(metadata, results, options, { runtimeStatsBefore, candidates });
  const after = cacheStats(metadata.channels);
  const runtimeStatsAfter = runtimeCoverageStats(candidates, buildChannelLookup(metadata.channels));
  if (!options.dryRun) {
    writeJson(metadataPath, metadata);
    writeCheckpoint(checkpoint, options);
  }
  printSummary({
    before,
    after,
    runtimeStatsBefore,
    runtimeStatsAfter,
    candidates,
    results,
    metadataPath,
    checkpointPath: options.checkpointPath,
    dryRun: options.dryRun,
    maxFetch: options.maxFetch,
  });
  if (options.requireDisplayImage && runtimeStatsAfter.missingDisplayImage > 0) {
    console.error(`CODEX_CHANNEL_AVATAR_DISPLAY_IMAGE_ERROR missingDisplayImage=${runtimeStatsAfter.missingDisplayImage}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const daily = args.includes("--daily");
  const options = {
    importDir: "",
    metadataPath: "",
    runtimeInput: DEFAULT_RUNTIME_INPUT,
    runtimeRange: "all",
    checkpointPath: DEFAULT_CHECKPOINT_PATH,
    delayMs: envInt("DAILY_SONG_CHANNEL_AVATAR_DELAY_MS", DEFAULT_DELAY_MS),
    maxFetch: -1,
    staleDays: DEFAULT_STALE_DAYS,
    refresh: false,
    dryRun: false,
    daily,
    resume: true,
    resetCheckpoint: false,
    requireDisplayImage: daily,
    includeRuntime: true,
    priorityHandles: [...PRIORITY_HANDLES],
  };
  if (daily) {
    options.maxFetch = envInt("DAILY_SONG_CHANNEL_AVATAR_MAX_FETCH", DEFAULT_DAILY_MAX_FETCH);
    options.delayMs = envInt("DAILY_SONG_CHANNEL_AVATAR_DELAY_MS", DEFAULT_DELAY_MS);
    options.staleDays = envInt("DAILY_SONG_CHANNEL_AVATAR_STALE_DAYS", DEFAULT_STALE_DAYS);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--daily") {
      options.daily = true;
    } else if (arg === "--import-dir") {
      options.importDir = requiredValue(args, ++index, arg);
    } else if (arg === "--metadata") {
      options.metadataPath = requiredValue(args, ++index, arg);
    } else if (arg === "--runtime-input") {
      options.runtimeInput = requiredValue(args, ++index, arg);
    } else if (arg === "--runtime-range") {
      options.runtimeRange = requiredValue(args, ++index, arg);
    } else if (arg === "--checkpoint") {
      options.checkpointPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--delay-ms") {
      options.delayMs = Math.max(0, Number.parseInt(requiredValue(args, ++index, arg), 10) || 0);
    } else if (arg === "--max-fetch" || arg === "--limit") {
      options.maxFetch = Math.max(0, Number.parseInt(requiredValue(args, ++index, arg), 10) || 0);
    } else if (arg === "--stale-days") {
      options.staleDays = Math.max(0, Number.parseInt(requiredValue(args, ++index, arg), 10) || 0);
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--priority-handle") {
      options.priorityHandles.push(requiredValue(args, ++index, arg));
    } else if (arg === "--no-default-priority") {
      options.priorityHandles = [];
    } else if (arg === "--no-runtime") {
      options.includeRuntime = false;
    } else if (arg === "--no-resume") {
      options.resume = false;
    } else if (arg === "--reset-checkpoint") {
      options.resetCheckpoint = true;
    } else if (arg === "--require-display-image") {
      options.requireDisplayImage = true;
    } else if (arg === "--no-require-display-image") {
      options.requireDisplayImage = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: 1,
      sourceSystem: SOURCE_GROUP,
      generatedAt: "",
      source: {
        kind: "youtube_public_channel_page",
        fetchedAt: "",
        note: "Low-rate public channel-page metadata cache for runtime VTuber channels.",
      },
      channels: [],
    };
  }
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    schemaVersion: Number(payload.schemaVersion) || 1,
    sourceSystem: payload.sourceSystem || SOURCE_GROUP,
    generatedAt: stringValue(payload.generatedAt),
    source: typeof payload.source === "object" && payload.source ? payload.source : {},
    channels: Array.isArray(payload.channels) ? payload.channels : [],
    avatarFetchReport: typeof payload.avatarFetchReport === "object" && payload.avatarFetchReport ? payload.avatarFetchReport : {},
  };
}

function readCheckpoint(options) {
  if (options.resetCheckpoint || !fs.existsSync(options.checkpointPath)) {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), results: {} };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(options.checkpointPath, "utf8"));
    return {
      schemaVersion: 1,
      generatedAt: stringValue(payload.generatedAt) || new Date().toISOString(),
      results: typeof payload.results === "object" && payload.results ? payload.results : {},
    };
  } catch {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), results: {} };
  }
}

function collectCandidates({ acceptedDir, channels, priorityHandles, runtimeInput, runtimeRange, includeRuntime }) {
  const candidates = [];
  if (includeRuntime) addRuntimeCandidates(candidates, runtimeInput, runtimeRange);
  for (const channel of channels || []) {
    addCandidate(candidates, {
      displayName: channel.displayName || channel.channelName || channel.name,
      channelId: channel.channelId,
      channelHandle: channel.handle || channel.channelHandle,
      channelUrl: channel.channelUrl,
      sourceUrl: channel.sourceUrl || channel.channelUrl,
      avatarUrl: channel.avatarUrl,
      thumbnailUrl: channel.thumbnailUrl || channel.videoThumbnailUrl,
      avatarFetchedAt: channel.avatarFetchedAt,
      evidence: ["channel-metadata.json"],
    });
  }
  for (const handle of priorityHandles || []) {
    addCandidate(candidates, {
      channelHandle: normalizeHandle(handle),
      sourceUrl: handleToUrl(handle),
      evidence: ["priority-handle-list"],
    });
  }
  if (fs.existsSync(acceptedDir)) {
    for (const file of fs.readdirSync(acceptedDir).filter((name) => name.endsWith(".json")).sort()) {
      const filePath = path.join(acceptedDir, file);
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const videos = Array.isArray(payload) ? payload : payload.videos;
      if (!Array.isArray(videos)) continue;
      for (const video of videos) {
        const sourceUrls = Array.isArray(video.sourceUrls) ? video.sourceUrls : [];
        addCandidate(candidates, {
          displayName: video.channelName,
          channelId: video.channelId,
          channelHandle: video.channelHandle || handleFromUrl(video.channelUrl) || handleFromUrl(video.discoveryImport?.discoveryChannelUrl),
          channelUrl: video.channelUrl,
          sourceUrl:
            video.sourceUrl ||
            video.channelUrl ||
            video.discoveryImport?.discoveryChannelUrl ||
            sourceUrls.find((url) => /youtube\.com\/(?:@|channel\/)/iu.test(String(url))),
          avatarUrl: video.avatarUrl || video.channelAvatarUrl,
          thumbnailUrl: thumbnailUrlForVideo(video),
          evidence: [`accepted/${file}`],
        });
      }
    }
  }
  return candidates;
}

function addRuntimeCandidates(candidates, runtimeInput, runtimeRange) {
  if (!fs.existsSync(runtimeInput)) return;
  const payload = JSON.parse(fs.readFileSync(runtimeInput, "utf8"));
  const group = runtimeGroup(payload, runtimeRange);
  const items = Array.isArray(group?.items) ? group.items : [];
  for (const item of items) {
    if (!Array.isArray(item.songs) || !item.songs.some((song) => stringValue(song?.title))) continue;
    addCandidate(candidates, {
      displayName: item.channelName,
      channelId: item.channelId,
      channelHandle: item.channelHandle || handleFromUrl(item.channelUrl || item.authorUrl || item.ownerUrl),
      channelUrl: item.channelUrl || item.authorUrl || item.ownerUrl,
      sourceUrl: item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl,
      avatarUrl: item.avatarUrl || item.channelAvatarUrl,
      thumbnailUrl: thumbnailUrlForVideo(item),
      evidence: [`runtime:${path.relative(ROOT, runtimeInput).replace(/\\/g, "/")}#${runtimeRange}`],
      runtimeCandidate: true,
    });
  }
}

function runtimeGroup(payload, rangeId) {
  const groups = payload?.groups || {};
  return groups[rangeId] || groups[String(rangeId).toUpperCase()] || groups.all || groups["7d"] || null;
}

function addCandidate(candidates, candidate) {
  const normalized = normalizeChannel(candidate);
  const key = candidateKey(normalized);
  if (!key) return;
  const existing = candidates.find((item) => candidateKey(item) === key || shareIdentity(item, normalized));
  if (existing) {
    mergeChannel(existing, normalized, { preserveAvatar: true });
    existing.evidence = uniqueValues([...(existing.evidence || []), ...(normalized.evidence || [])]);
    existing.runtimeCandidate = existing.runtimeCandidate === true || normalized.runtimeCandidate === true;
  } else {
    candidates.push(normalized);
  }
}

function buildChannelLookup(channels) {
  const lookup = new Map();
  for (const channel of channels || []) {
    const normalized = normalizeChannel(channel);
    for (const key of identityKeys(normalized)) lookup.set(key, channel);
  }
  return lookup;
}

function findExistingChannel(lookup, candidate) {
  for (const key of identityKeys(candidate)) {
    const existing = lookup.get(key);
    if (existing) return existing;
  }
  return null;
}

function addChannel(channels, lookup, candidate) {
  const channel = {};
  mergeChannel(channel, candidate, { preserveAvatar: false });
  channels.push(channel);
  for (const key of identityKeys(normalizeChannel(channel))) lookup.set(key, channel);
  return channel;
}

function mergeChannel(target, incoming, options = {}) {
  const normalized = normalizeChannel(incoming);
  const assignments = [
    ["handle", normalized.channelHandle],
    ["displayName", normalized.displayName],
    ["channelId", normalized.channelId],
    ["channelUrl", normalized.channelUrl],
    ["sourceUrl", normalized.sourceUrl],
    ["thumbnailUrl", normalized.thumbnailUrl],
    ["avatarFetchedAt", normalized.avatarFetchedAt],
  ];
  for (const [key, value] of assignments) {
    if (!target[key] && value) target[key] = value;
  }
  if (!options.preserveAvatar && normalized.avatarUrl) target.avatarUrl = normalized.avatarUrl;
  if (!target.avatarUrl && normalized.avatarUrl) target.avatarUrl = normalized.avatarUrl;
  return target;
}

async function fetchChannelMetadata(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept-language": "ja,en-US;q=0.8,en;q=0.6",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const html = await response.text();
    const metadata = parseChannelPage(html, response.url || url);
    if (!metadata.avatarUrl) throw new Error("missing_avatar_url");
    return metadata;
  } finally {
    clearTimeout(timeout);
  }
}

function parseChannelPage(html, finalUrl) {
  const decoded = decodeHtmlEntities(html);
  const avatarUrl = firstNonEmpty(
    matchJsonString(decoded, /"avatar"\s*:\s*\{\s*"thumbnails"\s*:\s*\[\s*\{\s*"url"\s*:\s*"([^"]+)"/u),
    matchJsonString(decoded, /"width"\s*:\s*900\s*,\s*"height"\s*:\s*900\s*\}\s*\]\s*\}\s*,\s*"banner"/u, true),
    matchMeta(decoded, "og:image"),
    matchLink(decoded, "image_src"),
  );
  const channelId = firstNonEmpty(
    matchJsonString(decoded, /"externalId"\s*:\s*"([^"]+)"/u),
    matchJsonString(decoded, /"channelId"\s*:\s*"(UC[^"]+)"/u),
    finalUrl.match(/youtube\.com\/channel\/([^/?#]+)/iu)?.[1],
    decoded.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/u)?.[1],
  );
  const displayName = firstNonEmpty(
    matchJsonString(decoded, /"channelMetadataRenderer"\s*:\s*\{\s*"title"\s*:\s*"([^"]+)"/u),
    matchMeta(decoded, "og:title"),
    matchJsonString(decoded, /"title"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/u),
  );
  const handle = normalizeHandle(firstNonEmpty(matchJsonString(decoded, /"canonicalBaseUrl"\s*:\s*"([^"]+)"/u), handleFromUrl(finalUrl)));
  const channelUrl = channelId ? `https://www.youtube.com/channel/${channelId}` : "";
  return {
    displayName,
    channelId,
    channelHandle: handle,
    channelUrl,
    sourceUrl: handle ? handleToUrl(handle) : finalUrl,
    avatarUrl: cleanAvatarUrl(avatarUrl),
  };
}

function matchJsonString(text, regex, previousString = false) {
  const match = text.match(regex);
  if (!match) return "";
  if (!previousString) return unescapeJsonString(match[1] || "");
  const before = text.slice(Math.max(0, match.index - 500), match.index);
  const strings = [...before.matchAll(/"url"\s*:\s*"([^"]+)"/gu)].map((item) => item[1]);
  return unescapeJsonString(strings.at(-1) || "");
}

function matchMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "iu"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "iu"),
  ];
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match) return match[1];
  }
  return "";
}

function matchLink(html, rel) {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexes = [
    new RegExp(`<link[^>]+rel=["']${escaped}["'][^>]+href=["']([^"']+)["']`, "iu"),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${escaped}["']`, "iu"),
  ];
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match) return match[1];
  }
  return "";
}

function normalizeMetadata(metadata, results, options, context) {
  metadata.schemaVersion = 1;
  metadata.sourceSystem = SOURCE_GROUP;
  metadata.generatedAt = new Date().toISOString();
  metadata.source = {
    ...(metadata.source || {}),
    kind: "youtube_public_channel_page",
    fetchedAt: metadata.generatedAt,
    note: "Low-rate public channel-page metadata cache for runtime VTuber channels. avatarUrl is a real channel avatar; thumbnailUrl is display fallback only.",
  };
  const channels = metadata.channels.map((channel) => {
    const normalized = normalizeChannel(channel);
    const result = {
      handle: normalized.channelHandle,
      displayName: normalized.displayName,
      channelId: normalized.channelId,
      channelUrl: normalized.channelUrl,
      sourceUrl: normalized.sourceUrl,
      avatarUrl: normalized.avatarUrl,
      thumbnailUrl: normalized.thumbnailUrl,
    };
    if (normalized.avatarFetchedAt) result.avatarFetchedAt = normalized.avatarFetchedAt;
    if (channel.avatarFetchStatus) result.avatarFetchStatus = stringValue(channel.avatarFetchStatus);
    if (channel.avatarFetchError) result.avatarFetchError = stringValue(channel.avatarFetchError).slice(0, 300);
    return result;
  });
  channels.sort((left, right) => {
    const leftKey = (left.handle || left.channelId || left.displayName || "").toLocaleLowerCase();
    const rightKey = (right.handle || right.channelId || right.displayName || "").toLocaleLowerCase();
    return leftKey.localeCompare(rightKey);
  });
  metadata.channels = channels;
  metadata.avatarFetchReport = {
    generatedAt: metadata.generatedAt,
    dryRun: Boolean(options.dryRun),
    daily: Boolean(options.daily),
    delayMs: options.delayMs,
    maxFetch: options.maxFetch,
    staleDays: options.staleDays,
    runtimeRange: options.runtimeRange,
    runtimeCoverageBefore: context.runtimeStatsBefore,
    runtimeCoverageTarget: "missingDisplayImage=0; realAvatar counts only real YouTube channel avatars",
    counts: countStatuses(results),
    failures: results
      .filter((result) => result.status === "failed")
      .map(({ handle, channelId, displayName, sourceUrl, reason }) => ({ handle, channelId, displayName, sourceUrl, reason })),
    skippedSummary: countBy(results.filter((result) => result.status === "skipped_collected_evidence").map((result) => result.reason || "unknown")),
    skippedSamples: results
      .filter((result) => result.status === "skipped_collected_evidence")
      .slice(0, 25)
      .map(({ handle, channelId, displayName, sourceUrl, reason }) => ({ handle, channelId, displayName, sourceUrl, reason })),
  };
}

function printSummary({ before, after, runtimeStatsBefore, runtimeStatsAfter, candidates, results, metadataPath, checkpointPath, dryRun, maxFetch }) {
  const counts = countStatuses(results);
  const failed = results.filter((result) => result.status === "failed");
  const skippedReasons = countBy(results.filter((result) => result.status === "skipped_collected_evidence").map((result) => result.reason || "unknown"));
  const evidence = results
    .filter((result) => result.avatarUrl)
    .slice(0, 10)
    .map((result) => ({
      handle: result.handle,
      channelId: result.channelId,
      sourceUrl: result.sourceUrl,
      avatarUrl: result.avatarUrl,
      thumbnailUrl: result.thumbnailUrl,
      status: result.status,
    }));
  console.log(
    [
      `CODEX_CHANNEL_AVATAR_CACHE_OK metadata=${metadataPath}`,
      `checkpoint=${checkpointPath}`,
      `dryRun=${dryRun ? "true" : "false"}`,
      `candidates=${candidates.length}`,
      `runtimeChannels=${runtimeStatsAfter.totalChannels}`,
      `runtimeParseable=${runtimeStatsAfter.parseableChannels}`,
      `runtimeRealAvatarBefore=${runtimeStatsBefore.realAvatar}`,
      `runtimeRealAvatarAfter=${runtimeStatsAfter.realAvatar}`,
      `thumbnailFallbackBefore=${runtimeStatsBefore.thumbnailFallback}`,
      `thumbnailFallbackAfter=${runtimeStatsAfter.thumbnailFallback}`,
      `missingDisplayImageBefore=${runtimeStatsBefore.missingDisplayImage}`,
      `missingDisplayImageAfter=${runtimeStatsAfter.missingDisplayImage}`,
      `cacheBeforeAvatar=${before.withAvatar}`,
      `cacheAfterAvatar=${after.withAvatar}`,
      `maxFetch=${maxFetch}`,
      `fetched=${counts.fetched || 0}`,
      `alreadyCached=${counts.already_cached || 0}`,
      `skipped=${counts.skipped_collected_evidence || 0}`,
      `failed=${counts.failed || 0}`,
    ].join(" "),
  );
  console.log(
    JSON.stringify(
      {
        counts,
        skippedReasons,
        failed,
        evidence,
        runtimeStatsBefore,
        runtimeStatsAfter,
        missingDisplayImage: runtimeStatsAfter.missingDisplayImageChannels,
      },
      null,
      2,
    ),
  );
}

function countStatuses(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

function resultFor(status, candidate, channel, reason = "") {
  const normalized = normalizeChannel(channel || candidate);
  return {
    status,
    handle: normalized.channelHandle,
    channelId: normalized.channelId,
    displayName: normalized.displayName,
    sourceUrl: normalized.sourceUrl || bestFetchUrl(candidate, channel),
    avatarUrl: normalized.avatarUrl,
    thumbnailUrl: normalized.thumbnailUrl,
    reason,
    updatedAt: new Date().toISOString(),
  };
}

function cacheStats(channels) {
  const total = Array.isArray(channels) ? channels.length : 0;
  const withAvatar = (channels || []).filter((channel) => cleanAvatarUrl(channel.avatarUrl)).length;
  return { total, withAvatar, missingAvatar: total - withAvatar };
}

function runtimeCoverageStats(candidates, lookup) {
  const runtimeCandidates = candidates.filter((candidate) => candidate.runtimeCandidate);
  const stats = {
    totalChannels: runtimeCandidates.length,
    parseableChannels: 0,
    realAvatar: 0,
    thumbnailFallback: 0,
    missingDisplayImage: 0,
    missingAvatar: 0,
    missingDisplayImageChannels: [],
  };
  for (const candidate of runtimeCandidates) {
    const existing = findExistingChannel(lookup, candidate);
    const merged = mergeNormalizedChannels(normalizeChannel(existing || {}), candidate);
    if (isParseableChannel(merged)) stats.parseableChannels += 1;
    if (merged.avatarUrl) {
      stats.realAvatar += 1;
    } else if (merged.thumbnailUrl) {
      stats.thumbnailFallback += 1;
      stats.missingAvatar += 1;
    } else {
      stats.missingDisplayImage += 1;
      stats.missingAvatar += 1;
      stats.missingDisplayImageChannels.push({
        handle: merged.channelHandle,
        channelId: merged.channelId,
        displayName: merged.displayName,
        sourceUrl: merged.sourceUrl,
        reason: "missing_real_avatar_and_thumbnail",
      });
    }
  }
  return stats;
}

function bestFetchUrl(candidate, existing) {
  const normalized = mergeNormalizedChannels(normalizeChannel(candidate), normalizeChannel(existing || {}));
  return firstNonEmpty(
    normalized.sourceUrl,
    normalized.channelHandle && handleToUrl(normalized.channelHandle),
    normalized.channelUrl,
    normalized.channelId && `https://www.youtube.com/channel/${normalized.channelId}`,
  );
}

function mergeNormalizedChannels(primary, fallback) {
  return {
    displayName: primary.displayName || fallback.displayName,
    channelId: primary.channelId || fallback.channelId,
    channelHandle: primary.channelHandle || fallback.channelHandle,
    channelUrl: primary.channelUrl || fallback.channelUrl,
    sourceUrl: primary.sourceUrl || fallback.sourceUrl,
    avatarUrl: primary.avatarUrl || fallback.avatarUrl,
    thumbnailUrl: primary.thumbnailUrl || fallback.thumbnailUrl,
    avatarFetchedAt: primary.avatarFetchedAt || fallback.avatarFetchedAt,
    runtimeCandidate: primary.runtimeCandidate === true || fallback.runtimeCandidate === true,
    evidence: uniqueValues([...(primary.evidence || []), ...(fallback.evidence || [])]),
  };
}

function normalizeChannel(value = {}) {
  const sourceUrl = stringValue(value.sourceUrl || value.channelUrl || value.authorUrl || value.ownerUrl);
  const channelHandle = normalizeHandle(value.handle || value.channelHandle || handleFromUrl(sourceUrl));
  const channelId = stringValue(value.channelId);
  const channelUrl = stringValue(value.channelUrl) || (channelId ? `https://www.youtube.com/channel/${channelId}` : "");
  return {
    displayName: stringValue(value.displayName || value.channelName || value.name),
    channelId,
    channelHandle,
    channelUrl,
    sourceUrl: sourceUrl || (channelHandle ? handleToUrl(channelHandle) : channelUrl),
    avatarUrl: cleanAvatarUrl(value.avatarUrl || value.channelAvatarUrl || value.authorAvatarUrl || value.profileImageUrl),
    thumbnailUrl: cleanImageUrl(value.thumbnailUrl || value.videoThumbnail || value.videoThumbnailUrl || value.thumbnail),
    avatarFetchedAt: stringValue(value.avatarFetchedAt),
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    runtimeCandidate: value.runtimeCandidate === true,
  };
}

function isParseableChannel(channel) {
  return Boolean(channel.channelId || channel.channelHandle || channelUrlIsFetchable(channel.channelUrl) || channelUrlIsFetchable(channel.sourceUrl));
}

function channelUrlIsFetchable(value) {
  return /youtube\.com\/(?:@|channel\/)/iu.test(stringValue(value));
}

function identityKeys(channel) {
  return uniqueValues([
    channel.channelId && `id:${channel.channelId}`,
    channel.channelHandle && `handle:${channel.channelHandle.toLocaleLowerCase()}`,
    channel.sourceUrl && `url:${normalizeUrlKey(channel.sourceUrl)}`,
    channel.channelUrl && `url:${normalizeUrlKey(channel.channelUrl)}`,
    channel.displayName && `name:${normalizeTextKey(channel.displayName)}`,
  ]);
}

function candidateKey(channel) {
  return identityKeys(channel)[0] || "";
}

function shareIdentity(left, right) {
  const keys = new Set(identityKeys(left));
  return identityKeys(right).some((key) => keys.has(key));
}

function normalizeUrlKey(value) {
  const text = stringValue(value).replace(/^http:\/\/www\./iu, "https://www.").replace(/^http:\/\//iu, "https://");
  const handle = normalizeHandle(text);
  if (handle) return handle.toLocaleLowerCase();
  const channelId = text.match(/youtube\.com\/channel\/([^/?#]+)/iu)?.[1] || "";
  return channelId ? `channel/${channelId}`.toLocaleLowerCase() : text.toLocaleLowerCase();
}

function normalizeHandle(value) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/(?:youtube\.com\/)?(@[A-Za-z0-9._-]+)/iu);
  if (match) return `/${match[1]}`;
  if (text.startsWith("@")) return `/${text}`;
  if (text.startsWith("/@")) return text;
  return "";
}

function handleFromUrl(value) {
  const text = stringValue(value);
  const match = text.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/iu);
  return match ? `/${match[1]}` : "";
}

function handleToUrl(value) {
  const handle = normalizeHandle(value);
  return handle ? `https://www.youtube.com${handle}` : "";
}

function thumbnailUrlForVideo(item) {
  const explicit = cleanImageUrl(item.thumbnailUrl || item.thumbnail || item.videoThumbnail || item.videoThumbnailUrl);
  if (explicit) return explicit;
  const videoId = stringValue(item.videoId);
  return /^[A-Za-z0-9_-]{11}$/u.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function cleanAvatarUrl(value) {
  const text = unescapeJsonString(stringValue(value)).replace(/\\u0026/gu, "&");
  if (!/^https:\/\/yt3\.googleusercontent\.com\//iu.test(text) && !/^https:\/\/yt[0-9]\.ggpht\.com\//iu.test(text)) {
    return "";
  }
  return text.replace(/=s\d+(-c-k-c0x00ffffff-no-rj)?$/u, "=s900-c-k-c0x00ffffff-no-rj");
}

function cleanImageUrl(value) {
  const text = unescapeJsonString(stringValue(value)).replace(/\\u0026/gu, "&");
  if (!/^https?:\/\//iu.test(text)) return "";
  if (/^data:image\//iu.test(text)) return "";
  return text;
}

function isStale(value, staleDays) {
  if (!staleDays) return false;
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed > staleDays * 24 * 60 * 60 * 1000;
}

function updateCheckpoint(checkpoint, key, result, options) {
  if (!key || options.dryRun) return;
  checkpoint.generatedAt = new Date().toISOString();
  checkpoint.results[key] = result;
  writeCheckpoint(checkpoint, options);
}

function writeCheckpoint(checkpoint, options) {
  if (options.dryRun) return;
  writeJson(options.checkpointPath, checkpoint);
}

function firstNonEmpty(...values) {
  return values.map(stringValue).find(Boolean) || "";
}

function uniqueValues(values) {
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function stringValue(value) {
  return String(value || "").trim();
}

function normalizeTextKey(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase();
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

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(`CODEX_CHANNEL_AVATAR_CACHE_ERROR ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
