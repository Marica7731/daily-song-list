const fs = require("node:fs");
const path = require("node:path");
const { isTimestampCandidateText, parseTimestampSongs } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const STATUS_PATH = path.join(DATA_DIR, "status.json");

const SEARCHES = [
  {
    keyword: "歌枠",
    url: "https://www.youtube.com/results?search_query=%E6%AD%8C%E6%9E%A0&sp=CAMSBggEEAEYAg%253D%253D",
  },
  {
    keyword: "弾き語り",
    url: "https://www.youtube.com/results?search_query=%E5%BC%BE%E3%81%8D%E8%AA%9E%E3%82%8A&sp=CAMSBggEEAEYAg%253D%253D",
  },
];

const SEARCH_LIMIT = positiveInteger(process.env.DAILY_SONG_SEARCH_LIMIT, 36);
const VIDEO_LIMIT = positiveInteger(process.env.DAILY_SONG_VIDEO_LIMIT, 36);
const REPLY_LIMIT = positiveInteger(process.env.DAILY_SONG_COMMENT_REPLY_LIMIT, 12);
const SNAPSHOT_RETENTION_DAYS = positiveInteger(process.env.DAILY_SONG_SNAPSHOT_RETENTION_DAYS, 35);
const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const H72_MS = 72 * 60 * 60 * 1000;

main().catch((error) => {
  console.error(`[update] ${error.stack || error.message}`);
  markFailure(error).finally(() => process.exit(2));
});

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const startedAt = new Date();
  const candidates = await collectCandidates(startedAt);
  console.log(`[update] candidates=${candidates.length}`);

  const inspected = [];
  const videos = [];
  for (const candidate of candidates.slice(0, VIDEO_LIMIT)) {
    try {
      const detail = await fetchVideoSongList(candidate);
      inspected.push({ videoId: candidate.videoId, ok: Boolean(detail), songCount: detail?.songs.length || 0 });
      if (detail) videos.push(detail);
      console.log(`[update] ${candidate.videoId} songs=${detail?.songs.length || 0} ${candidate.title}`);
    } catch (error) {
      inspected.push({ videoId: candidate.videoId, ok: false, error: error.message });
      console.warn(`[update] skip ${candidate.videoId}: ${error.message}`);
    }
  }

  const capturedAt = new Date();
  const groups = buildGroups(videos, capturedAt);
  const totalItems = Object.values(groups).reduce((sum, group) => sum + group.items.length, 0);
  if (totalItems <= 0) {
    throw new Error(`No usable timestamp song lists found after inspecting ${inspected.length} videos.`);
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: capturedAt.toISOString(),
    capturedAt: capturedAt.toISOString(),
    source: {
      name: "YouTube search + watch comments/descriptions",
      searches: SEARCHES,
      inspectedCount: inspected.length,
      usableVideoCount: videos.length,
    },
    status: {
      status: "success",
      attemptedAt: startedAt.toISOString(),
      completedAt: capturedAt.toISOString(),
      message: `Captured ${totalItems} videos with timestamp song lists.`,
    },
    groups,
  };

  writeJson(LATEST_PATH, payload);
  writeJson(path.join(DATA_DIR, "72h.json"), groups["72h"]);
  writeJson(path.join(DATA_DIR, "1m.json"), groups["1m"]);
  writeSnapshot(payload, capturedAt);
  writeJson(STATUS_PATH, payload.status);
  console.log(`[update] success totalItems=${totalItems} snapshot=${hourSnapshotId(capturedAt)}`);
}

async function collectCandidates(now) {
  const all = [];
  for (const search of SEARCHES) {
    const html = await fetchText(search.url);
    const data = extractJsonAfter(html, "ytInitialData");
    const items = extractSearchItems(data)
      .slice(0, SEARCH_LIMIT)
      .map((item) => ({ ...item, keyword: search.keyword }));
    all.push(...items);
  }

  const nowMs = now.getTime();
  return dedupeByVideoId(all)
    .map((item) => ({
      ...item,
      publishedTimestamp: parsePublishedTimestamp(item.publishedText, nowMs),
    }))
    .filter((item) => {
      if (!item.publishedTimestamp) return true;
      return nowMs - item.publishedTimestamp <= MONTH_MS;
    })
    .sort((a, b) => (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0));
}

async function fetchVideoSongList(candidate) {
  const html = await fetchText(`https://www.youtube.com/watch?v=${candidate.videoId}&hl=ja&persist_hl=1`);
  const apiKey = extractRegex(html, /"INNERTUBE_API_KEY":"([^"]+)"/);
  const clientVersion = extractRegex(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || "2.20260601.00.00";
  const initialData = extractJsonAfter(html, "ytInitialData");
  const comments = extractDescriptionCandidates(initialData);
  const continuation = findCommentsContinuation(initialData);
  if (apiKey && continuation) {
    const response = await fetchYouTubeContinuation(apiKey, clientVersion, continuation);
    comments.push(...extractCommentTexts(response));
    comments.push(...(await fetchCommentReplyTexts(apiKey, clientVersion, response, REPLY_LIMIT)));
  }

  const sources = [];
  for (const text of comments) {
    const songs = parseTimestampSongs([text]);
    if (songs.length) sources.push(songs);
  }
  const selected = selectBestSongs(withMergedOrderedSource(sources));
  if (!selected.length) return null;

  return {
    videoId: candidate.videoId,
    title: candidate.title,
    channelName: candidate.channelName,
    keyword: candidate.keyword,
    publishedText: candidate.publishedText,
    publishedTimestamp: candidate.publishedTimestamp || null,
    durationText: candidate.durationText,
    thumbnailUrl: candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
    sourceCount: sources.length,
    songs: selected.map((song, index) => ({
      index: index + 1,
      time: song.time,
      seconds: song.seconds,
      title: song.title,
      artist: song.artist === "未記載" ? "" : song.artist,
      raw: song.raw,
    })),
  };
}

function buildGroups(videos, capturedAt) {
  const nowMs = capturedAt.getTime();
  const inRange = (item, maxAgeMs) => {
    if (!item.publishedTimestamp) return maxAgeMs === MONTH_MS;
    return nowMs - item.publishedTimestamp <= maxAgeMs;
  };
  const sortVideos = (items) =>
    [...items].sort((a, b) => {
      const timeDiff = (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0);
      if (timeDiff) return timeDiff;
      return b.songs.length - a.songs.length;
    });

  return {
    "72h": {
      id: "72h",
      title: "72H timestamp song lists",
      generatedAt: capturedAt.toISOString(),
      updatedAt: capturedAt.toISOString(),
      items: sortVideos(videos.filter((item) => inRange(item, H72_MS))),
    },
    "1m": {
      id: "1m",
      title: "One-month timestamp song lists",
      generatedAt: capturedAt.toISOString(),
      updatedAt: capturedAt.toISOString(),
      items: sortVideos(videos.filter((item) => inRange(item, MONTH_MS))),
    },
  };
}

function writeSnapshot(payload, capturedAt) {
  const snapshotId = hourSnapshotId(capturedAt);
  const snapshotPath = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);
  writeJson(snapshotPath, { ...payload, snapshotId });

  const indexPath = path.join(SNAPSHOT_DIR, "index.json");
  const index = readJsonIfExists(indexPath) || { snapshots: [] };
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = new Map();
  for (const entry of Array.isArray(index.snapshots) ? index.snapshots : []) {
    if (!entry || !/^[0-9]{8}T[0-9]{4}00Z$/.test(entry.id)) continue;
    const entryTime = Date.parse(entry.capturedAt || entry.generatedAt || entry.id);
    if (!Number.isFinite(entryTime) || entryTime < cutoff) continue;
    if (!fs.existsSync(path.join(SNAPSHOT_DIR, `${entry.id}.json`))) continue;
    entries.set(entry.id, entry);
  }
  entries.set(snapshotId, {
    id: snapshotId,
    file: `${snapshotId}.json`,
    path: `data/snapshots/${snapshotId}.json`,
    generatedAt: payload.generatedAt,
    capturedAt: payload.capturedAt,
    label: formatSnapshotLabel(capturedAt),
    itemCounts: {
      "72h": payload.groups["72h"].items.length,
      "1m": payload.groups["1m"].items.length,
    },
  });

  const snapshots = [...entries.values()].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const keep = new Set(snapshots.map((entry) => `${entry.id}.json`));
  for (const dirent of fs.readdirSync(SNAPSHOT_DIR, { withFileTypes: true })) {
    if (dirent.isFile() && /^[0-9]{8}T[0-9]{4}00Z\.json$/.test(dirent.name) && !keep.has(dirent.name)) {
      fs.rmSync(path.join(SNAPSHOT_DIR, dirent.name));
    }
  }

  writeJson(indexPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    cadence: "hourly",
    latestSnapshotId: snapshots[0]?.id || "",
    snapshots,
  });
}

async function markFailure(error) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previous = readJsonIfExists(LATEST_PATH);
  const attemptedAt = new Date().toISOString();
  const status = {
    status: "failed",
    attemptedAt,
    completedAt: attemptedAt,
    message: error.message,
    fallback: previous ? "kept previous data/latest.json" : "no previous data available",
  };
  writeJson(STATUS_PATH, status);
}

function extractSearchItems(data) {
  const items = [];
  for (const node of walkDicts(data)) {
    const renderer = node.videoRenderer;
    if (!renderer || !renderer.videoId) continue;
    const videoId = renderer.videoId;
    items.push({
      videoId,
      title: textFrom(renderer.title),
      channelName: textFrom(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText),
      publishedText: textFrom(renderer.publishedTimeText),
      durationText: textFrom(renderer.lengthText),
      thumbnailUrl: bestThumbnail(renderer.thumbnail),
      viewText: textFrom(renderer.viewCountText || renderer.shortViewCountText),
    });
  }
  return dedupeByVideoId(items).filter((item) => item.title);
}

function extractDescriptionCandidates(data) {
  const texts = [];
  for (const item of walkDicts(data)) {
    if (typeof item.simpleText === "string" && isTimestampCandidateText(item.simpleText)) texts.push(item.simpleText);
    if (Array.isArray(item.runs)) {
      const joined = item.runs.map((run) => (run && typeof run.text === "string" ? run.text : "")).join("");
      if (isTimestampCandidateText(joined)) texts.push(joined);
    }
  }
  return [...new Set(texts)];
}

function findCommentsContinuation(data) {
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token;
    if (token && looksLikeCommentsContinuation(item)) return token;
  }
  for (const item of walkDicts(data)) {
    const token = item.continuationCommand?.token;
    if (token) return token;
  }
  return "";
}

function looksLikeCommentsContinuation(item) {
  const text = JSON.stringify(item);
  return /comment|コメント/i.test(text);
}

async function fetchCommentReplyTexts(apiKey, clientVersion, commentsResponse, maxContinuations) {
  const comments = [];
  const seen = new Set();
  const pending = extractCommentReplyContinuationTokens(commentsResponse);
  while (pending.length && seen.size < maxContinuations) {
    const token = pending.shift();
    if (seen.has(token)) continue;
    seen.add(token);
    const response = await fetchYouTubeContinuation(apiKey, clientVersion, token);
    comments.push(...extractCommentTexts(response));
    for (const nextToken of extractCommentReplyContinuationTokens(response)) {
      if (!seen.has(nextToken)) pending.push(nextToken);
    }
  }
  return comments;
}

function extractCommentReplyContinuationTokens(data) {
  const tokens = [];
  for (const item of walkDicts(data)) {
    const replies = item.commentRepliesRenderer;
    if (!replies || !Array.isArray(replies.contents)) continue;
    for (const content of replies.contents) {
      const token = content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

function extractCommentTexts(data) {
  const comments = [];
  for (const item of walkDicts(data)) {
    const entityContent = item.commentEntityPayload?.properties?.content?.content;
    if (typeof entityContent === "string") comments.push(entityContent);
    const rendererRuns = item.commentRenderer?.contentText?.runs;
    if (Array.isArray(rendererRuns)) {
      const text = rendererRuns.map((run) => run.text || "").join("");
      if (text) comments.push(text);
    }
  }
  return [...new Set(comments)];
}

async function fetchYouTubeContinuation(apiKey, clientVersion, continuation) {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      ...headers(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB",
          clientVersion,
          hl: "ja",
          gl: "JP",
        },
      },
      continuation,
    }),
  });
  if (!response.ok) throw new Error(`youtubei continuation HTTP ${response.status}`);
  return response.json();
}

function selectBestSongs(sources) {
  if (!sources.length) return [];
  return [...sources].sort((a, b) => {
    const lenDiff = b.length - a.length;
    if (lenDiff) return lenDiff;
    const artistDiff = countArtists(b) - countArtists(a);
    if (artistDiff) return artistDiff;
    return a[0].seconds - b[0].seconds;
  })[0];
}

function withMergedOrderedSource(sources) {
  const merged = mergeOrderedSources(sources);
  if (!merged.length) return sources;
  const largest = Math.max(0, ...sources.map((source) => source.length));
  return merged.length > largest ? [merged, ...sources] : sources;
}

function mergeOrderedSources(sources) {
  const longSources = sources.filter((source) => source.length >= 10);
  if (longSources.length < 2) return [];
  const merged = [];
  let lastSeconds = -1;
  for (const source of longSources.sort((a, b) => a[0].seconds - b[0].seconds)) {
    const start = source[0].seconds;
    const end = source[source.length - 1].seconds;
    if (start <= lastSeconds || end <= start) continue;
    merged.push(...source);
    lastSeconds = end;
  }
  return merged.length >= 20 ? dedupeMergedSongs(merged) : [];
}

function dedupeMergedSongs(songs) {
  const seen = new Set();
  const result = [];
  for (const song of songs) {
    const key = `${song.seconds}:${song.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

function countArtists(songs) {
  return songs.filter((song) => song.artist && song.artist !== "未記載").length;
}

function parsePublishedTimestamp(text, nowMs) {
  const normalized = normalizeDigits(String(text || "")).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/昨日|yesterday/i.test(normalized)) return nowMs - 24 * 60 * 60 * 1000;
  const directDate = normalized.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (directDate) {
    const value = new Date(Number(directDate[1]), Number(directDate[2]) - 1, Number(directDate[3])).getTime();
    return Number.isFinite(value) ? value : null;
  }
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|minutes?|mins?|分|hours?|hrs?|時間|小时|小時|days?|日|天|weeks?|週間|週|周|months?|か月|ヶ月|月|years?|年)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  let multiplier = 0;
  if (/second|sec|秒/.test(unit)) multiplier = 1000;
  else if (/minute|min|分/.test(unit)) multiplier = 60 * 1000;
  else if (/hour|hr|時間|小时|小時/.test(unit)) multiplier = 60 * 60 * 1000;
  else if (/day|日|天/.test(unit)) multiplier = 24 * 60 * 60 * 1000;
  else if (/week|週間|週|周/.test(unit)) multiplier = 7 * 24 * 60 * 60 * 1000;
  else if (/month|か月|ヶ月|月/.test(unit)) multiplier = 30 * 24 * 60 * 60 * 1000;
  else if (/year|年/.test(unit)) multiplier = 365 * 24 * 60 * 60 * 1000;
  return multiplier ? nowMs - amount * multiplier : null;
}

function normalizeDigits(text) {
  return String(text || "").replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

async function fetchText(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.text();
}

function headers() {
  return {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "accept-language": "ja,en-US;q=0.8,en;q=0.6",
  };
}

function extractJsonAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${marker} not found`);
  const start = text.indexOf("{", idx);
  if (start < 0) throw new Error(`${marker} object start not found`);
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

function extractRegex(text, regex) {
  return text.match(regex)?.[1] || "";
}

function* walkDicts(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* walkDicts(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walkDicts(child);
  }
}

function textFrom(value) {
  if (!value) return "";
  if (typeof value === "string") return normalizeWhitespace(value);
  if (typeof value.simpleText === "string") return normalizeWhitespace(value.simpleText);
  if (Array.isArray(value.runs)) return normalizeWhitespace(value.runs.map((run) => run.text || "").join(""));
  if (Array.isArray(value.accessibility?.accessibilityData?.label)) return normalizeWhitespace(value.accessibility.accessibilityData.label);
  return "";
}

function bestThumbnail(thumbnail) {
  const list = thumbnail?.thumbnails;
  if (!Array.isArray(list) || !list.length) return "";
  return [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url || "";
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeByVideoId(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item.videoId || seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    result.push(item);
  }
  return result;
}

function readJsonIfExists(filePath) {
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

function hourSnapshotId(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}0000Z`;
}

function formatSnapshotLabel(date) {
  return new Intl.DateTimeFormat("zh-Hant", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
