#!/usr/bin/env node
const path = require("node:path");

const { writeJson } = require("./bundle-writer");
const { createClient, ensureRobotsAllowed, loadRobots, parseArgs, requestStatsFromPages } = require("./crawl-core");
const { parseSongDetailPage, parseSongsPage, parseStreamsPage, parseVideoDetailPage } = require("./parsers");

async function probePublicPages(options = {}) {
  const args = { ...options };
  const client = args.client || createClient(args);
  const outputDir = args["output-dir"] || path.resolve(process.cwd(), "artifacts", "vsinger-http-backfill");
  const startedAt = Date.now();

  const robots = await loadRobots(client);
  ensureRobotsAllowed(robots, "songs");
  ensureRobotsAllowed(robots, "streams");
  ensureRobotsAllowed(robots, "videos");

  const requestRecords = [];
  const songsResponse = await client.getText("/songs");
  requestRecords.push(record("/songs", songsResponse));
  const songsPage = parseSongsPage(songsResponse.body, songsResponse.url);

  const songsCursorResponse = songsPage.nextPageUrl ? await client.getText(songsPage.nextPageUrl) : null;
  if (songsCursorResponse) requestRecords.push(record("/songs?cursor=...", songsCursorResponse));
  const songsCursorPage = songsCursorResponse ? parseSongsPage(songsCursorResponse.body, songsCursorResponse.url) : null;

  const streamsResponse = await client.getText("/streams");
  requestRecords.push(record("/streams", streamsResponse));
  const streamsPage = parseStreamsPage(streamsResponse.body, streamsResponse.url);

  const streamsCursorResponse = streamsPage.nextPageUrl ? await client.getText(streamsPage.nextPageUrl) : null;
  if (streamsCursorResponse) requestRecords.push(record("/streams?cursor=...", streamsCursorResponse));
  const streamsCursorPage = streamsCursorResponse ? parseStreamsPage(streamsCursorResponse.body, streamsCursorResponse.url) : null;

  const firstSong = songsPage.songs[0];
  const songDetailResponse = firstSong ? await client.getText(firstSong.songPageUrl) : null;
  if (songDetailResponse) requestRecords.push(record("/songs/{uuid}", songDetailResponse));
  const songDetail = songDetailResponse ? parseSongDetailPage(songDetailResponse.body, songDetailResponse.url) : null;

  const videoForDetail = streamsPage.videos.find((video) => video.setlistSongs.length) || streamsPage.videos[0];
  const videoDetailResponse = videoForDetail ? await client.getText(videoForDetail.videoPageUrl) : null;
  if (videoDetailResponse) requestRecords.push(record("/videos/{uuid}", videoDetailResponse));
  const videoDetail = videoDetailResponse ? parseVideoDetailPage(videoDetailResponse.body, videoDetailResponse.url) : null;

  const report = {
    schemaVersion: 1,
    kind: "vsinger-moment-public-html-probe",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    robots: {
      status: robots.response.status,
      fetchedAt: robots.response.headers.date || "",
      songsAllowed: robots.songsAllowed,
      streamsAllowed: robots.streamsAllowed,
      videosAllowed: robots.videosAllowed,
      apiAllowed: robots.apiAllowed,
      crawlDelaySeconds: robots.crawlDelay,
    },
    songs: {
      firstPageRows: songsPage.songs.length,
      cursorPageRows: songsCursorPage?.songs.length || 0,
      observedSiteSongCount: songsPage.observedSiteSongCount,
      nextCursorUrl: songsPage.nextPageUrl,
      cursorLocation: songsPage.nextPageUrl ? 'a[href^="/songs?cursor="]' : "",
      detailLinkFormat: songsPage.linkFormats.songDetail,
      youtubeLinkFormat: songsPage.linkFormats.youtube || songDetail?.youtubeLinkFormat || "",
      sampleSongDetail: songDetail,
    },
    streams: {
      firstPageRows: streamsPage.videos.length,
      cursorPageRows: streamsCursorPage?.videos.length || 0,
      nextCursorUrl: streamsPage.nextPageUrl,
      cursorLocation: streamsPage.nextPageUrl ? 'a[href^="/streams?cursor="]' : "",
      detailLinkFormat: streamsPage.linkFormats.videoDetail,
      songDetailLinkFormat: streamsPage.linkFormats.songDetail,
      youtubeLinkFormat: streamsPage.linkFormats.youtube || videoDetail?.youtubeUrl ? "https://www.youtube.com/watch?v={videoId}" : "",
      setlistPresentInHtml: streamsPage.setlistPresentInHtml,
      firstPageSetlistVideos: streamsPage.videos.filter((video) => video.setlistSongs.length).length,
      firstPageOccurrenceCount: streamsPage.videos.reduce((sum, video) => sum + video.setlistSongs.length, 0),
      sampleVideoDetail: videoDetail,
    },
    requests: requestRecords,
    requestStats: requestStatsFromPages(requestRecords),
  };

  writeJson(path.join(outputDir, "probe.json"), report);
  writeProbeMarkdown(path.join(outputDir, "probe.md"), report);
  return report;
}

function record(label, response) {
  return {
    label,
    url: response.url,
    status: response.status,
    bytes: response.bytes,
    elapsedMs: response.elapsedMs,
    fromCache: response.fromCache,
    etag: response.headers.etag || "",
    lastModified: response.headers["last-modified"] || "",
  };
}

function writeProbeMarkdown(filePath, report) {
  const lines = [
    "# VSinger Moment Public HTML Probe",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "## Robots",
    "",
    `- /songs allowed: ${report.robots.songsAllowed}`,
    `- /streams allowed: ${report.robots.streamsAllowed}`,
    `- /videos allowed: ${report.robots.videosAllowed}`,
    `- /api allowed: ${report.robots.apiAllowed}`,
    `- Crawl-delay: ${report.robots.crawlDelaySeconds ?? "not specified"} second(s)`,
    "",
    "## Songs",
    "",
    `- First page rows: ${report.songs.firstPageRows}`,
    `- Cursor page rows: ${report.songs.cursorPageRows}`,
    `- Observed site song count: ${report.songs.observedSiteSongCount ?? "unknown"}`,
    `- Next cursor location: ${report.songs.cursorLocation || "not found"}`,
    `- Detail link format: ${report.songs.detailLinkFormat || "not found"}`,
    `- YouTube link format: ${report.songs.youtubeLinkFormat || "not found"}`,
    "",
    "## Streams",
    "",
    `- First page rows: ${report.streams.firstPageRows}`,
    `- Cursor page rows: ${report.streams.cursorPageRows}`,
    `- Next cursor location: ${report.streams.cursorLocation || "not found"}`,
    `- Video detail link format: ${report.streams.detailLinkFormat || "not found"}`,
    `- Song detail link format: ${report.streams.songDetailLinkFormat || "not found"}`,
    `- YouTube link format: ${report.streams.youtubeLinkFormat || "not found"}`,
    `- Setlist exists in list HTML: ${report.streams.setlistPresentInHtml}`,
    `- First page setlist videos: ${report.streams.firstPageSetlistVideos}`,
    `- First page occurrence count: ${report.streams.firstPageOccurrenceCount}`,
    "",
    "## Requests",
    "",
    "| Label | Status | Bytes | Elapsed ms | URL |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.requests.map((request) => `| ${request.label} | ${request.status} | ${request.bytes} | ${request.elapsedMs} | ${request.url} |`),
    "",
  ];
  require("node:fs").mkdirSync(require("node:path").dirname(filePath), { recursive: true });
  require("node:fs").writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

if (require.main === module) {
  probePublicPages(parseArgs())
    .then((report) => {
      console.log(
        `CODEX_VSINGER_PROBE_OK songsAllowed=${report.robots.songsAllowed} streamsAllowed=${report.robots.streamsAllowed} crawlDelay=${report.robots.crawlDelaySeconds} songsRows=${report.songs.firstPageRows} streamRows=${report.streams.firstPageRows}`,
      );
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  probePublicPages,
};
