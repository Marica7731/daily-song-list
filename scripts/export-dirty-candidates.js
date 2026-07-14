const fs = require("node:fs");
const path = require("node:path");
const { createSongSearchLookup, isSongSearchKnown } = require("../assets/frontend-utils");
const { classifyEntry, hashNormalizedText, isUnknownArtist } = require("./curation");
const { repairParsedEntry } = require("./entry-repair");
const { mergeSupplementalKnownSongs } = require("./song-search-index");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const REVIEW_DIR = path.join(DATA_DIR, "review");
const REVIEW_SOURCE_DIR = path.join(REVIEW_DIR, "sources");
const CURRENT_ENTRY_INDEX_PATH = path.join(REVIEW_DIR, "current-entry-index.json");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");
const ALL_NICHE_UNKNOWN_JSON = path.join(REVIEW_DIR, "all-niche-unknown.json");
const ALL_NICHE_UNKNOWN_MD = path.join(REVIEW_DIR, "all-niche-unknown.md");
const PARSER_CORRUPTIONS_JSON = path.join(REVIEW_DIR, "parser-corruptions.json");
const CONFIRMED_NOISE_JSON = path.join(REVIEW_DIR, "confirmed-noise.json");

const CLASSIFICATIONS = ["confirmed_noise", "parser_corruption", "likely_noise", "needs_review", "likely_song"];
const CLASSIFICATION_LABELS = {
  confirmed_noise: "已确认非歌曲",
  parser_corruption: "已确认解析错误",
  likely_noise: "高概率非歌曲",
  needs_review: "需要人工判断",
  likely_song: "高概率真实歌曲",
};

if (require.main === module) {
  main();
}

function main() {
  const generatedAt = new Date().toISOString();
  const latest = readJson(LATEST_PATH);
  if (!latest?.groups) throw new Error("data/latest.json missing groups");
  const lookup = createSongSearchLookup(mergeSupplementalKnownSongs(readJsonIfExists(SONG_SEARCH_INDEX_PATH) || {}));
  const currentEntryLookup = buildCurrentEntryLookup(readJsonIfExists(CURRENT_ENTRY_INDEX_PATH)?.items || []);

  const latestRecords = collectRecords(latest, lookup, currentEntryLookup);
  const reviewRecords = collectReviewRecords();
  const currentReviewRecords = reviewRecords.filter((record) => record.sourceScope !== "history");
  const classifiedReviewRecords = reviewRecords.filter((record) => record.classification !== "needs_review");
  const allRecords = mergeRecords([...latestRecords, ...reviewRecords]);
  const allNicheUnknown = mergeRecords([...latestRecords, ...currentReviewRecords, ...classifiedReviewRecords]).filter(
    (record) => record.isNiche === true && record.isUnknownArtist === true,
  );
  const parserCorruptions = allRecords.filter((record) => record.classification === "parser_corruption");
  const confirmedNoise = allRecords.filter((record) => record.classification === "confirmed_noise");

  writeJson(ALL_NICHE_UNKNOWN_JSON, reportPayload({ generatedAt, latest, records: allNicheUnknown }));
  writeText(ALL_NICHE_UNKNOWN_MD, renderMarkdownReport({ generatedAt, records: allNicheUnknown }));
  writeJson(PARSER_CORRUPTIONS_JSON, reportPayload({ generatedAt, latest, records: parserCorruptions }));
  writeJson(CONFIRMED_NOISE_JSON, reportPayload({ generatedAt, latest, records: confirmedNoise }));

  console.log(
    `[dirty-candidates] nicheUnknown=${allNicheUnknown.length} parserCorruptions=${parserCorruptions.length} confirmedNoise=${confirmedNoise.length}`,
  );
}

function collectRecords(latest, lookup, currentEntryLookup = null) {
  const byKey = new Map();
  for (const [rangeId, group] of Object.entries(latest.groups || {})) {
    for (const item of group.items || []) {
      for (const song of item.songs || []) {
        const record = buildRecord({ rangeId, item, song, lookup, currentEntryLookup });
        const key = `${record.videoId}:${record.seconds}:${record.rawHash}:${record.title}:${record.artist}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.ranges = uniqueValues([...existing.ranges, rangeId]);
          continue;
        }
        byKey.set(key, record);
      }
    }
  }
  return [...byKey.values()].sort(compareRecord);
}

function buildRecord({ rangeId, item, song, lookup, currentEntryLookup = null }) {
  const sourceId = song.sourceId || item.selectedSourceId || item.sourceQuality?.sourceId || item.sourceId || (item.videoId ? `legacy:${item.videoId}` : "");
  const sourceHash =
    song.sourceHash ||
    item.selectedSourceHash ||
    item.sourceQuality?.sourceHash ||
    item.sourceHash ||
    hashNormalizedText(JSON.stringify((item.songs || []).map((entry) => [entry.seconds, entry.title, entry.artist, entry.raw || ""])));
  const raw = String(song.raw || "");
  const rawHash = song.rawHash || hashNormalizedText(raw || `${song.seconds}:${song.title}:${song.artist}`);
  const repaired = repairParsedEntry({ ...song, raw, rawHash, sourceId, sourceHash }, lookup);
  const knownSong = song.isNiche === false || isSongSearchKnown(repaired, lookup);
  const computed = classifyRecord(repaired, { knownSong });
  const reviewEntry = findCurrentEntry(currentEntryLookup, { ...song, videoId: item.videoId, sourceHash, rawHash });
  const classification = mergeClassification(computed, reviewEntry);
  const riskReasons = uniqueValues([
    ...classification.riskReasons,
    ...(song.isNiche === true && isUnknownArtist(song.artist) && !knownSong ? ["niche_unknown_artist"] : []),
    ...(knownSong && isUnknownArtist(song.artist) ? ["known_song_unknown_artist"] : []),
    ...(repaired.repair?.reasons || []),
  ]);
  const replacementSuggestion = buildReplacementSuggestion(song, repaired, classification.classification);
  const reviewId = reviewEntry?.reviewId || "";
  const sourcePath = reviewEntry?.sourcePath || "";

  return {
    title: song.title || "",
    artist: song.artist || "",
    isNiche: song.isNiche === true,
    isUnknownArtist: isUnknownArtist(song.artist),
    seconds: Number.isInteger(song.seconds) ? song.seconds : null,
    time: song.time || formatSeconds(song.seconds),
    raw,
    rawHash,
    videoId: item.videoId || "",
    videoTitle: item.title || "",
    channelName: item.channelName || "",
    channelId: item.channelId || "",
    channelHandle: item.channelHandle || "",
    youtubeUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : "",
    youtubeTimestampUrl: item.videoId && Number.isInteger(song.seconds) ? `https://www.youtube.com/watch?v=${item.videoId}&t=${song.seconds}s` : "",
    sourceId,
    sourceHash,
    sourceOrigin: "latest",
    sourceScope: "current",
    ranges: [rangeId],
    classification: classification.classification,
    suggestedAction: classification.suggestedAction,
    positiveEvidence: classification.positiveEvidence || [],
    sourceRiskReasons: [],
    riskReasons,
    replacementSuggestion,
    reviewId,
    sourcePath,
    reviewLocator: reviewLocator(sourcePath, rawHash),
    repairedTitle: repaired.title || "",
    repairedArtist: repaired.artist || "",
    repairReasons: repaired.repair?.reasons || [],
  };
}

function collectReviewRecords() {
  if (!fs.existsSync(REVIEW_SOURCE_DIR)) return [];
  const records = [];
  for (const fileName of fs.readdirSync(REVIEW_SOURCE_DIR)) {
    if (!fileName.endsWith(".json")) continue;
    const payload = readJsonIfExists(path.join(REVIEW_SOURCE_DIR, fileName));
    if (!payload?.entries?.length) continue;
    for (const entry of payload.entries) {
      if (!entry.classification || !CLASSIFICATIONS.includes(entry.classification)) continue;
      records.push(recordFromReviewEntry(payload, entry, fileName));
    }
  }
  return records.sort(compareRecord);
}

function recordFromReviewEntry(payload, entry, fileName) {
  const video = payload.video || {};
  const source = payload.source || {};
  const seconds = Number.isInteger(entry.seconds) ? entry.seconds : null;
  const classification =
    entry.classification && CLASSIFICATIONS.includes(entry.classification)
      ? { classification: entry.classification, suggestedAction: entry.suggestedAction || "manual_review", riskReasons: entry.riskReasons || [] }
      : classifyEntry(entry);
  const reviewId = payload.reviewId || "";
  const sourcePath = `data/review/sources/${fileName}`;
  const sourceScope = fileName.startsWith("history-") ? "history" : "current";
  const sourceRiskReasons = payload.risk?.riskReasons || [];
  return {
    title: entry.title || "",
    artist: entry.artist || "",
    isNiche: entry.isNiche === true,
    isUnknownArtist: isUnknownArtist(entry.artist),
    seconds,
    time: entry.time || formatSeconds(seconds),
    raw: entry.raw || "",
    rawHash: entry.rawHash || hashNormalizedText(entry.raw || `${entry.seconds}:${entry.title}:${entry.artist}`),
    videoId: video.videoId || "",
    videoTitle: video.title || "",
    channelName: video.channelName || "",
    channelId: "",
    channelHandle: "",
    youtubeUrl: video.youtubeUrl || (video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : ""),
    youtubeTimestampUrl: video.videoId && Number.isInteger(seconds) ? `https://www.youtube.com/watch?v=${video.videoId}&t=${seconds}s` : "",
    sourceId: entry.sourceId || source.sourceId || "",
    sourceHash: entry.sourceHash || source.sourceHash || "",
    sourceOrigin: `review:${fileName}`,
    sourceScope,
    ranges: source.snapshotId ? [`snapshot:${source.snapshotId}`] : ["review"],
    classification: classification.classification,
    suggestedAction: classification.suggestedAction,
    positiveEvidence: entry.positiveEvidence || [],
    sourceRiskReasons,
    riskReasons: uniqueValues([
      ...(classification.riskReasons || []),
      ...(entry.riskReasons || []),
      ...sourceRiskReasons.filter((reason) => reason.startsWith("source_")),
    ]),
    replacementSuggestion: entry.replacementSuggestion || null,
    reviewId,
    sourcePath,
    reviewLocator: reviewLocator(sourcePath, entry.rawHash || hashNormalizedText(entry.raw || `${entry.seconds}:${entry.title}:${entry.artist}`)),
  };
}

function reportPayload({ generatedAt, latest, records }) {
  return {
    schemaVersion: 1,
    generatedAt,
    dataSource: "data/latest.json + current review sources + classified historical review sources",
    reviewSourceDir: "data/review/sources",
    latestGeneratedAt: latest.generatedAt || "",
    curationVersion: latest.curationVersion || latest.source?.curationVersion || "",
    curationHash: latest.curationHash || latest.source?.curationHash || "",
    counts: reportCounts(records),
    items: records,
  };
}

function reportCounts(records) {
  const byClassification = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0]));
  const videoIds = new Set();
  const sourceIds = new Set();
  for (const record of records || []) {
    if (record.classification in byClassification) byClassification[record.classification] += 1;
    if (record.videoId) videoIds.add(record.videoId);
    if (record.sourceId || record.sourceHash) sourceIds.add(`${record.sourceId || ""}:${record.sourceHash || ""}`);
  }
  return {
    totalCandidates: records.length,
    uniqueVideos: videoIds.size,
    uniqueSources: sourceIds.size,
    confirmedNoiseCount: byClassification.confirmed_noise,
    parserCorruptionCount: byClassification.parser_corruption,
    likelyNoiseCount: byClassification.likely_noise,
    needsReviewCount: byClassification.needs_review,
    likelySongCount: byClassification.likely_song,
    byClassification,
  };
}

function renderMarkdownReport({ generatedAt, records }) {
  const counts = reportCounts(records);
  const lines = [
    "# 全量小众无歌手人工审核清单",
    "",
    `生成时间：${generatedAt}`,
    "",
    `候选总数：${counts.totalCandidates}`,
    `唯一视频数：${counts.uniqueVideos}`,
    `唯一来源数：${counts.uniqueSources}`,
    `已确认非歌曲：${counts.confirmedNoiseCount}`,
    `已确认解析错误：${counts.parserCorruptionCount}`,
    `高概率非歌曲：${counts.likelyNoiseCount}`,
    `需要人工判断：${counts.needsReviewCount}`,
    `高概率真实歌曲：${counts.likelySongCount}`,
    "",
  ];

  for (const classification of CLASSIFICATIONS) {
    const entries = records.filter((record) => record.classification === classification).sort(compareRecord);
    lines.push(`## ${CLASSIFICATION_LABELS[classification]}`, "");
    if (!entries.length) {
      lines.push("无。", "");
      continue;
    }
    for (const [videoKey, videoRecords] of groupByVideo(entries)) {
      const first = videoRecords[0];
      lines.push(`### ${escapeMarkdown(first.videoTitle || videoKey)}`);
      lines.push(`- 视频：${linkOrText(first.videoId, first.youtubeUrl)}`);
      lines.push(`- 频道：${escapeMarkdown(first.channelName || "")}`);
      lines.push("");
      lines.push("| 时间 | 标题 | 歌手 | 范围 | 风险原因 | 正面证据 | 建议 | 审核数据 |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const record of videoRecords.sort(compareRecord)) {
        const reviewLocator = [record.sourcePath, record.rawHash].filter(Boolean).join("#");
        lines.push(
          `| ${linkOrText(record.time || formatSeconds(record.seconds), record.youtubeTimestampUrl)} | ${escapeMarkdown(record.title)} | ${escapeMarkdown(record.artist)} | ${record.ranges.join(", ")} | ${record.riskReasons.join(", ")} | ${(record.positiveEvidence || []).join(", ")} | ${record.suggestedAction} | ${escapeMarkdown(reviewLocator || "review data")} |`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function groupByVideo(records) {
  const groups = new Map();
  for (const record of records || []) {
    const key = record.videoId || record.videoTitle || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].sort(([aKey, aRecords], [bKey, bRecords]) => {
    const a = aRecords[0];
    const b = bRecords[0];
    return (a.channelName || "").localeCompare(b.channelName || "", "ja") || (a.videoTitle || aKey).localeCompare(b.videoTitle || bKey, "ja");
  });
}

function mergeRecords(records) {
  const byKey = new Map();
  for (const record of records || []) {
    const key = `${record.videoId}:${record.seconds}:${record.rawHash}:${record.title}:${record.artist}:${record.classification}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...record, ranges: [...record.ranges] });
      continue;
    }
    existing.ranges = uniqueValues([...existing.ranges, ...record.ranges]);
    if (!existing.sourceOrigin.includes(record.sourceOrigin)) existing.sourceOrigin = `${existing.sourceOrigin};${record.sourceOrigin}`;
  }
  return [...byKey.values()].sort(compareRecord);
}

function buildCurrentEntryLookup(entries) {
  const byKey = new Map();
  for (const entry of entries || []) {
    for (const key of currentEntryKeys(entry)) {
      if (!byKey.has(key)) byKey.set(key, entry);
    }
  }
  return byKey;
}

function findCurrentEntry(lookup, record) {
  if (!lookup) return null;
  for (const key of currentEntryKeys(record)) {
    const found = lookup.get(key);
    if (found) return found;
  }
  return null;
}

function currentEntryKeys(entry) {
  const videoId = String(entry?.videoId || "");
  const rawHash = String(entry?.rawHash || "");
  const sourceHash = String(entry?.sourceHash || "");
  const seconds = Number.isInteger(entry?.seconds) ? String(entry.seconds) : "";
  const title = normalizeKeyText(entry?.title);
  const artist = normalizeKeyText(entry?.artist);
  return uniqueValues([
    videoId && rawHash ? `${videoId}:raw:${rawHash}` : "",
    videoId && sourceHash && rawHash ? `${videoId}:source:${sourceHash}:raw:${rawHash}` : "",
    videoId && seconds && title ? `${videoId}:time-title:${seconds}:${title}:${artist}` : "",
  ]);
}

function classifyRecord(song, options = {}) {
  const classification = classifyEntry(song, options);
  const evidence = positiveEvidence(song, options.knownSong === true);
  if (classification.classification === "likely_song" && !evidence.length) {
    return {
      classification: "needs_review",
      suggestedAction: "manual_review",
      riskReasons: ["no_positive_song_evidence"],
      positiveEvidence: [],
    };
  }
  if (song.repair?.changed) {
    return {
      classification: "parser_corruption",
      suggestedAction: "replace_entry",
      riskReasons: ["parser_corruption", ...(song.repair.reasons || [])],
      positiveEvidence: evidence,
    };
  }
  return {
    classification: classification.classification,
    suggestedAction: classification.suggestedAction,
    riskReasons: classification.riskReasons || [],
    positiveEvidence: evidence,
  };
}

function mergeClassification(computed, reviewEntry) {
  if (!reviewEntry?.classification || !CLASSIFICATIONS.includes(reviewEntry.classification)) return computed;
  if (classificationRank(reviewEntry.classification) >= classificationRank(computed.classification)) {
    return {
      classification: reviewEntry.classification,
      suggestedAction: reviewEntry.suggestedAction || computed.suggestedAction,
      riskReasons: uniqueValues([...(computed.riskReasons || []), ...(reviewEntry.riskReasons || [])]),
      positiveEvidence: uniqueValues([...(computed.positiveEvidence || []), ...(reviewEntry.positiveEvidence || [])]),
    };
  }
  return computed;
}

function classificationRank(classification) {
  return {
    likely_song: 0,
    needs_review: 1,
    likely_noise: 2,
    parser_corruption: 3,
    confirmed_noise: 4,
  }[classification] ?? 0;
}

function positiveEvidence(song, knownSong) {
  const evidence = [];
  if (knownSong) evidence.push(song.repair?.knownTitleArtist ? "known_title_artist" : "known_title");
  if (song.forceKept === true) evidence.push("force_keep");
  if (!isUnknownArtist(song.artist)) evidence.push("inferred_artist");
  return evidence;
}

function buildReplacementSuggestion(original, repaired, classification) {
  if (classification !== "parser_corruption" || !repaired?.repair?.changed) return null;
  const replacement = {};
  if (String(repaired.title || "") !== String(original.title || "")) replacement.title = repaired.title || "";
  if (String(repaired.artist || "") !== String(original.artist || "")) replacement.artist = repaired.artist || "";
  if (Number.isInteger(repaired.seconds) && repaired.seconds !== original.seconds) replacement.seconds = repaired.seconds;
  return Object.keys(replacement).length ? replacement : null;
}

function reviewLocator(sourcePath, rawHash) {
  return [sourcePath, rawHash].filter(Boolean).join("#");
}

function normalizeKeyText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function compareRecord(a, b) {
  return (
    (a.channelName || "").localeCompare(b.channelName || "", "ja") ||
    (a.videoTitle || "").localeCompare(b.videoTitle || "", "ja") ||
    (Number(a.seconds) || 0) - (Number(b.seconds) || 0) ||
    (a.title || "").localeCompare(b.title || "", "ja")
  );
}

function formatSeconds(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function escapeMarkdown(value) {
  return String(value || "").replace(/[\\|`*_{}[\]()#+\-.!]/g, "\\$&").replace(/\n/g, " ");
}

function linkOrText(text, href) {
  const label = escapeMarkdown(text);
  return href ? `[${label}](${href})` : label;
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

module.exports = {
  collectRecords,
  reportCounts,
};
