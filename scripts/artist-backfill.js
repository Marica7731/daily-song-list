const { isUnknownArtist } = require("./curation");
const { canonicalizeSongIdentity, loadSongAliasContext } = require("./song-aliases");
const { loadSupplementalKnownSongs } = require("./song-search-index");
const {
  cleanText,
  normalizeArtistKey,
  normalizeSongTitleKey,
  normalizeSongWorkTitle,
  songWorkTitleKey,
} = require("../assets/ranking-utils");

const CREDIT_SEPARATOR_RE = /[\/／|｜￤∣丨]/u;
const BACKFILL_SCHEMA_VERSION = 1;

function backfillMissingArtistsInPayload(payload, options = {}) {
  if (!payload?.groups) return payload;
  const videos = collectPayloadVideos(payload);
  const context = createArtistBackfillContext({ ...options, corpusVideos: options.corpusVideos || videos });
  let combinedStats = createBackfillStats();
  const groups = Object.fromEntries(
    Object.entries(payload.groups || {}).map(([groupId, group]) => {
      const result = backfillMissingArtistsInVideos(group.items || [], { ...options, context });
      combinedStats = mergeBackfillStats(combinedStats, result.artistBackfillStats);
      return [
        groupId,
        {
          ...group,
          items: result,
        },
      ];
    }),
  );
  return attachBackfillSummary({ ...payload, groups }, combinedStats);
}

function backfillMissingArtistsInVideos(videos, options = {}) {
  const context = options.context || createArtistBackfillContext({ ...options, corpusVideos: options.corpusVideos || videos });
  const stats = createBackfillStats();
  const result = (videos || []).map((video) => {
    const songs = (video.songs || []).map((song) => backfillSongArtist(song, context, stats));
    return { ...video, songs };
  });
  result.artistBackfillStats = finalizeBackfillStats(stats);
  return result;
}

function createArtistBackfillContext(options = {}) {
  const aliasContext = options.aliasContext || loadSongAliasContext();
  const supplementalKnownSongs =
    options.supplementalKnownSongs === undefined ? loadSupplementalKnownSongs() : normalizeKnownSongRecords(options.supplementalKnownSongs);
  const candidatesByTitleKey = new Map();

  for (const record of supplementalKnownSongs || []) {
    addArtistCandidate(candidatesByTitleKey, record.title, record.artist, {
      reason: "supplemental_known_song",
      priority: 100,
      evidenceCount: 1,
    });
  }

  for (const video of options.corpusVideos || []) {
    for (const song of video.songs || []) {
      const canonical = canonicalizeSongIdentity(song, aliasContext);
      if (!isUnknownArtist(canonical?.artist)) {
        addArtistCandidate(candidatesByTitleKey, canonical.title, canonical.artist, {
          reason: "same_canonical_song_artist",
          priority: 60,
          evidenceCount: 1,
        });
        continue;
      }

      const rawCredit = extractReliableRawArtistCredit(canonical);
      if (rawCredit.artist) {
        addArtistCandidate(candidatesByTitleKey, rawCredit.title || canonical.title, rawCredit.artist, {
          reason: "source_context_raw_credit",
          priority: 90,
          evidenceCount: 1,
        });
      }
    }
  }

  return {
    aliasContext,
    candidatesByTitleKey,
    supplementalKnownSongs,
  };
}

function backfillSongArtist(song, context, stats = createBackfillStats()) {
  stats.inputSongs += 1;
  const canonical = canonicalizeSongIdentity(song, context.aliasContext);
  if (!isUnknownArtist(canonical?.artist)) return canonical;

  stats.placeholderArtistSongs += 1;
  const directCredit = extractReliableRawArtistCredit(canonical);
  const candidate = directCredit.artist
    ? {
        artist: directCredit.artist,
        reason: "source_context_raw_credit",
        confidence: "high",
        evidenceCount: 1,
      }
    : resolveArtistCandidate(canonical, context);

  if (!candidate) {
    stats.unresolvedCount += 1;
    return canonical;
  }

  stats.filledCount += 1;
  incrementReason(stats.byReason, candidate.reason);
  const previousArtist = cleanText(canonical.artist);
  const repaired = canonicalizeSongIdentity(
    {
      ...canonical,
      artist: candidate.artist,
      artistBackfill: {
        schemaVersion: BACKFILL_SCHEMA_VERSION,
        changed: true,
        previousArtist,
        artist: candidate.artist,
        reason: candidate.reason,
        confidence: candidate.confidence,
        evidenceCount: candidate.evidenceCount || 1,
      },
      originalArtist: canonical.originalArtist || previousArtist,
    },
    context.aliasContext,
  );
  return repaired;
}

function resolveArtistCandidate(song, context) {
  const matches = [];
  for (const key of titleLookupKeys(song?.title)) {
    for (const candidate of context.candidatesByTitleKey.get(key) || []) {
      matches.push(candidate);
    }
  }
  if (!matches.length) return null;

  const byArtist = new Map();
  for (const match of matches) {
    const artistKey = normalizeArtistKey(match.artist);
    if (!artistKey) continue;
    const existing = byArtist.get(artistKey);
    if (!existing) {
      byArtist.set(artistKey, { ...match });
      continue;
    }
    existing.evidenceCount += match.evidenceCount || 1;
    existing.priority = Math.max(existing.priority, match.priority);
    existing.reason = mergeReasons(existing.reason, match.reason);
  }
  const ranked = [...byArtist.values()].sort(compareArtistCandidates);
  const winner = ranked[0];
  if (!winner) return null;
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.priority >= winner.priority && runnerUp.evidenceCount >= winner.evidenceCount) return null;
  return {
    artist: winner.artist,
    reason: winner.reason,
    confidence: winner.priority >= 90 ? "high" : winner.evidenceCount >= 2 ? "medium" : "low",
    evidenceCount: winner.evidenceCount,
  };
}

function addArtistCandidate(candidatesByTitleKey, title, artist, options = {}) {
  const cleanArtist = cleanText(artist);
  if (!cleanArtist || isUnknownArtist(cleanArtist) || isLikelyBadArtistCredit(cleanArtist)) return;
  for (const key of titleLookupKeys(title)) {
    if (!key) continue;
    if (!candidatesByTitleKey.has(key)) candidatesByTitleKey.set(key, []);
    candidatesByTitleKey.get(key).push({
      artist: cleanArtist,
      reason: options.reason || "same_canonical_song_artist",
      priority: Number(options.priority) || 50,
      evidenceCount: Number(options.evidenceCount) || 1,
    });
  }
}

function extractReliableRawArtistCredit(song) {
  const raw = cleanText(song?.raw).normalize("NFKC");
  const title = cleanText(song?.title).normalize("NFKC");
  if (!raw || !title || !CREDIT_SEPARATOR_RE.test(raw)) return { artist: "", title: "" };

  const parts = raw.split(CREDIT_SEPARATOR_RE);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const left = stripRawPrefix(parts[index]);
    const right = cleanRawArtistCredit(parts[index + 1]);
    if (!right || isUnknownArtist(right) || isLikelyBadArtistCredit(right)) continue;
    const leftKeys = titleLookupKeys(left);
    const songKeys = titleLookupKeys(title);
    if (leftKeys.some((leftKey) => songKeys.includes(leftKey) || songKeys.some((songKey) => leftKey.endsWith(songKey)))) {
      return { artist: right, title: left || title };
    }
  }
  return { artist: "", title: "" };
}

function titleLookupKeys(value) {
  const text = cleanText(value).normalize("NFKC");
  if (!text) return [];
  const candidates = new Set([text, normalizeSongWorkTitle(text).workTitle, stripDecorativeTitleSuffix(text), stripRawPrefix(text)]);
  const stripped = stripDecorativeTitleSuffix(stripRawPrefix(text));
  if (stripped) candidates.add(stripped);
  return [...candidates]
    .flatMap((candidate) => [normalizeSongTitleKey(candidate), songWorkTitleKey(candidate)])
    .filter(Boolean)
    .filter((key, index, values) => values.indexOf(key) === index);
}

function stripDecorativeTitleSuffix(value) {
  let text = cleanText(value).normalize("NFKC");
  const bracket = text.match(/^(.+?)\s*[(（［\[【「『]\s*([^()（）\[\]［］【】「」『』]{1,80})\s*[)）］\]】」』]\s*$/u);
  if (bracket && isDecorativeTitleSuffix(bracket[2])) text = bracket[1].trim();
  const separated = text.match(/^(.+?)\s*(?:[-ー–—|｜:：])\s*(.{1,80})\s*$/u);
  if (separated && isDecorativeTitleSuffix(separated[2])) text = separated[1].trim();
  return text;
}

function isDecorativeTitleSuffix(value) {
  const text = cleanText(value).normalize("NFKC");
  return /^(?:eng(?:lish)?\s*ver\.?|piano\s*ver\.?|bansanka|sunny|be\s+a\s+flower|hana\s+ni\s+natte|full|short|cover)$/iu.test(text) || /^[A-Za-z][A-Za-z0-9'’(),\-\s]{3,}$/u.test(text);
}

function stripRawPrefix(value) {
  return cleanText(value)
    .normalize("NFKC")
    .replace(/^[\[［【(（]?\s*\d{1,3}\s*[\]］】)）]?\s*/u, "")
    .replace(/^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*/u, "")
    .replace(/^\s*(?:[#＃]?\d{1,3}[.．、:：)）\]\-]|[①-⑳❶-❿⓵-⓾])\s*/u, "")
    .trim();
}

function cleanRawArtistCredit(value) {
  return cleanText(value)
    .normalize("NFKC")
    .replace(/\s+(?:19|20)\d{2}(?:[\/／.-]\d{1,2})?.*$/u, "")
    .replace(/\s*(?:[:：]_[^\s　:：]+[:：]?|←\s*NEW!?|NEW!)+\s*$/giu, "")
    .replace(/[」』】)\]）]+$/u, "")
    .trim();
}

function isLikelyBadArtistCredit(value) {
  const text = cleanText(value).normalize("NFKC");
  if (!text || text.length > 90) return true;
  if (!/[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(text)) return true;
  if (/(?:です|ます|でした|だった|して|する|したい|しよう|ください|理由|途中|可能性|報告|説明|紹介|コメント|リスナー|喉|病院|食べ物|飲み物|プレゼント|届きました)$/iu.test(text)) return true;
  if (/^(?:I|I'm|I’m|You|We|They|It|That|This|There|A|An|The|Why|What|When|Where|How|Can|Will|Was|Were|For|Those|Things|Still|Collaboration|Did|My)\b/u.test(text)) return true;
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length >= 5 && !/[一-龯ぁ-んァ-ヶ]/u.test(text) && !/(?:feat\.?|ft\.?|with|&|×|x)\s*[\p{Letter}\p{Number}]/iu.test(text)) return true;
  return false;
}

function collectPayloadVideos(payload) {
  const videos = [];
  for (const group of Object.values(payload?.groups || {})) videos.push(...(group.items || []));
  return videos;
}

function attachBackfillSummary(payload, stats) {
  const summary = finalizeBackfillStats(stats);
  return {
    ...payload,
    source: {
      ...(payload.source || {}),
      artistBackfill: summary,
    },
  };
}

function createBackfillStats() {
  return {
    schemaVersion: BACKFILL_SCHEMA_VERSION,
    inputSongs: 0,
    placeholderArtistSongs: 0,
    filledCount: 0,
    unresolvedCount: 0,
    byReason: {},
  };
}

function mergeBackfillStats(left, right = {}) {
  const result = createBackfillStats();
  result.inputSongs = (left.inputSongs || 0) + (right.inputSongs || 0);
  result.placeholderArtistSongs = (left.placeholderArtistSongs || 0) + (right.placeholderArtistSongs || 0);
  result.filledCount = (left.filledCount || 0) + (right.filledCount || 0);
  result.unresolvedCount = (left.unresolvedCount || 0) + (right.unresolvedCount || 0);
  result.byReason = { ...(left.byReason || {}) };
  for (const [reason, count] of Object.entries(right.byReason || {})) {
    result.byReason[reason] = (result.byReason[reason] || 0) + count;
  }
  return result;
}

function finalizeBackfillStats(stats) {
  return {
    schemaVersion: BACKFILL_SCHEMA_VERSION,
    inputSongs: Number(stats.inputSongs) || 0,
    placeholderArtistSongs: Number(stats.placeholderArtistSongs) || 0,
    filledCount: Number(stats.filledCount) || 0,
    unresolvedCount: Number(stats.unresolvedCount) || 0,
    byReason: Object.fromEntries(Object.entries(stats.byReason || {}).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function incrementReason(target, reason) {
  const key = cleanText(reason) || "unknown";
  target[key] = (target[key] || 0) + 1;
}

function compareArtistCandidates(left, right) {
  return right.priority - left.priority || right.evidenceCount - left.evidenceCount || left.artist.localeCompare(right.artist);
}

function mergeReasons(left, right) {
  return [...new Set([...(String(left || "").split("+")), ...(String(right || "").split("+"))].filter(Boolean))].sort().join("+");
}

function normalizeKnownSongRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => ({
      title: cleanText(record?.title),
      artist: cleanText(record?.artist),
    }))
    .filter((record) => record.title && record.artist);
}

module.exports = {
  backfillMissingArtistsInPayload,
  backfillMissingArtistsInVideos,
  backfillSongArtist,
  createArtistBackfillContext,
  extractReliableRawArtistCredit,
  titleLookupKeys,
};
