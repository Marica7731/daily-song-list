#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { writeJson } = require("./bundle-writer");
const {
  createClient,
  loadRobots,
  parseArgs,
  requestStatsFromPages,
  stopRecord,
  writeRunOutput,
} = require("./crawl-core");
const { dedupeOccurrences, dedupeSongs, dedupeVideos, occurrenceEntitiesFromVideo, songEntityFromHttp } = require("./model");
const { parseSongOccurrencesPage, parseSongsPage } = require("./parsers");

function ownerPermissionFromArgs(args, robots) {
  const enabled = Boolean(args["owner-permission"]) || process.env.VSINGER_OWNER_PERMISSION === "1";
  const note = args["owner-permission-note"] || process.env.VSINGER_OWNER_PERMISSION_NOTE || "operator asserted site-owner permission";
  if (!robots.singerSongsQueryAllowed && !enabled) {
    const error = new Error("robots.txt disallows singerId query URLs. Re-run only with --owner-permission after confirming site-owner authorization.");
    error.code = "SINGER_QUERY_REQUIRES_OWNER_PERMISSION";
    throw error;
  }
  return {
    enabled,
    note,
    acceptedAt: enabled ? new Date().toISOString() : "",
    robotsSingerSongsQueryAllowed: robots.singerSongsQueryAllowed,
  };
}

async function crawlSingerSongs(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill", "singer-songs");
  const maxSingers = args["max-singers"] ? Number(args["max-singers"]) : Infinity;
  const maxSongPages = args["max-song-pages"] ? Number(args["max-song-pages"]) : Infinity;
  const maxSongDetails = args["max-song-details"] ? Number(args["max-song-details"]) : args["fetch-song-details"] ? Infinity : 0;
  const robots = args.robots || (await loadRobots(client));
  const ownerPermission = ownerPermissionFromArgs(args, robots);
  const singers = loadSingerTargets(args).slice(0, maxSingers);

  const pages = [];
  const detailPages = [];
  const failures = [];
  const songs = [];
  const rawOccurrences = [];
  const singerReports = [];
  let songDetailFetchCount = 0;
  let stop = null;

  for (const singer of singers) {
    const report = await crawlSingleSinger({ client, singer, args, maxSongPages, maxSongDetails, songDetailFetchCount, pages, detailPages, songs, rawOccurrences, failures });
    singerReports.push(report);
    songDetailFetchCount += report.detailPagesFetched;
    if (Number.isFinite(maxSongDetails) && songDetailFetchCount >= maxSongDetails) stop = stopRecord("max-song-details", { maxSongDetails });
  }

  if (!stop) stop = Number.isFinite(maxSingers) && singers.length >= maxSingers ? stopRecord("max-singers", { maxSingers }) : stopRecord("completed-targets", { singerCount: singers.length });

  const uniqueSongs = dedupeSongs(songs).map((song) => ({
    ...song,
    permissionSource: ownerPermission.enabled ? "site_owner_permission" : "robots_allowed",
  }));
  const videos = dedupeVideos(videosFromSingerOccurrences(rawOccurrences));
  const occurrences = dedupeOccurrences(videos.flatMap(occurrenceEntitiesFromVideo));
  const result = {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-songs-crawl",
    generatedAt: new Date().toISOString(),
    ownerPermission,
    stop,
    singersProcessed: singers.length,
    pageCount: pages.length,
    detailPageCount: detailPages.length,
    rawSongRowCount: songs.length,
    uniqueSongCount: uniqueSongs.length,
    rawOccurrenceCount: rawOccurrences.length,
    occurrenceCount: occurrences.length,
    uniqueVideoCount: videos.length,
    coverageStatus: stop.reason === "completed-targets" ? "partial" : "partial",
    requestStats: requestStatsFromPages([...pages, ...detailPages]),
    singers: singerReports,
    pages,
    detailPages,
    songs: uniqueSongs,
    videos,
    occurrences,
    rawOccurrences,
    failures,
  };

  writeRunOutput(outputDir, "crawl", result);
  writeJson(path.join(outputDir, "songs.json"), uniqueSongs);
  writeJson(path.join(outputDir, "videos.json"), videos);
  writeJson(path.join(outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(outputDir, "raw-occurrences.json"), rawOccurrences);
  writeJson(path.join(outputDir, "sync-state.json"), {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulSingerSongsCrawl: {
      finishedAt: result.generatedAt,
      coverageStatus: result.coverageStatus,
      stopReason: result.stop?.reason || "",
      singersProcessed: result.singersProcessed,
      uniqueSongCount: result.uniqueSongCount,
      occurrenceCount: result.occurrenceCount,
    },
    ownerPermission: result.ownerPermission,
    knownSingerIds: singerReports.map((report) => report.externalSingerId),
    knownSongIds: uniqueSongs.map((song) => song.externalSongId),
    knownExternalVideoIds: videos.map((video) => video.externalVideoId),
    coverageStatus: result.coverageStatus,
  });
  return result;
}

async function crawlSingleSinger({ client, singer, args, maxSongPages, maxSongDetails, songDetailFetchCount, pages, detailPages, songs, rawOccurrences, failures }) {
  const visitedUrls = new Set();
  const discoveredSongIds = new Set();
  let nextPageUrl = singer.singerSongsUrl || singerSongsUrl(singer);
  let pageCount = 0;
  let detailPagesFetched = 0;
  let rawRowCount = 0;
  let stop = null;

  while (nextPageUrl && pageCount < maxSongPages) {
    if (visitedUrls.has(nextPageUrl)) {
      stop = stopRecord("cursor-loop", { nextPageUrl, externalSingerId: singer.externalSingerId });
      break;
    }
    visitedUrls.add(nextPageUrl);

    let response;
    try {
      response = await client.getText(nextPageUrl);
    } catch (error) {
      stop = stopRecord("http-error", { message: error.message, status: error.status || null, url: nextPageUrl });
      failures.push(stop);
      break;
    }

    const parsed = parseSongsPage(response.body, nextPageUrl);
    pageCount += 1;
    rawRowCount += parsed.rawRowCount;
    pages.push({
      pageUrl: nextPageUrl,
      pageHash: parsed.pageHash,
      externalSingerId: singer.externalSingerId,
      rawRowCount: parsed.rawRowCount,
      nextPageUrl: parsed.nextPageUrl,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      fromCache: response.fromCache,
    });

    for (const song of parsed.songs) {
      if (!discoveredSongIds.has(song.externalSongId)) {
        discoveredSongIds.add(song.externalSongId);
        songs.push({
          ...song,
          singerId: singer.externalSingerId,
          singerName: singer.singerName,
          singerSongPageUrl: nextPageUrl,
        });
      }
      if (songDetailFetchCount + detailPagesFetched >= maxSongDetails) continue;
      const detail = await fetchSongOccurrenceDetail({ client, song, singer, detailPages, rawOccurrences, failures });
      if (detail) detailPagesFetched += 1;
    }

    if (!parsed.nextPageUrl) {
      stop = stopRecord("no-next-cursor", { pageUrl: nextPageUrl });
      break;
    }
    nextPageUrl = parsed.nextPageUrl;
  }

  if (!stop && pageCount >= maxSongPages) stop = stopRecord("max-song-pages", { maxSongPages, externalSingerId: singer.externalSingerId });
  return {
    externalSingerId: singer.externalSingerId,
    singerName: singer.singerName,
    stop,
    pageCount,
    rawRowCount,
    uniqueSongCount: discoveredSongIds.size,
    detailPagesFetched,
  };
}

async function fetchSongOccurrenceDetail({ client, song, singer, detailPages, rawOccurrences, failures }) {
  try {
    const response = await client.getText(song.songPageUrl);
    const parsed = parseSongOccurrencesPage(response.body, song.songPageUrl);
    const occurrences = parsed.occurrences.map((occurrence) => ({
      ...occurrence,
      singerId: occurrence.singerId || singer.externalSingerId,
      singerName: occurrence.singerName || singer.singerName,
      rawTitle: occurrence.rawTitle || song.title,
      rawArtist: occurrence.rawArtist || song.originalArtist || null,
      songPageUrl: occurrence.songPageUrl || song.songPageUrl,
    }));
    rawOccurrences.push(...occurrences);
    detailPages.push({
      pageUrl: song.songPageUrl,
      pageHash: parsed.rawHash,
      externalSingerId: singer.externalSingerId,
      externalSongId: song.externalSongId,
      occurrenceCount: occurrences.length,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      fromCache: response.fromCache,
    });
    return parsed;
  } catch (error) {
    const failure = stopRecord("http-error", { message: error.message, status: error.status || null, url: song.songPageUrl, externalSongId: song.externalSongId });
    failures.push(failure);
    return null;
  }
}

function loadSingerTargets(args) {
  if (args["singers-file"]) {
    const filePayload = JSON.parse(fs.readFileSync(args["singers-file"], "utf8"));
    const singers = Array.isArray(filePayload) ? filePayload : filePayload.singers || [];
    return singers.map(normalizeSingerTarget).filter((singer) => singer.externalSingerId);
  }
  const externalSingerId = args["singer-id"];
  if (!externalSingerId) throw new Error("Provide --singer-id or --singers-file.");
  return [
    normalizeSingerTarget({
      externalSingerId,
      singerName: args["singer-name"] || "",
      singerSongsUrl: args["start-url"] || "",
    }),
  ];
}

function normalizeSingerTarget(singer) {
  return {
    externalSingerId: singer.externalSingerId || singer.singerId || "",
    singerName: singer.singerName || singer.name || "",
    singerSongsUrl: singer.singerSongsUrl || "",
  };
}

function singerSongsUrl(singer) {
  const url = new URL("https://vsinger-moment.jp/songs");
  url.searchParams.set("singerId", singer.externalSingerId);
  if (singer.singerName) url.searchParams.set("singerName", singer.singerName);
  return url.toString();
}

function videosFromSingerOccurrences(occurrences) {
  const byKey = new Map();
  for (const occurrence of occurrences) {
    const key = occurrence.youtubeVideoId || `external:${occurrence.externalVideoId}`;
    if (!key || key === "external:") continue;
    const video = byKey.get(key) || {
      externalVideoId: occurrence.externalVideoId,
      youtubeVideoId: occurrence.youtubeVideoId,
      youtubeUrl: occurrence.youtubeUrl,
      videoPageUrl: occurrence.videoPageUrl,
      videoTitle: occurrence.videoTitle,
      singerId: occurrence.singerId,
      singerName: occurrence.singerName,
      streamedAt: occurrence.streamedAt,
      thumbnailUrl: "",
      setlistStatus: "partial",
      setlistSongs: [],
      sourceSystem: "vsinger_moment_http",
      fetchedAt: occurrence.fetchedAt,
      rawHash: occurrence.rawHash,
    };
    video.setlistSongs.push({
      externalSongId: occurrence.externalSongId,
      rawTitle: occurrence.rawTitle,
      rawArtist: occurrence.rawArtist,
      seconds: occurrence.seconds,
      timestampText: occurrence.timestampText,
      songPageUrl: occurrence.songPageUrl,
    });
    byKey.set(key, video);
  }
  return [...byKey.values()].map((video) => ({
    ...video,
    setlistSongs: uniqueSetlistSongs(video.setlistSongs),
  }));
}

function uniqueSetlistSongs(songs) {
  const seen = new Set();
  const result = [];
  for (const song of songs) {
    const key = `${song.externalSongId}:${song.seconds}:${song.rawTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(song);
  }
  return result;
}

if (require.main === module) {
  crawlSingerSongs(parseArgs())
    .then((result) => {
      console.log(
        `CODEX_VSINGER_SINGER_SONGS_CRAWL_OK singers=${result.singersProcessed} songs=${result.uniqueSongCount} videos=${result.uniqueVideoCount} occurrences=${result.occurrenceCount} details=${result.detailPageCount} permission=${result.ownerPermission.enabled}`,
      );
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  crawlSingerSongs,
  ownerPermissionFromArgs,
  videosFromSingerOccurrences,
};
