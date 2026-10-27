import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts/static/heartbeat-dirty-batch.js");
const exporterPath = path.join(repoRoot, "scripts/static/export-static-dirty-review.js");
const rebuildScriptPath = path.join(repoRoot, "scripts/static/rebuild-only.js");
const workflowPath = path.join(repoRoot, ".github/workflows/heartbeat-dirty-data.yml");
const checkCodePath = path.join(repoRoot, ".github/workflows/check-code.yml");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-heartbeat-"));
  writeJson(path.join(root, "data/review/sources/current-clean.json"), {
    video: { videoId: "AAAAAAAAAAA", title: "current" },
    source: { sourceId: "selected:AAAAAAAAAAA:current", sourceHash: "hash-current" },
    entries: [
      {
        seconds: 10,
        rawHash: "raw-confirmed",
        classification: "confirmed_noise",
        suggestedAction: "drop_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 20,
        rawHash: "raw-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: { artist: "Fixed Artist" },
      },
      {
        seconds: 30,
        rawHash: "raw-invalid-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 40,
        rawHash: "raw-song",
        classification: "likely_song",
        suggestedAction: "keep",
        replacementSuggestion: null,
      },
    ],
  });
  writeJson(path.join(root, "data/review/sources/history-clean.json"), {
    video: { videoId: "BBBBBBBBBBB", title: "history" },
    source: { sourceId: "selected:BBBBBBBBBBB:history", sourceHash: "hash-history" },
    entries: [
      {
        seconds: 11,
        rawHash: "raw-history-confirmed",
        classification: "confirmed_noise",
        suggestedAction: "drop_entry",
        replacementSuggestion: null,
      },
      {
        seconds: 21,
        rawHash: "raw-history-parser",
        classification: "parser_corruption",
        suggestedAction: "replace_entry",
        replacementSuggestion: { title: "Fixed Title" },
      },
    ],
  });
  writeJson(path.join(root, "config/curation-overrides.json"), {
    schemaVersion: 1,
    records: [
      {
        action: "drop_entry",
        videoId: "AAAAAAAAAAA",
        occurrenceId: "",
        sourceId: "selected:AAAAAAAAAAA:current",
        sourceHash: "hash-current",
        seconds: 10,
        rawHash: "raw-confirmed",
        reason: "existing",
      },
    ],
  });
  fs.mkdirSync(path.join(root, "data/static/v1/days"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/static/v1/days/sentinel.json"), "immutable\n");
  return root;
}

function runBatch(root, args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_REVIEW_ROOT: path.join(root, "data/review"),
      STATIC_CURATION_OVERRIDES_PATH: path.join(root, "config/curation-overrides.json"),
      STATIC_HEARTBEAT_STATE_PATH: path.join(root, "data/review/heartbeat-state.json"),
      STATIC_HEARTBEAT_PATCH_PATH: path.join(root, "data/review/heartbeat-patch.json"),
    },
  });
}

test("heartbeat batch is bounded, cross-scope, type-aware, and skips existing selectors", () => {
  const root = fixtureRoot();
  const output = runBatch(root, [
    "--max-records", "3",
    "--scope", "all",
    "--types", "confirmed_noise,parser_corruption",
    "--now", "2026-10-05T00:00:00.000Z",
  ]);
  assert.match(output, /selected=/);

  const patch = JSON.parse(fs.readFileSync(path.join(root, "data/review/heartbeat-patch.json"), "utf8"));
  assert.equal(patch.records.length, 3, "hard cap is enforced");
  const scopes = new Set(patch.records.map((record) => record.videoId === "AAAAAAAAAAA" ? "current" : "history"));
  assert.deepEqual([...scopes].sort(), ["current", "history"], "the batch covers current and history");
  assert.ok(patch.records.some((record) => record.action === "drop_entry"));
  assert.ok(patch.records.some((record) => record.action === "replace_entry"));
  assert.ok(!patch.records.some((record) => record.rawHash === "raw-confirmed"), "existing selector is skipped");
  assert.ok(!patch.records.some((record) => record.rawHash === "raw-invalid-parser"), "incomplete replacement is skipped");
  assert.equal(fs.readFileSync(path.join(root, "data/static/v1/days/sentinel.json"), "utf8"), "immutable\n");

  const summary = JSON.parse(fs.readFileSync(path.join(root, "data/review/heartbeat-summary.json"), "utf8"));
  assert.equal(summary.rawHistoryTouched, false);
  assert.equal(summary.selectedCounts["current:parser_corruption"], 1);
  assert.equal(summary.selectedCounts["history:confirmed_noise"], 1);
  assert.equal(summary.selectedCounts["history:parser_corruption"], 1);
});

test("static source export turns split release dates into bounded review candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-static-dirty-"));
  writeJson(path.join(root, "data/static/v1/sources/AB/AB123456789.json"), {
    videoId: "AB123456789",
    title: "fixture stream",
    channelName: "fixture channel",
    publishedAt: "2026-01-01T00:00:00.000Z",
    songs: [
      {
        seconds: 10,
        title: "Song/Artist/1999/11",
        artist: "17",
        raw: "0:00:10 Song／Artist／1999/11/17",
        sourceId: "source-a",
        sourceHash: "hash-a",
      },
      {
        seconds: 20,
        title: "Real Song",
        artist: "Artist",
        raw: "0:00:20 Real Song / Artist",
        sourceId: "source-a",
        sourceHash: "hash-a",
      },
    ],
  });
  execFileSync(process.execPath, [exporterPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_DATA_ROOT: path.join(root, "data/static/v1"),
      STATIC_REVIEW_ROOT: path.join(root, "data/review"),
      STATIC_NOW: "2026-02-01T00:00:00.000Z",
    },
  });
  const names = fs.readdirSync(path.join(root, "data/review/sources"));
  assert.equal(names.length, 1);
  const payload = JSON.parse(fs.readFileSync(path.join(root, "data/review/sources", names[0]), "utf8"));
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].classification, "parser_corruption");
  assert.deepEqual(payload.entries[0].replacementSuggestion, { title: "Song", artist: "Artist" });
});

test("dirty export reparses raw lines before removing songs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-static-raw-review-"));
  const songs = [
    ["〜 🎸僕が僕であるために/🎤尾崎豊", "", "15:01 〜 🎸僕が僕であるために／🎤尾崎豊／1983年"],
    ["_那プラス", "みきとP", "1:34:27 ＿那プラス / みきとP"],
    ["Hello,Again ~昔からある場所~", "", "2:42:23 Hello,Again ～昔からある場所～ / MY LITTLE LOVER（1995年）"],
    ["青い栞", "", "2:04:29　🍨🎶　青い栞 - Galileo Galilei (練習中)"],
    ["にんげんっていいな", "中嶋義実・ヤングフレッシュ", "1:42:13 【にんげんっていいな/中嶋義実・ヤングフレッシュ】"],
    ["次回配信は9", "", "4:55:06 次回配信は9/19（土）06 : 00〜朝活配信"],
    ["MELOKEY発売中です", "", "[0:04:20] ❗MELOKEY発売中です(31日まで)"],
    ["NEWS 速報", "", "【00:52:33】💐 NEWS 速報 // 13日22時～ゆあんさん3周年記念配信 🌙🐰"],
  ].map(([title, artist, raw], index) => ({
    seconds: (index + 1) * 10,
    title,
    artist,
    raw,
    sourceId: "source-raw",
    sourceHash: "hash-raw",
  }));
  writeJson(path.join(root, "data/static/v1/sources/CD/CD123456789.json"), {
    videoId: "CD123456789",
    title: "fixture stream",
    channelName: "fixture channel",
    publishedAt: "2026-01-01T00:00:00.000Z",
    songs,
  });

  execFileSync(process.execPath, [exporterPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_DATA_ROOT: path.join(root, "data/static/v1"),
      STATIC_REVIEW_ROOT: path.join(root, "data/review"),
      STATIC_NOW: "2026-02-01T00:00:00.000Z",
    },
  });

  const names = fs.readdirSync(path.join(root, "data/review/sources"));
  assert.equal(names.length, 1);
  const payload = JSON.parse(fs.readFileSync(path.join(root, "data/review/sources", names[0]), "utf8"));
  assert.deepEqual(
    payload.entries.map((entry) => entry.raw),
    [songs[5].raw, songs[6].raw, songs[7].raw],
    "real songs survive while explicit schedule and promotion lines are removed",
  );
});

test("dirty export finds numeric markers and relay participant chapters without dropping relay songs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-static-relay-review-"));
  writeJson(path.join(root, "data/static/v1/sources/EF/EF123456789.json"), {
    videoId: "EF123456789",
    title: "【歌枠リレー】10時間リレー",
    channelName: "fixture relay",
    publishedAt: "2026-01-01T00:00:00.000Z",
    songs: [
      { seconds: 10, title: "1", artist: "未記載", raw: "0:10 1", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 20, title: "一", artist: "未記載", raw: "0:20 一", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 30, title: "一", artist: "未記載", raw: "0:30 一、", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 40, title: "第1章", artist: "未記載", raw: "0:40 第1章", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 50, title: "第一曲", artist: "未記載", raw: "0:50 第一曲", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 60, title: "～ 蜂屋ひまわり", artist: "未記載", raw: "1:00 ～ 蜂屋ひまわり", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 70, title: "1", artist: "Known Artist", raw: "1:10 1 / Known Artist", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 80, title: "残酷な天使のテーゼ", artist: "高橋洋子", raw: "1:20 残酷な天使のテーゼ / 高橋洋子", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 90, title: "【一】", artist: "Known Artist", raw: "1:30 【一】 / Known Artist", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 100, title: "リレー", artist: "未記載", raw: "1:40 リレー", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 110, title: "【", artist: "未記載", raw: "1:50 【", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 120, title: "12", artist: "未記載", raw: "2:00 １２", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 130, title: "第2章", artist: "未記載", raw: "2:10 第２章", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 140, title: "〜:珠々宮けい", artist: "すずみやけい", raw: "🎃 18:30〜:珠々宮けい（すずみやけい）", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 150, title: "〜: suimin", artist: "すいみん", raw: "🎃 20:30〜: suimin.（すいみん）", sourceId: "relay-source", sourceHash: "relay-hash" },
      { seconds: 160, title: "〜: 真の歌", artist: "CV. Real Artist", raw: "🎃 21:00〜: 真の歌 (CV. Real Artist)", sourceId: "relay-source", sourceHash: "relay-hash" },
    ],
  });
  writeJson(path.join(root, "data/static/v1/sources/FG/FG123456789.json"), {
    videoId: "FG123456789",
    title: "通常の歌枠",
    channelName: "fixture channel",
    publishedAt: "2026-01-01T00:00:00.000Z",
    songs: [
      { seconds: 140, title: "～ ただの曲", artist: "未記載", raw: "2:20 ～ ただの曲", sourceId: "ordinary-source", sourceHash: "ordinary-hash" },
    ],
  });

  execFileSync(process.execPath, [exporterPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      STATIC_DATA_ROOT: path.join(root, "data/static/v1"),
      STATIC_REVIEW_ROOT: path.join(root, "data/review"),
      STATIC_NOW: "2026-02-01T00:00:00.000Z",
    },
  });

  const names = fs.readdirSync(path.join(root, "data/review/sources"));
  const relayName = names.find((name) => name.includes("EF123456789"));
  assert.ok(relayName, "relay participants and numeric markers become review candidates");
  const payload = JSON.parse(fs.readFileSync(path.join(root, "data/review/sources", relayName), "utf8"));
  assert.deepEqual(
    payload.entries.map((entry) => [entry.title, entry.classification, entry.riskReasons[0]]),
    [
      ["1", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["一", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["一", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["第1章", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["第一曲", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["～ 蜂屋ひまわり", "confirmed_noise", "relay_participant_or_ceremony_chapter"],
      ["【", "confirmed_noise", "raw_bad_title"],
      ["12", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["第2章", "confirmed_noise", "bare_numeric_chapter_marker"],
      ["〜:珠々宮けい", "confirmed_noise", "relay_participant_or_ceremony_chapter"],
      ["〜: suimin", "confirmed_noise", "relay_participant_or_ceremony_chapter"],
    ],
  );
  assert.equal(
    payload.entries.some((entry) => entry.artist === "Known Artist"),
    false,
    "credited numeric or bracket-shaped songs are preserved",
  );
  assert.equal(payload.entries.some((entry) => entry.title === "リレー"), false, "the relay word alone is not treated as noise");
  assert.equal(payload.entries.some((entry) => entry.title === "〜: 真の歌"), false, "credited parenthesized relay songs are preserved");
  assert.equal(names.some((name) => name.includes("FG123456789")), false, "non-relay wave text is not removed by the relay rule");
});

test("heartbeat batch rejects unsafe scope and type input", () => {
  const root = fixtureRoot();
  assert.throws(() => runBatch(root, ["--scope", "maybe"]), /--scope/u);
  assert.throws(() => runBatch(root, ["--types", "likely_noise"]), /--types/u);
  assert.throws(() => runBatch(root, ["--max-records", "51"]), /--max-records/u);
});

test("heartbeat workflow and check-code gate expose the bounded publication contract", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /default: "25"/u);
  assert.match(workflow, /timeout-minutes: 35/u);
  assert.match(workflow, /Require a green Check code gate/u);
  assert.doesNotMatch(workflow, /Wait for the shared data publishers|HEARTBEAT_PUBLISHERS_BUSY/u);
  assert.match(workflow, /group: daily-song-list-dirty-heartbeat/u);
  assert.match(workflow, /cancel-in-progress: true/u, "duplicate deliveries must collapse to the newest heartbeat run");
  assert.match(workflow, /check-code\.yml/u);
  assert.match(workflow, /static:validate/u);
  assert.match(workflow, /export-static-dirty-review\.js/u);
  assert.ok(
    workflow.indexOf("npm run static:rebuild") < workflow.indexOf("node scripts/static/export-static-dirty-review.js"),
    "dirty review export must run after derived static sources are rebuilt",
  );
  assert.match(workflow, /rebuild-only\.js/u);
  assert.match(workflow, /expected_generated_at="\$\(jq -er '\.generatedAt' data\/static\/v1\/meta\.json\)"/u);
  assert.match(workflow, /expected_meta_sha="\$\(jq -S -c 'del\(\.generatedAt\)' data\/static\/v1\/meta\.json/u);
  assert.ok(
    workflow.indexOf('echo "expected_meta_sha=$expected_meta_sha"') < workflow.indexOf('git restore --worktree -- data/static/v1'),
    "the rebuilt meta digest must be captured before derived output is restored",
  );
  assert.match(workflow, /HEARTBEAT_RAW_HISTORY_CHANGED/u);
  assert.doesNotMatch(workflow, /HEARTBEAT_TRACKED_STATIC_CHANGED/u);
  assert.match(workflow, /git restore --worktree -- data\/static\/v1/u);
  assert.match(workflow, /git add -- config\/curation-overrides\.json data\/review\/heartbeat-state\.json data\/review\/heartbeat-summary\.json/u);
  assert.doesNotMatch(workflow, /git add -A --[^\n]*data\/static\/v1/u);
  assert.match(workflow, /HEARTBEAT_STAGED_RAW_HISTORY/u);
  assert.match(workflow, /GIT_INDEX_FILE="\$index_file" git read-tree "\$base"/u);
  assert.match(workflow, /git update-index --add --cacheinfo/u);
  assert.match(workflow, /git commit-tree "\$tree" -p "\$base"/u);
  assert.match(workflow, /git push origin "\$commit:main"/u);
  assert.match(workflow, /data_commit="\$DATA_COMMIT"/u);
  assert.match(workflow, /EXPECTED_GENERATED_AT: \$\{\{ steps\.batch\.outputs\.expected_generated_at \}\}/u);
  assert.match(workflow, /EXPECTED_META_SHA: \$\{\{ steps\.batch\.outputs\.expected_meta_sha \}\}/u);
  assert.doesNotMatch(workflow, /expected_meta="\$\(curl[^\n]*data\/static\/v1\/meta\.json"\)/u);
  assert.doesNotMatch(workflow, /data_commit="\$\(git rev-parse HEAD\)"/u);
  assert.match(workflow, /HEARTBEAT_INVALID_DATA_COMMIT/u);
  assert.doesNotMatch(workflow, /git rebase origin\/main/u);
  assert.match(workflow, /curl -fsSL --max-time 20[^\n]*https:\/\/marica7731\.github\.io/u, "live verification must follow the Pages custom-domain redirect");
  assert.match(workflow, /HEARTBEAT_PAGES_GRACE/u, "a final grace check must catch deployments that finish at the poll boundary");
  assert.match(workflow, /HEARTBEAT_PAGES_LIVE_GRACE/u, "live meta mismatch must get a bounded successor grace window");
  assert.match(workflow, /for grace_attempt in \$\(seq 1 36\)/u, "successor grace must stay bounded to three minutes");
  assert.match(workflow, /for live_attempt in \$\(seq 1 72\)/u, "live Pages propagation must allow a bounded six-minute edge delay");
  assert.match(workflow, /HEARTBEAT_PAGES_OK source=descendant/u, "live verification must accept a successful descendant deployment as the serving version");
  assert.match(workflow, /Cache-Control: no-cache/u, "live verification must bypass stale edge caches");
  assert.match(workflow, /HEARTBEAT_PAGES_SHA_MISMATCH/u);
  assert.match(workflow, /HEARTBEAT_PAGES_SUPERSEDED/u);
  assert.match(workflow, /HEARTBEAT_PAGES_DESCENDANT/u);
  assert.match(workflow, /compare\/\$data_commit/u);
  assert.match(workflow, /HEARTBEAT_PAGES_STALE/u);
  assert.match(workflow, /HEARTBEAT_PAGES_META_MISMATCH/u);
  assert.match(workflow, /del\(\.generatedAt\)/u, "live verification must exclude only the volatile generatedAt field");
  assert.match(workflow, /HEARTBEAT_PAGES_EDGE_UNAVAILABLE/u);
  assert.match(workflow, /fallback=rebuilt/u, "edge fallback must verify this run's rebuilt meta bytes, not stale commit metadata");
  assert.match(workflow, /deploy-pages\.yml/u);
  assert.doesNotMatch(workflow, /self-hosted|PostgreSQL|WDC|ssh |\bjp\b/iu);

  const checkCode = fs.readFileSync(checkCodePath, "utf8");
  assert.match(checkCode, /\/\.gitignore/u);
  assert.match(checkCode, /heartbeat-dirty-data\.yml/u);
  assert.match(checkCode, /heartbeat-dirty-batch\.js/u);
  assert.match(checkCode, /export-static-dirty-review\.js/u);
  assert.match(checkCode, /rebuild-only\.js/u);
  assert.match(checkCode, /heartbeat-dirty-batch\.test\.mjs/u);
  assert.match(checkCode, /dirty-heartbeat\.trigger/u);
});

test("static rebuild-only preserves raw day shards and collector state", (t) => {
  if (!fs.existsSync(path.join(repoRoot, "scripts/static/collect-and-build.js"))) {
    t.skip("full static pipeline is only present in the GitHub sparse checkout");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsl-rebuild-only-"));
  const dataRoot = path.join(root, "data/static/v1");
  const dayPath = path.join(dataRoot, "days/2026-01-01.json");
  const statePath = path.join(dataRoot, "state.json");
  writeJson(dayPath, {
    videos: [{
      videoId: "AAAAAAAAAAA",
      title: "Raw Stream",
      channelName: "Channel",
      channelId: "UC1234567890",
      publishedAt: "2026-01-01T00:00:00.000Z",
      songs: [{
        occurrenceId: "AAAAAAAAAAA:1:0",
        time: "0:01",
        seconds: 1,
        title: "Song",
        artist: "Artist",
        raw: "0:01 Song / Artist",
        rawHash: "raw-hash",
        sourceId: "source",
        sourceHash: "source-hash",
      }],
    }],
  });
  writeJson(statePath, {
    schemaVersion: 1,
    continuityStart: "2026-01-01T00:00:00.000Z",
    historyGaps: [],
    processedVideoIds: ["AAAAAAAAAAA"],
    queue: [],
    lastSourceSnapshotId: "snapshot",
  });
  const dayBefore = fs.readFileSync(dayPath, "utf8");
  const stateBefore = fs.readFileSync(statePath, "utf8");
  execFileSync(process.execPath, [rebuildScriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, STATIC_DATA_ROOT: dataRoot, STATIC_NOW: "2026-01-02T00:00:00.000Z" },
  });
  assert.equal(fs.readFileSync(dayPath, "utf8"), dayBefore, "raw day shard must remain byte-identical");
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore, "collector state must remain byte-identical");
  const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, "meta.json"), "utf8"));
  assert.equal(meta.videoCount, 1);
  assert.equal(meta.songOccurrenceCount, 1);
});
