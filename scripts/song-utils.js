const TIMESTAMP_RE = /(?<![\dA-Za-z_:])(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?!\d)/;
const TIMESTAMP_TOKEN_RE = /(?<![\dA-Za-z_:])(?:[\[【(（]\s*)?(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?:\s*[\]】)）])?(?!\d)/g;
const INDEX_RE =
  /^\s*(?:[⟦［\[]\s*#?[\d０-９]{1,3}\s*[⟧］\]]\s*|[#＃]?[\d０-９]{1,3}[)）、:：]\s*|[#＃]?[\d０-９]{1,3}[.．]\s*|[#＃]?[\d０-９]{1,3}\s+)/;
const SEPARATOR_CHARS = "/／|｜￤∣丨";
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

function parseTimestampSongs(comments) {
  const songs = [];
  for (const comment of comments || []) {
    for (const rawLine of mergeSplitTimelineLines(comment)) {
      const line = rawLine.trim();
      const match = TIMESTAMP_RE.exec(line);
      if (!match) continue;

      let tail = stripLeadingTimelineDecorations(line.slice(match.index + match[0].length));
      tail = stripLeadingTimelineDecorations(tail.replace(INDEX_RE, "")).trim();
      if (!tail || isObviouslyNonSongText(tail)) continue;

      const [title, artist] = splitTitleArtist(tail);
      if (
        isBadSongField(title) ||
        isBadSongField(artist) ||
        isNonSongSectionPair(title, artist) ||
        isObviouslyNonSongActivityTitle(title)
      ) {
        continue;
      }
      if (artist === "未記載" && isObviouslyNonSongTitleCandidate(title)) continue;

      songs.push({
        time: normalizeCommentTime(match[0]),
        seconds: timeToSeconds(normalizeCommentTime(match[0])),
        title,
        artist,
        raw: line,
      });
    }
  }
  return dedupeSongs(songs);
}

function splitTitleArtist(text) {
  const parsed = extractSongArtistCore(text);
  if (parsed) return parsed;
  return [cleanSongOrArtistPart(text), "未記載"];
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
    value = value.replace(/^[\]】)）⟧］」』]+\s*/u, "").trim();
    value = value
      .replace(/^(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?(?:[\s\u3000]*[;；,，、~～\-—–−:：]+\s*)?/u, "")
      .trim();
    value = value.replace(/^(?:Re\s*[:：]\s*|【\s*\d{1,3}\s*】\s*|\[\s*\d{1,3}\s*\]\s*|\(\s*\d{1,3}\s*\)\s*)/iu, "").trim();
    value = value.replace(/^\d{1,3}\s*(?:曲\s*[\/／]|[,，\-—–−:：]\s*|[.)．。、]\s+)/u, "").trim();
    value = value
      .replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼→⇒\s]+/u, "")
      .trim();
    if (value === original) break;
  }
  return value.replace(/^[\s\t\-–—:：.、]+|[\s\t\-–—:：.、]+$/g, "");
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
    const parsed = [cleanSongOrArtistPart(raw.slice(0, lastDelimiter)), splitWithMetadata(raw.slice(lastDelimiter + 1))];
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
  const match = findSpacedDelimiterOutsideBrackets(value, "|｜￤∣丨");
  if (!match) return cleanArtistPart(value);
  const artist = cleanArtistPart(value.slice(0, match.index));
  const metadata = cleanSongOrArtistPart(value.slice(match.index + match.length)).replace(/^[\[\]【】]+|[\[\]【】]+$/g, "");
  return artist && metadata ? `${artist} [${metadata}]` : artist;
}

function cleanSongOrArtistPart(text) {
  let value = stripTrailingLatinAnnotation(String(text || "").trim());
  const preserveTrailingDoubleSlash = /[A-Za-z0-9)\]）]\/\/\s*$/.test(value);
  value = value.replace(/^\s*(?:\d{1,3}\s*[\-—–−]|[#＃]\s*\d{1,3}\s*[.)．。、:：\-—–−]?|encore|アンコール)\s*/iu, "").trim();
  value = value.replace(/^[\[［]+|[\]］]+$/g, "").trim();
  value = value.replace(/^[\-—–−/／|｜￤∣丨:：;；]+|[\-—–−/／|｜￤∣丨:：;；]+$/g, "").trim();
  if (preserveTrailingDoubleSlash && !value.endsWith("//")) value = `${value}//`;
  return value;
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
  if (/^(開始|结束|終了|end|start|talk|talk[_-]?\d+|mc|雑談|聊天|感想|告知|返场|休息|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|読み開始|ただいま)$/iu.test(value)) {
    return true;
  }
  if (/(?:宣伝|告知|お知らせ)\s*$/u.test(value)) return true;
  if (value.startsWith("編集中です")) return true;
  if (/^".+"$/u.test(value)) return true;
  return false;
}

function isObviouslyNonSongTitleCandidate(text) {
  const value = normalizeSectionMarker(text);
  if (!value) return true;
  if (/^(配信)?start|starting|op|ed|edtalk|optalk|talk\d*|mc|雑談|告知|お知らせ|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|スタート|アカペラver|はのは[ー〜～]*|読み開始|ただいま$/iu.test(value)) {
    return true;
  }
  const raw = String(text || "");
  if (/(?:お疲れ|おつかれ|ありがとう|ありがと|こんばんは|こんにちは|おはよう|ただいま|待ってて|読み開始|\braid\b|\bthanks?\b)/iu.test(raw)) {
    return true;
  }
  if (
    raw.length >= 18 &&
    /(?:ちゃん|さん|くん|良すぎ|よすぎ|すぎて|しました|でした|ですね|ですよ|ありがとう|おつかれ|お疲れ|最高|晩酌|寄り酔い|するする|with\s+JOY子)/iu.test(raw)
  ) {
    return true;
  }
  if (/[\u{1F300}-\u{1FAFF}]/u.test(raw) && raw.length >= 12) return true;
  return /(?:トーク|配信|コメント|アーカイブ|歌ってほしい|歌唱検知|かわい|好き|鼻詰まり|照れ顔|最近|オケだけ|ざっぶーん|歌枠|リアクション|ハモリ|ライブ行って|イメージ|印象|共通点|接点|生放送|武道館|コラボ予定|チケット|キービジュアル|ジャケット写真|グッズ|スクショ|誕生日|ニッポン放送|写真投稿|試験|頑張る|またね)/iu.test(raw);
}

function isObviouslyNonSongActivityTitle(text) {
  if (/^\s*[A-Za-zぁ-んァ-ヶ一-龯々ー・\s]{2,}\s*[→⇒]\s*[A-Za-zぁ-んァ-ヶ一-龯々ー・\s]{2,}\s*$/u.test(text || "")) {
    return true;
  }
  return /(?:歌枠|リアクション|ハモリ|ライブ行って|イメージ|印象|共通点|接点|生放送|武道館|コラボ予定|チケット|キービジュアル|ジャケット写真|グッズ|スクショ|誕生日|ニッポン放送|写真投稿|試験|頑張る|またね|声がかかる|自己啓発|放送📻)/iu.test(text || "");
}

function isNonSongSectionPair(title, artist) {
  return Boolean(title && artist && isNonSongSectionMarker(title) && isNonSongSectionMarker(artist));
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
  if (!value || /^(歌名|歌手|编号|未確定|未确定)$/iu.test(value)) return true;
  if (TIMESTAMP_RE.test(value) && value.match(TIMESTAMP_RE)?.[0] === value) return true;
  if (!/[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/u.test(value)) return true;
  if (/^(talk|mc|雑談|聊天|感想|开场|開始|结束|終了|告知|返场|休息)$/iu.test(value)) return true;
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
  return songKey(left.title) === songKey(right.title) && Math.abs(left.seconds - right.seconds) <= 3;
}

function songKey(text) {
  return normalizeTimelineChars(stripTrailingLatinAnnotation(text))
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/[\[\]（）()【】「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨]/gu, "");
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
    .replace(/^[\s\u3000\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼→⇒]+/u, "")
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
    else if (depth === 0 && delimiters.includes(ch)) found = idx;
  }
  return found;
}

function isSpace(ch) {
  return /^[\s\u3000]$/.test(ch || "");
}

module.exports = {
  TIMESTAMP_RE,
  isTimestampCandidateText,
  normalizeCommentText,
  parseTimestampSongs,
  timeToSeconds,
};
