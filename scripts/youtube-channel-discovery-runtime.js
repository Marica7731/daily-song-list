const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isLikelyNonSongEntry, normalizeParsedSong } = require("./song-utils");

const SOURCE_GROUP = "youtube_channel_discovery";

function loadYoutubeChannelDiscoveryRuntimeVideos(options = {}) {
  const importDir = path.resolve(options.importDir || path.join(__dirname, "..", "data", "external", "youtube-channel-discovery"));
  const acceptedDir = path.join(importDir, "accepted");
  const channelMetadata = loadChannelMetadata(path.join(importDir, "channel-metadata.json"));
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
  const allVideos = [];
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
      allVideos.push(normalized);
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

  const metadataLookup = buildChannelMetadataLookup(channelMetadata.channels, allVideos);
  const videos = [...byVideoId.values()].map((video) => hydrateChannelMetadata(video, metadataLookup));
  const summary = {
    sourceSystem: SOURCE_GROUP,
    generatedAt: generatedAt || latestIso(...fileSummaries.map((item) => item.generatedAt)) || "",
    files: fileSummaries,
    fileCount: fileSummaries.length,
    videoCount: videos.length,
    occurrenceCount: videos.reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0),
  };
  return { videos, summary };
}

function loadChannelMetadata(filePath) {
  if (!fs.existsSync(filePath)) return { channels: [] };
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { channels: Array.isArray(payload.channels) ? payload.channels : [] };
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
  const channelUrl = stringValue(video.channelUrl || video.discoveryChannelUrl || video.discoveryImport?.discoveryChannelUrl);
  const channelHandle = normalizeHandle(video.channelHandle) || normalizeHandle(channelUrl) || normalizeHandle(sourceUrls.find((url) => /youtube\.com\/@/iu.test(url)));
  return {
    ...video,
    videoId,
    title: stringValue(video.title),
    url: stringValue(video.url) || `https://www.youtube.com/watch?v=${videoId}`,
    channelName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle,
    channelUrl,
    avatarUrl: stringValue(video.avatarUrl || video.channelAvatarUrl),
    thumbnailUrl: stringValue(video.thumbnailUrl),
    sourceUrl: stringValue(video.sourceUrl || channelUrl || sourceUrls.find((url) => /youtube\.com\/(?:@|channel\/)/iu.test(url))),
    knownSourceType: stringValue(video.knownSourceType || SOURCE_GROUP),
    isCollected: video.isCollected === false ? false : true,
    publishedTimestamp: finiteTimestamp(video.publishedTimestamp),
    publishedText: stringValue(video.publishedText),
    durationText: stringValue(video.durationText),
    thumbnailUrl: stringValue(video.thumbnailUrl),
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

function normalizeRuntimeSong(song, index, video) {
  const normalized = normalizeParsedSong(song || {});
  if (!normalized.title || isLikelyNonSongEntry(normalized)) return null;
  const title = stringValue(normalized.title);
  if (!title) return null;
  return {
    ...song,
    index: Number.isFinite(Number(song.index)) && Number(song.index) > 0 ? Number(song.index) : index + 1,
    time: stringValue(normalized.time),
    seconds: Math.max(0, Number(normalized.seconds) || 0),
    title,
    artist: stringValue(normalized.artist),
    raw: stringValue(normalized.raw),
    rawHash: stringValue(normalized.rawHash || song.rawHash),
    sourceId: stringValue(song.sourceId || video.selectedSourceId),
    sourceHash: stringValue(song.sourceHash || video.selectedSourceHash),
    isNiche: song.isNiche === true,
  };
}

function buildChannelMetadataLookup(channels, videos) {
  const lookup = new Map();
  for (const channel of channels || []) {
    addChannelMetadata(lookup, {
      displayName: stringValue(channel.displayName || channel.channelName || channel.name),
      channelId: stringValue(channel.channelId),
      channelHandle: normalizeHandle(channel.handle || channel.channelHandle || channel.sourceUrl || channel.channelUrl),
      channelUrl: stringValue(channel.channelUrl),
      sourceUrl: stringValue(channel.sourceUrl || channel.channelUrl),
      avatarUrl: stringValue(channel.avatarUrl),
      thumbnailUrl: stringValue(channel.thumbnailUrl || channel.videoThumbnailUrl),
      knownSourceType: stringValue(channel.knownSourceType || SOURCE_GROUP),
      isCollected: channel.isCollected === false ? false : true,
    });
  }
  for (const video of videos || []) {
    addChannelMetadata(lookup, metadataFromVideo(video));
  }
  return lookup;
}

function metadataFromVideo(video) {
  const sourceUrls = Array.isArray(video.sourceUrls) ? video.sourceUrls : [];
  const sourceUrl = stringValue(
    video.sourceUrl ||
      video.channelUrl ||
      sourceUrls.find((url) => /youtube\.com\/(?:@|channel\/)/iu.test(url)) ||
      video.discoveryImport?.discoveryChannelUrl,
  );
  return {
    displayName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle: normalizeHandle(video.channelHandle) || normalizeHandle(sourceUrl),
    channelUrl: stringValue(video.channelUrl),
    sourceUrl,
    avatarUrl: stringValue(video.avatarUrl || video.channelAvatarUrl),
    thumbnailUrl: stringValue(video.thumbnailUrl),
    knownSourceType: stringValue(video.knownSourceType || SOURCE_GROUP),
    isCollected: video.isCollected === false ? false : true,
  };
}

function addChannelMetadata(lookup, metadata) {
  const keys = channelIdentityKeys(metadata);
  if (!keys.length) return;
  const normalized = normalizeChannelMetadata(metadata);
  for (const key of keys) {
    lookup.set(key, mergeChannelMetadata(lookup.get(key), normalized));
  }
}

function hydrateChannelMetadata(video, lookup) {
  const metadata = findChannelMetadata(lookup, metadataFromVideo(video));
  const cleanVideoHandle = normalizeHandle(video.channelHandle);
  const hydrated = metadata
    ? {
        ...video,
        channelName: preferredChannelDisplayName(video.channelName, metadata.displayName),
        channelAliases: channelAliasValues([...(Array.isArray(video.channelAliases) ? video.channelAliases : []), video.channelName, metadata.displayName, metadata.channelHandle]),
        channelId: video.channelId || metadata.channelId || "",
        channelHandle: cleanVideoHandle || metadata.channelHandle || "",
        channelUrl: video.channelUrl || metadata.sourceUrl || metadata.channelUrl || "",
        avatarUrl: video.avatarUrl || metadata.avatarUrl || "",
        thumbnailUrl: video.thumbnailUrl || metadata.thumbnailUrl || "",
        sourceUrl: video.sourceUrl || metadata.sourceUrl || metadata.channelUrl || "",
        knownSourceType: video.knownSourceType || metadata.knownSourceType || SOURCE_GROUP,
        isCollected: video.isCollected === false ? false : metadata.isCollected !== false,
      }
    : {
        ...video,
        channelHandle: cleanVideoHandle,
      };
  return withTimeMetadata(hydrated);
}

function channelAliasValues(values) {
  return uniqueValues(values).filter((value) => !isChannelPathAlias(value));
}

function isChannelPathAlias(value) {
  const text = stringValue(value).toLocaleLowerCase();
  return text.startsWith("/channel/") || text.includes("youtube.com/channel/");
}

function findChannelMetadata(lookup, metadata) {
  for (const key of channelIdentityKeys(metadata)) {
    const value = lookup.get(key);
    if (value) return value;
  }
  return null;
}

function normalizeChannelMetadata(metadata) {
  return {
    displayName: stringValue(metadata.displayName),
    channelId: stringValue(metadata.channelId),
    channelHandle: normalizeHandle(metadata.channelHandle),
    channelUrl: stringValue(metadata.channelUrl),
    sourceUrl: stringValue(metadata.sourceUrl || metadata.channelUrl),
    avatarUrl: stringValue(metadata.avatarUrl),
    thumbnailUrl: stringValue(metadata.thumbnailUrl),
    knownSourceType: stringValue(metadata.knownSourceType || SOURCE_GROUP),
    isCollected: metadata.isCollected === false ? false : true,
  };
}

function mergeChannelMetadata(existing, incoming) {
  if (!existing) return incoming;
  return {
    displayName: preferredChannelDisplayName(existing.displayName, incoming.displayName),
    channelId: existing.channelId || incoming.channelId,
    channelHandle: existing.channelHandle || incoming.channelHandle,
    channelUrl: existing.channelUrl || incoming.channelUrl,
    sourceUrl: existing.sourceUrl || incoming.sourceUrl,
    avatarUrl: existing.avatarUrl || incoming.avatarUrl,
    thumbnailUrl: existing.thumbnailUrl || incoming.thumbnailUrl,
    knownSourceType: existing.knownSourceType || incoming.knownSourceType,
    isCollected: existing.isCollected !== false || incoming.isCollected !== false,
  };
}

function channelIdentityKeys(metadata) {
  return uniqueValues([
    metadata.channelId && `id:${metadata.channelId}`,
    metadata.channelHandle && `handle:${normalizeHandle(metadata.channelHandle).toLocaleLowerCase()}`,
    metadata.sourceUrl && `url:${normalizeChannelUrlKey(metadata.sourceUrl)}`,
    metadata.channelUrl && `url:${normalizeChannelUrlKey(metadata.channelUrl)}`,
  ]);
}

function normalizeHandle(value) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/(?:youtube\.com\/|^\/?)(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  if (match) return `/${match[1]}`;
  return "";
}

function normalizeChannelUrlKey(value) {
  const text = stringValue(value).replace(/^http:\/\/www\./iu, "https://www.").replace(/^http:\/\//iu, "https://");
  const handle = normalizeHandle(text);
  if (handle.startsWith("/@")) return handle.toLocaleLowerCase();
  const channelId = text.match(/youtube\.com\/channel\/([^/?#]+)/iu)?.[1] || "";
  return channelId ? `channel/${channelId}`.toLocaleLowerCase() : text.toLocaleLowerCase();
}

function withTimeMetadata(video) {
  const publishedTimestamp = finiteTimestamp(video.publishedTimestamp);
  return {
    ...video,
    publishedTimestamp,
    publishedAt: timestampToIso(publishedTimestamp),
    timeMissingReason: publishedTimestamp ? "" : timeMissingReason(video),
  };
}

function timestampToIso(value) {
  return value ? new Date(value).toISOString() : "";
}

function timeMissingReason(video) {
  if (!video?.videoId) return "missing_video_id";
  return "youtube_published_timestamp_unavailable";
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

function stringValue(value) {
  return String(value || "").trim();
}

function preferredChannelDisplayName(current, candidate) {
  const currentText = stringValue(current);
  const candidateText = stringValue(candidate);
  if (!currentText) return candidateText;
  if (!candidateText) return currentText;
  return channelDisplayNameScore(candidateText) > channelDisplayNameScore(currentText) ? candidateText : currentText;
}

function channelDisplayNameScore(value) {
  const text = stringValue(value);
  if (!text) return -1;
  let score = Math.min(text.length, 80);
  if (/[ぁ-ゖァ-ヺ一-龯々〆〤]/u.test(text)) score += 1000;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text) || /^\/channel\/UC[A-Za-z0-9_-]+$/u.test(text) || /^UC[A-Za-z0-9_-]{20,}$/u.test(text)) score -= 1000;
  return score;
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
  loadYoutubeChannelDiscoveryRuntimeVideos,
  normalizeRuntimeVideo,
};
