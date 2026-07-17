#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { readJson, writeJson } = require("./bundle-writer");
const {
  createClient,
  loadCheckpoint,
  loadRobots,
  parseArgs,
  requestStatsFromPages,
  saveCheckpoint,
  stopRecord,
  writeRunOutput,
} = require("./crawl-core");
const { dedupeOccurrences, dedupeSongs, dedupeVideos, occurrenceEntitiesFromVideo } = require("./model");
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
  const checkpointPath = args.checkpoint || path.join(outputDir, "checkpoint.json");
  const checkpoint = args.fresh ? null : loadCheckpoint(checkpointPath);
  const maxSingersPerRun = args["max-singers"] ? Number(args["max-singers"]) : Infinity;
  const maxSongPages = args["max-song-pages"] ? Number(args["max-song-pages"]) : Infinity;
  const maxSongDetails = args["max-song-details"] ? Number(args["max-song-details"]) : args["fetch-song-details"] ? Infinity : 0;
  const robots = args.robots || (await loadRobots(client));
  const ownerPermission = ownerPermissionFromArgs(args, robots);
  const allSingers = loadSingerTargets(args);
  const state = loadSingerSongsState(outputDir, args);
  let nextSingerIndex = normalizeStartSingerIndex(checkpoint, allSingers);
  const targetEndIndex = Math.min(allSingers.length, nextSingerIndex + maxSingersPerRun);
  let stop = null;
  let currentSingerCheckpoint = null;

  for (let singerIndex = nextSingerIndex; singerIndex < targetEndIndex; singerIndex += 1) {
    const singer = allSingers[singerIndex];
    const singerCheckpoint = checkpointForSinger(checkpoint, singer, singerIndex);
    const report = await crawlSingleSinger({
      client,
      singer,
      singerIndex,
      maxSongPages,
      maxSongDetails,
      state,
      checkpoint: singerCheckpoint,
      onProgress: ({ currentSinger, report: progressReport }) => {
        upsertSingerReport(state.singerReports, progressReport);
        persistSingerSongsRun({
          outputDir,
          checkpointPath,
          state,
          ownerPermission,
          stop: stopRecord("in-progress", { externalSingerId: singer.externalSingerId, nextPageUrl: currentSinger.nextPageUrl }),
          allSingers,
          nextSingerIndex: singerIndex,
          currentSinger,
          fetchSongDetails: Boolean(args["fetch-song-details"]),
          maxSongDetails,
        });
      },
    });
    upsertSingerReport(state.singerReports, report);

    if (report.resumeCheckpoint) {
      stop = report.stop;
      nextSingerIndex = singerIndex;
      currentSingerCheckpoint = report.resumeCheckpoint;
      persistSingerSongsRun({
        outputDir,
        checkpointPath,
        state,
        ownerPermission,
        stop,
        allSingers,
        nextSingerIndex,
        currentSinger: currentSingerCheckpoint,
        fetchSongDetails: Boolean(args["fetch-song-details"]),
        maxSongDetails,
      });
      break;
    }

    nextSingerIndex = singerIndex + 1;
    currentSingerCheckpoint = null;
    persistSingerSongsRun({
      outputDir,
      checkpointPath,
      state,
      ownerPermission,
      stop: stopRecord("completed-singer", { externalSingerId: singer.externalSingerId }),
      allSingers,
      nextSingerIndex,
      currentSinger: null,
      fetchSongDetails: Boolean(args["fetch-song-details"]),
      maxSongDetails,
    });
  }

  if (!stop) {
    stop =
      nextSingerIndex < allSingers.length && Number.isFinite(maxSingersPerRun)
        ? stopRecord("max-singers", { maxSingers: maxSingersPerRun, nextSingerIndex })
        : stopRecord("completed-targets", { singerCount: allSingers.length });
  }

  return persistSingerSongsRun({
    outputDir,
    checkpointPath,
    state,
    ownerPermission,
    stop,
    allSingers,
    nextSingerIndex,
    currentSinger: currentSingerCheckpoint,
    fetchSongDetails: Boolean(args["fetch-song-details"]),
    maxSongDetails,
  });
}

async function crawlSingleSinger({ client, singer, singerIndex, maxSongPages, maxSongDetails, state, checkpoint, onProgress }) {
  const visitedUrls = new Set(checkpoint?.visitedUrls || []);
  const discoveredSongIds = new Set(checkpoint?.discoveredSongIds || []);
  let nextPageUrl = checkpoint?.nextPageUrl || singer.singerSongsUrl || singerSongsUrl(singer);
  let pageCount = Number(checkpoint?.pageCount || 0);
  let detailPagesFetched = Number(checkpoint?.detailPagesFetched || 0);
  let rawRowCount = Number(checkpoint?.rawRowCount || 0);
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
      state.failures.push(stop);
      break;
    }

    const parsed = parseSongsPage(response.body, nextPageUrl);
    pageCount += 1;
    rawRowCount += parsed.rawRowCount;
    state.pages.push({
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
        state.songs.push({
          ...song,
          singerId: singer.externalSingerId,
          singerName: singer.singerName,
          singerSongPageUrl: nextPageUrl,
        });
      }
      if (state.detailPages.length >= maxSongDetails) continue;
      const detail = await fetchSongOccurrenceDetail({ client, song, singer, state });
      if (detail) detailPagesFetched += 1;
    }

    const currentSinger = singerCheckpoint({
      singer,
      singerIndex,
      nextPageUrl: parsed.nextPageUrl,
      visitedUrls,
      discoveredSongIds,
      pageCount,
      rawRowCount,
      detailPagesFetched,
    });
    onProgress?.({
      currentSinger,
      report: singerReport({ singer, stop: stopRecord("in-progress", { nextPageUrl: parsed.nextPageUrl }), pageCount, rawRowCount, discoveredSongIds, detailPagesFetched }),
    });

    if (!parsed.nextPageUrl) {
      stop = stopRecord("no-next-cursor", { pageUrl: nextPageUrl });
      break;
    }
    nextPageUrl = parsed.nextPageUrl;
  }

  if (!stop && !nextPageUrl) stop = stopRecord("no-next-cursor", { externalSingerId: singer.externalSingerId });
  if (!stop && pageCount >= maxSongPages) stop = stopRecord("max-song-pages", { maxSongPages, externalSingerId: singer.externalSingerId });
  const resumeCheckpoint = stop && stop.reason !== "no-next-cursor" ? singerCheckpoint({ singer, singerIndex, nextPageUrl, visitedUrls, discoveredSongIds, pageCount, rawRowCount, detailPagesFetched }) : null;
  return {
    ...singerReport({ singer, stop, pageCount, rawRowCount, discoveredSongIds, detailPagesFetched }),
    resumeCheckpoint,
  };
}

function singerReport({ singer, stop, pageCount, rawRowCount, discoveredSongIds, detailPagesFetched }) {
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

async function fetchSongOccurrenceDetail({ client, song, singer, state }) {
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
    state.rawOccurrences.push(...occurrences);
    state.detailPages.push({
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
    state.failures.push(failure);
    return null;
  }
}

function loadSingerSongsState(outputDir, args) {
  if (args.fresh) return emptySingerSongsState();
  const previous = readJson(path.join(outputDir, "crawl.json"), {});
  return {
    pages: Array.isArray(previous.pages) ? previous.pages : [],
    detailPages: Array.isArray(previous.detailPages) ? previous.detailPages : [],
    failures: Array.isArray(previous.failures) ? previous.failures : [],
    songs: readJson(path.join(outputDir, "songs.json"), previous.songs || []),
    rawOccurrences: readJson(path.join(outputDir, "raw-occurrences.json"), previous.rawOccurrences || []),
    singerReports: Array.isArray(previous.singers) ? previous.singers : [],
  };
}

function emptySingerSongsState() {
  return {
    pages: [],
    detailPages: [],
    failures: [],
    songs: [],
    rawOccurrences: [],
    singerReports: [],
  };
}

function normalizeStartSingerIndex(checkpoint, singers) {
  if (checkpoint?.currentSinger && singerAtIndexMatches(singers, checkpoint.currentSinger.singerIndex, checkpoint.currentSinger.externalSingerId)) {
    return checkpoint.currentSinger.singerIndex;
  }
  const nextSingerIndex = Number(checkpoint?.nextSingerIndex || 0);
  if (!Number.isFinite(nextSingerIndex)) return 0;
  return Math.max(0, Math.min(nextSingerIndex, singers.length));
}

function checkpointForSinger(checkpoint, singer, singerIndex) {
  if (!checkpoint?.currentSinger) return null;
  if (checkpoint.currentSinger.singerIndex !== singerIndex) return null;
  if (checkpoint.currentSinger.externalSingerId !== singer.externalSingerId) return null;
  return checkpoint.currentSinger;
}

function singerAtIndexMatches(singers, singerIndex, externalSingerId) {
  return singerIndex >= 0 && singerIndex < singers.length && singers[singerIndex]?.externalSingerId === externalSingerId;
}

function singerCheckpoint({ singer, singerIndex, nextPageUrl, visitedUrls, discoveredSongIds, pageCount, rawRowCount, detailPagesFetched }) {
  return {
    singerIndex,
    externalSingerId: singer.externalSingerId,
    singerName: singer.singerName,
    nextPageUrl: nextPageUrl || "",
    visitedUrls: [...visitedUrls],
    discoveredSongIds: [...discoveredSongIds],
    pageCount,
    rawRowCount,
    detailPagesFetched,
  };
}

function upsertSingerReport(reports, report) {
  const index = reports.findIndex((item) => item.externalSingerId === report.externalSingerId);
  if (index >= 0) reports[index] = report;
  else reports.push(report);
}

function persistSingerSongsRun({ outputDir, checkpointPath, state, ownerPermission, stop, allSingers, nextSingerIndex, currentSinger, fetchSongDetails, maxSongDetails }) {
  const result = buildSingerSongsResult({
    state,
    ownerPermission,
    stop,
    allSingers,
    nextSingerIndex,
    currentSinger,
    fetchSongDetails,
    maxSongDetails,
  });

  writeRunOutput(outputDir, "crawl", result);
  writeJson(path.join(outputDir, "songs.json"), result.songs);
  writeJson(path.join(outputDir, "videos.json"), result.videos);
  writeJson(path.join(outputDir, "occurrences.json"), result.occurrences);
  writeJson(path.join(outputDir, "raw-occurrences.json"), result.rawOccurrences);
  writeJson(path.join(outputDir, "sync-state.json"), buildSyncState(result));
  saveCheckpoint(checkpointPath, buildCheckpoint(result, currentSinger));
  return result;
}

function buildSingerSongsResult({ state, ownerPermission, stop, allSingers, nextSingerIndex, currentSinger, fetchSongDetails, maxSongDetails }) {
  const uniqueSongs = dedupeSongs(state.songs).map((song) => ({
    ...song,
    permissionSource: song.permissionSource || (ownerPermission.enabled ? "site_owner_permission" : "robots_allowed"),
  }));
  const rawOccurrences = dedupeRawOccurrences(state.rawOccurrences);
  const videos = dedupeVideos(videosFromSingerOccurrences(rawOccurrences));
  const occurrences = dedupeOccurrences(videos.flatMap(occurrenceEntitiesFromVideo));
  const detailCoverageStatus = classifyDetailCoverage({ fetchSongDetails, maxSongDetails, uniqueSongCount: uniqueSongs.length, detailPageCount: state.detailPages.length, failures: state.failures });
  const coverageStatus = classifySingerSongsCoverage({
    stop,
    allSingers,
    nextSingerIndex,
    currentSinger,
    singerReports: state.singerReports,
    detailCoverageStatus,
    failures: state.failures,
  });

  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-songs-crawl",
    generatedAt: new Date().toISOString(),
    ownerPermission,
    stop,
    singerTargetCount: allSingers.length,
    nextSingerIndex,
    remainingSingerCount: Math.max(0, allSingers.length - nextSingerIndex),
    currentSinger: currentSinger
      ? {
          singerIndex: currentSinger.singerIndex,
          externalSingerId: currentSinger.externalSingerId,
          singerName: currentSinger.singerName,
          nextPageUrl: currentSinger.nextPageUrl,
          pageCount: currentSinger.pageCount,
          rawRowCount: currentSinger.rawRowCount,
          uniqueSongCount: currentSinger.discoveredSongIds.length,
          detailPagesFetched: currentSinger.detailPagesFetched,
        }
      : null,
    singersProcessed: state.singerReports.length,
    pageCount: state.pages.length,
    detailPageCount: state.detailPages.length,
    rawSongRowCount: state.pages.reduce((sum, page) => sum + (Number(page.rawRowCount) || 0), 0),
    uniqueSongCount: uniqueSongs.length,
    rawOccurrenceCount: rawOccurrences.length,
    occurrenceCount: occurrences.length,
    uniqueVideoCount: videos.length,
    detailCoverageStatus,
    coverageStatus,
    requestStats: requestStatsFromPages([...state.pages, ...state.detailPages]),
    singers: state.singerReports,
    pages: state.pages,
    detailPages: state.detailPages,
    songs: uniqueSongs,
    videos,
    occurrences,
    rawOccurrences,
    failures: state.failures,
  };
}

function buildSyncState(result) {
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-sync-state",
    updatedAt: result.generatedAt,
    lastSuccessfulSingerSongsCrawl: {
      finishedAt: result.generatedAt,
      coverageStatus: result.coverageStatus,
      detailCoverageStatus: result.detailCoverageStatus,
      stopReason: result.stop?.reason || "",
      singersProcessed: result.singersProcessed,
      singerTargetCount: result.singerTargetCount,
      nextSingerIndex: result.nextSingerIndex,
      remainingSingerCount: result.remainingSingerCount,
      uniqueSongCount: result.uniqueSongCount,
      occurrenceCount: result.occurrenceCount,
    },
    ownerPermission: result.ownerPermission,
    knownSingerIds: result.singers.map((report) => report.externalSingerId),
    knownSongIds: result.songs.map((song) => song.externalSongId),
    knownExternalVideoIds: result.videos.map((video) => video.externalVideoId),
    cursorCheckpoint: {
      nextSingerIndex: result.nextSingerIndex,
      currentSinger: result.currentSinger,
    },
    coverageStatus: result.coverageStatus,
  };
}

function buildCheckpoint(result, currentSinger) {
  return {
    schemaVersion: 1,
    kind: "vsinger-moment-http-singer-songs-checkpoint",
    updatedAt: result.generatedAt,
    ownerPermission: result.ownerPermission,
    singerTargetCount: result.singerTargetCount,
    nextSingerIndex: result.nextSingerIndex,
    remainingSingerCount: result.remainingSingerCount,
    currentSinger,
    knownSongIds: result.songs.map((song) => song.externalSongId),
    knownExternalVideoIds: result.videos.map((video) => video.externalVideoId),
    coverageStatus: result.coverageStatus,
  };
}

function classifyDetailCoverage({ fetchSongDetails, maxSongDetails, uniqueSongCount, detailPageCount, failures }) {
  if (!fetchSongDetails || Number.isFinite(maxSongDetails)) return "partial";
  if (failures.length) return "partial";
  return detailPageCount >= uniqueSongCount ? "complete" : "partial";
}

function classifySingerSongsCoverage({ stop, allSingers, nextSingerIndex, currentSinger, singerReports, detailCoverageStatus, failures }) {
  if (failures.length) return "partial";
  if (currentSinger) return "partial";
  if (nextSingerIndex < allSingers.length) return "partial";
  if (detailCoverageStatus !== "complete") return "partial";
  if (!singerReports.length && allSingers.length) return "partial";
  return singerReports.every((report) => report.stop?.reason === "no-next-cursor") && stop?.reason === "completed-targets" ? "complete" : "partial";
}

function dedupeRawOccurrences(occurrences) {
  const seen = new Set();
  const result = [];
  for (const occurrence of occurrences || []) {
    const key = [
      occurrence.singerId || "",
      occurrence.externalSongId || "",
      occurrence.externalVideoId || "",
      occurrence.youtubeVideoId || "",
      occurrence.seconds ?? "",
      occurrence.timestampText || "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(occurrence);
  }
  return result;
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
