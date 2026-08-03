const { createHash } = require("node:crypto");
const { cleanSongTitleNoise, isBlockedSongEntry, isChatReactionShoutText } = require("../assets/source-filter");
const { isActivityMarkerTitle } = require("./curation");

const TIMESTAMP_RE = /(?<![\dA-Za-z_:])(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?!\d)/;
const STRICT_TITLE_ARTIST_DELIMITER = "\u2502";
const TIMESTAMP_TOKEN_RE = /(?<![\dA-Za-z_:])(?:[\[【(（]\s*)?(?:\d{1,2}:[0-5]\d:[0-5]\d|[0-5]?\d:[0-5]\d)(?:\s*[\]】)）])?(?!\d)/g;
const INDEX_RE =
  /^\s*(?:[⟦［\[]\s*#?[\d０-９]{1,3}\s*[⟧］\]]\s*|[#＃]?[\d０-９]{1,3}[)）、:：]\s*|[#＃]?[\d０-９]{1,3}[.．](?![\d０-９])\s*|[#＃]?[\d０-９]{1,3}\s+)/;
const SEPARATOR_CHARS = "/／|｜￤∣丨✦";
const NOA_POLARIS_SOURCE_CONTEXT_KEYS = new Set([
  "authorName",
  "candidate",
  "channel",
  "channelHandle",
  "channelName",
  "channelUrl",
  "discovery",
  "discoveryChannelUrl",
  "discoverySingerName",
  "discoverySourceUrls",
  "ownerUrl",
  "ownerUrls",
  "source",
  "sourceRecord",
  "sourceUrl",
  "sourceUrls",
  "title",
  "video",
  "videoTitle",
]);
const NOA_POLARIS_AIMER_START_ARTIST_RE =
  /^Aimer(?:[\s\u3000]+|[\s\u3000]*[\/／|｜￤∣丨✦:：\-—–−・･][\s\u3000]*)(?:start|star|スター|スタート)$/iu;
const BRACKET_OPEN = "([{（［【「『";
const BRACKET_CLOSE = ")]}）］】」』";
const OFFICIAL_ARTIST_NAMES = new Map([
  ["ado", "Ado"],
  ["deco27", "DECO*27"],
  ["yorushika", "ヨルシカ"],
  ["ヨルシカ", "ヨルシカ"],
  ["ヨルシカyorushika", "ヨルシカ"],
]);

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

function stableSourceRawHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function sourceLineRecords(text) {
  const value = String(text || "");
  const lines = [];
  let start = 0;
  let index = 0;
  while (index <= value.length) {
    const atEnd = index === value.length;
    const ch = value[index];
    if (!atEnd && ch !== "\n" && ch !== "\r") {
      index += 1;
      continue;
    }
    lines.push({
      text: value.slice(start, index),
      sourceLineOrdinal: lines.length + 1,
      sourceLineStartOffset: start,
    });
    if (atEnd) break;
    index += ch === "\r" && value[index + 1] === "\n" ? 2 : 1;
    start = index;
  }
  return lines;
}

function sourceInputRecord(comment, options = {}) {
  const source = comment && typeof comment === "object" ? comment : { text: comment };
  const text = typeof source.text === "string" ? source.text : "";
  return {
    text,
    sourceId: String(source.sourceId || options.sourceId || "").trim(),
    sourceHash: String(source.sourceHash || options.sourceHash || "").trim(),
    videoId: String(source.videoId || options.videoId || "").trim(),
  };
}

function parseTimestampSongs(comments, options = {}) {
  const songs = [];
  const onReject = typeof options.onReject === "function" ? options.onReject : null;
  for (const comment of comments || []) {
    const source = sourceInputRecord(comment, options);
    if (!source.text) continue;
    for (const rawLine of mergeSplitTimelineLines(source.text, { withSourcePosition: true })) {
      const line = String(rawLine.text || "").trim();
      const match = TIMESTAMP_RE.exec(line);
      if (!match) continue;
      const sourceStartOffset =
        Number.isInteger(rawLine.sourceStartOffset) ? rawLine.sourceStartOffset + match.index : null;
      const sourcePositionReady =
        Boolean(source.sourceId && source.sourceHash && source.videoId) && Number.isInteger(sourceStartOffset);

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
        sourceId: source.sourceId || null,
        sourceHash: source.sourceHash || null,
        rawHash: stableSourceRawHash(line),
        sourceLineOrdinal: rawLine.sourceLineOrdinal ?? null,
        sourceOccurrenceOrdinal: rawLine.sourceOccurrenceOrdinal ?? null,
        sourceStartOffset,
        position: sourceStartOffset,
        occurrenceId: sourcePositionReady ? `${source.videoId}:${sourceStartOffset}:${timeToSeconds(time)}` : null,
        needsReview: !sourcePositionReady,
      });
    }
  }
  const seenOccurrenceIds = new Map();
  for (const song of songs) {
    if (!song.occurrenceId) continue;
    const previous = seenOccurrenceIds.get(song.occurrenceId);
    if (previous) {
      previous.occurrenceId = null;
      previous.needsReview = true;
      previous.positionCollision = true;
      song.occurrenceId = null;
      song.needsReview = true;
      song.positionCollision = true;
      continue;
    }
    seenOccurrenceIds.set(song.occurrenceId, song);
  }
  return dedupeSongs(songs);
}

function normalizeParsedSong(song) {
  if (!song || typeof song !== "object") return song;
  const title = cleanSongOrArtistPart(song.title);
  let artist = cleanArtistMetadata(song.artist);
  if (!artist || artist === "未記載") artist = "未記載";
  else if (isLikelyWorkMetadata(artist)) artist = "未記載";
  return {
    ...song,
    title,
    artist,
  };
}

function normalizeSourceAwareArtist(song, sourceContext = {}) {
  if (!song || typeof song !== "object") return song;
  const artist = canonicalizeKnownArtistName(cleanArtistMetadata(song.artist));
  const baseSong = artist !== String(song.artist || "").trim() ? { ...song, artist } : song;
  if (!isNoaPolarisSourceContext(sourceContext) || !NOA_POLARIS_AIMER_START_ARTIST_RE.test(artist.normalize("NFKC"))) return baseSong;
  return {
    ...baseSong,
    artist: "Aimer",
    repair: baseSong.repair
      ? {
          ...baseSong.repair,
          changed: true,
          reasons: [...new Set([...(baseSong.repair.reasons || []), "source_aware_artist_normalization"])],
        }
      : baseSong.repair,
    sourceAwareArtistNormalization: {
      changed: true,
      reason: "noa_polaris_aimer_start_artist",
      originalArtist: artist,
    },
  };
}

function cleanArtistMetadata(text) {
  const original = String(text || "").trim();
  let value = original;
  for (let index = 0; index < 4; index += 1) {
    const next = value
      .replace(/\s*[\(（]\s*EN\s*:[^()（）]{1,160}[\)）]\s*$/iu, "")
      .replace(/\s*[\(（]\s*同接\d+(?:人|名)[^()（）]{0,80}[\)）]\s*$/u, "")
      .replace(/\s*※(?:Be Careful of Volume|音源一時停止有|音量注意|最後\d*秒音量注意)\s*$/iu, "")
      .trim();
    if (next === value) break;
    value = next;
  }
  return dropUnknownArtistParts(value || original);
}

function dropUnknownArtistParts(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  const parts = splitArtistParts(text);
  if (parts.length <= 1) return text;
  const realParts = parts.filter((part) => !isUnknownArtistField(part));
  return realParts.length && realParts.length < parts.length ? realParts.join(" / ") : text;
}

function splitArtistParts(value) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of String(value || "")) {
    if (BRACKET_OPEN.includes(char)) {
      depth += 1;
      current += char;
      continue;
    }
    if (BRACKET_CLOSE.includes(char)) {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth === 0 && /[\/／|｜￤∣丨、,，&＆+＋;；]/u.test(char)) {
      const part = current.trim();
      if (part) parts.push(part);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function canonicalizeKnownArtistName(value) {
  const text = stripArtistEmojiDecorations(String(value || "").trim());
  if (!text || isUnknownArtistField(text)) return text;
  return OFFICIAL_ARTIST_NAMES.get(artistOfficialKey(text)) || text;
}

function artistOfficialKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function stripArtistEmojiDecorations(value) {
  let text = String(value || "").trim();
  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/[:：]_[^\s\u3000:：/／|｜￤∣丨]+[:：]?/gu, " ")
      .replace(/(^|[\s\u3000])_[A-Za-z0-9][A-Za-z0-9_-]*[:：]?(?=$|[\s\u3000])/gu, " ")
      .replace(/^[\s\u3000\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F]+|[\s\u3000\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F]+$/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function isNoaPolarisSourceContext(sourceContext = {}) {
  return collectNoaPolarisSourceContextParts(sourceContext).some(isNoaPolarisSourceText);
}

function collectNoaPolarisSourceContextParts(value, parts = [], seen = new Set()) {
  if (value == null) return parts;
  if (typeof value === "string" || typeof value === "number") {
    parts.push(String(value));
    return parts;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNoaPolarisSourceContextParts(item, parts, seen);
    return parts;
  }
  if (typeof value !== "object" || seen.has(value)) return parts;
  seen.add(value);
  for (const key of NOA_POLARIS_SOURCE_CONTEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectNoaPolarisSourceContextParts(value[key], parts, seen);
  }
  return parts;
}

function isNoaPolarisSourceText(text) {
  const value = String(text || "").normalize("NFKC").trim();
  if (!value) return false;
  return /(?:^|[^A-Za-z0-9])Noa\s*Polaris(?:[^A-Za-z0-9]|$)/iu.test(value) || /@noa[._-]?polaris(?:\b|[/?#])/iu.test(value) || /ノア[\s\u3000・･.\-ー]*ポラリス/u.test(value);
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

function auditParsedSongForImport(song, source = {}) {
  const normalized = normalizeSourceAwareArtist(normalizeParsedSong(song), source);
  const title = String(normalized?.title || "").trim();
  const artist = String(normalized?.artist || "").trim();
  const raw = String(normalized?.raw || song?.raw || "");
  if (!title) return importAuditResult("drop", "missing_title", normalized);
  if (isExcludedImportSourceContext(source)) return importAuditResult("drop", "excluded_source_context", normalized);
  if (isBadSongField(title)) return importAuditResult("drop", "bad_title_field", normalized);
  if (artist && artist !== "未記載" && isBadSongField(artist)) return importAuditResult("drop", "bad_artist_field", normalized);
  if (hasResidualTimestampInSongFields(title, artist)) return importAuditResult("drop", "residual_timestamp", normalized);
  if (isSongRequestInstructionEntry(title, artist, raw)) return importAuditResult("drop", "song_request_instruction", normalized);
  if (isSuspiciousImportSongEntry(title, artist, raw)) return importAuditResult("suspicious", "suspicious_import_song_entry", normalized);
  if (isLikelyNonSongEntry(normalized, source)) return importAuditResult("drop", "likely_non_song_entry", normalized);
  return importAuditResult("accept", "", normalized);
}

function importAuditResult(action, reason, song) {
  return { action, reason, song };
}

function hasResidualTimestampInSongFields(title, artist) {
  return [title, artist].some((value) => {
    const text = String(value || "").trim();
    if (!text) return false;
    const match = text.match(TIMESTAMP_RE);
    return Boolean(match && (match[0] === text || /(?:^|[\s\u3000[(（［【])\d{1,2}:\d{2}/u.test(text)));
  });
}

function isSongRequestInstructionEntry(title, artist, raw) {
  const text = compactSignalText(`${title || ""}${artist || ""}${raw || ""}`);
  if (!text) return false;
  return /(?:曲名|歌名|歌手|アーティスト|原曲|原唱|セトリ|セットリスト|タイムスタンプ|概要欄|説明欄).{0,28}(?:教えて|ください|下さい|お願い|求む|募集|受付|確認|修正|追加|更新|まとめ|整理|不明|未記載|わからない|分からない|どこ|誰|です|ます)/iu.test(text);
}

function isSuspiciousImportSongEntry(title, artist, raw) {
  const hasArtist = !isUnknownArtistField(artist);
  const text = `${title || ""} ${artist || ""} ${raw || ""}`.normalize("NFKC");
  const normalizedTitle = String(title || "").normalize("NFKC").trim();
  const normalizedArtist = String(artist || "").normalize("NFKC").trim();
  if (
    (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u.test(normalizedTitle) && /^(?:live[\s/|:.-]+)?ao\s+vivo$/iu.test(normalizedArtist)) ||
    (/^【一般ライブ】\d{1,2}$/u.test(normalizedTitle) && /^[月火水木金土日]$/u.test(normalizedArtist)) ||
    (/^【マンデーバスターズ】/u.test(normalizedTitle) && isUnknownArtistField(normalizedArtist))
  ) return true;
  if (/^\s*(?:[\[【(（]\s*)?\d{1,3}(?:\s*[\]】)）])?\s*$/u.test(title) && /[一-龯ぁ-んァ-ヶA-Za-z]/u.test(artist)) return true;
  if (!hasArtist && /[「『《〈].{1,80}[」』》〉]/u.test(title) && /(?:説明|紹介|感想|告知|雑談|コメント|リクエスト|公開|正体)/u.test(text)) return true;
  return false;
}

function isExcludedImportSourceContext(source = {}) {
  const text = [
    source.title,
    source.videoTitle,
    source.channelName,
    source.channelHandle,
    source.channelUrl,
    source.sourceText,
    source.discoverySourceText,
  ]
    .map((value) => String(value || "").normalize("NFKC"))
    .join(" ");
  if (!text.trim()) return false;
  if (/(?:フルート|クラリネット|生演奏|piano streaming|ピアノ演奏)/iu.test(text)) return true;
  if (/(?:\blive\b|ライブ)/iu.test(text) && /(?:演奏|instrumental|performance|session|concert|recital)/iu.test(text)) return true;
  return false;
}

function isLikelyNonSongEntry(song, source = {}) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "");
  const combined = `${title} ${raw}`;
  const hasArtist = !isUnknownArtistField(artist);

  if (isCustomEmojiOnlyText(title)) return true;
  if (/^0\d+[.．]\d+(?:\s*[\/／].*)?$/u.test(title)) return true;
  if (isBlockedSongEntry({ title, artist, raw }, source)) return true;
  if (!hasArtist && isStandaloneNonSongMarker(title)) return true;
  if (!hasArtist && isChatReactionShoutText(title)) return true;
  if (isReactionActivityEntry(title, artist, raw)) return true;
  if (isShortReactionPseudoSongTitle(title, artist)) return true;
  if (isStandaloneNonSongMarker(title) && isSectionMarkerDescriptorArtist(artist)) return true;
  if (isCommentaryNonSongEntry(title, artist, raw)) return true;
  if (!hasArtist && /^(?:\d+次会|達成[!！]?|歌みたの話)$/u.test(title)) return true;
  if (!hasArtist && /^(?:(?:歌|配信)?枠)?\s*(?:start|stream\s*start|karaoke\s*start|開始)$/iu.test(title)) return true;
  if (/^(音入り|音入[り]?|声入り|マイクテスト|開始|終了|结束|結束|曲始まり|オープニング|エンディング|登場|退場|ゲスト|スパチャ読み|読み開始|コメント読み|告知|雑談|雑談タイム[!！]?|休憩|休憩[&＆]?雑談タイム|新しいOP画面|OP画面|OPトーク|待機OPstart|EDトーク|カンニングタイム(?:Part\d+)?|ただいま|まで)$/iu.test(title)) {
    return true;
  }
  if (/^雑談\s*[\/／|｜]\s*\S/u.test(title)) return true;
  const titleIsTalkPart = /^トークパート[①-⑳\d]*$/u.test(title);
  const artistIsTalkPart = /^トークパート[①-⑳\d]*$/u.test(artist);
  const titleIsSelfIntro = /^自己紹介(?:込み)?$/u.test(title);
  const artistIsSelfIntro = /^自己紹介(?:込み)?$/u.test(artist);
  if (
    titleIsTalkPart ||
    artistIsTalkPart ||
    (!hasArtist && titleIsSelfIntro) ||
    (titleIsSelfIntro && artistIsTalkPart) ||
    (artistIsSelfIntro && titleIsTalkPart) ||
    (isNoaPolarisSourceContext(source) && (titleIsSelfIntro || artistIsSelfIntro)) ||
    /^(?:曲入り前の解説|チューニング入ります)$/u.test(title)
  ) {
    return true;
  }
  if (/^(?:閉会式|開会式)$/u.test(title)) return true;
  if (/(?:曲始まり|オープニング|エンディング|登場|退場|スパチャ読み|コメント読み|チャット読み|ギフト(?:は)?読|読み開始|読み上げ|告知|宣伝|配信終了|配信開始|販売開始|オンライン販売|高評価|ch登録|チャンネル登録|登録者(?:数)?|視聴者|OBS|お手洗い休憩|チャットお題|\d+\s*達成|開始\s*[\/／]|虚空|クリックとは|クリックあるもの|ゲスト匂わせ|ゲストでよく呼ばれる|スパチャ|メモは紙|ライブでやる曲|チャンネルで.+歌ってみた|明日の曲について|ござるさん)/iu.test(combined)) {
    return true;
  }
  if (/(?:手で表現した|お写真公開|写真公開|ライブ開催決定|お披露目で.+やりたい|スタンドマイク回したかった)/iu.test(combined)) {
    return true;
  }
  if (!hasArtist && /^(?:本編開始|全曲終了|全曲结束|全曲結束|開始[・\s]?|終了[・\s]?|结束[・\s]?|結束[・\s]?|ライブ開催決定|特別ゲスト|突然の)/iu.test(title)) {
    return true;
  }
  if (!hasArtist && /(?:お話|話$|話①|話②|話題|裏話|スケジュール|おすすめ|コメント|チャット|ギフト|設定|手癖|腰|良い音|到着|ただいま|お土産|先生|予想|コンディション|休暇中|気圧|体調|配信|動画|映画|クリップ|バランス|読み|頑張|ありがとう|お疲れ|おつかれ)/iu.test(combined)) {
    return true;
  }
  if (!hasArtist && /(?:説明|自己紹介|告知|お知らせ|公開|正体|マイク|音声|音入り|声入り|曲名|歌手|アーティスト|リクエスト|セトリ|セットリスト|概要欄|説明欄)/iu.test(combined)) {
    return true;
  }
  if (!hasArtist && /(?:コミュニティは帰るべき場所|曲入り前の解説|チューニング入ります|明日夢かなえ入場|同接\d+(?:人|名)(?:突破|達成おめでとう)|縦型配信の機能|配信前のアクシデント|居酒屋で聞いて知った曲)/iu.test(combined)) {
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
  if ((!hasArtist && isDirtyNarrationText(title, raw)) || (hasArtist && isLikelyTranslationArtist(artist, title, raw))) {
    return true;
  }
  if (hasArtist && /^(咳払い|くしゃみ|雑談|告知|宣伝|休憩)$/iu.test(artist)) {
    return true;
  }
  if (hasArtist && isNarrationDescriptorArtist(artist) && isDirtyNarrationText(title, raw)) {
    return true;
  }
  return false;
}

function isNarrationDescriptorArtist(artist) {
  return /(?:事情|テーマ|EDテーマ|OPテーマ|トーク|話|雑談|告知|宣伝|説明|紹介)$/iu.test(String(artist || "").normalize("NFKC").trim());
}

function isSectionMarkerDescriptorArtist(artist) {
  const value = String(artist || "").normalize("NFKC").trim();
  if (!value) return true;
  if (isStandaloneNonSongMarker(value) || isNarrationDescriptorArtist(value)) return true;
  if (/^(?:Cパート|Cpart|エンドカード|おかえり|音量注意|最後\d*秒音量注意|うっかり|ちょっと待てぃ|ミュート|生写真チラ見せ)$/iu.test(value)) return true;
  return /(?:Cパート|Cpart|ミュート|生写真|チラ見せ)/iu.test(value);
}

function isDirtyNarrationText(title, raw) {
  const titleText = String(title || "").normalize("NFKC").trim();
  const text = compactSignalText(`${titleText} ${raw || ""}`);
  if (!text) return false;
  if (/^(?:YoutubePremium|AFK|awayfromkeyboard|take\d+|テイク\d+)$/iu.test(compactSignalText(titleText))) return true;
  if (/^(?:コメ|コメント)[「『"“].+[」』"”]$/u.test(compactSignalText(titleText))) return true;
  if (/(?:リスナー同士の結婚報告|なかったことにしよう|とてもくやしい|リクエストできる歌のリスト|妻を迎えに行かないと|久しぶりに来てまた食べ物の話|夏を感じる曲|喉が痛い|歌声禁斷症勢|譲り合い精神|突然3Dモデルがバグった|燃え尽きて消えた|包囲されたちびたん|会社をクビに|ガイドメロディが大きい|曲が増えた理由|飽きるまでずっと繰り返し|疑われちゃう可能性|ミニストップ行けよ|ビックリした|プレゼントが届きました|歌っている途中)/u.test(text)) {
    return true;
  }
  if (/(?:食べ物|食べる|飲む|飲酒|料理|メニュー|お酒|ビール|ハイボール|喉|病院|薬|体調|風邪|咳|くしゃみ|あくび|欠伸|衣装|髪型|職場|クイズ|ダンス|巻き舌|雰囲気|アパート|缶|マイク|カワハギ|干物|お金|人の心|体がバグ|著作権|ミュート|恋愛運|ペットショップ|ラー油|ケンタッキー|バーガーキング|酒のラベル|春が嫌い|カンニング|再確認|覚えてきた曲|ごらんください|ご覧ください|JOYSOUND|音楽停止)/iu.test(text) && /(?:話|痛い|行く|行け|届|した|する|です|ます|ちゃう|嫌い|[?？])/.test(text)) {
    return true;
  }
  if (/(?:メンシ|メンバーシップ|こそこそ話|爆音EDテーマ|就寝させない|取れてる|悲しい|事情)/iu.test(text)) return true;
  return /(?:でした|です|ます|ました|してる|している|したい|しよう|しない|できる|いけない|ちゃう|だった|だよ|だね|なの|かな|かも|理由|途中|可能性|報告|説明|紹介|翻訳|ヒント|問題|どこ|誰|なに|何|どう|なぜ|なんで|[?？])$/u.test(titleText);
}

function isLikelyTranslationArtist(artist, title, raw) {
  const artistText = String(artist || "").normalize("NFKC").trim();
  const titleText = String(title || "").normalize("NFKC").trim();
  const rawText = String(raw || "").normalize("NFKC");
  if (!artistText || !/[A-Za-z]/u.test(artistText)) return false;
  if (!/[一-龯ぁ-んァ-ヶ]/u.test(titleText)) return false;
  if (/[一-龯ぁ-んァ-ヶ]/u.test(artistText)) return false;
  if (!/[\/／]\s*[A-Za-z]/u.test(rawText)) return false;
  if (!isEnglishExplanationCredit(artistText)) return false;
  if (isDirtyShortGlossPair(titleText, artistText)) return true;
  if (isDirtyNarrationText(titleText, rawText)) return true;
  return /(?:した|して|する|です|ます|だった|でした|理由|途中|可能性|報告|届きました|痛い|大きい|消えた|バグった|行け|食べ|飲み|料理|喉|体調|病院|職場|衣装|髪型|クイズ|ダンス|巻き舌|雰囲気|アパート|集中してない|麻痺|缶|マイク|カワハギ|干物|お金|人の心|体がバグ|著作権|ミュート|恋愛運|JOYSOUND|音楽停止|曲|歌|リスナー|なれたん|ちびたん|[?？])/i.test(titleText);
}

function isDirtyShortGlossPair(title, artist) {
  const titleText = compactSignalText(title);
  const artistText = String(artist || "").normalize("NFKC").trim();
  if (/^(?:Yawn|Yawning|Pet Shop|Food Poisoning|Guide Melody|Hospital|Comment Section|Recommendations?|Using a Can as a Microphone|Dried Filefish|Muted Due to Copyright Issues)$/iu.test(artistText)) return true;
  return /^(?:あくび|欠伸|ペットショップ|食あたり|病院|コメント欄|ガイドメロディ|缶をマイクに|著作権の問題でミュートされています)$/u.test(titleText);
}

function isEnglishExplanationCredit(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  if (/^(?:Yawn|Yawning|Pet Shop|Food Poisoning|Guide Melody|Hospital|Comment Section|Recommendations?|Using a Can as a Microphone|Dried Filefish|Muted Due to Copyright Issues)$/iu.test(text)) return true;
  if (/^(?:I|I'm|I’m|You|We|They|It|That|This|There|A|An|The|Why|What|When|Where|How|Can|Will|Was|Were|For|Those|Things|Still|Collaboration|Did|My)\b/u.test(text)) return true;
  if (wordCount >= 4) return true;
  return /\b(?:Announcement|Apartment|Atmosphere|Background|Body|Bugging|Burger|Cheating|Chili|Community|Cooking|Copyright|Count|Dance|Filefish|Food|Drink|Gift|Guide Melody|Guinea|Hairstyle|Heart|Hospital|KFC|Korea|Label|Learned|Luck|Microphone|Money|Muted|Newly|Oil|Outfits?|Pet|Quiz|Rechecking|Recommendations|Rolled|Sake|Shop|Spring|Story|Stream|Comment|Chat|Song List|Practice|Swiss|Take a Look|Throat|Birthday|Surprised|Welcome|Workplace|Yawn|Yawning)\b/iu.test(text);
}

function compactSignalText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[!！?？。．.]+$/gu, "")
    .trim();
}

function isStandaloneNonSongMarker(text) {
  const value = normalizeStandaloneMarker(text);
  if (!value) return false;
  if (/^(?:op|ed|end|opening|ending|openingtalk|endingtalk|streamstart|streamend|streamended|karaokestart|karaokeend)$/iu.test(value)) return true;
  if (/^(?:setlist|timestamp|timestamps)$/iu.test(value)) return true;
  if (/^(?:本編開始|本編終了|全曲終了|全曲结束|全曲結束|配信開始|配信終了|開始|終了|结束|結束|セットリスト|セトリ|タイムスタンプ|曲名|歌唱開始時間)$/u.test(value)) return true;
  return false;
}

function normalizeStandaloneMarker(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[【】[\]「」『』"'“”‘’]/gu, "")
    .replace(/^[\s~〜～・･:：\-—–−/／|｜￤∣丨]+|[\s~〜～・･:：\-—–−/／|｜￤∣丨]+$/gu, "")
    .replace(/[\s~〜～・･:：\-—–−/／|｜￤∣丨]+/gu, "")
    .trim();
}

function isCommentaryNonSongEntry(title, artist, raw) {
  const hasArtist = !isUnknownArtistField(artist);
  const titleIsCommentary = isCommentaryNonSongText(title);
  if (isNaraetanSelfReference(`${title || ""} ${artist || ""} ${raw || ""}`) && !isKnownSongSafeFromCommentary(title, artist)) return true;
  if (!hasArtist && (titleIsCommentary || isCommentaryNonSongText(raw) || isNaraetanSelfReference(title) || isTopicLikeBilingualCommentary(title, artist, raw))) return true;
  if (titleIsCommentary && (isCommentaryNonSongText(artist) || isSentenceLikeCredit(artist))) return true;
  if (isNaraetanSelfReference(title) && !hasStructuredSongNumber(raw)) return true;
  if (isTopicLikeBilingualCommentary(title, artist, raw)) return true;
  return false;
}

function isCommentaryNonSongText(text) {
  const value = String(text || "")
    .normalize("NFKC")
    .replace(/[:：]_[^\s　:：]+[:：]?/gu, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]/gu, "")
    .replace(/\s+/gu, "")
    .replace(/[!！?？。．.]+$/gu, "")
    .trim();
  if (!value) return false;
  if (/^(?:コメ|コメント|米)[「『"].{1,80}[」』"]$/iu.test(value)) return true;
  if (/^(?:アンケート|投票)(?:結果|タイム|中|する|して|お願いします|お願い)?(?:[（(].{1,80}[）)])?$/u.test(value)) return true;
  if (/^(?:リクエスト|リク)(?:募集|確認|受付|タイム|ください|下さい|募集中|受付中|ok|OK)?$/iu.test(value)) return true;
  if (/^(?:コメント|コメ)(?:読み|欄|確認|返信|返し|して|ください|下さい|募集中|歓迎)$/iu.test(value)) return true;
  if (/^(?:配信|歌枠)(?:開始|終了|予定|告知|中|について|ありがとう|お疲れさま?|おつかれさま?)$/iu.test(value)) return true;
  if (/コミュニティは帰るべき場所/u.test(value)) return true;
  if (/(?:セトリ|セットリスト|タイムスタンプ|概要欄|説明欄|曲名|歌手|アーティスト).{0,24}(?:です|ます|ください|下さい|お願い|教えて|確認|修正|追加|更新|まとめ|整理|不明|未記載|わからない|分からない)/iu.test(value)) return true;
  if (/(?:初見|はじめまして).{0,20}(?:いらっしゃい|歓迎|ようこそ)/iu.test(value)) return true;
  if (/(?:なれコール)?アンケート|歌詞考察|曲紹介(?:タイム)?/u.test(value)) return true;
  if (/喉(?:が|は)?(?:痛い|いたい|不調|治らない|やられた|終わった)|のど(?:が|は)?(?:痛い|いたい|不調)|喉の調子(?:が|は)?/iu.test(value)) return true;
  if (/^(?:なれたん|naraetan)(?:は|が|の|も|って|です|だよ|である|自称|説明|自己紹介|について).{0,60}$/iu.test(value)) return true;
  return false;
}

function isTopicLikeBilingualCommentary(title, artist, raw) {
  const titleText = String(title || "").trim();
  const artistText = String(artist || "").trim();
  const rawText = String(raw || "");
  const combined = `${titleText} ${artistText} ${rawText}`;
  if (isKnownSongSafeFromCommentary(titleText, artistText)) return false;
  if (isJapaneseTopicTitleWithEnglishGloss(titleText, artistText)) return true;
  if (hasStructuredSongNumber(rawText) && !isCommentaryNonSongText(titleText)) return false;
  if (/(?:話|理由|コメント|コメ|リクエスト|アンケート|おすすめ|おススメ|喉|のど|配信|動画|練習|噛|食べ|飲み|料理|旅行|友達|家族|姉|妹|幼馴染|指|身長|リップ|フリ|視聴者|収益化|チャンネル|スーパー|キーボード|アレルギー|リスナー|歌声|サビ|歌詞|体調|病院|歯磨き|うがい|買い物|職場|謝|絵文字|プレゼント|写真|踏んで|海遊館|衣装|髪型|クイズ|ダンス|巻き舌|雰囲気|アパート|集中してない|麻痺|缶|マイク|カワハギ|干物|お金|人の心|体がバグ|著作権|ミュート|恋愛運|joysound|音楽停止|セトリ|セットリスト|タイムスタンプ|概要欄|説明欄|曲名|歌手|アーティスト|初見|はじめまして|いらっしゃい|歓迎|決まって|教えて|お願い|開始|終了)/iu.test(combined)) {
    return isTopicLikeTitle(titleText) || isSentenceLikeTitle(titleText) || isSentenceLikeCredit(artistText) || isCommentaryNonSongText(titleText) || isCommentaryNonSongText(artistText);
  }
  return isSentenceLikeTitle(titleText) && isSentenceLikeCredit(artistText);
}

function isJapaneseTopicTitleWithEnglishGloss(title, artist) {
  const titleText = String(title || "").trim();
  const artistText = String(artist || "").trim();
  if (!titleText || !artistText || !containsJapanese(titleText) || containsJapanese(artistText)) return false;
  if (!isEnglishGlossLikeText(artistText)) return false;
  if (isCommentaryNonSongText(titleText) || isTopicLikeTitle(titleText) || isSentenceLikeTitle(titleText)) return true;
  return /(?:op|ed|opening|ending|雑談|日常|閑談|問候|挨拶|感想|紹介|説明|韓国|韓国人|日本|日本語|英語|発音|長音|病院|食|飯|飲|茶|酒|炭酸|ドリンク|餅|音楽停止|クリック|おすすめ|曲紹介|歌詞考察|考察|アンケート|リクエスト|お知らせ|告知|bgm|コメント|コメ|コミュニティ|家族|両親|姉|妹|幼馴染|身長|指|チャンネル|登録|美容院|カラオケ|ドラマ|お土産|夢|広告|写真|リスク|違い|難しい|ちゃんぽん|キムチ|ソーマ|体調|歯磨き|うがい|買い物|職場|謝|絵文字|プレゼント|踏んで|海遊館|大阪の話|衣装|髪型|クイズ|ダンス|巻き舌|雰囲気|アパート|集中してない|麻痺|料理|メニュー|缶|マイク|カワハギ|干物|お金|人の心|体がバグ|著作権|ミュート|恋愛運|joysound|セトリ|セットリスト|タイムスタンプ|概要欄|説明欄|曲名|歌手|アーティスト|初見|はじめまして|いらっしゃい|歓迎|決まって|教えて|お願い|開始|終了)/iu.test(titleText);
}

function isEnglishGlossLikeText(text) {
  const value = String(text || "").normalize("NFKC").trim();
  if (!value || containsJapanese(value) || !containsLatin(value)) return false;
  if (!/^[A-Za-z0-9 .,:'’"“”&+_\-/!?~()[\]#]+$/u.test(value)) return false;
  const words = value.match(/[A-Za-z][A-Za-z'’]*/gu) || [];
  if (!words.length || words.length > 18) return false;
  if (isSentenceLikeCredit(value)) return true;
  if (/[?？]$/.test(value) || /\([^)]{3,80}\)/u.test(value)) return true;
  return /\b(?:about|accidental|accented|ad|alcohol|announcement|anime|apartment|atmosphere|attack|background|ballad|body|bugging|burger|carbonated|catchy|cheating|chili|click|commercial|community|cooking|copyright|count|dance|decided|description|descriptions?|differences?|difficult|dream|drink(?:ing)?|filefish|first-time|food|gift|greeting|guinea|hairstyle|heart|hello|hospital|introduced?|introducing|japanese|kfc|korean|korea|label|learned|luck|marks?|microphone|money|music|muted|newly|oil|outfits?|parents?|pet|picture|please|poisoning|poll|popular|pronunciation|quiz|rechecking|recommendations?|recently|request|rice|risks?|rolled|sake|salon|setlist|shop|song|songs|souvenirs?|spring|stops?|swiss|tea|temptation|timestamps?|traditional|vowel|watched|welcome|workplace)\b/iu.test(value);
}

function isKnownSongSafeFromCommentary(title, artist) {
  const titleText = String(title || "").trim();
  const artistText = String(artist || "").trim();
  if (/星座になれたら/u.test(titleText)) return true;
  if (/^(?:ENDLESS STORY|Never Ending Story|Opening|Ending)$/iu.test(titleText) && artistText && artistText !== "未記載") return true;
  if (/^START:DASH!!$/iu.test(titleText) && artistText && artistText !== "未記載") return true;
  return false;
}

function isNaraetanSelfReference(text) {
  return /(?:なれたん|naraetan)/iu.test(String(text || ""));
}

function hasStructuredSongNumber(raw) {
  const value = String(raw || "").replace(/^\s*(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*/u, "");
  return /(?:^|[\s　])#?\d{1,3}\s*[.)．、）:：]/u.test(value) || /(?:^|[\s　])#\d{1,3}\s+/u.test(value);
}

function isSentenceLikeTitle(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value.length >= 18 && /(?:だった|でした|です|ます|して|した|する|され|たい|ない|ある|いる|なる|なった|くる|行く|来る|思う|忘れ|信じ|疑う|食べ|飲み|寝て|痛い|怖い|楽しい|辛い|欲しい|ください|お願い|かな|ですね|ですよ|だよ|なの|のか|のは|とは|って|コメ|コメント)/u.test(value)) return true;
  return /^(?:[^/／|｜]{1,40})(?:\?|？)$/u.test(value) && /(?:なれたん|人|何|どこ|いる|する|です|ます|なの|のか)/u.test(value);
}

function isTopicLikeTitle(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /(?:おすすめ.*(?:集|紹介)|曲紹介|歌うフリ|(?:姉|妹|幼馴染).*(?:or|または)|指が細い|身長が低い|家族に例える)/iu.test(value);
}

function isSentenceLikeCredit(text) {
  const value = String(text || "").trim();
  if (!value || value === "未記載") return false;
  if (/^(?:Recommended|Poll:|Are you trying|I envy|I(?:’|'|)ll pretend|Older Sister|Younger Sister|.+\?)\b/iu.test(value)) return true;
  if (value.length >= 24 && /\s/u.test(value) && /\b(?:i|you|we|my|your|the|a|an|to|that|this|was|were|is|are|be|being|been|have|has|had|do|does|did|can|can't|cannot|will|want|trying|because|with|from|about|people|song|comment|viewers|family|friend|reason|recommended|pretend|believe|forgot)\b/iu.test(value)) return true;
  return value.length >= 18 && /(?:だった|でした|です|ます|して|した|する|され|たい|ない|ある|いる|なる|なった|くる|行く|来る|思う|忘れ|信じ|疑う|食べ|飲み|痛い|怖い|欲しい|ください|お願い|ですね|ですよ|だよ|なの|のか|のは|とは|って)/u.test(value);
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

function isShortReactionPseudoSongTitle(title, artist) {
  const value = normalizeReactionActivityText(title);
  if (/^(?:くしゃみ|助かる|たすかる|がち恋距離助かる|ガチ恋距離助かる)$/iu.test(value)) return true;
  if (isUnknownArtistField(artist) && isCompoundShortReactionPseudoTitle(value)) return true;
  return /ここすき$/u.test(value) && isUnknownArtistField(artist);
}

function isCompoundShortReactionPseudoTitle(value) {
  if (!value || value.length > 24) return false;
  if (/(?:くしゃみ|咳払い|せき払い|咳).{0,10}(?:助かる|たすかる)(?:んだワ|んだわ|[ー〜～]*)?$/iu.test(value)) return true;
  return /^(?:圧|バカ|ばか|ちゅ|ちゅー|めっちゃ|とても|大変)?(?:助かる|たすかる)$/iu.test(value);
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
  const strict = parseStrictTitleArtist(text);
  if (strict) return strict;
  if (String(text || "").includes(STRICT_TITLE_ARTIST_DELIMITER)) {
    return [cleanSongOrArtistPart(text), "未記載"];
  }
  const parsed = extractSongArtistCore(text);
  if (parsed) return parsed;
  const symbolicPerformer = extractTitleWithSymbolicPerformer(text);
  if (symbolicPerformer) return symbolicPerformer;
  return [cleanSongOrArtistPart(text), "未記載"];
}

function parseStrictTitleArtist(text) {
  const value = String(text || "").trim();
  const delimiterCount = [...value].filter((char) => char === STRICT_TITLE_ARTIST_DELIMITER).length;
  if (delimiterCount !== 1) return null;
  const index = value.indexOf(STRICT_TITLE_ARTIST_DELIMITER);
  const rawTitle = value.slice(0, index).trim();
  const rawArtist = value.slice(index + STRICT_TITLE_ARTIST_DELIMITER.length).trim();
  if (!rawTitle || !rawArtist) return null;
  const title = cleanSongOrArtistPart(rawTitle);
  const artist = cleanArtistPart(rawArtist);
  if (!title || !artist || isBadSongField(title) || isBadSongField(artist)) return null;
  return [title, artist];
}

function extractTitleWithSymbolicPerformer(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(.+?)\s*[\/／|｜￤∣丨]\s*[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F\s・･×+＆&、,]+$/u);
  if (!match) return null;
  const title = cleanSongOrArtistPart(match[1]);
  return title && !isBadSongField(title) ? [title, "未記載"] : null;
}

function sourceTimelineLine(text, source, sourceStartOffset = null, sourceOccurrenceOrdinal = null) {
  return {
    text,
    sourceLineOrdinal: source?.sourceLineOrdinal ?? null,
    sourceOccurrenceOrdinal,
    sourceStartOffset,
  };
}

function splitCollapsedTimelineLineWithSourcePosition(sourceLine) {
  const original = String(sourceLine?.text || "");
  const normalized = normalizeTimelineChars(original).trim();
  if (!normalized) return [];
  const leadingTrim = original.length - original.trimStart().length;
  const timestampRegex = new RegExp(TIMESTAMP_RE.source, "gu");
  const matches = [...normalized.matchAll(timestampRegex)];
  if (matches.length <= 1) {
    const match = matches[0];
    return [
      sourceTimelineLine(
        normalized,
        sourceLine,
        match ? (sourceLine.sourceLineStartOffset ?? 0) + leadingTrim : null,
        match ? 1 : null,
      ),
    ];
  }
  const chunks = [];
  const prefix = normalized.slice(0, matches[0].index).trim();
  if (prefix) chunks.push(sourceTimelineLine(prefix, sourceLine, null, null));
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? normalized.length;
    const chunk = normalized.slice(start, end).trim();
    if (!chunk) continue;
    chunks.push(
      sourceTimelineLine(
        chunk,
        sourceLine,
        (sourceLine.sourceLineStartOffset ?? 0) + leadingTrim + start,
        index + 1,
      ),
    );
  }
  return chunks;
}

function mergeSplitTimelineLinesWithSourcePosition(text) {
  const lines = [];
  for (const sourceLine of sourceLineRecords(text)) {
    lines.push(...splitCollapsedTimelineLineWithSourcePosition(sourceLine));
  }
  const lineText = (line) => String(line?.text || "").trim();
  const merged = [];
  const push = (textValue, sourceLine) => {
    const text = String(textValue || "").trim();
    if (text) merged.push(sourceTimelineLine(text, sourceLine, sourceLine?.sourceStartOffset ?? null, sourceLine?.sourceOccurrenceOrdinal ?? null));
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lineText(lines[index]);
    const next = lineText(lines[index + 1]);
    const next2 = lineText(lines[index + 2]);
    const next3 = lineText(lines[index + 3]);
    if (
      /^\d{1,3}$/.test(line) &&
      isStartTimestampMarkerLine(next) &&
      isTimestampOnlyLine(next2) &&
      next3 &&
      !isTimestampOnlyLine(next3) &&
      !isObviouslyNonSongText(next3)
    ) {
      const timestamp = extractPrimaryTimestamp(next);
      if (timestamp) push(`${timestamp} ${next3}`, lines[index + 1]);
      index += 3;
      continue;
    }
    if (isSongArtistOnlyLine(line) && isTimestampOnlyLine(next)) {
      const timestamp = extractPrimaryTimestamp(next);
      if (timestamp) push(`${timestamp} ${line}`, lines[index + 1]);
      index += 1;
      continue;
    }
    if (isTimestampOnlyLine(line)) {
      const timestamp = extractPrimaryTimestamp(line);
      if (timestamp && next && !isTimestampOnlyLine(next) && !isObviouslyNonSongText(next)) {
        push(`${timestamp} ${next}`, lines[index]);
        index += 1;
        continue;
      }
    }
    push(line, lines[index]);
  }
  return merged;
}

function mergeSplitTimelineLines(text, options = {}) {
  if (options.withSourcePosition) return mergeSplitTimelineLinesWithSourcePosition(text);
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

function splitCollapsedTimelineLine(line, options = {}) {
  if (options.withSourcePosition) {
    return splitCollapsedTimelineLineWithSourcePosition({
      text: line,
      sourceLineOrdinal: options.sourceLineOrdinal,
      sourceLineStartOffset: options.sourceLineStartOffset,
    });
  }
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
  if (/^(開始|歌唱開始|歌唱開始時間|歌唱開始時刻|结束|結束|終了|end|start|op|ed|opening|ending|オープニング|エンディング|エンドカード|intro|outro|set\s*list|setlist|セットリスト|セトリ|タイムスタンプ|曲名|talk|talk[_-]?\d+|mc|雑談|聊天|感想|告知|返场|休息|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|読み開始|ただいま)$/iu.test(value)) {
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
  if (/^(?:(?:配信|stream|karaoke)?start|starting|op|ed|end|opening|ending|オープニング|エンディング|エンドカード|intro|outro|setlist|セットリスト|セトリ|タイムスタンプ|曲名|歌唱開始|歌唱開始時間|歌唱開始時刻|edtalk|optalk|talk\d*|mc|雑談|雑談タイム|新しいop画面|op画面|edトーク|休憩雑談タイム|カンニングタイム(?:part\d+)?|告知|お知らせ|声入り|ご挨拶|挨拶|アナウンス|自己紹介|幕開け|スタート|アカペラver|はのは[ー〜～]*|読み開始|ただいま)$/iu.test(value)) {
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
  return /^(opening|open|op|start|starting|intro|introduction|幕開け|開幕|開始|オープニング|声入り|ご挨拶|挨拶|アナウンス|自己紹介|closing|close|end|ending|ed|outro|閉幕|終幕|終了|结束|結束|エンディング|エンドカード)$/iu.test(key);
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
  if (/^(talk|mc|雑談|聊天|感想|开场|開始|歌唱開始|歌唱開始時間|歌唱開始時刻|结束|結束|終了|告知|返场|休息|set\s*list|setlist|セットリスト|セトリ|タイムスタンプ)$/iu.test(value)) return true;
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
  return deduped.sort(
    (a, b) =>
      a.seconds - b.seconds ||
      (Number.isInteger(a.sourceStartOffset) ? a.sourceStartOffset : Number.MAX_SAFE_INTEGER) -
        (Number.isInteger(b.sourceStartOffset) ? b.sourceStartOffset : Number.MAX_SAFE_INTEGER),
  );
}

function isNearDuplicateSong(left, right) {
  if (
    left?.occurrenceId ||
    right?.occurrenceId ||
    Number.isInteger(left?.sourceStartOffset) ||
    Number.isInteger(right?.sourceStartOffset)
  ) {
    return false;
  }
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
  auditParsedSongForImport,
  isTimestampCandidateText,
  isLikelyNonSongEntry,
  cleanArtistMetadata,
  normalizeCommentText,
  normalizeParsedSong,
  normalizeSourceAwareArtist,
  parseTimestampSongs,
  timeToSeconds,
};
