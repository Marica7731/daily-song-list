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
    { cwd: ROOT, encoding: "utf8" },
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
    assert.equal(allFieldSongSearch.records[0].matchedByVtuber, true);
    assert.equal(allFieldSongSearch.records[0].matchedBySource, true);
    assert.equal(allFieldSongSearch.records[0].displayArtist, "Singer A");
    assert.equal(allFieldSongSearch.records[0].occurrences.length, 1);
    assert.equal(allFieldSongSearch.records[0].occurrences[0].item.channelName, "Alpha Ch.");
    assert.equal(allFieldSongSearch.records[0].occurrences[0].item.thumbnailUrl, "https://i.ytimg.com/vi/video-a/hqdefault.jpg");
    assert.equal(allFieldSongSearch.records[0].channels[0].name, "Alpha Ch.");

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

    const vtubers = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=vtubers&pageSize=5`);
    assert.equal(vtubers.totalCount, 3);
    assert.equal(vtubers.records[0].name, "Alpha Ch.");
    assert.equal(vtubers.records[0].channelId, "UC-alpha");
    assert.equal(vtubers.records[0].count, 3);
    assert.equal(vtubers.records[0].videoCount, 2);

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

    const videoHandleSearch = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=videos&q=beta_ch&pageSize=5`);
    assert.equal(videoHandleSearch.totalCount, 1);
    assert.equal(videoHandleSearch.records[0].title, "Night Karaoke");

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
