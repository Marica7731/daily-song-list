#!/usr/bin/env node

const { applyCurationToVideos, loadCurationContext } = require("./curation");
const { createBlockedSourceAudit, filterBlockedVideos, isBlockedSongEntry } = require("../assets/source-filter");
const { normalizeArtistKey, normalizeSongTitleKey } = require("../assets/ranking-utils");

const DEFAULT_URL = "https://ytb-song-rank.culua.com/data/latest.json";
const START_WHITELIST = [
  ["StaRt", "Mrs. GREEN APPLE"],
  ["START", "レフティーモンスターP feat. Lily"],
  ["START", "愛内里菜"],
];

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const queriedAt = new Date().toISOString();
  const payload = await fetchJson(url);
  const groupId = payload.groups?.all ? "all" : payload.groups?.["1m"] ? "1m" : Object.keys(payload.groups || {})[0];
  if (!groupId) throw new Error("payload has no groups");
  const items = payload.groups[groupId]?.items || [];
  const before = summarizeItems(items);
  const blockedAudit = createBlockedSourceAudit();
  const sourceFiltered = filterBlockedVideos(deepClone(items), { audit: blockedAudit });
  const curated = applyCurationToVideos(sourceFiltered, loadCurationContext());
  const after = summarizeItems(curated);
  const falsePositive = runFalsePositiveChecks();
  const positive = runPositiveChecks();

  if (positive.failed.length) {
    throw new Error(`positive checks failed: ${positive.failed.join(", ")}`);
  }
  if (falsePositive.failed.length) {
    throw new Error(`false-positive checks failed: ${falsePositive.failed.join(", ")}`);
  }

  const result = {
    queriedAt,
    sourceUrl: url,
    sourceGeneratedAt: payload.generatedAt || "",
    sourceCapturedAt: payload.capturedAt || "",
    groupId,
    before,
    after,
    projected: {
      blockedVideoCount: blockedAudit.summary().removed,
      curationRuleDroppedEntries: curated.curationStats?.ruleDroppedEntries || 0,
      curationConversationDroppedEntries: curated.curationStats?.conversationDroppedEntries || 0,
      nearDuplicateDroppedEntries: curated.curationStats?.nearDuplicateDroppedEntries || 0,
      nearDuplicateGroups: curated.curationStats?.nearDuplicateGroups || 0,
      songDelta: before.songCount - after.songCount,
      dirtyKeywordDelta: before.dirtyKeywordRows - after.dirtyKeywordRows,
      tenQDelta: before.tenQRows - after.tenQRows,
    },
    checks: {
      positive: positive.passed,
      falsePositive: falsePositive.passed,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(
    [
      "CODEX_DATA_QUALITY_AUDIT_OK",
      `group=${groupId}`,
      `videos=${before.videoCount}`,
      `songsBefore=${before.songCount}`,
      `songsAfter=${after.songCount}`,
      `dirtyBefore=${before.dirtyKeywordRows}`,
      `dirtyAfter=${after.dirtyKeywordRows}`,
      `tenQBefore=${before.tenQRows}`,
      `tenQAfter=${after.tenQRows}`,
      `blockedVideos=${blockedAudit.summary().removed}`,
      `nearDuplicateDropped=${curated.curationStats?.nearDuplicateDroppedEntries || 0}`,
      `falsePositiveChecks=${falsePositive.passed.length}`,
      `positiveChecks=${positive.passed.length}`,
    ].join(" "),
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "codex-data-quality-audit/1.0" },
  });
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function summarizeItems(items) {
  const songs = (items || []).flatMap((item) => item.songs || []);
  return {
    videoCount: (items || []).length,
    songCount: songs.length,
    dirtyKeywordRows: songs.filter(isDirtyKeywordRow).length,
    dirtyKeywordBreakdown: dirtyKeywordBreakdown(songs),
    tenQRows: songs.filter((song) => isTenQTitle(song.title)).length,
    startUnknownRows: songs.filter((song) => isStartTitle(song.title) && isUnknownArtist(song.artist)).length,
    startWhitelistRows: songs.filter(isStartWhitelistSong).length,
    blockedSongRows: songs.filter((song) => isBlockedSongEntry(song)).length,
    sampleDirtyTitles: sampleUnique(songs.filter(isDirtyKeywordRow).map((song) => displaySong(song)), 12),
  };
}

function isDirtyKeywordRow(song) {
  const fields = [song?.title, song?.artist].map((value) => normalizeDirtyField(value));
  return fields.some((value) => {
    if (!value) return false;
    if (/^(?:ed|op|end|start|opening|ending|intro|outro|open|setlist|セットリスト|セトリ|タイムスタンプ|曲名|開始|歌唱開始|歌唱開始時間|歌唱開始時刻|配信開始|配信スタート|待機画面スタート|声入り|自己紹介|挨拶)$/iu.test(value)) return true;
    if (/^[~〜～]+(?:リアルライブチケット#耐久\s*\d+)?$/iu.test(value)) return true;
    return isTenQTitle(value);
  });
}

function dirtyKeywordBreakdown(songs) {
  const counts = {};
  for (const song of songs || []) {
    for (const field of [song?.title, song?.artist]) {
      const key = dirtyKeywordKey(field);
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => left[0].localeCompare(right[0])));
}

function dirtyKeywordKey(value) {
  const normalized = normalizeDirtyField(value);
  if (!normalized) return "";
  if (isTenQTitle(normalized)) return "tenQ";
  if (/^[~〜～]+(?:リアルライブチケット#耐久\s*\d+)?$/iu.test(normalized)) return "wave_marker";
  const compact = normalized.replace(/[\s\u3000]+/gu, "").toLocaleLowerCase();
  if (/^setlist$/iu.test(compact)) return "setlist";
  if (/^(?:start|配信スタート|待機画面スタート)$/iu.test(compact)) return "start";
  if (/^(?:open|opening)$/iu.test(compact)) return "opening";
  if (/^(?:end|ending)$/iu.test(compact)) return "ending";
  if (/^(?:op|ed|intro|outro)$/iu.test(compact)) return compact;
  if (/^(?:開始|歌唱開始|歌唱開始時間|歌唱開始時刻|配信開始)$/u.test(compact)) return "start_japanese";
  if (/^(?:セットリスト|セトリ|タイムスタンプ|曲名|声入り|自己紹介|挨拶)$/u.test(compact)) return compact;
  return "";
}

function normalizeDirtyField(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\u3000!！?？.,，。、:：;；]+$/gu, "")
    .trim();
}

function isTenQTitle(value) {
  const compact = String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000~〜～!！?？.,，。、:：;；\-—–−_]+/gu, "");
  return /天q/u.test(compact);
}

function isStartTitle(value) {
  return normalizeSongTitleKey(value) === "start";
}

function isStartWhitelistSong(song) {
  const titleKey = normalizeSongTitleKey(song?.title || "");
  const artistKey = normalizeArtistKey(song?.artist || "");
  return START_WHITELIST.some(([title, artist]) => titleKey === normalizeSongTitleKey(title) && artistKey === normalizeArtistKey(artist));
}

function isUnknownArtist(value) {
  return new Set(["", "unknown", "n/a", "na", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補", "-"]).has(
    String(value || "").trim(),
  );
}

function runPositiveChecks() {
  const samples = [
    { title: "天Q", artist: "未記載" },
    { title: "天Q天Q~~WO~~~", artist: "未記載" },
    { title: "Set List", artist: "未記載" },
    { title: "Start", artist: "未記載" },
    { title: "opening", artist: "未記載" },
    { title: "END", artist: "未記載" },
    { title: "歌唱開始時間", artist: "未記載" },
    { title: "セットリスト", artist: "歌唱開始時間" },
    { title: "ED", artist: "お遊戯あり" },
  ];
  const passed = [];
  const failed = [];
  for (const sample of samples) {
    const curated = applyCurationToVideos([{ videoId: "POSITIVE", songs: [{ ...sample, seconds: 1, raw: `0:01 ${sample.title}` }] }], { overrides: { records: [] } });
    if (!curated.length) passed.push(displaySong(sample));
    else failed.push(displaySong(sample));
  }
  return { passed, failed };
}

function runFalsePositiveChecks() {
  const samples = [
    { title: "StaRt", artist: "Mrs. GREEN APPLE" },
    { title: "START", artist: "レフティーモンスターP feat. Lily" },
    { title: "START", artist: "愛内里菜" },
    { title: "-ERROR", artist: "niki" },
    { title: "-OZONE-", artist: "めらみぽっぷ" },
    { title: "さらば", artist: "キンモクセイ『あたしンち』初代OP ※" },
    { title: "READY STEADY GO", artist: "L'Arc-en-Ciel" },
    { title: "タッチ", artist: "岩崎良美" },
    { title: "Opening", artist: "Known Artist" },
    { title: "Open Your Eyes", artist: "Guano Apes" },
    { title: "ENDLESS STORY", artist: "REIRA starring YUNA ITO" },
  ];
  const curated = applyCurationToVideos(
    [
      {
        videoId: "FALSEPOSITIVE",
        songs: samples.map((sample, index) => ({ ...sample, seconds: index * 60 + 1, raw: `0:${String(index).padStart(2, "0")}:01 ${sample.title} / ${sample.artist}` })),
      },
    ],
    { overrides: { records: [] } },
  );
  const kept = new Set((curated[0]?.songs || []).map(displaySong));
  const passed = [];
  const failed = [];
  for (const sample of samples) {
    const label = displaySong(sample);
    if (kept.has(label)) passed.push(label);
    else failed.push(label);
  }
  return { passed, failed };
}

function sampleUnique(values, limit) {
  return [...new Set(values)].slice(0, limit);
}

function displaySong(song) {
  return `${song?.title || ""} / ${song?.artist || ""}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_DATA_QUALITY_AUDIT_FAIL ${error.stack || error.message}`);
    process.exit(1);
  });
}
