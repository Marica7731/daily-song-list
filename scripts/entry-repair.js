const { createSongSearchLookup, normalizeSongSearchText } = require("../assets/frontend-utils");

const UNKNOWN_ARTIST = "未記載";
const DELIMITER_CHARS = "/／|｜￤∣丨";
const BRACKET_OPEN = "([{（［【「『";
const BRACKET_CLOSE = ")]}）］】」』";

function repairParsedEntry(song, lookupInput = null) {
  if (!song || typeof song !== "object") return song;

  const lookup = normalizeLookup(lookupInput);
  const signals = entryRepairSignals(song);
  const repairs = [];
  let title = String(song.title || "").trim();
  let artist = normalizeArtist(song.artist);
  const raw = String(song.raw || "");

  const cleanedTitle = cleanSafeTitleCandidate(title);
  if (cleanedTitle && cleanedTitle !== title) {
    title = cleanedTitle;
    repairs.push("safe_title_cleanup");
  }

  const delimiterRepair = bestDelimiterRepairCandidate(song, lookup);
  if (delimiterRepair && shouldApplyDelimiterRepair(song, delimiterRepair, lookup)) {
    title = delimiterRepair.title;
    artist = delimiterRepair.artist;
    repairs.push("delimiter_split");
  }

  const combinedRepair = bestCombinedTitleArtistCandidate(title, lookup);
  if (combinedRepair && isUnknownArtist(artist)) {
    title = combinedRepair.title;
    artist = combinedRepair.artist;
    repairs.push("combined_title_artist_lookup");
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

function bestDelimiterRepairCandidate(song, lookupInput = null) {
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

function titleArtistSplitCandidates(text) {
  const value = String(text || "").trim();
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
  text = text
    .replace(/^[\s\u3000\u200b-\u200f\u202a-\u202e│┃┏┗┣┳┻━─┬┴┌┐┘┤┼├└╟╠╚╔╩╦╬╞╰╭╮╯꒱]+/u, "")
    .replace(/^(?:【\s*(?:セットリスト|セトリ|リクエスト)\s*】|\[\s*(?:set\s*list|request)\s*\])\s*/iu, "")
    .trim();
  text = text.replace(/^(?:[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]\s*|\d{1,3}\s*[≫»>]+\s*|[#＃]?\d{1,3}[.．](?!\d)\s*)/u, "").trim();
  text = text.replace(/\s*(?:🆕|←\s*NEW!?|<-\s*NEW!?|NEW!)\s*$/iu, "").trim();
  for (let index = 0; index < 3; index += 1) {
    const unwrapped = unwrapPairedQuote(text);
    if (unwrapped === text) break;
    text = unwrapped.trim();
  }
  return text.replace(/^[\s\u3000\-–—:：;；,，.。]+|[\s\u3000\-–—:：;；,，.。]+$/gu, "").trim();
}

function cleanSafeArtistCandidate(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:19|20)\d{2}\s*[\/／.-]\s*(?:0?[1-9]|1[0-2])\b.*$/u, "")
    .replace(/\s+(?:19|20)\d{2}$/u, "")
    .trim();
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
  return value;
}

function shouldApplyDelimiterRepair(song, candidate, lookup) {
  if (!candidate) return false;
  const currentArtist = normalizeArtist(song?.artist);
  const currentTitle = String(song?.title || "").trim();
  if (candidate.score >= 10) return true;
  if (isNumericMonthOnly(currentArtist) && candidate.score > 0) return true;
  if (isUnknownArtist(currentArtist) && songSearchRecognition(candidate, lookup).knownTitleArtist) return true;
  if (isUnknownArtist(currentArtist) && candidate.score >= 4 && isLikelyArtistCredit(candidate.artist)) return true;
  return cleanSafeTitleCandidate(currentTitle) !== candidate.title && songSearchRecognition(candidate, lookup).knownTitle;
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
  if (/^(?:cover|covered\s+by|歌ってみた|弾き語り|karaoke|inst|off\s*vocal)$/iu.test(artist)) return false;
  if (/(?:です|ます|でした|だった|してください|しよう|したい|気がする|公開|開催|開始|終了)$/u.test(artist)) return false;
  return /[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(artist);
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
  return new Set(["", "unknown", "na", "n/a", "none", "null", "未記載", "未记载", "不明", "なし", "无"]).has(value);
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
  if (/^(?:閉会式|開会式)$/u.test(title)) return true;
  return /(?:手で表現した|お写真公開|写真公開|ライブ開催決定|お披露目で.+やりたい|スタンドマイク回したかった)/iu.test(combined);
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

function uniqueValues(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

module.exports = {
  bestCombinedTitleArtistCandidate,
  bestDelimiterRepairCandidate,
  cleanSafeTitleCandidate,
  entryRepairSignals,
  repairParsedEntry,
  scoreTitleArtistSplit,
  songSearchRecognition,
  titleArtistSplitCandidates,
};
