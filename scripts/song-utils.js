const { cleanSongTitleNoise, isBlockedSongEntry, isChatReactionShoutText } = require("../assets/source-filter");
const { isActivityMarkerTitle } = require("./curation");

const TIMESTAMP_RE = /(?<![\dA-Za-z_:])(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?!\d)/;
const TIMESTAMP_TOKEN_RE = /(?<![\dA-Za-z_:])(?:[\[【(（]\s*)?(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?:\s*[\]】)）])?(?!\d)/g;
const INDEX_RE =
  /^\s*(?:[⟦［\[]\s*#?[\d０-９]{1,3}\s*[⟧］\]]\s*|[#＃]?[\d０-９]{1,3}[)）、:：]\s*|[#＃]?[\d０-９]{1,3}[.．](?![\d０-９])\s*|[#＃]?[\d０-９]{1,3}\s+)/;
const SEPARATOR_CHARS = "/／|｜￤∣丨✦";
const BRACKET_OPEN = "([{（［【「『";
const BRACKET_CLOSE = ")]}）］】」』";

function normalizeTimelineChars(text) {
  return String(text || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/．/g, ".")
    .replace(/＃/g, "#");
}

function normalizeCommentText(text) {
  return normalizeTimelineChars(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "");
}

function parseTimestampSongs(comments, options = {}) {
  const songs = [];
  const onReject = typeof options.onReject === "function" ? options.onReject : null;
  for (const comment of comments || []) {
    for (const rawLine of mergeSplitTimelineLines(comment)) {
      const line = rawLine.trim();
      const match = TIMESTAMP_RE.exec(line);
      if (!match) continue;

      const time = normalizeCommentTime(match[0]);
      let tail = stripLeadingTimelineDecorations(line.slice(match.index + match[0].length));
      tail = stripLeadingTimelineDecorations(tail.replace(INDEX_RE, "")).trim();
      if (!tail) {
        const prefix = stripLeadingTimelineDecorations(line.slice(0, match.index).replace(INDEX_RE, "")).trim();
        if (prefix && !isObviouslyNonSongText(prefix)) tail = prefix;
      }
      if (!tail) {
        rejectTimestampLine(onReject, "empty_after_timestamp", { line, time, tail });
        continue;
      }
      if (isObviouslyNonSongText(tail)) {
        rejectTimestampLine(onReject, "obvious_non_song_text", { line, time, tail });
        continue;
      }
      if (isCustomEmojiOnlyText(tail)) {
        rejectTimestampLine(onReject, "custom_emoji_only", { line, time, tail });
        continue;
      }

      const [title, artist] = splitTitleArtist(tail);
      const basicRejectReason =
        (isBadSongField(title) && "bad_title") ||
        (isBadSongField(artist) && "bad_artist") ||
        (isCustomEmojiOnlyEntry(title, artist) && "custom_emoji_only") ||
        (isNonSongSectionPair(title, artist) && "section_marker_pair") ||
        (isActivityMarkerTitle(title, artist) && "activity_marker_title") ||
        (isObviouslyNonSongActivityTitle(title) && "activity_title");
      if (basicRejectReason) {
        rejectTimestampLine(onReject, basicRejectReason, { line, time, tail, title, artist });
        continue;
      }
      if (artist === "未記載" && isObviouslyNonSongTitleCandidate(title)) {
        rejectTimestampLine(onReject, "title_only_non_song_candidate", { line, time, tail, title, artist });
        continue;
      }
      if (isLikelyNonSongEntry({ title, artist, raw: line })) {
        rejectTimestampLine(onReject, "likely_non_song_entry", { line, time, tail, title, artist });
        continue;
      }

      songs.push({
        time,
        seconds: timeToSeconds(time),
        title,
        artist,
        raw: line,
      });
    }
  }
  return dedupeSongs(songs);
}

function normalizeParsedSong(song) {
  if (!song || typeof song !== "object") return song;
  const title = cleanSongOrArtistPart(song.title);
  let artist = String(song.artist || "").trim();
  if (!artist || artist === "未記載") artist = "未記載";
  else if (isLikelyWorkMetadata(artist)) artist = "未記載";
  return {
    ...song,
    title,
    artist,
  };
}

function rejectTimestampLine(onReject, reason, payload) {
  if (!onReject) return;
  onReject({
    reason,
    line: payload.line || "",
    time: payload.time || "",
    tail: payload.tail || "",
    title: payload.title || "",
    artist: payload.artist || "",
  });
}

function isLikelyNonSongEntry(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "");
  const combined = `${title} ${raw}`;
  const hasArtist = Boolean(artist && artist !== "未記載");

  if (isCustomEmojiOnlyText(title)) return true;
  if (/^0\d+[.．]\d+(?:\s*[\/／].*)?$/u.test(title)) return true;
  if (isBlockedSongEntry({ title, artist, raw })) return true;
  if (!hasArtist && isChatReactionShoutText(title)) return true;
  if (isReactionActivityEntry(title, artist, raw)) return true;
  if (!hasArtist && /^(?:\d+次会|達成[!！]?|歌みたの話)$/u.test(title)) return true;
  if (!hasArtist && /^(?:(?:歌|配信)?枠)?\s*(?:start|stream\s*start|karaoke\s*start|開始)$/iu.test(title)) return true;
  if (/^(音入り|音入[り]?|声入り|マイクテスト|開始|終了|曲始まり|オープニング|エンディング|登場|退場|ゲスト|スパチャ読み|読み開始|コメント読み|告知|雑談|休憩|ただいま|まで)$/iu.test(title)) {
    return true;
  }
  if (/^(?:閉会式|開会式)$/u.test(title)) return true;
  if (/(?:曲始まり|オープニング|エンディング|登場|退場|スパチャ読み|コメント読み|チャット読み|ギフト(?:は)?読|読み開始|読み上げ|告知|宣伝|配信終了|配信開始|高評価|ch登録|チャンネル登録|登録者(?:数)?|視聴者|OBS|お手洗い休憩|チャットお題|\d+\s*達成|開始\s*[\/／]|虚空|クリックとは|クリックあるもの|ゲスト匂わせ|ゲストでよく呼ばれる|スパチャ|メモは紙|ライブでやる曲|チャンネルで.+歌ってみた|明日の曲について|ござるさん)/iu.test(combined)) {
    return true;
  }
  if (/(?:手で表現した|お写真公開|写真公開|ライブ開催決定|お披露目で.+やりたい|スタンドマイク回したかった)/iu.test(combined)) {
    return true;
  }
  if (!hasArtist && /^(?:本編開始|全曲終了|開始[・\s]?|終了[・\s]?|ライブ開催決定|特別ゲスト|突然の)/iu.test(title)) {
    return true;
  }
  if (!hasArtist && /(?:お話|話$|話①|話②|話題|裏話|スケジュール|おすすめ|コメント|チャット|ギフト|設定|手癖|腰|良い音|到着|ただいま|お土産|先生|予想|コンディション|休暇中|気圧|体調|配信|動画|映画|クリップ|バランス|読み|頑張|ありがとう|お疲れ|おつかれ)/iu.test(combined)) {
    return true;
  }
  if (
    !hasArtist &&
    /^(?:おはよう|おはようございます|こんにちは|こんばんは)[^\n]{0,28}(?:です|だよ|でーす)[!！。.\s]*$/iu.test(title)
  ) {
    return true;
  }
  if (!hasArtist && /^(?:おはよう|おはようございます|こんにちは|こんばんは)[ー〜～?？!！。.\s]*$/iu.test(title)) {
    return true;
  }
  if (!hasArtist && /^.{0,4}(実は|ほら|悲報|どうすか|めっちゃいい|新しいこと|良い音|魅惑の腰|別の意味で|フラグ立て|まさか今|ここから|いつもより|苦しうない).{0,8}$/iu.test(title)) {
    return true;
  }
  if (hasArtist && /^(咳払い|くしゃみ|雑談|告知|宣伝|休憩)$/iu.test(artist)) {
    return true;
  }
  return false;
}

function isReactionActivityEntry(title, artist, raw) {
  const hasArtist = Boolean(artist && artist !== "未記載");
  const titleReaction = isReactionActivityText(title);
  const artistReaction = isReactionActivityText(artist);
  const rawHasMarker = hasReactionActivityMarker(raw);

  if (!hasArtist && titleReaction) return true;
  if (rawHasMarker && (titleReaction || artistReaction)) return true;
  return false;
}

function isReactionActivityText(text) {
  const value = normalizeReactionActivityText(text);
  return /^(?:ぷくっ?|ふんっ?|あくび|欠伸|くしゃみ|咳払い|せき払い|咳|のび|伸び|水分補給)$/iu.test(value) ||
    /^(?:ぷくっ?|ふんっ?|あくび)(?:かわいい|可愛い)$/iu.test(value);
}

function hasReactionActivityMarker(raw) {
  const value = String(raw || "");
  if (/[:：]_[^\s　:：]+[:：]?/u.test(value) || /[\u{1F300}-\u{1FAFF}]/u.test(value)) return true;
  for (const match of value.matchAll(/[（(]([^()（）]{1,24})[)）]/gu)) {
    if (isReactionActivityText(match[1])) return true;
  }
  return false;
}

function normalizeReactionActivityText(text) {
  return stripCustomEmojiAliases(text)
    .replace(/[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]/gu, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[^\u3040-\u30ff\u3400-\u9fff々〆ヵヶーっ]/gu, "")
    .trim();
}

function splitTitleArtist(text) {
  const parsed = extractSongArtistCore(text);
  if (parsed) return parsed;
  const symbolicPerformer = extractTitleWithSymbolicPerformer(text);
  if (symbolicPerformer) return symbolicPerformer;
  return [cleanSongOrArtistPart(text), "未記載"];
}

function extractTitleWithSymbolicPerformer(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(.+?)\s*[\/／|｜￤∣丨]\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F\s・･×+＆&、,]+$/u);
  if (!match) return null;
  const title = cleanSongOrArtistPart(match[1]);
  return title && !isBadSongField(title) ? [title, "未記載"] : null;
}

function mergeSplitTimelineLines(text) {
  const lines = [];
  const rawLines = normalizeCommentText(text).split("\n");
  for (const line of rawLines) {
    lines.push(...splitCollapsedTimelineLine(line));
  }

  const merged = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = (lines[idx] || "").trim();
    const next = (lines[idx + 1] || "").trim();
    const next2 = (lines[idx + 2] || "").trim();
    const next3 = (lines[idx + 3] || "").trim();

    if (
      /^\d{1,3}$/.test(line) &&
      isStartTimestampMarkerLine(next) &&
      isTimestampOnlyLine(next2) &&
      next3 &&
      !isTimestampOnlyLine(next3) &&
      !isObviouslyNonSongText(next3)
    ) {
      const timestamp = extractPrimaryTimestamp(next);
      if (timestamp) merged.push(`${timestamp} ${next3}`);
      idx += 3;
      continue;
    }

    if (isSongArtistOnlyLine(line) && isTimestampOnlyLine(next)) {
      const timestamp = extractPrimaryTimestamp(next);
      if (timestamp) merged.push(`${timestamp} ${line}`);
      idx += 1;
      continue;
    }

    if (isTimestampOnlyLine(line)) {
      const timestamp = extractPrimaryTimestamp(line);
      if (timestamp && next && !isTimestampOnlyLine(next) && !isObviouslyNonSongText(next)) {
        merged.push(`${timestamp} ${next}`);
        idx += 1;
        continue;
      }
    }

    merged.push(line);
  }
  return merged;
}

function splitCollapsedTimelineLine(line) {
  const source = normalizeTimelineChars(line).trim();
  if (!source) return [];
  TIMESTAMP_TOKEN_RE.lastIndex = 0;
  const positions = [];
  for (const match of source.matchAll(TIMESTAMP_TOKEN_RE)) {
    const token = match[0].replace(/^[\[【(（]\s*|\s*[\]】)）]$/g, "");
    if (TIMESTAMP_RE.test(token)) positions.push(match.index);
  }
  const uniquePositions = [...new Set(positions)].sort((a, b) => a - b);
  if (uniquePositions.length <= 1) return [source];
  const result = [];
  if (uniquePositions[0] > 0) {
    const prefix = source.slice(0, uniquePositions[0]).trim();
    if (prefix) result.push(prefix);
  }
  for (let idx = 0; idx < uniquePositions.length; idx += 1) {
    const start = uniquePositions[idx];
    const end = uniquePositions[idx + 1] ?? source.length;
    const chunk = source.slice(start, end).trim();
    if (chunk) result.push(chunk);
  }
  return result;
}

function stripLeadingTimelineDecorations(text) {
  let value = normalizeTimelineChars(text).trim();
  for (let idx = 0; idx < 4; idx += 1) {
    const original = value;
    value = value.replace(/^[\]】)）⟧］」』⁆]+\s*/u, "").trim();
    value = value
      .replace(/^(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?(?:[\s\u3000]*[;；,，、~～\-—–−:：]+\s*)?/u, "")
      .trim();
    value = value.replace(/^(?:Re\s*[:：]\s*|【\s*\d{1,3}\s*】\s*|\[\s*\d{1,3}\s*\]\s*|\(\s*\d{1,3}\s*\)\s*)/iu, "").trim();
    value = value.replace(/^\d{1,3}\s*(?:曲\s*[\/／]|[,，\-—–−:：]\s*|[.)．。、]\s+)/u, "").trim();
    value = stripLeadingDecorativeNumberBullet(value);
    value = value
      .replace(/^[\u200b-\u200f\u202a-\u202e\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼→⇒꒱⁅⁆\s]+/u, "")
      .trim();
    if (value === original) break;
  }
  return value.replace(/^[\s\t\-–—:：.、]+|[\s\t\-–—:：.、]+$/g, "");
}

function stripLeadingDecorativeNumberBullet(value) {
  return String(value || "")
    .replace(
      /^[＊*]\s*(?=(?:[#＃]?[\d０-９]{1,3}[.．](?![\d０-９])|[#＃]?[\d０-９]{1,3}[)）、:：]|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]|[mｍ][\d０-９]{1,3}[.．]))/iu,
      "",
    )
    .trim();
}

function extractSongArtistCore(text) {
  const raw = String(text || "")
    .trim()
    .replace(/\s*[\(（]\s*\d{4}\s*(?:[\/.\-年]\s*\d{1,2})\s*(?:[\/.\-月]\s*\d{1,2})?\s*日?\s*[\)）]\s*$/u, "");
  if (!raw) return null;

  const simpleDoubleSlash = raw.match(/^(.+?)\s*\/\/\s*(.+)$/u);
  if (simpleDoubleSlash) {
    const parsed = [cleanSongOrArtistPart(simpleDoubleSlash[1]), splitWithMetadata(simpleDoubleSlash[2])];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  const doubleSlash = findSpacedDoubleSlashOutsideBrackets(raw);
  if (doubleSlash > 0) {
    const parsed = [cleanSongOrArtistPart(raw.slice(0, doubleSlash)), splitWithMetadata(raw.slice(doubleSlash + 2))];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  const spaced = findSpacedDelimiterOutsideBrackets(raw, SEPARATOR_CHARS);
  if (spaced) {
    const parsed = [cleanSongOrArtistPart(raw.slice(0, spaced.index)), splitWithMetadata(raw.slice(spaced.index + spaced.length))];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  let match = raw.match(/^(.+)\s+[-—–−]\s+(.+)$/u);
  if (match) {
    const parsed = [cleanSongOrArtistPart(match[1]), splitWithMetadata(match[2])];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  match = raw.match(/^(.+?)\s+by\s+(.+)$/iu);
  if (match && (match[2].trim().length >= 3 || containsJapanese(match[2]))) {
    const parsed = [cleanSongOrArtistPart(match[1]), splitWithMetadata(match[2])];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  const lastDelimiter = findLastDelimiterOutsideBrackets(raw, SEPARATOR_CHARS);
  if (lastDelimiter > 0 && lastDelimiter < raw.length - 1) {
    const title = cleanSongOrArtistPart(raw.slice(0, lastDelimiter));
    const artistPart = raw.slice(lastDelimiter + 1);
    if (title && isLikelyWorkMetadata(artistPart)) return [title, "未記載"];
    const parsed = [title, splitWithMetadata(artistPart)];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  match = raw.match(/^(.+?)\s*[\(（]([^()（）]{1,80})[\)）]\s*$/u);
  if (match && !looksLikeLatinAnnotation(match[2])) {
    const parsed = [cleanSongOrArtistPart(match[1]), cleanArtistPart(match[2])];
    if (!isBadSongField(parsed[0]) && !isBadSongField(parsed[1])) return parsed;
  }

  return null;
}

function splitWithMetadata(text) {
  const value = String(text || "").trim();
  const slashMetadataArtist = splitArtistBeforeWorkMetadata(value);
  if (slashMetadataArtist) return slashMetadataArtist;
  const match = findSpacedDelimiterOutsideBrackets(value, "|｜￤∣丨");
  if (!match) return cleanArtistPart(value);
  const artist = cleanArtistPart(value.slice(0, match.index));
  const metadata = cleanSongOrArtistPart(value.slice(match.index + match.length)).replace(/^[\[\]【】]+|[\[\]【】]+$/g, "");
  return artist && metadata ? `${artist} [${metadata}]` : artist;
}

function splitArtistBeforeWorkMetadata(text) {
  const value = String(text || "").trim();
  const match = findSpacedDelimiterOutsideBrackets(value, "/／");
  if (!match) return "";
  const artist = cleanArtistPart(value.slice(0, match.index));
  const metadata = cleanSongOrArtistPart(value.slice(match.index + match.length));
  if (!artist || isBadSongField(artist) || !metadata || !isLikelyWorkMetadata(metadata)) return "";
  return artist;
}

function cleanSongOrArtistPart(text) {
  let value = stripTrailingLatinAnnotation(String(text || "").trim());
  value = stripCustomEmojiAliases(value).trim();
  if (!shouldPreserveDecimalSongTitle(value)) value = cleanSongTitleNoise(value).trim();
  value = value.replace(/^_[A-Za-z0-9]+:\s*/u, "").trim();
  const preserveTrailingDoubleSlash = /[A-Za-z0-9)\]）]\/\/\s*$/.test(value);
  value = stripLeadingDecorativeNumberBullet(value);
  value = value.replace(/^\s*(?:[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]\s*|\d{1,3}\s*[≫»>]+\s*|\d{1,3}\s*[\-—–−]|[#＃]\s*\d{1,3}\s*[.)．。、:：\-—–−]?|encore|アンコール)\s*/iu, "").trim();
  if (!shouldPreserveDecimalSongTitle(value)) value = cleanSongTitleNoise(value).trim();
  value = value.replace(/^[\[［]+|[\]］]+$/g, "").trim();
  value = value.replace(/^[\-—–−/／|｜￤∣丨✦:：;；]+|[\-—–−/／|｜￤∣丨✦:：;；]+$/g, "").trim();
  if (preserveTrailingDoubleSlash && !value.endsWith("//")) value = `${value}//`;
  return value;
}

function shouldPreserveDecimalSongTitle(value) {
  const text = String(value || "").trim();
  return /^\d[.．]\d+(?:\S*|\s*[\/／].*)?$/u.test(text);
}

function cleanArtistPart(text) {
  let value = cleanSongOrArtistPart(text);
  const romanized = value.match(/^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .,:'’"“”&+_\-/!?~～#＃♯♭★☆♪♫♡♥◎・･=×∞]+\s*[\(（]([^()（）]{1,80})[\)）]$/u);
  if (romanized && containsJapanese(romanized[1])) value = romanized[1].trim();
  value = value.replace(/\s*[❄✨⭐★☆]*\s*(?:チャレンジ|challenge)\s*$/iu, "").trim();
  value = value.replace(/\s*(?:[\[【(（]\s*)?(?:Original Song|Original|オリジナル(?:曲)?|弾き語り(?:初披露)?|初披露|初公開|途中まで|ワンコーラス|挑戦枠?)(?:\s*[\]】)）])?\s*$/iu, "").trim();
  value = value.replace(/\s*【[^】]{1,120}】\s*$/u, "").trim();
  return value;
}

function isTimestampCandidateText(text) {
  const value = normalizeCommentText(text);
  if (!TIMESTAMP_RE.test(value)) return false;
  const remainder = value
    .replace(TIMESTAMP_RE, "")
    .replace(/[\s\u3000\[\]【】()（）<>＜＞:：;；,，.。~～\-—–−_/／|｜￤∣丨♪♫♬♩▶▷►▸▹・･●○◆◇■□]+/gu, "");
  return /[A-Za-zぁ-んァ-ヶ一-龯々]/u.test(remainder);
}

function isCustomEmojiOnlyEntry(title, artist) {
  if (String(artist || "").trim() && artist !== "未記載") return false;
  return isCustomEmojiOnlyText(title);
}

function isCustomEmojiOnlyText(text) {
  const value = normalizeTimelineChars(text).trim();
  if (!value || value.length > 100) return false;
  return /^:?_[^\s　/／|｜￤∣丨]+(?::+_?[^\s　/／|｜￤∣丨]+)*:?$/u.test(value);
}

function stripCustomEmojiAliases(text) {
  return String(text || "")
    .replace(/[:：]_[^\s　:：]+[:：]?/gu, "")
    .replace(/^_[^\s　:：]+[:：]\s*/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isStartTimestampMarkerLine(text) {
  const value = normalizeTimelineChars(text).trim();
  return /^\d{1,2}:\d{2}(?::\d{2})?\s*[~～-]?\s*$/.test(value);
}

function isTimestampOnlyLine(text) {
  const value = normalizeTimelineChars(text).trim();
  return /^(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*[~～-]?\s*$/.test(value);
}

function extractPrimaryTimestamp(text) {
  const match = normalizeTimelineChars(text).match(TIMESTAMP_RE);
  return match ? match[0] : "";
}

function isSongArtistOnlyLine(text) {
  const value = normalizeTimelineChars(text).trim();
  if (!value || TIMESTAMP_RE.test(value) || isTimestampOnlyLine(value) || isObviouslyNonSongText(value)) return false;
  return extractSongArtistCore(value) !== null;
}

function isObviouslyNonSongText(text) {
  const value = stripWeirdLeadingChars(text);
  if (!value) return true;
  if (/^(?:\d+次会|達成[!！]?|歌みたの話)$/u.test(value)) return true;
  if (/^(開始|结束|終了|end|start|op|ed|opening|ending|intro|outro|set\s*list|setlist|セットリスト|セトリ|タイムスタンプ|曲名|talk|talk[_-]?\d+|mc|雑談|聊天|感想|告知|返场|休息|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|読み開始|ただいま)$/iu.test(value)) {
    return true;
  }
  if (/^[~〜～]+(?:リアルライブチケット#耐久\s*\d+)?$/iu.test(value)) return true;
  if (/(?:宣伝|告知|お知らせ)\s*$/u.test(value)) return true;
  if (value.startsWith("編集中です")) return true;
  if (/^".+"$/u.test(value)) return true;
  return false;
}

function isObviouslyNonSongTitleCandidate(text) {
  const value = normalizeSectionMarker(text);
  if (!value) return true;
  if (/^(?:\d+次会|達成|歌みたの話)$/u.test(value)) return true;
  if (/^(?:(?:配信|stream|karaoke)?start|starting|op|ed|end|opening|ending|intro|outro|setlist|セットリスト|セトリ|タイムスタンプ|曲名|edtalk|optalk|talk\d*|mc|雑談|告知|お知らせ|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|スタート|アカペラver|はのは[ー〜～]*|読み開始|ただいま)$/iu.test(value)) {
    return true;
  }
  if (/^[~〜～]+(?:リアルライブチケット#耐久\s*\d+)?$/iu.test(value)) return true;
  const raw = String(text || "");
  if (/(?:お疲れ|おつかれ|ありがとう|ありがと|ただいま|待ってて|読み開始|\braid\b|\bthanks?\b)/iu.test(raw)) {
    return true;
  }
  if (/^(?:おはよう|おはようございます|こんにちは|こんばんは)[^\n]{0,28}(?:です|だよ|でーす)[!！。.\s]*$/iu.test(raw)) {
    return true;
  }
  if (/^(?:またね)[ー〜～!！。.\s]*$/iu.test(raw)) {
    return true;
  }
  if (
    raw.length >= 18 &&
    /(?:ちゃん|さん|くん|良すぎ|よすぎ|すぎて|しました|でした|ですね|ですよ|ありがとう|おつかれ|お疲れ|最高|晩酌|寄り酔い|するする|with\s+JOY子)/iu.test(raw)
  ) {
    return true;
  }
  if (/[\u{1F300}-\u{1FAFF}]/u.test(raw) && raw.length >= 12) return true;
  return /(?:トーク|配信|コメント|アーカイブ|歌ってほしい|歌唱検知|かわい|好き|鼻詰まり|照れ顔|最近|オケだけ|ざっぶーん|歌枠|リアクション|ハモリ|ライブ行って|イメージ|印象|共通点|接点|生放送|武道館|コラボ予定|チケット|キービジュアル|ジャケット写真|グッズ|スクショ|誕生日|ニッポン放送|写真投稿|試験|頑張る)/iu.test(raw);
}

function isObviouslyNonSongActivityTitle(text) {
  if (/^\s*[A-Za-zぁ-んァ-ヶ一-龯々ー・\s]{2,}\s*[→⇒]\s*[A-Za-zぁ-んァ-ヶ一-龯々ー・\s]{2,}\s*$/u.test(text || "")) {
    return true;
  }
  return /(?:歌枠|リアクション|ハモリ|ライブ行って|イメージ|印象|共通点|接点|生放送|武道館|コラボ予定|チケット|キービジュアル|ジャケット写真|グッズ|スクショ|誕生日|ニッポン放送|写真投稿|試験|頑張る|声がかかる|自己啓発|放送📻)/iu.test(text || "");
}

function isNonSongSectionPair(title, artist) {
  return Boolean(title && artist && isNonSongSectionMarker(title) && isNonSongSectionMarker(artist));
}

function isLikelyWorkMetadata(text) {
  const value = cleanSongOrArtistPart(text);
  if (!value) return false;
  if (looksLikeArtistCreditWithWorkMetadata(value)) return false;
  const base = value
    .replace(/\s*[\(（][^()（）]{1,100}[\)）]\s*$/u, "")
    .replace(/\s*\[[^\[\]]{1,100}\]\s*$/u, "")
    .trim();
  if (!base) return false;
  return /(?:^|[\s・･])(?:OP|ED|OST|BGM|MV|PV|主題歌|挿入歌|劇中歌|テーマ|opening|ending)$/iu.test(base) ||
    /(?:アニメ|映画|劇場版|ドラマ|ゲーム|特撮|番組|作品|第\d+期|シーズン\d+).{0,40}(?:OP|ED|主題歌|挿入歌|劇中歌|テーマ)?$/iu.test(base) ||
    /(?:OP|ED)(?:\d+|[①-⑳])?$/iu.test(base);
}

function looksLikeArtistCreditWithWorkMetadata(text) {
  const value = String(text || "").trim();
  if (/(?:feat\.?|featuring|starring|covered\s+by|歌唱|cover(?:ed)?\s+by)/iu.test(value)) return true;
  if (
    /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .:'’"“”&+_\-!?~～#＃♯♭★☆♪♫♡♥◎・･=×∞]{2,}(?:\s*[\(（]|\s*[\/／|｜￤∣丨])/u.test(value) &&
    /(?:\d{4}|TV|アニメ|映画|ドラマ|ゲーム|主題歌|OP|ED)/iu.test(value)
  ) {
    return !/^(?:TV|OP|ED|OST|BGM|MV|PV|opening|ending)\b/iu.test(value);
  }
  return false;
}

function isNonSongSectionMarker(text) {
  const key = normalizeSectionMarker(text);
  return /^(opening|open|op|start|starting|intro|introduction|幕開け|開幕|開始|オープニング|声入り|ご挨拶|挨拶|アナウンス|自己紹介|closing|close|end|ending|ed|outro|閉幕|終幕|終了|エンディング)$/iu.test(key);
}

function normalizeSectionMarker(text) {
  return String(text || "")
    .replace(/[\s\u3000_\-—–−/／|｜￤∣丨:：;；,，.。!！?？~～・･]+/gu, "")
    .toLowerCase();
}

function isBadSongField(text) {
  const value = String(text || "").trim();
  if (value === "未記載") return false;
  if (!value || /^(歌名|曲名|歌手|原唱|编号|未確定|未确定)$/iu.test(value)) return true;
  if (TIMESTAMP_RE.test(value) && value.match(TIMESTAMP_RE)?.[0] === value) return true;
  if (!/[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/u.test(value)) return true;
  if (/^0\d+[.．]\d+$/u.test(value)) return true;
  if (/^(talk|mc|雑談|聊天|感想|开场|開始|结束|終了|告知|返场|休息|set\s*list|setlist|セットリスト|セトリ|タイムスタンプ)$/iu.test(value)) return true;
  return false;
}

function dedupeSongs(songs) {
  const deduped = [];
  for (const song of songs) {
    const existingIndex = deduped.findIndex((item) => isNearDuplicateSong(item, song));
    if (existingIndex >= 0) {
      if (deduped[existingIndex].artist === "未記載" && song.artist !== "未記載") deduped[existingIndex] = song;
      continue;
    }
    deduped.push(song);
  }
  return deduped.sort((a, b) => a.seconds - b.seconds);
}

function isNearDuplicateSong(left, right) {
  return songKey(left.title) === songKey(right.title) && artistsCompatible(left.artist, right.artist) && Math.abs(left.seconds - right.seconds) <= 3;
}

function artistsCompatible(left, right) {
  const leftUnknown = isUnknownArtistField(left);
  const rightUnknown = isUnknownArtistField(right);
  if (leftUnknown || rightUnknown) return true;
  return songKey(left) === songKey(right);
}

function isUnknownArtistField(value) {
  return new Set(["", "unknown", "n/a", "na", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補", "-"]).has(
    String(value || "").trim(),
  );
}

function songKey(text) {
  return normalizeTimelineChars(stripTrailingLatinAnnotation(text))
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/[\[\]（）()【】「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦]/gu, "");
}

function normalizeCommentTime(value) {
  const parts = String(value).split(":");
  if (parts.length === 2) return `0:${String(Number(parts[0])).padStart(2, "0")}:${parts[1]}`;
  return `${Number(parts[0])}:${parts[1]}:${parts[2]}`;
}

function timeToSeconds(value) {
  const parts = String(value)
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function stripWeirdLeadingChars(text) {
  return String(text || "")
    .replace(/^[\s\u3000\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼→⇒⁅⁆]+/u, "")
    .trim();
}

function stripTrailingLatinAnnotation(text) {
  const value = String(text || "").trim();
  const match = value.match(/([\s\u3000]*)[(（［\[]([^()（）\[\]［］]{1,120})[)）］\]]\s*$/u);
  if (!match) return value;
  const before = value.slice(0, match.index).trim();
  const content = match[2].trim();
  if (before && containsJapanese(before) && looksLikeLatinAnnotation(content)) return before;
  return value;
}

function looksLikeLatinAnnotation(text) {
  const value = String(text || "").trim();
  if (!value || !containsLatin(value) || containsJapanese(value)) return false;
  return /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .,:'’"“”&+_\-/!?~～()[\]（）［］#＃♯♭★☆♪♫♡♥◎・･=×∞]+$/u.test(value);
}

function containsJapanese(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text || "");
}

function containsLatin(text) {
  return /[A-Za-z]/.test(text || "");
}

function findSpacedDoubleSlashOutsideBrackets(text) {
  let depth = 0;
  for (let idx = 0; idx < text.length - 1; idx += 1) {
    const ch = text[idx];
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.slice(idx, idx + 2) === "//" && isSpace(text[idx - 1]) && isSpace(text[idx + 2])) return idx;
  }
  return -1;
}

function findSpacedDelimiterOutsideBrackets(text, delimiters) {
  let depth = 0;
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && delimiters.includes(ch) && isSpace(text[idx - 1]) && isSpace(text[idx + 1])) {
      return { index: idx, length: 1 };
    }
  }
  return null;
}

function findLastDelimiterOutsideBrackets(text, delimiters) {
  let depth = 0;
  let found = -1;
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (BRACKET_OPEN.includes(ch)) depth += 1;
    else if (BRACKET_CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && delimiters.includes(ch) && !isDateSlashDelimiter(text, idx)) found = idx;
  }
  return found;
}

function isDateSlashDelimiter(text, index) {
  const ch = text[index];
  if (ch !== "/" && ch !== "／") return false;
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  return /\b(?:19|20)\d{2}\s*$/u.test(before) && /^\s*(?:0?[1-9]|1[0-2])\b/u.test(after);
}

function isSpace(ch) {
  return /^[\s\u3000]$/.test(ch || "");
}

module.exports = {
  TIMESTAMP_RE,
  isTimestampCandidateText,
  isLikelyNonSongEntry,
  normalizeCommentText,
  normalizeParsedSong,
  parseTimestampSongs,
  timeToSeconds,
};
