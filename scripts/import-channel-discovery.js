const fs = require("node:fs");
const path = require("node:path");

const { createSongSearchLookup, isSongSearchKnown, normalizeSongSearchText } = require("../assets/frontend-utils");
const { matchBlockedSource } = require("../assets/source-filter");
const { backfillSongArtist, createArtistBackfillContext, extractReliableRawArtistCredit, titleLookupKeys } = require("./artist-backfill");
const { hashNormalizedText, loadCurationContext } = require("./curation");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { mergeSupplementalKnownSongs } = require("./song-search-index");
const {
  VIDEO_CATALOG_PATH,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  writeCatalogSegments,
  writeVideoCatalog,
} = require("./video-catalog");
const { isLikelyNonSongEntry, normalizeParsedSong } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_GROUP = "youtube_channel_discovery";
const DEFAULT_IMPORT_AUDIT_EXCEPTIONS_PATH = path.join(ROOT, "config", "youtube-channel-import-audit-exceptions.json");
const UNKNOWN_ARTIST_VALUES = new Set(["", "unknown", "na", "n/a", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補", "-"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = inputDirsFromArgs(args);
  const startedAt = new Date().toISOString();
  const curation = loadCurationContext();
  const before = loadVideoCatalog();
  const { videos, stats: readStats } = readDiscoveryVideos(inputs, { auditExceptionsPath: args["audit-exceptions"] });
  if (!videos.length && !args["allow-empty"]) {
    throw new Error(`no usable channel discovery video details found in ${inputs.join(", ")}`);
  }
  const safeImport = filterNonRegressiveImports(before, videos);
  const importedVideos = safeImport.videos.map((video) => ({
    ...video,
    curationVersion: curation.version,
    curationHash: curation.hash,
  }));
  const update = mergeVideosIntoCatalog(before, importedVideos, startedAt);
  writeVideoCatalog(update.catalog, VIDEO_CATALOG_PATH);
  const segmentStats = writeCatalogSegments(update.catalog);
  const beforeVideoIds = new Set(before.videos.map((entry) => entry.videoId));
  const candidateVideoIds = new Set(videos.map((video) => video.videoId));
  const importedVideoIds = new Set(importedVideos.map((video) => video.videoId));
  const report = {
    schemaVersion: 1,
    kind: "youtube-channel-discovery-import",
    generatedAt: startedAt,
    inputs,
    readStats: { ...readStats, ...safeImport.stats },
    catalogStats: update.stats,
    segmentStats,
    candidateVideoIds: [...candidateVideoIds].sort(),
    importedVideoIds: [...importedVideoIds].sort(),
    addedVideoIds: [...importedVideoIds].filter((videoId) => !beforeVideoIds.has(videoId)).sort(),
  };
  const reportPath = path.resolve(ROOT, String(args["report-path"] || path.join("artifacts", "channel-discovery", "import-report.json")));
  writeJson(reportPath, report);
  console.log(
    [
      "CODEX_CHANNEL_DISCOVERY_IMPORT_OK",
      `inputs=${inputs.length}`,
      `readVideos=${readStats.videoDetails}`,
      `usableVideos=${videos.length}`,
      `importedVideos=${importedVideos.length}`,
      `skippedRegressions=${safeImport.stats.skippedExistingRegressions}`,
      `suspicious=${readStats.preImportAudit.totals.cleaned.videos.withSuspiciousRows}`,
      `songs=${readStats.songs}`,
      `catalogBefore=${before.videos.length}`,
      `catalogAfter=${update.catalog.videos.length}`,
      `added=${update.stats.addedVideoCount}`,
      `updated=${update.stats.updatedVideoCount}`,
      `segments=${segmentStats.segmentCount}`,
      `report=${quoteForMarker(reportPath)}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function inputDirsFromArgs(args) {
  const values = listValues(args["input-dir"] || args.input || args._);
  const dirs = values.map((value) => path.resolve(ROOT, String(value || ""))).filter(Boolean);
  if (!dirs.length) {
    throw new Error("Usage: npm run youtube:import-channel-discovery -- --input-dir <discovery output dir>");
  }
  return [...new Set(dirs)];
}

function readDiscoveryVideos(inputDirs, options = {}) {
  const videos = [];
  const seen = new Set();
  const hasExplicitAuditExceptionsPath = Object.prototype.hasOwnProperty.call(options, "auditExceptionsPath") && options.auditExceptionsPath;
  if (options.auditExceptionsPath === true) throw new Error("--audit-exceptions requires a value");
  const auditExceptions = loadImportAuditExceptions(
    hasExplicitAuditExceptionsPath ? path.resolve(ROOT, String(options.auditExceptionsPath)) : DEFAULT_IMPORT_AUDIT_EXCEPTIONS_PATH,
    options.auditExceptions,
    { requireFile: Boolean(hasExplicitAuditExceptionsPath) },
  );
  const stats = {
    inputDirs: inputDirs.length,
    videoDetails: 0,
    usableVideos: 0,
    skippedNoSongs: 0,
    skippedInvalidVideoId: 0,
    duplicateVideoIds: 0,
    songs: 0,
    videosWithPublishedTimestamp: 0,
    videosWithThumbnail: 0,
    songsWithTimestamp: 0,
    rawSongCandidates: 0,
    acceptedSongs: 0,
    skippedSongs: 0,
    failedSongs: 0,
    suspiciousSongs: 0,
    inputSummaries: [],
    preImportAudit: emptyPreImportAudit(),
  };
  for (const inputDir of inputDirs) {
    const filePath = path.join(inputDir, "video-details.json");
    if (!fs.existsSync(filePath)) throw new Error(`video-details.json not found: ${filePath}`);
    const details = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(details)) throw new Error(`video-details.json must be an array: ${filePath}`);
    const inputAuditContext = createImportAuditContext(details, auditExceptions, options);
    const inputStats = {
      inputDir: projectRelativePath(inputDir),
      videoDetails: 0,
      usableVideos: 0,
      skippedNoSongs: 0,
      skippedInvalidVideoId: 0,
      duplicateVideoIds: 0,
      songs: 0,
      videosWithPublishedTimestamp: 0,
      videosWithThumbnail: 0,
      songsWithTimestamp: 0,
      rawSongCandidates: 0,
      acceptedSongs: 0,
      skippedSongs: 0,
      failedSongs: 0,
      suspiciousSongs: 0,
      preImportAudit: emptyPreImportInputSummary(inputDir),
    };
    for (const detail of details) {
      stats.videoDetails += 1;
      inputStats.videoDetails += 1;
      const audit = auditDiscoveryDetail(detail, inputDir, inputAuditContext);
      mergePreImportAudit(stats.preImportAudit, inputStats.preImportAudit, audit);
      inputStats.rawSongCandidates += audit.rawSongCandidateCount;
      inputStats.acceptedSongs += audit.acceptedSongCount;
      inputStats.skippedSongs += audit.skippedSongCount;
      inputStats.failedSongs += audit.failedSongCount;
      inputStats.suspiciousSongs += audit.suspiciousSongCount;
      stats.rawSongCandidates += audit.rawSongCandidateCount;
      stats.acceptedSongs += audit.acceptedSongCount;
      stats.skippedSongs += audit.skippedSongCount;
      stats.failedSongs += audit.failedSongCount;
      stats.suspiciousSongs += audit.suspiciousSongCount;
      const videoId = String(detail?.videoId || "").trim();
      if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
        stats.skippedInvalidVideoId += 1;
        inputStats.skippedInvalidVideoId += 1;
        continue;
      }
      const songs = audit.acceptedSongs;
      if (!songs.length) {
        if (audit.status === "skipped") {
          stats.skippedNoSongs += 1;
          inputStats.skippedNoSongs += 1;
        }
        continue;
      }
      if (seen.has(videoId)) {
        stats.duplicateVideoIds += 1;
        inputStats.duplicateVideoIds += 1;
        continue;
      }
      seen.add(videoId);
      videos.push(normalizeImportedVideo(detail, inputDir, songs));
      stats.usableVideos += 1;
      stats.songs += songs.length;
      stats.videosWithPublishedTimestamp += finiteTimestamp(detail.publishedTimestamp) ? 1 : 0;
      stats.videosWithThumbnail += stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId) ? 1 : 0;
      stats.songsWithTimestamp += songs.filter((song) => Number.isFinite(Number(song.seconds))).length;
      inputStats.usableVideos += 1;
      inputStats.songs += songs.length;
      inputStats.videosWithPublishedTimestamp += finiteTimestamp(detail.publishedTimestamp) ? 1 : 0;
      inputStats.videosWithThumbnail += stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId) ? 1 : 0;
      inputStats.songsWithTimestamp += songs.filter((song) => Number.isFinite(Number(song.seconds))).length;
    }
    stats.inputSummaries.push(inputStats);
    stats.preImportAudit.inputSummaries.push(inputStats.preImportAudit);
  }
  finalizePreImportAudit(stats.preImportAudit);
  return { videos, stats };
}

function createImportAuditContext(details, auditExceptions, options = {}) {
  const titleCounts = new Map();
  const strippedTitleCounts = new Map();
  const corpusSongs = [];
  for (const detail of details || []) {
    for (const rawSong of Array.isArray(detail?.songs) ? detail.songs : []) {
      const song = normalizeParsedSong(rawSong);
      const titleKey = normalizeAuditKey(song?.title);
      const strippedKey = strippedTitleSignal(song?.title);
      if (titleKey) incrementCount(titleCounts, titleKey);
      if (strippedKey) incrementCount(strippedTitleCounts, strippedKey);
      corpusSongs.push(song);
    }
  }
  const songAliasContext = options.songAliasContext || loadSongAliasContext();
  const songSearchIndex = mergeSupplementalKnownSongs(options.songSearchIndex || {}, options.supplementalKnownSongs);
  const songSearchLookup = createSongSearchLookup(songSearchIndex);
  const artistBackfillContext = createArtistBackfillContext({
    aliasContext: songAliasContext,
    corpusVideos: [{ videoId: "pre-import-corpus", songs: corpusSongs }],
    supplementalKnownSongs: songSearchIndex.supplementalKnownSongs || [],
  });
  return {
    titleCounts,
    strippedTitleCounts,
    auditExceptions,
    songAliasContext,
    songSearchIndex,
    songSearchLookup,
    artistBackfillContext,
  };
}

function auditDiscoveryDetail(detail, inputDir, context) {
  const videoId = String(detail?.videoId || "").trim();
  const rawSongs = Array.isArray(detail?.songs) ? detail.songs : [];
  const thumbnailUrl = stringValue(detail?.thumbnailUrl) || fallbackThumbnailUrl(videoId);
  const songs = [];
  const videoReasons = [];
  let acceptedSongCount = 0;
  let skippedSongCount = 0;
  let failedSongCount = 0;
  let suspiciousSongCount = 0;

  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) videoReasons.push("invalid_video_id");
  if (/^[A-Za-z0-9_-]{11}$/u.test(videoId) && !thumbnailUrl) videoReasons.push("missing_thumbnail_url");
  const blockedSourceMatch = matchBlockedSource(detail);
  if (blockedSourceMatch) videoReasons.push("blocked_source");

  const hasFatalVideoReason = videoReasons.includes("invalid_video_id") || videoReasons.includes("missing_thumbnail_url") || videoReasons.includes("blocked_source");
  rawSongs.forEach((rawSong, index) => {
    const normalized = normalizeParsedSong(rawSong) || {};
    const baseSong = {
      ...normalized,
      time: stringValue(normalized.time),
      seconds: Math.max(0, Number(normalized.seconds) || 0),
      title: stringValue(normalized.title),
      artist: stringValue(normalized.artist) || "未記載",
      raw: stringValue(normalized.raw),
      rawHash: stringValue(normalized.rawHash || hashNormalizedText(normalized.raw || `${normalized.time || normalized.seconds || ""} ${normalized.title || ""}`)),
      sourceId: stringValue(normalized.sourceId || detail?.selectedSourceId || detail?.sourceQuality?.sourceId),
      sourceHash: stringValue(normalized.sourceHash || detail?.selectedSourceHash || detail?.sourceQuality?.sourceHash),
    };
    const songAudit = auditSongCandidate(baseSong, {
      ...context,
      detail,
      videoId,
      songIndex: index,
      hasFatalVideoReason,
    });
    songs.push(songAudit.item);
    if (songAudit.status === "accepted") acceptedSongCount += 1;
    else if (songAudit.status === "failed") failedSongCount += 1;
    else if (songAudit.status === "suspicious") suspiciousSongCount += 1;
    else skippedSongCount += 1;
  });

  let status = "skipped";
  if (hasFatalVideoReason) status = "failed";
  else if (acceptedSongCount > 0) status = "accepted";
  else if (suspiciousSongCount > 0) status = "suspicious";

  return {
    inputDir: projectRelativePath(inputDir),
    videoId,
    title: stringValue(detail?.title),
    channelName: stringValue(detail?.channelName),
    thumbnailUrl,
    channelAvatarUrl: stringValue(detail?.channelAvatarUrl || detail?.channelThumbnailUrl),
    status,
    reasons: videoReasons,
    rawSongCandidateCount: rawSongs.length,
    acceptedSongCount,
    skippedSongCount,
    failedSongCount,
    suspiciousSongCount,
    acceptedSongs: status === "failed" ? [] : songs.filter((song) => song.status === "accepted").map((song) => song.song),
    songs,
  };
}

function auditSongCandidate(song, context) {
  const explicitReject = findAuditException("rejected", song, context);
  if (explicitReject) {
    return auditSongResult("skipped", song, ["manual_reject_exception"], explicitReject);
  }
  if (!song.title) return auditSongResult("failed", song, ["missing_title"]);
  if (context.hasFatalVideoReason) return auditSongResult("failed", song, ["video_failed_pre_import_audit"]);

  const repairedSong = canonicalizeSongIdentity(backfillSongArtist(song, context.artistBackfillContext), context.songAliasContext);
  if (!isImportableSong(repairedSong) || isLikelyTranslationSplit(repairedSong) || hasTimelineMarkerPollution(repairedSong) || isLikelyExplanationOrGreeting(repairedSong)) {
    return auditSongResult("skipped", repairedSong, nonSongAuditReasons(repairedSong));
  }
  const suspiciousReasons = suspiciousReasonsForSong(repairedSong, context);
  const explicitAccept = suspiciousReasons.length ? findAuditException("accepted", song, context) : null;
  if (suspiciousReasons.length) {
    if (explicitAccept) return auditSongResult("accepted", repairedSong, ["manual_accept_exception"], explicitAccept);
    return auditSongResult("suspicious", repairedSong, suspiciousReasons);
  }
  return auditSongResult("accepted", repairedSong);
}

function auditSongResult(status, song, reasons = [], exception = null) {
  return {
    status,
    item: {
      status,
      reasons: uniqueValues(reasons),
      exceptionId: stringValue(exception?.id),
      reviewedBy: stringValue(exception?.reviewedBy),
      song,
    },
  };
}

function suspiciousReasonsForSong(song, context) {
  const reasons = [];
  if (isSingletonWithoutArtist(song, context)) reasons.push("single_occurrence_without_artist");
  if (isSingletonAfterNoiseStrip(song, context)) reasons.push("single_occurrence_after_noise_strip");
  if (isLikelyTranslationSplit(song)) reasons.push("translation_split_as_artist");
  if (hasTimelineMarkerPollution(song)) reasons.push("timeline_marker_pollution");
  return uniqueValues(reasons);
}

function isSingletonWithoutArtist(song, context) {
  if (!isUnknownArtist(song.artist)) return false;
  if (hasTrustedKnownSongEvidence(song, context) || hasRecoverableArtistEvidence(song, context)) return false;
  const titleKey = normalizeAuditKey(song.title);
  return Boolean(titleKey && (context.titleCounts.get(titleKey) || 0) <= 1);
}

function isSingletonAfterNoiseStrip(song, context) {
  if (!isUnknownArtist(song.artist)) return false;
  if (hasTrustedKnownSongEvidence(song, context) || hasRecoverableArtistEvidence(song, context)) return false;
  const stripped = strippedTitleSignal(song.title);
  if (!stripped || (context.strippedTitleCounts.get(stripped) || 0) > 1) return false;
  return isWeakSongTitleSignal(stripped, song.title) || hasTimelineMarkerPollution(song) || isLikelyExplanationOrGreeting(song);
}

function nonSongAuditReasons(song) {
  const reasons = ["rule_rejected_non_song"];
  if (isLikelyExplanationOrGreeting(song)) reasons.push("likely_narration_or_greeting");
  if (isLikelyTranslationSplit(song)) reasons.push("translation_split_as_artist");
  if (hasTimelineMarkerPollution(song)) reasons.push("timeline_marker_pollution");
  return uniqueValues(reasons);
}

function hasTrustedKnownSongEvidence(song, context) {
  return Boolean(isSongSearchKnown(song, context.songSearchLookup));
}

function hasRecoverableArtistEvidence(song, context) {
  if (extractReliableRawArtistCredit(song).artist) return true;
  const backfillContext = context.artistBackfillContext;
  if (!backfillContext?.candidatesByTitleKey) return false;
  return titleLookupKeys(song.title).some((key) => (backfillContext.candidatesByTitleKey.get(key) || []).length > 0);
}

function isLikelyExplanationOrGreeting(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC");
  const combined = `${title} ${raw}`;
  if (/(?:(?:歌|配信)?枠)?\s*(?:start|stream\s*start|開始)/iu.test(combined)) return true;
  if (!title) return false;
  if (/^(?:おはよう|おはようございます|こんにちは|こんばんは|hello|hi|start|stream start|開始|終了)[!！。.\s]*$/iu.test(title)) return true;
  return (
    isUnknownArtist(song?.artist) &&
    /(?:雑談|説明|紹介|挨拶|打ち合わせ|コメント|チャット|告知|宣伝|休憩|開始|終了|タイムスタンプ|曲名|セトリ|セットリスト|ありがとう|お疲れ|おつかれ|配信|動画|概要欄)/iu.test(combined)
  );
}

function isLikelyTranslationSplit(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC");
  if (!/[一-龯ぁ-んァ-ヶ]/u.test(title)) return false;
  if (!/[A-Za-z]/u.test(artist) || /[一-龯ぁ-んァ-ヶ]/u.test(artist)) return false;
  if (!/[\/／]\s*[A-Za-z]/u.test(raw)) return false;
  const wordCount = artist.split(/\s+/u).filter(Boolean).length;
  return wordCount >= 4 || /\b(?:Story|Stream|Comment|Chat|Song List|Guide Melody|Practice|Hospital|Food|Drink|Throat|Birthday|Surprised|Recommendations)\b/iu.test(artist);
}

function hasTimelineMarkerPollution(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC");
  const combined = `${title} ${artist} ${raw}`;
  if (/^(?:OP|ED|Start|End|Stream Start|開始|終了|タイムスタンプ|曲名|歌詞|セトリ|セットリスト)$/iu.test(title)) return true;
  if (/^[#\d０-９\s.．:：)）、-]*(?:OP|ED|Start|End|開始|終了|タイムスタンプ|曲名)\b/iu.test(combined)) return true;
  if (/[《〈<【「『].{0,18}(?:OP|ED|Start|End|開始|終了|タイムスタンプ|曲名).{0,18}[》〉>】」』]/iu.test(combined)) return true;
  if (/(?:^|[\s　《〈<【「『])(?:OP|ED|Start|End|Stream\s*Start|開始|終了|タイムスタンプ|曲名)(?:$|[\s　》〉>】」』])/iu.test(combined)) return true;
  return false;
}

function strippedTitleSignal(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/(?<![\dA-Za-z_:])(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?!\d)/gu, " ")
    .replace(/[《〈<【「『\[({（].{0,80}?[》〉>】」』\])}）]/gu, " ")
    .replace(/^[#\s]*(?:\d{1,3}[)）、.:：．-]?\s*)+/u, " ")
    .replace(/\b(?:OP|ED|Start|End|Stream\s*Start)\b/giu, " ")
    .replace(/(?:開始|終了|タイムスタンプ|曲名|歌詞|セトリ|セットリスト|一曲目|二曲目|三曲目)/gu, " ");
  return normalizeAuditKey(text);
}

function isWeakSongTitleSignal(stripped, originalTitle) {
  if (!stripped || stripped.length <= 2) return true;
  if (!/[A-Za-zぁ-んァ-ヶ一-龯]/u.test(stripped)) return true;
  if (/^(?:op|ed|start|end|streamstart|開始|終了|曲名|タイムスタンプ|timestamp)$/iu.test(stripped)) return true;
  const title = String(originalTitle || "").normalize("NFKC").trim();
  return /(?:です|ます|ました|する|した|して|だった|でした|ください|お願い|ありがとう|お疲れ|おつかれ|[?？])$/u.test(title);
}

function emptyPreImportAudit() {
  return {
    schemaVersion: 1,
    policy: {
      accepted: "rule-cleaned rows after blocklist, curation, canonicalization, and artist backfill",
      dropped: "fatal video rows, blocklisted sources, parser failures, and high-confidence non-song rows",
      suspicious: "song-shaped rows with weak evidence; AI/manual review must produce a reproducible rule or explicit exception before import",
    },
    totals: {
      ...emptyPreImportCounts(),
      reasons: emptyPreImportReasons(),
    },
    inputSummaries: [],
    suspiciousItems: [],
    suspiciousQueue: [],
    caseSamples: {},
    channelSummaries: {},
  };
}

function emptyPreImportInputSummary(inputDir) {
  return {
    inputDir: projectRelativePath(inputDir),
    raw: {
      videoDetails: 0,
      songCandidates: 0,
    },
    cleaned: emptyPreImportCounts().cleaned,
    reasons: emptyPreImportReasons(),
    suspiciousItems: [],
    suspiciousQueue: [],
    caseSamples: {},
    channelSummaries: {},
  };
}

function emptyPreImportCounts() {
  return {
    raw: {
      videoDetails: 0,
      songCandidates: 0,
    },
    cleaned: {
      videos: { accepted: 0, skipped: 0, failed: 0, suspicious: 0, withSuspiciousRows: 0, withFailedRows: 0 },
      songs: { accepted: 0, skipped: 0, failed: 0, suspicious: 0 },
    },
  };
}

function emptyPreImportReasons() {
  return {
    skipped: {},
    failed: {},
    suspicious: {},
    acceptedExceptions: 0,
    rejectedExceptions: 0,
  };
}

function mergePreImportAudit(totalAudit, inputAudit, detailAudit) {
  for (const audit of [totalAudit.totals, inputAudit]) {
    audit.raw.videoDetails += 1;
    audit.raw.songCandidates += detailAudit.rawSongCandidateCount;
    audit.cleaned.videos[detailAudit.status] = (audit.cleaned.videos[detailAudit.status] || 0) + 1;
    if (detailAudit.suspiciousSongCount > 0) audit.cleaned.videos.withSuspiciousRows += 1;
    if (detailAudit.failedSongCount > 0) audit.cleaned.videos.withFailedRows += 1;
    audit.cleaned.songs.accepted += detailAudit.acceptedSongCount;
    audit.cleaned.songs.skipped += detailAudit.skippedSongCount;
    audit.cleaned.songs.failed += detailAudit.failedSongCount;
    audit.cleaned.songs.suspicious += detailAudit.suspiciousSongCount;
  }
  recordChannelAudit(totalAudit.channelSummaries, detailAudit);
  recordChannelAudit(inputAudit.channelSummaries, detailAudit);
  addReasonCounts(totalAudit, inputAudit, detailAudit);
  const reviewItem = compactSuspiciousAuditItem(detailAudit);
  if (reviewItem) {
    totalAudit.suspiciousItems.push(reviewItem);
    inputAudit.suspiciousItems.push(reviewItem);
    totalAudit.suspiciousQueue = totalAudit.suspiciousItems;
    inputAudit.suspiciousQueue = inputAudit.suspiciousItems;
  }
}

function addReasonCounts(totalAudit, inputAudit, detailAudit) {
  for (const reason of detailAudit.reasons || []) {
    addReasonCount(totalAudit.totals.reasons.failed, reason);
    addReasonCount(inputAudit.reasons.failed, reason);
    addCaseSample(totalAudit.caseSamples, reason, detailAudit, null);
    addCaseSample(inputAudit.caseSamples, reason, detailAudit, null);
  }
  for (const song of detailAudit.songs || []) {
    const bucket = song.status === "failed" ? "failed" : song.status === "suspicious" ? "suspicious" : song.status === "skipped" ? "skipped" : "";
    if (!bucket) {
      if (song.reasons.includes("manual_accept_exception")) {
        totalAudit.totals.reasons.acceptedExceptions += 1;
        inputAudit.reasons.acceptedExceptions += 1;
      }
      continue;
    }
    for (const reason of song.reasons || []) {
      addReasonCount(totalAudit.totals.reasons[bucket], reason);
      addReasonCount(inputAudit.reasons[bucket], reason);
      addCaseSample(totalAudit.caseSamples, reason, detailAudit, song);
      addCaseSample(inputAudit.caseSamples, reason, detailAudit, song);
      if (reason === "manual_reject_exception") {
        totalAudit.totals.reasons.rejectedExceptions += 1;
        inputAudit.reasons.rejectedExceptions += 1;
      }
    }
  }
}

function finalizePreImportAudit(audit) {
  addDroppedAliases(audit.totals);
  audit.suspiciousQueue = audit.suspiciousItems;
  audit.caseSamples = sortCaseSamples(audit.caseSamples);
  audit.channelSummaries = finalizeChannelSummaries(audit.channelSummaries);
  for (const input of audit.inputSummaries || []) {
    addDroppedAliases(input);
    input.suspiciousQueue = input.suspiciousItems;
    input.caseSamples = sortCaseSamples(input.caseSamples);
    input.channelSummaries = finalizeChannelSummaries(input.channelSummaries);
  }
}

function addDroppedAliases(summary) {
  summary.cleaned.videos.dropped = (summary.cleaned.videos.skipped || 0) + (summary.cleaned.videos.failed || 0);
  summary.cleaned.songs.dropped = (summary.cleaned.songs.skipped || 0) + (summary.cleaned.songs.failed || 0);
}

function recordChannelAudit(target, detailAudit) {
  const key = normalizeAuditKey(detailAudit.channelName) || detailAudit.videoId || "unknown";
  if (!target[key]) {
    target[key] = {
      channelName: detailAudit.channelName,
      rawVideoDetails: 0,
      rawCandidates: 0,
      accepted: 0,
      dropped: 0,
      suspicious: 0,
      byStatus: {},
      byReason: {},
    };
  }
  const record = target[key];
  record.rawVideoDetails += 1;
  record.rawCandidates += detailAudit.rawSongCandidateCount;
  record.accepted += detailAudit.acceptedSongCount;
  record.dropped += detailAudit.skippedSongCount + detailAudit.failedSongCount;
  record.suspicious += detailAudit.suspiciousSongCount;
  record.byStatus[detailAudit.status] = (record.byStatus[detailAudit.status] || 0) + 1;
  for (const song of detailAudit.songs || []) {
    for (const reason of song.reasons || []) record.byReason[reason] = (record.byReason[reason] || 0) + 1;
  }
  for (const reason of detailAudit.reasons || []) record.byReason[reason] = (record.byReason[reason] || 0) + 1;
}

function finalizeChannelSummaries(value) {
  return Object.values(value || {})
    .map((item) => ({ ...item, byStatus: sortReasonCounts(item.byStatus), byReason: sortReasonCounts(item.byReason) }))
    .sort((a, b) => b.rawCandidates - a.rawCandidates || a.channelName.localeCompare(b.channelName));
}

function addCaseSample(target, reason, detailAudit, songAudit) {
  const key = stringValue(reason) || "unknown";
  if (!target[key]) target[key] = [];
  if (target[key].length >= 8) return;
  const song = songAudit?.song || {};
  target[key].push({
    inputDir: detailAudit.inputDir,
    videoId: detailAudit.videoId,
    url: detailAudit.videoId ? `https://www.youtube.com/watch?v=${detailAudit.videoId}${Number.isFinite(Number(song.seconds)) ? `&t=${Math.max(0, Number(song.seconds) || 0)}s` : ""}` : "",
    channelName: detailAudit.channelName,
    status: songAudit?.status || detailAudit.status,
    seconds: Number.isFinite(Number(song.seconds)) ? Math.max(0, Number(song.seconds) || 0) : null,
    title: stringValue(song.title || detailAudit.title),
    artist: stringValue(song.artist),
    raw: stringValue(song.raw),
  });
}

function sortCaseSamples(value) {
  return Object.fromEntries(Object.entries(value || {}).sort((a, b) => a[0].localeCompare(b[0])));
}

function compactSuspiciousAuditItem(detailAudit) {
  const songs = (detailAudit.songs || [])
    .filter((song) => song.status === "suspicious" || song.status === "failed")
    .map((song) => ({
      status: song.status,
      reasons: song.reasons,
      time: song.song.time,
      seconds: song.song.seconds,
      title: song.song.title,
      artist: song.song.artist,
      raw: song.song.raw,
      rawHash: song.song.rawHash,
    }));
  if (detailAudit.status !== "failed" && !songs.length) return null;
  return {
    inputDir: detailAudit.inputDir,
    videoId: detailAudit.videoId,
    title: detailAudit.title,
    channelName: detailAudit.channelName,
    thumbnailUrl: detailAudit.thumbnailUrl,
    channelAvatarUrl: detailAudit.channelAvatarUrl,
    status: detailAudit.status,
    reasons: detailAudit.reasons,
    rawSongCandidateCount: detailAudit.rawSongCandidateCount,
    acceptedSongCount: detailAudit.acceptedSongCount,
    suspiciousSongCount: detailAudit.suspiciousSongCount,
    failedSongCount: detailAudit.failedSongCount,
    songs,
  };
}

function addReasonCount(target, reason) {
  const key = stringValue(reason) || "unknown";
  target[key] = (target[key] || 0) + 1;
}

function sortReasonCounts(value) {
  return Object.fromEntries(Object.entries(value || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function loadImportAuditExceptions(filePath = DEFAULT_IMPORT_AUDIT_EXCEPTIONS_PATH, inlinePayload = null, options = {}) {
  if (inlinePayload) return normalizeImportAuditExceptions(inlinePayload);
  if (options.requireFile && !fs.existsSync(filePath)) throw new Error(`audit exceptions file not found: ${filePath}`);
  const payload = readJsonIfExists(filePath) || {};
  return normalizeImportAuditExceptions(payload);
}

function normalizeImportAuditExceptions(payload) {
  return {
    accepted: normalizeExceptionRecords(payload.accepted || payload.allow || payload.allowed),
    rejected: normalizeExceptionRecords(payload.rejected || payload.reject || payload.denied),
  };
}

function normalizeExceptionRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record, index) => ({
      id: stringValue(record.id || record.exceptionId || `exception-${index + 1}`),
      videoId: stringValue(record.videoId),
      rawHash: stringValue(record.rawHash),
      seconds: Number.isFinite(Number(record.seconds)) ? Math.max(0, Number(record.seconds)) : null,
      title: stringValue(record.title),
      artist: stringValue(record.artist),
      reviewedBy: stringValue(record.reviewedBy),
      reviewedAt: stringValue(record.reviewedAt),
      reason: stringValue(record.reason),
    }))
    .filter((record) => record.reason && record.reviewedBy && (record.rawHash || record.title || record.videoId));
}

function findAuditException(kind, song, context) {
  const videoId = String(context.videoId || "").trim();
  return (context.auditExceptions?.[kind] || []).find((record) => {
    if (record.videoId && record.videoId !== videoId) return false;
    if (record.rawHash && record.rawHash === stringValue(song.rawHash)) return true;
    if (record.seconds != null && record.seconds !== Math.max(0, Number(song.seconds) || 0)) return false;
    if (record.title && normalizeAuditKey(record.title) !== normalizeAuditKey(song.title)) return false;
    if (record.artist && normalizeAuditKey(record.artist) !== normalizeAuditKey(song.artist)) return false;
    return Boolean(record.title || record.artist);
  }) || null;
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function filterNonRegressiveImports(catalog, videos) {
  const previousByVideoId = new Map((catalog.videos || []).map((entry) => [entry.videoId, entry]));
  const kept = [];
  const stats = {
    skippedExistingRegressions: 0,
    skippedExistingRegressionVideoIds: [],
  };
  for (const video of videos) {
    const previous = previousByVideoId.get(video.videoId);
    if (previous && isStrictSongSubset(previous.songs, video.songs)) {
      stats.skippedExistingRegressions += 1;
      stats.skippedExistingRegressionVideoIds.push(video.videoId);
      continue;
    }
    kept.push(video);
  }
  stats.skippedExistingRegressionVideoIds.sort();
  return { videos: kept, stats };
}

function isStrictSongSubset(previousSongs, incomingSongs) {
  const previousKeys = new Set((previousSongs || []).map(songKey).filter(Boolean));
  const incomingKeys = new Set((incomingSongs || []).map(songKey).filter(Boolean));
  if (!previousKeys.size || !incomingKeys.size) return false;
  let missing = 0;
  for (const key of previousKeys) {
    if (!incomingKeys.has(key)) missing += 1;
  }
  return missing > 0;
}

function songKey(song) {
  const seconds = Math.max(0, Number(song?.seconds) || 0);
  return [
    seconds,
    normalizeIdentity(song?.title),
    normalizeIdentity(song?.artist),
    normalizeIdentity(song?.rawHash || song?.raw),
  ].join("::");
}

function normalizeIdentity(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeAuditKey(value) {
  return normalizeIdentity(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function isUnknownArtist(value) {
  return UNKNOWN_ARTIST_VALUES.has(normalizeIdentity(value));
}

function incrementCount(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function normalizeImportedVideo(detail, inputDir, songs) {
  const videoId = String(detail.videoId || "").trim();
  return {
    videoId,
    title: stringValue(detail.title),
    channelName: stringValue(detail.channelName),
    channelId: stringValue(detail.channelId),
    channelHandle: stringValue(detail.channelHandle),
    channelUrl: stringValue(detail.channelUrl || detail.discoveryChannelUrl),
    channelAvatarUrl: stringValue(detail.channelAvatarUrl || detail.channelThumbnailUrl),
    channelThumbnailUrl: stringValue(detail.channelThumbnailUrl || detail.channelAvatarUrl),
    publishedTimestamp: finiteTimestamp(detail.publishedTimestamp),
    publishedText: stringValue(detail.publishedText),
    durationText: stringValue(detail.durationText),
    thumbnailUrl: stringValue(detail.thumbnailUrl) || fallbackThumbnailUrl(videoId),
    sourceGroups: uniqueValues([SOURCE_GROUP, ...listValues(detail.sourceGroups), detail.sourceGroup]),
    sourceUrls: uniqueValues([
      ...listValues(detail.sourceUrls),
      ...listValues(detail.discoverySourceUrls),
      stringValue(detail.sourceUrl),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]),
    selectedSourceId: stringValue(detail.selectedSourceId || detail.sourceQuality?.sourceId),
    selectedSourceHash: stringValue(detail.selectedSourceHash || detail.sourceQuality?.sourceHash),
    songs: songs.map((song, index) => ({
      index: index + 1,
      time: stringValue(song.time),
      seconds: Math.max(0, Number(song.seconds) || 0),
      title: stringValue(song.title),
      artist: stringValue(song.artist),
      raw: stringValue(song.raw),
      rawHash: stringValue(song.rawHash),
      originalTitle: stringValue(song.originalTitle),
      originalArtist: stringValue(song.originalArtist),
      alias: song.alias && typeof song.alias === "object" ? song.alias : undefined,
      artistBackfill: song.artistBackfill && typeof song.artistBackfill === "object" ? song.artistBackfill : undefined,
      sourceId: stringValue(song.sourceId || detail.selectedSourceId || detail.sourceQuality?.sourceId),
      sourceHash: stringValue(song.sourceHash || detail.selectedSourceHash || detail.sourceQuality?.sourceHash),
      isNiche: song.isNiche === true,
    })),
    lastInspectedAt: stringValue(detail.lastInspectedAt || detail.updatedAt) || new Date().toISOString(),
    qualityStatus: "usable",
    discoveryImport: {
      sourceGroup: SOURCE_GROUP,
      inputDir: projectRelativePath(inputDir),
      discoverySingerName: stringValue(detail.discoverySingerName),
      discoveryChannelUrl: stringValue(detail.discoveryChannelUrl),
      matchedKeywords: listValues(detail.matchedKeywords).map((value) => stringValue(value)).filter(Boolean),
    },
  };
}

function fallbackThumbnailUrl(videoId) {
  return /^[A-Za-z0-9_-]{11}$/u.test(String(videoId || "")) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function isImportableSong(song) {
  return Boolean(song?.title) && !isLikelyNonSongEntry(song);
}

function projectRelativePath(value) {
  const absolutePath = path.resolve(ROOT, String(value || ""));
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.replace(/\\/gu, "/");
  }
  return absolutePath.replace(/\\/gu, "/");
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === false) return [];
  return [value];
}

function uniqueValues(values) {
  return [...new Set(listValues(values).map((value) => stringValue(value)).filter(Boolean))];
}

function stringValue(value) {
  return String(value || "").trim();
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function quoteForMarker(value) {
  return JSON.stringify(String(value || ""));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE_GROUP,
  filterNonRegressiveImports,
  inputDirsFromArgs,
  isImportableSong,
  isStrictSongSubset,
  normalizeImportedVideo,
  projectRelativePath,
  readDiscoveryVideos,
  fallbackThumbnailUrl,
};
