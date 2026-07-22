"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_GROUP = "youtube_channel_discovery";
const DEFAULT_METADATA_PATH = path.join(__dirname, "..", "data", "external", "youtube-channel-discovery", "channel-metadata.json");

function loadChannelMetadataCache(filePath = DEFAULT_METADATA_PATH) {
  if (!fs.existsSync(filePath)) return { channels: [] };
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    ...payload,
    channels: Array.isArray(payload.channels) ? payload.channels : [],
  };
}

function hydratePayloadWithChannelMetadata(payload, options = {}) {
  const metadata = loadChannelMetadataCache(options.metadataPath || DEFAULT_METADATA_PATH);
  const lookup = buildChannelMetadataLookup(metadata.channels);
  const groups = payload?.groups && typeof payload.groups === "object" ? payload.groups : {};
  const hydratedGroups = {};
  for (const [groupId, group] of Object.entries(groups)) {
    hydratedGroups[groupId] =
      group && typeof group === "object"
        ? {
            ...group,
            items: Array.isArray(group.items) ? group.items.map((item) => hydrateVideoWithChannelMetadata(item, lookup)) : group.items,
          }
        : group;
  }
  return {
    ...payload,
    groups: hydratedGroups,
    source: {
      ...(payload.source || {}),
      channelMetadataCache: {
        path: path.relative(path.join(__dirname, ".."), options.metadataPath || DEFAULT_METADATA_PATH).replace(/\\/g, "/"),
        channelCount: metadata.channels.length,
        generatedAt: metadata.generatedAt || "",
      },
    },
  };
}

function hydrateVideoWithChannelMetadata(item, lookup) {
  const metadata = findChannelMetadata(lookup, metadataFromVideo(item));
  if (!metadata) {
    const channelAliases = channelAliasValues(item.channelAliases);
    return withDisplayThumbnail({
      ...item,
      ...(channelAliases.length ? { channelAliases } : {}),
      channelHandle: normalizeHandle(item.channelHandle || item.channelUrl || item.sourceUrl),
    });
  }
  const currentName = stringValue(item.channelName);
  const preferredName = preferredChannelDisplayName(currentName, metadata.displayName);
  const currentHandle = normalizeHandle(item.channelHandle);
  const channelAliases = channelAliasValues([...(Array.isArray(item.channelAliases) ? item.channelAliases : []), currentName, metadata.displayName, currentHandle, metadata.channelHandle]);
  const hydrated = {
    ...item,
    channelName: preferredName,
    channelAliases,
    channelId: item.channelId || metadata.channelId || "",
    channelHandle: currentHandle || metadata.channelHandle || "",
    channelUrl: item.channelUrl || metadata.channelUrl || metadata.sourceUrl || "",
    avatarUrl: realAvatarUrl(item.avatarUrl || item.channelAvatarUrl) || metadata.avatarUrl || "",
    sourceUrl: item.sourceUrl || metadata.sourceUrl || metadata.channelUrl || "",
    knownSourceType: item.knownSourceType || metadata.knownSourceType || "",
  };
  return withDisplayThumbnail(hydrated, metadata.thumbnailUrl);
}

function withDisplayThumbnail(item, fallbackThumbnail = "") {
  return {
    ...item,
    thumbnailUrl: item.thumbnailUrl || item.thumbnail || fallbackThumbnail || thumbnailUrlForVideo(item),
  };
}

function buildChannelMetadataLookup(channels) {
  const lookup = new Map();
  for (const channel of channels || []) {
    const metadata = normalizeChannelMetadata(channel);
    for (const key of channelIdentityKeys(metadata)) {
      lookup.set(key, mergeChannelMetadata(lookup.get(key), metadata));
    }
  }
  return lookup;
}

function findChannelMetadata(lookup, metadata) {
  for (const key of channelIdentityKeys(normalizeChannelMetadata(metadata))) {
    const value = lookup.get(key);
    if (value) return value;
  }
  return null;
}

function metadataFromVideo(item = {}) {
  return {
    displayName: stringValue(item.channelName),
    channelId: stringValue(item.channelId),
    channelHandle: normalizeHandle(item.channelHandle || item.channelUrl || item.authorUrl || item.ownerUrl || item.sourceUrl),
    channelUrl: stringValue(item.channelUrl || item.authorUrl || item.ownerUrl),
    sourceUrl: stringValue(item.sourceUrl || item.channelUrl || item.authorUrl || item.ownerUrl),
    avatarUrl: realAvatarUrl(item.avatarUrl || item.channelAvatarUrl),
    thumbnailUrl: imageUrl(item.thumbnailUrl || item.thumbnail || thumbnailUrlForVideo(item)),
    knownSourceType: stringValue(item.knownSourceType),
  };
}

function normalizeChannelMetadata(metadata = {}) {
  const channelId = stringValue(metadata.channelId);
  const channelHandle = normalizeHandle(metadata.handle || metadata.channelHandle || metadata.sourceUrl || metadata.channelUrl);
  const channelUrl = stringValue(metadata.channelUrl) || (channelId ? `https://www.youtube.com/channel/${channelId}` : "");
  const sourceUrl = stringValue(metadata.sourceUrl || metadata.channelUrl) || (channelHandle ? `https://www.youtube.com${channelHandle}` : channelUrl);
  return {
    displayName: stringValue(metadata.displayName || metadata.channelName || metadata.name),
    channelId,
    channelHandle,
    channelUrl,
    sourceUrl,
    avatarUrl: realAvatarUrl(metadata.avatarUrl || metadata.channelAvatarUrl || metadata.authorAvatarUrl || metadata.profileImageUrl),
    thumbnailUrl: imageUrl(metadata.thumbnailUrl || metadata.videoThumbnail || metadata.videoThumbnailUrl || metadata.thumbnail),
    knownSourceType: stringValue(metadata.knownSourceType || SOURCE_GROUP),
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
  };
}

function channelIdentityKeys(metadata) {
  return uniqueValues([
    metadata.channelId && `id:${metadata.channelId}`,
    metadata.channelHandle && `handle:${metadata.channelHandle.toLocaleLowerCase()}`,
    metadata.sourceUrl && `url:${normalizeChannelUrlKey(metadata.sourceUrl)}`,
    metadata.channelUrl && `url:${normalizeChannelUrlKey(metadata.channelUrl)}`,
    metadata.displayName && `name:${normalizeTextKey(metadata.displayName)}`,
  ]);
}

function thumbnailUrlForVideo(item = {}) {
  const videoId = stringValue(item.videoId);
  return /^[A-Za-z0-9_-]{11}$/u.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function imageUrl(value) {
  const text = stringValue(value);
  if (!/^https?:\/\//iu.test(text)) return "";
  if (/^data:image\//iu.test(text)) return "";
  return text;
}

function realAvatarUrl(value) {
  const text = stringValue(value);
  if (/^https:\/\/yt3\.googleusercontent\.com\//iu.test(text) || /^https:\/\/yt[0-9]\.ggpht\.com\//iu.test(text)) return text;
  if (/^https?:\/\/example\.test\//iu.test(text)) return text;
  return "";
}

function normalizeHandle(value) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/^https?:\/\/(?:www\.)?youtube\.com\/(@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu);
  if (match) return `/${match[1]}`;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text)) return text.startsWith("/") ? text : `/${text}`;
  return "";
}

function normalizeChannelUrlKey(value) {
  const text = stringValue(value).replace(/^http:\/\/www\./iu, "https://www.").replace(/^http:\/\//iu, "https://");
  const handle = normalizeHandle(text);
  if (handle) return handle.toLocaleLowerCase();
  const channelId = text.match(/youtube\.com\/channel\/([^/?#]+)/iu)?.[1] || "";
  return channelId ? `channel/${channelId}`.toLocaleLowerCase() : text.toLocaleLowerCase();
}

function normalizeTextKey(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase();
}

function preferredChannelDisplayName(current, candidate) {
  const currentText = stringValue(current);
  const candidateText = stringValue(candidate);
  if (!currentText) return candidateText;
  if (!candidateText) return currentText;
  const currentScore = channelDisplayNameScore(currentText);
  const candidateScore = channelDisplayNameScore(candidateText);
  return candidateScore > currentScore ? candidateText : currentText;
}

function channelDisplayNameScore(value) {
  const text = stringValue(value);
  if (!text) return -1;
  let score = Math.min(text.length, 80);
  if (/[ぁ-ゖァ-ヺ一-龯々〆〤]/u.test(text)) score += 1000;
  if (/^\/?@[A-Za-z0-9._%~-]+$/u.test(text)) score -= 1000;
  return score;
}

function uniqueValues(values) {
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function channelAliasValues(values) {
  return uniqueValues(Array.isArray(values) ? values : []).filter((value) => !isChannelPathAlias(value));
}

function isChannelPathAlias(value) {
  const text = stringValue(value).toLocaleLowerCase();
  return text.startsWith("/channel/") || text.includes("youtube.com/channel/");
}

function stringValue(value) {
  return String(value || "").trim();
}

module.exports = {
  DEFAULT_METADATA_PATH,
  buildChannelMetadataLookup,
  findChannelMetadata,
  hydratePayloadWithChannelMetadata,
  hydrateVideoWithChannelMetadata,
  imageUrl,
  loadChannelMetadataCache,
  metadataFromVideo,
  normalizeChannelMetadata,
  preferredChannelDisplayName,
  realAvatarUrl,
  thumbnailUrlForVideo,
};
