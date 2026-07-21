const { spawn } = require("node:child_process");

const { createSourceRecord, hashNormalizedText } = require("./curation");
const { normalizeParsedSong, parseTimestampSongs } = require("./song-utils");
const {
  SOURCE_SYSTEM,
  filterDiscoveryCandidates,
  matchedDiscoveryKeywords,
  normalizeChannelUrl,
} = require("./youtube-channel-discovery-core");

const DEFAULT_YT_DLP_PATH = "yt-dlp";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_COMMENT_LIMIT = 80;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

async function fetchChannelPageWithYtDlp(pageUrl, options = {}, context = {}) {
  const playlist = await runYtDlpJson(buildPlaylistArgs(pageUrl, options), options);
  return playlistJsonToDiscoveryPageResult(playlist, pageUrl, options, context);
}

async function inspectVideoSongListWithYtDlp(candidate, options = {}, context = {}) {
  const info = await runYtDlpJson(buildVideoInfoArgs(candidate, options), options);
  return videoInfoToSongListResult(info, candidate, options, context);
}

function playlistJsonToDiscoveryPageResult(playlist, pageUrl, options = {}, context = {}) {
  const fetchedAt = context.fetchedAt || new Date().toISOString();
  const rawItems = playlistJsonToCandidates(playlist, pageUrl, options, fetchedAt);
  const filtered = filterDiscoveryCandidates(rawItems, options.keywords, Date.now());
  return {
    items: filtered,
    summary: {
      pageUrl,
      status: "yt-dlp",
      backend: "yt-dlp",
      pageCount: 1,
      rawItemCount: rawItems.length,
      candidateCount: filtered.length,
      continuationRounds: 0,
      reachedEnd: true,
      fromCache: false,
      bytes: JSON.stringify(playlist || {}).length,
      fallbackFrom: context.error ? String(context.error.message || context.error) : "",
    },
  };
}

function playlistJsonToCandidates(playlist, pageUrl, options = {}, fetchedAt = new Date().toISOString()) {
  const entries = Array.isArray(playlist?.entries) ? playlist.entries : [];
  const channel = ytDlpChannelMetadata(playlist);
  const normalizedChannelUrl = normalizeChannelUrl(options.channelUrl || channel.channelUrl || pageUrl);
  return entries
    .filter((entry) => entry && String(entry.id || "").trim())
    .map((entry) => {
      const videoId = String(entry.id || "").trim();
      const thumbnailUrl = bestThumbnailUrl(entry.thumbnails) || entry.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      const channelAvatarUrl = channel.channelAvatarUrl || thumbnailUrl;
      const title = String(entry.title || "").trim();
      return {
        sourceSystem: SOURCE_SYSTEM,
        videoId,
        title,
        channelName: String(entry.channel || entry.uploader || channel.channelName || "").trim(),
        channelId: String(entry.channel_id || entry.uploader_id || channel.channelId || "").trim(),
        channelHandle: channelHandleFromYtDlp(entry.uploader_id || channel.channelHandle),
        channelUrl: normalizedChannelUrl,
        singerName: options.singerName || "",
        channelAvatarUrl,
        channelThumbnailUrl: channel.channelAvatarUrl || channelAvatarUrl,
        thumbnailUrl,
        durationText: entry.duration_string || secondsToTimestamp(entry.duration),
        publishedText: publishedTextFromEntry(entry),
        publishedTimestamp: timestampFromYtDlp(entry),
        viewText: Number.isFinite(Number(entry.view_count)) ? `${Number(entry.view_count)} views` : "",
        statusText: liveStatusText(entry.live_status),
        matchedKeywords: matchedDiscoveryKeywords(title, options.keywords),
        keyword: matchedDiscoveryKeywords(title, options.keywords)[0] || "",
        keywords: options.keywords || [],
        sourceGroup: SOURCE_SYSTEM,
        sourceGroups: [SOURCE_SYSTEM],
        sourceUrls: [entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${videoId}`].filter(Boolean),
        discoverySourceUrl: pageUrl,
        fetchedAt,
      };
    });
}

function videoInfoToSongListResult(info, candidate, options = {}, context = {}) {
  const sources = sourceRecordsFromYtDlpInfo(info, candidate.videoId);
  const audit = {
    videoId: candidate.videoId,
    title: info.title || candidate.title,
    channelName: info.channel || info.uploader || candidate.channelName,
    keyword: candidate.keyword,
    keywords: candidate.keywords,
    sourceGroups: candidate.sourceGroups,
    publishedText: candidate.publishedText || publishedTextFromEntry(info),
    publishedTimestamp: candidate.publishedTimestamp || timestampFromYtDlp(info) || null,
    durationText: candidate.durationText || info.duration_string || secondsToTimestamp(info.duration),
    backend: "yt-dlp",
    fallbackFrom: context.error ? String(context.error.message || context.error) : "",
    commentCandidateCount: sources.length,
    result: "no_timestamp_candidates",
    selectedSongCount: 0,
    acceptedSourceCount: 0,
    rejectedSourceCount: 0,
    rejectedEntryCount: 0,
    sources: [],
  };
  const parsedSources = [];
  for (const sourceRecord of sources) {
    const rejectedEntries = [];
    const songs = parseTimestampSongs([sourceRecord.text], {
      onReject: (entry) => rejectedEntries.push(compactRejectedEntry(entry)),
    })
      .map(normalizeParsedSong)
      .map((song) => ({
        ...song,
        sourceId: sourceRecord.sourceId,
        sourceHash: sourceRecord.sourceHash,
        sourceType: sourceRecord.sourceType,
        rawHash: hashNormalizedText(song.raw || `${song.time || ""} ${song.title || ""}`),
      }));
    if (!songs.length && !rejectedEntries.length) continue;
    const summary = sourceSummary(sourceRecord, songs, rejectedEntries);
    audit.sources.push(summary);
    audit.rejectedEntryCount += rejectedEntries.length;
    if (songs.length) parsedSources.push({ sourceRecord, songs, summary });
  }
  audit.acceptedSourceCount = parsedSources.length;
  audit.result = parsedSources.length ? "selected" : audit.sources.length ? "no_usable_song_source" : audit.result;
  const selected = selectBestParsedSource(parsedSources);
  if (!selected) return { detail: null, audit };

  selected.summary.selected = true;
  audit.selectedSongCount = selected.songs.length;
  const selectedSourceId = selected.sourceRecord.sourceId;
  const selectedSourceHash = selected.sourceRecord.sourceHash;
  return {
    detail: {
      videoId: candidate.videoId,
      title: info.title || candidate.title,
      channelName: info.channel || info.uploader || candidate.channelName || "",
      channelId: info.channel_id || info.uploader_id || candidate.channelId || "",
      channelHandle: channelHandleFromYtDlp(info.uploader_id || candidate.channelHandle),
      keyword: candidate.keyword,
      keywords: candidate.keywords || [candidate.keyword].filter(Boolean),
      sourceGroups: candidate.sourceGroups || [candidate.sourceGroup].filter(Boolean),
      sourceUrls: candidate.sourceUrls || [],
      publishedText: candidate.publishedText || publishedTextFromEntry(info),
      publishedTimestamp: candidate.publishedTimestamp || timestampFromYtDlp(info) || null,
      durationText: candidate.durationText || info.duration_string || secondsToTimestamp(info.duration),
      thumbnailUrl: bestThumbnailUrl(info.thumbnails) || info.thumbnail || candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
      channelAvatarUrl: candidate.channelAvatarUrl || bestChannelAvatarUrl(info) || candidate.thumbnailUrl || "",
      channelThumbnailUrl: candidate.channelThumbnailUrl || candidate.channelAvatarUrl || bestChannelAvatarUrl(info) || "",
      sourceCount: parsedSources.length,
      rejectedSourceCount: 0,
      rejectedSources: [],
      rejectedEntryCount: audit.rejectedEntryCount,
      sourceQuality: {
        sourceId: selectedSourceId,
        sourceHash: selectedSourceHash,
        sourceType: selected.sourceRecord.sourceType,
        sourceScore: selected.songs.length,
        riskScore: 0,
        riskLevel: "unscored",
        riskReasons: ["yt_dlp_fallback_unscored"],
        originalCount: selected.summary.originalCount,
        keptCount: selected.songs.length,
        knownSongCount: 0,
        artistCount: selected.songs.filter((song) => isUsableArtist(song.artist)).length,
        unknownArtistCount: selected.songs.filter((song) => !isUsableArtist(song.artist)).length,
      },
      selectedSourceId,
      selectedSourceHash,
      songs: selected.songs.map((song, index) => ({
        index: index + 1,
        time: song.time,
        seconds: song.seconds,
        title: song.title,
        artist: displayArtist(song.artist),
        raw: song.raw,
        rawHash: song.rawHash,
        sourceId: selectedSourceId,
        sourceHash: selectedSourceHash,
      })),
    },
    audit,
  };
}

function sourceRecordsFromYtDlpInfo(info, videoId) {
  const records = [];
  const description = String(info?.description || "").trim();
  if (description) records.push(createSourceRecord({ videoId, sourceType: "description", text: description, index: records.length }));
  for (const comment of Array.isArray(info?.comments) ? info.comments : []) {
    const text = String(comment?.text || comment?.content || "").trim();
    if (!text) continue;
    records.push(
      createSourceRecord({
        videoId,
        sourceType: "comment",
        text,
        commentId: comment.id || "",
        authorName: comment.author || "",
        index: records.length,
      }),
    );
  }
  return dedupeSourceRecords(records);
}

function sourceSummary(sourceRecord, songs, rejectedEntries) {
  return {
    sourceId: sourceRecord.sourceId,
    sourceHash: sourceRecord.sourceHash,
    sourceType: sourceRecord.sourceType,
    authorName: sourceRecord.authorName || "",
    selected: false,
    originalCount: songs.length + rejectedEntries.length,
    acceptedCount: songs.length,
    rejectedEntryCount: rejectedEntries.length,
    rejectedEntries: rejectedEntries.slice(0, 20),
    textSample: truncateText(sourceRecord.text, 240),
  };
}

function selectBestParsedSource(parsedSources) {
  if (!parsedSources.length) return null;
  return [...parsedSources].sort((a, b) => {
    const lengthDiff = b.songs.length - a.songs.length;
    if (lengthDiff) return lengthDiff;
    const artistDiff = b.songs.filter((song) => isUsableArtist(song.artist)).length - a.songs.filter((song) => isUsableArtist(song.artist)).length;
    if (artistDiff) return artistDiff;
    return (a.songs[0]?.seconds || 0) - (b.songs[0]?.seconds || 0);
  })[0];
}

function buildPlaylistArgs(pageUrl, options = {}) {
  const args = ["--flat-playlist", "--dump-single-json", "--no-progress", "--no-warnings"];
  const limit = Number(options.maxCandidates) || 0;
  if (limit > 0) args.push("--playlist-end", String(limit));
  args.push(pageUrl);
  return args;
}

function buildVideoInfoArgs(candidate, options = {}) {
  const limit = Math.max(1, Number(options.ytDlpCommentLimit) || DEFAULT_COMMENT_LIMIT);
  return [
    "--skip-download",
    "--no-playlist",
    "--write-comments",
    "--extractor-args",
    `youtube:max_comments=${limit},comment_sort=top`,
    "--dump-single-json",
    "--no-progress",
    "--no-warnings",
    `https://www.youtube.com/watch?v=${candidate.videoId}`,
  ];
}

function runYtDlpJson(args, options = {}) {
  return new Promise((resolve, reject) => {
    const command = options.ytDlpPath || process.env.YT_DLP || DEFAULT_YT_DLP_PATH;
    const timeoutMs = Math.max(1, Number(options.ytDlpTimeoutMs) || DEFAULT_TIMEOUT_MS);
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`yt-dlp failed to start: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        reject(new Error(`yt-dlp output exceeded ${MAX_CAPTURE_BYTES} bytes`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`yt-dlp exited ${exitCode}: ${firstLine(stderr)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`yt-dlp JSON parse failed: ${error.message}`));
      }
    });
  });
}

function ytDlpChannelMetadata(playlist) {
  const channelName = String(playlist?.channel || playlist?.uploader || playlist?.title || "").trim();
  const channelId = String(playlist?.channel_id || playlist?.uploader_id || playlist?.id || "").trim();
  const channelHandle = channelHandleFromYtDlp(playlist?.uploader_id || playlist?.channel || "");
  const channelUrl = playlist?.channel_url || playlist?.uploader_url || (channelHandle ? `https://www.youtube.com/${channelHandle}` : "");
  return {
    channelName,
    channelId,
    channelHandle,
    channelUrl,
    channelAvatarUrl: bestChannelAvatarUrl(playlist),
  };
}

function bestChannelAvatarUrl(value) {
  const thumbnails = Array.isArray(value?.thumbnails) ? value.thumbnails : [];
  const avatarCandidates = thumbnails.filter((thumbnail) => {
    const url = String(thumbnail?.url || "");
    const id = String(thumbnail?.id || "");
    const width = Number(thumbnail?.width) || 0;
    const height = Number(thumbnail?.height) || 0;
    const squareish = !width || !height || Math.abs(width - height) <= Math.max(width, height) * 0.25;
    return squareish && /(?:avatar|yt3\.ggpht|yt3\.googleusercontent)/iu.test(`${id} ${url}`);
  });
  return bestThumbnailUrl(avatarCandidates) || "";
}

function bestThumbnailUrl(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return "";
  return [...thumbnails]
    .filter((thumbnail) => thumbnail && thumbnail.url)
    .sort((a, b) => thumbnailScore(b) - thumbnailScore(a))[0]?.url || "";
}

function thumbnailScore(thumbnail) {
  const width = Number(thumbnail.width) || 0;
  const height = Number(thumbnail.height) || 0;
  return width * height || width || height || 1;
}

function timestampFromYtDlp(entry) {
  const timestamp = Number(entry?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp * 1000;
  const uploadDate = String(entry?.upload_date || "");
  if (/^\d{8}$/u.test(uploadDate)) {
    const parsed = Date.parse(`${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function publishedTextFromEntry(entry) {
  const timestamp = timestampFromYtDlp(entry);
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function liveStatusText(status) {
  const value = String(status || "");
  if (value === "is_live") return "LIVE";
  if (value === "is_upcoming" || value === "not_yet_live") return "upcoming";
  return "";
}

function channelHandleFromYtDlp(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("@")) return `/${text}`;
  if (text.startsWith("/@")) return text;
  return "";
}

function displayArtist(artist) {
  return isUsableArtist(artist) ? String(artist).trim() : "";
}

function isUsableArtist(artist) {
  const value = String(artist || "").trim();
  return Boolean(value && !/^(?:未記載|未记载|待补歌手|待補歌手|待补|待補)$/u.test(value));
}

function compactRejectedEntry(entry) {
  return {
    reason: entry.reason || "unknown",
    time: entry.time || "",
    seconds: entry.time ? timeToSeconds(entry.time) : null,
    title: entry.title || entry.tail || "",
    artist: entry.artist || "",
    line: truncateText(entry.line || entry.tail || "", 180),
    rawHash: hashNormalizedText(entry.line || entry.tail || ""),
  };
}

function timeToSeconds(time) {
  const parts = String(time || "").split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function secondsToTimestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!value) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function dedupeSourceRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records || []) {
    const key = `${record.sourceId}:${record.sourceHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function truncateText(text, limit) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}

module.exports = {
  buildPlaylistArgs,
  buildVideoInfoArgs,
  fetchChannelPageWithYtDlp,
  inspectVideoSongListWithYtDlp,
  playlistJsonToCandidates,
  playlistJsonToDiscoveryPageResult,
  runYtDlpJson,
  videoInfoToSongListResult,
};
