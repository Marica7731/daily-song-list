#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readDayVideos } = require("./collect-and-build");
const { cleanStaticVideos } = require("./quality-guard");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const OUTPUT = path.join(DATA_ROOT, "remaining-dirty-audit.json");
const MAX_CANDIDATES = positiveInt(process.env.STATIC_DIRTY_AUDIT_MAX_CANDIDATES, 1200);
const MAX_COLLISIONS = positiveInt(process.env.STATIC_DIRTY_AUDIT_MAX_COLLISIONS, 500);

if (require.main === module) main();

function main() {
  const original = readDayVideos(DATA_ROOT);
  const { videos, audit: appliedQuality } = cleanStaticVideos(original);
  const report = auditVisibleVideos(videos, {
    inputVideoCount: original.length,
    appliedQuality,
    generatedAt: new Date().toISOString(),
  });
  writeJson(OUTPUT, report);
  console.log(
    "STATIC_REMAINING_DIRTY_AUDIT_OK "
      + `visibleVideos=${report.visibleVideoCount} visibleOccurrences=${report.visibleOccurrenceCount} `
      + `highConfidence=${report.highConfidenceCandidateCount} review=${report.reviewCandidateCount} `
      + `descriptionCollisions=${report.descriptionCollisionCount}`,
  );
}

function auditVisibleVideos(videos, context = {}) {
  const rows = [];
  const titleStats = new Map();
  const descriptionHashes = new Map();
  const occurrenceDuplicates = [];
  const perDay = new Map();

  for (const video of videos || []) {
    const seenOccurrenceKeys = new Set();
    const day = String(video.publishedAt || "").slice(0, 10) || "unknown";
    const dayStats = perDay.get(day) || { videos: 0, occurrences: 0, candidates: 0, highConfidenceCandidates: 0 };
    dayStats.videos += 1;

    for (const song of video.songs || []) {
      dayStats.occurrences += 1;
      const row = normalizeRow(video, song);
      rows.push(row);

      const titleKey = normalizeKey(row.title);
      if (titleKey) {
        let stat = titleStats.get(titleKey);
        if (!stat) {
          stat = { title: row.title, count: 0, artists: new Map(), rows: [] };
          titleStats.set(titleKey, stat);
        }
        stat.count += 1;
        const artistKey = normalizeKey(row.artist);
        stat.artists.set(artistKey, (stat.artists.get(artistKey) || 0) + 1);
        if (stat.rows.length < 60) stat.rows.push(row);
      }

      if (row.sourceKind === "description" && row.sourceHash && row.raw.length >= 35) {
        let group = descriptionHashes.get(row.sourceHash);
        if (!group) {
          group = { sourceHash: row.sourceHash, raws: new Set(), videos: new Set(), channels: new Set(), videoTitles: new Set(), rows: [] };
          descriptionHashes.set(row.sourceHash, group);
        }
        group.raws.add(row.raw);
        group.videos.add(row.videoId);
        group.channels.add(row.channelIdentity);
        group.videoTitles.add(row.videoTitle);
        if (group.rows.length < 12) group.rows.push(row);
      }

      const occurrenceKey = [row.seconds, normalizeKey(row.title), normalizeKey(row.artist)].join("\u001f");
      if (seenOccurrenceKeys.has(occurrenceKey)) occurrenceDuplicates.push(row);
      else seenOccurrenceKeys.add(occurrenceKey);
    }
    perDay.set(day, dayStats);
  }

  const dominantArtistByTitle = buildDominantArtistMap(titleStats);
  const candidates = [];
  for (const row of rows) {
    const classification = classifyRemainingRow(row, dominantArtistByTitle.get(normalizeKey(row.title)));
    if (!classification.score) continue;
    candidates.push({ ...row, ...classification });
  }

  for (const candidate of candidates) {
    const dayStats = perDay.get(candidate.day);
    if (!dayStats) continue;
    dayStats.candidates += 1;
    if (candidate.confidence === "high") dayStats.highConfidenceCandidates += 1;
  }

  const collisions = [...descriptionHashes.values()]
    .filter((group) => group.videos.size >= 2 && group.channels.size >= 2)
    .map((group) => ({
      sourceHash: group.sourceHash,
      videoCount: group.videos.size,
      channelCount: group.channels.size,
      distinctVideoTitleCount: group.videoTitles.size,
      distinctRawCount: group.raws.size,
      confidence:
        group.videos.size >= 4 && group.channels.size >= 4 && group.videoTitles.size >= 3 && group.raws.size <= 2
          ? "high"
          : "review",
      sampleRows: group.rows.map(compactRow),
    }))
    .sort((a, b) =>
      confidenceWeight(b.confidence) - confidenceWeight(a.confidence)
      || b.videoCount - a.videoCount
      || b.channelCount - a.channelCount,
    );

  const highConfidence = candidates
    .filter((item) => item.confidence === "high")
    .sort(candidateSort)
    .slice(0, MAX_CANDIDATES);
  const review = candidates
    .filter((item) => item.confidence !== "high")
    .sort(candidateSort)
    .slice(0, MAX_CANDIDATES);

  return {
    schemaVersion: 1,
    generatedAt: context.generatedAt || new Date().toISOString(),
    policy: "audit only; never mutates day shards or published rows",
    visibleVideoCount: (videos || []).length,
    visibleOccurrenceCount: rows.length,
    appliedQuality: {
      quarantinedOccurrences: Number(context.appliedQuality?.quarantinedOccurrences || 0),
      deduplicatedOccurrences: Number(context.appliedQuality?.deduplicatedOccurrences || 0),
      normalizedArtistOccurrences: Number(context.appliedQuality?.normalizedArtistOccurrences || 0),
      normalizedReleaseMetadataOccurrences: Number(context.appliedQuality?.normalizedReleaseMetadataOccurrences || 0),
      repairedDateCreditOccurrences: Number(context.appliedQuality?.repairedDateCreditOccurrences || 0),
      repairedStructuredCreditOccurrences: Number(context.appliedQuality?.repairedStructuredCreditOccurrences || 0),
      repairedKnownSourceCreditOccurrences: Number(context.appliedQuality?.repairedKnownSourceCreditOccurrences || 0),
    },
    descriptionCollisionCount: collisions.length,
    highConfidenceDescriptionCollisionCount: collisions.filter((item) => item.confidence === "high").length,
    highConfidenceCandidateCount: candidates.filter((item) => item.confidence === "high").length,
    reviewCandidateCount: candidates.filter((item) => item.confidence !== "high").length,
    survivingDuplicateCount: occurrenceDuplicates.length,
    byDay: Object.fromEntries([...perDay.entries()].sort()),
    highConfidenceCandidates: highConfidence.map(compactCandidate),
    reviewCandidates: review.map(compactCandidate),
    descriptionCollisions: collisions.slice(0, MAX_COLLISIONS),
    survivingDuplicateSamples: occurrenceDuplicates.slice(0, 100).map(compactRow),
  };
}

function normalizeRow(video, song) {
  const sourceId = String(song?.sourceId || "");
  return {
    day: String(video?.publishedAt || "").slice(0, 10) || "unknown",
    videoId: String(video?.videoId || ""),
    videoTitle: clean(video?.title),
    channelName: clean(video?.channelName),
    channelIdentity: clean(video?.channelId || video?.channelHandle || video?.channelName || video?.videoId),
    seconds: Number.isFinite(Number(song?.seconds)) ? Number(song.seconds) : 0,
    title: clean(song?.title),
    artist: clean(song?.artist),
    raw: clean(song?.raw),
    sourceId,
    sourceHash: clean(song?.sourceHash),
    rawHash: clean(song?.rawHash) || sha256(clean(song?.raw)),
    sourceKind: sourceId.startsWith("description:") ? "description" : sourceId.startsWith("legacy:") ? "legacy" : "comment",
  };
}

function classifyRemainingRow(row, titleStat) {
  const title = row.title;
  const artist = row.artist;
  const raw = row.raw;
  const unknownArtist = isUnknownArtist(artist);
  const reasons = [];
  let score = 0;

  if (!title) return { score: 10, confidence: "high", reasons: ["empty_title"] };

  if (/^(?:\?{2,}|[-~〜～_.・…]+)$/u.test(title)) {
    score += 8;
    reasons.push("placeholder_title");
  }

  if (/^(?:start|stream\s*start|opening|ending|intro|outro|op|ed|mc\s*\d*|talk(?:\s*time|\s*part\s*\d*)?|waiting)$/iu.test(title) && unknownArtist) {
    score += 8;
    reasons.push("standalone_activity_marker");
  }

  const activityWords = /(?:雑談|お話|話題|感想|告知|お知らせ|休憩|水分補給|挨拶|自己紹介|音量(?:チェック|調整)|マイク(?:テスト|チェック)|チューニング|リクエスト(?:募集|受付)|アンケート|スパチャ|メンシ|配信(?:開始|終了|再開)|枠(?:開始|終了|スタート)|振り返り|同接|登録者.*達成|再起動|オフライン|販売中|次枠)/iu;
  if (activityWords.test(title) && unknownArtist) {
    score += 7;
    reasons.push("activity_language_without_artist");
  }

  if (
    unknownArtist &&
    /(?:です|ます|でした|しました|してます|している|について|のお話|ありがとう|おめでとう|だった|だよ|だね|かな|かも|ください|下さい|しよう|します)[!！?？。．.]*$/u.test(title) &&
    title.length >= 8
  ) {
    score += 5;
    reasons.push("sentence_like_unknown_title");
  }

  if (
    /(?:^|\s)(?:20\d{2}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]20\d{2})(?:\s|$)/u.test(title + " " + raw) &&
    /(?:配信|ライブ|stream|live)/iu.test(title + " " + raw) &&
    (unknownArtist || /^(?:[月火水木金土日]|\d{1,2}[月火水木金土日])$/u.test(artist))
  ) {
    score += 7;
    reasons.push("dated_stream_listing");
  }

  if (/^(?:[月火水木金土日]|\d{1,2}[月火水木金土日])$/u.test(artist)) {
    score += 5;
    reasons.push("weekday_as_artist");
  }

  if (/^(?:チャレンジ(?:失敗|成功)|キャンセル|予告|告知|休憩|雑談|talk|mc\d*)$/iu.test(artist)) {
    score += 6;
    reasons.push("activity_descriptor_as_artist");
  }

  if (/^(?:\d+(?:st|nd|rd|th)?\s*)?アルバム「[^」]+」より$/iu.test(artist)) {
    score += 6;
    reasons.push("release_note_as_artist");
  }

  if (artist.length >= 45 && /(?:19|20)\d{2}|(?:アニメ|映画|ドラマ|ゲーム|OP|ED|主題歌|挿入歌|アルバム|発売|リリース)/iu.test(artist)) {
    score += 4;
    reasons.push("metadata_heavy_artist");
  }

  if (title.length >= 55 && unknownArtist && /[、。！？!?]|(?:です|ます|した|する|について)/u.test(title)) {
    score += 4;
    reasons.push("long_sentence_unknown_title");
  }

  if (titleStat?.dominantArtist && normalizeKey(artist) !== titleStat.dominantArtistKey) {
    const mismatchSuspicious = unknownArtist
      || /(?:チャレンジ|キャンセル|アルバム|発売|リリース|OP|ED|主題歌|挿入歌|ライブ|配信|原曲|cover|歌唱)/iu.test(artist)
      || /^(?:[月火水木金土日]|\d{1,2}[月火水木金土日])$/u.test(artist);
    if (mismatchSuspicious && titleStat.total >= 3 && titleStat.dominantCount >= 2 && titleStat.dominantShare >= 0.6) {
      score += 5;
      reasons.push("suspicious_artist_vs_dominant_title_credit");
    }
  }

  if (
    unknownArtist &&
    /[-–—／/|｜]\s*[^-–—／/|｜]{2,}$/u.test(title) &&
    /[-–—／/|｜]/u.test(raw) &&
    title.length >= 12
  ) {
    score += 3;
    reasons.push("possible_unparsed_credit");
  }

  let confidence = "review";
  if (
    score >= 8 ||
    reasons.includes("placeholder_title") ||
    reasons.includes("weekday_as_artist") ||
    reasons.includes("standalone_activity_marker") ||
    reasons.includes("release_note_as_artist")
  ) confidence = "high";

  return { score, confidence, reasons, dominantArtist: titleStat?.dominantArtist || "" };
}

function buildDominantArtistMap(titleStats) {
  const result = new Map();
  for (const [titleKey, stat] of titleStats) {
    const sorted = [...stat.artists.entries()]
      .filter(([artistKey]) => artistKey)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!sorted.length) continue;
    const [dominantArtistKey, dominantCount] = sorted[0];
    const representative = stat.rows.find((row) => normalizeKey(row.artist) === dominantArtistKey)?.artist || "";
    result.set(titleKey, {
      total: stat.count,
      dominantArtistKey,
      dominantArtist: representative,
      dominantCount,
      dominantShare: dominantCount / stat.count,
    });
  }
  return result;
}

function compactCandidate(item) {
  return {
    confidence: item.confidence,
    score: item.score,
    reasons: item.reasons,
    dominantArtist: item.dominantArtist || "",
    ...compactRow(item),
  };
}

function compactRow(row) {
  return {
    day: row.day,
    videoId: row.videoId,
    videoTitle: row.videoTitle,
    channelName: row.channelName,
    seconds: row.seconds,
    title: row.title,
    artist: row.artist,
    raw: row.raw,
    sourceId: row.sourceId,
    sourceHash: row.sourceHash,
    rawHash: row.rawHash,
    sourceKind: row.sourceKind,
  };
}

function candidateSort(a, b) {
  return b.score - a.score
    || a.day.localeCompare(b.day)
    || a.videoId.localeCompare(b.videoId)
    || a.seconds - b.seconds;
}

function confidenceWeight(value) { return value === "high" ? 2 : 1; }
function isUnknownArtist(value) { return /^(?:|未記載|不明|未知歌手|unknown)$/iu.test(clean(value)); }
function clean(value) { return String(value || "").normalize("NFKC").replace(/[\s\u3000]+/gu, " ").trim(); }
function normalizeKey(value) { return clean(value).toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu, ""); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8"); }

module.exports = {
  auditVisibleVideos,
  buildDominantArtistMap,
  classifyRemainingRow,
};
