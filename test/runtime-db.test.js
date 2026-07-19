const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.PYTHON || "python";

test("runtime DB builder creates queryable rankings and external tables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-db-"));
  const latestPath = path.join(dir, "latest.json");
  const vsingerDir = path.join(dir, "vsinger");
  const dbPath = path.join(dir, "song-rank.sqlite");
  fs.mkdirSync(vsingerDir, { recursive: true });
  const vsingerSongs = [{ externalSongId: "s1", canonicalSongId: "vsinger:s1", displayTitle: "VS Song", displayArtist: "VS Artist" }];
  const vsingerVideos = [{ externalVideoId: "v1", youtubeVideoId: "yt123456789", title: "VS Live", singerName: "VSinger", streamedAt: "2026-07-18" }];
  const vsingerOccurrences = [{ externalSongId: "s1", canonicalSongId: "vsinger:s1", externalVideoId: "v1", youtubeVideoId: "yt123456789", seconds: 123 }];

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
              thumbnailUrl: "https://i.ytimg.com/vi/video-a/hqdefault.jpg",
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
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
              thumbnailUrl: "https://i.ytimg.com/vi/video-a/hqdefault.jpg",
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
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
              songs: [{ title: "Song One (Piano Ver.)", artist: "Singer A", seconds: 30, time: "0:30" }],
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
              songs: [{ title: "Song Three", artist: "Singer C", seconds: 40, time: "0:40" }],
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

  fs.writeFileSync(
    path.join(vsingerDir, "manifest.json"),
    JSON.stringify({
      sourceSystem: "vsinger_moment_http",
      generatedAt: "2026-07-19T00:00:00.000Z",
      counts: { songs: 1, videos: 1, occurrences: 1 },
      shards: {
        songs: [{ file: "songs-0001.json", count: 1, sha256: sha256Json(vsingerSongs) }],
        videos: [{ file: "videos-0001.json", count: 1, sha256: sha256Json(vsingerVideos) }],
        occurrences: [{ file: "occurrences-0001.json", count: 1, sha256: sha256Json(vsingerOccurrences) }],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(vsingerDir, "songs-0001.json"),
    JSON.stringify(vsingerSongs),
    "utf8",
  );
  fs.writeFileSync(
    path.join(vsingerDir, "videos-0001.json"),
    JSON.stringify(vsingerVideos),
    "utf8",
  );
  fs.writeFileSync(
    path.join(vsingerDir, "occurrences-0001.json"),
    JSON.stringify(vsingerOccurrences),
    "utf8",
  );

  const buildOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--vsinger-dir",
      vsingerDir,
      "--output",
      dbPath,
      "--allow-partial-vsinger",
      "--no-youtube-channel-discovery",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(buildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);
  assert.ok(fs.existsSync(dbPath));

  const queryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songs",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(queryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(queryOutput, /Song One/);
  assert.match(queryOutput, /"totalCount": 5/);
  assert.match(queryOutput, /"totalOccurrenceCount": 6/);

  const mergedQueryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "Song One",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(mergedQueryOutput, /"count": 2/);
  assert.match(mergedQueryOutput, /"totalCount": 1/);

  const channelSongSearchOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "Alpha",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(channelSongSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(channelSongSearchOutput, /"totalCount": 0/);
  assert.match(channelSongSearchOutput, /"totalOccurrenceCount": 0/);

  const videoTitleSongSearchOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songIndex",
      "--q",
      "Morning",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoTitleSongSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoTitleSongSearchOutput, /"totalCount": 0/);

  const vtuberQueryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--q",
      "Alpha",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vtuberQueryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vtuberQueryOutput, /"totalCount": 1/);
  assert.match(vtuberQueryOutput, /"name": "Alpha Ch\."/);
  assert.match(vtuberQueryOutput, /"channelId": "UC-alpha"/);
  assert.match(vtuberQueryOutput, /"count": 3/);
  assert.match(vtuberQueryOutput, /"videoCount": 2/);

  const vtuberMissingAvatarOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--q",
      "Beta",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vtuberMissingAvatarOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vtuberMissingAvatarOutput, /"name": "Beta Ch\."/);
  assert.match(vtuberMissingAvatarOutput, /"avatarUrl": ""/);
  assert.match(vtuberMissingAvatarOutput, /"thumbnailUrl": "https:\/\/i\.ytimg\.com\/vi\/video-b\/hqdefault\.jpg"/);
  assert.doesNotMatch(vtuberMissingAvatarOutput, /data:image|fallback-avatar/u);

  const vtuberAliasQueryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--q",
      "HanamaeHaru",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vtuberAliasQueryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vtuberAliasQueryOutput, /"totalCount": 1/);
  assert.match(vtuberAliasQueryOutput, /"name": "Haru Ch\. 花前ハル"/);

  const videoMetricQueryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songs",
      "--metric",
      "videos",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoMetricQueryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoMetricQueryOutput, /"metric": "videos"/);

  const vsingerQueryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vsingerSongs",
      "--page-size",
      "5",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vsingerQueryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vsingerQueryOutput, /VS Song/);
  assert.match(vsingerQueryOutput, /"totalCount": 1/);

  const vsingerVtuberOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--q",
      "VSinger",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vsingerVtuberOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vsingerVtuberOutput, /"name": "VSinger"/);
  assert.match(vsingerVtuberOutput, /"knownSourceType": "vsinger_moment_http"/);
  assert.match(vsingerVtuberOutput, /"isCollected": true/);
});

test("runtime DB builder merges accepted YouTube channel discovery increments into rankings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-channel-db-"));
  const latestPath = path.join(dir, "latest.json");
  const channelDir = path.join(dir, "youtube-channel-discovery");
  const acceptedDir = path.join(channelDir, "accepted");
  const dbPath = path.join(dir, "song-rank.sqlite");
  fs.mkdirSync(acceptedDir, { recursive: true });

  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: { "7d": { items: [] }, all: { items: [] } },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(acceptedDir, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceSystem: "youtube_channel_discovery",
      generatedAt: "2026-07-19T01:00:00.000Z",
      videos: [
        {
          videoId: "3sYGvwElb14",
          title: "Channel Overlay Karaoke #香鳴ハノン",
          url: "https://www.youtube.com/watch?v=chanvideo01",
          channelName: "",
          channelId: "",
          channelHandle: "",
          channelUrl: "https://www.youtube.com/@kanaruhanon",
          publishedTimestamp: 1784332800000,
          publishedText: "2026-07-18",
          songs: [
            { title: "Overlay Song", artist: "Overlay Artist", time: "1:23", seconds: 83 },
            { title: "Overlay Song", artist: "Overlay Artist", time: "5:00", seconds: 300 },
          ],
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(channelDir, "channel-metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceSystem: "youtube_channel_discovery",
      channels: [
        {
          handle: "/@kanaruhanon",
          displayName: "Hanon Ch. 香鳴ハノン【パレプロ】",
          channelId: "UCay6Y3oEoiC6ZEE2G0UZu_A",
          channelUrl: "https://www.youtube.com/channel/UCay6Y3oEoiC6ZEE2G0UZu_A",
          sourceUrl: "https://www.youtube.com/@kanaruhanon",
          avatarUrl: "https://yt3.googleusercontent.com/hanon-avatar=s900-c-k-c0x00ffffff-no-rj",
          knownSourceType: "youtube_channel_discovery",
        },
      ],
    }),
    "utf8",
  );

  const buildOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPath,
      "--no-vsinger",
      "--youtube-channel-discovery-dir",
      channelDir,
      "--require-youtube-channel-discovery",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(buildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);

  const queryOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "Overlay Song",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(queryOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(queryOutput, /Overlay Song/);
  assert.match(queryOutput, /"totalCount": 1/);
  assert.match(queryOutput, /"totalOccurrenceCount": 2/);

  const videoHandleSearchOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "videos",
      "--q",
      "3sYGvwElb14",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoHandleSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoHandleSearchOutput, /"totalCount": 1/);
  assert.match(videoHandleSearchOutput, /Hanon Ch\. 香鳴ハノン【パレプロ】/);
  assert.match(videoHandleSearchOutput, /UCay6Y3oEoiC6ZEE2G0UZu_A/);
  assert.match(videoHandleSearchOutput, /hanon-avatar/);

  const videoUrlSearchOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "videos",
      "--q",
      "youtube.com/@kanaruhanon",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoUrlSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoUrlSearchOutput, /"totalCount": 1/);

  const vtuberSongMetricOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPath,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--metric",
      "songs",
      "--q",
      "kanaruhanon",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vtuberSongMetricOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(vtuberSongMetricOutput, /"metric": "songs"/);
  assert.match(vtuberSongMetricOutput, /"name": "Hanon Ch\. 香鳴ハノン【パレプロ】"/);
  assert.match(vtuberSongMetricOutput, /"songCount": 1/);
  assert.match(vtuberSongMetricOutput, /"isCollected": true/);
});

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
