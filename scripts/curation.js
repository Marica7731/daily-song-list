const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isSongSearchKnown, normalizeSongSearchText } = require("../assets/frontend-utils");
const { entryRepairSignals } = require("./entry-repair");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const OVERRIDES_PATH = path.join(CONFIG_DIR, "curation-overrides.json");
const NON_SONG_RULES_PATH = path.join(CONFIG_DIR, "non-song-rules.json");
const UNKNOWN_ARTIST_KEYS = new Set(["", "unknown", "n/a", "na", "none", "null", "未記載", "未记载", "不明", "なし", "无", "待补歌手", "待補歌手", "待补", "待補", "-"]);
const VALID_ACTIONS = new Set(["drop_entry", "replace_entry", "reject_source", "force_refresh", "drop_video", "force_keep"]);
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
  if (isEmojiOrReactionOnly(title)) return true;
  if (/^(?:や|やー|やあ|やほ|やっほ|わあ|あ|え|お|ん|うん|はい|ええ)[…~〜～!！?？。.\s]*$/iu.test(value)) return true;
  if (/^「.+」$/u.test(value) || /「.+」/u.test(raw)) return true;
  if (/[?？]$/u.test(value)) return true;
  if (/(?:について|のお話|問題|しよう|している|していない|だった|でした|です|ます|ありがとう|おめでとう|気がする|したい|したいな|してほしい|してください|してあげる|ちゃうね|なんで|かな|かも|だよ|だね|なの|か)$/iu.test(value)) return true;
  if (/(?:背景を変える|横に置く|食べる|飲む|お名前呼び|配信告知|チャンネル登録|スパチャ|メンシ|スクショ|サムネ|写真|告知|登録|コメント|ギフト|リクエスト|メンバー|キャンペーン|アルバム発売記念)/iu.test(value)) return true;
  if (/(?:クッキング|ケーキ|テーマは|浮かれて|よっこいしょ|歌声|地声|バラード|透明感|触れれる|楽しそう|褒め合って|適正性|サイレン|プロポーズ|結婚|苗字|謝罪|わさび事件|始まりました|終了|さんとの|発売記念|開催)/iu.test(value)) return true;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(title) && title.length <= 18) return true;
  return /(?:について|のお話|問題|しよう|している|していない|だった|でした|です|ます)/iu.test(raw);
}

function isStrongNonSongActivityText(value) {
  const text = String(value || "").normalize("NFKC").replace(/[\s\u3000]+/gu, "").replace(/[!！?？。．.]+$/gu, "");
  if (!text) return false;
  if (/^(?:YoutubePremium|AFK|awayfromkeyboard|take\d+|テイク\d+)$/iu.test(text)) return true;
  if (/^(?:練習|practice).{2,}$/iu.test(text)) return true;
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
  if (/(?:リスナー同士の結婚報告|なかったことにしよう|とてもくやしい|リクエストできる歌のリスト|妻を迎えに行かないと|久しぶりに来てまた食べ物の話|夏を感じる曲|喉が痛い|歌声禁斷症勢|譲り合い精神|突然3Dモデルがバグった|燃え尽きて消えた|包囲されたちびたん|会社をクビに|ガイドメロディが大きい|曲が増えた理由|飽きるまでずっと繰り返し|疑われちゃう可能性|ミニストップ行けよ|ビックリした|プレゼントが届きました|歌っている途中|自己肯定感.*上がってる)/u.test(text)) {
    return true;
  }
  if (/(?:食べ物|食べる|飲む|飲酒|お酒|ビール|ハイボール|喉|病院|薬|体調|風邪|咳|くしゃみ|あくび|欠伸)/u.test(text) && /(?:話|痛い|行く|行け|届|した|する|です|ます|ちゃう|[?？])/.test(text)) {
    return true;
  }
  return false;
}

function isWeakUnknownSingletonNonSong(song, occurrenceStats = {}) {
  if (!isUnknownArtist(song?.artist)) return false;
  if (!isCorpusSingleton(occurrenceStats)) return false;
  const title = String(song?.title || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  const compact = normalizeConversationText(`${title} ${raw}`);
  if (!title || normalizeSongSearchText(title).length <= 1) return false;
  if (isStrongNonSongActivityText(title) || isStrongNonSongActivityText(raw)) return true;
  if (isTranslationOnlyExplanationRow(title, raw)) return true;
  if (/(?:でした|です|ます|ました|してる|している|したい|しよう|しない|できる|いけない|ちゃう|だった|だよ|だね|なの|かな|かも|理由|途中|可能性|報告|説明|紹介|翻訳|ヒント|問題|どこ|誰|なに|何|どう|なぜ|なんで|[?？])$/u.test(title)) {
    return true;
  }
  if (/(?:コメ|コメント|リスナー|配信|曲紹介|曲説明|曲リスト|歌のリスト|アンケート|質問|喉|病院|食べ物|飲み物|飲酒|行動|移動|帰宅|プレゼント|YouTubePremium|AFK|awayfromkeyboard|take\d+)/iu.test(compact)) {
    return true;
  }
  return false;
}

function isCorpusSingleton(occurrenceStats = {}) {
  return (occurrenceStats.titleArtistCount || 0) === 1 && (occurrenceStats.titleCount || 0) === 1;
}

function isTranslationOnlyExplanationRow(title, raw) {
  const rawText = String(raw || "");
  if (!/[\/／]\s*[A-Za-z][A-Za-z0-9'’(),\-\s]{8,}$/u.test(rawText)) return false;
  const titleText = String(title || "");
  if (/^[A-Za-z0-9'’(),\-\s]+$/u.test(titleText)) return false;
  return /(?:した|して|する|です|ます|だった|でした|理由|途中|可能性|報告|届きました|痛い|大きい|消えた|バグった|行け|食べ|飲み|喉|曲|歌|リスナー|なれたん|ちびたん|[?？])/.test(titleText);
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
  if (isHardNonSongNarrationEntry(song, options.songSearchLookup)) {
    return { classification: "likely_noise", suggestedAction: "drop_entry", riskReasons: ["hard_non_song_narration"] };
  }
  const knownSong =
    options.knownSong === true ||
    (typeof options.knownSongMatcher === "function" && options.knownSongMatcher(song)) ||
    isKnownSongByLookup(song, options.songSearchLookup);
  const unknownArtist = isUnknownArtist(song?.artist);
  const signals = song?.curationSignals || entryRepairSignals(song);
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
  if (!knownSong && isWeakUnknownSingletonNonSong(song, options.occurrenceStats)) {
    return { classification: "likely_noise", suggestedAction: "drop_entry", riskReasons: ["weak_unknown_singleton_non_song"] };
  }
  if (
    unknownArtist &&
    !knownSong &&
    options.songSearchLookup?.available &&
    isCorpusSingleton(options.occurrenceStats) &&
    !hasReliableRawArtistCredit(song) &&
    !hasNearKnownTitleMatch(song?.title, options.songSearchLookup)
  ) {
    return { classification: "likely_noise", suggestedAction: "drop_entry", riskReasons: ["weak_unknown_singleton_low_similarity"] };
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
  const corpusStats = buildCorpusSongStats(context?.corpusVideos || videos);
  const stats = {
    droppedVideos: 0,
    droppedEntries: 0,
    replacedEntries: 0,
    ruleDroppedEntries: 0,
    conversationDroppedEntries: 0,
    mixedSourceDroppedEntries: 0,
    nearDuplicateDroppedEntries: 0,
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
      const classification = classifyEntry(enriched, {
        rules: context?.nonSongRules,
        songSearchLookup: context?.songSearchLookup,
        occurrenceStats: corpusSongStatsFor(corpusStats, enriched),
      });
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
    const mixedSourceFilter = filterArtistRichSingletonUnknownSongs(songs, corpusStats);
    stats.mixedSourceDroppedEntries += mixedSourceFilter.droppedCount;
    const deduped = dedupeNearDuplicateVideoSongs(mixedSourceFilter.songs);
    stats.nearDuplicateDroppedEntries += deduped.droppedCount;
    if (deduped.songs.length) result.push({ ...video, songs: deduped.songs });
  }
  result.curationStats = stats;
  return result;
}

function dedupeNearDuplicateVideoSongs(inputSongs, options = {}) {
  const windowSeconds = Number.isInteger(options.windowSeconds) ? options.windowSeconds : 30;
  const kept = [];
  let droppedCount = 0;
  for (const song of inputSongs || []) {
    const existingIndex = kept.findIndex((item) => isNearDuplicateVideoSong(item, song, windowSeconds));
    if (existingIndex < 0) {
      kept.push(song);
      continue;
    }

    const existing = kept[existingIndex];
    const preferred = preferNearDuplicateSong(existing, song);
    const dropped = preferred === existing ? song : existing;
    kept[existingIndex] = attachNearDuplicateProvenance(preferred, dropped, windowSeconds);
    droppedCount += 1;
  }
  return {
    songs: kept.sort((a, b) => (a.seconds || 0) - (b.seconds || 0)).map((song, index) => ({ ...song, index: index + 1 })),
    droppedCount,
  };
}

function filterArtistRichSingletonUnknownSongs(inputSongs, corpusStats) {
  const songs = Array.isArray(inputSongs) ? inputSongs : [];
  const artistCount = songs.filter((song) => !isUnknownArtist(song?.artist)).length;
  const unknownCount = songs.length - artistCount;
  const artistRatio = songs.length ? artistCount / songs.length : 0;
  if (artistCount < 5 || unknownCount < 2 || artistRatio < 0.35) return { songs, droppedCount: 0 };

  const kept = [];
  let droppedCount = 0;
  for (const song of songs) {
    const occurrenceStats = corpusSongStatsFor(corpusStats, song);
    if (
      isUnknownArtist(song?.artist) &&
      occurrenceStats.titleCount === 1 &&
      occurrenceStats.titleArtistCount === 1 &&
      !hasReliableRawArtistCredit(song)
    ) {
      droppedCount += 1;
      continue;
    }
    kept.push(song);
  }
  return { songs: kept, droppedCount };
}

function hasReliableRawArtistCredit(song) {
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  const title = String(song?.title || "").normalize("NFKC").trim();
  if (!raw || !title || isStrongNonSongActivityText(title) || isTranslationOnlyExplanationRow(title, raw)) return false;
  const escapedTitle = escapeRegExp(title).replace(/\s+/gu, "\\s*");
  const pattern = new RegExp(`${escapedTitle}\\s*[\\/／|｜￤∣丨]\\s*([^\\n]{2,80})`, "iu");
  const match = raw.match(pattern);
  const artist = match ? cleanRawArtistCredit(match[1]) : "";
  if (!artist || isUnknownArtist(artist)) return false;
  if (/(?:です|ます|でした|だった|して|する|したい|しよう|ください|理由|途中|可能性|報告|説明|紹介|コメント|リスナー|喉|病院|食べ物|飲み物|プレゼント|届きました)$/iu.test(artist)) {
    return false;
  }
  return /[\p{Letter}\p{Number}一-龯ぁ-んァ-ヶ]/u.test(artist);
}

function cleanRawArtistCredit(value) {
  return String(value || "")
    .replace(/\s+(?:19|20)\d{2}(?:[\/／.-]\d{1,2})?.*$/u, "")
    .replace(/\s*(?:[:：]_[^\s　:：]+[:：]?|🆕|←\s*NEW!?|NEW!)+\s*$/giu, "")
    .replace(/[」』】)\]）]+$/u, "")
    .trim();
}

function isNearDuplicateVideoSong(left, right, windowSeconds) {
  const leftTitle = duplicateTitleKey(left?.title);
  const rightTitle = duplicateTitleKey(right?.title);
  if (!leftTitle || leftTitle !== rightTitle) return false;
  if (Math.abs((Number(left?.seconds) || 0) - (Number(right?.seconds) || 0)) > windowSeconds) return false;
  const leftArtist = duplicateArtistKey(left?.artist);
  const rightArtist = duplicateArtistKey(right?.artist);
  return !leftArtist || !rightArtist || leftArtist === rightArtist;
}

function preferNearDuplicateSong(left, right) {
  const scoreDiff = nearDuplicateTrustScore(right) - nearDuplicateTrustScore(left);
  if (scoreDiff > 0) return right;
  if (scoreDiff < 0) return left;
  return (Number(right?.seconds) || 0) < (Number(left?.seconds) || 0) ? right : left;
}

function nearDuplicateTrustScore(song) {
  let score = 0;
  if (song?.forceKept) score += 100;
  if (!isUnknownArtist(song?.artist)) score += 30;
  if (song?.rawHash) score += 4;
  if (song?.sourceId || song?.sourceHash) score += 2;
  if (String(song?.raw || "").trim()) score += 1;
  return score;
}

function attachNearDuplicateProvenance(keptSong, droppedSong, windowSeconds) {
  const previous = keptSong.nearDuplicateMerge?.dropped || [];
  return {
    ...keptSong,
    nearDuplicateMerge: {
      windowSeconds,
      droppedCount: previous.length + 1,
      reason: "same_video_same_song_within_30_seconds",
      dropped: [...previous, compactDuplicateSong(droppedSong)],
    },
  };
}

function compactDuplicateSong(song) {
  return {
    seconds: Number(song?.seconds) || 0,
    time: song?.time || secondsToTime(Number(song?.seconds) || 0),
    title: String(song?.title || ""),
    artist: String(song?.artist || ""),
    sourceId: String(song?.sourceId || ""),
    sourceHash: String(song?.sourceHash || ""),
    rawHash: String(song?.rawHash || ""),
  };
}

function duplicateTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\uFE0E\uFE0F]/gu, "")
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’~～!！?？.,，。、:：;；\-—–−_・･/／|｜￤∣丨✦]/gu, "")
    .trim();
}

function duplicateArtistKey(value) {
  return isUnknownArtist(value) ? "" : duplicateTitleKey(value);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function buildCorpusSongStats(videos) {
  const titleCounts = new Map();
  const titleArtistCounts = new Map();
  for (const video of videos || []) {
    for (const song of video.songs || []) {
      const titleKey = normalizeSongSearchText(song?.title);
      const artistKey = isUnknownArtist(song?.artist) ? "" : normalizeSongSearchText(song?.artist);
      if (!titleKey) continue;
      titleCounts.set(titleKey, (titleCounts.get(titleKey) || 0) + 1);
      const titleArtistKey = `${titleKey}::${artistKey}`;
      titleArtistCounts.set(titleArtistKey, (titleArtistCounts.get(titleArtistKey) || 0) + 1);
    }
  }
  return { titleCounts, titleArtistCounts };
}

function corpusSongStatsFor(stats, song) {
  const titleKey = normalizeSongSearchText(song?.title);
  const artistKey = isUnknownArtist(song?.artist) ? "" : normalizeSongSearchText(song?.artist);
  return {
    titleCount: titleKey ? stats.titleCounts.get(titleKey) || 0 : 0,
    titleArtistCount: titleKey ? stats.titleArtistCounts.get(`${titleKey}::${artistKey}`) || 0 : 0,
  };
}

function isKnownSongByLookup(song, lookup) {
  return Boolean(lookup?.available && isSongSearchKnown(song, lookup));
}

function isExactTitleArtistKnownByLookup(song, lookup) {
  if (!lookup?.available) return false;
  const titleKey = normalizeSongSearchText(song?.title);
  const artistKey = normalizeSongSearchText(song?.artist);
  return Boolean(titleKey && artistKey && !isUnknownArtist(song?.artist) && lookup.titleArtistKeys.has(`${titleKey}::${artistKey}`));
}

function isHardNonSongNarrationEntry(song, lookup) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  if (!title) return false;
  if (isExactTitleArtistKnownByLookup(song, lookup)) return false;
  const numberedSongListRow = isSongListNumberedRaw(raw);
  if (!numberedSongListRow && (isStrongNonSongActivityText(title) || isStrongNonSongActivityText(raw))) return true;
  if (hasEmbeddedSongTitleWithNarration(title, artist)) return true;
  if (hasLikelyTranslationCredit(title, artist, raw)) return true;
  return false;
}

function isSongListNumberedRaw(raw) {
  const text = String(raw || "").normalize("NFKC").trim();
  return /(?:^|[\s　])(?:[#＃]\s*\d{1,3}\b|M\d{1,3}[.．]?|[①-⑳])/.test(text);
}

function hasEmbeddedSongTitleWithNarration(title, artist) {
  const text = `${title} ${artist}`.normalize("NFKC");
  if (!/[【「『].+[】」』]/u.test(text)) return false;
  return /(?:スーパーで聞いた曲|聞いた曲|歌ってみたかった|聞こえた|流れてた|の曲|という曲)/u.test(text);
}

function hasLikelyTranslationCredit(title, artist, raw) {
  const titleText = String(title || "").normalize("NFKC").trim();
  const rawText = String(raw || "").normalize("NFKC").trim();
  if (!/[\/／]\s*\S/u.test(rawText)) return false;
  const artistText = isUnknownArtist(artist) ? extractRawSlashCredit(titleText, rawText) : String(artist || "").normalize("NFKC").trim();
  if (!artistText || isUnknownArtist(artistText)) return false;
  const japaneseTitle = /[一-龯ぁ-んァ-ヶ]/u.test(titleText);
  const latinArtist = /[A-Za-z]/u.test(artistText);
  if (/[一-龯ぁ-んァ-ヶ]/u.test(artistText)) return false;
  if (!japaneseTitle || !latinArtist) return false;
  const wordCount = artistText.split(/\s+/u).filter(Boolean).length;
  if (/^(?:I|I'm|I’m|You|We|They|It|That|This|There|A|An|The|Why|What|When|Where|How|Can|Will|Was|Were|For|Those|Things|Still|Collaboration|Did|My)\b/u.test(artistText)) return true;
  if (wordCount >= 4) return true;
  if (/(?:\b(?:Story|Stream|Comment|Chat|Song List|Guide Melody|Practice|Hospital|Food|Drink|Throat|Birthday|Surprised|Yawn|Yawning)\b)/iu.test(artistText)) return true;
  if (/(?:feat\.?|ft\.?|with|&|×|x)\s*[\p{Letter}\p{Number}]/iu.test(artistText)) return false;
  if (/^(?:LiSA|Aimer|Ado|YOASOBI|Yorushika|supercell|HoneyWorks|RADWIMPS|KOKIA|Lia|eill|doriko|DECO\*27|EasyPop|MIMI|Mao|ChouCho|See-Saw|Whiteberry|GARNET CROW|Mrs\. GREEN APPLE|Official髭男dism|UNISON SQUARE GARDEN|BUMP OF CHICKEN|Every Little Thing|CHiCO with HoneyWorks|Goose house|Kenshi Yonezu|NICO Touches the Walls|THE ORAL CIGARETTES|GARNiDELiA|Yunomi & nicamoq|DAOKO×米津玄師|Novelbright|FRUITS ZIPPER|CUTIE STREET|MONGOL800|MAISONdes|ALI PROJECT|Galileo Galilei|KANA-BOON|LAST ALLIANCE|AiScReam|Islet feat\.倚水|All at once|SunSet Swish)$/u.test(artistText)) {
    return false;
  }
  const compactTitle = normalizeConversationText(titleText);
  const compactArtist = normalizeConversationText(artistText);
  if (/^(?:Yawn|Yawning|Surprised|Nothing happened|Pet Shop|exhausted|My left arm is getting way too excited)$/iu.test(artistText)) return true;
  if (/(?:\b(?:I|I'm|I’m|You|We|They|It|That|This|There|A|An|The|Why|What|When|Where|How|Can|Will|Was|Were)\b|[?？]|!|％|\d+%|\(|\))/u.test(artistText)) return true;
  if (compactArtist.length >= 8 && compactTitle.length >= 3 && compactArtist.includes(compactTitle)) return true;
  return false;
}

function extractRawSlashCredit(title, raw) {
  const titleText = String(title || "").normalize("NFKC").trim();
  const rawText = String(raw || "").normalize("NFKC").trim();
  if (!titleText || !rawText) return "";
  if (!rawText.includes(titleText)) return "";
  const match = rawText.match(/[\/／]\s*([^\/／\n]{1,120})$/u);
  return match ? cleanRawArtistCredit(match[1]) : "";
}

function hasNearKnownTitleMatch(title, lookup) {
  if (!lookup?.available) return false;
  const titleKey = normalizeSongSearchText(title);
  if (!titleKey || titleKey.length < 5) return false;
  if (lookup.titleKeys.has(titleKey)) return true;
  const candidates = titleKeysByLength(lookup);
  const minLength = Math.max(5, titleKey.length - 1);
  const maxLength = titleKey.length + 1;
  let checked = 0;
  for (let length = minLength; length <= maxLength; length += 1) {
    for (const candidate of candidates.get(length) || []) {
      checked += 1;
      if (checked > 2500) return false;
      const limit = titleKey.length >= 8 ? 2 : 1;
      if (boundedEditDistance(titleKey, candidate, limit) <= limit) return true;
    }
  }
  return false;
}

function titleKeysByLength(lookup) {
  if (lookup._titleKeysByLength) return lookup._titleKeysByLength;
  const byLength = new Map();
  for (const key of lookup.titleKeys || []) {
    const length = String(key || "").length;
    if (!byLength.has(length)) byLength.set(length, []);
    byLength.get(length).push(key);
  }
  lookup._titleKeysByLength = byLength;
  return byLength;
}

function boundedEditDistance(left, right, maxDistance) {
  const a = String(left || "");
  const b = String(right || "");
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      rowBest = Math.min(rowBest, value);
    }
    if (rowBest > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length];
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
  classifyEntry,
  collectForceRefreshVideoIds,
  createSourceRecord,
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
