const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const IMPORT_ROOT = path.join(ROOT, "data", "static", "v1", "imports");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    args[key] = value;
  }
  return args;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function videoIdOf(value) {
  return String(value?.videoId || value?.youtubeVideoId || "").trim();
}

function canonicalHandle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("@")) return text;
  if (text.startsWith("/@")) return text.slice(1);
  const match = text.match(/youtube\.com\/(?:@|[^/]+\/@)([^/?#]+)/iu);
  return match ? `@${match[1]}` : `@${text.replace(/^\/+/u, "")}`;
}

function isoTimestamp(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : "";
}

function compactAudit(audit, fallback = {}) {
  const videoId = videoIdOf(audit);
  return {
    videoId,
    title: String(audit?.title || fallback.videoTitle || fallback.title || ""),
    channelName: String(audit?.channelName || fallback.channelName || ""),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    publishedAt: isoTimestamp(audit?.publishedTimestamp || audit?.publishedText || fallback.publishedTimestamp),
    publishedText: String(audit?.publishedText || fallback.publishedText || ""),
    durationText: String(audit?.durationText || fallback.durationText || ""),
    keywords: Array.isArray(audit?.keywords) ? audit.keywords.map(String)
      : Array.isArray(fallback.matchedKeywords) ? fallback.matchedKeywords.map(String) : [],
    result: String(audit?.result || ""),
    error: String(audit?.error || ""),
    selectedSongCount: Number(audit?.selectedSongCount || 0),
    acceptedSourceCount: Number(audit?.acceptedSourceCount || 0),
    rejectedSourceCount: Number(audit?.rejectedSourceCount || 0),
    commentCandidateCount: Number(audit?.commentCandidateCount || 0),
  };
}

function normalizeVideo(detail, manifest, expected) {
  const videoId = videoIdOf(detail);
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) throw new Error(`invalid detail video id: ${videoId}`);
  const songs = Array.isArray(detail.songs) ? detail.songs : [];
  if (!songs.length) throw new Error(`detail has no songs: ${videoId}`);
  const normalizedSongs = songs.map((song, index) => ({
    index: index + 1,
    time: String(song?.time || ""),
    seconds: Math.max(0, Number(song?.seconds) || 0),
    title: String(song?.title || ""),
    artist: String(song?.artist || ""),
    raw: String(song?.raw || ""),
    sourceId: String(song?.sourceId || detail.selectedSourceId || ""),
    sourceHash: String(song?.sourceHash || detail.selectedSourceHash || ""),
  })).filter((song) => song.title);
  if (!normalizedSongs.length) throw new Error(`detail has no usable songs: ${videoId}`);
  return {
    videoId,
    title: String(detail.title || ""),
    channelName: String(detail.channelName || manifest.channelName || ""),
    channelId: String(detail.channelId || manifest.channelId || expected.channelId),
    channelHandle: canonicalHandle(detail.channelHandle || expected.handle),
    channelUrl: String(detail.channelUrl || manifest.channelUrl || expected.url),
    publishedAt: isoTimestamp(detail.publishedTimestamp || detail.publishedAt),
    thumbnailUrl: String(detail.thumbnailUrl || ""),
    matchedKeywords: Array.isArray(detail.matchedKeywords) ? detail.matchedKeywords.map(String) : [],
    songs: normalizedSongs,
  };
}

function buildChannelSetlists({ inputDir, runId, sourceCommit, expectedId, expectedHandle, expectedUrl, now = new Date() }) {
  const manifest = readJson(path.join(inputDir, "manifest.json"), "manifest");
  const rawVideos = readJson(path.join(inputDir, "raw-videos.json"), "raw videos");
  const details = readJson(path.join(inputDir, "video-details.json"), "video details");
  const audits = readJson(path.join(inputDir, "audits.json"), "audits");
  const checkpoint = readJson(path.join(inputDir, "checkpoint.json"), "checkpoint");

  if (manifest.kind !== "youtube-channel-discovery" || manifest.candidateOnly !== false) {
    throw new Error("input is not a complete channel discovery run");
  }
  if (manifest.complete !== true || manifest.partial !== false) throw new Error("discovery source is incomplete");
  if (!Array.isArray(rawVideos) || !Array.isArray(details) || !Array.isArray(audits)) {
    throw new Error("discovery outputs must be arrays");
  }
  const maxInspect = Number(manifest.maxInspect || 0);
  const candidateCount = Number(manifest.candidateCount || 0);
  if (maxInspect <= 0 || candidateCount <= 0) throw new Error("discovery did not inspect candidates");
  if (rawVideos.length !== candidateCount) throw new Error("raw candidate count does not match manifest");
  if (Number(manifest.usableVideoCount || 0) !== details.length) throw new Error("usable detail count does not match manifest");
  if (checkpoint.schemaVersion !== 1) throw new Error("checkpoint schema is not supported");
  if (!Array.isArray(checkpoint.completedVideoIds) || !Array.isArray(checkpoint.details) || !Array.isArray(checkpoint.audits)) {
    throw new Error("checkpoint outputs are incomplete");
  }

  const rawIds = rawVideos.map(videoIdOf);
  const detailIds = details.map(videoIdOf);
  const auditIds = audits.map(videoIdOf);
  const idSet = (ids) => new Set(ids.filter(Boolean));
  const rawSet = idSet(rawIds);
  const detailSet = idSet(detailIds);
  const auditSet = idSet(auditIds);
  const completedSet = idSet(checkpoint.completedVideoIds);
  if (rawSet.size !== candidateCount) throw new Error("duplicate raw candidate ids");
  if (completedSet.size !== candidateCount || [...completedSet].some((id) => !rawSet.has(id))) {
    throw new Error("checkpoint does not cover every candidate");
  }
  if (checkpoint.details.length !== details.length || checkpoint.audits.length !== audits.length) {
    throw new Error("checkpoint output counts do not match discovery outputs");
  }
  if (auditSet.size !== candidateCount) throw new Error("audit coverage does not include every candidate");
  if ([...detailSet].some((id) => !auditSet.has(id))) throw new Error("detail without an audit");
  if ([...auditSet].some((id) => !rawSet.has(id))) throw new Error("audit for an unknown candidate");
  if (details.some((detail) => !Array.isArray(detail.songs) || !detail.songs.length)) {
    throw new Error("usable detail contains no songs");
  }
  if (audits.some((audit) => audit?.result === "fetch_error")) throw new Error("candidate inspection contains fetch_error");

  const expected = {
    id: String(expectedId || manifest.channelId || ""),
    handle: canonicalHandle(expectedHandle || manifest.channelHandle || ""),
    url: String(expectedUrl || manifest.channelUrl || ""),
  };
  if (!expected.id || !expected.handle || !expected.url) throw new Error("missing expected channel identity");
  if (String(manifest.channelId || "").toLowerCase() !== expected.id.toLowerCase()) {
    throw new Error("discovery channel id does not match expected identity");
  }
  if (canonicalHandle(manifest.channelHandle).toLowerCase() !== expected.handle.toLowerCase()) {
    throw new Error("discovery channel handle does not match expected identity");
  }
  const normalizeUrl = (value) => {
    const url = new URL(String(value || ""));
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/streams\/?$/u, "").replace(/\/+$/u, "");
    return `${url.host}${url.pathname}`.toLowerCase();
  };
  if (normalizeUrl(manifest.channelUrl) !== normalizeUrl(expected.url)) {
    throw new Error("discovery channel url does not match expected identity");
  }

  const videos = details.map((detail) => normalizeVideo(detail, manifest, expected));
  const occurrenceCount = videos.reduce((total, video) => total + video.songs.length, 0);
  const rawById = new Map(rawVideos.map((video) => [videoIdOf(video), video]));
  const compactAudits = audits.map((audit) => compactAudit(audit, rawById.get(videoIdOf(audit)) || {}));
  const noSongCount = compactAudits.filter((audit) => audit.selectedSongCount === 0 && audit.result !== "fetch_error").length;
  const failedCount = compactAudits.filter((audit) => audit.result === "fetch_error").length;
  const payload = {
    schemaVersion: 1,
    kind: "channel-setlists",
    generatedAt: now.toISOString(),
    channel: {
      id: expected.id,
      handle: expected.handle,
      url: expected.url,
      name: String(manifest.channelName || ""),
    },
    source: {
      system: "youtube-channel-discovery",
      runId: String(runId || ""),
      sourceCommit: String(sourceCommit || ""),
      manifestGeneratedAt: String(manifest.generatedAt || ""),
      keywords: Array.isArray(manifest.keywords) ? manifest.keywords.map(String) : [],
      pageCount: Number(manifest.pageSummaries?.[0]?.pageCount || 0),
      reachedEnd: Boolean(manifest.pageSummaries?.[0]?.reachedEnd),
    },
    summary: {
      candidateCount,
      inspectedCount: completedSet.size,
      // inspectedCount is cumulative checkpoint coverage; inspectedInLatestRun is this pass.
      inspectedInLatestRun: Number(manifest.inspectedInLatestRun || 0),
      setlistVideoCount: videos.length,
      auditCount: compactAudits.length,
      occurrenceCount,
      noSongCount,
      failedCount,
      allCandidatesAccounted: auditSet.size === candidateCount,
    },
    videos,
    audits: compactAudits,
  };
  return payload;
}

function writeChannelSetlists(payload, outputRelative) {
  const resolved = path.resolve(ROOT, outputRelative);
  const relative = path.relative(IMPORT_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`output must stay under ${path.relative(ROOT, IMPORT_ROOT)}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 100 * 1024 * 1024) throw new Error("channel setlist export exceeds 100 MB");
  fs.writeFileSync(resolved, serialized, "utf8");
  return resolved;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(String(args["input-dir"] || ""));
  const output = String(args.output || "");
  if (!inputDir || !output) throw new Error("Usage: export-channel-setlists.js --input-dir DIR --output data/static/v1/imports/NAME.json");
  const payload = buildChannelSetlists({
    inputDir,
    runId: args["run-id"],
    sourceCommit: args["source-commit"],
    expectedId: args["channel-id"],
    expectedHandle: args["channel-handle"],
    expectedUrl: args["channel-url"],
  });
  const written = writeChannelSetlists(payload, output);
  console.log(JSON.stringify({
    kind: payload.kind,
    output: path.relative(ROOT, written),
    candidateCount: payload.summary.candidateCount,
    setlistVideoCount: payload.summary.setlistVideoCount,
    occurrenceCount: payload.summary.occurrenceCount,
    noSongCount: payload.summary.noSongCount,
    failedCount: payload.summary.failedCount,
    allCandidatesAccounted: payload.summary.allCandidatesAccounted,
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildChannelSetlists,
  canonicalHandle,
  parseArgs,
  writeChannelSetlists,
};
