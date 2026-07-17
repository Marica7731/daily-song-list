const { normalizeArtistKey, normalizeSongTitleKey, songWorkTitleKey } = require("../../assets/ranking-utils");
const { rawHash, stableStringify } = require("../vsinger-moment/provenance");

const EXTERNAL_SYSTEM = "vsinger-moment.mcp-public";
const ADAPTER_VERSION = "vsinger-moment-adapter-v1";
const MATCHING_VERSION = "external-song-enrichment.v1";
const DEFAULT_FETCHED_AT = "1970-01-01T00:00:00.000Z";
const REVIEW_DECISIONS = new Set([
  "manual-curation-priority",
  "review-required",
  "rejected-version-conflict",
  "rejected-ambiguous-local-match",
  "external-only",
]);
const BLOCKED_AUTO_VERSION_PATTERN = /\b(remix|mashup|medley)\b|リミックス|マッシュアップ|メドレー/iu;
const VERSION_SUFFIX_PATTERN = /\b(piano\s*ver\.?|acoustic\s*ver\.?|live\s*ver\.?|remix|mashup|medley)\b|ピアノ|リミックス|マッシュアップ|メドレー/iu;
const YOUTUBE_ID_PATTERN = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/iu;
const YOUTUBE_ID_FALLBACK_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

function buildSongEnrichment(options = {}) {
  const now = options.now || new Date().toISOString();
  const externalSongs = normalizeExternalSongs(options.externalSongs || []);
  const localSongs = normalizeLocalSongs(options.localSongs || []);
  const manualCurationKeys = buildManualCurationKeys(options.manualCuration || []);
  const externalTitleConflicts = externalSameTitleDifferentArtists(externalSongs);
  const localByTitle = groupBy(localSongs, (song) => song.titleKey);
  const externalMatchedKeys = new Set();
  const localMatchedKeys = new Set();
  const autoAliases = [];
  const reviewCandidates = [];
  const knownSongCandidates = [];
  const conflictReport = [];

  for (const external of externalSongs) {
    const matches = findLocalMatches(external, localSongs).sort(compareMatch);
    const decision = decideIdentityCandidate({
      external,
      matches,
      externalTitleConflicts,
      manualCurationKeys,
    });
    const selectedMatch = matches[0] || null;
    const candidate = buildIdentityCandidate({
      external,
      local: selectedMatch ? selectedMatch.local : null,
      match: selectedMatch,
      decision,
      now,
    });

    if (selectedMatch) {
      externalMatchedKeys.add(external.identityKey);
      localMatchedKeys.add(selectedMatch.local.identityKey);
    }

    if (decision.decision === "auto-accept") {
      autoAliases.push(candidate);
      knownSongCandidates.push(buildKnownSongCandidate(candidate, now));
    } else {
      reviewCandidates.push(candidate);
    }

    conflictReport.push(...buildExternalConflictEntries(external, selectedMatch, decision, localByTitle.get(external.titleKey) || []));
  }

  for (const local of localSongs) {
    if (!localMatchedKeys.has(local.identityKey)) {
      conflictReport.push({
        type: "local_missing_external",
        title: local.title,
        artist: local.artist,
        localKey: local.identityKey,
        decision: "no-external-candidate",
      });
    }
  }

  return {
    schemaVersion: "external-song-enrichment.result.v1",
    generatedAt: now,
    externalSystem: EXTERNAL_SYSTEM,
    adapterVersion: ADAPTER_VERSION,
    matchingVersion: MATCHING_VERSION,
    summary: {
      externalSongCount: externalSongs.length,
      localSongCount: localSongs.length,
      automaticAliasCount: autoAliases.length,
      reviewCandidateCount: reviewCandidates.length,
      knownSongCandidateCount: knownSongCandidates.length,
      conflictCount: conflictReport.length,
    },
    automaticAliases: sortByStableIdentity(dedupeBy(autoAliases, (candidate) => candidate.provenance.externalId)),
    reviewCandidates: sortByStableIdentity(dedupeBy(reviewCandidates, (candidate) => `${candidate.provenance.externalId}:${candidate.decision}`)),
    knownSongCandidates: sortByStableIdentity(dedupeBy(knownSongCandidates, (candidate) => candidate.externalSongId)),
    conflictReport: conflictReport.sort(compareConflict),
  };
}

function buildVideoCandidates(options = {}) {
  const now = options.now || new Date().toISOString();
  const externalSongs = normalizeExternalSongs(options.externalSongs || []);
  const candidates = [];
  for (const external of externalSongs) {
    for (const report of extractVideoReports(external.raw)) {
      const videoId = extractYouTubeVideoId(report.youtubeUrl || report.videoId || report.url);
      if (!videoId) {
        continue;
      }
      candidates.push({
        videoId,
        externalSongId: external.externalSongId,
        reportedSongTitle: report.songTitle || report.title || external.title,
        reportedArtist: report.artist || report.originalArtist || external.artist,
        reportedSinger: report.singerName || report.singer || external.raw.singerName || null,
        reportedTimestamp: report.timestamp || report.time || null,
        sourceUrl: report.pageUrl || external.sourceUrl,
        fetchedAt: external.fetchedAt || now,
        verificationStatus: "unverified",
        provenance: buildProvenance(external, {
          decision: "video-candidate-unverified",
          confidence: 0.5,
        }),
      });
    }
  }
  return {
    schemaVersion: "external-video-candidates.v1",
    generatedAt: now,
    externalSystem: EXTERNAL_SYSTEM,
    adapterVersion: ADAPTER_VERSION,
    matchingVersion: MATCHING_VERSION,
    candidates: dedupeBy(candidates, (candidate) =>
      [candidate.videoId, candidate.externalSongId, candidate.reportedTimestamp || ""].join("::"),
    ).sort((a, b) =>
      compareValues(a.videoId, b.videoId) ||
      compareValues(a.externalSongId, b.externalSongId) ||
      compareValues(a.reportedTimestamp || "", b.reportedTimestamp || ""),
    ),
  };
}

function normalizeExternalSongs(records) {
  return (records || [])
    .map((record) => normalizeExternalSongRecord(record))
    .filter((record) => record.externalSongId && record.titleKey);
}

function normalizeExternalSongRecord(record) {
  const title = cleanText(record.title || record.songTitle || record.name);
  const artist = cleanText(record.artist || record.originalArtist || record.originalArtistName || record.artistName);
  const externalSongId = cleanText(record.externalSongId || record.songId || record.id || record.slug);
  const sourceUrl = cleanText(record.sourcePageUrl || record.pageUrl || record.url || record.sourceUrl) || null;
  const titleAliases = uniqueStrings([record.titleAliases, record.aliases, record.kanaTitle, record.romajiTitle]);
  const artistAliases = uniqueStrings([
    record.artistAliases,
    record.originalArtistAliases,
    record.artistKana,
    record.artistRomaji,
  ]);
  const titleKey = normalizeTitleKey(title);
  const artistKey = normalizeArtistKeySafe(artist);
  return {
    externalSongId,
    title,
    artist,
    titleAliases,
    artistAliases,
    titleKey,
    artistKey,
    sourceUrl,
    fetchedAt: cleanText(record.fetchedAt) || DEFAULT_FETCHED_AT,
    rawHash: cleanText(record.rawHash) || rawHash(record),
    raw: record,
    identityKey: identityKey(titleKey, artistKey),
  };
}

function normalizeLocalSongs(input) {
  return extractLocalSongRecords(input)
    .map((record) => normalizeLocalSongRecord(record))
    .filter((record) => record.titleKey);
}

function extractLocalSongRecords(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (Array.isArray(input && input.songs)) {
    return input.songs;
  }
  if (input && input.groups && typeof input.groups === "object") {
    const records = [];
    for (const group of Object.values(input.groups)) {
      for (const item of group.items || []) {
        for (const song of item.songs || []) {
          records.push({
            ...song,
            videoId: item.videoId,
            sourceGroup: group.id,
          });
        }
      }
    }
    return records;
  }
  return [];
}

function normalizeLocalSongRecord(record) {
  const title = cleanText(record.title || record.canonicalTitle || record.songTitle);
  const artist = cleanText(record.artist || record.canonicalArtist || record.originalArtist);
  const titleKey = normalizeTitleKey(title);
  const artistKey = normalizeArtistKeySafe(artist);
  return {
    title,
    artist,
    titleKey,
    artistKey,
    identityKey: identityKey(titleKey, artistKey),
    raw: record,
  };
}

function findLocalMatches(external, localSongs) {
  const externalTitleKeys = new Set([external.titleKey, ...external.titleAliases.map(normalizeTitleKey)].filter(Boolean));
  const externalArtistKeys = new Set([external.artistKey, ...external.artistAliases.map(normalizeArtistKeySafe)].filter(Boolean));
  const matches = [];
  for (const local of localSongs) {
    const titleMatches = externalTitleKeys.has(local.titleKey);
    const artistMatches = !externalArtistKeys.size || externalArtistKeys.has(local.artistKey);
    if (titleMatches && artistMatches) {
      const exactTitle = local.titleKey === external.titleKey;
      const exactArtist = local.artistKey === external.artistKey;
      matches.push({
        local,
        confidence: exactTitle && exactArtist ? 0.98 : exactTitle || exactArtist ? 0.93 : 0.9,
        matchingReason:
          exactTitle && exactArtist
            ? "exact-title-artist"
            : exactTitle
              ? "exact-title-artist-alias"
              : "title-alias-artist",
      });
    }
  }
  return matches;
}

function decideIdentityCandidate({ external, matches, externalTitleConflicts, manualCurationKeys }) {
  if (!matches.length) {
    return {
      decision: "external-only",
      confidence: 0.45,
      reason: "external-song-not-found-locally",
    };
  }
  if (matches.length > 1) {
    return {
      decision: "rejected-ambiguous-local-match",
      confidence: Math.max(...matches.map((match) => match.confidence)),
      reason: "multiple-local-candidates",
    };
  }
  const match = matches[0];
  const manualKey = identityKey(match.local.titleKey, match.local.artistKey);
  if (manualCurationKeys.has(manualKey)) {
    return {
      decision: "manual-curation-priority",
      confidence: match.confidence,
      reason: "manual-curation-already-controls-identity",
    };
  }
  if (externalTitleConflicts.has(external.titleKey)) {
    return {
      decision: "review-required",
      confidence: Math.min(match.confidence, 0.84),
      reason: "same-title-different-artist",
    };
  }
  if (hasBlockedVersionConflict(external.title, match.local.title)) {
    return {
      decision: "rejected-version-conflict",
      confidence: Math.min(match.confidence, 0.7),
      reason: "remix-mashup-medley-conflict",
    };
  }
  if (hasVersionSuffixDifference(external.title, match.local.title)) {
    return {
      decision: "review-required",
      confidence: Math.min(match.confidence, 0.82),
      reason: "version-suffix-difference",
    };
  }
  if (match.confidence >= 0.9) {
    return {
      decision: "auto-accept",
      confidence: match.confidence,
      reason: match.matchingReason,
    };
  }
  return {
    decision: "review-required",
    confidence: match.confidence,
    reason: "low-confidence",
  };
}

function buildIdentityCandidate({ external, local, match, decision, now }) {
  return {
    schemaVersion: "external-song-identity-candidate.v1",
    externalSongId: external.externalSongId,
    localTitle: local ? local.title : null,
    localArtist: local ? local.artist : null,
    canonicalTitleCandidate: external.title,
    canonicalArtistCandidate: external.artist || null,
    titleAliases: uniqueStrings([external.titleAliases, local ? local.title : null]).filter((value) => value !== external.title),
    artistAliases: uniqueStrings([external.artistAliases, local ? local.artist : null]).filter((value) => value !== external.artist),
    kanaRomajiCandidates: buildKanaRomajiCandidates(external),
    sourceUrl: external.sourceUrl,
    matchingReason: match ? match.matchingReason : decision.reason,
    confidence: roundConfidence(decision.confidence),
    decision: decision.decision,
    provenance: buildProvenance(external, {
      decision: decision.decision,
      confidence: roundConfidence(decision.confidence),
      fetchedAt: external.fetchedAt || now,
    }),
  };
}

function buildKnownSongCandidate(identityCandidate, now) {
  return {
    schemaVersion: "external-known-song-candidate.v1",
    title: identityCandidate.canonicalTitleCandidate,
    artist: identityCandidate.canonicalArtistCandidate,
    matchingReason: identityCandidate.matchingReason,
    confidence: identityCandidate.confidence,
    externalSongId: identityCandidate.externalSongId,
    sourceUrl: identityCandidate.sourceUrl,
    verifiedAt: null,
    generatedAt: now,
    provenance: {
      ...identityCandidate.provenance,
      decision: "known-song-candidate",
    },
  };
}

function buildProvenance(external, options = {}) {
  return {
    externalSystem: EXTERNAL_SYSTEM,
    externalId: external.externalSongId,
    sourceUrl: external.sourceUrl,
    fetchedAt: options.fetchedAt || external.fetchedAt || DEFAULT_FETCHED_AT,
    rawHash: external.rawHash,
    adapterVersion: ADAPTER_VERSION,
    matchingVersion: MATCHING_VERSION,
    decision: options.decision || "unknown",
    confidence: roundConfidence(options.confidence || 0),
  };
}

function buildExternalConflictEntries(external, selectedMatch, decision, localSameTitle) {
  const conflicts = [];
  if (!selectedMatch) {
    conflicts.push({
      type: "external_missing_local",
      externalSongId: external.externalSongId,
      title: external.title,
      artist: external.artist,
      sourceUrl: external.sourceUrl,
      decision: "review-required",
    });
    return conflicts;
  }
  const differentArtists = localSameTitle.filter((local) => local.artistKey && local.artistKey !== external.artistKey);
  if (differentArtists.length) {
    conflicts.push({
      type: "same_title_different_artist",
      externalSongId: external.externalSongId,
      title: external.title,
      externalArtist: external.artist,
      localArtists: differentArtists.map((local) => local.artist).sort(),
      decision: "manual-review-required",
    });
  }
  if (decision.reason === "same-title-different-artist") {
    conflicts.push({
      type: "same_title_different_artist",
      externalSongId: external.externalSongId,
      title: external.title,
      externalArtist: external.artist,
      localArtists: localSameTitle.map((local) => local.artist).sort(),
      decision: "manual-review-required",
    });
  }
  if (external.artistAliases.length) {
    conflicts.push({
      type: "artist_kana_romaji",
      externalSongId: external.externalSongId,
      artist: external.artist,
      aliases: external.artistAliases,
      decision: "candidate-only",
    });
  }
  if (decision.reason === "version-suffix-difference" || decision.reason === "remix-mashup-medley-conflict") {
    conflicts.push({
      type: "version_suffix_difference",
      externalSongId: external.externalSongId,
      externalTitle: external.title,
      localTitle: selectedMatch.local.title,
      decision: decision.decision,
    });
  }
  if (external.raw.conflict) {
    conflicts.push({
      type: "external_data_conflict",
      externalSongId: external.externalSongId,
      conflict: external.raw.conflict,
      decision: "manual-review-required",
    });
  }
  return conflicts;
}

function buildManualCurationKeys(records) {
  const keys = new Set();
  for (const record of records || []) {
    const title = record.title || record.canonicalTitle || record.songTitle;
    const artist = record.artist || record.canonicalArtist || record.originalArtist;
    const titleKey = normalizeTitleKey(title);
    if (!titleKey) {
      continue;
    }
    keys.add(identityKey(titleKey, normalizeArtistKeySafe(artist)));
  }
  return keys;
}

function externalSameTitleDifferentArtists(externalSongs) {
  const groups = groupBy(externalSongs, (song) => song.titleKey);
  const conflicts = new Set();
  for (const [titleKey, songs] of groups) {
    const artistKeys = new Set(songs.map((song) => song.artistKey).filter(Boolean));
    if (artistKeys.size > 1) {
      conflicts.add(titleKey);
    }
  }
  return conflicts;
}

function buildKanaRomajiCandidates(external) {
  return uniqueStrings([
    external.raw.artistKana,
    external.raw.artistRomaji,
    external.raw.kanaArtist,
    external.raw.romajiArtist,
    external.artistAliases,
  ]);
}

function extractVideoReports(raw) {
  const reports = [];
  if (raw.youtubeUrl || raw.videoId) {
    reports.push(raw);
  }
  for (const field of ["performances", "singingHistory", "streams", "setlist"]) {
    if (Array.isArray(raw[field])) {
      for (const item of raw[field]) {
        reports.push({
          ...item,
          songTitle: item.songTitle || item.title || raw.title || raw.songTitle,
          artist: item.artist || item.originalArtist || raw.artist || raw.originalArtist,
          pageUrl: item.pageUrl || raw.pageUrl || raw.sourcePageUrl,
        });
      }
    }
  }
  return reports;
}

function extractYouTubeVideoId(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }
  if (YOUTUBE_ID_FALLBACK_PATTERN.test(text)) {
    return text;
  }
  const match = text.match(YOUTUBE_ID_PATTERN);
  return match ? match[1] : null;
}

function hasBlockedVersionConflict(externalTitle, localTitle) {
  if (!BLOCKED_AUTO_VERSION_PATTERN.test(externalTitle) && !BLOCKED_AUTO_VERSION_PATTERN.test(localTitle)) {
    return false;
  }
  return normalizeTitleKey(externalTitle) !== normalizeTitleKey(localTitle) || cleanText(externalTitle) !== cleanText(localTitle);
}

function hasVersionSuffixDifference(externalTitle, localTitle) {
  const externalHasSuffix = VERSION_SUFFIX_PATTERN.test(externalTitle);
  const localHasSuffix = VERSION_SUFFIX_PATTERN.test(localTitle);
  if (!externalHasSuffix && !localHasSuffix) {
    return false;
  }
  return cleanText(externalTitle) !== cleanText(localTitle);
}

function normalizeTitleKey(value) {
  return songWorkTitleKey(value) || normalizeSongTitleKey(value);
}

function normalizeArtistKeySafe(value) {
  return normalizeArtistKey(value || "");
}

function identityKey(titleKey, artistKey) {
  return `${titleKey || ""}::${artistKey || ""}`;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flatMap((item) => (Array.isArray(item) ? item : [item]))) {
    const text = cleanText(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

function sortByStableIdentity(items) {
  return (items || []).slice().sort((a, b) =>
    compareValues(a.externalSongId, b.externalSongId) ||
    compareValues(a.canonicalTitleCandidate || a.title, b.canonicalTitleCandidate || b.title) ||
    compareValues(a.canonicalArtistCandidate || a.artist || "", b.canonicalArtistCandidate || b.artist || ""),
  );
}

function compareMatch(a, b) {
  return b.confidence - a.confidence || compareValues(a.local.identityKey, b.local.identityKey);
}

function compareConflict(a, b) {
  return compareValues(a.type, b.type) || compareValues(a.externalSongId || "", b.externalSongId || "") || compareValues(a.title || "", b.title || "");
}

function compareValues(a, b) {
  return String(a || "").localeCompare(String(b || ""), "ja");
}

function roundConfidence(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function assertNoRankingInputs(value, path = "external") {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["rank", "ranking", "score", "singingCount", "streamCount", "performanceCount", "viewCount"].includes(key)) {
      throw new Error(`${path}.${key} must not be exported as local ranking data`);
    }
    assertNoRankingInputs(child, `${path}.${key}`);
  }
}

module.exports = {
  ADAPTER_VERSION,
  EXTERNAL_SYSTEM,
  MATCHING_VERSION,
  REVIEW_DECISIONS,
  assertNoRankingInputs,
  buildKnownSongCandidate,
  buildProvenance,
  buildSongEnrichment,
  buildVideoCandidates,
  cleanText,
  extractLocalSongRecords,
  extractYouTubeVideoId,
  normalizeExternalSongRecord,
  normalizeExternalSongs,
  normalizeLocalSongs,
  stableStringify,
};
