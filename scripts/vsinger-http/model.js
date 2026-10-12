const { sha256 } = require("./html-utils");

const SOURCE_SYSTEM = "vsinger_moment_http";
const MCP_SOURCE_SYSTEM = "vsinger_moment_mcp";

function songEntityFromHttp(song, now = new Date().toISOString()) {
  return {
    canonicalSongId: canonicalSongId(song.externalSongId),
    externalSongId: song.externalSongId,
    displayTitle: song.title || song.rawTitle || song.displayTitle || "",
    displayArtist: song.originalArtist || song.rawArtist || song.displayArtist || "",
    titleAliases: [],
    artistAliases: [],
    sourceSystem: SOURCE_SYSTEM,
    sourceUrl: song.songPageUrl || "",
    provenance: provenance("song", song),
    createdAt: now,
    updatedAt: now,
  };
}

function videoEntityFromHttp(video) {
  return {
    youtubeVideoId: video.youtubeVideoId || "",
    externalVideoId: video.externalVideoId,
    title: video.videoTitle || "",
    singerName: video.singerName || "",
    streamedAt: video.streamedAt || "",
    sourceUrl: video.videoPageUrl || "",
    verificationStatus: "externally_reported",
  };
}

function occurrenceEntitiesFromVideo(video) {
  return (video.setlistSongs || []).map((song) => ({
    youtubeVideoId: video.youtubeVideoId || "",
    canonicalSongId: canonicalSongId(song.externalSongId),
    seconds: song.seconds,
    sourceSystem: SOURCE_SYSTEM,
    externalSongId: song.externalSongId || "",
    externalVideoId: video.externalVideoId || "",
    verificationStatus: "externally_reported",
    provenance: provenance("occurrence", { video, song }),
  }));
}

function dedupeSongs(songs) {
  return dedupeBy(songs, (song) => (song.externalSongId ? `${song.sourceSystem || SOURCE_SYSTEM}:${song.externalSongId}` : ""));
}

function dedupeVideos(videos) {
  return dedupeBy(videos, (video) => video.youtubeVideoId || `external:${video.externalVideoId}`);
}

function dedupeOccurrences(occurrences) {
  return dedupeBy(occurrences, (occurrence) => {
    if (occurrence.youtubeVideoId) return `${occurrence.youtubeVideoId}:${occurrence.canonicalSongId}:${occurrence.seconds ?? ""}`;
    return `${occurrence.externalVideoId}:${occurrence.externalSongId}:${occurrence.seconds ?? ""}`;
  });
}

function applyMcpSupplement(base, supplement) {
  return {
    songs: dedupeSongs([...(base.songs || []), ...(supplement.songs || []).map((song) => ({ ...song, sourceSystem: song.sourceSystem || MCP_SOURCE_SYSTEM }))]),
    videos: dedupeVideos([...(base.videos || []), ...(supplement.videos || [])]),
    occurrences: dedupeOccurrences([...(base.occurrences || []), ...(supplement.occurrences || [])]),
  };
}

function buildNormalizedBundle({ songs = [], videos = [] }, now = new Date().toISOString()) {
  const songEntities = dedupeSongs([...songs, ...songCandidatesFromVideos(videos)].map((song) => songEntityFromHttp(song, now)));
  const videoEntities = dedupeVideos(videos.map(videoEntityFromHttp));
  const occurrenceEntities = dedupeOccurrences(videos.flatMap(occurrenceEntitiesFromVideo));
  return {
    schemaVersion: 1,
    sourceSystem: SOURCE_SYSTEM,
    generatedAt: now,
    songs: songEntities,
    videos: videoEntities,
    occurrences: occurrenceEntities,
    counts: {
      songs: songEntities.length,
      videos: videoEntities.length,
      occurrences: occurrenceEntities.length,
    },
  };
}

function songCandidatesFromVideos(videos = []) {
  const candidates = [];
  for (const video of videos) {
    for (const song of video.setlistSongs || []) {
      if (!song.externalSongId) continue;
      candidates.push({
        externalSongId: song.externalSongId,
        rawTitle: song.rawTitle || "",
        rawArtist: song.rawArtist || "",
        songPageUrl: song.songPageUrl || "",
        sourceSystem: SOURCE_SYSTEM,
        fetchedAt: video.fetchedAt || new Date().toISOString(),
        rawHash: video.rawHash || "",
        provenanceVideoId: video.externalVideoId || "",
      });
    }
  }
  return candidates;
}

function canonicalSongId(externalSongId) {
  return externalSongId ? `vsinger:${externalSongId}` : "";
}

function provenance(kind, payload) {
  return {
    kind,
    sourceSystem: SOURCE_SYSTEM,
    hash: sha256(JSON.stringify(payload)),
  };
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

module.exports = {
  MCP_SOURCE_SYSTEM,
  SOURCE_SYSTEM,
  applyMcpSupplement,
  buildNormalizedBundle,
  canonicalSongId,
  dedupeOccurrences,
  dedupeSongs,
  dedupeVideos,
  occurrenceEntitiesFromVideo,
  songCandidatesFromVideos,
  songEntityFromHttp,
  videoEntityFromHttp,
};
