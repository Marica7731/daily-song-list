const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { createSongSearchLookup } = require("../assets/frontend-utils");
const { createBlockedSourceAudit, filterBlockedVideos } = require("../assets/source-filter");
const { backfillMissingArtistsInVideos } = require("./artist-backfill");
const { applyCurationToVideos, loadCurationContext } = require("./curation");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { mergeSupplementalKnownSongs } = require("./song-search-index");

const SOURCE_GROUP = "youtube_channel_discovery";

function loadYoutubeChannelDiscoveryRuntimeVideos(options = {}) {
  const importDir = path.resolve(options.importDir || path.join(__dirname, "..", "data", "external", "youtube-channel-discovery"));
  const acceptedDir = path.join(importDir, "accepted");
  const required = options.required === true;
  if (!fs.existsSync(acceptedDir)) {
    if (required) throw new Error(`YouTube channel discovery accepted directory not found: ${acceptedDir}`);
    return null;
  }

  const files = fs.readdirSync(acceptedDir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  if (!files.length) {
    if (required) throw new Error(`No YouTube channel discovery accepted JSON files in ${acceptedDir}`);
    return null;
  }

  const byVideoId = new Map();
  const fileSummaries = [];
  let generatedAt = "";
  for (const file of files) {
    const filePath = path.join(acceptedDir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    const videos = Array.isArray(payload) ? payload : payload.videos;
    if (!Array.isArray(videos)) {
      throw new Error(`YouTube channel discovery accepted file must contain a videos array: ${filePath}`);
    }
    generatedAt = latestIso(generatedAt, payload.generatedAt);
    let usableCount = 0;
    let occurrenceCount = 0;
    for (const video of videos) {
      const normalized = normalizeRuntimeVideo(video, file);
      if (!normalized) continue;
      usableCount += 1;
      occurrenceCount += normalized.songs.length;
      const existing = byVideoId.get(normalized.videoId);
      if (!existing || isRicherVideo(normalized, existing)) {
        byVideoId.set(normalized.videoId, normalized);
      }
    }
    fileSummaries.push({
      file: path.relative(importDir, filePath).replace(/\\/g, "/"),
      sha256: sha256(raw),
      count: usableCount,
      occurrences: occurrenceCount,
      generatedAt: payload.generatedAt || "",
    });
  }

  const rawVideos = [...byVideoId.values()];
  const cleanup = options.cleanup === false
    ? { videos: rawVideos, stats: { enabled: false } }
    : cleanYoutubeChannelDiscoveryRuntimeVideos(rawVideos, options);
  const videos = cleanup.videos;
  const summary = {
    sourceSystem: SOURCE_GROUP,
    generatedAt: generatedAt || latestIso(...fileSummaries.map((item) => item.generatedAt)) || "",
    files: fileSummaries,
    fileCount: fileSummaries.length,
    rawVideoCount: rawVideos.length,
    rawOccurrenceCount: rawVideos.reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0),
    videoCount: videos.length,
    occurrenceCount: videos.reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0),
    cleanup: cleanup.stats,
  };
  return { videos, summary };
}

function cleanYoutubeChannelDiscoveryRuntimeVideos(videos, options = {}) {
  const aliasContext = options.aliasContext || loadSongAliasContext();
  const songSearchIndex = mergeSupplementalKnownSongs(options.songSearchIndex || {}, options.supplementalKnownSongs);
  const songSearchLookup = createSongSearchLookup(songSearchIndex);
  const blockedSourceAudit = createBlockedSourceAudit();
  const sourceFiltered = filterBlockedVideos(videos || [], { audit: blockedSourceAudit });
  const curationContext = {
    ...loadCurationContext(options),
    songAliasContext: aliasContext,
    songSearchLookup,
    corpusVideos: sourceFiltered,
  };
  const curated = applyCurationToVideos(sourceFiltered, curationContext);
  const backfilled = backfillMissingArtistsInVideos(curated, {
    aliasContext,
    supplementalKnownSongs: songSearchIndex.supplementalKnownSongs || [],
    corpusVideos: curated,
  });
  const cleanedVideos = backfilled
    .map((video) => ({
      ...video,
      songs: (video.songs || [])
        .map((song) => canonicalizeSongIdentity(song, aliasContext))
        .filter((song) => song?.title)
        .map((song, index) => ({ ...song, index: index + 1 })),
    }))
    .filter((video) => video.songs.length);
  const stats = {
    enabled: true,
    inputVideos: (videos || []).length,
    inputOccurrences: countSongs(videos),
    blockedSources: blockedSourceAudit.summary(),
    curation: curated.curationStats || {},
    artistBackfill: backfilled.artistBackfillStats || {},
    outputVideos: cleanedVideos.length,
    outputOccurrences: countSongs(cleanedVideos),
  };
  return { videos: cleanedVideos, stats };
}

function normalizeRuntimeVideo(video, sourceFile) {
  const videoId = stringValue(video?.videoId);
  if (!videoId) return null;
  const songs = Array.isArray(video.songs)
    ? video.songs
        .map((song, index) => normalizeRuntimeSong(song, index, video))
        .filter(Boolean)
    : [];
  if (!songs.length) return null;
  const sourceUrls = uniqueValues([
    ...(Array.isArray(video.sourceUrls) ? video.sourceUrls : []),
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  return {
    ...video,
    videoId,
    title: stringValue(video.title),
    url: stringValue(video.url) || `https://www.youtube.com/watch?v=${videoId}`,
    channelName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle: stringValue(video.channelHandle),
    channelUrl: stringValue(video.channelUrl),
    channelAvatarUrl: stringValue(video.channelAvatarUrl || video.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(video.channelThumbnailUrl || video.channelAvatarUrl),
    publishedTimestamp: finiteTimestamp(video.publishedTimestamp),
    publishedText: stringValue(video.publishedText),
    durationText: stringValue(video.durationText),
    thumbnailUrl: stringValue(video.thumbnailUrl) || fallbackThumbnailUrl(videoId),
    sourceGroups: uniqueValues([SOURCE_GROUP, ...(Array.isArray(video.sourceGroups) ? video.sourceGroups : [])]),
    sourceUrls,
    selectedSourceId: stringValue(video.selectedSourceId),
    selectedSourceHash: stringValue(video.selectedSourceHash),
    songs,
    qualityStatus: stringValue(video.qualityStatus) || "usable",
    discoveryImport: {
      ...(video.discoveryImport || {}),
      sourceGroup: SOURCE_GROUP,
      acceptedFile: sourceFile,
    },
  };
}

function fallbackThumbnailUrl(videoId) {
  return /^[A-Za-z0-9_-]{11}$/u.test(String(videoId || "")) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function normalizeRuntimeSong(song, index, video) {
  const title = stringValue(song?.title);
  if (!title) return null;
  return {
    ...song,
    index: Number.isFinite(Number(song.index)) && Number(song.index) > 0 ? Number(song.index) : index + 1,
    time: stringValue(song.time),
    seconds: Math.max(0, Number(song.seconds) || 0),
    title,
    artist: stringValue(song.artist),
    raw: stringValue(song.raw),
    rawHash: stringValue(song.rawHash),
    sourceId: stringValue(song.sourceId || video.selectedSourceId),
    sourceHash: stringValue(song.sourceHash || video.selectedSourceHash),
    isNiche: song.isNiche === true,
  };
}

function isRicherVideo(candidate, existing) {
  const candidateSongs = Array.isArray(candidate.songs) ? candidate.songs.length : 0;
  const existingSongs = Array.isArray(existing.songs) ? existing.songs.length : 0;
  if (candidateSongs !== existingSongs) return candidateSongs > existingSongs;
  const candidateSources = Array.isArray(candidate.sourceUrls) ? candidate.sourceUrls.length : 0;
  const existingSources = Array.isArray(existing.sourceUrls) ? existing.sourceUrls.length : 0;
  return candidateSources >= existingSources;
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => stringValue(value)).filter(Boolean))];
}

function countSongs(videos) {
  return (videos || []).reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0);
}

function stringValue(value) {
  return String(value || "").trim();
}

function latestIso(...values) {
  let selected = "";
  let selectedMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const text = stringValue(value);
    if (!text) continue;
    const ms = Date.parse(text);
    if (Number.isFinite(ms) && ms >= selectedMs) {
      selected = text;
      selectedMs = ms;
    } else if (!Number.isFinite(ms) && !selected) {
      selected = text;
    }
  }
  return selected;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

module.exports = {
  SOURCE_GROUP,
  cleanYoutubeChannelDiscoveryRuntimeVideos,
  loadYoutubeChannelDiscoveryRuntimeVideos,
  normalizeRuntimeVideo,
};
