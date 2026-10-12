import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HISTORY_GAP, REPAIR_SOURCE_GROUP, buildStaticSite, canonicalizeStaticSong, hashId, initialState, persistCompleted, readChannelSetlistImports, reconcileChannelSetlistImports, selectInspectionBatch } = require("../scripts/static/collect-and-build.js");
const { buildChannelSetlists } = require("../scripts/static/export-channel-setlists.js");
const { computeHistoryGaps, gitBlobSha1, importLegacyDocument, migrateRecoveryState, recoveryBudgetExpired, rejectIncompleteSource, snapshotCoverage, verifySourceBytes } = require("../scripts/static/recover-history.js");
const { compareSearchResults, matchSearchItems, searchScore } = require("../assets/static-search-utils.js");



test("numeric song search prioritizes semantic titles and rejects metadata/ordinal false positives", () => {
  const items = [
    { type: "songs", name: "17", secondary: "椎名林檎", occurrenceCount: 1, videoCount: 1 },
    { type: "songs", name: "17才", secondary: "森高千里", occurrenceCount: 4, videoCount: 4 },
    { type: "songs", name: "17歳の唄", secondary: "阿部真央", occurrenceCount: 1, videoCount: 1 },
    { type: "songs", name: "𝟏𝟕. きゅうくらりん", secondary: "いよわ feat.可不", occurrenceCount: 30, videoCount: 30 },
    { type: "songs", name: "君はロックを聴かない", secondary: "あいみょん（2017年）", occurrenceCount: 50, videoCount: 50 },
    { type: "songs", name: "Rebirth-day", secondary: "01:05:17", occurrenceCount: 40, videoCount: 40 },
    { type: "songs", name: "晩餐歌", secondary: "tuki.(17)", occurrenceCount: 20, videoCount: 20 },
    { type: "songs", name: "Song 17: River", secondary: "未記載", occurrenceCount: 10, videoCount: 10 },
    { type: "songs", name: "セプテンバーさん/Aimer cover 2016/08", secondary: "17 Key=G# (+6)", occurrenceCount: 8, videoCount: 8 },
    { type: "songs", name: "くじびきアンバランス", secondary: "UNDER17", occurrenceCount: 3, videoCount: 3 },
  ];
  const matched = matchSearchItems(items, "songs", "17")
    .sort((a, b) => b.searchScore - a.searchScore || b.occurrenceCount - a.occurrenceCount);

  assert.deepEqual(
    matched.slice(0, 3).map((item) => [item.name, item.secondary]),
    [["17", "椎名林檎"], ["17才", "森高千里"], ["17歳の唄", "阿部真央"]],
  );
  assert.equal(searchScore(items[3], "songs", "17"), -1, "setlist ordinal must not match");
  assert.equal(searchScore(items[4], "songs", "17"), -1, "2017 metadata must not match");
  assert.equal(searchScore(items[5], "songs", "17"), -1, "timestamp must not match");
  assert.equal(searchScore(items[6], "songs", "17"), -1, "parenthesized age metadata must not match");
  assert.equal(searchScore(items[7], "songs", "17"), -1, "Song 17 ordinal must not match");
  assert.equal(searchScore(items[8], "songs", "17"), -1, "key metadata must not match");
  assert.ok(searchScore({ type: "songs", name: "ヒバナ", secondary: "DECO*27" }, "songs", "27") > 0);
});

test("leading artist sigils stay significant in text search", () => {
  const items = [
    { type: "songs", name: "再会", secondary: "*Luna", occurrenceCount: 4, videoCount: 4 },
    { type: "songs", name: "流星のパルス", secondary: "*Luna feat.初音ミク", occurrenceCount: 3, videoCount: 3 },
    { type: "songs", name: "Moonlight", secondary: "Luna", occurrenceCount: 30, videoCount: 30 },
    { type: "songs", name: "君と夏フェス", secondary: "SHISHAMO", occurrenceCount: 20, videoCount: 20 },
    { type: "songs", name: "君と夏フェス", secondary: "＠SHISHAMO", occurrenceCount: 1, videoCount: 1 },
  ];

  const star = matchSearchItems(items, "songs", "*luna")
    .sort((a, b) => b.searchScore - a.searchScore || b.occurrenceCount - a.occurrenceCount);
  assert.deepEqual(
    star.map((item) => [item.name, item.secondary]),
    [["再会", "*Luna"], ["流星のパルス", "*Luna feat.初音ミク"]],
  );
  assert.equal(searchScore(items[2], "songs", "*luna"), -1, "plain Luna must not satisfy an explicit *Luna query");
  assert.ok(searchScore(items[0], "songs", "luna") > 0, "plain luna remains a broad search");
  assert.ok(searchScore(items[4], "songs", "@shishamo") > 0, "NFKC must preserve a full-width leading sigil");
  assert.equal(searchScore(items[3], "songs", "@shishamo"), -1, "explicit @ must not collapse into plain SHISHAMO");
});

test("yorushika catalog repairs swapped and fragmented derived song identities", () => {
  assert.deepEqual(canonicalizeStaticSong({ title: "ヨルシカ", artist: "晴る" }), {
    title: "晴る",
    artist: "ヨルシカ",
    originalTitle: "ヨルシカ",
    originalArtist: "晴る",
    canonicalTitle: "晴る",
    canonicalArtist: "ヨルシカ",
    catalogRepair: "yorushika_official_catalog",
  });
  assert.equal(canonicalizeStaticSong({ title: "𝟎𝟏. ノーチラス", artist: "ヨルシカ" }).title, "ノーチラス");
  assert.equal(canonicalizeStaticSong({ title: "盜作", artist: "ヨルシカ" }).title, "盗作");
  assert.equal(canonicalizeStaticSong({ title: "若者のすべて", artist: "suis from ヨルシカ" }).artist, "ヨルシカ");
  assert.deepEqual(
    canonicalizeStaticSong({ title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" }),
    { title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" },
  );
  assert.deepEqual(canonicalizeStaticSong({ title: "声", artist: "Aimer" }), { title: "声", artist: "Aimer" });
});

test("yorushika search orders exact artist matches by occurrence count", () => {
  const items = [
    { name: "ヨルシカ", secondary: "晴る", occurrenceCount: 1, videoCount: 1 },
    { name: "花に亡霊", secondary: "ヨルシカ", occurrenceCount: 494, videoCount: 493 },
    { name: "ヨルシカ ｰ 嘘月", secondary: "練歌", occurrenceCount: 1, videoCount: 1 },
  ];
  const sorted = [...items].sort((left, right) => compareSearchResults(left, right, "ヨルシカ"));
  assert.deepEqual(sorted.map((item) => item.occurrenceCount), [494, 1, 1]);
});

test("static search exposes real result pagination", () => {
  const app = fs.readFileSync(path.resolve("assets/static-app.js"), "utf8");
  assert.match(app, /compareSearchResults\(left, right, raw\)/u);
  assert.match(app, /state\.pageCount = Math\.max\(1, Math\.ceil\(results\.length \/ 50\)\)/u);
  assert.match(app, /render\(pageResults\);\s*renderPager\(\);/u);
  assert.doesNotMatch(app, /el\.page\.textContent = "搜索"/u);
  assert.doesNotMatch(app, /function goPage\(target\) \{\s*if \(el\.search\.value\.trim\(\)\) return;/u);
});

test("static pipeline emits resumable today/3d/7d/30d/all shards and explicit gap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-static-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  const now = new Date("2026-09-01T00:00:00Z");
  const state = initialState(now);
  state.continuityStart = "2026-09-01T00:01:00Z";
  state.lastSourceSnapshotId = "fixture-1";
  state.lastSourceCapturedAt = now.toISOString();
  state.sourceCoverage = { status: "success", candidateVideos: 1 };
  state.processedVideoIds = ["abcdefghijk"];
  state.queue = [
    { videoId: "pending-today", publishedTimestamp: Date.parse("2026-09-01T00:02:00Z") },
    { videoId: "pending-old", publishedTimestamp: Date.parse("2026-07-01T00:00:00Z") },
    { videoId: "pending-unknown-publish", snapshotCapturedAt: now.toISOString() },
  ];
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(dataRoot, "days/2026-09-01.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-09-01",
    videos: [{
      videoId: "abcdefghijk",
      title: "fixture stream",
      channelName: "Fixture VTuber",
      channelId: "UCfixture",
      publishedAt: "2026-09-01T00:00:00Z",
      thumbnailUrl: "https://example.invalid/a.jpg",
      watchUrl: "https://youtube.com/watch?v=abcdefghijk",
      keyword: "歌枠",
      keywords: ["歌枠"],
      songs: [
        { occurrenceId: "one", time: "00:10", seconds: 10, title: "Song A", artist: "Artist A" },
        { occurrenceId: "two", time: "00:20", seconds: 20, title: "Song A", artist: "Artist A" },
        ...Array.from({ length: 8 }, (_, index) => ({
          occurrenceId: `extra-${index}`, time: `00:${String(30 + index).padStart(2, "0")}`, seconds: 30 + index,
          title: "Song A", artist: "Artist A",
        })),
        { occurrenceId: "bad-live-meta", time: "04:00", seconds: 240, title: "24/07/2026", artist: "Live Ao vivo", raw: "Santo Rosário | Sexta-feira | 04:00 | 24/07/2026 | Live Ao vivo" },
        { occurrenceId: "reviewed-ad", time: "05:00", seconds: 300, title: "『ボイスカード』全国のAIICO自販機にて販売中9/15〜10", artist: "31", raw: "3:20:44『ボイスカード』全国のAIICO自販機にて販売中9/15〜10/31", sourceHash: "3ce2889d374219c88ef71404170db724289081434d471593996f75067f4d4a59" },
      ],
    }],
  }));

  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 1, maxShardBytes: 100000 });
  assert.equal(meta.ranges.today.songs.totalCount, 1);
  assert.equal(meta.ranges["3d"].songs.totalCount, 1);
  assert.equal(meta.ranges["7d"].songs.totalCount, 1);
  assert.equal(meta.songOccurrenceCount, 10);
  assert.deepEqual(meta.ranges.today.stats, {
    videoCount: 1,
    songOccurrenceCount: 10,
    pendingVideoCount: 1,
    quarantinedOccurrences: 1,
    deduplicatedOccurrences: 0,
  });
  assert.equal(meta.ranges["3d"].stats.pendingVideoCount, 1);
  assert.equal(meta.ranges["7d"].stats.pendingVideoCount, 1);
  assert.equal(meta.ranges["30d"].stats.pendingVideoCount, 1);
  assert.equal(meta.ranges.all.stats.pendingVideoCount, 3);
  assert.equal(meta.ranges.all.stats.quarantinedOccurrences, 1);
  assert.equal(meta.ranges["7d"].songs.pageNumberWidth, 4);
  assert.equal(meta.ranges["7d"].songs.path, "rankings/7d/songs/page-{page:04d}.json");
  assert.equal(meta.ranges["30d"].artists.totalCount, 1);
  assert.equal(meta.ranges.all.vtubers.totalCount, 1);
  assert.deepEqual(meta.historyGaps, [HISTORY_GAP]);
  const page = JSON.parse(fs.readFileSync(path.join(dataRoot, "rankings/7d/songs/page-0001.json")));
  assert.equal(page.items[0].occurrenceCount, 10);
  assert.equal(page.items[0].detailPath, `entities/songs/${hashId("songs\u001fsonga\u001fartista")}.json`);
  const detail = JSON.parse(fs.readFileSync(path.join(dataRoot, page.items[0].detailPath)));
  assert.equal(detail.occurrences.length, 10);
  assert.equal(page.items[0].videoCount, 1);
  assert.equal(page.items[0].sourcesPreview.length, 1);
  assert.equal(page.items[0].sourcesPreview[0].channelName, "Fixture VTuber");

  const vtuberPage = JSON.parse(fs.readFileSync(path.join(dataRoot, "rankings/7d/vtubers/page-0001.json")));
  assert.equal(vtuberPage.items[0].occurrenceCount, 10);
  assert.equal(vtuberPage.items[0].videoCount, 1);
  assert.equal(vtuberPage.items[0].songCount, 1);
  assert.equal(vtuberPage.items[0].sourcesPreview.length, 1);
  assert.equal(vtuberPage.items[0].channelId, "UCfixture");

  const songId = hashId("songs\u001fsonga\u001fartista");
  const searchShard = JSON.parse(fs.readFileSync(path.join(dataRoot, `search/${songId[0]}.json`)));
  const searchSong = searchShard.items.find((item) => item.id === songId);
  assert.ok(searchSong);
  assert.equal(searchSong.occurrenceCount, 10);
  assert.equal(searchSong.videoCount, 1);
  assert.equal(searchSong.rangeMetrics.today.occurrenceCount, 10);
  assert.equal(searchSong.rangeMetrics["3d"].videoCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, "quality-audit.json"))).visibleOccurrences, 10);
  assert.equal("sourcesPreview" in searchSong, false);
  assert.deepEqual(searchSong.keywords, ["歌枠"]);
  fs.rmSync(root, { recursive: true, force: true });
});



test("reviewed collection config hydrates channel identity and merges split vtuber entities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-collection-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  const now = new Date("2026-10-06T00:00:00Z");
  const state = initialState(now);
  state.processedVideoIds = ["raraOld0001", "raraNew0001"];
  state.queue = [];
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify(state));
  const song = { occurrenceId: "song", time: "0:01", seconds: 60, title: "CANDY CANDY", artist: "きゃりーぱみゅぱみゅ" };
  fs.writeFileSync(path.join(dataRoot, "days/2026-10-06.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-06",
    videos: [
      { videoId: "raraOld0001", title: "old", channelName: "Rara Channel / 小鳥遊らら", channelId: "", channelHandle: "", publishedAt: "2026-10-06T00:00:00Z", thumbnailUrl: "https://example.invalid/old.jpg", watchUrl: "https://youtube.com/watch?v=raraOld0001", keywords: ["歌枠"], songs: [song] },
      { videoId: "raraNew0001", title: "new", channelName: "Rara Channel / 小鳥遊らら", channelId: "UCLIEOGtrywxsLztMPPKtfkA", channelHandle: "@RaraTakanashi", publishedAt: "2026-10-06T00:01:00Z", thumbnailUrl: "https://example.invalid/new.jpg", watchUrl: "https://youtube.com/watch?v=raraNew0001", keywords: ["歌枠"], songs: [song] },
    ],
  }));
  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 50, maxShardBytes: 100000 });
  const page = JSON.parse(fs.readFileSync(path.join(dataRoot, "rankings/all/vtubers/page-0001.json"), "utf8"));
  assert.equal(page.totalCount, 1, "missing channel identity must not split the collected entity");
  const item = page.items[0];
  assert.equal(item.channelId, "UCLIEOGtrywxsLztMPPKtfkA");
  assert.equal(item.channelHandle, "@RaraTakanashi");
  assert.equal(item.channelUrl, "https://www.youtube.com/@RaraTakanashi");
  assert.equal(item.collected, true);
  assert.equal(meta.ranges.all.vtubers.totalCount, 1);
  const detail = JSON.parse(fs.readFileSync(path.join(dataRoot, item.detailPath), "utf8"));
  assert.equal(detail.collected, true);
  assert.equal(detail.occurrences.length, 2);
  assert.equal(detail.channelId, "UCLIEOGtrywxsLztMPPKtfkA");
  assert.equal(detail.channelHandle, "@RaraTakanashi");
  assert.equal(detail.channelUrl, "https://www.youtube.com/@RaraTakanashi");
  const searchShard = JSON.parse(fs.readFileSync(path.join(dataRoot, `search/${item.id[0]}.json`), "utf8"));
  const searchItem = searchShard.items.find((entry) => entry.id === item.id);
  assert.equal(searchItem.channelId, "UCLIEOGtrywxsLztMPPKtfkA");
  assert.equal(searchItem.channelHandle, "@RaraTakanashi");
  assert.equal(searchItem.channelUrl, "https://www.youtube.com/@RaraTakanashi");
  const songPage = JSON.parse(fs.readFileSync(path.join(dataRoot, "rankings/all/songs/page-0001.json"), "utf8"));
  assert.equal(songPage.items[0].collected, false, "song entities must not inherit channel collection state");
  assert.equal(songPage.items[0].collectionId, "", "song entities must not inherit collection id");
  fs.rmSync(root, { recursive: true, force: true });
});

test("static frontend keeps operational gaps out of the normal UI and never fabricates dash metrics", () => {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const app = fs.readFileSync(path.resolve("assets/static-app.js"), "utf8");
  const css = fs.readFileSync(path.resolve("assets/static.css"), "utf8");
  assert.doesNotMatch(html, /id=["']gap["']|MISSING|历史缺口|不会把缺失历史伪装成完整数据/);
  assert.doesNotMatch(app, /不会把缺失历史伪装成完整数据|occurrenceCount\s*:\s*["']–["']|videoCount\s*:\s*["']–["']/);
  assert.match(html, /class="rank-header"/);
  assert.match(app, /sourcesPreview/);
  assert.match(app, /查看全部来源/);
  assert.match(app, /hydrateSearchMetrics/);
  assert.match(app, /function renderStatus\(range\)/);
  assert.match(app, /state\.meta\.ranges\?\.\[range\]\?\.stats/);
  assert.match(app, /候选待处理/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /class="filter-panel"/);
  assert.match(app, /daily-song-list-theme/);
  assert.match(app, /initTheme\(\)/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /\.filter-panel\s*\{[\s\S]*?position:absolute/);
  assert.doesNotMatch(css, /\/\* 2026-09-28 compact filter popover[\s\S]*?\.filter-popover\[open\]\s*\{[^}]*width\s*:\s*260px/);
});

test("static inspection batch prioritizes fresh videos and still drains backlog", () => {
  const now = new Date("2026-09-16T00:00:00Z");
  const old = Array.from({ length: 30 }, (_, index) => ({
    videoId: `old-${String(index).padStart(2, "0")}`,
    publishedTimestamp: Date.parse("2026-08-01T00:00:00Z") + index * 1000,
  }));
  const recent = Array.from({ length: 30 }, (_, index) => ({
    videoId: `recent-${String(index).padStart(2, "0")}`,
    publishedTimestamp: Date.parse("2026-09-15T00:00:00Z") + index * 1000,
  }));

  const batch = selectInspectionBatch([...old, ...recent], 24, now);
  assert.equal(batch.length, 24);
  assert.deepEqual(batch.slice(0, 3).map((item) => item.videoId), ["recent-29", "recent-28", "recent-27"]);
  assert.deepEqual(batch.slice(-4).map((item) => item.videoId), ["old-00", "old-01", "old-02", "old-03"]);

  const backlogOnly = selectInspectionBatch(old, 24, now);
  assert.deepEqual(backlogOnly.map((item) => item.videoId), old.slice(0, 24).map((item) => item.videoId));
});

test("static inspection batch hoists an explicitly requested video", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const queue = [
    ...Array.from({ length: 40 }, (_, index) => ({
      videoId: `recent${String(index).padStart(7, "0")}`,
      publishedTimestamp: Date.parse("2026-10-05T23:00:00Z") + index * 1000,
    })),
    { videoId: "flahkQbUguU", publishedTimestamp: Date.parse("2026-10-05T19:30:38Z") },
  ];

  const batch = selectInspectionBatch(queue, 24, now, ["flahkQbUguU"]);
  assert.equal(batch[0].videoId, "flahkQbUguU");
  assert.equal(batch.length, 24);

  const fallbackBatch = selectInspectionBatch(queue, 24, now);
  assert.equal(fallbackBatch[0].videoId, "flahkQbUguU");
});

test("an all-failed inspection batch never blocks the static publication path", () => {
  const source = fs.readFileSync(path.resolve("scripts/static/collect-and-build.js"), "utf8");
  assert.match(source, /batch_degraded attempted=\$\{batch\.length\} failed=\$\{failures\.length\}; continuing with last successful state/u);
  assert.doesNotMatch(source, /all \$\{batch\.length\} bounded inspections failed/u);
});

test("static update workflow is GitHub-hosted, resumable, and commits only static data", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-update.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /cron: "23 \* \* \* \*"/);
  assert.match(workflow, /default: "60"/);
  assert.match(workflow, /Resolve bounded drain size/);
  assert.match(workflow, /if \(\( video_limit > 60 \)\); then/);
  assert.match(workflow, /STATIC_UPDATE_LIMIT_CAPPED requested=\$video_limit effective=60/);
  assert.match(workflow, /STATIC_VIDEO_LIMIT: \$\{\{ steps\.drain\.outputs\.video_limit \}\}/);
  assert.match(workflow, /priority_video_ids:/);
  assert.match(workflow, /STATIC_PRIORITY_VIDEO_IDS: \$\{\{ steps\.drain\.outputs\.priority_video_ids \}\}/);
  assert.match(workflow, /STATIC_UPDATE_INVALID_PRIORITY_VIDEO_ID/);
  assert.match(workflow, /VIDEO_LIMIT: \$\{\{ steps\.drain\.outputs\.video_limit \}\}/);
  assert.match(workflow, /Queue immediate continuation while backlog remains/);
  assert.match(workflow, /STATIC_UPDATE_CONTINUE pending=\$pending video_limit=\$VIDEO_LIMIT/);
  assert.match(workflow, /gh workflow run static-update\.yml --ref main -f video_limit="\$VIDEO_LIMIT"/);
  assert.match(workflow, /-f priority_video_ids="\$PRIORITY_VIDEO_IDS"/);
  assert.match(workflow, /Hand off dropped videos to the repair workflow/);
  assert.match(workflow, /STATIC_UPDATE_HANDOFF dropped=\$dropped/);
  assert.match(workflow, /gh workflow run static-repair-dropped\.yml --ref main/);
  assert.match(workflow, /if \(\( pending == 0 \)\); then/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /npm run static:update/);
  assert.match(workflow, /npm run static:validate/);
  assert.match(workflow, /git add -- data\/static\/v1/);
  assert.match(workflow, /git fetch --deepen=10 origin main/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /STATIC_UPDATE_ALREADY_PUBLISHED/);
  assert.match(workflow, /STATIC_UPDATE_REBASE_RETRY attempt=/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /STATIC_UPDATE_REBASE_UNEXPECTED_PATH/);
  assert.match(workflow, /\[\[ "\$path" == data\/static\/v1\/\* \]\]/);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh /i);
});

test("legacy all is byte-bound, split into day shards, and restores all beyond 7d", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-legacy-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(dataRoot, { recursive: true });
  const now = new Date("2026-09-01T00:00:00Z");
  const state = initialState(now);
  migrateRecoveryState(state);
  const legacy = {
    id: "all", retentionPolicy: "permanent", generatedAt: "2026-08-22T17:52:03.305Z",
    items: [{
      videoId: "abcdefghijk", title: "old stream", channelName: "Old VTuber", channelId: "",
      publishedTimestamp: Date.parse("2026-01-02T03:04:05Z"), sourceGroups: ["today"], selectedSourceId: "source",
      songs: [
        { occurrenceId: null, index: 1, time: "0:10", seconds: 10, title: "Old Song", artist: "Old Artist", raw: "old", rawHash: "raw-hash", sourceId: "source", sourceHash: "hash", needsReview: false },
        { occurrenceId: "empty", index: 2, time: "0:20", seconds: 20, title: "", artist: "未記載", raw: "", rawHash: "empty-hash", sourceId: "source", sourceHash: "hash", needsReview: false },
      ],
    }],
  };
  const source = { commit: "fixture", generatedAt: legacy.generatedAt };
  const summary = importLegacyDocument(dataRoot, state, legacy, source, now, 100000);
  assert.equal(summary.videoCount, 1);
  assert.equal(summary.occurrenceCount, 1);
  assert.equal(summary.derivedOccurrenceIds, 1);
  assert.equal(summary.rejectedEmptyTitles, 1);
  assert.equal(summary.missingChannelIds, 1);
  assert.equal(fs.readdirSync(path.join(dataRoot, "days/2026-01-02")).length, 1);
  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 50, maxShardBytes: 100000 });
  assert.equal(meta.ranges["7d"].songs.totalCount, 0);
  assert.equal(meta.ranges.all.songs.totalCount, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("recovery source proof uses Git blob identity and missing days compact into ranges", () => {
  const bytes = Buffer.from("immutable fixture\n");
  const source = { bytes: bytes.length, gitBlobSha1: gitBlobSha1(bytes) };
  assert.equal(verifySourceBytes(bytes, source).gitBlobSha1, source.gitBlobSha1);
  const days = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`2026-08-${String(23 + index).padStart(2, "0")}`, "MISSING"]));
  days["2026-08-24"] = "COMPLETE";
  days["2026-08-25"] = "COMPLETE";
  assert.deepEqual(computeHistoryGaps(days), [
    { from: "2026-08-23", through: "2026-08-23", status: "MISSING" },
    { from: "2026-08-26", through: "2026-08-31", status: "MISSING" },
  ]);
});

test("truncated immutable discovery remains MISSING", () => {
  assert.deepEqual(snapshotCoverage({ groups: { today: { sources: [{ keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true }] } } }), {
    complete: false,
    status: "MISSING",
    sourceCount: 1,
    incomplete: [{ keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true }],
  });
  assert.equal(snapshotCoverage({ groups: { today: { sources: [{ keyword: "弾き語り", itemCount: 80, limit: 500, reachedBottom: true, truncatedByLimit: false }] } } }).status, "COMPLETE");
});

test("truncated immutable discovery is rejected before partial videos are ingested", () => {
  const state = { recoveryDates: {}, historyDays: {}, processedVideoIds: ["existing-video"] };
  const coverage = snapshotCoverage({ groups: { today: { sources: [{ keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true }] } } });
  const outcome = rejectIncompleteSource(
    state,
    "2026-08-30",
    { attempts: 0, noProgressAttempts: 0, processedEligibleVideos: 0 },
    { snapshotId: "snapshot-0830", capturedAt: "2026-08-30T15:48:12.759Z", videoCount: 600 },
    "data/today-snapshots/snapshot-0830.json",
    { sha256: "fixture-sha" },
    coverage,
    new Date("2026-09-01T06:00:00Z"),
  );

  assert.deepEqual(outcome, {
    status: "MISSING",
    processingStatus: "SKIPPED_INCOMPLETE_SOURCE",
    remaining: 0,
    inspected: 0,
    completed: 0,
    failures: 0,
    checkpointReason: "incomplete_source",
    checkpointElapsedMs: 0,
    noProgressAttempts: 0,
    purgedVideos: 0,
    purgedOccurrences: 0,
    purgedFiles: 0,
    requeuedVideos: 0,
    coverage,
    proof: { sha256: "fixture-sha" },
  });
  assert.equal(state.historyDays["2026-08-30"], "MISSING");
  assert.equal(state.recoveryDates["2026-08-30"].sourceVideoCount, 600);
  assert.equal(state.recoveryDates["2026-08-30"].eligibleVideos, 0);
  assert.equal(state.recoveryDates["2026-08-30"].processedEligibleVideos, 0);
  assert.deepEqual(state.processedVideoIds, ["existing-video"]);
});

test("truncated immutable discovery purges prior partial writes and requeues only their videos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-incomplete-source-"));
  const dataRoot = path.join(root, "data/static/v1");
  const daysRoot = path.join(dataRoot, "days");
  const partRoot = path.join(daysRoot, "2026-08-22");
  fs.mkdirSync(partRoot, { recursive: true });
  const incompleteVideo = {
    videoId: "partial0001", sourceSnapshotId: "snapshot-0823",
    songs: [{ occurrenceId: "one" }, { occurrenceId: "two" }],
  };
  const secondIncompleteVideo = {
    videoId: "partial0002", sourceSnapshotId: "snapshot-0823",
    songs: [{ occurrenceId: "three" }],
  };
  const completeVideo = {
    videoId: "complete001", sourceSnapshotId: "snapshot-0824",
    songs: [{ occurrenceId: "four" }],
  };
  fs.writeFileSync(path.join(daysRoot, "2026-08-23.json"), JSON.stringify({
    schemaVersion: 1, day: "2026-08-23", videos: [incompleteVideo, completeVideo],
  }));
  fs.writeFileSync(path.join(partRoot, "part-0001.json"), JSON.stringify({
    schemaVersion: 1, day: "2026-08-22", videos: [secondIncompleteVideo],
  }));
  const state = {
    recoveryDates: {}, historyDays: {},
    processedVideoIds: ["partial0001", "partial0002", "complete001", "metadata-only"],
  };
  const coverage = snapshotCoverage({ groups: { today: { sources: [{
    keyword: "歌枠", itemCount: 500, limit: 500, reachedBottom: false, truncatedByLimit: true,
  }] } } });
  const outcome = rejectIncompleteSource(
    state,
    "2026-08-23",
    { attempts: 3, noProgressAttempts: 0, processedEligibleVideos: 595 },
    { snapshotId: "snapshot-0823", capturedAt: "2026-08-23T15:50:46.174Z", videoCount: 611 },
    "data/today-snapshots/snapshot-0823.json",
    { sha256: "fixture-sha" },
    coverage,
    new Date("2026-09-01T07:00:00Z"),
    dataRoot,
  );

  assert.equal(outcome.purgedVideos, 2);
  assert.equal(outcome.purgedOccurrences, 3);
  assert.equal(outcome.purgedFiles, 2);
  assert.equal(outcome.requeuedVideos, 2);
  assert.deepEqual(state.processedVideoIds, ["complete001", "metadata-only"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(daysRoot, "2026-08-23.json"))).videos, [completeVideo]);
  assert.equal(fs.existsSync(partRoot), false);
  assert.equal(state.recoveryDates["2026-08-23"].processingStatus, "SKIPPED_INCOMPLETE_SOURCE");
  assert.equal(state.recoveryDates["2026-08-23"].purgedVideos, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("history recovery wall-clock budget checkpoints only after an inspected video", () => {
  assert.equal(recoveryBudgetExpired(1_000, 20_000, 21_000, 0), false);
  assert.equal(recoveryBudgetExpired(1_000, 20_000, 20_999, 1), false);
  assert.equal(recoveryBudgetExpired(1_000, 20_000, 21_000, 1), true);
});

test("history recovery workflow is GitHub-hosted, bounded, resumable, and static-only", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-recover-history.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: 55/);
  assert.match(workflow, /default: "180"/);
  assert.match(workflow, /checkpoint_minutes:/);
  assert.match(workflow, /checkpoint_minutes >= 5 && checkpoint_minutes <= 25/);
  assert.match(workflow, /STATIC_RECOVERY_BUDGET_MS=\$\(\(checkpoint_minutes \* 60000\)\)/);
  assert.match(workflow, /Validate bounded recovery batch/);
  assert.match(workflow, /limit >= 1 && limit <= 200/);
  assert.match(workflow, /npm run static:recover/);
  assert.match(workflow, /Resume an incomplete date checkpoint/);
  assert.match(workflow, /through_date:/);
  assert.match(workflow, /Advance to the next pinned date/);
  assert.match(workflow, /fromJSON\(steps\.outcome\.outputs\.remaining\) == 0/);
  assert.match(workflow, /date -u -d "\$current \+ 1 day" \+%F/);
  assert.match(workflow, /DAILY_SONG_REQUEST_DELAY_MS: "2500"/);
  assert.match(workflow, /DAILY_SONG_429_COOLDOWN_MS: "60000"/);
  assert.match(workflow, /git add -- data\/static\/v1/);
  assert.match(workflow, /git fetch --depth=2 origin main/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /STATIC_RECOVERY_REBASE_UNEXPECTED_PATH/);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh /i);
});

test("a zero-song inspection stays retryable and never silently disappears", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-no-song-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(dataRoot, { recursive: true });
  const candidate = { videoId: "aClwk1yFZao", title: "karaoke", snapshotCapturedAt: "2026-10-02T00:00:00.000Z" };
  const emptyRun = [{
    candidate,
    result: { detail: { songs: [] }, audit: { result: "no_usable_song_source" } },
  }];

  const state = initialState(new Date("2026-10-04T00:00:00.000Z"));
  persistCompleted(state, emptyRun, new Date("2026-10-04T00:00:00.000Z"), dataRoot);
  assert.equal(state.processedVideoIds.includes(candidate.videoId), false, "a zero-song pass must stay re-discoverable");
  assert.equal(state.noSongAttempts[candidate.videoId].attempts, 1);

  persistCompleted(state, emptyRun, new Date("2026-10-04T01:00:00.000Z"), dataRoot);
  persistCompleted(state, emptyRun, new Date("2026-10-04T02:00:00.000Z"), dataRoot);
  assert.equal(state.processedVideoIds.includes(candidate.videoId), true, "the retry budget must still terminate");
  assert.equal(state.noSongAttempts[candidate.videoId].attempts, 3);

  const recovered = initialState(new Date("2026-10-04T03:00:00.000Z"));
  persistCompleted(recovered, [{
    candidate,
    result: {
      detail: {
        videoId: candidate.videoId,
        title: "karaoke",
        publishedTimestamp: "2026-10-02T10:00:00.000Z",
        songs: [{ title: "Candy Candy", seconds: 12, index: 0 }],
      },
    },
  }], new Date("2026-10-04T03:00:00.000Z"), dataRoot);
  const shard = JSON.parse(fs.readFileSync(path.join(dataRoot, "days", "2026-10-02.json"), "utf8"));
  assert.equal(shard.videos[0].videoId, candidate.videoId);
  assert.equal(shard.videos[0].songs[0].title, "Candy Candy");
  assert.equal(recovered.noSongAttempts[candidate.videoId], undefined, "a repaired video must clear its retry record");
});

test("modern attributed description content is read as the stream set list", () => {
  // YouTube now serves long-stream descriptions as one plain `content` string under
  // attributedDescription, not as simpleText/runs. Missing that field meant the whole
  // set list was invisible: zero candidates, then a silent drop as if no song existed.
  const { extractDescriptionCandidates } = require("../scripts/update-songlist.js");
  const { parseTimestampSongs } = require("../scripts/song-utils.js");

  const setList = [
    "04:51      01.  レディーレ (Redire) // バルーン (Balloon)",
    "26:02      04.  CANDY CANDY // きゃりーぱみゅぱみゅ (Kyary Pamyu Pamyu)",
    "32:23      05.  長く短い祭 (Nagaku Mijikai Matsuri) // 椎名林檎 (Ringo Sheena)",
  ].join("\n");

  const data = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: { title: { runs: [{ text: "歌枠" }] } } },
              { videoSecondaryInfoRenderer: { attributedDescription: { content: setList } } },
            ],
          },
        },
      },
    },
  };

  const candidates = extractDescriptionCandidates(data);
  assert.equal(candidates.length, 1, "the attributed description must be read as one candidate");
  const songs = parseTimestampSongs([{ videoId: "aClwk1yFZao", sourceType: "description", text: candidates[0], index: 0 }]);
  assert.deepEqual(
    songs.map((song) => song.title),
    ["レディーレ", "CANDY CANDY", "長く短い祭"],
    "the full set list must be recovered, including CANDY CANDY",
  );
  assert.deepEqual(
    songs.map((song) => song.time),
    ["0:04:51", "0:26:02", "0:32:23"],
  );
});

test("repair audit reports processed videos that never reached a day shard", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-repair-audit-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-02.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-02",
    videos: [{ videoId: "keptVideo01", title: "kept", channelName: "channel", publishedAt: "2026-10-02T10:00:00.000Z", songs: [{ occurrenceId: "keptVideo01:1:0", time: "00:01", seconds: 1, title: "Song", artist: "", raw: "Song", sourceId: "", sourceHash: "" }] }],
  }));
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["keptVideo01", "droppedVideo1", "droppedVideo2", "spentVideo03"],
    queue: [],
    noSongAttempts: { spentVideo03: { attempts: 3, lastAttemptAt: "2026-10-03T00:00:00.000Z", lastResult: "no_usable_song_source" } },
    noSongAttemptsSchema: 2,
  }));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "10", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "dropped-videos.json"), "utf8"));
  assert.equal(ledger.publishedVideoCount, 1);
  assert.equal(ledger.unpublishedVideoCount, 3);
  assert.equal(ledger.droppedVideoCount, 2, "a video that spent its retry budget is no longer repairable");
  assert.equal(ledger.abandonedVideoCount, 1);
  assert.deepEqual(ledger.dropped.map((item) => item.videoId), ["droppedVideo1", "droppedVideo2", "spentVideo03"]);
  assert.deepEqual(ledger.dropped.filter((item) => item.repairable).map((item) => item.videoId), ["droppedVideo1", "droppedVideo2"]);

  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.videoId), ["droppedVideo1", "droppedVideo2"]);
  for (const entry of state.queue) assert.equal(entry.sourceGroup, REPAIR_SOURCE_GROUP);
  assert.equal(state.queue.some((item) => item.videoId === "keptVideo01"), false, "published videos must never be re-queued");
  assert.equal(ledger.unreadableShardCount, 0);
  assert.deepEqual(ledger.unreadableShards, []);
});

test("repair audit survives a malformed day shard instead of aborting", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-repair-unreadable-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days", "2026-08-14"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-02.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-02",
    videos: [{ videoId: "keptVideo01", title: "kept", channelName: "channel", publishedAt: "2026-10-02T10:00:00.000Z", songs: [] }],
  }));
  // Truncated mid-write: one bad shard must not throw away the whole audit.
  fs.writeFileSync(path.join(dataRoot, "days", "2026-08-14", "part-0001.json"), '{"videos":[{"videoId"');
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["keptVideo01", "droppedVideo1"],
    queue: [],
  }));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "5", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "dropped-videos.json"), "utf8"));
  assert.equal(ledger.publishedVideoCount, 1, "readable shards are still indexed");
  assert.equal(ledger.unreadableShardCount, 1);
  assert.match(ledger.unreadableShards[0].file, /days\/2026-08-14\/part-0001\.json/u);
  assert.equal(ledger.droppedVideoCount, 1, "the audit keeps working while a shard is unreadable");

  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.videoId), ["droppedVideo1"]);
});

test("stale no-song retry counters are invalidated when the parser changes", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-repair-schema-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-02.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-02",
    videos: [{ videoId: "keptVideo01", title: "kept", channelName: "channel", publishedAt: "2026-10-02T10:00:00.000Z", songs: [] }],
  }));
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["keptVideo01", "droppedVideo1", "spentVideo03"],
    queue: [],
    // Produced by the pre-description parser: every one of these verdicts is suspect.
    noSongAttempts: {
      droppedVideo1: { attempts: 3, lastAttemptAt: "2026-10-03T00:00:00.000Z", lastResult: "no_timestamp_candidates" },
      spentVideo03: { attempts: 3, lastAttemptAt: "2026-10-03T00:00:00.000Z", lastResult: "no_timestamp_candidates" },
    },
  }));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "10", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "dropped-videos.json"), "utf8"));
  assert.equal(ledger.droppedVideoCount, 2, "every dropped video becomes repairable again");
  assert.equal(ledger.abandonedVideoCount, 0, "no video stays terminal on a stale parser verdict");
  assert.deepEqual(ledger.dropped.map((item) => item.attempts), [0, 0]);

  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.equal(state.noSongAttemptsSchema, 2);
  assert.deepEqual(state.noSongAttempts, {});
  assert.deepEqual(state.queue.map((item) => item.videoId), ["droppedVideo1", "spentVideo03"]);
});

test("reported video is seeded ahead of the id-sorted backlog", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-repair-priority-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "recovery"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-02.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-02",
    videos: [],
  }));
  // Sorted order puts the reported id last; the priority list must win.
  // The reported id is already queued, but behind a long backlog: priority must hoist it.
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["AAAAAAAAAAA", "BBBBBBBBBBB", "aClwk1yFZao"],
    queue: [
      { videoId: "AAAAAAAAAAA", sourceGroup: "mygit_today_snapshot" },
      { videoId: "BBBBBBBBBBB", sourceGroup: "mygit_today_snapshot" },
    ],
    noSongAttempts: {},
    noSongAttemptsSchema: 2,
  }));
  fs.writeFileSync(path.join(dataRoot, "recovery", "priority-ids.json"), JSON.stringify(["aClwk1yFZao"]));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "1", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.deepEqual(
    state.queue.map((item) => item.videoId),
    ["aClwk1yFZao", "AAAAAAAAAAA", "BBBBBBBBBBB"],
    "an already-queued reported video is hoisted ahead of the backlog",
  );
  const priority = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "priority-ids.json"), "utf8"));
  assert.deepEqual(priority, ["aClwk1yFZao"], "an unqueued priority id is retained until it is handled");
});

test("reported video is never retired by a throttled watch page", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-repair-cap-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "recovery"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-02.json"), JSON.stringify({ schemaVersion: 1, day: "2026-10-02", videos: [] }));
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["aClwk1yFZao", "spentVideo03"],
    queue: [],
    noSongAttempts: {
      aClwk1yFZao: { attempts: 3, lastAttemptAt: "2026-10-03T20:21:42.952Z", lastResult: "no_usable_song_source" },
      spentVideo03: { attempts: 3, lastAttemptAt: "2026-10-03T20:21:42.952Z", lastResult: "no_timestamp_candidates" },
    },
    noSongAttemptsSchema: 2,
  }));
  fs.writeFileSync(path.join(dataRoot, "recovery", "priority-ids.json"), JSON.stringify(["aClwk1yFZao"]));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "5", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "dropped-videos.json"), "utf8"));
  assert.equal(ledger.unpublishedVideoCount, 2);
  assert.equal(ledger.droppedVideoCount, 1, "the reported id still counts as repairable at attempt 3");
  assert.equal(ledger.abandonedVideoCount, 1, "only the unreported video is terminal");

  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.videoId), ["aClwk1yFZao", "spentVideo03"].filter((id) => id !== "spentVideo03"));
  assert.equal(state.queue.some((item) => item.videoId === "aClwk1yFZao"), true, "it is re-queued despite the spent counter");
  assert.equal(state.queue.some((item) => item.videoId === "spentVideo03"), false, "ordinary exhausted videos stay retired");
});

test("OP and ED markers do not make a clean set list high risk", () => {
  // aClwk1yFZao's description yields 17 real songs plus OP / ご挨拶 / ED. The parser already
  // rejects those three as obvious_non_song_text, but sourceStats counted them again as topic
  // and activity markers, pushing riskScore to 100 and discarding the whole source.
  const { buildSongSource } = require("../scripts/update-songlist.js");
  const { createSourceRecord } = require("../scripts/curation.js");
  const { parseTimestampSongs } = require("../scripts/song-utils.js");

  const setList = [
    "✧ Set List / タイムスタンプ",
    "00:00      OP",
    "00:57      ご挨拶",
    "04:51      01.  レディーレ (Redire) // バルーン (Balloon)",
    "11:23      02.  絶頂讃歌 (Orgasm Anthem) // 和ぬか (Wanuka)",
    "15:32      03.  ミュージック (Music) // サカナクション (sakanaction)",
    "26:02      04.  CANDY CANDY // きゃりーぱみゅぱみゅ (Kyary Pamyu Pamyu)",
    "32:23      05.  長く短い祭 (Nagaku Mijikai Matsuri) // 椎名林檎 (Ringo Sheena)",
    "38:54      06.  脱法ロック (Law-evading Rock) // Neru",
    "45:03      07.  トリカゴ (Torikago) // XX:me",
    "51:53      08.  ジェヘナ (Gehenna) // wotaku",
    "1:03:57   09.  ナイトルーティーン (Night Routine) // キタニタツヤ (Tatsuya Kitani)",
    "1:09:24   10.  フライディ・チャイナタウン (Fly-day Chinatown) // 泰葉 (Yasuha)",
    "1:14:36   11.  ダーリンダンス (Darling Dance) // かいりきベア (Kairiki Bear)",
    "1:21:57   12.  妄想疾患■ガール (Mousou Shikkan Yami Girl) // 大柴広己、れるりり (Hiroki Oshiba, Rerulili)",
    "1:26:24   13.  シュガーバイン (Sugarvine) // Dixie Flatline",
    "1:34:40   14.  カガリビト (Kagaribito) // millstones",
    "1:39:50   15.  ライアーダンス (Liar Dance) // DECO*27",
    "1:45:06   16.  ヒバナ (Hibana) // DECO*27",
    "1:53:31   17.  太陽系デスコ (Solar System Disco) // ナユタン星人 (NayutalieN)",
    "2:00:52   ED",
  ].join("\n");

  const videoId = "aClwk1yFZao";
  const record = createSourceRecord({ videoId, sourceType: "description", text: setList, index: 0 });
  const rejectedEntries = [];
  const songs = parseTimestampSongs([{ ...record, text: setList, videoId }], {
    onReject: (entry) => rejectedEntries.push(entry),
  });
  assert.equal(songs.length, 17, "the 17 real songs parse");
  assert.equal(rejectedEntries.filter((entry) => entry.reason === "obvious_non_song_text").length, 3, "OP, ご挨拶 and ED are rejected by the parser");
  assert.ok(rejectedEntries.some((entry) => entry.tail === "OP"), "OP is rejected by the parser");
  assert.ok(rejectedEntries.some((entry) => entry.tail === "ED"), "ED is rejected by the parser");

  const source = buildSongSource(songs, rejectedEntries, record, {
    videoId,
    title: "【 歌枠 / karaoke 】",
    channelName: "Figaro",
    keywords: [],
    sourceGroups: ["static_repair"],
  });

  assert.equal(source.stats.originalCount, 20, "the raw row count still includes OP/ED");
  assert.equal(source.stats.topicCount, 0, "parser-rejected markers are not counted as topics");
  assert.equal(source.stats.activityMarkerCount, 0, "parser-rejected markers are not activity markers");
  assert.equal(source.riskLevel !== "high", true, "a clean set list must not be scored high risk");
  assert.equal(source.rejected, false, "the source must survive source-level rejection");
  assert.equal(source.songs.length, 17);
  assert.ok(source.songs.some((song) => song.title === "CANDY CANDY"));
});

test("watch metadata survives object-shaped microformat fields", () => {
  // YouTube now serves microformat.title as { simpleText }, and String() on it used to publish
  // the literal title "[object Object]". The watch-next fallback covers a throttled player page.
  const { extractWatchVideoMetadata } = require("../scripts/update-songlist.js");
  const player = JSON.stringify({
    videoDetails: { title: "", author: "", channelId: "" },
    microformat: {
      playerMicroformatRenderer: {
        title: { simpleText: "【 歌枠 】karaoke" },
        ownerChannelName: "Figaro",
        externalChannelId: "UC123",
        publishDate: "2026-10-02T04:05:40-07:00",
        ownerProfileUrl: "https://www.youtube.com/@Figaro_qpt",
      },
    },
  });
  const html = `var ytInitialPlayerResponse = ${player};`;
  const meta = extractWatchVideoMetadata(html);
  assert.equal(meta.title, "【 歌枠 】karaoke", "simpleText must be unwrapped");
  assert.equal(meta.channelName, "Figaro");
  assert.equal(meta.channelId, "UC123");
  assert.equal(new Date(meta.publishedTimestamp).toISOString(), "2026-10-02T11:05:40.000Z");
  assert.notEqual(meta.title, "[object Object]");
});

test("watch metadata falls back to watch-next data when the player page is absent", () => {
  const { extractWatchVideoMetadata } = require("../scripts/update-songlist.js");
  const html = `var ytInitialData = ${JSON.stringify({
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              {
                videoPrimaryInfoRenderer: {
                  title: { runs: [{ text: "Recovered title" }] },
                  dateText: { simpleText: "2026/10/02 にライブ配信" },
                },
              },
              {
                videoSecondaryInfoRenderer: {
                  owner: {
                    videoOwnerRenderer: {
                      title: { runs: [{ text: "Recovered channel" }] },
                      navigationEndpoint: { browseEndpoint: { browseId: "UC456", canonicalBaseUrl: "/@recovered" } },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  })};`;
  const meta = extractWatchVideoMetadata(html);
  assert.equal(meta.title, "Recovered title");
  assert.equal(meta.channelName, "Recovered channel");
  assert.equal(meta.channelId, "UC456");
  assert.equal(meta.publishedTimestamp, Date.parse("2026-10-02T00:00:00.000Z"));
});

test("re-inspecting a repair candidate moves it off the stale day shard", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-relocate-"));
  const daysRoot = path.join(dataRoot, "days");
  fs.mkdirSync(daysRoot, { recursive: true });
  const stale = {
    schemaVersion: 1,
    day: "2026-10-03",
    videos: [{ videoId: "aClwk1yFZao", title: "", channelName: "", publishedAt: "2026-10-03T20:32:14.315Z", songs: [] }],
  };
  fs.writeFileSync(path.join(daysRoot, "2026-10-03.json"), JSON.stringify(stale));

  const state = { processedVideoIds: ["aClwk1yFZao"], queue: [], noSongAttempts: {}, noSongAttemptsSchema: 2 };
  persistCompleted(state, [{
    candidate: { videoId: "aClwk1yFZao", snapshotId: "repair-20261003T210045Z", snapshotCapturedAt: "2026-10-03T20:32:14.315Z", keywords: [] },
    result: {
      detail: {
        videoId: "aClwk1yFZao",
        title: "Recovered title",
        channelName: "Figaro",
        publishedTimestamp: Date.parse("2026-10-02T04:05:40-07:00"),
        keywords: [],
        songs: [{ seconds: 1562, title: "CANDY CANDY", artist: "きゃりーぱみゅぱみゅ", raw: "26:02 CANDY CANDY" }],
      },
    },
  }], new Date("2026-10-04T00:00:00.000Z"), dataRoot);

  const moved = JSON.parse(fs.readFileSync(path.join(daysRoot, "2026-10-02.json"), "utf8"));
  assert.equal(moved.videos.length, 1);
  assert.equal(moved.videos[0].title, "Recovered title");
  assert.equal(moved.videos[0].publishedAt, "2026-10-02T11:05:40.000Z");
  const old = JSON.parse(fs.readFileSync(path.join(daysRoot, "2026-10-03.json"), "utf8"));
  assert.equal(old.videos.length, 0, "the stale copy must be removed so songs are not counted twice");
});

test("same-day repair source receipt does not rewrite raw day bytes", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-raw-repair-"));
  const daysRoot = path.join(dataRoot, "days");
  fs.mkdirSync(daysRoot, { recursive: true });
  const state = { processedVideoIds: [], queue: [], noSongAttempts: {}, noSongAttemptsSchema: 2 };
  const detail = {
    videoId: "sameDay0001",
    title: "Stable title",
    channelName: "Stable channel",
    channelId: "UCstable",
    publishedTimestamp: Date.parse("2026-10-01T00:00:00Z"),
    keywords: ["歌枠"],
    songs: [{ seconds: 10, title: "Stable song", artist: "Artist", raw: "00:10 Stable song / Artist" }],
  };
  const firstCandidate = { videoId: detail.videoId, snapshotId: "repair-old", snapshotCapturedAt: "2026-10-01T01:00:00Z", keywords: [] };
  persistCompleted(state, [{ candidate: firstCandidate, result: { detail } }], new Date("2026-10-06T00:00:00Z"), dataRoot);
  const dayPath = path.join(daysRoot, "2026-10-01.json");
  const before = fs.readFileSync(dayPath, "utf8");
  const secondCandidate = { ...firstCandidate, snapshotId: "repair-new", snapshotCapturedAt: "2026-10-06T01:00:00Z" };
  persistCompleted(state, [{ candidate: secondCandidate, result: { detail } }], new Date("2026-10-06T02:00:00Z"), dataRoot);
  assert.equal(fs.readFileSync(dayPath, "utf8"), before);
});

test("published records without title or channel are re-queued for metadata repair", () => {
  const requireChild = createRequire(import.meta.url);
  const { execFileSync } = requireChild("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-meta-repair-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "days", "2026-10-03.json"), JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-03",
    videos: [
      { videoId: "aClwk1yFZao", title: "", channelName: "", publishedAt: "2026-10-03T20:32:14.315Z", songs: [] },
      { videoId: "HealthyVideo", title: "ok", channelName: "ch", publishedAt: "2026-10-03T10:00:00.000Z", songs: [] },
    ],
  }));
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify({
    schemaVersion: 1,
    processedVideoIds: ["aClwk1yFZao", "HealthyVideo"],
    queue: [],
    noSongAttempts: {},
    noSongAttemptsSchema: 2,
  }));

  execFileSync(process.execPath, ["scripts/static/repair-dropped.js"], {
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_REPAIR_SEED_LIMIT: "5", STATIC_NOW: "2026-10-04T00:00:00.000Z" },
    stdio: "pipe",
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(dataRoot, "recovery", "dropped-videos.json"), "utf8"));
  assert.equal(ledger.metadataIncompleteVideoCount, 1);
  assert.deepEqual(ledger.metadataIncompleteVideoIds, ["aClwk1yFZao"]);
  const state = JSON.parse(fs.readFileSync(path.join(dataRoot, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.videoId), ["aClwk1yFZao"], "metadata repair is seeded ahead of the backlog");
});

test("repair mode drains the historical backlog before fresh arrivals", () => {
  const requireFresh = createRequire(import.meta.url);
  const modulePath = requireFresh.resolve("../scripts/static/collect-and-build.js");
  const previous = process.env.STATIC_REPAIR_MODE;
  process.env.STATIC_REPAIR_MODE = "1";
  delete requireFresh.cache[modulePath];
  try {
    const repairBuild = requireFresh(modulePath);
    const now = new Date().toISOString();
    const repair = { videoId: "repairVideo1", sourceGroup: repairBuild.REPAIR_SOURCE_GROUP, snapshotCapturedAt: now };
    const fresh = { videoId: "freshVideo01", sourceGroup: "mygit_today_snapshot", publishedTimestamp: now };
    const chosen = repairBuild.selectInspectionBatch([fresh, repair], 1);
    assert.deepEqual(chosen.map((item) => item.videoId), [repair.videoId]);
  } finally {
    if (previous === undefined) delete process.env.STATIC_REPAIR_MODE;
    else process.env.STATIC_REPAIR_MODE = previous;
    delete requireFresh.cache[modulePath];
  }
});

test("dropped-video repair workflow is GitHub-hosted, bounded, resumable, and static-only", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-repair-dropped.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /timeout-minutes: 55/);
  assert.match(workflow, /default: "60"/);
  assert.match(workflow, /STATIC_REPAIR_SEED_LIMIT_CAPPED requested=\$seed_limit effective=120/);
  assert.match(workflow, /STATIC_REPAIR_PASS_FAILED pass=\$pass/);
  assert.match(workflow, /DAILY_SONG_429_COOLDOWN_MS: "180000"/);
  assert.match(workflow, /STATIC_REPAIR_THROTTLED status=\$REPAIR_STATUS/);
  assert.match(workflow, /sleep 300/);
  assert.match(workflow, /\n        if: always\(\)\n/);
  assert.match(workflow, /STATIC_REPAIR_MODE: "1"/);
  // A failing pass must stay diagnosable from main: the transcript is committed with the data.
  assert.match(workflow, /repair-last-run\.txt/);
  assert.match(workflow, /run_passes > "\$log_file" 2>&1/);
  assert.match(workflow, /cat "\$log_file"/);
  assert.match(workflow, /STATIC_REPAIR_REAUDIT_FAILED/);
  assert.match(workflow, /Evidence must never be the reason a diagnosis fails/);
  assert.match(workflow, /node scripts\/static\/repair-dropped\.js/);
  assert.match(workflow, /npm run static:update/);
  assert.match(workflow, /npm run static:validate/);
  assert.match(workflow, /git add -- data\/static\/v1/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /STATIC_REPAIR_REBASE_UNEXPECTED_PATH/);
  assert.match(workflow, /gh workflow run deploy-pages\.yml --ref main/);
  assert.match(workflow, /gh workflow run static-repair-dropped\.yml --ref main/);
  assert.match(workflow, /pending_static="\$\(gh run list/u);
  assert.match(workflow, /STATIC_REPAIR_YIELD_STATIC pending=\$pending_static/u);
  assert.match(workflow, /group: daily-song-list-static-update/);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh /i);
});
test("manual exact curation removes only configured non-song rows from static output", () => {
  const overrides = JSON.parse(fs.readFileSync(path.resolve("config/curation-overrides.json"), "utf8"));
  const records = overrides.records.filter((record) => record.reason === "manual_confirmed_non_song_activity_chapter");
  assert.equal(records.length, 20, "the manual cleanup batch must remain explicit and auditable");
  const record = records.find((item) => item.videoId === "-hN9tB_1l3s");
  assert.ok(record, "the cleanup fixture must reference a reviewed record");
  const dirtyTitle = record.note.match(/"(.+?)"/u)?.[1];
  assert.ok(dirtyTitle, "the reviewed record must name the dirty title");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-manual-curation-"));
  const dataRoot = path.join(root, "data/static/v1");
  fs.mkdirSync(path.join(dataRoot, "days"), { recursive: true });
  const now = new Date("2026-10-04T01:00:00.000Z");
  const state = initialState(now);
  state.queue = [];
  state.processedVideoIds = [record.videoId];
  fs.writeFileSync(path.join(dataRoot, "state.json"), JSON.stringify(state));
  const dayPath = path.join(dataRoot, "days/2026-10-04.json");
  const rawBefore = JSON.stringify({
    schemaVersion: 1,
    day: "2026-10-04",
    videos: [{
      videoId: record.videoId,
      title: "Manual cleanup fixture",
      channelName: "Fixture Channel",
      channelId: "UCfixture",
      publishedAt: "2026-10-04T00:00:00.000Z",
      thumbnailUrl: "https://example.invalid/fixture.jpg",
      watchUrl: `https://youtube.com/watch?v=${record.videoId}`,
      keyword: "歌枠",
      keywords: ["歌枠"],
      songs: [
        {
          occurrenceId: record.occurrenceId,
          time: "1:16:57",
          seconds: record.seconds,
          title: dirtyTitle,
          artist: "Reviewed Activity",
          raw: `1:16:57 ${dirtyTitle} / Reviewed Activity`,
          sourceId: record.sourceId,
          sourceHash: record.sourceHash,
          rawHash: record.rawHash,
        },
        {
          occurrenceId: "manual-sentinel",
          time: "1:16:58",
          seconds: record.seconds + 1,
          title: "Lemon",
          artist: "米津玄師",
          raw: "1:16:58 Lemon / 米津玄師",
          sourceId: record.sourceId,
          sourceHash: record.sourceHash,
          rawHash: "manual-cleanup-sentinel",
        },
      ],
    }],
  });
  fs.writeFileSync(dayPath, rawBefore);

  const meta = buildStaticSite(dataRoot, state, now, { pageSize: 1, maxShardBytes: 100000 });
  assert.equal(meta.videoCount, 1);
  assert.equal(meta.songOccurrenceCount, 1);
  assert.equal(fs.readFileSync(dayPath, "utf8"), rawBefore, "raw day shards must remain untouched");
  const manifest = JSON.parse(fs.readFileSync(path.join(dataRoot, "search/manifest.json"), "utf8"));
  const searchItems = manifest.shards.flatMap((shard) => JSON.parse(fs.readFileSync(path.join(dataRoot, shard.path), "utf8")).items);
  assert.ok(searchItems.some((item) => item.name === "Lemon"), "a real song must remain searchable");
  assert.ok(!searchItems.some((item) => item.name === dirtyTitle), "the reviewed non-song must be absent from search");
  fs.rmSync(root, { recursive: true, force: true });
});

test("static frontend exposes collected channels as an included search scope", () => {
  const html = fs.readFileSync(path.resolve("index.html"), "utf8");
  const app = fs.readFileSync(path.resolve("assets/static-app.js"), "utf8");
  const css = fs.readFileSync(path.resolve("assets/static.css"), "utf8");
  assert.match(html, /<option value="vtubers">收录<\/option>/u);
  assert.match(html, /placeholder="搜索歌曲、歌手、收录"/u);
  assert.match(app, /function searchLabel\(value\)\{return value === "vtubers" \? "收录" : label\(value\)\}/u);
  assert.match(app, /COLLECTED_VTUBER_IDS = new Set\(\["7163e7a35bf251f9"\]\)/u);
  assert.match(app, /COLLECTED_VTUBER_IDS\.has\(item\.id\)/u);
  assert.doesNotMatch(app, /el\.type\.value === "vtubers" \? '<span class="collection-badge">已收录<\/span>' : ""/u);
  assert.match(css, /\.collection-badge\s*\{/u);
  assert.match(app, /closeDetailOnOutsideClick/u);
  assert.match(app, /state\.detailTrigger/u);
  assert.match(app, /document\.addEventListener\("click", closeDetailOnOutsideClick\)/u);
  assert.match(app, /detail\(item\)\.catch\(/u);
  assert.match(css, /html\[data-theme="dark"\] option\s*\{/u);
  assert.match(css, /color-scheme:dark/u);
  assert.match(app, /KNOWN_CHANNEL_STREAM_URLS = new Map\(\[\["7163e7a35bf251f9", "https:\/\/www\.youtube\.com\/@v-rara\/streams"\]\]\)/u);
  assert.match(app, /groupOccurrencesByVideo/u);
  assert.match(app, /class="occurrence-group"/u);
  assert.match(app, /class="occurrence-songs"/u);
  assert.match(app, /channelStreamsUrl/u);
  assert.match(css, /\.occurrence-group\s*\{/u);
  assert.match(css, /\.occurrence-songs\s*\{/u);
  assert.match(css, /\.channel-name-link\s*\{/u);
});

test("channel setlist export accounts for every inspected candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-setlists-"));
  try {
    const candidateA = {
      videoId: "AAAAAAAAAAA",
      title: "歌枠 full archive",
      matchedKeywords: ["歌"],
      discoverySourceUrls: ["https://www.youtube.com/@RaraTakanashi/streams"],
    };
    const candidateB = {
      videoId: "BBBBBBBBBBB",
      title: "talk archive",
      matchedKeywords: ["live"],
      discoverySourceUrls: ["https://www.youtube.com/@RaraTakanashi/streams"],
    };
    const rawVideos = [candidateA, candidateB];
    const manifest = {
      kind: "youtube-channel-discovery",
      candidateOnly: false,
      complete: true,
      partial: false,
      maxInspect: 100000,
      candidateCount: 2,
      inspectedInLatestRun: 2,
      usableVideoCount: 1,
      occurrenceCount: 2,
      generatedAt: "2026-10-06T00:00:00.000Z",
      channelId: "UCLIEOGtrywxsLztMPPKtfkA",
      channelHandle: "@RaraTakanashi",
      channelName: "Rara Channel",
      channelUrl: "https://www.youtube.com/@RaraTakanashi/streams",
      keywords: ["歌", "live"],
      pageSummaries: [{ pageCount: 17, reachedEnd: true }],
    };
    const details = [{
      videoId: candidateA.videoId,
      title: "歌枠 full archive",
      channelName: "Rara Channel",
      channelId: manifest.channelId,
      channelHandle: manifest.channelHandle,
      channelUrl: manifest.channelUrl,
      publishedTimestamp: 1791230400,
      matchedKeywords: candidateA.matchedKeywords,
      songs: [
        { time: "0:01:02", seconds: 62, title: "Song A", artist: "Artist A", raw: "0:01:02 Song A / Artist A" },
        { time: "0:02:03", seconds: 123, title: "Song B", artist: "Artist B", raw: "0:02:03 Song B / Artist B" },
      ],
    }];
    const audits = [
      { videoId: candidateA.videoId, result: "selected", selectedSongCount: 2, acceptedSourceCount: 1 },
      { videoId: candidateB.videoId, result: "no_timestamp_candidates", selectedSongCount: 0, acceptedSourceCount: 0 },
    ];
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, "raw-videos.json"), JSON.stringify(rawVideos));
    fs.writeFileSync(path.join(root, "video-details.json"), JSON.stringify(details));
    fs.writeFileSync(path.join(root, "audits.json"), JSON.stringify(audits));
    fs.writeFileSync(path.join(root, "checkpoint.json"), JSON.stringify({
      schemaVersion: 1,
      completedVideoIds: rawVideos.map((video) => video.videoId),
      details,
      audits,
    }));

    const payload = buildChannelSetlists({
      inputDir: root,
      runId: "12345",
      sourceCommit: "a".repeat(40),
      expectedId: manifest.channelId,
      expectedHandle: manifest.channelHandle,
      expectedUrl: manifest.channelUrl,
      now: new Date("2026-10-06T00:00:00.000Z"),
    });
    assert.equal(payload.summary.candidateCount, 2);
    assert.equal(payload.summary.inspectedCount, 2);
    assert.equal(payload.summary.setlistVideoCount, 1);
    assert.equal(payload.summary.occurrenceCount, 2);
    assert.equal(payload.summary.noSongCount, 1);
    assert.equal(payload.summary.failedCount, 0);
    assert.equal(payload.summary.allCandidatesAccounted, true);
    assert.equal(payload.channel.handle, "@RaraTakanashi");
    assert.equal(payload.videos[0].channelUrl, "https://www.youtube.com/@RaraTakanashi/streams");
    assert.deepEqual(payload.videos[0].songs.map((song) => song.title), ["Song A", "Song B"]);
    assert.deepEqual(payload.audits.map((audit) => audit.videoId), ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    assert.deepEqual(payload.audits.map((audit) => audit.title), ["歌枠 full archive", "talk archive"]);

    fs.writeFileSync(path.join(root, "audits.json"), JSON.stringify(audits.slice(0, 1)));
    fs.writeFileSync(path.join(root, "checkpoint.json"), JSON.stringify({
      schemaVersion: 1,
      completedVideoIds: rawVideos.map((video) => video.videoId),
      details,
      audits: audits.slice(0, 1),
    }));
    assert.throws(
      () => buildChannelSetlists({
        inputDir: root,
        runId: "12345",
        sourceCommit: "a".repeat(40),
        expectedId: manifest.channelId,
        expectedHandle: manifest.channelHandle,
        expectedUrl: manifest.channelUrl,
      }),
      /audit coverage does not include every candidate/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("channel discovery resumes its checkpoint before another bounded inspection pass", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/discover-vtuber-streams.yml"), "utf8");
  assert.match(workflow, /actions: read/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /timeout-minutes: 360/u);
  assert.match(workflow, /DISCOVERY_TIMEOUT_SECONDS: "18000"/u);
  assert.match(workflow, /VTUBER_RESUME_OK artifactId=/u);
  assert.match(workflow, /ltrimstr\(\$prefix\)/u);
  assert.match(workflow, /output\/checkpoint\.json/u);
  assert.match(workflow, /checkpoint\.completedVideoIds/u);
  // The import path is outside sparse checkout, so staging must use --sparse.
  assert.match(workflow, /git add --sparse -- "\$import_path"/u);
  assert.doesNotMatch(workflow, /git add -- "data\/static\/v1\/days/u);
});

test("verified channel setlist imports enter generated shards and clear audited candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-channel-setlist-import-"));
  try {
    const dataRoot = path.join(root, "data/static/v1");
    const importsRoot = path.join(dataRoot, "imports");
    fs.mkdirSync(importsRoot, { recursive: true });
    const now = new Date("2026-10-06T12:00:00.000Z");
    const importedVideo = {
      videoId: "AAAAAAAAAAA",
      title: "歌枠 full archive",
      channelName: "Rara Channel / 小鳥遊らら",
      channelId: "UCLIEOGtrywxsLztMPPKtfkA",
      channelHandle: "@RaraTakanashi",
      channelUrl: "https://www.youtube.com/@RaraTakanashi/streams",
      publishedAt: "2026-10-05T12:00:00.000Z",
      thumbnailUrl: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg",
      matchedKeywords: ["歌", "live"],
      songs: [
        { index: 1, time: "0:01:02", seconds: 62, title: "Song A", artist: "Artist A", raw: "0:01:02 Song A / Artist A", sourceId: "description", sourceHash: "a".repeat(64) },
        { index: 2, time: "0:02:03", seconds: 123, title: "Song B", artist: "Artist B", raw: "0:02:03 Song B / Artist B", sourceId: "description", sourceHash: "a".repeat(64) },
      ],
    };
    const payload = {
      schemaVersion: 1,
      kind: "channel-setlists",
      generatedAt: now.toISOString(),
      source: { runId: "37398206556", sourceCommit: "a".repeat(40) },
      summary: {
        candidateCount: 2,
        inspectedCount: 2,
        inspectedInLatestRun: 2,
        setlistVideoCount: 1,
        auditCount: 2,
        occurrenceCount: 2,
        noSongCount: 1,
        failedCount: 0,
        allCandidatesAccounted: true,
      },
      videos: [importedVideo],
      audits: [
        { videoId: "AAAAAAAAAAA", result: "selected", selectedSongCount: 2 },
        { videoId: "BBBBBBBBBBB", result: "no_timestamp_candidates", selectedSongCount: 0 },
      ],
    };
    const importPath = path.join(importsRoot, "rara-takanashi.json");
    fs.writeFileSync(importPath, JSON.stringify(payload));
    fs.writeFileSync(path.join(importsRoot, "inspection-priority-ids.json"), JSON.stringify(["flahkQbUguU"]));

    const state = initialState(now);
    state.processedVideoIds = ["DDDDDDDDDDD"];
    state.queue = [
      { videoId: "AAAAAAAAAAA" },
      { videoId: "BBBBBBBBBBB" },
      { videoId: "CCCCCCCCCCC" },
    ];
    state.noSongAttempts = { AAAAAAAAAAA: 1, BBBBBBBBBBB: 2 };
    const imports = reconcileChannelSetlistImports(state, dataRoot);
    assert.equal(imports.length, 1);
    assert.deepEqual(state.queue.map((item) => item.videoId), ["CCCCCCCCCCC"]);
    assert.deepEqual(state.processedVideoIds, ["AAAAAAAAAAA", "BBBBBBBBBBB", "DDDDDDDDDDD"]);
    assert.deepEqual(state.noSongAttempts, {});
    assert.equal(state.channelSetlistImports[0].candidateCount, 2);

    const meta = buildStaticSite(dataRoot, state, now, { channelSetlistImports: imports, pageSize: 50, maxShardBytes: 4000000 });
    assert.equal(meta.channelSetlistImports[0].candidateCount, 2);
    assert.equal(meta.channelSetlistImports[0].occurrenceCount, 2);
    const source = JSON.parse(fs.readFileSync(path.join(dataRoot, "sources/AA/AAAAAAAAAAA.json"), "utf8"));
    assert.deepEqual(source.songs.map((song) => song.title), ["Song A", "Song B"]);
    const searchFiles = fs.readdirSync(path.join(dataRoot, "search")).filter((name) => name !== "manifest.json");
    const searchItems = searchFiles.flatMap((name) => JSON.parse(fs.readFileSync(path.join(dataRoot, "search", name), "utf8")).items);
    const channelItem = searchItems.find((item) => item.type === "vtubers" && item.occurrenceCount === 2);
    assert.ok(channelItem, "imported setlist occurrences must enter search");

    payload.summary.occurrenceCount = 99;
    fs.writeFileSync(importPath, JSON.stringify(payload));
    assert.throws(() => readChannelSetlistImports(dataRoot), /summary mismatch/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("static update triggers and reports verified channel setlist imports", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/static-update.yml"), "utf8");
  assert.match(workflow, /- "data\/static\/v1\/imports\/\*\*"/u);
  assert.match(workflow, /channelSetlistImports: meta\.channelSetlistImports \|\| \[\]/u);
});

test("manual pending ledger keeps an unresolved VTuber stream ready for queue insertion", () => {
  const ledger = JSON.parse(fs.readFileSync(path.resolve("data/static/v1/recovery/manual-pending.json"), "utf8"));
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.pendingCount, ledger.items.filter((item) => item.status === "pending").length);
  const item = ledger.items.find((entry) => entry.videoId === "-DuL8LWMgg0");
  assert.ok(item, "the missing RARA stream must remain explicitly pending");
  assert.equal(item.status, "pending");
  assert.equal(item.title, "【歌枠】アイドル曲【#ららりうむ】");
  assert.equal(item.queueCandidate.videoId, item.videoId);
  assert.equal(item.queueCandidate.sourceGroup, "manual_vtuber_pending");
  assert.equal(new Set(ledger.items.map((entry) => entry.videoId)).size, ledger.items.length);
});

test("detail dialog layout prevents cover and title overlap", () => {
  const css = fs.readFileSync(path.resolve("assets/static.css"), "utf8");
  assert.match(css, /\.occurrence-video\s*\{[^}]*grid-template-columns:112px minmax\(0,1fr\)/u);
  assert.match(css, /\.occurrence-video \.occurrence-thumb img\s*\{[^}]*width:100%!important/u);
  const narrowDetailCss = css.slice(css.lastIndexOf("@media(max-width:720px){"));
  assert.match(narrowDetailCss, /\.occurrence-video\s*\{[^}]*grid-template-columns:86px minmax\(0,1fr\)/u);
  assert.match(narrowDetailCss, /\.occurrence-songs\s*\{[^}]*padding-left:95px/u);
});
// Detail layout gate is active.

test("standard slash setlist keeps every row through source risk selection", () => {
  const { isLikelyNonSongEntry, parseTimestampSongs } = require("../scripts/song-utils.js");
  const { buildSongSource, selectBestSongs } = require("../scripts/update-songlist.js");
  const rows = [
    "0:14:04 Asphodelus-アスフォデルス-/Ceui/「機翼のユースティア」OP/AUGUST (2011)",
    "0:25:26 Dreaming Sheep/中恵光城/「大図書館の羊飼い -Dreaming Sheep-」OP/AUGUST (2014)",
    "0:35:36 say your prayer/片霧烈火/「しゃーまんず・さんくちゅありー巫女の聖域ー」OP/ALICESOFT (2010)",
    "0:45:52 hurting heart/fripSide/「神曲奏界ポリフォニカ・THE BLACK 1 & 2 BOX EDITION」OP/KuroCo (2007)",
    "0:54:04 原罪のレクイエム/KOTOKO/「プリズム・アーク ～プリズム・ハート エピソード2 ～」OP/ぱじゃまソフト (2006)",
    "1:06:14 FairChild/榊原ゆい/「FairChild」OP/ALcot (2007)",
    "1:18:08 sign/夢乃ゆき/「ソラコイ」OP/チェルシーソフト (2015)",
    "1:27:35 WHITE ALBUM/森川由綺/「WHITE ALBUM」OP/Leaf (1998)",
    "1:36:24 Girls' Carnival/ユカ/「Making×Lovers」OP/SMEE (2017)",
    "1:45:54 モラトリアム・クラスタ/柚子乃/「ギャングスタ・リパブリカ」OP/WHITESOFT (2013)",
    "1:59:51 おやすみモノクローム/倚水/「Dreamin'Her -僕は、彼女の夢を見る。-」OP/LIFE0 (2022)",
  ];
  const sourceText = `Setlist:\n${rows.join("\n")}`;
  const rejected = [];
  const songs = parseTimestampSongs([
    { text: sourceText, videoId: "9TSHn43ttmc", sourceId: "comment:9TSHn43ttmc", sourceHash: "b".repeat(64) },
  ], { onReject: (entry) => rejected.push(entry) });

  assert.equal(rejected.length, 0);
  assert.equal(songs.length, 11);
  assert.deepEqual(
    songs.slice(0, 3).map(({ title, artist }) => [title, artist]),
    [["Asphodelus-アスフォデルス", "Ceui"], ["Dreaming Sheep", "中恵光城"], ["say your prayer", "片霧烈火"]],
  );
  assert.deepEqual([songs[4].title, songs[4].artist], ["原罪のレクイエム", "KOTOKO"]);
  assert.deepEqual([songs[10].title, songs[10].artist], ["おやすみモノクローム", "倚水"]);
  assert.equal(
    isLikelyNonSongEntry({
      title: "Asphodelus-アスフォデルス-/Ceui/「機翼のユースティア」OP",
      artist: "AUGUST (2011)",
      raw: rows[0],
    }),
    false,
    "a release year is metadata, not an English commentary gloss",
  );

  const source = buildSongSource(
    songs,
    [],
    {
      sourceId: "comment:9TSHn43ttmc:setlist",
      sourceHash: "c".repeat(64),
      sourceType: "comment",
      sourceIndex: 0,
      commentId: "9TSHn43ttmc:setlist",
      authorName: "lonelyevil",
      text: sourceText,
    },
    {
      videoId: "9TSHn43ttmc",
      title: "【 歌枠┆KARAOKE 】お久しぶりです！美少女ゲームソング歌枠をします ✧",
      channelName: "Rara Channel",
      channelId: "UCLIEOGtrywxsLztMPPKtfkA",
      channelHandle: "@RaraTakanashi",
      channelUrl: "https://www.youtube.com/@RaraTakanashi",
      keywords: ["歌", "karaoke"],
    },
  );
  assert.equal(source.rejected, false);
  assert.equal(source.summary.rejectedEntryCount, 0);
  assert.equal(source.stats.keptCount, 11);
  assert.equal(source.stats.riskLevel, "low");
  assert.equal(source.stats.hasSetlistKeyword, true);
  assert.equal(selectBestSongs([source]).length, 11);

  const workflow = fs.readFileSync(path.resolve(".github/workflows/discover-vtuber-streams.yml"), "utf8");
  assert.match(workflow, /DAILY_SONG_RETAIN_AUDIT_SOURCE_TEXT: "1"/u);
});
