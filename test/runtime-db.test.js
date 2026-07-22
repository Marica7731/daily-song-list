const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.PYTHON || "python";

test("runtime DB builder cleans channel path handles without metadata and upgrades display names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-db-channel-handle-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-22T00:00:00.000Z",
      capturedAt: "2026-07-22T00:00:00.000Z",
      groups: {
        all: {
          items: [
            {
              videoId: "ISSHIKI0001",
              title: "English label",
              channelName: "Isshiki Izu",
              channelId: "UCISSHIKI",
              channelHandle: "/channel/UCISSHIKI",
              channelUrl: "https://www.youtube.com/channel/UCISSHIKI",
              channelAliases: ["/channel/UCISSHIKI", "Isshiki Izu"],
              songs: [{ title: "雑魚", artist: "柊マグネタイト", seconds: 10 }],
            },
            {
              videoId: "ISSHIKI0002",
              title: "Japanese label",
              channelName: "一色イズ◇Isshiki IS",
              channelId: "UCISSHIKI",
              channelHandle: "/@IsshikiIS",
              channelUrl: "https://www.youtube.com/@IsshikiIS",
              songs: [{ title: "雑魚", artist: "柊マグネタイト", seconds: 20 }],
            },
          ],
        },
      },
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
      "--no-youtube-channel-discovery",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(buildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);

  const probePath = path.join(dir, "channel-handle-db-probe.py");
  fs.writeFileSync(
    probePath,
    [
      "import json",
      "import sqlite3",
      "import sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "out = {}",
      "out['videos'] = [json.loads(row[0]) for row in conn.execute(\"SELECT payload_json FROM videos ORDER BY video_id\")]",
      "out['occurrences'] = [json.loads(row[0]) for row in conn.execute(\"SELECT payload_json FROM occurrences ORDER BY occurrence_id\")]",
      "out['sourceOccurrences'] = [json.loads(row[0]) for row in conn.execute(\"SELECT payload_json FROM source_occurrences WHERE range_id = 'all' ORDER BY source_key, position\")]",
      "row = conn.execute(\"SELECT handle, display_name, payload_json FROM channel_metadata WHERE channel_id = 'UCISSHIKI'\").fetchone()",
      "out['channelMetadata'] = {'handle': row[0], 'displayName': row[1], 'payload': json.loads(row[2])}",
      "conn.close()",
      "print(json.dumps(out, ensure_ascii=True))",
      "",
    ].join("\n"),
    "utf8",
  );
  const probe = JSON.parse(execFileSync(PYTHON, [probePath, dbPath], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(probe.videos.every((item) => item.channelHandle !== "/channel/UCISSHIKI"), true);
  assert.equal(probe.occurrences.every((item) => item.video.channelHandle !== "/channel/UCISSHIKI"), true);
  assert.equal(
    probe.sourceOccurrences.every((item) => item.item.channelHandle !== "/channel/UCISSHIKI" && !(item.item.channelAliases || []).includes("/channel/UCISSHIKI")),
    true,
  );
  assert.equal(probe.channelMetadata.handle, "/@IsshikiIS");
  assert.equal(probe.channelMetadata.displayName, "一色イズ◇Isshiki IS");
});

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
                { title: "Calc Alias Song", artist: "Calc", seconds: 25, time: "0:25" },
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
              songs: [
                { title: "Song One (Piano Ver.)", artist: "Singer A", seconds: 30, time: "0:30" },
                { title: "Calc Alias Song", artist: "Calc.", seconds: 35, time: "0:35" },
              ],
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
                { title: "No Logic", artist: "ジミーサムP", seconds: 45, time: "0:45" },
              ],
            },
            {
              videoId: "video-d",
              title: "Midnight Karaoke",
              channelName: "Haru Ch. 花前ハル",
              thumbnailUrl: "https://i.ytimg.com/vi/video-d/hqdefault.jpg",
              publishedTimestamp: 1784430000000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song Four", artist: "Singer D", seconds: 50, time: "0:50" },
                { title: "No Logic", artist: "OneRoom", seconds: 55, time: "0:55" },
              ],
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
  assert.match(buildOutput, /vsingerSourceDetails=1/);
  assert.match(buildOutput, /vsingerSourceOccurrences=1/);
  assert.ok(fs.existsSync(dbPath));

  const sqliteProbePath = path.join(dir, "sqlite-source-probe.py");
  fs.writeFileSync(
    sqliteProbePath,
    [
      "import json",
      "import sqlite3",
      "import sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "out = {}",
      "out['vsinger_source_details'] = conn.execute(\"SELECT COUNT(*) FROM source_details WHERE entity_type = 'vsingerSong'\").fetchone()[0]",
      "out['vsinger_source_occurrences'] = conn.execute(\"SELECT COUNT(*) FROM source_occurrences WHERE source_key IN (SELECT source_key FROM source_details WHERE entity_type = 'vsingerSong')\").fetchone()[0]",
      "conn.close()",
      "print(json.dumps(out, ensure_ascii=False))",
      "",
    ].join("\n"),
    "utf8",
  );
  const sqliteProbeOutput = execFileSync(PYTHON, [sqliteProbePath, dbPath], { cwd: ROOT, encoding: "utf8" });
  const sqliteProbe = JSON.parse(sqliteProbeOutput);
  assert.equal(sqliteProbe.vsinger_source_details, 1);
  assert.equal(sqliteProbe.vsinger_source_occurrences, 1);

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
  assert.match(queryOutput, /"totalCount": 7/);
  assert.match(queryOutput, /"totalOccurrenceCount": 10/);

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
  assert.match(channelSongSearchOutput, /"totalCount": 5/);
  assert.match(channelSongSearchOutput, /"totalOccurrenceCount": 8/);

  const scopedChannelSongSearchOutput = execFileSync(
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
      "--search-scope",
      "song",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(scopedChannelSongSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(scopedChannelSongSearchOutput, /"searchScope": "song"/);
  assert.match(scopedChannelSongSearchOutput, /"totalCount": 0/);

  const andSongSearchOutput = execFileSync(
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
      "Alpha AND Three",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(andSongSearchOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(andSongSearchOutput, /"title": "Song Three"/);
  assert.match(andSongSearchOutput, /"totalCount": 1/);

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
  assert.match(videoTitleSongSearchOutput, /"totalCount": 3/);

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
  assert.match(vtuberQueryOutput, /"count": 5/);
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

  const videoHandleChannelScopeOutput = execFileSync(
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
      "beta_ch",
      "--search-scope",
      "channel",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoHandleChannelScopeOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoHandleChannelScopeOutput, /"totalCount": 1/);
  assert.match(videoHandleChannelScopeOutput, /"title": "Night Karaoke"/);

  const videoIdChannelScopeOutput = execFileSync(
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
      "UC-alpha",
      "--search-scope",
      "channel",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoIdChannelScopeOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoIdChannelScopeOutput, /"totalCount": 1/);
  assert.match(videoIdChannelScopeOutput, /"title": "Late Karaoke"/);

  const videoTitleChannelScopeOutput = execFileSync(
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
      "Night",
      "--search-scope",
      "channel",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(videoTitleChannelScopeOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(videoTitleChannelScopeOutput, /"totalCount": 0/);

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
  assert.match(vsingerVtuberOutput, /"isCollected": false/);
});

test("runtime DB builder treats moment source aliases as not collected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-db-moment-alias-"));
  const latestPath = path.join(dir, "latest.json");

  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        "7d": { items: [] },
        all: {
          items: [
            {
              videoId: "MOMALIAS001",
              title: "Moment alias karaoke",
              channelName: "Moment Alias Ch.",
              isCollected: true,
              sourceQuality: { sourceType: "external", sourceSystem: "moment" },
              songs: [{ title: "Moment Alias Song", artist: "Moment Alias Artist", seconds: 10, time: "0:10" }],
            },
            {
              videoId: "VSALIAS0001",
              title: "VSinger moment alias karaoke",
              channelName: "VSinger Moment Alias Ch.",
              isCollected: true,
              sourceQuality: { sourceType: "external", sourceSystem: "vsinger-moment" },
              songs: [{ title: "VSinger Moment Alias Song", artist: "VSinger Moment Alias Artist", seconds: 20, time: "0:20" }],
            },
            {
              videoId: "MANUALALIAS",
              title: "Manual source karaoke",
              channelName: "Manual Alias Ch.",
              knownSourceType: "manual",
              isCollected: false,
              songs: [{ title: "Manual Alias Song", artist: "Manual Alias Artist", seconds: 30, time: "0:30" }],
            },
          ],
        },
      },
    }),
    "utf8",
  );

  for (const rankingSource of ["js", "python"]) {
    const dbPath = path.join(dir, `song-rank-${rankingSource}.sqlite`);
    const buildArgs = [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPath,
      "--no-vsinger",
      "--no-youtube-channel-discovery",
    ];
    if (rankingSource === "python") buildArgs.push("--ranking-source", "python");
    const buildOutput = execFileSync(PYTHON, buildArgs, { cwd: ROOT, encoding: "utf8" });
    assert.match(buildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);

    const vtuberOutput = execFileSync(
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
        "Alias",
        "--page-size",
        "10",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const payload = parseDbQueryOutput(vtuberOutput);
    const byName = new Map(payload.records.map((record) => [record.name, record]));
    assert.equal(byName.get("Moment Alias Ch.").knownSourceType, "moment", rankingSource);
    assert.equal(byName.get("Moment Alias Ch.").isCollected, false, rankingSource);
    assert.equal(byName.get("VSinger Moment Alias Ch.").knownSourceType, "vsinger-moment", rankingSource);
    assert.equal(byName.get("VSinger Moment Alias Ch.").isCollected, false, rankingSource);
    assert.equal(byName.get("Manual Alias Ch.").knownSourceType, "manual", rankingSource);
    assert.equal(byName.get("Manual Alias Ch.").isCollected, true, rankingSource);
  }
});

test("runtime DB builder repairs indexed unknown-artist known songs before ranking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-db-repair-"));
  const latestPath = path.join(dir, "latest.json");

  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        "7d": { items: [] },
        all: {
          items: [
            {
              videoId: "known-song-repair",
              title: "Indexed known songs",
              channelName: "Repair Ch.",
              thumbnailUrl: "https://i.ytimg.com/vi/known-song-repair/hqdefault.jpg",
              publishedTimestamp: 1784430000000,
              publishedText: "2026-07-19",
              songs: [
                { title: "花になって", artist: "緑黄色社会", seconds: 10, time: "0:10" },
                { title: "⟦16⟧ 花になって", artist: "未記載", seconds: 20, time: "0:20" },
                { title: "16 花になって", artist: "未記載", seconds: 30, time: "0:30" },
                { title: "花になって - Be a flower", artist: "未記載", seconds: 40, time: "0:40" },
                { title: "52😎花になって", artist: "未記載", seconds: 50, time: "0:50" },
                { title: "晴る", artist: "ヨルシカ", seconds: 60, time: "1:00" },
                { title: "晴るる", artist: "未記載", seconds: 70, time: "1:10" },
              ],
            },
          ],
        },
      },
    }),
    "utf8",
  );

  for (const rankingSource of ["js", "python"]) {
    const dbPath = path.join(dir, `song-rank-${rankingSource}.sqlite`);
    const buildArgs = [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPath,
      "--no-vsinger",
      "--no-youtube-channel-discovery",
    ];
    if (rankingSource === "python") buildArgs.push("--ranking-source", "python");
    const buildOutput = execFileSync(PYTHON, buildArgs, { cwd: ROOT, encoding: "utf8" });
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
        "花になって",
        "--summary-only",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.match(queryOutput, /CODEX_RUNTIME_DB_QUERY_OK/, rankingSource);
    assert.match(queryOutput, /"totalCount": 1/, rankingSource);
    assert.match(queryOutput, /"count": 5/, rankingSource);
    assert.match(queryOutput, /"displayArtist": "緑黄色社会"/, rankingSource);
    assert.doesNotMatch(queryOutput, /::unknown|未記載|⟦16⟧|16 花になって|Be a flower|52😎/u, rankingSource);

    const sourcePreviewProbePath = path.join(dir, `source-preview-probe-${rankingSource}.py`);
    fs.writeFileSync(
      sourcePreviewProbePath,
      [
        "import json",
        "import sqlite3",
        "import sys",
        "conn = sqlite3.connect(sys.argv[1])",
        "def payloads(table):",
        "    rows = conn.execute(f\"SELECT payload_json FROM {table} WHERE range_id = 'all'\").fetchall()",
        "    for (payload_json,) in rows:",
        "        try:",
        "            yield json.loads(payload_json)",
        "        except Exception:",
        "            continue",
        "def song_from_payload(payload):",
        "    song = payload.get('song') if isinstance(payload, dict) else {}",
        "    return song if isinstance(song, dict) else {}",
        "def is_flower(song):",
        "    title = str(song.get('title') or '')",
        "    return '花になって' in title or 'Be a flower' in title",
        "def summarize(table):",
        "    songs = [song_from_payload(payload) for payload in payloads(table)]",
        "    flowers = [song for song in songs if is_flower(song)]",
        "    return {",
        "        'flower_count': len(flowers),",
        "        'unknown_count': sum(1 for song in flowers if str(song.get('artist') or '') == '未記載'),",
        "        'dirty_title_count': sum(1 for song in flowers if any(marker in str(song.get('title') or '') for marker in ('⟦16⟧', '16 花になって', 'Be a flower', '52😎'))),",
        "    }",
        "out = {'source_occurrences': summarize('source_occurrences'), 'occurrences': summarize('occurrences')}",
        "conn.close()",
        "print(json.dumps(out, ensure_ascii=False))",
        "",
      ].join("\n"),
      "utf8",
    );
    const sourcePreviewProbeOutput = execFileSync(PYTHON, [sourcePreviewProbePath, dbPath], { cwd: ROOT, encoding: "utf8" });
    const sourcePreviewProbe = JSON.parse(sourcePreviewProbeOutput);
    assert.ok(sourcePreviewProbe.source_occurrences.flower_count > 0, rankingSource);
    assert.equal(sourcePreviewProbe.source_occurrences.unknown_count, 0, rankingSource);
    assert.equal(sourcePreviewProbe.source_occurrences.dirty_title_count, 0, rankingSource);
    assert.equal(sourcePreviewProbe.occurrences.flower_count, 5, rankingSource);
    assert.equal(sourcePreviewProbe.occurrences.unknown_count, 0, rankingSource);
    assert.equal(sourcePreviewProbe.occurrences.dirty_title_count, 0, rankingSource);

    const haruruOutput = execFileSync(
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
        "晴るる",
        "--summary-only",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const haruruPayload = parseDbQueryOutput(haruruOutput);
    assert.equal(haruruPayload.totalCount, 1, rankingSource);
    assert.equal(haruruPayload.firstRecord.title, "晴るる", rankingSource);
    assert.notEqual(haruruPayload.firstRecord.displayArtist, "ヨルシカ", rankingSource);
    assert.equal(["", "未記載"].includes(haruruPayload.firstRecord.displayArtist), true, rankingSource);
  }
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
      groups: {
        "7d": { items: [] },
        all: {
          items: [
            {
              videoId: "ZEAgcWCnkwQ",
              title: "Riona karaoke",
              channelName: "Riona Ch. 響咲リオナ - FLOW GLOW",
              channelHandle: "@IsakiRiona",
              channelUrl: "https://www.youtube.com/@IsakiRiona",
              knownSourceType: "vsinger_moment_http",
              isCollected: true,
              sourceGroups: ["vsinger-moment"],
              songs: [
                { title: "自己肯定感がドンドン上がってる", artist: "未記載", time: "56:02", seconds: 3362 },
                { title: "START", artist: "愛内里菜", time: "1:06:40", seconds: 4000 },
                { title: "Calc Alias Song", artist: "Calc", time: "1:07:00", seconds: 4020 },
                { title: "No Logic", artist: "ジミーサムP", time: "1:08:00", seconds: 4080 },
              ],
            },
            {
              videoId: "naretan0001",
              title: "Naretan chat source",
              channelName: "Naretan Ch. なれたん",
              channelHandle: "@naretan",
              knownSourceType: "vsinger_moment_http",
              sourceGroups: ["vsinger-moment"],
              songs: [
                { title: "なれたん", artist: "未記載", time: "0:01", seconds: 1 },
                { title: "【雑談】リクエスト確認", artist: "未記載", time: "0:02", seconds: 2 },
                { title: "星座になれたら", artist: "結束バンド", time: "0:03", seconds: 3 },
                {
                  title: "初めて日本の病院に行ってきました",
                  artist: "I Went to a Japanese Hospital for the First Time",
                  raw: "00:06:50 初めて日本の病院に行ってきました / I Went to a Japanese Hospital for the First Time",
                  time: "0:04",
                  seconds: 4,
                },
                {
                  title: "音楽停止（クリックミス）",
                  artist: "Music stops (accidental click)",
                  raw: "01:43:25 音楽停止（クリックミス） / Music stops (accidental click)",
                  time: "0:05",
                  seconds: 5,
                },
                { title: "なれコールアンケート", artist: "未記載", raw: "01:44:00 なれコールアンケート", time: "0:06", seconds: 6 },
                { title: "食あたり", artist: "Food Poisoning", raw: "01:44:10 食あたり / Food Poisoning", time: "0:07", seconds: 7 },
                { title: "晩餐歌", artist: "tuki.", raw: "1:04:22 晩餐歌 / tuki.", time: "0:08", seconds: 8 },
                { title: "晩餐歌 (Bansanka)", artist: "tuki.", raw: "1:05:22 晩餐歌 (Bansanka) / tuki.", time: "0:08:30", seconds: 510 },
                { title: "上野公園の桜", artist: "Cherry Blossoms at Ueno Park", raw: "0:09 上野公園の桜 / Cherry Blossoms at Ueno Park", time: "0:09", seconds: 9 },
                { title: "ホログラム", artist: "NICO Touches the Walls", raw: "0:10 ホログラム / NICO Touches the Walls", time: "0:10", seconds: 10 },
                {
                  title: "今日の衣装と髪型",
                  artist: "Today’s Outfit and Hairstyle",
                  raw: "00:35:35 今日の衣装と髪型 / Today’s Outfit and Hairstyle",
                  time: "0:11",
                  seconds: 11,
                },
                {
                  title: "韓国の職場の雰囲気",
                  artist: "Workplace Atmosphere in Korea",
                  raw: "00:26:16 韓国の職場の雰囲気 / Workplace Atmosphere in Korea",
                  time: "0:12",
                  seconds: 12,
                },
                {
                  title: "恋ダンスをするネンドウ君",
                  artist: "Nendou Doing the “Koi Dance”",
                  raw: "03:47:46 恋ダンスをするネンドウ君 / Nendou Doing the “Koi Dance”",
                  time: "0:13",
                  seconds: 13,
                },
                {
                  title: "缶をマイクに",
                  artist: "Using a Can as a Microphone",
                  raw: "00:22:13 缶をマイクに / Using a Can as a Microphone",
                  time: "0:14",
                  seconds: 14,
                },
                {
                  title: "あなたのお金を数えましょう",
                  artist: "Let’s Count Your Money",
                  raw: "01:01:09 あなたのお金を数えましょう / Let’s Count Your Money",
                  time: "0:15",
                  seconds: 15,
                },
                {
                  title: "著作権の問題でミュートされています",
                  artist: "Muted Due to Copyright Issues",
                  raw: "01:40:09 著作権の問題でミュートされています / Muted Due to Copyright Issues",
                  time: "0:16",
                  seconds: 16,
                },
                {
                  title: "AFK (away from keyboard)",
                  artist: "未記載",
                  raw: "03:36:05 03:38:51 AFK (away from keyboard)",
                  time: "0:17",
                  seconds: 17,
                },
                {
                  title: "ペットショップ",
                  artist: "Pet Shop",
                  raw: "01:58:12 ペットショップ / Pet Shop",
                  time: "0:18",
                  seconds: 18,
                },
                {
                  title: "ドンキホーテのラー油",
                  artist: "Donki Hote’s Chili Oil",
                  raw: "01:47:22 ドンキホーテのラー油 / Donki Hote’s Chili Oil",
                  time: "0:19",
                  seconds: 19,
                },
                {
                  title: "ケンタッキーとバーガーキング",
                  artist: "KFC and Burger King",
                  raw: "01:06:15 ケンタッキーとバーガーキング / KFC and Burger King",
                  time: "0:20",
                  seconds: 20,
                },
                {
                  title: "切り抜き酒のラベル",
                  artist: "Clip-Style Sake Label",
                  raw: "02:07:56 切り抜き酒のラベル / Clip-Style Sake Label",
                  time: "0:21",
                  seconds: 21,
                },
                {
                  title: "春が嫌いな人",
                  artist: "People Who Hate Spring",
                  raw: "00:18:38 春が嫌いな人 / People Who Hate Spring",
                  time: "0:22",
                  seconds: 22,
                },
                {
                  title: "カンニング（新しく覚えてきた曲を再確認）",
                  artist: "Cheating (Rechecking a Newly Learned Song)",
                  raw: "00:42:54 カンニング（新しく覚えてきた曲を再確認） / Cheating (Rechecking a Newly Learned Song)",
                  time: "0:23",
                  seconds: 23,
                },
                {
                  title: "セトリは概要欄です",
                  artist: "Setlist is in the description",
                  raw: "00:43:00 01. セトリは概要欄です / Setlist is in the description",
                  time: "0:24",
                  seconds: 24,
                },
                {
                  title: "初見さんいらっしゃい",
                  artist: "Welcome first-time viewers",
                  raw: "00:43:10 初見さんいらっしゃい / Welcome first-time viewers",
                  time: "0:25",
                  seconds: 25,
                },
                { title: "Calc Alias Song", artist: "Calc.", raw: "00:44:00 Calc Alias Song / Calc.", time: "0:26", seconds: 26 },
                { title: "No Logic", artist: "OneRoom", raw: "00:45:00 No Logic / OneRoom", time: "0:27", seconds: 27 },
              ],
            },
            {
              videoId: "flower00123",
              title: "Flower variants karaoke",
              channelName: "Flower Ch.",
              channelHandle: "@flower_v",
              channelUrl: "https://www.youtube.com/@flower_v",
              knownSourceType: "manual",
              thumbnailUrl: "https://i.ytimg.com/vi/flower00123/hqdefault.jpg",
              publishedTimestamp: 1784337000000,
              publishedText: "2026-07-18",
              songs: [
                { title: "花になって", artist: "緑黄色社会", time: "1:00", seconds: 60 },
                { title: "花になって - Be a flower", artist: "未記載", time: "2:00", seconds: 120 },
                { title: "52😎花になって", artist: "未記載", time: "3:00", seconds: 180 },
              ],
            },
            {
              videoId: "PrEfIx00123",
              title: "Prefix marker karaoke",
              channelName: "Prefix Marker Ch.",
              channelUrl: "https://www.youtube.com/@prefixmarker",
              knownSourceType: "manual",
              thumbnailUrl: "https://i.ytimg.com/vi/PrEfIx00123/hqdefault.jpg",
              publishedTimestamp: 1784336100000,
              publishedText: "2026-07-18",
              songs: [
                { title: "No01. Honey♥Come!!", artist: "小倉唯", time: "1:00", seconds: 60 },
                { title: "Honey♥Come!!", artist: "小倉唯", time: "2:00", seconds: 120 },
                { title: "27;0:11:02 エマ", artist: "go!go!vanillas", time: "3:00", seconds: 180 },
                { title: "エマ", artist: "go!go!vanillas", time: "4:00", seconds: 240 },
              ],
            },
          ],
        },
      },
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
          channelHandle: "/channel/UCay6Y3oEoiC6ZEE2G0UZu_A",
          channelUrl: "https://www.youtube.com/@kanaruhanon",
          publishedTimestamp: 1784332800000,
          publishedText: "2026-07-18",
          songs: [
            { title: "Overlay Song", artist: "Overlay Artist", time: "1:23", seconds: 83 },
            { title: "Overlay Song", artist: "Overlay Artist", time: "5:00", seconds: 300 },
            { title: "END", artist: "unknown", time: "6:00", seconds: 360 },
            { title: "Opening Talk", artist: "未記載", time: "7:00", seconds: 420 },
            { title: "Ending Talk", artist: "unknown", time: "8:00", seconds: 480 },
            { title: "本編終了", artist: "未記載", time: "9:00", seconds: 540 },
            { title: "曲名教えてください", artist: "未記載", raw: "9:30 曲名教えてください", time: "9:30", seconds: 570 },
            { title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO", time: "10:00", seconds: 600 },
            { title: "Never Ending Story", artist: "Limahl", time: "10:30", seconds: 630 },
            { title: "START:DASH!!", artist: "μ's", time: "10:45", seconds: 645 },
            { title: "Pretender", artist: "Official髭男dism", time: "11:00", seconds: 660 },
            { title: "spending", artist: "Known Artist", time: "12:00", seconds: 720 },
            { title: "Opening", artist: "Known Artist", time: "13:00", seconds: 780 },
          ],
        },
        {
          videoId: "collab00123",
          title: "Collaboration Karaoke",
          channelName: "CHIYURU ch.三日月ちゆる、Hanon Ch. 香鳴ハノン【パレプロ】",
          channelId: "",
          channelHandle: "",
          channelUrl: "",
          thumbnailUrl: "https://i.ytimg.com/vi/collab00123/hqdefault.jpg",
          publishedTimestamp: 1784336400000,
          publishedText: "2026-07-18",
          songs: [{ title: "Collaboration Song", artist: "Singer", time: "1:00", seconds: 60 }],
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

  const artistAliasOutput = execFileSync(
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
      "\"Calc Alias Song\" OR \"No Logic\"",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(artistAliasOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const artistAliasPayload = parseDbQueryOutput(artistAliasOutput);
  const calcAlias = artistAliasPayload.records.find((record) => record.title === "Calc Alias Song");
  const noLogicAlias = artistAliasPayload.records.find((record) => record.title === "No Logic");
  assert.equal(artistAliasPayload.totalCount, 2);
  assert.equal(calcAlias.displayArtist, "Calc.");
  assert.equal(calcAlias.timestampCount, 2);
  assert.equal(noLogicAlias.displayArtist, "ジミーサムP");
  assert.equal(noLogicAlias.timestampCount, 2);

  const prefixMarkerOutput = execFileSync(
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
      "\"Honey♥Come!!\" OR エマ",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(prefixMarkerOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const prefixMarkerPayload = parseDbQueryOutput(prefixMarkerOutput);
  const honeyPrefix = prefixMarkerPayload.records.find((record) => record.title === "Honey♥Come!!");
  const emaPrefix = prefixMarkerPayload.records.find((record) => record.title === "エマ");
  assert.equal(honeyPrefix.timestampCount, 2);
  assert.equal(emaPrefix.timestampCount, 2);

  const rawPrefixMarkerOutput = execFileSync(
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
      "\"No01. Honey♥Come!!\" OR \"27;0:11:02 エマ\"",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(rawPrefixMarkerOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(rawPrefixMarkerOutput, /"totalCount": 0/);

  const dirtySongOutput = execFileSync(
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
      "\"Opening Talk\" OR \"Ending Talk\" OR \"本編終了\" OR \"自己肯定感がドンドン上がってる\" OR なれたん OR \"【雑談】リクエスト確認\" OR 初めて日本の病院に行ってきました OR 音楽停止 OR なれコールアンケート OR 食あたり OR 上野公園の桜 OR 今日の衣装と髪型 OR 韓国の職場の雰囲気 OR 恋ダンスをするネンドウ君 OR 缶をマイクに OR あなたのお金を数えましょう OR 著作権の問題でミュートされています OR AFK OR ペットショップ OR ドンキホーテのラー油 OR ケンタッキーとバーガーキング OR 切り抜き酒のラベル OR 春が嫌いな人 OR カンニング OR セトリは概要欄です OR 初見さんいらっしゃい OR 曲名教えてください",
      "--search-scope",
      "title",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(dirtySongOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(dirtySongOutput, /"totalCount": 0/);

  const retainedMomentSongOutput = execFileSync(
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
      "START OR 星座になれたら OR 晩餐歌",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(retainedMomentSongOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(retainedMomentSongOutput, /"totalCount": 4/);

  const songAliasOutput = execFileSync(
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
      "晩餐歌",
      "--search-scope",
      "title",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(songAliasOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const songAliasPayload = parseDbQueryOutput(songAliasOutput);
  assert.equal(songAliasPayload.totalCount, 1);
  assert.equal(songAliasPayload.records[0].title, "晩餐歌");
  assert.equal(songAliasPayload.records[0].displayArtist, "tuki.");
  assert.equal(songAliasPayload.records[0].timestampCount, 2);

  const retainedEnglishArtistOutput = execFileSync(
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
      "ホログラム",
      "--search-scope",
      "title",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(retainedEnglishArtistOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(retainedEnglishArtistOutput, /NICO Touches the Walls/);
  assert.match(retainedEnglishArtistOutput, /"totalCount": 1/);

  const safeSongOutput = execFileSync(
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
      "\"ENDLESS STORY\" OR \"Never Ending Story\" OR \"START:DASH\" OR Pretender OR spending OR Opening",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(safeSongOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(safeSongOutput, /"totalCount": 6/);

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

  const channelHandleProbePath = path.join(dir, "channel-handle-probe.py");
  fs.writeFileSync(
    channelHandleProbePath,
    [
      "import json",
      "import sqlite3",
      "import sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "rows = conn.execute(\"SELECT payload_json FROM source_occurrences WHERE range_id = 'all'\").fetchall()",
      "matches = []",
      "for (payload_json,) in rows:",
      "    payload = json.loads(payload_json)",
      "    item = payload.get('item') if isinstance(payload, dict) else {}",
      "    if isinstance(item, dict) and item.get('videoId') == '3sYGvwElb14':",
      "        matches.append({",
      "            'channelName': item.get('channelName'),",
      "            'channelHandle': item.get('channelHandle'),",
      "            'channelAliases': item.get('channelAliases'),",
      "        })",
      "conn.close()",
      "print(json.dumps(matches, ensure_ascii=True))",
      "",
    ].join("\n"),
    "utf8",
  );
  const channelHandleProbe = JSON.parse(execFileSync(PYTHON, [channelHandleProbePath, dbPath], { cwd: ROOT, encoding: "utf8" }));
  assert.ok(channelHandleProbe.length > 0);
  assert.equal(channelHandleProbe.every((item) => item.channelName === "Hanon Ch. 香鳴ハノン【パレプロ】"), true);
  assert.equal(channelHandleProbe.every((item) => item.channelHandle === "/@kanaruhanon"), true);
  assert.equal(channelHandleProbe.every((item) => !(item.channelAliases || []).includes("/channel/UCay6Y3oEoiC6ZEE2G0UZu_A")), true);

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
  assert.match(vtuberSongMetricOutput, /"songCount": 7/);
  assert.match(vtuberSongMetricOutput, /"isCollected": true/);
  const vtuberSongMetricPayload = parseDbQueryOutput(vtuberSongMetricOutput);
  assert.deepEqual(
    vtuberSongMetricPayload.records[0].songs.map((song) => song.name),
    ["Overlay Song", "ENDLESS STORY", "Never Ending Story", "START:DASH!!", "Pretender", "spending", "Opening"],
  );

  const flowerVtuberSongMetricOutput = execFileSync(
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
      "Flower",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(flowerVtuberSongMetricOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const flowerVtuberSongMetricPayload = parseDbQueryOutput(flowerVtuberSongMetricOutput);
  assert.equal(flowerVtuberSongMetricPayload.records[0].songCount, 1);
  assert.deepEqual(flowerVtuberSongMetricPayload.records[0].songs, [{ key: "花になって", name: "花になって", count: 3 }]);

  const momentOnlyVtuberOutput = execFileSync(
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
      "IsakiRiona",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(momentOnlyVtuberOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(momentOnlyVtuberOutput, /"knownSourceType": "vsinger_moment_http"/);
  assert.match(momentOnlyVtuberOutput, /"isCollected": false/);

  const dbPathPython = path.join(dir, "song-rank-python.sqlite");
  const pythonBuildOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPathPython,
      "--no-vsinger",
      "--youtube-channel-discovery-dir",
      channelDir,
      "--require-youtube-channel-discovery",
      "--ranking-source",
      "python",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonBuildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);
  const pythonArtistAliasOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPathPython,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "\"Calc Alias Song\" OR \"No Logic\"",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonArtistAliasOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const pythonArtistAliasPayload = parseDbQueryOutput(pythonArtistAliasOutput);
  const pythonCalcAlias = pythonArtistAliasPayload.records.find((record) => record.title === "Calc Alias Song");
  const pythonNoLogicAlias = pythonArtistAliasPayload.records.find((record) => record.title === "No Logic");
  assert.equal(pythonArtistAliasPayload.totalCount, 2);
  assert.equal(pythonCalcAlias.displayArtist, "Calc.");
  assert.equal(pythonCalcAlias.timestampCount, 2);
  assert.equal(pythonNoLogicAlias.displayArtist, "ジミーサムP");
  assert.equal(pythonNoLogicAlias.timestampCount, 2);

  const pythonPrefixMarkerOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPathPython,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "\"Honey♥Come!!\" OR エマ",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonPrefixMarkerOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const pythonPrefixMarkerPayload = parseDbQueryOutput(pythonPrefixMarkerOutput);
  const pythonHoneyPrefix = pythonPrefixMarkerPayload.records.find((record) => record.title === "Honey♥Come!!");
  const pythonEmaPrefix = pythonPrefixMarkerPayload.records.find((record) => record.title === "エマ");
  assert.equal(pythonHoneyPrefix.timestampCount, 2);
  assert.equal(pythonEmaPrefix.timestampCount, 2);

  const pythonRawPrefixMarkerOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPathPython,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "\"No01. Honey♥Come!!\" OR \"27;0:11:02 エマ\"",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonRawPrefixMarkerOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(pythonRawPrefixMarkerOutput, /"totalCount": 0/);

  const pythonDirtySongOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPathPython,
      "--range",
      "all",
      "--view",
      "songs",
      "--q",
      "今日の衣装と髪型 OR 韓国の職場の雰囲気 OR 恋ダンスをするネンドウ君 OR 缶をマイクに OR あなたのお金を数えましょう OR 著作権の問題でミュートされています OR AFK OR ペットショップ OR ドンキホーテのラー油 OR ケンタッキーとバーガーキング OR 切り抜き酒のラベル OR 春が嫌いな人 OR カンニング",
      "--search-scope",
      "title",
      "--page-size",
      "5",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonDirtySongOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(pythonDirtySongOutput, /"totalCount": 0/);

  const pythonFlowerVtuberSongMetricOutput = execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "query-runtime-db.py"),
      "--db",
      dbPathPython,
      "--range",
      "all",
      "--view",
      "vtubers",
      "--metric",
      "songs",
      "--q",
      "Flower",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(pythonFlowerVtuberSongMetricOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const pythonFlowerVtuberSongMetricPayload = parseDbQueryOutput(pythonFlowerVtuberSongMetricOutput);
  assert.equal(pythonFlowerVtuberSongMetricPayload.records[0].songCount, 1);
  assert.deepEqual(pythonFlowerVtuberSongMetricPayload.records[0].songs, [{ name: "花になって", count: 3 }]);

  const compositeVtuberOutput = execFileSync(
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
      "三日月ちゆる",
      "--summary-only",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(compositeVtuberOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  assert.match(compositeVtuberOutput, /"totalCount": 0/);
});

test("runtime DB builder drops same-second translated alias rows from bilingual source lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-db-translated-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-22T00:00:00.000Z",
      capturedAt: "2026-07-22T00:00:00.000Z",
      groups: {
        all: {
          items: [
            {
              videoId: "video-translated",
              title: "Bilingual Karaoke",
              channelName: "Alias Ch.",
              thumbnailUrl: "https://i.ytimg.com/vi/video-translated/hqdefault.jpg",
              publishedTimestamp: 1784678400000,
              publishedText: "2026-07-22",
              songs: [
                { title: "ピースサイン", artist: "米津玄師", seconds: 741, time: "12:21" },
                { title: "Peace Sign", artist: "Kenshi Yonezu", seconds: 741, time: "12:21" },
                { title: "マリーゴールド", artist: "あいみょん", seconds: 1392, time: "23:12" },
                { title: "Marigold", artist: "Aimyon", seconds: 1392, time: "23:12" },
                { title: "晩餐歌", artist: "tuki.", seconds: 2400, time: "40:00" },
                { title: "Bansanka", artist: "tuki.", seconds: 2400, time: "40:00" },
                { title: "Hello", artist: "Adele", seconds: 2000, time: "33:20" },
              ],
            },
          ],
        },
      },
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
      "--no-youtube-channel-discovery",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(buildOutput, /CODEX_RUNTIME_DB_BUILD_OK/);

  const songOutput = execFileSync(
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
      "\"ピースサイン\" OR \"Peace Sign\" OR \"マリーゴールド\" OR Marigold OR 晩餐歌 OR Bansanka OR Hello",
      "--search-scope",
      "title",
      "--page-size",
      "10",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(songOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const songPayload = parseDbQueryOutput(songOutput);
  assert.deepEqual(
    songPayload.records.map((record) => record.title).sort(),
    ["Hello", "ピースサイン", "マリーゴールド", "晩餐歌"].sort(),
  );
  assert.equal(songPayload.records.find((record) => record.title === "Hello")?.displayArtist, "Adele");
  assert.equal(songPayload.records.find((record) => record.title === "晩餐歌")?.timestampCount, 1);

  const vtuberOutput = execFileSync(
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
      "Alias",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.match(vtuberOutput, /CODEX_RUNTIME_DB_QUERY_OK/);
  const vtuberPayload = parseDbQueryOutput(vtuberOutput);
  assert.equal(vtuberPayload.records[0].songCount, 4);
  assert.deepEqual(
    vtuberPayload.records[0].songs.map((song) => song.name).sort(),
    ["Hello", "ピースサイン", "マリーゴールド", "晩餐歌"].sort(),
  );
});

function parseDbQueryOutput(output) {
  const markerIndex = output.lastIndexOf("\nCODEX_RUNTIME_DB_QUERY_OK");
  assert.notEqual(markerIndex, -1, output);
  return JSON.parse(output.slice(0, markerIndex));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
