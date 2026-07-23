const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.PYTHON || "python";
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, "server", "song_rank_api.py"), "utf8");

test("runtime API vtuber fallback uses normalized song title lookup for source enrichment", () => {
  assert.match(SERVER_SOURCE, /def song_title_lookup_key/u);
  assert.match(SERVER_SOURCE, /def title_like_pattern_for_lookup/u);
  assert.match(SERVER_SOURCE, /song_title_lookup_key\(candidate\["title"\]\) != title_key/u);
  assert.doesNotMatch(
    SERVER_SOURCE,
    /r\.scope_key = 'all'\s+AND r\.title = \?/u,
  );
});

test("runtime API all-field source search prioritizes entity matches by global count", () => {
  assert.match(SERVER_SOURCE, /def entity_source_search_scope_for_view/u);
  assert.match(SERVER_SOURCE, /CASE WHEN \{entity_clause\} THEN 0 ELSE 1 END AS entity_match_order/u);
  assert.match(SERVER_SOURCE, /entity_match_order ASC/u);
  assert.match(SERVER_SOURCE, /CASE WHEN entity_match_order = 0 THEN \{global_order_column\} ELSE \{order_column\} END DESC/u);
});

test("runtime API merges indexed unknown artist song variants into the known song result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-api-indexed-unknown-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  let child = null;
  let stderr = "";

  try {
    writeIndexedUnknownArtistFixture(latestPath);
    execFileSync(
      PYTHON,
      [
        path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
        "--input",
        latestPath,
        "--output",
        dbPath,
        "--no-vsinger",
        "--no-youtube-channel-discovery",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT: "2" },
        timeout: 30000,
      },
    );
    const port = await getFreePort();
    child = spawn(
      PYTHON,
      [
        path.join(ROOT, "server", "song_rank_api.py"),
        "--db",
        dbPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitForReady(child, port);
    const params = new URLSearchParams({
      range: "all",
      view: "songs",
      q: "花になって",
      pageSize: "5",
    });
    const flowerSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?${params}`);
    assert.equal(flowerSearch.totalCount, 1);
    assert.equal(flowerSearch.totalOccurrenceCount, 3);
    assert.equal(flowerSearch.records.length, 1);
    assert.equal(flowerSearch.records[0].title, "花になって");
    assert.equal(flowerSearch.records[0].displayArtist, "緑黄色社会");
    assert.equal(flowerSearch.records[0].count, 3);

    const responseText = JSON.stringify(flowerSearch);
    assert.doesNotMatch(responseText, /未記載/u);
    assert.doesNotMatch(responseText, /⟦16⟧/u);
    assert.doesNotMatch(responseText, /16 花になって/u);
  } finally {
    if (child) {
      child.kill();
      await waitForExit(child);
      assert.equal(stderr.includes("Traceback"), false, stderr);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime API all-field source search sorts by matched occurrence count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-api-source-sort-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  let child = null;
  let stderr = "";

  try {
    writeAllFieldSourceSortFixture(latestPath);
    execFileSync(
      PYTHON,
      [
        path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
        "--input",
        latestPath,
        "--output",
        dbPath,
        "--no-vsinger",
        "--no-youtube-channel-discovery",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT: "2" },
        timeout: 30000,
      },
    );
    const sourceFtsProbe = probeSourceOccurrenceFts(dir, dbPath, "needle");
    assert.equal(sourceFtsProbe.hasSourceFts, 1);
    assert.equal(sourceFtsProbe.hasChannelFts, 1);
    assert.ok(sourceFtsProbe.sourceFtsRows >= 4);

    const port = await getFreePort();
    child = spawn(
      PYTHON,
      [
        path.join(ROOT, "server", "song_rank_api.py"),
        "--db",
        dbPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitForReady(child, port);
    const sourceSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=needle&searchFields=all&pageSize=5`);
    assert.equal(sourceSearch.searchScope, "all");
    assert.deepEqual(sourceSearch.searchFields, []);
    assert.deepEqual(sourceSearch.records.map((record) => record.title), ["Search Strong", "Global Heavy"]);
    assert.deepEqual(sourceSearch.records.map((record) => record.count), [3, 1]);
    assert.deepEqual(sourceSearch.records.map((record) => record.globalCount), [3, 5]);
    assert.equal(sourceSearch.records[0].matchedBySource, true);
  } finally {
    if (child) {
      child.kill();
      await waitForExit(child);
      assert.equal(stderr.includes("Traceback"), false, stderr);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime API excludes blocked VTuber source occurrences from channel search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-api-blocked-source-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  let child = null;
  let stderr = "";

  try {
    writeBlockedSourceSearchFixture(latestPath);
    execFileSync(
      PYTHON,
      [
        path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
        "--input",
        latestPath,
        "--output",
        dbPath,
        "--no-vsinger",
        "--no-youtube-channel-discovery",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT: "2" },
        timeout: 30000,
      },
    );
    const port = await getFreePort();
    child = spawn(
      PYTHON,
      [
        path.join(ROOT, "server", "song_rank_api.py"),
        "--db",
        dbPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    await waitForReady(child, port);
    const safeChannelSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Safe%20Source&searchFields=channel&pageSize=5`);
    assert.equal(safeChannelSearch.searchScope, "channel");
    assert.equal(safeChannelSearch.totalCount, 1);
    assert.equal(safeChannelSearch.records[0].title, "Safe Channel Song");
    assert.equal(safeChannelSearch.records[0].matchedBySource, true);

    for (const query of ["Uchi%20Fifi", "uchififi", "UCMhjWfFiyxVjNWBJpkDotcg"]) {
      const blockedSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=${query}&searchFields=channel&pageSize=5`);
      assert.equal(blockedSearch.searchScope, "channel");
      const message = `${query} ${JSON.stringify(blockedSearch.records)}`;
      assert.equal(blockedSearch.totalCount, 0, message);
      assert.equal(blockedSearch.totalOccurrenceCount, 0, message);
      assert.deepEqual(blockedSearch.records, [], message);
    }
  } finally {
    if (child) {
      child.kill();
      await waitForExit(child);
      assert.equal(stderr.includes("Traceback"), false, stderr);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime API serves health and ranking rows from SQLite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-api-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  writeLatestFixture(latestPath);
  execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPath,
      "--no-vsinger",
      "--no-youtube-channel-discovery",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DAILY_SONG_REQUEST_PREVIEW_SOURCE_LIMIT: "2" },
    },
  );

  const port = await getFreePort();
  const child = spawn(
    PYTHON,
    [
      path.join(ROOT, "server", "song_rank_api.py"),
      "--db",
      dbPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForReady(child, port);
    const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, "ok");
    assert.equal(health.counts.videos, 4);

    const meta = await fetchJson(`http://127.0.0.1:${port}/api/meta`);
    assert.equal(meta.meta.source_latest_sha256, sha256File(latestPath));
    assert.equal(meta.meta.latest_generated_at, "2026-07-19T00:00:00.000Z");

    const rankings = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&pageSize=5`);
    assert.equal(rankings.totalCount, 4);
    assert.equal(rankings.totalOccurrenceCount, 5);
    assert.equal(rankings.records[0].title, "Song One");
    assert.equal(rankings.records[0].count, 2);

    const videoMetricRankings = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&metric=videos&pageSize=5`);
    assert.equal(videoMetricRankings.metric, "videos");
    assert.equal(videoMetricRankings.totalCount, 4);
    assert.equal(videoMetricRankings.records[0].title, "Song One");

    const songTitleSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Song%20One&pageSize=5`);
    assert.equal(songTitleSearch.totalCount, 1);
    assert.equal(songTitleSearch.totalOccurrenceCount, 2);
    assert.equal(songTitleSearch.records[0].title, "Song One");
    assert.equal(songTitleSearch.records[0].count, 2);
    assert.equal(songTitleSearch.records[0].matchedBySource, undefined);
    assert.equal(songTitleSearch.records[0].globalCount, undefined);

    const songFieldSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Singer&searchFields=title,artist&pageSize=5`);
    assert.equal(songFieldSearch.searchScope, "song");
    assert.deepEqual(songFieldSearch.searchFields, ["title", "artist"]);
    assert.deepEqual(songFieldSearch.records.map((record) => record.title), ["Song One", "Song Four", "Song Three", "Song Two"]);
    assert.deepEqual(songFieldSearch.records.map((record) => record.count), [2, 1, 1, 1]);

    const artistOnlyFieldSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Singer%20A&searchFields=artist&pageSize=5`);
    assert.equal(artistOnlyFieldSearch.searchScope, "artist");
    assert.deepEqual(artistOnlyFieldSearch.searchFields, ["artist"]);
    assert.deepEqual(artistOnlyFieldSearch.records.map((record) => record.title), ["Song One"]);

    const titleOnlyFieldSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Singer%20A&searchFields=title&pageSize=5`);
    assert.equal(titleOnlyFieldSearch.searchScope, "title");
    assert.deepEqual(titleOnlyFieldSearch.searchFields, ["title"]);
    assert.equal(titleOnlyFieldSearch.totalCount, 0);

    const channelSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&pageSize=5`);
    assert.equal(channelSongSearch.searchScope, "all");
    assert.equal(channelSongSearch.totalCount, 0);
    assert.equal(channelSongSearch.totalOccurrenceCount, 0);
    assert.deepEqual(channelSongSearch.records, []);

    const allFieldSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&searchFields=all&pageSize=5`);
    assert.equal(allFieldSongSearch.searchScope, "all");
    assert.deepEqual(allFieldSongSearch.searchFields, []);
    assert.equal(allFieldSongSearch.totalCount, 3);
    assert.equal(allFieldSongSearch.totalOccurrenceCount, 3);
    assert.deepEqual(allFieldSongSearch.records.map((record) => record.title), ["Song One", "Song Three", "Song Two"]);
    assert.equal(allFieldSongSearch.records[0].matchedByVtuber, undefined);
    assert.equal(allFieldSongSearch.records[0].matchedBySource, true);
    assert.equal(allFieldSongSearch.records[0].displayArtist, "Singer A");
    assert.equal(allFieldSongSearch.records[0].occurrences.length, 1);
    assert.equal(allFieldSongSearch.records[0].occurrences[0].item.channelName, "Alpha Ch.");
    assert.equal(allFieldSongSearch.records[0].occurrences[0].item.thumbnailUrl, "https://i.ytimg.com/vi/video-a/hqdefault.jpg");
    assert.equal(allFieldSongSearch.records[0].channels[0].name, "Alpha Ch.");

    const channelFieldSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&searchFields=channel&pageSize=5`);
    assert.equal(channelFieldSongSearch.searchScope, "channel");
    assert.deepEqual(channelFieldSongSearch.searchFields, ["channel"]);
    assert.equal(channelFieldSongSearch.totalCount, 3);
    assert.equal(channelFieldSongSearch.records[0].matchedByVtuber, undefined);
    assert.equal(channelFieldSongSearch.records[0].matchedBySource, true);
    assert.equal(channelFieldSongSearch.records[0].occurrences[0].item.channelName, "Alpha Ch.");

    const allFieldVideoTitleSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Morning&searchFields=all&pageSize=5`);
    assert.equal(allFieldVideoTitleSongSearch.searchScope, "all");
    assert.deepEqual(allFieldVideoTitleSongSearch.searchFields, []);
    assert.equal(allFieldVideoTitleSongSearch.totalCount, 2);
    assert.deepEqual(allFieldVideoTitleSongSearch.records.map((record) => record.title), ["Song One", "Song Two"]);
    assert.equal(allFieldVideoTitleSongSearch.records[0].matchedBySource, true);
    assert.equal(allFieldVideoTitleSongSearch.records[0].occurrences[0].item.title, "Morning Karaoke");

    const allFieldArtistSourceSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=%22Singer%20A%22&searchFields=all&pageSize=5`);
    assert.equal(allFieldArtistSourceSearch.searchScope, "all");
    assert.deepEqual(allFieldArtistSourceSearch.searchFields, []);
    assert.equal(allFieldArtistSourceSearch.totalCount, 1);
    assert.equal(allFieldArtistSourceSearch.records[0].title, "Song One");

    const scopedChannelSourceSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&searchScope=channel&pageSize=5`);
    assert.equal(scopedChannelSourceSongSearch.searchScope, "channel");
    assert.equal(scopedChannelSourceSongSearch.totalCount, 3);
    assert.equal(scopedChannelSourceSongSearch.totalOccurrenceCount, 3);
    assert.deepEqual(scopedChannelSourceSongSearch.records.map((record) => record.title), ["Song One", "Song Three", "Song Two"]);
    assert.equal(scopedChannelSourceSongSearch.records[0].count, 1);
    assert.equal(scopedChannelSourceSongSearch.records[0].globalCount, 2);
    assert.equal(scopedChannelSourceSongSearch.records[0].matchedBySource, true);
    assert.equal(scopedChannelSourceSongSearch.records[0].occurrences.length, 1);
    assert.equal(scopedChannelSourceSongSearch.records[0].occurrences[0].item.channelName, "Alpha Ch.");

    const scopedAllSourceSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&searchScope=source&pageSize=5`);
    assert.equal(scopedAllSourceSongSearch.searchScope, "source");
    assert.equal(scopedAllSourceSongSearch.totalCount, 3);
    assert.equal(scopedAllSourceSongSearch.totalOccurrenceCount, 3);
    assert.deepEqual(scopedAllSourceSongSearch.records.map((record) => record.title), ["Song One", "Song Three", "Song Two"]);

    const scopedChannelSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Alpha&searchScope=song&pageSize=5`);
    assert.equal(scopedChannelSongSearch.searchScope, "song");
    assert.equal(scopedChannelSongSearch.totalCount, 0);
    assert.equal(scopedChannelSongSearch.totalOccurrenceCount, 0);
    assert.deepEqual(scopedChannelSongSearch.records, []);

    const andSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Song%20AND%20Three&pageSize=5`);
    assert.equal(andSongSearch.totalCount, 1);
    assert.equal(andSongSearch.records[0].title, "Song Three");

    const orSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Song%20Two%20OR%20Song%20Four&pageSize=5`);
    assert.equal(orSongSearch.totalCount, 2);
    assert.deepEqual(orSongSearch.records.map((record) => record.title), ["Song Four", "Song Two"]);

    const escapedWildcardSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=%25&pageSize=5`);
    assert.equal(escapedWildcardSearch.totalCount, 0);

    const videoTitleSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Morning&pageSize=5`);
    assert.equal(videoTitleSongSearch.totalCount, 0);

    const scopedVideoTitleSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=Morning&searchScope=video&pageSize=5`);
    assert.equal(scopedVideoTitleSongSearch.totalCount, 2);

    const defaultFieldVideoMetricSongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&metric=videos&q=Morning&searchFields=title,artist&pageSize=5`);
    assert.equal(defaultFieldVideoMetricSongSearch.metric, "videos");
    assert.equal(defaultFieldVideoMetricSongSearch.searchScope, "video");
    assert.deepEqual(defaultFieldVideoMetricSongSearch.searchFields, ["video"]);
    assert.equal(defaultFieldVideoMetricSongSearch.totalCount, 2);
    assert.deepEqual(defaultFieldVideoMetricSongSearch.records.map((record) => record.videoCount), [1, 1]);

    const channelSongIndexSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songIndex&q=Alpha&pageSize=5`);
    assert.equal(channelSongIndexSearch.totalCount, 0);

    const scopedChannelSongIndexSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songIndex&q=Alpha&searchScope=channel&pageSize=5`);
    assert.equal(scopedChannelSongIndexSearch.totalCount, 3);

    const scopedChannelHandleSongIndexSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songIndex&q=alpha_ch&searchFields=channel&pageSize=5`);
    assert.equal(scopedChannelHandleSongIndexSearch.searchScope, "channel");
    assert.equal(scopedChannelHandleSongIndexSearch.totalCount, 3);
    assert.deepEqual(
      new Set(scopedChannelHandleSongIndexSearch.records.map((record) => record.title)),
      new Set(["Song One", "Song Two", "Song Three"]),
    );

    const vtubers = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&pageSize=5`);
    assert.equal(vtubers.totalCount, 3);
    assert.equal(vtubers.records[0].name, "Alpha Ch.");
    assert.equal(vtubers.records[0].channelId, "UC-alpha");
    assert.equal(vtubers.records[0].count, 3);
    assert.equal(vtubers.records[0].videoCount, 2);
    assert.equal(vtubers.records[0].occurrences.length, 2);
    assert.ok(vtubers.records[0].sourceDetailKey);

    const vtuberSource = await fetchJson(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(vtubers.records[0].sourceDetailKey)}`);
    assert.equal(vtuberSource.found, true);
    assert.equal(vtuberSource.record.name, "Alpha Ch.");
    assert.equal(vtuberSource.record.count, 3);
    assert.equal(vtuberSource.record.videoCount, 2);
    assert.equal(vtuberSource.record.occurrences.length, 3);
    assert.deepEqual(
      vtuberSource.record.occurrences.map((occurrence) => occurrence.song.title),
      ["Song One", "Song Two", "Song Three"],
    );

    const vtuberSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&q=Alpha&pageSize=5`);
    assert.equal(vtuberSearch.totalCount, 1);
    assert.equal(vtuberSearch.records[0].name, "Alpha Ch.");
    assert.equal(vtuberSearch.records[0].count, 3);

    const vtuberWithoutAvatar = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&q=Beta&pageSize=5`);
    assert.equal(vtuberWithoutAvatar.totalCount, 1);
    assert.equal(vtuberWithoutAvatar.records[0].name, "Beta Ch.");
    assert.equal(vtuberWithoutAvatar.records[0].avatarUrl, "");
    assert.equal(vtuberWithoutAvatar.records[0].thumbnailUrl, "https://i.ytimg.com/vi/video-b/hqdefault.jpg");
    assert.doesNotMatch(JSON.stringify(vtuberWithoutAvatar.records[0]), /data:image|fallback-avatar/u);

    const vtuberVideoMetric = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&metric=videos&q=Alpha&pageSize=5`);
    assert.equal(vtuberVideoMetric.metric, "videos");
    assert.equal(vtuberVideoMetric.records[0].videoCount, 2);

    const vtuberSongMetric = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&metric=songs&q=Alpha&pageSize=5`);
    assert.equal(vtuberSongMetric.metric, "songs");
    assert.equal(vtuberSongMetric.totalSongCount, 3);
    assert.equal(vtuberSongMetric.records[0].songCount, 3);
    assert.deepEqual(
      vtuberSongMetric.records[0].songs.map((song) => song.name),
      ["Song One", "Song Two", "Song Three"],
    );
    assert.equal(vtuberSongMetric.records[0].avatarUrl, "https://example.test/alpha-avatar.png");
    assert.equal(vtuberSongMetric.records[0].isCollected, true);
    assert.equal(vtuberSongMetric.records[0].knownSourceType, "manual");

    const dirtySongSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&q=%22Opening%20Talk%22%20OR%20%22Ending%20Talk%22%20OR%20END%20OR%20%22%E6%9C%AC%E7%B7%A8%E7%B5%82%E4%BA%86%22&searchScope=title&pageSize=5`);
    assert.equal(dirtySongSearch.totalCount, 0);
    assert.equal(dirtySongSearch.totalOccurrenceCount, 0);

    const vtuberAliasSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&q=HanamaeHaru&pageSize=5`);
    assert.equal(vtuberAliasSearch.totalCount, 1);
    assert.equal(vtuberAliasSearch.records[0].name, "Haru Ch. 花前ハル");

    const videoHandleSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=videos&q=beta_ch&searchFields=channel&pageSize=5`);
    assert.equal(videoHandleSearch.totalCount, 1);
    assert.equal(videoHandleSearch.records[0].title, "Night Karaoke");

    const videoIdChannelSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=videos&q=UC-alpha&searchFields=channel&pageSize=5`);
    assert.equal(videoIdChannelSearch.totalCount, 2);
    assert.deepEqual(
      new Set(videoIdChannelSearch.records.map((record) => record.title)),
      new Set(["Late Karaoke", "Morning Karaoke"]),
    );

    const videoTitleChannelSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=videos&q=Night&searchFields=channel&pageSize=5`);
    assert.equal(videoTitleChannelSearch.totalCount, 0);

    const sourceKey = rankings.records[0].sourceDetailKey;
    const source = await fetchJson(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(sourceKey)}`);
    assert.equal(source.found, true);
    assert.equal(source.record.title, "Song One");
    assert.equal(source.record.occurrences.length, 2);

    const sourceFirstPage = await fetchJson(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(sourceKey)}?page=1&pageSize=1`);
    assert.equal(sourceFirstPage.found, true);
    assert.equal(sourceFirstPage.page, 1);
    assert.equal(sourceFirstPage.pageSize, 1);
    assert.equal(sourceFirstPage.pageCount, 2);
    assert.equal(sourceFirstPage.totalCount, 2);
    assert.equal(sourceFirstPage.totalVideoCount, 2);
    assert.equal(sourceFirstPage.totalOccurrenceCount, 2);
    assert.equal(sourceFirstPage.record.occurrences.length, 1);
    assert.equal(sourceFirstPage.record.occurrences[0].item.videoId, "video-a");

    const sourceSecondPage = await fetchJson(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(sourceKey)}?page=2&pageSize=1`);
    assert.equal(sourceSecondPage.page, 2);
    assert.equal(sourceSecondPage.record.occurrences.length, 1);
    assert.equal(sourceSecondPage.record.occurrences[0].item.videoId, "video-b");
  } finally {
    child.kill();
    await waitForExit(child);
    assert.equal(stderr.includes("Traceback"), false, stderr);
  }
});

function writeIndexedUnknownArtistFixture(latestPath) {
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        all: {
          items: [
            indexedUnknownArtistVideo("flower-known", "Flower Known Karaoke", [
              { title: "花になって", artist: "緑黄色社会", seconds: 10, time: "0:10" },
            ]),
            indexedUnknownArtistVideo("flower-bracket-index", "Flower Bracket Karaoke", [
              { title: "⟦16⟧ 花になって", artist: "未記載", seconds: 20, time: "0:20" },
            ]),
            indexedUnknownArtistVideo("flower-plain-index", "Flower Plain Karaoke", [
              { title: "16 花になって", artist: "未記載", seconds: 30, time: "0:30" },
            ]),
          ],
        },
      },
    }),
    "utf8",
  );
}

function indexedUnknownArtistVideo(videoId, title, songs) {
  return {
    videoId,
    title,
    channelName: "Flower Ch.",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    publishedTimestamp: 1784419200000,
    publishedText: "2026-07-19",
    songs,
  };
}

function writeAllFieldSourceSortFixture(latestPath) {
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        all: {
          items: [
            sourceSortVideo("needle-a", "ordinary stream one", "needle", [
              { title: "Global Heavy", artist: "Known Artist", seconds: 10, time: "0:10" },
              { title: "Search Strong", artist: "Known Artist", seconds: 20, time: "0:20" },
            ]),
            sourceSortVideo("needle-b", "ordinary stream two", "needle", [
              { title: "Search Strong", artist: "Known Artist", seconds: 30, time: "0:30" },
            ]),
            sourceSortVideo("needle-c", "ordinary stream three", "needle", [
              { title: "Search Strong", artist: "Known Artist", seconds: 40, time: "0:40" },
            ]),
            sourceSortVideo("filler-a", "ordinary stream four", "", [
              { title: "Global Heavy", artist: "Known Artist", seconds: 50, time: "0:50" },
            ]),
            sourceSortVideo("filler-b", "ordinary stream five", "", [
              { title: "Global Heavy", artist: "Known Artist", seconds: 60, time: "1:00" },
            ]),
            sourceSortVideo("filler-c", "ordinary stream six", "", [
              { title: "Global Heavy", artist: "Known Artist", seconds: 70, time: "1:10" },
            ]),
            sourceSortVideo("filler-d", "ordinary stream seven", "", [
              { title: "Global Heavy", artist: "Known Artist", seconds: 80, time: "1:20" },
            ]),
          ],
        },
      },
    }),
    "utf8",
  );
}

function sourceSortVideo(videoId, title, keyword, songs) {
  return {
    videoId,
    title,
    channelName: "Fixture Channel",
    keyword,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    publishedTimestamp: 1784419200000,
    publishedText: "2026-07-19",
    songs,
  };
}

function writeBlockedSourceSearchFixture(latestPath) {
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-22T00:00:00.000Z",
      capturedAt: "2026-07-22T00:00:00.000Z",
      groups: {
        all: {
          items: [
            {
              videoId: "blocked-uchi-fifi",
              title: "Regional Karaoke",
              channelName: "羽芝扉扉 Uchi Fifi",
              thumbnailUrl: "https://i.ytimg.com/vi/blocked-uchi-fifi/hqdefault.jpg",
              songs: [{ title: "Blocked Regional Song", artist: "Known Artist", seconds: 10, time: "0:10" }],
            },
            {
              videoId: "safe-source-video",
              title: "Safe Karaoke",
              channelName: "Safe Source Ch.",
              channelId: "UC-safe-source",
              channelHandle: "/@safe_source",
              channelUrl: "https://www.youtube.com/@safe_source",
              thumbnailUrl: "https://i.ytimg.com/vi/safe-source-video/hqdefault.jpg",
              songs: [{ title: "Safe Channel Song", artist: "Known Artist", seconds: 20, time: "0:20" }],
            },
          ],
        },
      },
    }),
    "utf8",
  );
}

function probeSourceOccurrenceFts(dir, dbPath, query) {
  const probePath = path.join(dir, "source-fts-probe.py");
  fs.writeFileSync(
    probePath,
    [
      "import json",
      "import sqlite3",
      "import sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "query = sys.argv[2]",
      "out = {}",
      "out['hasSourceFts'] = conn.execute(\"SELECT COUNT(*) FROM sqlite_master WHERE name = 'source_occurrences_fts'\").fetchone()[0]",
      "out['hasChannelFts'] = conn.execute(\"SELECT COUNT(*) FROM sqlite_master WHERE name = 'source_occurrences_channel_fts'\").fetchone()[0]",
      "out['sourceFtsRows'] = conn.execute(\"SELECT COUNT(*) FROM source_occurrences_fts WHERE range_id = 'all' AND source_occurrences_fts MATCH ?\", (f'\\\"{query}\\\"',)).fetchone()[0] if out['hasSourceFts'] else 0",
      "conn.close()",
      "print(json.dumps(out, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf8",
  );
  return JSON.parse(execFileSync(PYTHON, [probePath, dbPath, query], { cwd: ROOT, encoding: "utf8" }));
}

function writeLatestFixture(latestPath) {
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        "7d": {
          items: [
            {
              videoId: "video-a",
              title: "Morning Karaoke",
              channelName: "Alpha Ch.",
              avatarUrl: "https://example.test/alpha-avatar.png",
              thumbnailUrl: "https://i.ytimg.com/vi/video-a/hqdefault.jpg",
              knownSourceType: "manual",
              isCollected: true,
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
                { title: "Opening Talk", artist: "unknown", seconds: 21, time: "0:21" },
                { title: "Ending Talk", artist: "未記載", seconds: 22, time: "0:22" },
              ],
            },
          ],
        },
        all: {
          items: [
            {
              videoId: "video-a",
              title: "Morning Karaoke",
              channelName: "Alpha Ch.",
              avatarUrl: "https://example.test/alpha-avatar.png",
              thumbnailUrl: "https://i.ytimg.com/vi/video-a/hqdefault.jpg",
              knownSourceType: "manual",
              isCollected: true,
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
                { title: "Opening Talk", artist: "unknown", seconds: 21, time: "0:21" },
                { title: "Ending Talk", artist: "未記載", seconds: 22, time: "0:22" },
              ],
            },
            {
              videoId: "video-b",
              title: "Night Karaoke",
              channelName: "Beta Ch.",
              channelHandle: "@beta_ch",
              channelUrl: "https://www.youtube.com/@beta_ch",
              thumbnailUrl: "https://i.ytimg.com/vi/video-b/hqdefault.jpg",
              publishedTimestamp: 1784422800000,
              publishedText: "2026-07-19",
              songs: [{ title: "Song One", artist: "Singer A", seconds: 30, time: "0:30" }],
            },
            {
              videoId: "video-c",
              title: "Late Karaoke",
              channelName: "Alpha Ch.",
              channelId: "UC-alpha",
              channelHandle: "/@alpha_ch",
              thumbnailUrl: "https://i.ytimg.com/vi/video-c/hqdefault.jpg",
              publishedTimestamp: 1784426400000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song Three", artist: "Singer C", seconds: 40, time: "0:40" },
                { title: "END", artist: "unknown", seconds: 41, time: "0:41" },
                { title: "本編終了", artist: "未記載", seconds: 42, time: "0:42" },
              ],
            },
            {
              videoId: "video-d",
              title: "Midnight Karaoke",
              channelName: "Haru Ch. 花前ハル",
              thumbnailUrl: "https://i.ytimg.com/vi/video-d/hqdefault.jpg",
              publishedTimestamp: 1784430000000,
              publishedText: "2026-07-19",
              songs: [{ title: "Song Four", artist: "Singer D", seconds: 50, time: "0:50" }],
            },
          ],
        },
      },
    }),
    "utf8",
  );
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(child, port) {
  let stdout = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`API did not become ready. stdout=${stdout}`));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("CODEX_RUNTIME_API_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`API exited before ready with code ${code}. stdout=${stdout}`));
    });
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200) return;
    } catch {
      // The readiness line is emitted just before serve_forever starts accepting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`API did not accept health checks after ready. stdout=${stdout}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return await response.json();
}
