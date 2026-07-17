const fs = require("node:fs");
const path = require("node:path");
const { extractSearchItems } = require("./update-songlist");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts", "diagnostics");

async function main() {
  const args = process.argv.slice(2);
  const videoId = args.find((arg) => /^[A-Za-z0-9_-]{11}$/u.test(arg));
  const forceInspect = args.includes("--force-inspect");
  if (!videoId) throw new Error("Usage: npm run diagnose:video -- <YouTube videoId> [--force-inspect]");
  const outDir = path.join(ARTIFACTS_DIR, videoId);
  fs.mkdirSync(outDir, { recursive: true });

  const searchRenderers = await diagnoseSearchRenderers(videoId);
  const watchSummary = await diagnoseWatchPage(videoId);
  const local = diagnoseLocalData(videoId);
  const diagnostic = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    videoId,
    forceInspect,
    firstFailureStage: firstFailureStage(local, watchSummary, searchRenderers),
    searchRenderers: summarizeSearchRenderers(searchRenderers),
    watchPage: watchSummary.summary,
    presence: local.presence,
    exclusion: local.exclusion,
    final: {
      inCatalog: local.presence.permanentCatalog,
      inAll: local.presence.all,
      in7d: local.presence["7d"],
      inRuntimeRangeShard: local.presence.runtimeRangeShard,
      inSourceDetailShard: local.presence.sourceDetailShard,
      inSearchShard: local.presence.searchShard,
      songCount: local.parsedSongs.length,
    },
  };

  writeJson(path.join(outDir, "diagnostic.json"), diagnostic);
  writeJson(path.join(outDir, "search-renderers.json"), searchRenderers);
  writeJson(path.join(outDir, "watch-page-summary.json"), watchSummary);
  writeJson(path.join(outDir, "source-candidates.json"), local.sourceCandidates);
  writeJson(path.join(outDir, "parsed-songs.json"), local.parsedSongs);
  writeJson(path.join(outDir, "rejected-songs.json"), local.rejectedSongs);
  fs.writeFileSync(path.join(outDir, "diagnostic.md"), diagnosticMarkdown(diagnostic, local), "utf8");
  console.log(`DIAGNOSE_VIDEO_OK videoId=${videoId} firstFailureStage=${diagnostic.firstFailureStage} songs=${local.parsedSongs.length}`);
}

async function diagnoseSearchRenderers(videoId) {
  const result = {
    fetchedAt: new Date().toISOString(),
    queryUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(videoId)}&hl=ja&persist_hl=1`,
    rendererTypes: {},
    extractedCandidates: [],
    error: "",
  };
  try {
    const html = await fetchText(result.queryUrl);
    const initialData = extractJsonAfter(html, "ytInitialData");
    for (const node of walkDicts(initialData)) {
      for (const key of ["videoRenderer", "reelItemRenderer", "shortsLockupViewModel", "richItemRenderer", "lockupViewModel", "compactVideoRenderer"]) {
        if (node[key]) result.rendererTypes[key] = (result.rendererTypes[key] || 0) + 1;
      }
    }
    result.extractedCandidates = extractSearchItems(initialData).filter((item) => item.videoId === videoId || item.title || item.sourceRendererType);
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function diagnoseWatchPage(videoId) {
  const result = {
    fetchedAt: new Date().toISOString(),
    watchUrl: `https://www.youtube.com/watch?v=${videoId}&hl=ja&persist_hl=1`,
    summary: {
      ok: false,
      title: "",
      descriptionCandidateCount: 0,
      hasCommentContinuation: false,
      timestampLineCount: 0,
    },
    error: "",
  };
  try {
    const html = await fetchText(result.watchUrl);
    const initialData = extractJsonAfter(html, "ytInitialData");
    const descriptionTexts = [];
    for (const item of walkDicts(initialData)) {
      if (typeof item.simpleText === "string" && looksTimestampLike(item.simpleText)) descriptionTexts.push(item.simpleText);
      if (Array.isArray(item.runs)) {
        const joined = item.runs.map((run) => run?.text || "").join("");
        if (looksTimestampLike(joined)) descriptionTexts.push(joined);
      }
    }
    result.summary = {
      ok: true,
      title: extractRegex(html, /<title>([^<]+)/u).replace(/ - YouTube$/u, ""),
      descriptionCandidateCount: new Set(descriptionTexts).size,
      hasCommentContinuation: /continuationCommand/u.test(html) && /comment|コメント/iu.test(html),
      timestampLineCount: descriptionTexts.join("\n").split(/\n/u).filter(looksTimestampLike).length,
    };
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function diagnoseLocalData(videoId) {
  const latest = readJson(path.join(DATA_DIR, "latest.json"));
  const all = readJson(path.join(DATA_DIR, "all.json"));
  const recent = readJson(path.join(DATA_DIR, "7d.json"));
  const catalog = readJson(path.join(DATA_DIR, "video-catalog.json"));
  const audit = readJson(path.join(DATA_DIR, "audit.json"));
  const inspectionCache = readJson(path.join(DATA_DIR, "inspection-cache.json"));
  const catalogEntry = findVideo(catalog?.videos, videoId);
  const latestAllEntry = findVideo(latest?.groups?.all?.items, videoId);
  const latest7dEntry = findVideo(latest?.groups?.["7d"]?.items, videoId);
  const auditEntry = findVideo(audit?.videos, videoId);
  const cacheEntry = findVideo(inspectionCache?.videos, videoId);
  return {
    presence: {
      youtubeTodaySearch: hasSourceGroup(catalogEntry, "today"),
      youtubeMonthSearch: hasSourceGroup(catalogEntry, "month"),
      mygitTodaySnapshot: hasSourceGroup(catalogEntry, "mygit_today_snapshot"),
      historicalMygitSnapshot: hasSourceGroup(catalogEntry, "mygit_today_snapshot"),
      permanentCatalog: Boolean(catalogEntry),
      inspectionCache: Boolean(cacheEntry),
      latestPayload: Boolean(latestAllEntry || latest7dEntry),
      "7d": Boolean(findVideo(recent?.items, videoId) || latest7dEntry),
      all: Boolean(findVideo(all?.items, videoId) || latestAllEntry),
      runtimeRangeShard: scanJsonDirForVideo(path.join(DATA_DIR, "ui", "ranges"), videoId),
      sourceDetailShard: scanJsonDirForVideo(path.join(DATA_DIR, "ui", "source-details"), videoId),
      searchShard: scanJsonDirForVideo(path.join(DATA_DIR, "ui", "search"), videoId),
    },
    exclusion: {
      skippedByInspectionCache: Boolean(cacheEntry),
      inspectionCacheResult: cacheEntry?.result || "",
      latestAuditResult: auditEntry?.result || "",
      blocklist: false,
      manualReject: /manual_reject/u.test(JSON.stringify(auditEntry || {})),
    },
    sourceCandidates: [catalogEntry, latest7dEntry, latestAllEntry, auditEntry].filter(Boolean).map(compactVideoSource),
    parsedSongs: (catalogEntry?.songs || latestAllEntry?.songs || latest7dEntry?.songs || []).map((song) => ({
      time: song.time,
      seconds: song.seconds,
      title: song.title,
      artist: song.artist,
      sourceId: song.sourceId || "",
      sourceHash: song.sourceHash || "",
      rawHash: song.rawHash || "",
      identificationSource: song.identificationSource || "",
      confidence: song.confidence ?? null,
    })),
    rejectedSongs: listRejected(auditEntry),
  };
}

function firstFailureStage(local, watchSummary, searchRenderers) {
  if (local.presence.permanentCatalog && local.presence.all && local.presence.runtimeRangeShard && local.presence.searchShard) {
    return "no_failure_currently_recorded";
  }
  if (!searchRenderers.extractedCandidates?.some((item) => item.videoId)) return "candidate_not_discovered";
  if (!local.presence.permanentCatalog && local.exclusion.skippedByInspectionCache) return "skipped_by_inspection_cache";
  if (!watchSummary.summary.ok) return "watch_fetch_failed";
  if (!watchSummary.summary.timestampLineCount) return "no_timestamp_candidates";
  if (!local.parsedSongs.length) return "no_usable_song_source";
  if (!local.presence.permanentCatalog) return "catalog_write_missing";
  if (!local.presence.runtimeRangeShard) return "runtime_shard_missing";
  return "unknown";
}

function compactVideoSource(entry) {
  return {
    videoId: entry.videoId,
    title: entry.title,
    channelName: entry.channelName,
    sourceGroups: entry.sourceGroups || entry.discoveryGroups || [],
    selectedSourceId: entry.selectedSourceId || "",
    selectedSourceHash: entry.selectedSourceHash || "",
    songCount: entry.songs?.length || entry.selectedSongCount || 0,
    result: entry.result || "",
    sourceQuality: entry.sourceQuality || null,
  };
}

function listRejected(auditEntry) {
  const rejected = [];
  for (const source of auditEntry?.sources || []) {
    for (const entry of source.rejectedEntries || source.rejectedSamples || []) {
      rejected.push({
        sourceId: source.sourceId || "",
        sourceHash: source.sourceHash || "",
        reason: entry.reason || source.reason || "",
        time: entry.time || "",
        title: entry.title || "",
        artist: entry.artist || "",
      });
    }
  }
  return rejected;
}

function diagnosticMarkdown(diagnostic, local) {
  return [
    `# Video Diagnostic: ${diagnostic.videoId}`,
    "",
    `- generatedAt: ${diagnostic.generatedAt}`,
    `- firstFailureStage: ${diagnostic.firstFailureStage}`,
    `- rendererTypes: ${JSON.stringify(diagnostic.searchRenderers.rendererTypes)}`,
    `- watchPage: ${JSON.stringify(diagnostic.watchPage)}`,
    `- presence: ${JSON.stringify(diagnostic.presence)}`,
    `- parsedSongs: ${local.parsedSongs.length}`,
    "",
    "## Songs",
    ...local.parsedSongs.map((song) => `- ${song.time || "0:00"} ${song.title}${song.artist ? ` / ${song.artist}` : ""}`),
    "",
  ].join("\n");
}

function summarizeSearchRenderers(searchRenderers) {
  return {
    queryUrl: searchRenderers.queryUrl,
    rendererTypes: searchRenderers.rendererTypes,
    matchedCandidateCount: searchRenderers.extractedCandidates.filter((item) => item.videoId).length,
    error: searchRenderers.error,
  };
}

function hasSourceGroup(entry, group) {
  return listValues(entry?.sourceGroups).includes(group) || listValues(entry?.discoveryGroups).includes(group) || entry?.sourceGroup === group;
}

function findVideo(items, videoId) {
  return (items || []).find((item) => item?.videoId === videoId) || null;
}

function scanJsonDirForVideo(dir, videoId) {
  if (!fs.existsSync(dir)) return false;
  for (const filePath of walkFiles(dir)) {
    if (!filePath.endsWith(".json")) continue;
    if (fs.readFileSync(filePath, "utf8").includes(videoId)) return true;
  }
  return false;
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(filePath);
    else yield filePath;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "ja,en;q=0.8" } });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

function extractJsonAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${marker} not found`);
  const start = text.indexOf("{", idx);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let pos = start; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, pos + 1));
    }
  }
  throw new Error(`${marker} object end not found`);
}

function* walkDicts(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* walkDicts(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walkDicts(child);
  }
}

function looksTimestampLike(value) {
  return /(?:^|\s)(?:\d{1,2}:)?\d{1,2}:\d{2}\s+\S/u.test(String(value || ""));
}

function extractRegex(text, regex) {
  return text.match(regex)?.[1] || "";
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
