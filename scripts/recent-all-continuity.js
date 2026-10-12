"use strict";

const { groupForRange } = require("./range-config");

const CONTINUITY_FIELDS = [
  "title",
  "channelName",
  "channelId",
  "channelHandle",
  "channelUrl",
  "sourceUrl",
  "publishedTimestamp",
  "songs",
];

function validateRecentAllContinuity(payload) {
  const recentItems = groupForRange(payload?.groups, "7d")?.items || [];
  const allItems = groupForRange(payload?.groups, "all")?.items || [];
  const allByVideoId = new Map(allItems.map((item) => [item?.videoId, item]));
  const missingVideos = [];
  const missingSongs = [];
  const missingFields = [];

  for (const recentItem of recentItems) {
    const allItem = allByVideoId.get(recentItem?.videoId);
    if (!allItem) {
      missingVideos.push(recentItem?.videoId || "");
      continue;
    }
    for (const song of recentItem.songs || []) {
      const occurrences = (allItem.songs || []).filter((candidate) => songKey(candidate) === songKey(song)).length;
      if (occurrences < 1) missingSongs.push(`${recentItem.videoId}:${songKey(song)}`);
    }
    for (const field of CONTINUITY_FIELDS) {
      if (hasValue(recentItem[field]) && !hasValue(allItem[field])) {
        missingFields.push(`${recentItem.videoId}:${field}`);
      }
    }
  }

  return {
    recentVideoCount: recentItems.length,
    allVideoCount: allItems.length,
    missingVideos,
    missingSongs,
    missingFields,
    ok: missingVideos.length === 0 && missingSongs.length === 0 && missingFields.length === 0,
  };
}

function assertRecentAllContinuity(payload) {
  const result = validateRecentAllContinuity(payload);
  if (!result.ok) {
    const details = [
      result.missingVideos.length ? `videos=${result.missingVideos.slice(0, 8).join(",")}` : "",
      result.missingSongs.length ? `songs=${result.missingSongs.slice(0, 8).join(",")}` : "",
      result.missingFields.length ? `fields=${result.missingFields.slice(0, 8).join(",")}` : "",
    ].filter(Boolean).join(" ");
    throw new Error(`7d-to-all continuity failed ${details}`.trim());
  }
  return result;
}

function songKey(song) {
  return JSON.stringify([
    Number.isInteger(song?.seconds) ? song.seconds : null,
    String(song?.title || ""),
    String(song?.artist || ""),
  ]);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

module.exports = {
  assertRecentAllContinuity,
  validateRecentAllContinuity,
};
