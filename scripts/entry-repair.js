const fs = require("node:fs");
const path = require("node:path");
const { createSongSearchLookup, normalizeSongSearchText } = require("../assets/frontend-utils");
const { canonicalizeArtistName } = require("../assets/ranking-utils");
const STRICT_TITLE_ARTIST_DELIMITER = "\u2502";

const UNKNOWN_ARTIST = "未記載";
const ROOT = path.resolve(__dirname, "..");
const KNOWN_SONG_ARTIST_OVERRIDES_PATH = path.join(ROOT, "config", "known-song-artist-overrides.json");
const DELIMITER_CHARS = "/／|｜￤∣丨";
const BRACKET_PAIRS = [
  ["【", "】"],
  ["［", "］"],
  ["[", "]"],
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["(", ")"],
  ["{", "}"],
];
const BRACKET_OPEN = BRACKET_PAIRS.map(([open]) => open).join("");
const BRACKET_CLOSE = BRACKET_PAIRS.map(([, close]) => close).join("");
const BRACKET_CLOSE_BY_OPEN = new Map(BRACKET_PAIRS);

function repairParsedEntry(song, lookupInput = null) {
  if (!song || typeof song !== "object") return song;

  const lookup = normalizeLookup(lookupInput);
  const signals = entryRepairSignals(song);
  const repairs = [];
  let title = String(song.title || "").trim();
  let artist = normalizeArtist(song.artist);
  const raw = String(song.raw || "");

  const crossFieldWrapper = stripCrossFieldWrapper(title, artist);
  if (crossFieldWrapper.changed) {
    title = crossFieldWrapper.title;
    artist = cleanSafeArtistCandidate(crossFieldWrapper.artist) || UNKNOWN_ARTIST;
    repairs.push(...crossFieldWrapper.reasons);
  }

  const cleanedArtist = cleanSafeArtistCandidate(artist) || UNKNOWN_ARTIST;
  if (cleanedArtist !== artist) repairs.push("safe_artist_cleanup");
  artist = cleanedArtist;

  const cleanedTitle = cleanSafeTitleCandidate(title);
  if (cleanedTitle && cleanedTitle !== title) {
    title = cleanedTitle;
    repairs.push("safe_title_cleanup");
  }

  const parserCorruptionRepair = parserCorruptionTitleCandidate(song, title);
  if (parserCorruptionRepair && parserCorruptionRepair !== title) {
    title = parserCorruptionRepair;
    repairs.push("parser_corruption_title_restore");
  }

  const delimiterRepair = bestDelimiterRepairCandidate(song, lookup);
  const isStrictDelimiterRepair = delimiterRepair?.delimiter === STRICT_TITLE_ARTIST_DELIMITER;
  const shouldApplyCandidate = isStrictDelimiterRepair
    ? shouldApplyStrictDelimiterRepair(delimiterRepair)
    : shouldApplyDelimiterRepair(song, delimiterRepair, lookup);
  if (delimiterRepair && shouldApplyCandidate) {
    title = delimiterRepair.title;
    if (!isStrictDelimiterRepair || isUnknownArtist(artist)) artist = delimiterRepair.artist;
    repairs.push("delimiter_split");
  }

  const combinedRepair = bestCombinedTitleArtistCandidate(title, lookup);
  if (combinedRepair && isUnknownArtist(artist)) {
    title = combinedRepair.title;
    artist = combinedRepair.artist;
    repairs.push("combined_title_artist_lookup");
  }

  const knownArtist = findKnownSongArtistOverride(title, artist);
  if (knownArtist) {
    artist = knownArtist.artist;
    repairs.push("known_song_artist_override");
  }

  const known = songSearchRecognition({ title, artist }, lookup);
  return {
    ...song,
    title,
    artist,
    raw,
    repair: {
      changed: title !== String(song.title || "").trim() || artist !== normalizeArtist(song.artist),
      reasons: repairs,
      knownTitle: known.knownTitle,
      knownTitleArtist: known.knownTitleArtist,
    },
    curationSignals: signals,
  };
}

let knownSongArtistOverrideContext = null;

function loadKnownSongArtistOverrides(filePath = KNOWN_SONG_ARTIST_OVERRIDES_PATH) {
  if (filePath === KNOWN_SONG_ARTIST_OVERRIDES_PATH && knownSongArtistOverrideContext) return knownSongArtistOverrideContext;
  const config = readJsonIfExists(filePath) || { schemaVersion: 1, records: [] };
  const context = createKnownSongArtistOverrideContext(config);
  if (filePath === KNOWN_SONG_ARTIST_OVERRIDES_PATH) knownSongArtistOverrideContext = context;
  return context;
}

function createKnownSongArtistOverrideContext(config = {}) {
  const records = Array.isArray(config.records) ? config.records : [];
  const byTitleKey = new Map();
  const errors = [];

  if (Number(config.schemaVersion) !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(config.records)) errors.push("records must be array");
  for (const [index, record] of records.entries()) {
    const title = cleanConfigText(record?.title);
    const artist = cleanConfigText(record?.artist);
    const titleKey = normalizeSongSearchText(title);
    if (!title || !titleKey) errors.push(`records[${index}].title invalid`);
    if (!artist || isUnknownArtist(artist)) errors.push(`records[${index}].artist invalid`);
    if (record?.reviewedAt && Number.isNaN(Date.parse(record.reviewedAt))) errors.push(`records[${index}].reviewedAt invalid`);
    if (!titleKey || !artist) continue;
    const value = {
      title,
      artist,
      reason: cleanConfigText(record?.reason) || "high_confidence_artist_completion",
      reviewedAt: cleanConfigText(record?.reviewedAt),
      evidence: Array.isArray(record?.evidence) ? record.evidence.map(cleanConfigText).filter(Boolean) : [],
    };
    const existing = byTitleKey.get(titleKey);
    if (existing && existing.artist !== artist) {
      errors.push(`records[${index}] conflicts for ${title}`);
      continue;
    }
    byTitleKey.set(titleKey, value);
  }

  return { schemaVersion: Number(config.schemaVersion) || 1, records, byTitleKey, errors };
}

function validateKnownSongArtistOverrides(config = {}) {
  const context = createKnownSongArtistOverrideContext(config);
  return { errors: context.errors, context };
}

function findKnownSongArtistOverride(title, artist, context = loadKnownSongArtistOverrides()) {
  if (!isUnknownArtist(artist)) return null;
  const titleKey = normalizeSongSearchText(cleanSafeTitleCandidate(title));
  if (!titleKey) return null;
  return context?.byTitleKey?.get(titleKey) || null;
}

function bestDelimiterRepairCandidate(song, lookupInput = null) {
  const strict = bestStrictDelimiterRepairCandidate(song);
  if (strict) return strict;
  const lookup = normalizeLookup(lookupInput);
  const texts = candidateSourceTexts(song);
  let best = null;
  for (const text of texts) {
    for (const split of titleArtistSplitCandidates(text)) {
      const scored = scoreTitleArtistSplit(text, split, lookup);
      if (scored.score <= 0) continue;
      if (!best || scored.score > best.score) best = scored;
    }
  }
  return best;
}

function bestStrictDelimiterRepairCandidate(song) {
  for (const text of candidateSourceTexts(song)) {
    const candidate = strictDelimiterRepairCandidate(text);
    if (candidate) return candidate;
  }
  return null;
}

function strictDelimiterRepairCandidate(text) {
  const value = String(text || "").trim();
  const delimiterCount = [...value].filter((char) => char === STRICT_TITLE_ARTIST_DELIMITER).length;
  if (delimiterCount !== 1) return null;
  const index = value.indexOf(STRICT_TITLE_ARTIST_DELIMITER);
  const rawTitle = value.slice(0, index).trim();
  const rawArtist = value.slice(index + STRICT_TITLE_ARTIST_DELIMITER.length).trim();
  if (!rawTitle || !rawArtist || !isValidStrictTitleCandidate(rawTitle)) return null;
  const title = cleanSafeTitleCandidate(rawTitle);
  const artist = cleanSafeArtistCandidate(rawArtist);
  if (!title || !isValidStrictTitleCandidate(title) || !artist || isBadArtistCandidate(artist)) return null;
  return {
    index,
    delimiter: STRICT_TITLE_ARTIST_DELIMITER,
    title,
    artist,
    rawTitle,
    rawArtist,
    score: 1,
    reasons: ["strict_delimiter", "non_empty_parts"],
  };
}

function isValidStrictTitleCandidate(value) {
  const title = String(value || "").trim();
  if (!title) return false;
  const timestamp = title.match(/(?<![\dA-Za-z_:])(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?!\d)/u);
  if (timestamp && timestamp[0] === title) return false;
  return /[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/u.test(title);
}

function titleArtistSplitCandidates(text) {
  const value = stripOuterTitleArtistContainer(String(text || "").trim());
  const candidates = [];
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (BRACKET_OPEN.includes(char)) {
      depth += 1;
      continue;
    }
    if (BRACKET_CLOSE.includes(char)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !DELIMITER_CHARS.includes(char) || isDateSlashAt(value, index)) continue;
    const title = cleanSafeTitleCandidate(value.slice(0, index));
    const artist = cleanSafeArtistCandidate(value.slice(index + 1));
    if (!title || !artist) continue;
    candidates.push({
      index,
      delimiter: char,
      title,
      artist,
      rawTitle: value.slice(0, index).trim(),
      rawArtist: value.slice(index + 1).trim(),
    });
  }
  return candidates;
}

function scoreTitleArtistSplit(text, split, lookupInput = null) {
  const lookup = normalizeLookup(lookupInput);
  const candidate = split && typeof split === "object" && "title" in split ? split : titleArtistSplitCandidates(text)[0];
  if (!candidate) return { score: Number.NEGATIVE_INFINITY, reasons: ["no_split"] };

  const reasons = [];
  let score = 0;
  if (candidate.title && candidate.artist) {
    score += 2;
    reasons.push("non_empty_parts");
  }
  if (isBadArtistCandidate(candidate.artist)) {
    score -= 12;
    reasons.push("bad_artist");
  }
  if (candidate.title.length >= 2) score += 1;
  if (candidate.artist.length >= 2) score += 1;
  if (hasSpaceAroundDelimiter(text, candidate.index)) {
    score += 1;
    reasons.push("spaced_delimiter");
  }

  const recognition = songSearchRecognition(candidate, lookup);
  if (recognition.knownTitleArtist) {
    score += 12;
    reasons.push("known_title_artist");
  } else if (recognition.knownTitle) {
    score += 5;
    reasons.push("known_title");
  }
  if (/\b\d{4}\s*$/u.test(candidate.rawTitle) && /^\d{1,2}\b/u.test(candidate.rawArtist)) {
    score -= 16;
    reasons.push("looks_like_year_month_fragment");
  }
  return { ...candidate, score, reasons };
}

function cleanSafeTitleCandidate(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = stripCustomEmojiAliases(text);
  text = text
    .replace(/^[\s\u3000\u200b-\u200f\u202a-\u202e\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F│┃┏┗┣┳┻━─┬┴┌┐┘┤┼├└╟╠╚╔╩╦╬╞╰╭╮╯꒱⁅⁆]+/u, "")
    .replace(/^[#＃]?\d{1,3}\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F]+\s*/u, "")
    .replace(/^(?:【\s*(?:セットリスト|セトリ|リクエスト)\s*】|\[\s*(?:set\s*list|request)\s*\])\s*/iu, "")
    .replace(
      /^(?:未記載|未记载|待补歌手|待補歌手|待补|待補)\s+(?=(?:[⟦［\[]\s*#?[\d０-９]{1,3}\s*[⟧］\]]\s*[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]|[mｍ]?\d{1,3}[.．]|[#＃]?\d{1,3}\s*[≫»>]|[#＃]?\d{1,3}\s*[)）、:：]|[#＃]?[\d０-９]{1,3}\s+[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]))/iu,
      "",
    )
    .trim();
  text = stripDecorativeNumberBullet(text);
  text = text
    .replace(
      /^(?:[⟦［\[]\s*#?[\d０-９]{1,3}\s*[⟧］\]]\s*(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]\s*|[mｍ][\d０-９]{1,3}[.．]\s*|[\d０-９]{1,3}\s*[≫»>]+\s*|[#＃]?[\d０-９]{1,3}[.．](?![\d０-９])\s*|[#＃]?[\d０-９]{1,3}\s*[)）、:：]\s*|[#＃]?[\d０-９]{1,3}\s+(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]))/iu,
      "",
    )
    .trim();
  text = text.replace(/\s*(?:🆕|←\s*NEW!?|<-\s*NEW!?|NEW!)\s*$/iu, "").trim();
  for (let index = 0; index < 3; index += 1) {
    const unwrapped = unwrapPairedQuote(text);
    if (unwrapped === text) break;
    text = unwrapped.trim();
  }
  return text.replace(/^[\s\u3000\-–—:：;；,，.。]+|[\s\u3000\-–—:：;；,，.。]+$/gu, "").trim();
}

function cleanSafeArtistCandidate(value) {
  return canonicalizeArtistName(stripUnpairedTrailingCloseBracket(
    stripCustomEmojiAliases(value)
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:19|20)\d{2}\s*[\/／.-]\s*(?:0?[1-9]|1[0-2])\b.*$/u, "")
    .replace(/\s+(?:19|20)\d{2}$/u, "")
    .replace(/\s*(?:ピアノ伴奏|アカペラ|お試し枠|海外ニキミームVer\.?|ワンコーラス|1番のみ)\s*$/iu, "")
    .replace(/\s*[☆★]+\s*$/u, "")
    .replace(/\s*[-ー–—]?\s*[【［\[(（「『]\s*$/u, "")
      .trim(),
  ));
}

function stripUnpairedTrailingCloseBracket(value) {
  let text = String(value || "").trim();
  for (const [open, close] of BRACKET_PAIRS) {
    while (text.endsWith(close) && countChar(text, close) > countChar(text, open)) {
      text = text.slice(0, text.length - close.length).trim();
    }
  }
  return text;
}

function countChar(value, char) {
  return [...String(value || "")].filter((item) => item === char).length;
}

function stripDecorativeNumberBullet(value) {
  return String(value || "")
    .replace(
      /^[＊*]\s*(?=(?:[#＃]?[\d０-９]{1,3}[.．](?![\d０-９])|[#＃]?[\d０-９]{1,3}[)）、:：]|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]|[mｍ][\d０-９]{1,3}[.．]))/iu,
      "",
    )
    .trim();
}

function stripCrossFieldWrapper(titleInput, artistInput) {
  const title = String(titleInput || "").trim();
  const artist = String(artistInput || "").trim();
  for (const [open, close] of BRACKET_PAIRS) {
    if (!title.startsWith(open) || !artist.endsWith(close)) continue;
    const nextTitle = title.slice(open.length).trim();
    const nextArtist = artist.slice(0, artist.length - close.length).trim();
    if (!nextTitle || !nextArtist) continue;
    return {
      title: nextTitle,
      artist: nextArtist,
      changed: true,
      reasons: ["cross_field_wrapper"],
    };
  }
  return { title, artist, changed: false, reasons: [] };
}

function stripOuterTitleArtistContainer(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const open = text[0];
  const close = BRACKET_CLOSE_BY_OPEN.get(open);
  if (!close || !text.endsWith(close)) return text;
  const inner = text.slice(open.length, text.length - close.length).trim();
  if (!inner || !hasTopLevelDelimiter(inner)) return text;
  return inner;
}

function hasTopLevelDelimiter(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (BRACKET_OPEN.includes(char)) depth += 1;
    else if (BRACKET_CLOSE.includes(char)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && DELIMITER_CHARS.includes(char) && !isDateSlashAt(value, index)) return true;
  }
  return false;
}

function entryRepairSignals(song) {
  const text = cleanSignalText(String(song?.title || song?.raw || ""));
  const customEmojiOnly = isCustomEmojiOnlyText(text);
  const reactionTextOnly = isReactionTextOnly(text);
  const numericPseudoTitle = isNumericPseudoTitle(text);
  const activityOrAnnouncement = isActivityOrAnnouncementText(text, song);
  const reasons = [];
  if (customEmojiOnly) reasons.push("custom_emoji_only");
  if (reactionTextOnly) reasons.push("reaction_text_only");
  if (numericPseudoTitle) reasons.push("numeric_pseudo_title");
  if (activityOrAnnouncement) reasons.push("activity_or_announcement");
  return {
    customEmojiOnly,
    reactionTextOnly,
    numericPseudoTitle,
    activityOrAnnouncement,
    suppressLikelySong: customEmojiOnly || reactionTextOnly || numericPseudoTitle || activityOrAnnouncement,
    suggestedAction: customEmojiOnly || reactionTextOnly || numericPseudoTitle || activityOrAnnouncement ? "drop_entry" : "",
    reasons,
  };
}

function parserCorruptionTitleCandidate(song, currentTitle) {
  const raw = String(song?.raw || "").normalize("NFKC");
  const title = String(currentTitle || song?.title || "").normalize("NFKC").trim();
  if (!raw || !title) return "";
  const rawText = rawSongText(raw);
  const decimalMatches = rawText.match(/\b\d+(?:\.\d+)+(?:[^\s/／|｜]*)?/gu) || [];
  for (const candidate of decimalMatches) {
    const normalizedCandidate = cleanSafeTitleCandidate(candidate);
    if (!normalizedCandidate || normalizedCandidate === title || title.startsWith(normalizedCandidate)) continue;
    const truncated = normalizedCandidate.replace(/^\d+\./u, "");
    if (title === truncated || title.startsWith(truncated)) return normalizedCandidate;
  }
  return "";
}

function bestCombinedTitleArtistCandidate(title, lookupInput = null) {
  const lookup = normalizeLookup(lookupInput);
  if (!lookup.available || !lookup.titleArtistKeys.size) return null;
  const value = String(title || "").trim();
  if (!value) return null;
  if (lookup.titleKeys.has(normalizeSongSearchText(value))) return null;

  const candidates = [];
  for (const match of value.matchAll(/\s+/gu)) {
    const index = match.index;
    const left = cleanSafeTitleCandidate(value.slice(0, index));
    const right = cleanSafeArtistCandidate(value.slice(index + match[0].length));
    if (!left || !right) continue;
    const key = titleArtistKey(left, right);
    if (lookup.titleArtistKeys.has(key)) candidates.push({ title: left, artist: right, key });
  }
  const unique = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function songSearchRecognition(song, lookupInput = null) {
  const lookup = normalizeLookup(lookupInput);
  if (!lookup.available) return { knownTitle: false, knownTitleArtist: false };
  const titleKey = normalizeSongSearchText(song?.title);
  const artistKey = normalizeSongSearchText(song?.artist);
  const knownTitle = Boolean(titleKey && lookup.titleKeys.has(titleKey));
  const knownTitleArtist = Boolean(titleKey && artistKey && !isUnknownArtistKey(artistKey) && lookup.titleArtistKeys.has(`${titleKey}::${artistKey}`));
  return { knownTitle, knownTitleArtist };
}

function normalizeLookup(input) {
  if (!input) return { available: false, titleKeys: new Set(), titleArtistKeys: new Set() };
  if (input.titleKeys instanceof Set || input.titleArtistKeys instanceof Set) {
    const titleKeys = input.titleKeys instanceof Set ? input.titleKeys : new Set(input.titleKeys || []);
    const titleArtistKeys = input.titleArtistKeys instanceof Set ? input.titleArtistKeys : new Set(input.titleArtistKeys || []);
    return {
      ...input,
      available: Boolean(input.available ?? (titleKeys.size || titleArtistKeys.size)),
      titleKeys,
      titleArtistKeys,
    };
  }
  return createSongSearchLookup(input);
}

function candidateSourceTexts(song) {
  return uniqueValues([
    rawSongText(song?.raw),
    song?.title,
    isUnknownArtist(song?.artist) ? "" : `${song?.title || ""}/${song?.artist || ""}`,
  ]);
}

function rawSongText(raw) {
  let value = String(raw || "").trim();
  value = value.replace(/^(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*/u, "").trim();
  value = value.replace(/^(?:[#＃]?\d{1,3}[)）、:：]\s*|[#＃]?\d{1,3}[.．](?!\d)\s*|[#＃]?\d{1,3}\s+)/u, "").trim();
  value = stripOuterTitleArtistContainer(value);
  return value;
}

function shouldApplyDelimiterRepair(song, candidate, lookup) {
  if (!candidate) return false;
  const currentArtist = normalizeArtist(song?.artist);
  const currentTitle = String(song?.title || "").trim();
  if (isLikelyWorkMetadataCandidate(candidate.artist)) return false;
  if (candidate.score >= 10) return true;
  if (isNumericMonthOnly(currentArtist) && candidate.score > 0) return true;
  if (hasCrossFieldBracketLeak(currentTitle, currentArtist) && candidate.score > 0 && !isBadArtistCandidate(candidate.artist)) return true;
  if (isUnknownArtist(currentArtist) && songSearchRecognition(candidate, lookup).knownTitleArtist) return true;
  if (isUnknownArtist(currentArtist) && candidate.score >= 4 && isLikelyArtistCredit(candidate.artist)) return true;
  return cleanSafeTitleCandidate(currentTitle) !== candidate.title && songSearchRecognition(candidate, lookup).knownTitle;
}

function shouldApplyStrictDelimiterRepair(candidate) {
  return Boolean(candidate && candidate.score > 0);
}

function isDateSlashAt(text, index) {
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  return /\b(?:19|20)\d{2}\s*$/u.test(before) && /^\s*(?:0?[1-9]|1[0-2])\b/u.test(after);
}

function hasSpaceAroundDelimiter(text, index) {
  return /\s/u.test(text[index - 1] || "") && /\s/u.test(text[index + 1] || "");
}

function isBadArtistCandidate(value) {
  const artist = String(value || "").trim();
  return !artist || isNumericMonthOnly(artist) || !/[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(artist);
}

function isLikelyArtistCredit(value) {
  const artist = String(value || "").trim();
  if (isBadArtistCandidate(artist)) return false;
  if (artist.length > 60) return false;
  if (isLikelyWorkMetadataCandidate(artist)) return false;
  if (/^(?:cover|covered\s+by|歌ってみた|弾き語り|karaoke|inst|off\s*vocal)$/iu.test(artist)) return false;
  if (/(?:です|ます|でした|だった|してください|しよう|したい|気がする|公開|開催|開始|終了)$/u.test(artist)) return false;
  return /[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(artist);
}

function hasCrossFieldBracketLeak(title, artist) {
  const titleText = String(title || "").trim();
  const artistText = String(artist || "").trim();
  for (const [open, close] of BRACKET_PAIRS) {
    if (titleText.startsWith(open) && artistText.includes(close)) return true;
  }
  return false;
}

function isLikelyWorkMetadataCandidate(value) {
  const text = String(value || "").trim();
  return /(?:TV\s*size|TV\s*アニメ|TV\s*anime|アニメ|動畫|动画|映画|ドラマ|ゲーム|特撮|番組|作品|第\d+期|シーズン\d+|主題歌|主题歌|挿入歌|劇中歌|テーマ|opening|ending|OP|ED)(?:\s*[\[(（【].*[\])）】])?$/iu.test(text);
}

function isNumericMonthOnly(value) {
  return /^(?:0?[1-9]|1[0-2])$/u.test(String(value || "").trim());
}

function normalizeArtist(value) {
  const artist = String(value || "").trim();
  return artist || UNKNOWN_ARTIST;
}

function isUnknownArtist(value) {
  return isUnknownArtistKey(normalizeSongSearchText(value)) || normalizeArtist(value) === UNKNOWN_ARTIST;
}

function isUnknownArtistKey(value) {
  return new Set(["", "unknown", "na", "n/a", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補"]).has(value);
}

function titleArtistKey(title, artist) {
  const titleKey = normalizeSongSearchText(title);
  const artistKey = normalizeSongSearchText(artist);
  return titleKey && artistKey && !isUnknownArtistKey(artistKey) ? `${titleKey}::${artistKey}` : "";
}

function cleanSignalText(value) {
  return String(value || "")
    .replace(/^(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*/u, "")
    .trim();
}

function cleanConfigText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isCustomEmojiOnlyText(value) {
  const text = String(value || "").trim();
  return Boolean(text && text.length <= 100 && /^:?_[^\s　/／|｜￤∣丨]+(?::+_?[^\s　/／|｜￤∣丨]+)*:?$/u.test(text));
}

function isReactionTextOnly(value) {
  const normalized = String(value || "")
    .replace(/[:：]_[^\s　:：]+[:：]?/gu, "")
    .replace(/^_[^\s　:：]+[:：]\s*/u, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]/gu, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[^\u3040-\u30ff\u3400-\u9fff々〆ヵヶーっ]/gu, "")
    .trim();
  return /^(?:ぷくっ+|ぷいっ+|ふんっ+|あくび|欠伸|くしゃみ|咳払い|せき払い|咳|のび|伸び|水分補給)$/iu.test(normalized);
}

function isNumericPseudoTitle(value) {
  return /^0\d+[.．]\d+(?:\s*[\/／].*)?$/u.test(cleanSafeTitleCandidate(value));
}

function isActivityOrAnnouncementText(value, song = {}) {
  const title = cleanSafeTitleCandidate(value);
  const artist = String(song?.artist || "").trim();
  const combined = `${title} ${artist} ${song?.raw || ""}`;
  if (/^(?:\d+次会|達成[!！]?|歌みたの話)$/u.test(title)) return true;
  if (/^(?:閉会式|開会式)$/u.test(title)) return true;
  return /(?:手で表現した|お写真公開|写真公開|ライブ開催決定|出演決定|フェス.*決定|お披露目で.+やりたい|スタンドマイク回したかった|謝罪会見|改めて謝罪|ばいちょろり.*終了|マリパのわさび事件)/iu.test(combined);
}

function unwrapPairedQuote(value) {
  const pairs = [
    ["『", "』"],
    ["「", "」"],
    ["【", "】"],
    ["[", "]"],
    ["［", "］"],
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  const text = String(value || "").trim();
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close)) return text.slice(open.length, text.length - close.length);
  }
  return text;
}

function stripCustomEmojiAliases(value) {
  let text = String(value || "");
  for (let index = 0; index < 6; index += 1) {
    const next = text
      .replace(/[:：]_[^\s　:：/／|｜￤∣丨]+[:：]?/gu, " ")
      .replace(/(^|[\s\u3000])_[A-Za-z0-9][A-Za-z0-9_-]*[:：]?(?=$|[\s\u3000])/gu, " ")
      .replace(/(^|[\s\u3000])[A-Za-z0-9_-]+(?:smile|cheers|clap|face|penlight|kp)(?=$|[\s\u3000])/giu, " ");
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

module.exports = {
  KNOWN_SONG_ARTIST_OVERRIDES_PATH,
  bestCombinedTitleArtistCandidate,
  bestDelimiterRepairCandidate,
  cleanSafeTitleCandidate,
  cleanSafeArtistCandidate,
  createKnownSongArtistOverrideContext,
  entryRepairSignals,
  findKnownSongArtistOverride,
  loadKnownSongArtistOverrides,
  parserCorruptionTitleCandidate,
  repairParsedEntry,
  scoreTitleArtistSplit,
  songSearchRecognition,
  stripCrossFieldWrapper,
  titleArtistSplitCandidates,
  validateKnownSongArtistOverrides,
};
