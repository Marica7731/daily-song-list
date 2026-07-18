const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { VsingerHttpClient, VsingerHttpError } = require("../scripts/vsinger-http/http-client");
const { parseYouTubeVideoId } = require("../scripts/vsinger-http/html-utils");
const { writeShardedBundle, readJson, writeJson } = require("../scripts/vsinger-http/bundle-writer");
const { buildBackfillBundle } = require("../scripts/vsinger-http/build-backfill-bundle");
const { applyMcpSupplement, buildNormalizedBundle, dedupeOccurrences } = require("../scripts/vsinger-http/model");
const { parseRobotsTxt, isAllowed, crawlDelaySeconds } = require("../scripts/vsinger-http/robots");
const { runBackfillWorker, shouldWriteBundle } = require("../scripts/vsinger-http/run-backfill-worker");
const { crawlSongs } = require("../scripts/vsinger-http/crawl-songs");
const { crawlStreams } = require("../scripts/vsinger-http/crawl-streams");
const { crawlSingers } = require("../scripts/vsinger-http/crawl-singers");
const { crawlSingerSongs } = require("../scripts/vsinger-http/crawl-singer-songs");
const { fetchVideoDetails } = require("../scripts/vsinger-http/fetch-video-details");
const { parseSingerDetailPage, parseSingersPage, parseSongOccurrencesPage, parseSongsPage, parseStreamsPage, parseVideoDetailPage } = require("../scripts/vsinger-http/parsers");

const SONG_A = "11111111-1111-4111-8111-111111111111";
const SONG_B = "22222222-2222-4222-8222-222222222222";
const SONG_C = "33333333-3333-4333-8333-333333333333";
const SONG_D = "44444444-4444-4444-8444-444444444444";
const VIDEO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIDEO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VIDEO_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SINGER_A = "f404dd51-2f38-499a-88f7-faf5d897d1ba";
const SINGER_B = "99999999-9999-4999-8999-999999999999";

test("robots parser allows public catalog routes and blocks API", () => {
  const policy = parseRobotsTxt(`
User-agent: *
Allow: /songs/
Allow: /streams/
Allow: /videos/
Allow: /singers/
Disallow: /api/
Disallow: /*?*singerId=
Disallow: /*?*singerName=
Crawl-delay: 1
`);

  assert.equal(isAllowed(policy, "/songs?cursor=abc"), true);
  assert.equal(isAllowed(policy, "/streams?cursor=abc"), true);
  assert.equal(isAllowed(policy, "/singers?cursor=abc"), true);
  assert.equal(isAllowed(policy, `/singers/${SINGER_A}`), true);
  assert.equal(isAllowed(policy, "/songs?singerId=f404dd51-2f38-499a-88f7-faf5d897d1ba"), false);
  assert.equal(isAllowed(policy, "/songs/17f05e2a-68af-492f-864c-dad7e35e0985?singerId=f404dd51-2f38-499a-88f7-faf5d897d1ba"), false);
  assert.equal(isAllowed(policy, "/streams?singerName=%E7%8D%85%E5%AD%90%E7%A5%9E"), false);
  assert.equal(isAllowed(policy, "/api/private"), false);
  assert.equal(crawlDelaySeconds(policy), 1);
});

test("singers parser extracts cards and detail aggregate metadata", () => {
  const list = parseSingersPage(singersPageHtml({ cursor: "next-singers" }));
  const detail = parseSingerDetailPage(singerDetailHtml(), `https://vsinger-moment.jp/singers/${SINGER_A}`);

  assert.equal(list.observedSingerCount, 393);
  assert.equal(list.singers.length, 1);
  assert.equal(list.singers[0].externalSingerId, SINGER_A);
  assert.equal(list.singers[0].singerName, "獅子神レオナ/レオナちゃんねる");
  assert.equal(list.singers[0].totalSingingCount, 4122);
  assert.equal(list.singers[0].streamVideoCount, 221);
  assert.equal(list.singers[0].repertoireSongCount, 1656);
  assert.equal(new URL(list.singers[0].singerSongsUrl).searchParams.get("singerId"), SINGER_A);
  assert.equal(list.nextPageUrl, "https://vsinger-moment.jp/singers?cursor=next-singers");
  assert.equal(detail.repertoireSongCount, 1656);
  assert.equal(detail.totalSingingCount, 4122);
  assert.equal(detail.youtubeChannelId, "UCB1s_IdO-r0nUkY2mXeti-A");
});

test("singer crawler keeps cumulative outputs across checkpoint resume", async () => {
  const dir = tempDir("singers-resume");
  const first = await crawlSingers({
    client: mockClient({
      "https://vsinger-moment.jp/singers": singersPageHtml({ cursor: "resume-singers", cards: [singerCard()] }),
      "https://vsinger-moment.jp/singers?cursor=resume-singers": singersPageHtml({ cards: [singerCard(SINGER_B, "歌手B")] }),
    }),
    robots: allowedRobots(),
    fresh: true,
    "max-pages": 1,
    "output-dir": dir,
  });
  const second = await crawlSingers({
    client: mockClient({
      "https://vsinger-moment.jp/singers": singersPageHtml({ cursor: "resume-singers", cards: [singerCard()] }),
      "https://vsinger-moment.jp/singers?cursor=resume-singers": singersPageHtml({ cards: [singerCard(SINGER_B, "歌手B")] }),
    }),
    robots: allowedRobots(),
    "max-pages": 1,
    "output-dir": dir,
  });
  const singers = readJson(path.join(dir, "singers.json"));

  assert.equal(first.uniqueSingerCount, 1);
  assert.equal(second.pageCount, 2);
  assert.equal(second.uniqueSingerCount, 2);
  assert.deepEqual(
    singers.map((singer) => singer.externalSingerId),
    [SINGER_A, SINGER_B],
  );
});

test("songs parser extracts homepage and cursor rows", () => {
  const parsed = parseSongsPage(songsPageHtml({ cursor: "abc", songs: [songCard(SONG_A, "フィナーレ", "eill"), songCard(SONG_B, "晩餐歌", "Tuki.")] }));

  assert.equal(parsed.observedSiteSongCount, 71877);
  assert.equal(parsed.songs.length, 2);
  assert.equal(parsed.songs[0].externalSongId, SONG_A);
  assert.equal(parsed.songs[0].title, "フィナーレ");
  assert.equal(parsed.songs[0].originalArtist, "eill");
  assert.equal(parsed.songs[0].singingCountReference, 2569);
  assert.equal(parsed.songs[0].latestPerformanceDate, "2026-07-15");
  assert.equal(parsed.songs[0].recentSingerName, "むんもっしゅ");
  assert.equal(parsed.nextPageUrl, "https://vsinger-moment.jp/songs?cursor=abc");

  const singerCursor = parseSongsPage(
    songsPageHtml({
      cursorHref: `/songs?singerId=${SINGER_A}&singerName=${encodeURIComponent("獅子神レオナ/レオナちゃんねる")}&cursor=singer-next`,
      songs: [songCard(SONG_D, "フィナーレ", "eill", `?singerId=${SINGER_A}`)],
    }),
  );
  assert.equal(new URL(singerCursor.nextPageUrl).searchParams.get("cursor"), "singer-next");
});

test("streams parser extracts setlists, missing setlists, and real YouTube IDs", () => {
  const parsed = parseStreamsPage(streamsPageHtml({ cursor: "next-stream" }));

  assert.equal(parsed.videos.length, 2);
  assert.equal(parsed.videos[0].externalVideoId, VIDEO_A);
  assert.equal(parsed.videos[0].youtubeVideoId, "PwEG0NtOoxE");
  assert.equal(parsed.videos[0].setlistSongs.length, 3);
  assert.equal(parsed.videos[0].setlistSongs[0].externalSongId, SONG_A);
  assert.equal(parsed.videos[0].setlistSongs[0].seconds, 421);
  assert.equal(parsed.videos[0].setlistStatus, "complete");
  assert.deepEqual(parsed.videos[0].detailQueueReasons, []);
  assert.equal(parsed.videos[1].setlistStatus, "none");
  assert.equal(parsed.videos[1].detailQueueReasons.includes("setlist_none"), true);
  assert.equal(parsed.nextPageUrl, "https://vsinger-moment.jp/streams?cursor=next-stream");
});

test("video detail parser fills setlist artists and repeated same-song occurrences", () => {
  const parsed = parseVideoDetailPage(videoDetailHtml(), `https://vsinger-moment.jp/videos/${VIDEO_A}`);

  assert.equal(parsed.externalVideoId, VIDEO_A);
  assert.equal(parsed.youtubeVideoId, "PwEG0NtOoxE");
  assert.equal(parsed.setlistStatus, "complete");
  assert.equal(parsed.setlistSongs.length, 3);
  assert.equal(parsed.setlistSongs[0].rawArtist, "セシル・コルベル");
  assert.equal(parsed.setlistSongs[2].externalSongId, SONG_A);
  assert.equal(parsed.setlistSongs[2].seconds, 1620);
});

test("video detail fetcher keeps cumulative outputs across queue batches", async () => {
  const dir = tempDir("video-details-resume");
  const queueItems = [
    { externalVideoId: VIDEO_A, videoPageUrl: `https://vsinger-moment.jp/videos/${VIDEO_A}`, reasons: ["setlist_none"] },
    { externalVideoId: VIDEO_C, videoPageUrl: `https://vsinger-moment.jp/videos/${VIDEO_C}`, reasons: ["setlist_incomplete"] },
  ];
  const pages = {
    [`https://vsinger-moment.jp/videos/${VIDEO_A}`]: videoDetailHtml(VIDEO_A, "PwEG0NtOoxE"),
    [`https://vsinger-moment.jp/videos/${VIDEO_C}`]: videoDetailHtml(VIDEO_C, "dQw4w9WgXcQ"),
  };

  const first = await fetchVideoDetails({ client: mockClient(pages), robots: allowedRobots(), queueItems, "max-videos": 1, "output-dir": dir });
  const second = await fetchVideoDetails({ client: mockClient(pages), robots: allowedRobots(), queueItems, "max-videos": 1, "output-dir": dir });
  const videos = readJson(path.join(dir, "videos.json"));
  const report = readJson(path.join(dir, "video-details.json"));
  const checkpoint = readJson(path.join(dir, "checkpoint.json"));

  assert.equal(first.runFetchedCount, 1);
  assert.equal(first.remainingQueueCount, 1);
  assert.equal(second.runFetchedCount, 1);
  assert.equal(second.fetchedCount, 2);
  assert.equal(second.videoCount, 2);
  assert.equal(second.occurrenceCount, 6);
  assert.equal(second.remainingQueueCount, 0);
  assert.equal(second.coverageStatus, "complete");
  assert.equal(report.outputFiles.videos, "videos.json");
  assert.equal("videos" in report, false);
  assert.equal("occurrences" in report, false);
  assert.deepEqual(
    videos.map((video) => video.externalVideoId),
    [VIDEO_A, VIDEO_C],
  );
  assert.equal(checkpoint.processedQueueCount, 2);
});

test("singer-scoped song details parse occurrence history and require owner permission for crawl", async () => {
  const parsed = parseSongOccurrencesPage(songOccurrenceDetailHtml(), `https://vsinger-moment.jp/songs/${SONG_D}?singerId=${SINGER_A}`);
  assert.equal(parsed.historyCount, 2);
  assert.equal(parsed.occurrences.length, 2);
  assert.equal(parsed.occurrences[0].externalVideoId, VIDEO_A);
  assert.equal(parsed.occurrences[0].youtubeVideoId, "PwEG0NtOoxE");
  assert.equal(parsed.occurrences[0].seconds, 360);

  const client = mockClient({
    [`https://vsinger-moment.jp/songs?singerId=${SINGER_A}&singerName=${encodeURIComponent("獅子神レオナ/レオナちゃんねる")}`]: songsPageHtml({
      songs: [songCard(SONG_D, "フィナーレ", "eill", `?singerId=${SINGER_A}`)],
      observedCount: 1,
    }),
    [`https://vsinger-moment.jp/songs/${SONG_D}?singerId=${SINGER_A}`]: songOccurrenceDetailHtml(),
  });

  await assert.rejects(
    () =>
      crawlSingerSongs({
        client,
        robots: allowedRobots(),
        "singer-id": SINGER_A,
        "singer-name": "獅子神レオナ/レオナちゃんねる",
        "output-dir": tempDir("singer-songs-no-permission"),
      }),
    /owner-permission/,
  );

  const dir = tempDir("singer-songs");
  const result = await crawlSingerSongs({
    client,
    robots: allowedRobots(),
    "owner-permission": true,
    "singer-id": SINGER_A,
    "singer-name": "獅子神レオナ/レオナちゃんねる",
    "max-song-pages": 1,
    "max-song-details": 1,
    "output-dir": dir,
  });
  const report = readJson(path.join(dir, "crawl.json"));

  assert.equal(result.ownerPermission.enabled, true);
  assert.equal(result.uniqueSongCount, 1);
  assert.equal(result.uniqueVideoCount, 2);
  assert.equal(result.occurrenceCount, 2);
  assert.equal(report.outputFiles.rawOccurrences, "raw-occurrences.json");
  assert.equal("songs" in report, false);
  assert.equal("occurrences" in report, false);
});

test("singer-scoped crawler resumes current singer from checkpoint cursor", async () => {
  const dir = tempDir("singer-songs-resume");
  const singerName = "獅子神レオナ/レオナちゃんねる";
  const encodedSingerName = encodeURIComponent(singerName);
  const firstUrl = `https://vsinger-moment.jp/songs?singerId=${SINGER_A}&singerName=${encodedSingerName}`;
  const secondUrl = `https://vsinger-moment.jp/songs?singerId=${SINGER_A}&singerName=${encodedSingerName}&cursor=resume`;
  const pages = {
    [firstUrl]: songsPageHtml({
      cursorHref: `/songs?singerId=${SINGER_A}&singerName=${encodedSingerName}&cursor=resume`,
      songs: [songCard(SONG_A, "A", "Artist", `?singerId=${SINGER_A}`)],
      observedCount: 2,
    }),
    [secondUrl]: songsPageHtml({
      songs: [songCard(SONG_B, "B", "Artist", `?singerId=${SINGER_A}`)],
      observedCount: 2,
    }),
  };

  const first = await crawlSingerSongs({
    client: mockClient(pages),
    robots: allowedRobots(),
    fresh: true,
    "owner-permission": true,
    "singer-id": SINGER_A,
    "singer-name": singerName,
    "max-song-pages": 1,
    "max-song-details": 0,
    "output-dir": dir,
  });
  const checkpoint = readJson(path.join(dir, "checkpoint.json"));

  assert.equal(first.stop.reason, "max-song-pages");
  assert.equal(first.uniqueSongCount, 1);
  assert.equal(checkpoint.currentSinger.nextPageUrl, secondUrl);
  assert.deepEqual(checkpoint.currentSinger.discoveredSongIds, [SONG_A]);

  const second = await crawlSingerSongs({
    client: mockClient(pages),
    robots: allowedRobots(),
    "owner-permission": true,
    "singer-id": SINGER_A,
    "singer-name": singerName,
    "max-song-pages": 1,
    "max-song-details": 0,
    "output-dir": dir,
  });
  const syncState = readJson(path.join(dir, "sync-state.json"));

  assert.equal(second.stop.reason, "completed-targets");
  assert.equal(second.pageCount, 2);
  assert.equal(second.uniqueSongCount, 2);
  assert.equal(second.nextSingerIndex, 1);
  assert.equal(syncState.cursorCheckpoint.nextSingerIndex, 1);
  assert.equal(readJson(path.join(dir, "checkpoint.json")).currentSinger, null);
});

test("YouTube parser never treats VSinger UUIDs as YouTube IDs", () => {
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/watch?v=PwEG0NtOoxE&t=421s"), "PwEG0NtOoxE");
  assert.equal(parseYouTubeVideoId(`https://vsinger-moment.jp/videos/${VIDEO_A}`), "");
});

test("song crawler stops on cursor loop", async () => {
  const client = mockClient({
    "https://vsinger-moment.jp/songs": songsPageHtml({ cursor: "loop", songs: [songCard(SONG_A, "A", "Artist")] }),
    "https://vsinger-moment.jp/songs?cursor=loop": songsPageHtml({ cursor: "loop", songs: [songCard(SONG_B, "B", "Artist")] }),
  });
  const result = await crawlSongs({ client, robots: allowedRobots(), "output-dir": tempDir("cursor-loop") });

  assert.equal(result.stop.reason, "cursor-loop");
  assert.equal(result.cursorLoopDetected, true);
  assert.equal(result.coverageStatus, "cursor-loop");
});

test("song crawler stops after five no-progress pages", async () => {
  const pages = {
    "https://vsinger-moment.jp/songs": songsPageHtml({ cursor: "p1", songs: [songCard(SONG_A, "A", "Artist")] }),
  };
  for (let index = 1; index <= 5; index += 1) {
    pages[`https://vsinger-moment.jp/songs?cursor=p${index}`] = songsPageHtml({
      cursor: `p${index + 1}`,
      songs: [songCard(SONG_A, "A", "Artist")],
    });
  }
  const result = await crawlSongs({ client: mockClient(pages), robots: allowedRobots(), "output-dir": tempDir("no-progress") });

  assert.equal(result.stop.reason, "no-progress");
  assert.equal(result.noProgressDetected, true);
  assert.equal(result.uniqueSongCount, 1);
});

test("song crawler reports count mismatch instead of declaring completeness", async () => {
  const client = mockClient({
    "https://vsinger-moment.jp/songs": songsPageHtml({ songs: [songCard(SONG_A, "A", "Artist")], observedCount: 20 }),
  });
  const result = await crawlSongs({ client, robots: allowedRobots(), "output-dir": tempDir("count-mismatch") });

  assert.equal(result.stop.reason, "no-next-cursor");
  assert.equal(result.coverageStatus, "count-mismatch");
});

test("song crawler resumes from checkpoint cursor and known IDs", async () => {
  const dir = tempDir("resume");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "checkpoint.json"),
    JSON.stringify({
      nextPageUrl: "https://vsinger-moment.jp/songs?cursor=resume",
      knownSongIds: [SONG_A],
      visitedCursorUrls: ["__first_page__"],
      visitedPageHashes: [],
    }),
  );
  const result = await crawlSongs({
    client: mockClient({
      "https://vsinger-moment.jp/songs?cursor=resume": songsPageHtml({ songs: [songCard(SONG_A, "A", "Artist"), songCard(SONG_B, "B", "Artist")] }),
    }),
    robots: allowedRobots(),
    "output-dir": dir,
  });

  assert.equal(result.startUrl, "https://vsinger-moment.jp/songs?cursor=resume");
  assert.equal(result.uniqueSongCount, 1);
  assert.equal(result.songs[0].externalSongId, SONG_B);
});

test("song crawler keeps cumulative outputs across checkpoint resume", async () => {
  const dir = tempDir("song-cumulative-resume");
  const pages = {
    "https://vsinger-moment.jp/songs": songsPageHtml({ cursor: "resume-song", songs: [songCard(SONG_A, "A", "Artist")], observedCount: 2 }),
    "https://vsinger-moment.jp/songs?cursor=resume-song": songsPageHtml({ songs: [songCard(SONG_B, "B", "Artist")], observedCount: 2 }),
  };

  const first = await crawlSongs({ client: mockClient(pages), robots: allowedRobots(), fresh: true, "max-pages": 1, "output-dir": dir });
  const second = await crawlSongs({ client: mockClient(pages), robots: allowedRobots(), "max-pages": 1, "output-dir": dir });
  const songs = readJson(path.join(dir, "songs.json"));

  assert.equal(first.uniqueSongCount, 1);
  assert.equal(second.pageCount, 2);
  assert.equal(second.uniqueSongCount, 2);
  assert.deepEqual(
    songs.map((song) => song.externalSongId),
    [SONG_A, SONG_B],
  );
});

test("HTTP client retries 429, pauses on 403, and reuses ETag cache", async () => {
  let calls = 0;
  const retryClient = new VsingerHttpClient({
    cacheDir: tempDir("http-retry"),
    requestIntervalMs: 0,
    maxRetries: 1,
    transport: async () => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response("<html>ok</html>", { status: 200, headers: { etag: '"abc"' } });
    },
  });
  const retried = await retryClient.getText("https://vsinger-moment.jp/songs");
  assert.equal(retried.status, 200);
  assert.equal(calls, 2);

  const pauseClient = new VsingerHttpClient({
    cacheDir: tempDir("http-403"),
    requestIntervalMs: 0,
    transport: async () => new Response("forbidden", { status: 403 }),
  });
  await assert.rejects(() => pauseClient.getText("https://vsinger-moment.jp/songs"), (error) => error instanceof VsingerHttpError && error.pauseRequired);

  let etagHeader = "";
  let etagCalls = 0;
  const etagClient = new VsingerHttpClient({
    cacheDir: tempDir("http-etag"),
    requestIntervalMs: 0,
    transport: async (_url, init) => {
      etagCalls += 1;
      etagHeader = init.headers["if-none-match"] || "";
      if (etagCalls === 1) return new Response("<html>cached</html>", { status: 200, headers: { etag: '"cached"' } });
      return new Response(null, { status: 304 });
    },
  });
  await etagClient.getText("https://vsinger-moment.jp/songs");
  const cached = await etagClient.getText("https://vsinger-moment.jp/songs");
  assert.equal(etagHeader, '"cached"');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.body, "<html>cached</html>");
});

test("dedupe model keeps repeated same-song timestamps and avoids MCP duplicate imports", () => {
  const occurrences = dedupeOccurrences([
    { youtubeVideoId: "PwEG0NtOoxE", canonicalSongId: "vsinger:a", seconds: 421 },
    { youtubeVideoId: "PwEG0NtOoxE", canonicalSongId: "vsinger:a", seconds: 421 },
    { youtubeVideoId: "PwEG0NtOoxE", canonicalSongId: "vsinger:a", seconds: 1620 },
    { externalVideoId: VIDEO_A, externalSongId: SONG_A, seconds: 1 },
    { externalVideoId: VIDEO_A, externalSongId: SONG_A, seconds: 1 },
  ]);
  assert.equal(occurrences.length, 3);

  const merged = applyMcpSupplement(
    { songs: [{ sourceSystem: "vsinger_moment_http", externalSongId: SONG_A }], videos: [], occurrences: [{ youtubeVideoId: "PwEG0NtOoxE", canonicalSongId: "vsinger:a", seconds: 421 }] },
    { songs: [{ sourceSystem: "vsinger_moment_http", externalSongId: SONG_A }], videos: [], occurrences: [{ youtubeVideoId: "PwEG0NtOoxE", canonicalSongId: "vsinger:a", seconds: 421 }] },
  );
  assert.equal(merged.songs.length, 1);
  assert.equal(merged.occurrences.length, 1);
});

test("normalized bundle derives song entities from stream setlists", () => {
  const parsed = parseStreamsPage(streamsPageHtml({}));
  const bundle = buildNormalizedBundle({ videos: parsed.videos }, "2026-07-17T00:00:00.000Z");

  assert.equal(bundle.counts.videos, 2);
  assert.equal(bundle.counts.occurrences, 3);
  assert.equal(bundle.counts.songs, 2);
  assert.deepEqual(
    bundle.songs.map((song) => [song.externalSongId, song.displayTitle]),
    [
      [SONG_A, "Arrietty's Song"],
      [SONG_B, "世界の約束"],
    ],
  );
});

test("stream crawler writes setlist song catalog and sync state", async () => {
  const dir = tempDir("stream-sync");
  const bundleDir = path.join(dir, "bundle");
  const result = await crawlStreams({
    client: mockClient({
      "https://vsinger-moment.jp/streams": streamsPageHtml({}),
    }),
    robots: allowedRobots(),
    "output-dir": dir,
    "write-bundle": true,
    "bundle-dir": bundleDir,
  });
  const syncState = readJson(path.join(dir, "sync-state.json"));
  const manifest = readJson(path.join(bundleDir, "manifest.json"));
  const bundleSongs = readJson(path.join(bundleDir, "songs-0001.json"));

  assert.equal(result.uniqueSetlistSongCount, 2);
  assert.equal(syncState.knownSongIds.length, 2);
  assert.equal(syncState.lastSuccessfulStreamCrawl.occurrenceCount, 3);
  assert.equal(manifest.counts.songs, 2);
  assert.equal(manifest.shards.syncState[0].file, "syncState.json");
  assert.equal(bundleSongs[0].displayTitle, "Arrietty's Song");
});

test("stream crawler keeps cumulative outputs across checkpoint resume", async () => {
  const dir = tempDir("stream-cumulative-resume");
  const pages = {
    "https://vsinger-moment.jp/streams": streamsPageHtml({ cursor: "resume-stream", cards: [streamCardWithSetlist()] }),
    "https://vsinger-moment.jp/streams?cursor=resume-stream": streamsPageHtml({ cards: [streamCardWithSetlist(VIDEO_C, "dQw4w9WgXcQ")] }),
  };

  const first = await crawlStreams({ client: mockClient(pages), robots: allowedRobots(), fresh: true, "max-pages": 1, "output-dir": dir });
  const second = await crawlStreams({ client: mockClient(pages), robots: allowedRobots(), "max-pages": 1, "output-dir": dir });
  const videos = readJson(path.join(dir, "videos.json"));
  const report = readJson(path.join(dir, "crawl.json"));

  assert.equal(first.uniqueVideoCount, 1);
  assert.equal(second.pageCount, 2);
  assert.equal(second.uniqueVideoCount, 2);
  assert.equal(second.occurrenceCount, 6);
  assert.equal(report.detailQueueCount, 0);
  assert.equal(report.outputFiles.videos, "videos.json");
  assert.equal("videos" in report, false);
  assert.equal("occurrences" in report, false);
  assert.deepEqual(
    videos.map((video) => video.externalVideoId),
    [VIDEO_A, VIDEO_C],
  );
});

test("backfill bundle builder merges stage outputs and writes coverage report", () => {
  const root = tempDir("backfill-build");
  const songsDir = path.join(root, "songs");
  const streamsDir = path.join(root, "streams");
  const videoDetailsDir = path.join(root, "video-details");
  const singerSongsDir = path.join(root, "singer-songs");
  const outputDir = path.join(root, "bundle");
  const streamVideos = parseStreamsPage(streamsPageHtml({})).videos;
  const detailVideo = parseVideoDetailPage(videoDetailHtml(), `https://vsinger-moment.jp/videos/${VIDEO_A}`);

  writeJson(path.join(songsDir, "songs.json"), [
    {
      externalSongId: SONG_C,
      title: "Catalog Only",
      originalArtist: "Catalog Artist",
      songPageUrl: `https://vsinger-moment.jp/songs/${SONG_C}`,
    },
  ]);
  writeJson(path.join(songsDir, "crawl.json"), {
    generatedAt: "2026-07-17T00:00:00.000Z",
    coverageStatus: "count-mismatch",
    stop: { reason: "no-next-cursor" },
    pageCount: 1,
    rawRowCount: 1,
    uniqueSongCount: 1,
    observedSiteSongCount: 20,
    duplicateRowCount: 0,
    duplicateRate: 0,
    requestStats: { requestCount: 1, averageHtmlBytes: 100, averageResponseTimeMs: 10, totalBytes: 100 },
    pages: [{ bytes: 100, elapsedMs: 10 }],
  });
  writeJson(path.join(songsDir, "sync-state.json"), {
    lastSuccessfulSongCrawl: { coverageStatus: "count-mismatch" },
    cursorCheckpoint: { nextPageUrl: "" },
  });
  writeJson(path.join(streamsDir, "videos.json"), streamVideos);
  writeJson(path.join(streamsDir, "detail-queue.json"), [{ videoPageUrl: `https://vsinger-moment.jp/videos/${VIDEO_B}`, reasons: ["setlist_none"] }]);
  writeJson(path.join(streamsDir, "crawl.json"), {
    generatedAt: "2026-07-17T00:00:00.000Z",
    coverageStatus: "partial",
    stop: { reason: "max-pages" },
    pageCount: 1,
    rawRowCount: 2,
    uniqueVideoCount: 2,
    uniqueSetlistSongCount: 2,
    duplicateRowCount: 0,
    duplicateRate: 0,
    occurrenceCount: 3,
    streamWatermark: "2026-07-17",
    requestStats: { requestCount: 1, averageHtmlBytes: 200, averageResponseTimeMs: 20, totalBytes: 200 },
    pages: [{ setlistCount: 1, occurrenceCount: 3, bytes: 200, elapsedMs: 20 }],
  });
  writeJson(path.join(streamsDir, "sync-state.json"), {
    lastSuccessfulStreamCrawl: { coverageStatus: "partial" },
    streamWatermark: "2026-07-17",
    cursorCheckpoint: { nextPageUrl: "https://vsinger-moment.jp/streams?cursor=next" },
  });
  writeJson(path.join(videoDetailsDir, "videos.json"), [detailVideo]);
  writeJson(path.join(videoDetailsDir, "video-details.json"), {
    kind: "vsinger-moment-http-video-detail-fill",
    generatedAt: "2026-07-17T00:00:00.000Z",
    requestedCount: 1,
    fetchedCount: 1,
    occurrenceCount: 3,
    requestStats: { requestCount: 1, averageHtmlBytes: 300, averageResponseTimeMs: 30, totalBytes: 300 },
    pages: [{ bytes: 300, elapsedMs: 30 }],
  });
  writeJson(path.join(singerSongsDir, "songs.json"), [
    {
      externalSongId: SONG_D,
      title: "Singer Scoped",
      originalArtist: "Singer Artist",
      songPageUrl: `https://vsinger-moment.jp/songs/${SONG_D}?singerId=${SINGER_A}`,
    },
  ]);
  writeJson(path.join(singerSongsDir, "videos.json"), [
    {
      externalVideoId: VIDEO_C,
      youtubeVideoId: "dQw4w9WgXcQ",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      videoPageUrl: `https://vsinger-moment.jp/videos/${VIDEO_C}`,
      videoTitle: "Singer scoped stream",
      singerId: SINGER_A,
      singerName: "獅子神レオナ/レオナちゃんねる",
      streamedAt: "2025-12-23",
      setlistStatus: "partial",
      setlistSongs: [{ externalSongId: SONG_D, rawTitle: "Singer Scoped", rawArtist: "Singer Artist", seconds: 360, timestampText: "00:06:00", songPageUrl: `https://vsinger-moment.jp/songs/${SONG_D}` }],
    },
  ]);
  writeJson(path.join(singerSongsDir, "crawl.json"), {
    kind: "vsinger-moment-http-singer-songs-crawl",
    generatedAt: "2026-07-17T00:00:00.000Z",
    coverageStatus: "partial",
    singersProcessed: 1,
    pageCount: 1,
    detailPageCount: 1,
    uniqueSongCount: 1,
    uniqueVideoCount: 1,
    occurrenceCount: 1,
    ownerPermission: { enabled: true, note: "test" },
    requestStats: { requestCount: 2, averageHtmlBytes: 150, averageResponseTimeMs: 15, totalBytes: 300 },
    pages: [{ bytes: 100, elapsedMs: 10 }, { bytes: 200, elapsedMs: 20 }],
  });
  writeJson(path.join(singerSongsDir, "sync-state.json"), {
    lastSuccessfulSingerSongsCrawl: { coverageStatus: "partial" },
    ownerPermission: { enabled: true, note: "test" },
  });

  const { bundle, manifest } = buildBackfillBundle({
    "songs-dir": songsDir,
    "streams-dir": streamsDir,
    "video-details-dir": videoDetailsDir,
    "singer-songs-dir": singerSongsDir,
    "output-dir": outputDir,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
  const report = readJson(path.join(outputDir, "backfill-report.json"));
  const syncState = readJson(path.join(outputDir, "syncState.json"));

  assert.equal(bundle.counts.songs, 4);
  assert.equal(bundle.counts.videos, 3);
  assert.equal(bundle.counts.occurrences, 4);
  assert.equal(bundle.counts.conflicts, 0);
  assert.equal(bundle.coverage.stages.songs.coverageStatus, "count-mismatch");
  assert.equal(bundle.coverage.savings.avoidedVideoDetailRequestsByListSetlists, 1);
  assert.equal(bundle.coverage.stages.singerSongs.ownerPermission.enabled, true);
  assert.equal(bundle.coverage.savings.singerScopedOccurrencesImported, 1);
  assert.equal(manifest.shards.coverage[0].file, "coverage.json");
  assert.equal(report.coverage.requestStats.requestCount, 5);
  assert.equal(syncState.knownSongIds.includes(SONG_C), true);
  assert.equal(fs.existsSync(path.join(outputDir, "backfill-report.md")), true);
});

test("backfill worker orchestrates stages and writes immutable bundle versions", async () => {
  const root = tempDir("backfill-worker");
  const bundleRoot = path.join(root, "bundles");
  const report = await runBackfillWorker({
    client: mockClient({
      "https://vsinger-moment.jp/songs": songsPageHtml({ songs: [songCard(SONG_A, "A", "Artist")] }),
      "https://vsinger-moment.jp/streams": streamsPageHtml({ cards: [streamCardWithSetlist()] }),
      "https://vsinger-moment.jp/singers": singersPageHtml({ cards: [singerCard()] }),
    }),
    robots: allowedRobots(),
    fresh: true,
    "root-dir": root,
    "bundle-root": bundleRoot,
    "bundle-version": "test-version",
    "force-bundle": true,
    "song-pages": 1,
    "stream-pages": 1,
    "singer-pages": 1,
    "skip-singer-songs": true,
    "no-lock": true,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
  const latest = readJson(path.join(bundleRoot, "latest.json"));
  const state = readJson(path.join(root, "worker-state.json"));
  const manifest = readJson(path.join(bundleRoot, "versions", "test-version", "manifest.json"));

  assert.equal(report.stages.songs.pageCount, 1);
  assert.equal(report.stages.streams.uniqueVideoCount, 1);
  assert.equal(report.stages.singers.uniqueSingerCount, 1);
  assert.equal(report.currentCounts.songs, 2);
  assert.equal(report.bundle.version, "test-version");
  assert.equal(latest.manifest, "versions/test-version/manifest.json");
  assert.equal(state.lastBundle.version, "test-version");
  assert.equal(manifest.counts.videos, 1);
  assert.equal(manifest.counts.occurrences, 3);
});

test("backfill worker bundle threshold decisions use count and time deltas", () => {
  assert.equal(shouldWriteBundle({ args: { "force-bundle": true }, currentCounts: { songs: 0, occurrences: 0 }, previousBundle: null, generatedAt: "2026-07-17T00:00:00.000Z" }).reason, "force-bundle");
  assert.equal(shouldWriteBundle({ args: {}, currentCounts: { songs: 1, occurrences: 0 }, previousBundle: null, generatedAt: "2026-07-17T00:00:00.000Z" }).reason, "first-bundle");
  assert.equal(
    shouldWriteBundle({
      args: { "bundle-song-threshold": 10 },
      currentCounts: { songs: 15, occurrences: 0 },
      previousBundle: { generatedAt: "2026-07-17T00:00:00.000Z", counts: { songs: 4, occurrences: 0 } },
      generatedAt: "2026-07-17T00:10:00.000Z",
    }).reason,
    "song-threshold",
  );
  assert.equal(
    shouldWriteBundle({
      args: { "bundle-occurrence-threshold": 10 },
      currentCounts: { songs: 0, occurrences: 15 },
      previousBundle: { generatedAt: "2026-07-17T00:00:00.000Z", counts: { songs: 0, occurrences: 4 } },
      generatedAt: "2026-07-17T00:10:00.000Z",
    }).reason,
    "occurrence-threshold",
  );
  assert.equal(
    shouldWriteBundle({
      args: { "bundle-interval-minutes": 30 },
      currentCounts: { songs: 0, occurrences: 0 },
      previousBundle: { generatedAt: "2026-07-17T00:00:00.000Z", counts: { songs: 0, occurrences: 0 } },
      generatedAt: "2026-07-17T00:31:00.000Z",
    }).reason,
    "time-threshold",
  );
});

test("bundle writer is idempotent for the same normalized payload", () => {
  const dir = tempDir("bundle");
  const bundle = {
    sourceSystem: "vsinger_moment_http",
    generatedAt: "2026-07-17T00:00:00.000Z",
    counts: { songs: 2, videos: 0, occurrences: 0 },
    songs: [
      { canonicalSongId: "vsinger:a", externalSongId: SONG_A },
      { canonicalSongId: "vsinger:b", externalSongId: SONG_B },
    ],
    coverage: { coverageStatus: "partial" },
    failures: [],
    syncState: { coverageStatus: "partial" },
  };
  const first = writeShardedBundle(dir, bundle, { shardSize: 1 });
  const second = writeShardedBundle(dir, bundle, { shardSize: 1 });
  const manifest = readJson(path.join(dir, "manifest.json"));

  assert.deepEqual(second.shards.songs, first.shards.songs);
  assert.deepEqual(manifest.shards.songs, first.shards.songs);
  assert.equal(manifest.shards.songs.length, 2);
  assert.equal(manifest.shards.syncState[0].file, "syncState.json");
});

function songsPageHtml({ cursor = "", cursorHref = "", songs = [], observedCount = 71877 }) {
  const nextHref = cursorHref || (cursor ? `/songs?cursor=${cursor}` : "");
  return `<!doctype html><html><head><meta name="description" content="${observedCount}曲以上のVTuber・VSingerカバー曲を完全網羅！"></head><body>
<main><div class="grid">${songs.join("")}</div>
${nextHref ? `<a class="w-full" href="${nextHref}" data-discover="true">次のページを読み込む</a>` : ""}
</main></body></html>`;
}

function songCard(id, title, artist, detailQuery = "") {
  return `<div class="bg-white rounded-lg shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden border border-gray-200 flex flex-col h-full">
<div class="p-5 space-y-3 flex-1 flex flex-col"><div class="flex-1"><h2 class="text-lg">${title}</h2><p class="text-sm">${artist}</p></div>
<span title="歌唱回数">2569<!-- -->回歌唱</span><span title="最新歌唱日">2026/7/15</span>
<span class="truncate">最近:<!-- --> <a href="/singers/singer-a">むんもっしゅ</a></span>
<a class="flex-1" href="/songs/${id}${detailQuery}" data-discover="true">詳細を見る</a>
<a href="https://www.youtube.com/watch?v=yCpZHgTbZxg">原曲</a></div></div>`;
}

function singersPageHtml({ cursor = "", cards = [singerCard()] }) {
  return `<!doctype html><html><head><meta name="description" content="393名のVTuber・VSingerの歌唱活動を完全網羅！"></head><body>
<main><div class="grid">${cards.join("")}</div>
${cursor ? `<a class="w-full" href="/singers?cursor=${cursor}" data-discover="true">次のページを読み込む</a>` : ""}
</main></body></html>`;
}

function singerCard(id = SINGER_A, name = "獅子神レオナ/レオナちゃんねる") {
  const encodedName = encodeURIComponent(name);
  return `<div class="bg-white rounded-lg shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden border border-gray-200 flex flex-col h-full">
<img src="https://yt3.ggpht.com/leona=s800-c-k-c0x00ffffff-no-rj" alt="${name}"/>
<div class="p-4 space-y-3 flex-1 flex flex-col"><div><h2 class="text-xl font-semibold text-gray-900">${name}</h2></div>
<p class="text-gray-600 text-sm line-clamp-2">わいるど、がお～！</p>
<span class="inline-block px-2 py-0.5 text-xs bg-purple-50 text-purple-700 rounded-full">バラード系楽曲が得意</span>
<div><span title="最終配信">2026/7/17</span><span title="総歌唱数">4122<!-- -->回</span><span title="配信動画数">221<!-- -->本</span><span title="レパートリー数">1656<!-- -->曲</span></div>
<a class="flex-1" href="/singers/${id}" data-discover="true">詳細を見る</a>
<a title="楽曲一覧" href="/songs?singerId=${id}&amp;singerName=${encodedName}">楽曲</a>
<a title="配信一覧" href="/streams?singerId=${id}&amp;singerName=${encodedName}">配信</a>
<a href="https://www.youtube.com/channel/UCB1s_IdO-r0nUkY2mXeti-A">YouTube</a>
</div></div>`;
}

function singerDetailHtml() {
  return `<!doctype html><html><head>
<title>獅子神レオナ/レオナちゃんねる | VTuber・VSinger歌唱データベース - VSinger Moment</title>
<meta name="description" content="獅子神レオナ/レオナちゃんねるの歌枠・歌ってみた動画を完全網羅！1656曲のレパートリーを4122回歌唱。"/>
<meta property="og:url" content="https://vsinger-moment.jp/singers/${SINGER_A}"/>
</head><body>
<h1>獅子神レオナ/レオナちゃんねる</h1>
<img src="https://yt3.ggpht.com/leona=s800-c-k-c0x00ffffff-no-rj" alt="獅子神レオナ/レオナちゃんねる"/>
<a href="https://www.youtube.com/channel/UCB1s_IdO-r0nUkY2mXeti-A">YouTube</a>
<div><div>221</div><div>歌枠動画</div></div><div><div>1656</div><div>レパートリー</div></div><div><div>4122</div><div>歌唱数</div></div>
<a href="/songs?singerId=${SINGER_A}&amp;singerName=%E7%8D%85%E5%AD%90%E7%A5%9E%E3%83%AC%E3%82%AA%E3%83%8A%2F%E3%83%AC%E3%82%AA%E3%83%8A%E3%81%A1%E3%82%83%E3%82%93%E3%81%AD%E3%82%8B">楽曲を探す</a>
<a href="/streams?singerId=${SINGER_A}&amp;singerName=%E7%8D%85%E5%AD%90%E7%A5%9E%E3%83%AC%E3%82%AA%E3%83%8A%2F%E3%83%AC%E3%82%AA%E3%83%8A%E3%81%A1%E3%82%83%E3%82%93%E3%81%AD%E3%82%8B">歌枠を探す</a>
<script type="application/ld+json">{"dateModified":"2026-07-16T02:01:50.141Z","lastReviewed":"2026-07-18T04:01:07.455Z"}</script>
</body></html>`;
}

function streamsPageHtml({ cursor = "", cards = [streamCardWithSetlist(), streamCardNoSetlist()] }) {
  return `<!doctype html><html><body>
${cards.join("")}
${cursor ? `<a class="w-full" href="/streams?cursor=${cursor}" data-discover="true">次のページを読み込む</a>` : ""}
</body></html>`;
}

function streamCardWithSetlist(videoId = VIDEO_A, youtubeId = "PwEG0NtOoxE") {
  return `<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col"><div class="p-4">
<img src="https://i.ytimg.com/vi/${youtubeId}/default.jpg" alt="video a"/>
<a href="/singers/singer-a">宮守ゆり</a><h3 class="text-xs">星海のメロウ歌枠リレー</h3>
<div class="text-xs text-gray-500"><svg class="lucide-calendar"></svg>2026/7/17</div>
<details open><summary>セットリスト（<!-- -->3<!-- -->曲）</summary>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:07:01</span><a href="/songs/${SONG_A}">Arrietty&#x27;s Song</a></div>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:14:30</span><a href="/songs/${SONG_B}">世界の約束</a></div>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:27:00</span><a href="/songs/${SONG_A}">Arrietty&#x27;s Song</a></div>
</details>
<a class="flex-1" href="/videos/${videoId}" data-discover="true">詳細を見る</a>
<a href="https://www.youtube.com/watch?v=${youtubeId}">YouTube</a>
</div></div>`;
}

function streamCardNoSetlist() {
  return `<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col"><div class="p-4">
<img src="https://i.ytimg.com/vi/SR7Az4c9-Ls/default.jpg" alt="video b"/>
<a href="/singers/singer-b">雛呑ちの</a><h3 class="text-xs">夜更かしタイム</h3>
<div class="text-xs text-gray-500"><svg class="lucide-calendar"></svg>2026/7/17</div>
<div class="mb-3 text-xs text-gray-400 italic flex-1">セットリスト情報なし</div>
<a class="flex-1" href="/videos/${VIDEO_B}" data-discover="true">詳細を見る</a>
<a href="https://www.youtube.com/watch?v=SR7Az4c9-Ls">YouTube</a>
</div></div>`;
}

function videoDetailHtml(videoId = VIDEO_A, youtubeId = "PwEG0NtOoxE") {
  return `<!doctype html><html><head>
<meta property="og:url" content="https://vsinger-moment.jp/videos/${videoId}"/>
<meta property="og:title" content="星海のメロウ歌枠リレー - VSinger Moment"/>
<meta property="og:description" content="宮守ゆりの歌枠配信「星海」のセットリストと歌唱情報。3曲の歌唱データを収録。"/>
<meta property="og:image" content="https://i.ytimg.com/vi/${youtubeId}/default.jpg"/>
</head><body>
${videoDetailRow("00:07:01", SONG_A, "Arrietty&#x27;s Song", "セシル・コルベル", 421, youtubeId)}
${videoDetailRow("00:14:30", SONG_B, "世界の約束", "倍賞千恵子", 870, youtubeId)}
${videoDetailRow("00:27:00", SONG_A, "Arrietty&#x27;s Song", "セシル・コルベル", 1620, youtubeId)}
</body></html>`;
}

function songOccurrenceDetailHtml() {
  return `<!doctype html><html><head>
<meta property="og:url" content="https://vsinger-moment.jp/songs/${SONG_D}"/>
<title>フィナーレ / eill - VSinger Moment</title>
</head><body>
<h1>フィナーレ</h1><p>eill</p>
<div>7 回歌われています</div><div>1 人が歌っています</div>
<section><h2>歌唱履歴</h2><p>全 2 件</p>
<div class="group border border-gray-200 rounded-lg">
<a href="/singers/${SINGER_A}">獅子神レオナ/レオナちゃんねる</a>
<a href="/videos/${VIDEO_A}">一時間だけ歌っちゃいますか</a>
<span>2025/12/23</span><span>00:06:00</span>
<a href="https://www.youtube.com/watch?v=PwEG0NtOoxE&amp;t=360s">YouTube</a>
</div>
<div class="group border border-gray-200 rounded-lg">
<a href="/singers/${SINGER_A}">獅子神レオナ/レオナちゃんねる</a>
<a href="/videos/${VIDEO_C}">睡眠は大事だよ</a>
<span>2025/11/17</span><span>00:07:30</span>
<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=450s">YouTube</a>
</div>
</section></body></html>`;
}

function videoDetailRow(time, songId, title, artist, seconds, youtubeId = "PwEG0NtOoxE") {
  return `<div class="group border border-gray-200 rounded-lg"><button title="サイト内で視聴"><span class="text-[10px]">${time}</span></button>
<h3>${title}</h3><p class="text-xs md:text-sm text-gray-600 leading-tight">${artist}</p>
<a href="https://www.youtube.com/watch?v=${youtubeId}&amp;t=${seconds}s">YouTube</a>
<a href="/songs/${songId}">曲詳細</a></div>`;
}

function allowedRobots() {
  return {
    songsAllowed: true,
    streamsAllowed: true,
    singersAllowed: true,
    singerSongsQueryAllowed: false,
    singerStreamsQueryAllowed: false,
    videosAllowed: true,
    apiAllowed: false,
    crawlDelay: 1,
  };
}

function mockClient(pages) {
  return {
    userAgent: "test",
    async getText(urlOrPath) {
      const url = new URL(urlOrPath, "https://vsinger-moment.jp").toString();
      if (!(url in pages)) throw new Error(`missing mock page: ${url}`);
      return {
        url,
        status: 200,
        headers: {},
        body: pages[url],
        bytes: Buffer.byteLength(pages[url]),
        elapsedMs: 1,
        fromCache: false,
      };
    },
  };
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vsinger-http-${name}-`));
}
