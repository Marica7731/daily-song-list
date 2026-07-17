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
const { crawlSongs } = require("../scripts/vsinger-http/crawl-songs");
const { crawlStreams } = require("../scripts/vsinger-http/crawl-streams");
const { parseSongsPage, parseStreamsPage, parseVideoDetailPage } = require("../scripts/vsinger-http/parsers");

const SONG_A = "11111111-1111-4111-8111-111111111111";
const SONG_B = "22222222-2222-4222-8222-222222222222";
const SONG_C = "33333333-3333-4333-8333-333333333333";
const VIDEO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIDEO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("robots parser allows public catalog routes and blocks API", () => {
  const policy = parseRobotsTxt(`
User-agent: *
Allow: /songs/
Allow: /streams/
Allow: /videos/
Disallow: /api/
Crawl-delay: 1
`);

  assert.equal(isAllowed(policy, "/songs?cursor=abc"), true);
  assert.equal(isAllowed(policy, "/streams?cursor=abc"), true);
  assert.equal(isAllowed(policy, "/api/private"), false);
  assert.equal(crawlDelaySeconds(policy), 1);
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

test("backfill bundle builder merges stage outputs and writes coverage report", () => {
  const root = tempDir("backfill-build");
  const songsDir = path.join(root, "songs");
  const streamsDir = path.join(root, "streams");
  const videoDetailsDir = path.join(root, "video-details");
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

  const { bundle, manifest } = buildBackfillBundle({
    "songs-dir": songsDir,
    "streams-dir": streamsDir,
    "video-details-dir": videoDetailsDir,
    "output-dir": outputDir,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
  const report = readJson(path.join(outputDir, "backfill-report.json"));
  const syncState = readJson(path.join(outputDir, "syncState.json"));

  assert.equal(bundle.counts.songs, 3);
  assert.equal(bundle.counts.videos, 2);
  assert.equal(bundle.counts.occurrences, 3);
  assert.equal(bundle.counts.conflicts, 0);
  assert.equal(bundle.coverage.stages.songs.coverageStatus, "count-mismatch");
  assert.equal(bundle.coverage.savings.avoidedVideoDetailRequestsByListSetlists, 1);
  assert.equal(manifest.shards.coverage[0].file, "coverage.json");
  assert.equal(report.coverage.requestStats.requestCount, 3);
  assert.equal(syncState.knownSongIds.includes(SONG_C), true);
  assert.equal(fs.existsSync(path.join(outputDir, "backfill-report.md")), true);
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

function songsPageHtml({ cursor = "", songs = [], observedCount = 71877 }) {
  return `<!doctype html><html><head><meta name="description" content="${observedCount}曲以上のVTuber・VSingerカバー曲を完全網羅！"></head><body>
<main><div class="grid">${songs.join("")}</div>
${cursor ? `<a class="w-full" href="/songs?cursor=${cursor}" data-discover="true">次のページを読み込む</a>` : ""}
</main></body></html>`;
}

function songCard(id, title, artist) {
  return `<div class="bg-white rounded-lg shadow-sm hover:shadow-lg transition-all duration-200 overflow-hidden border border-gray-200 flex flex-col h-full">
<div class="p-5 space-y-3 flex-1 flex flex-col"><div class="flex-1"><h2 class="text-lg">${title}</h2><p class="text-sm">${artist}</p></div>
<span title="歌唱回数">2569<!-- -->回歌唱</span><span title="最新歌唱日">2026/7/15</span>
<span class="truncate">最近:<!-- --> <a href="/singers/singer-a">むんもっしゅ</a></span>
<a class="flex-1" href="/songs/${id}" data-discover="true">詳細を見る</a>
<a href="https://www.youtube.com/watch?v=yCpZHgTbZxg">原曲</a></div></div>`;
}

function streamsPageHtml({ cursor = "" }) {
  return `<!doctype html><html><body>
${streamCardWithSetlist()}
${streamCardNoSetlist()}
${cursor ? `<a class="w-full" href="/streams?cursor=${cursor}" data-discover="true">次のページを読み込む</a>` : ""}
</body></html>`;
}

function streamCardWithSetlist() {
  return `<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col"><div class="p-4">
<img src="https://i.ytimg.com/vi/PwEG0NtOoxE/default.jpg" alt="video a"/>
<a href="/singers/singer-a">宮守ゆり</a><h3 class="text-xs">星海のメロウ歌枠リレー</h3>
<div class="text-xs text-gray-500"><svg class="lucide-calendar"></svg>2026/7/17</div>
<details open><summary>セットリスト（<!-- -->3<!-- -->曲）</summary>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:07:01</span><a href="/songs/${SONG_A}">Arrietty&#x27;s Song</a></div>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:14:30</span><a href="/songs/${SONG_B}">世界の約束</a></div>
<div class="text-xs text-gray-700 py-1"><span class="font-mono">00:27:00</span><a href="/songs/${SONG_A}">Arrietty&#x27;s Song</a></div>
</details>
<a class="flex-1" href="/videos/${VIDEO_A}" data-discover="true">詳細を見る</a>
<a href="https://www.youtube.com/watch?v=PwEG0NtOoxE">YouTube</a>
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

function videoDetailHtml() {
  return `<!doctype html><html><head>
<meta property="og:url" content="https://vsinger-moment.jp/videos/${VIDEO_A}"/>
<meta property="og:title" content="星海のメロウ歌枠リレー - VSinger Moment"/>
<meta property="og:description" content="宮守ゆりの歌枠配信「星海」のセットリストと歌唱情報。3曲の歌唱データを収録。"/>
<meta property="og:image" content="https://i.ytimg.com/vi/PwEG0NtOoxE/default.jpg"/>
</head><body>
${videoDetailRow("00:07:01", SONG_A, "Arrietty&#x27;s Song", "セシル・コルベル", 421)}
${videoDetailRow("00:14:30", SONG_B, "世界の約束", "倍賞千恵子", 870)}
${videoDetailRow("00:27:00", SONG_A, "Arrietty&#x27;s Song", "セシル・コルベル", 1620)}
</body></html>`;
}

function videoDetailRow(time, songId, title, artist, seconds) {
  return `<div class="group border border-gray-200 rounded-lg"><button title="サイト内で視聴"><span class="text-[10px]">${time}</span></button>
<h3>${title}</h3><p class="text-xs md:text-sm text-gray-600 leading-tight">${artist}</p>
<a href="https://www.youtube.com/watch?v=PwEG0NtOoxE&amp;t=${seconds}s">YouTube</a>
<a href="/songs/${songId}">曲詳細</a></div>`;
}

function allowedRobots() {
  return {
    songsAllowed: true,
    streamsAllowed: true,
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
