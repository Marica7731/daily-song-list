"use strict";

// Publication-time quality layer for the GitHub Pages static pipeline.
// Keep original day shards untouched: false positives can be restored without re-scraping.
const MIN_COLLISION_VIDEOS = 5;
const MIN_COLLISION_CHANNELS = 5;
const MIN_COLLISION_TITLES = 4;

function unambiguousNonSongReason(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").trim();

  // A foreign prayer broadcast was parsed as a Japanese karaoke song and its
  // identical YouTube description was attached to unrelated VTuber videos.
  // Do not block short numeric song titles alone: "1/2" is a real song.
  if (
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/u.test(title) &&
    /\bSanto Ros[aá]rio\b/iu.test(raw) &&
    /\b(?:Ao vivo|Dia)\b/iu.test(raw) &&
    /(?:\bDia\b|\bAo vivo\b)/iu.test(artist)
  ) return "prayer_broadcast_timeline";

  // A dated, weekday-stamped stream announcement is not a song credit.
  if (
    /(?:Vol[.]?\s*\d+).*(?:配信)\s*(?:20\d{2})[./-]\d{1,2}[./-]\d{1,2}/iu.test(title) &&
    /(?:\(\s*[月火水木金土日]\s*\)|（\s*[月火水木金土日]\s*）)/u.test(raw) &&
    /^[月火水木金土日]$/u.test(artist)
  ) return "dated_stream_announcement";

  if (
    /(?:達成できず|未達成)/u.test(title) &&
    /^\d{1,2}[月火水木金土日]$/u.test(artist) &&
    /^\d{1,2}:\d{2}まで[!！]?(?:達成できず|未達成)[^\n]{0,30}\d{1,2}\/\d{1,2}[月火水木金土日]$/u.test(raw)
  ) return "dated_stream_challenge_result";

  if (
    /\bANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA\b/iu.test(title) &&
    /\bLUCAS\s+12:31\b/iu.test(raw) &&
    /^LUCAS$/iu.test(artist)
  ) return "bible_verse_broadcast";

  // Identified from historical day shards: a spoken transition, not the
  // track title. Do not generalize this to songs with titles like "雑談".
  if (/^雑談パート[①-⑳\d]*$/u.test(title) && /雑談パート/u.test(raw)) {
    return "confirmed_chat_segment_label";
  }
  if (/^(?:枠スタート|歌枠スタート|配信スタート)$/u.test(title) &&
      /^(?:|未記載|不明|未知歌手|unknown)$/iu.test(artist) &&
      /(?:^|[\s　])(?:枠スタート|歌枠スタート|配信スタート)[!！\s　]*$/u.test(raw)) {
    return "confirmed_stream_start_marker";
  }

  // Complete spoken sentence split at the slash in 1/3 by the parser:
  // original: "VTuberのライブ制作費は生身の半分～1/3".
  if (/^VTuberのライブ制作費は生身の半分[～~〜]1$/iu.test(title) &&
      /^3$/u.test(artist) &&
      /VTuberのライブ制作費は生身の半分[～~〜]1\/3/iu.test(raw)) {
    return "spoken_fraction_split_as_artist";
  }

  // Do not apply generic song-title or artist-name dictionaries: they can
  // silently remove real songs with everyday-language titles.
  return null;
}

function repeatedDescriptionSources(videos) {
  const byHash = new Map();
  for (const video of videos) {
    for (const song of video.songs || []) {
      const hash = String(song.sourceHash || "");
      if (!hash || !String(song.sourceId || "").startsWith("description:")) continue;
      if (String(song.raw || "").length < 35) continue;
      let item = byHash.get(hash);
      if (!item) {
        item = { videoIds: new Set(), channels: new Set(), titles: new Set(), rawRows: new Set(), examples: [] };
        byHash.set(hash, item);
      }
      item.videoIds.add(video.videoId);
      item.channels.add(String(video.channelId || video.channelHandle || video.channelName || video.videoId).normalize("NFKC"));
      item.titles.add(String(video.title || "").normalize("NFKC"));
      item.rawRows.add(String(song.raw || "").normalize("NFKC"));
      if (item.examples.length < 3 && !item.examples.some((entry) => entry.videoId === video.videoId)) {
        item.examples.push({ videoId: video.videoId, channelName: video.channelName || "", videoTitle: video.title || "", raw: String(song.raw || "").slice(0, 160) });
      }
    }
  }
  const collisions = new Map();
  for (const [hash, entry] of byHash) {
    if (
      entry.videoIds.size >= MIN_COLLISION_VIDEOS &&
      entry.channels.size >= MIN_COLLISION_CHANNELS &&
      entry.titles.size >= MIN_COLLISION_TITLES &&
      entry.rawRows.size <= 2
    ) {
      collisions.set(hash, {
        reason: "reused_description_across_unrelated_channels",
        videoCount: entry.videoIds.size,
        channelCount: entry.channels.size,
        distinctVideoTitles: entry.titles.size,
        examples: entry.examples,
      });
    }
  }
  return collisions;
}

function normalizeConservativeArtist(song) {
  const artist = String(song?.artist || "");
  const matched = artist.match(/^[/／|｜][\s　]+(.+)$/u);
  if (!matched?.[1]?.trim()) return song;
  // A delimiter copied from "title / artist" should never become part of
  // an artist name. A slash with no following whitespace or DISH// stays.
  return { ...song, artist: matched[1].trim() };
}

function cleanStaticVideos(videos) {
  const collisions = repeatedDescriptionSources(videos);
  const counters = { inputVideos: videos.length, inputOccurrences: 0, visibleVideos: 0, visibleOccurrences: 0, quarantinedOccurrences: 0, quarantinedVideos: 0, normalizedArtistOccurrences: 0, byReason: {} };
  const examples = [];
  const byDay = {};
  const normalizedArtistExamples = [];
  const cleaned = videos.map((video) => {
    const songs = (video.songs || []).filter((song) => {
      counters.inputOccurrences += 1;
      const reason = unambiguousNonSongReason(song) ||
        (String(song.sourceId || "").startsWith("description:") && collisions.has(String(song.sourceHash || ""))
          ? "reused_description_across_unrelated_channels"
          : null);
      if (!reason) return true;
      counters.quarantinedOccurrences += 1;
      const day = String(video.publishedAt || "").slice(0, 10) || "unknown";
      byDay[day] ||= { quarantinedOccurrences: 0, byReason: {} };
      byDay[day].quarantinedOccurrences += 1;
      byDay[day].byReason[reason] = (byDay[day].byReason[reason] || 0) + 1;
      counters.byReason[reason] = (counters.byReason[reason] || 0) + 1;
      if (examples.length < 40) {
        examples.push({
          reason,
          videoId: video.videoId,
          channelName: video.channelName || "",
          occurrenceId: song.occurrenceId || "",
          sourceId: song.sourceId || "",
          sourceHash: song.sourceHash || "",
          title: song.title || "",
          artist: song.artist || "",
          raw: String(song.raw || "").slice(0, 200),
        });
      }
      return false;
    }).map((song) => {
      const normalized = normalizeConservativeArtist(song);
      if (normalized !== song) {
        counters.normalizedArtistOccurrences += 1;
        if (normalizedArtistExamples.length < 25) normalizedArtistExamples.push({
          videoId: video.videoId, title: song.title || "",
          before: song.artist || "", after: normalized.artist, sourceId: song.sourceId || "",
        });
      }
      return normalized;
    });
    if (songs.length) counters.visibleVideos += 1;
    else if ((video.songs || []).length) counters.quarantinedVideos += 1;
    counters.visibleOccurrences += songs.length;
    return { ...video, songs };
  }).filter((video) => video.songs.length);
  if (counters.inputOccurrences && counters.quarantinedOccurrences / counters.inputOccurrences > 0.1) {
    throw new Error("static quality guard quarantined over 10% of all occurrences; manual review required before publishing");
  }
  const audit = {
    schemaVersion: 1,
    policy: "quarantine derived pages only; retain unmodified days/* and state.json",
    ...counters,
    repeatedDescriptionSources: [...collisions].map(([sourceHash, info]) => ({ sourceHash, ...info })),
    byDay,
    normalizedArtistExamples,
    examples,
  };
  return { videos: cleaned, audit };
}

module.exports = { cleanStaticVideos, normalizeConservativeArtist, repeatedDescriptionSources, unambiguousNonSongReason };
