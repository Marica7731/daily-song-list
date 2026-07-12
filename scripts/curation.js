const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const OVERRIDES_PATH = path.join(CONFIG_DIR, "curation-overrides.json");
const NON_SONG_RULES_PATH = path.join(CONFIG_DIR, "non-song-rules.json");
const UNKNOWN_ARTIST_RE = /^(?:未記載|未记载|待补歌手|待補歌手|待补|待補)$/u;
const VALID_ACTIONS = new Set(["drop_entry", "replace_entry", "reject_source", "drop_video", "force_keep"]);
const ENTRY_ACTIONS = new Set(["drop_entry", "replace_entry", "force_keep"]);
const SOURCE_ACTIONS = new Set(["reject_source"]);

function loadCurationContext(options = {}) {
  const nonSongRules = normalizeNonSongRules(readJsonIfExists(options.nonSongRulesPath || NON_SONG_RULES_PATH) || {});
  const overrides = normalizeOverrides(readJsonIfExists(options.overridesPath || OVERRIDES_PATH) || { schemaVersion: 1, records: [] });
  const validation = validateCurationOverrides(overrides);
  if (validation.errors.length) {
    const message = validation.errors.map((error) => `- ${error}`).join("\n");
    throw new Error(`Invalid curation overrides:\n${message}`);
  }
  const curationHash = hashNormalizedText(
    JSON.stringify({
      nonSongRules,
      records: overrides.records,
    }),
  );
  return {
    version: `curation-v1:${curationHash.slice(0, 12)}`,
    hash: curationHash,
    nonSongRules,
    overrides,
  };
}

function normalizeNonSongRules(rules) {
  return {
    schemaVersion: Number(rules.schemaVersion) || 1,
    exactUnknownArtistTitles: uniqueNormalizedTitles(rules.exactUnknownArtistTitles),
    candidateActivityTitles: uniqueNormalizedTitles(rules.candidateActivityTitles),
    channelScopedExactTitles: Array.isArray(rules.channelScopedExactTitles) ? rules.channelScopedExactTitles : [],
    channelScopedPatterns: Array.isArray(rules.channelScopedPatterns) ? rules.channelScopedPatterns : [],
  };
}

function normalizeOverrides(value) {
  if (Array.isArray(value)) return { schemaVersion: 1, records: value.map(normalizeOverrideRecord) };
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    records: Array.isArray(value.records) ? value.records.map(normalizeOverrideRecord) : [],
  };
}

function normalizeOverrideRecord(record) {
  const action = String(record?.action || "").trim();
  const seconds = record?.seconds === "" || record?.seconds == null ? null : Number(record.seconds);
  return {
    action,
    videoId: String(record?.videoId || "").trim(),
    sourceId: String(record?.sourceId || "").trim(),
    sourceHash: String(record?.sourceHash || "").trim(),
    seconds: Number.isInteger(seconds) ? seconds : seconds,
    rawHash: String(record?.rawHash || "").trim(),
    replacement: record?.replacement && typeof record.replacement === "object" ? normalizeReplacement(record.replacement) : undefined,
    reason: String(record?.reason || "").trim(),
    note: String(record?.note || "").trim(),
    reviewedAt: String(record?.reviewedAt || "").trim(),
    reviewedBy: String(record?.reviewedBy || "").trim(),
  };
}

function normalizeReplacement(replacement) {
  const result = {};
  if ("title" in replacement) result.title = String(replacement.title || "").trim();
  if ("artist" in replacement) result.artist = String(replacement.artist || "").trim();
  if ("seconds" in replacement) result.seconds = Number(replacement.seconds);
  return result;
}

function validateCurationOverrides(value) {
  const overrides = normalizeOverrides(value);
  const errors = [];
  const seen = new Map();
  if (overrides.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const [index, record] of overrides.records.entries()) {
    const label = `records[${index}]`;
    if (!VALID_ACTIONS.has(record.action)) errors.push(`${label}.action invalid: ${record.action || "(missing)"}`);
    if (!isValidVideoId(record.videoId)) errors.push(`${label}.videoId invalid or missing`);
    if (ENTRY_ACTIONS.has(record.action)) {
      if (!record.sourceId && !record.sourceHash) errors.push(`${label} must include sourceId or sourceHash`);
      if (!Number.isInteger(record.seconds) || record.seconds < 0) errors.push(`${label}.seconds must be a non-negative integer`);
      if (!record.rawHash) errors.push(`${label}.rawHash missing`);
    }
    if (SOURCE_ACTIONS.has(record.action) && !record.sourceId && !record.sourceHash) {
      errors.push(`${label} must include sourceId or sourceHash`);
    }
    if (record.action === "replace_entry") {
      if (!record.replacement || typeof record.replacement !== "object") {
        errors.push(`${label}.replacement missing`);
      } else {
        const hasTitle = "title" in record.replacement && record.replacement.title;
        const hasArtist = "artist" in record.replacement && record.replacement.artist;
        const hasSeconds = "seconds" in record.replacement && Number.isInteger(record.replacement.seconds) && record.replacement.seconds >= 0;
        if (!hasTitle && !hasArtist && !hasSeconds) errors.push(`${label}.replacement must set title, artist, or seconds`);
        if ("seconds" in record.replacement && !hasSeconds) errors.push(`${label}.replacement.seconds invalid`);
      }
    }
    if (record.reviewedAt && Number.isNaN(Date.parse(record.reviewedAt))) errors.push(`${label}.reviewedAt invalid`);

    const key = overrideConflictKey(record);
    if (key) {
      const previous = seen.get(key);
      const fingerprint = stableRecordFingerprint(record);
      if (previous && previous !== fingerprint) errors.push(`${label} conflicts with another override for ${key}`);
      else seen.set(key, fingerprint);
    }
  }
  return { valid: errors.length === 0, errors, overrides };
}

function overrideConflictKey(record) {
  if (!record.action || !record.videoId) return "";
  const sourceKey = record.sourceId || `hash:${record.sourceHash || ""}`;
  if (record.action === "drop_video") return `video:${record.videoId}`;
  if (record.action === "reject_source") return `source:${record.videoId}:${sourceKey}`;
  if (!sourceKey || !Number.isInteger(record.seconds) || !record.rawHash) return "";
  return `entry:${record.videoId}:${sourceKey}:${record.seconds}:${record.rawHash}`;
}

function stableRecordFingerprint(record) {
  return JSON.stringify({
    action: record.action,
    videoId: record.videoId,
    sourceId: record.sourceId,
    sourceHash: record.sourceHash,
    seconds: record.seconds,
    rawHash: record.rawHash,
    replacement: record.replacement || null,
  });
}

function mergeCurationPatch(existingValue, patchValue) {
  const existing = normalizeOverrides(existingValue);
  const patch = normalizeOverrides(patchValue);
  const patchValidation = validateCurationOverrides(patch);
  if (patchValidation.errors.length) {
    return { ok: false, errors: patchValidation.errors, merged: existing, counts: emptyMergeCounts() };
  }

  const records = [...existing.records];
  const byKey = new Map();
  for (const [index, record] of records.entries()) byKey.set(overrideConflictKey(record), { index, record });

  const counts = emptyMergeCounts();
  const conflicts = [];
  for (const record of patch.records) {
    const key = overrideConflictKey(record);
    const found = byKey.get(key);
    if (!found) {
      byKey.set(key, { index: records.length, record });
      records.push(record);
      counts.added += 1;
      continue;
    }
    const currentFingerprint = stableRecordFingerprint(found.record);
    const nextFingerprint = stableRecordFingerprint(record);
    if (currentFingerprint === nextFingerprint) {
      counts.ignored += 1;
      continue;
    }
    if (found.record.action !== record.action) {
      conflicts.push(key);
      counts.conflicts += 1;
      continue;
    }
    records[found.index] = {
      ...found.record,
      ...record,
      note: record.note || found.record.note,
      reviewedAt: record.reviewedAt || found.record.reviewedAt,
      reviewedBy: record.reviewedBy || found.record.reviewedBy,
    };
    counts.updated += 1;
  }

  const merged = { schemaVersion: 1, records };
  const mergedValidation = validateCurationOverrides(merged);
  const errors = [...conflicts.map((key) => `conflicting patch override: ${key}`), ...mergedValidation.errors];
  return { ok: errors.length === 0, errors, merged, counts };
}

function emptyMergeCounts() {
  return { added: 0, updated: 0, ignored: 0, conflicts: 0 };
}

function createSourceRecord({ videoId, sourceType, text, commentId = "", authorName = "", index = 0 }) {
  const sourceHash = hashNormalizedText(text);
  const normalizedSourceType = String(sourceType || "unknown").trim() || "unknown";
  const stableCommentId = String(commentId || "").trim();
  let sourceId = stableCommentId;
  if (!sourceId && normalizedSourceType === "description") sourceId = `description:${videoId}:${sourceHash.slice(0, 16)}`;
  if (!sourceId) sourceId = `${normalizedSourceType}:${sourceHash}`;
  return {
    sourceId,
    sourceType: normalizedSourceType,
    commentId: stableCommentId,
    authorName: String(authorName || "").trim(),
    sourceHash,
    sourceIndex: index,
    text: String(text || ""),
  };
}

function normalizeSourceText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function hashNormalizedText(text) {
  return crypto.createHash("sha256").update(normalizeSourceText(text), "utf8").digest("hex");
}

function normalizeCurationTitle(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\s\u3000]+/gu, "")
    .trim();
}

function uniqueNormalizedTitles(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeCurationTitle).filter(Boolean))];
}

function isUnknownArtist(artist) {
  const value = String(artist || "").trim();
  return !value || UNKNOWN_ARTIST_RE.test(value);
}

function isActivityMarkerTitle(title, artist, rules = loadNonSongRulesSafe()) {
  if (!isUnknownArtist(artist)) return false;
  const normalizedTitle = normalizeCurationTitle(title);
  return rules.exactUnknownArtistTitles.includes(normalizedTitle);
}

function isCandidateActivityTitle(title, rules = loadNonSongRulesSafe()) {
  const normalizedTitle = normalizeCurationTitle(title);
  return rules.exactUnknownArtistTitles.includes(normalizedTitle) || rules.candidateActivityTitles.includes(normalizedTitle);
}

function applyCurationToSources(sources, context, candidate = {}) {
  const overrides = context?.overrides?.records || [];
  const result = [];
  const stats = { droppedEntries: 0, replacedEntries: 0, rejectedSources: 0, forceKeptEntries: 0 };
  for (const source of sources || []) {
    if (matchesAnyOverride(overrides, "reject_source", { videoId: candidate.videoId, source })) {
      stats.rejectedSources += 1;
      continue;
    }
    const songs = [];
    for (const song of source.songs || []) {
      const matchContext = { videoId: candidate.videoId, source, song };
      if (matchesAnyOverride(overrides, "drop_entry", matchContext)) {
        stats.droppedEntries += 1;
        continue;
      }
      const replacement = findOverride(overrides, "replace_entry", matchContext);
      if (replacement) {
        stats.replacedEntries += 1;
        songs.push(applyReplacement(song, replacement.replacement));
        continue;
      }
      const forceKeep = findOverride(overrides, "force_keep", matchContext);
      if (forceKeep) {
        stats.forceKeptEntries += 1;
        songs.push({ ...song, forceKept: true });
        continue;
      }
      songs.push(song);
    }
    if (songs.length) {
      result.push({
        ...source,
        songs,
        stats: recomputeSourceStats(source.stats, songs),
      });
    }
  }
  result.curationStats = stats;
  return result;
}

function applyCurationToVideos(videos, context) {
  const overrides = context?.overrides?.records || [];
  const stats = { droppedVideos: 0, droppedEntries: 0, replacedEntries: 0, forceRefreshVideoIds: collectForceRefreshVideoIds(context).size };
  const result = [];
  for (const video of videos || []) {
    if (matchesAnyOverride(overrides, "drop_video", { videoId: video.videoId })) {
      stats.droppedVideos += 1;
      continue;
    }
    if (video.carriedFromPrevious && hasRejectSourceOverride(context, video.videoId)) {
      stats.droppedVideos += 1;
      continue;
    }
    const source = {
      sourceId: video.selectedSourceId || video.sourceId || "",
      sourceHash: video.selectedSourceHash || video.sourceHash || "",
    };
    const songs = [];
    for (const song of video.songs || []) {
      const enriched = {
        ...song,
        sourceId: song.sourceId || source.sourceId,
        sourceHash: song.sourceHash || source.sourceHash,
        rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || song.seconds || ""} ${song.title || ""}`),
      };
      const matchContext = { videoId: video.videoId, source, song: enriched };
      if (matchesAnyOverride(overrides, "drop_entry", matchContext)) {
        stats.droppedEntries += 1;
        continue;
      }
      const replacement = findOverride(overrides, "replace_entry", matchContext);
      if (replacement) {
        stats.replacedEntries += 1;
        songs.push(applyReplacement(enriched, replacement.replacement));
        continue;
      }
      songs.push(enriched);
    }
    if (songs.length) result.push({ ...video, songs });
  }
  result.curationStats = stats;
  return result;
}

function applyReplacement(song, replacement = {}) {
  const next = { ...song };
  if ("title" in replacement && replacement.title) next.title = replacement.title;
  if ("artist" in replacement) next.artist = replacement.artist;
  if ("seconds" in replacement && Number.isInteger(replacement.seconds) && replacement.seconds >= 0) {
    next.seconds = replacement.seconds;
    next.time = secondsToTime(replacement.seconds);
  }
  return next;
}

function recomputeSourceStats(stats, songs) {
  if (!stats) return stats;
  const artistCount = songs.filter((song) => !isUnknownArtist(song.artist)).length;
  const unknownArtistCount = songs.length - artistCount;
  const activityMarkerCount = songs.filter((song) => isCandidateActivityTitle(song.title)).length;
  const nicheCount = songs.filter((song) => song.isNiche === true).length;
  return {
    ...stats,
    keptCount: songs.length,
    artistCount,
    artistRatio: songs.length ? artistCount / songs.length : 0,
    unknownArtistCount,
    unknownArtistRatio: songs.length ? unknownArtistCount / songs.length : 0,
    activityMarkerCount,
    activityMarkerRatio: songs.length ? activityMarkerCount / songs.length : 0,
    nicheCount,
    nicheRatio: songs.length ? nicheCount / songs.length : 0,
  };
}

function findOverride(records, action, context) {
  return (records || []).find((record) => record.action === action && matchesOverride(record, context)) || null;
}

function matchesAnyOverride(records, action, context) {
  return Boolean(findOverride(records, action, context));
}

function matchesOverride(record, { videoId, source = {}, song = {} }) {
  if (record.videoId !== videoId) return false;
  if (record.action === "drop_video") return true;
  if (record.sourceId && record.sourceId !== source.sourceId && record.sourceId !== song.sourceId) return false;
  if (record.sourceHash && record.sourceHash !== source.sourceHash && record.sourceHash !== song.sourceHash) return false;
  if (ENTRY_ACTIONS.has(record.action)) {
    if (Number.isInteger(record.seconds) && record.seconds !== song.seconds) return false;
    if (record.rawHash && record.rawHash !== song.rawHash) return false;
  }
  return true;
}

function collectForceRefreshVideoIds(context) {
  const ids = new Set();
  for (const record of context?.overrides?.records || []) {
    if (record.action === "reject_source" && record.videoId) ids.add(record.videoId);
  }
  return ids;
}

function hasRejectSourceOverride(context, videoId) {
  return (context?.overrides?.records || []).some((record) => record.action === "reject_source" && record.videoId === videoId);
}

function entryRiskReasons({ song, knownSongMatcher, sourceStats = {} }) {
  const reasons = [];
  const title = String(song?.title || "");
  const artist = String(song?.artist || "");
  const knownSong = knownSongMatcher ? knownSongMatcher(song) : false;
  if (song?.isNiche === true && isUnknownArtist(artist)) reasons.push("niche_unknown_artist");
  if (isCandidateActivityTitle(title)) reasons.push("activity_marker_title");
  if (normalizeCurationTitle(title).length <= 4 && !knownSong) reasons.push("short_unknown_title");
  if (isUnknownArtist(artist) && sourceStats.unknownArtistCount >= 3) reasons.push("source_multiple_unknown_artists");
  if (song?.isNiche === true && normalizeCurationTitle(title).length <= 8 && sourceStats.nicheCount >= 3) {
    reasons.push("source_multiple_niche_short_titles");
  }
  return reasons;
}

function sourceRiskReasons(source, knownSongMatcher) {
  const stats = source.stats || source;
  const reasons = [];
  if ((stats.unknownArtistRatio || 0) >= 0.75 && (stats.keptCount || 0) >= 4) reasons.push("source_unknown_artist_ratio_high");
  if ((stats.activityMarkerRatio || 0) >= 0.15 && (stats.activityMarkerCount || 0) >= 1) reasons.push("source_activity_marker_ratio_high");
  if ((stats.topicCount || 0) >= 3) reasons.push("source_many_topic_entries");
  if ((stats.activityMarkerCount || 0) >= 3) reasons.push("source_many_activity_entries");
  if ((stats.suspiciousEntryCount || 0) > Math.max(2, (stats.knownSongCount || 0) * 2)) reasons.push("suspicious_rows_exceed_known_songs");
  if ((stats.keptCount || 0) >= 8 && (stats.knownSongCount || 0) <= 1 && (stats.artistCount || 0) <= 1) {
    reasons.push("kept_count_high_low_known_song_density");
  }
  for (const song of source.songs || []) reasons.push(...entryRiskReasons({ song, knownSongMatcher, sourceStats: stats }));
  return [...new Set(reasons)];
}

function riskScoreFromReasons(reasons, stats = {}) {
  let score = 0;
  for (const reason of reasons || []) {
    if (/activity|exceed|low_known|ratio_high/.test(reason)) score += 28;
    else if (/multiple|topic|niche/.test(reason)) score += 18;
    else score += 10;
  }
  score += Math.min(25, (stats.activityMarkerCount || 0) * 8);
  score += Math.min(20, (stats.unknownArtistCount || 0) * 2);
  return Math.min(100, score);
}

function riskLevel(score) {
  if (score >= 70) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function secondsToTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isValidVideoId(videoId) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(videoId || ""));
}

function loadNonSongRulesSafe() {
  return normalizeNonSongRules(readJsonIfExists(NON_SONG_RULES_PATH) || {});
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  CONFIG_DIR,
  NON_SONG_RULES_PATH,
  OVERRIDES_PATH,
  VALID_ACTIONS,
  applyCurationToSources,
  applyCurationToVideos,
  collectForceRefreshVideoIds,
  createSourceRecord,
  entryRiskReasons,
  hashNormalizedText,
  hasRejectSourceOverride,
  isActivityMarkerTitle,
  isCandidateActivityTitle,
  isUnknownArtist,
  loadCurationContext,
  mergeCurationPatch,
  normalizeCurationTitle,
  normalizeOverrides,
  riskLevel,
  riskScoreFromReasons,
  sourceRiskReasons,
  validateCurationOverrides,
};
