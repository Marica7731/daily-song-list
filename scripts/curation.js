const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { entryRepairSignals } = require("./entry-repair");
const { normalizeArtistKey, normalizeSongTitleKey } = require("../assets/ranking-utils");
const { isBlockedSongEntry, isChannelScopedUnknownArtistDirtySong, isSingletonPseudoSongEntry } = require("../assets/source-filter");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const OVERRIDES_PATH = path.join(CONFIG_DIR, "curation-overrides.json");
const NON_SONG_RULES_PATH = path.join(CONFIG_DIR, "non-song-rules.json");
const UNKNOWN_ARTIST_KEYS = new Set(["", "unknown", "n/a", "na", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補", "-"]);
const VALID_ACTIONS = new Set(["drop_entry", "replace_entry", "reject_source", "force_refresh", "drop_video", "force_keep"]);
const ENTRY_ACTIONS = new Set(["drop_entry", "replace_entry", "force_keep"]);
const SOURCE_ACTIONS = new Set(["reject_source"]);
const NEAR_DUPLICATE_WINDOW_SECONDS = 30;

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
    activityTitlePatterns: Array.isArray(rules.activityTitlePatterns) ? rules.activityTitlePatterns.map((value) => String(value || "").trim()).filter(Boolean) : [],
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
  if (record.action === "force_refresh") return `refresh:${record.videoId}`;
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
  return UNKNOWN_ARTIST_KEYS.has(normalizeUnknownArtistKey(artist));
}

function normalizeUnknownArtistKey(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isActivityMarkerTitle(title, artist, rules = loadNonSongRulesSafe(), options = {}) {
  if (options.knownSong === true) return false;
  if (!isUnknownArtist(artist)) return false;
  const normalizedTitle = normalizeCurationTitle(title);
  const exactTitles = Array.isArray(rules.exactUnknownArtistTitles) ? rules.exactUnknownArtistTitles : [];
  return exactTitles.includes(normalizedTitle) || matchesActivityTitlePattern(title, rules);
}

function isCandidateActivityTitle(title, rules = loadNonSongRulesSafe()) {
  const normalizedTitle = normalizeCurationTitle(title);
  const exactTitles = Array.isArray(rules.exactUnknownArtistTitles) ? rules.exactUnknownArtistTitles : [];
  const candidateTitles = Array.isArray(rules.candidateActivityTitles) ? rules.candidateActivityTitles : [];
  return (
    exactTitles.includes(normalizedTitle) ||
    candidateTitles.includes(normalizedTitle) ||
    matchesActivityTitlePattern(title, rules)
  );
}

function matchesActivityTitlePattern(title, rules = loadNonSongRulesSafe()) {
  const value = String(title || "").normalize("NFKC").trim();
  for (const pattern of rules.activityTitlePatterns || []) {
    try {
      if (new RegExp(pattern, "iu").test(value)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function isConversationEntry(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "");
  const value = normalizeConversationText(title);
  if (!value) return false;
  if (isStrongNonSongActivityText(value) || isStrongNonSongActivityText(raw) || isStrongNonSongActivityText(`${title} ${artist}`)) return true;
  if (!isUnknownArtist(artist)) return false;
  if (isCommentaryNoiseConversationText(value) || isCommentaryNoiseConversationText(raw)) return true;
  if (isEmojiOrReactionOnly(title)) return true;
  if (/^(?:や|やー|やあ|やほ|やっほ|わあ|あ|え|お|ん|うん|はい|ええ)[…~〜～!！?？。.\s]*$/iu.test(value)) return true;
  if (/^「.+」$/u.test(value) || /「.+」/u.test(raw)) return true;
  if (/[?？]$/u.test(value)) return true;
  if (/(?:について|のお話|問題|しよう|している|していない|だった|でした|です|ます|ありがとう|おめでとう|気がする|したい|したいな|してほしい|してください|してあげる|ちゃうね|なんで|かな|かも|だよ|だね|なの|か)$/iu.test(value)) return true;
  if (/(?:背景を変える|横に置く|食べる|飲む|お名前呼び|配信告知|チャンネル登録|スパチャ|メンシ|スクショ|サムネ|写真|告知|登録|コメント|ギフト|リクエスト|メンバー|キャンペーン|アルバム発売記念|おすすめ.*(?:集|紹介)|曲紹介|歌うフリ|姉|妹|幼馴染|指が細い|身長が低い|家族に例える)/iu.test(value)) return true;
  if (/(?:クッキング|ケーキ|テーマは|浮かれて|よっこいしょ|歌声|地声|バラード|透明感|触れれる|楽しそう|褒め合って|適正性|サイレン|プロポーズ|結婚|苗字|謝罪|わさび事件|始まりました|終了|さんとの|発売記念|開催|次(?:の)?バトンは|次は.+ちゃん|嫁|お嫁|問候|挨拶|日常|近況)/iu.test(value)) return true;
  if (/^(?:おはよう|おはよ|こんにちは|こんばんは|こん[\p{Letter}\p{Number}ー~〜～]{2,20}|おつ[\p{Letter}\p{Number}ー~〜～]{1,24}|またね|ばいばい|bye)$/iu.test(value)) return true;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(title) && title.length <= 18) return true;
  return /(?:について|のお話|問題|しよう|している|していない|だった|でした|です|ます)/iu.test(raw);
}

function isCommentaryNoiseConversationText(text) {
  const value = normalizeConversationText(text).replace(/[!！?？。．.]+$/gu, "");
  if (!value) return false;
  if (/^(?:コメ|コメント|米)[「『"].{1,80}[」』"]$/iu.test(value)) return true;
  if (/^(?:アンケート|投票)(?:結果|タイム|中|する|して|お願いします|お願い)?(?:[（(].{1,80}[）)])?$/u.test(value)) return true;
  if (/^(?:リクエスト|リク)(?:募集|確認|受付|タイム|ください|下さい|募集中|受付中|ok|OK)?$/iu.test(value)) return true;
  if (/^(?:コメント|コメ)(?:読み|欄|確認|返信|返し|して|ください|下さい|募集中|歓迎)$/iu.test(value)) return true;
  if (/^(?:配信|歌枠)(?:開始|終了|予定|告知|中|について|ありがとう|お疲れさま?|おつかれさま?)$/iu.test(value)) return true;
  if (/(?:なれコール)?アンケート|歌詞考察|曲紹介(?:タイム)?/u.test(value)) return true;
  if (/喉(?:が|は)?(?:痛い|いたい|不調|治らない|やられた|終わった)|のど(?:が|は)?(?:痛い|いたい|不調)|喉の調子(?:が|は)?/iu.test(value)) return true;
  if (/^(?:なれたん|naraetan)(?:は|が|の|も|って|です|だよ|である|自称|説明|自己紹介|について).{0,60}$/iu.test(value)) return true;
  if (/なれたん/u.test(value)) return true;
  return false;
}

function isStrongNonSongActivityText(value) {
  const text = String(value || "").normalize("NFKC").replace(/[\s\u3000]+/gu, "").replace(/[!！?？。．.]+$/gu, "");
  if (!text) return false;
  if (/^(?:YoutubePremium|AFK|awayfromkeyboard|take\d+|テイク\d+)$/iu.test(text)) return true;
  if (/^(?:練習|practice).{2,}$/iu.test(text)) return true;
  if (/^(?:本編|歌パート|閉会式|復習タイム|練習パート)(?:開始|終了)$/u.test(text)) return true;
  if (/^(?:たすかる|バカたすかる|はのぴょ[ー〜～]*ん|ぴょのは[ー〜～]*|はのみくり[ー〜～]*ん)$/iu.test(text)) return true;
  if (/(?:歌みた|歌ってみた).*(?:こだわり|話|紹介|ポイント)/u.test(text)) return true;
  if (/^大阪の話[①-⑳\d:：].+$/u.test(text)) return true;
  if (/^(?:コメ|コメント)[「『"“].+[」』"”]$/u.test(text)) return true;
  if (/^(?:閉会式|閉会|開会式)(?:も?(?:見てください|みてください|見てね|みてね))?$/u.test(text)) return true;
  if (/^\d+を手で表現した$/u.test(text)) return true;
  if (/(?:周年記念)?(?:お)?写真公開/u.test(text)) return true;
  if (/3Dライブ開催決定/u.test(text)) return true;
  if (/3Dお披露目でスタンドマイク回したかった/u.test(text)) return true;
  if (/\d{1,2}[\/／]\d{1,2}.+(?:出演決定|開催決定|フェス|イベント|告知)/u.test(text)) return true;
  if (/(?:アルバム)?発売記念キャンペーン開催/u.test(text)) return true;
  if (/(?:地声|歌声|バラード).+(?:すごい|合ってる|透明感)/u.test(text)) return true;
  if (/(?:免許の適正性|声がサイレン|楽しそう|触れれる|褒め合って体にいい|難しい曲を挑戦|花火大会.*行きたい|すぐ会えるよって意味で歌いたい|謝罪会見|改めて謝罪|ばいちょろり.*終了|マリパのわさび事件)/u.test(text)) {
    return true;
  }
  if (/(?:リスナー同士の結婚報告|なかったことにしよう|とてもくやしい|リクエストできる歌のリスト|妻を迎えに行かないと|久しぶりに来てまた食べ物の話|夏を感じる曲|喉が痛い|歌声禁斷症勢|譲り合い精神|突然3Dモデルがバグった|燃え尽きて消えた|包囲されたちびたん|会社をクビに|ガイドメロディが大きい|曲が増えた理由|飽きるまでずっと繰り返し|疑われちゃう可能性|ミニストップ行けよ|ビックリした|プレゼントが届きました|歌っている途中)/u.test(text)) {
    return true;
  }
  if (/(?:食べ物|食べる|飲む|飲酒|お酒|ビール|ハイボール|喉|病院|薬|体調|風邪|咳|くしゃみ|あくび|欠伸)/u.test(text) && /(?:話|痛い|行く|行け|届|した|する|です|ます|ちゃう|[?？])/.test(text)) {
    return true;
  }
  return false;
}

function normalizeConversationText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[:：]_[^\s　:：]+[:：]?/gu, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]/gu, "")
    .replace(/\s+/g, "")
    .trim();
}

function isEmojiOrReactionOnly(text) {
  const value = normalizeConversationText(text).replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  return Boolean(value && value.length <= 4 && !/[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(value));
}

function isParserCorruptionEntry(song) {
  const raw = String(song?.raw || "").normalize("NFKC");
  const title = String(song?.title || "").normalize("NFKC").trim();
  if (!raw || !title) return false;
  const decimalMatches = raw.match(/\b\d+(?:\.\d+)+(?:[^\s/／|｜]*)?/gu) || [];
  for (const candidate of decimalMatches) {
    if (!candidate || title === candidate || title.startsWith(candidate)) continue;
    const truncated = candidate.replace(/^\d+\./u, "");
    if (title === truncated || title.startsWith(truncated)) return true;
  }
  return false;
}

function classifyEntry(song, options = {}) {
  const knownSong = options.knownSong === true || (typeof options.knownSongMatcher === "function" && options.knownSongMatcher(song));
  const unknownArtist = isUnknownArtist(song?.artist);
  const signals = song?.curationSignals || entryRepairSignals(song);
  if (isChannelScopedUnknownArtistDirtySong(song, options.video)) {
    return { classification: "confirmed_noise", suggestedAction: "drop_entry", riskReasons: ["channel_scoped_unknown_artist_dirty_source"] };
  }
  if (!knownSong && signals?.suppressLikelySong) {
    const reasons = signals.reasons?.length ? signals.reasons : ["non_song_signal"];
    const classification = reasons.some((reason) => reason === "custom_emoji_only" || reason === "reaction_text_only") ? "likely_noise" : "confirmed_noise";
    return { classification, suggestedAction: "drop_entry", riskReasons: reasons };
  }
  if (isParserCorruptionEntry(song)) {
    return { classification: "parser_corruption", suggestedAction: "replace_entry", riskReasons: ["parser_corruption"] };
  }
  if (unknownArtist && !knownSong && isActivityMarkerTitle(song?.title, song?.artist, options.rules || loadNonSongRulesSafe())) {
    return { classification: "confirmed_noise", suggestedAction: "drop_entry", riskReasons: ["activity_marker_title"] };
  }
  if (!knownSong && isConversationEntry(song)) {
    return { classification: "likely_noise", suggestedAction: "drop_entry", riskReasons: ["conversation_entry"] };
  }
  if (!knownSong && isBlockedSongEntry(song, options.video)) {
    return { classification: "confirmed_noise", suggestedAction: "drop_entry", riskReasons: ["blocked_song_entry"] };
  }
  if (!knownSong && isSingletonPseudoSongEntry(song, options.titleStats)) {
    return { classification: "likely_noise", suggestedAction: "drop_entry", riskReasons: ["singleton_pseudo_song_entry"] };
  }
  if (unknownArtist && knownSong) {
    return { classification: "likely_song", suggestedAction: "keep", riskReasons: ["known_song_unknown_artist"] };
  }
  if (song?.isNiche === true && unknownArtist) {
    return { classification: "needs_review", suggestedAction: "manual_review", riskReasons: ["niche_unknown_artist"] };
  }
  return { classification: "likely_song", suggestedAction: "keep", riskReasons: [] };
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
  const titleStats = context?.titleStats || buildTitleOccurrenceStats(videos);
  const stats = {
    droppedVideos: 0,
    droppedEntries: 0,
    replacedEntries: 0,
    ruleDroppedEntries: 0,
    conversationDroppedEntries: 0,
    nearDuplicateDroppedEntries: 0,
    nearDuplicateGroups: 0,
    forceRefreshVideoIds: collectForceRefreshVideoIds(context).size,
  };
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
      sourceId: video.selectedSourceId || video.sourceId || (video.videoId ? `legacy:${video.videoId}` : ""),
      sourceHash:
        video.selectedSourceHash ||
        video.sourceHash ||
        hashNormalizedText(JSON.stringify((video.songs || []).map((song) => [song.seconds, song.title, song.artist, song.raw || ""]))),
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
      const classification = classifyEntry(enriched, { rules: context?.nonSongRules, video, titleStats });
      if (classification.suggestedAction === "drop_entry" && classification.classification === "confirmed_noise") {
        stats.ruleDroppedEntries += 1;
        continue;
      }
      if (classification.suggestedAction === "drop_entry" && classification.classification === "likely_noise") {
        stats.conversationDroppedEntries += 1;
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
    const deduped = dedupeNearDuplicateSongs(songs);
    stats.nearDuplicateDroppedEntries += deduped.droppedEntries;
    stats.nearDuplicateGroups += deduped.groups;
    if (deduped.songs.length) result.push({ ...video, songs: deduped.songs });
  }
  result.curationStats = stats;
  return result;
}

function buildTitleOccurrenceStats(videos) {
  const records = new Map();
  for (const video of videos || []) {
    const videoKey = String(video?.videoId || video?.selectedSourceId || video?.sourceId || video?.title || "").trim();
    for (const song of Array.isArray(video?.songs) ? video.songs : []) {
      const key = normalizeSingletonTitleKey(song?.title || "");
      if (!key) continue;
      if (!records.has(key)) records.set(key, { rows: 0, sources: new Set() });
      const record = records.get(key);
      record.rows += 1;
      record.sources.add(videoKey || `${key}:${record.rows}`);
    }
  }
  for (const record of records.values()) {
    record.sourceCount = record.sources.size;
    delete record.sources;
  }
  return records;
}

function normalizeSingletonTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦♪♫♬♩]+/gu, "")
    .trim();
}

function dedupeNearDuplicateSongs(songs, options = {}) {
  const windowSeconds = Number.isInteger(options.windowSeconds) ? options.windowSeconds : NEAR_DUPLICATE_WINDOW_SECONDS;
  const entries = (songs || []).map((song, order) => ({ song, order }));
  entries.sort((left, right) => songSeconds(left.song) - songSeconds(right.song) || left.order - right.order);

  const groups = [];
  for (const entry of entries) {
    const match = groups.find((group) => isNearDuplicateSong(group.kept.song, entry.song, windowSeconds));
    if (!match) {
      groups.push({ kept: entry, duplicates: [] });
      continue;
    }
    if (compareNearDuplicateCandidate(entry.song, match.kept.song) > 0) {
      match.duplicates.push(match.kept);
      match.kept = entry;
    } else {
      match.duplicates.push(entry);
    }
  }

  let droppedEntries = 0;
  let groupCount = 0;
  const keptEntries = [];
  for (const group of groups) {
    if (group.duplicates.length) {
      droppedEntries += group.duplicates.length;
      groupCount += 1;
      keptEntries.push({
        ...group.kept,
        song: attachNearDuplicateProvenance(group.kept.song, group.duplicates.map((entry) => entry.song), windowSeconds),
      });
    } else {
      keptEntries.push(group.kept);
    }
  }

  keptEntries.sort((left, right) => left.order - right.order);
  return {
    songs: keptEntries.map((entry) => entry.song),
    droppedEntries,
    groups: groupCount,
  };
}

function isNearDuplicateSong(left, right, windowSeconds = NEAR_DUPLICATE_WINDOW_SECONDS) {
  const leftSeconds = songSeconds(left);
  const rightSeconds = songSeconds(right);
  if (!Number.isFinite(leftSeconds) || !Number.isFinite(rightSeconds)) return false;
  if (Math.abs(leftSeconds - rightSeconds) > windowSeconds) return false;
  const leftTitle = normalizeSongTitleKey(left?.title || "");
  const rightTitle = normalizeSongTitleKey(right?.title || "");
  if (!leftTitle || leftTitle !== rightTitle) return false;
  return artistsCompatible(left?.artist, right?.artist);
}

function artistsCompatible(left, right) {
  const leftUnknown = isUnknownArtist(left);
  const rightUnknown = isUnknownArtist(right);
  if (leftUnknown || rightUnknown) return true;
  return normalizeArtistKey(left) === normalizeArtistKey(right);
}

function compareNearDuplicateCandidate(left, right) {
  const leftScore = nearDuplicateTrustScore(left);
  const rightScore = nearDuplicateTrustScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return songSeconds(right) - songSeconds(left);
}

function nearDuplicateTrustScore(song) {
  let score = 0;
  if (song?.forceKept) score += 100;
  if (!isUnknownArtist(song?.artist)) score += 20;
  if (song?.repair?.knownTitleArtist) score += 12;
  else if (song?.repair?.knownTitle) score += 6;
  if (String(song?.artist || "").trim().length > 2) score += 2;
  if (String(song?.raw || "").trim()) score += 1;
  return score;
}

function attachNearDuplicateProvenance(song, duplicates, windowSeconds) {
  const existing = Array.isArray(song?.dedupe?.duplicates) ? song.dedupe.duplicates : [];
  return {
    ...song,
    dedupe: {
      ...(song.dedupe || {}),
      changed: true,
      reason: "near_duplicate_same_video",
      windowSeconds,
      duplicateCount: existing.length + duplicates.length,
      duplicates: [
        ...existing,
        ...duplicates.map((duplicate) => ({
          title: duplicate.title || "",
          artist: duplicate.artist || "",
          time: duplicate.time || "",
          seconds: Number.isFinite(Number(duplicate.seconds)) ? Number(duplicate.seconds) : null,
          sourceId: duplicate.sourceId || "",
          sourceHash: duplicate.sourceHash || "",
          rawHash: duplicate.rawHash || "",
          raw: duplicate.raw || "",
        })),
      ],
    },
  };
}

function songSeconds(song) {
  const value = Number(song?.seconds);
  return Number.isFinite(value) ? value : Number.NaN;
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
  const conversationEntryCount = songs.filter((song) => isConversationEntry(song)).length;
  const parserCorruptionCount = songs.filter((song) => isParserCorruptionEntry(song)).length;
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
    conversationEntryCount,
    conversationRatio: songs.length ? conversationEntryCount / songs.length : 0,
    parserCorruptionCount,
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
    if (record.action === "force_refresh" && record.videoId) ids.add(record.videoId);
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
  const signals = song?.curationSignals || entryRepairSignals(song);
  if (isParserCorruptionEntry(song)) reasons.push("parser_corruption");
  if (!knownSong && signals?.suppressLikelySong) reasons.push(...(signals.reasons || ["non_song_signal"]));
  if (!knownSong && isActivityMarkerTitle(title, artist)) reasons.push("activity_marker_title");
  if (!knownSong && isConversationEntry(song)) reasons.push("conversation_entry");
  if (song?.isNiche === true && isUnknownArtist(artist) && !knownSong) reasons.push("niche_unknown_artist");
  if (normalizeCurationTitle(title).length <= 4 && !knownSong && isUnknownArtist(artist)) reasons.push("short_unknown_title");
  if (isUnknownArtist(artist) && sourceStats.unknownArtistCount >= 3) reasons.push("source_multiple_unknown_artists");
  if (song?.isNiche === true && normalizeCurationTitle(title).length <= 8 && sourceStats.nicheCount >= 3) {
    reasons.push("source_multiple_niche_short_titles");
  }
  return reasons;
}

function sourceRiskReasons(source, knownSongMatcher) {
  const stats = source.stats || source;
  const reasons = [];
  if ((stats.unknownArtistRatio || 0) >= 0.75 && (stats.keptCount || 0) >= 4 && (stats.knownSongCount || 0) <= 2) {
    reasons.push("source_unknown_artist_ratio_high");
  }
  if ((stats.activityMarkerRatio || 0) >= 0.15 && (stats.activityMarkerCount || 0) >= 1) reasons.push("source_activity_marker_ratio_high");
  if ((stats.conversationEntryCount || 0) >= 3 && (stats.conversationRatio || 0) >= 0.35 && (stats.knownSongCount || 0) <= 2) {
    reasons.push("source_conversation_timeline");
  }
  if ((stats.parserCorruptionCount || 0) >= 2) reasons.push("source_parser_corruption");
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
    if (/activity|conversation|parser|exceed|low_known|ratio_high/.test(reason)) score += 28;
    else if (/multiple|topic/.test(reason)) score += 14;
    else if (/niche_unknown_artist/.test(reason)) score += 6;
    else if (/known_song_unknown_artist/.test(reason)) score += 2;
    else score += 10;
  }
  score += Math.min(25, (stats.activityMarkerCount || 0) * 8);
  score += Math.min(25, (stats.conversationEntryCount || 0) * 6);
  score += Math.min(25, (stats.parserCorruptionCount || 0) * 10);
  if ((stats.knownSongCount || 0) <= 2) score += Math.min(12, (stats.unknownArtistCount || 0));
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
  buildTitleOccurrenceStats,
  classifyEntry,
  collectForceRefreshVideoIds,
  createSourceRecord,
  dedupeNearDuplicateSongs,
  entryRiskReasons,
  hashNormalizedText,
  hasRejectSourceOverride,
  isActivityMarkerTitle,
  isCandidateActivityTitle,
  isConversationEntry,
  isParserCorruptionEntry,
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
