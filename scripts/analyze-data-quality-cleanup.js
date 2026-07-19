const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createBlockedSourceAudit, filterBlockedVideos, isBlockedSongEntry, matchBlockedSource } = require("../assets/source-filter");
const { applyCurationToVideos } = require("./curation");
const { isLikelyNonSongEntry } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const LATEST_PATH = path.join(ROOT, "data", "latest.json");

const DIRTY_FIELD_PATTERNS = [
  { id: "ed", re: /^(?:ED|エンディング)$/iu },
  { id: "op", re: /^(?:OP|オープニング)$/iu },
  { id: "end", re: /^(?:END|Ending|エンド)$/iu },
  { id: "start", re: /^(?:Start|START|スタート)$/iu },
  { id: "self_intro", re: /自己紹介|ご挨拶|挨拶/iu },
  { id: "song_name_header", re: /^曲名$/iu },
  { id: "wave_only", re: /^～+$/u },
  { id: "begin", re: /^(?:開始|配信開始)$/u },
  { id: "setlist", re: /^(?:Set List|セットリスト|セトリ)$/iu },
  { id: "voice_in", re: /^声入り$/u },
  { id: "timestamp", re: /^タイムスタンプ$/u },
  { id: "tenq_reaction", re: /天Q|DEN\s*Q|DQ|HAWAWA|BUA{3,}|AAA\s+TEST\s+TEST|E\s*HO\s*E\s*HO/iu },
];

const START_WHITELIST_SAMPLES = [
  { title: "StaRt", artist: "Mrs. GREEN APPLE" },
  { title: "START", artist: "レフティーモンスターP feat. Lily" },
  { title: "START", artist: "愛内里菜" },
];

const TRUE_SONG_FALSE_POSITIVE_SAMPLES = [
  { title: "HOT LIMIT", artist: "T.M.Revolution" },
  { title: "READY STEADY GO", artist: "L'Arc-en-Ciel" },
  { title: "はじまりはいつも雨", artist: "ASKA" },
  { title: "勝利のマシンロボ", artist: "子門真人" },
  ...START_WHITELIST_SAMPLES,
];

function main() {
  const input = parseArgs(process.argv.slice(2));
  const payload = readInputPayload(input);
  const videos = uniqueVideos(payload.groups?.all?.items || collectGroupVideos(payload.groups));
  const allSongs = videos.flatMap((video) => (video.songs || []).map((song) => ({ video, song })));
  const blockedAudit = createBlockedSourceAudit();
  const sourceFiltered = filterBlockedVideos(videos, { audit: blockedAudit });
  const curated = applyCurationToVideos(sourceFiltered, { overrides: { records: [] } });
  const curatedSongs = curated.flatMap((video) => video.songs || []);
  const dirtyMatches = countDirtyMatches(allSongs);
  const startRows = allSongs.filter(({ song }) => normalizeKey(song.title) === "start");
  const whitelistSamples = START_WHITELIST_SAMPLES.map((song) => ({
    ...song,
    keptBySongFilter: !isLikelyNonSongEntry(song) && !isBlockedSongEntry(song),
  }));
  const falsePositiveSamples = TRUE_SONG_FALSE_POSITIVE_SAMPLES.map((song) => ({
    ...song,
    wouldDrop: isLikelyNonSongEntry(song) || isBlockedSongEntry(song),
  }));
  const blockedMatches = videos.map((video) => ({ video, match: matchBlockedSource(video) })).filter((entry) => entry.match);
  const arumaMatches = blockedMatches.filter((entry) => /Aruma|薬袋|藥袋/iu.test(entry.match.name || ""));

  const result = {
    generatedAt: new Date().toISOString(),
    inputSource: input.label,
    inputVideos: videos.length,
    inputSongs: allSongs.length,
    dirtyKeywordMatches: dirtyMatches,
    blockedSourceRemoved: blockedAudit.summary().removed,
    arumaBlockedVideoCount: arumaMatches.length,
    afterCurationVideos: curated.length,
    afterCurationSongs: curatedSongs.length,
    curationFilteredSongCount: allSongs.length - curatedSongs.length,
    ruleDroppedEntries: curated.curationStats?.ruleDroppedEntries || 0,
    conversationDroppedEntries: curated.curationStats?.conversationDroppedEntries || 0,
    nearDuplicateDroppedEntries: curated.curationStats?.nearDuplicateDroppedEntries || 0,
    startRowsInData: startRows.length,
    startWhitelistSamplesRetained: whitelistSamples.filter((sample) => sample.keptBySongFilter).length,
    startWhitelistSamples: whitelistSamples,
    falsePositiveSamplesPassed: falsePositiveSamples.every((sample) => !sample.wouldDrop),
    falsePositiveSamples,
    arumaSamples: arumaMatches.slice(0, 5).map(({ video, match }) => ({
      videoId: video.videoId || "",
      channelName: video.channelName || "",
      matchedField: match.matchedField || "",
      matchedValue: match.matchedValue || "",
    })),
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(
    [
      "CODEX_DATA_QUALITY_ANALYZE_OK",
      `inputSongs=${result.inputSongs}`,
      `filteredSongs=${result.curationFilteredSongCount}`,
      `nearDuplicateDropped=${result.nearDuplicateDroppedEntries}`,
      `arumaBlocked=${result.arumaBlockedVideoCount}`,
      `startWhitelistRetained=${result.startWhitelistSamplesRetained}`,
      `falsePositiveSamplesPassed=${result.falsePositiveSamplesPassed}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const input = { type: "file", value: LATEST_PATH, label: path.relative(ROOT, LATEST_PATH) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      const value = argv[index + 1];
      if (!value) throw new Error("--input requires a file path");
      index += 1;
      const filePath = path.resolve(ROOT, value);
      return { type: "file", value: filePath, label: path.relative(ROOT, filePath) };
    }
    if (arg === "--git-ref") {
      const value = argv[index + 1];
      if (!value) throw new Error("--git-ref requires a ref:path value");
      index += 1;
      return { type: "git-ref", value, label: value };
    }
  }
  return input;
}

function readInputPayload(input) {
  if (input.type === "git-ref") {
    return JSON.parse(execFileSync("git", ["show", input.value], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  }
  return readJson(input.value);
}

function countDirtyMatches(entries) {
  const counts = Object.fromEntries(DIRTY_FIELD_PATTERNS.map((pattern) => [pattern.id, { title: 0, artist: 0 }]));
  for (const { song } of entries) {
    for (const pattern of DIRTY_FIELD_PATTERNS) {
      if (pattern.re.test(String(song.title || ""))) counts[pattern.id].title += 1;
      if (pattern.re.test(String(song.artist || ""))) counts[pattern.id].artist += 1;
    }
  }
  return counts;
}

function uniqueVideos(videos) {
  const byKey = new Map();
  for (const video of videos || []) {
    const key = video.videoId || `${video.title || ""}:${video.channelName || ""}`;
    if (!key || byKey.has(key)) continue;
    byKey.set(key, video);
  }
  return [...byKey.values()];
}

function collectGroupVideos(groups) {
  return Object.values(groups || {}).flatMap((group) => group.items || []);
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’~～!！?？.,，。、:：;；\-—–−_・･/／|｜]+/gu, "")
    .trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

if (require.main === module) main();
