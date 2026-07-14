(function initRankingUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.RankingUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createRankingUtils() {
  const UNKNOWN_ARTISTS = new Set([
    "unknown",
    "n/a",
    "na",
    "none",
    "null",
    "未記載",
    "未记载",
    "不明",
    "无",
    "なし",
    "待补歌手",
    "待補歌手",
    "待补",
    "待補",
    "-",
  ]);

  function buildSongRecords(occurrences, options = {}) {
    const clean = options.cleanText || cleanText;
    const normalize = options.normalizeEntityKey || normalizeEntityKey;
    const normalizeArtist = options.normalizeArtistKey || normalizeArtistKey;
    const normalizeTitle = options.normalizeSongTitleKey || normalizeSongTitleKey;
    const makeSortKey = options.makeSongSortKey || ((value) => normalize(value));
    const increment = options.incrementCount || incrementCount;
    const titleGroups = new Map();

    for (const occurrence of occurrences || []) {
      const title = clean(occurrence?.song?.title);
      const titleKey = normalizeTitle(title);
      if (!titleKey) continue;

      if (!titleGroups.has(titleKey)) {
        titleGroups.set(titleKey, {
          titleKey,
          title,
          titleCounts: new Map(),
          knownArtists: new Map(),
          unknownOccurrences: [],
        });
      }

      const titleGroup = titleGroups.get(titleKey);
      incrementTitleCount(titleGroup.titleCounts, title);
      const artist = clean(occurrence?.song?.artist);
      const rawArtistKey = normalize(artist);
      const artistKey = normalizeArtist(artist) || rawArtistKey;
      if (isKnownArtist(artist, rawArtistKey) && !isLikelyNonArtistAnnotation(artist)) {
        if (!titleGroup.knownArtists.has(artistKey)) {
          titleGroup.knownArtists.set(artistKey, {
            key: `${titleKey}::${artistKey}`,
            titleKey,
            artistKey,
            artistTitleKey: normalizeTitle(artist),
            artistBaseKeys: artistBaseKeys(artist, normalizeArtist),
            title,
            sortKey: makeSortKey(title),
            count: 0,
            artists: new Map(),
            channels: new Map(),
            occurrences: [],
          });
        }
        addOccurrence(titleGroup.knownArtists.get(artistKey), occurrence, { clean, increment });
      } else {
        titleGroup.unknownOccurrences.push(occurrence);
      }
    }

    for (const titleGroup of titleGroups.values()) {
      mergeKnownArtistVariants(titleGroup);
    }

    const allKnownRecords = Array.from(titleGroups.values()).flatMap((group) =>
      Array.from(group.knownArtists.values()),
    );
    const records = [];
    for (const titleGroup of titleGroups.values()) {
      const displayTitle = selectCanonicalTitle(titleGroup.titleCounts) || titleGroup.title;
      const knownRecords = Array.from(titleGroup.knownArtists.values());
      for (const record of knownRecords) {
        applyDisplayTitle(record, displayTitle, makeSortKey);
        records.push(record);
      }

      if (!titleGroup.unknownOccurrences.length) continue;
      const unknownTarget =
        selectDominantRecord(knownRecords) || findKnownRecordFromCombinedTitle(titleGroup.titleKey, allKnownRecords);
      if (unknownTarget) {
        for (const occurrence of titleGroup.unknownOccurrences) {
          addOccurrence(unknownTarget, occurrence, { clean, increment, skipArtist: true });
        }
        continue;
      }

      const unknownRecord = {
        key: `${titleGroup.titleKey}::unknown`,
        title: displayTitle,
        sortKey: makeSortKey(displayTitle),
        count: 0,
        artists: new Map(),
        channels: new Map(),
        occurrences: [],
      };
      for (const occurrence of titleGroup.unknownOccurrences) {
        addOccurrence(unknownRecord, occurrence, { clean, increment, skipArtist: true });
      }
      records.push(unknownRecord);
    }

    return records;
  }

  function buildArtistRecords(occurrences, options = {}) {
    const clean = options.cleanText || cleanText;
    const normalizeArtist = options.normalizeArtistKey || normalizeArtistKey;
    const increment = options.incrementCount || incrementCount;
    const records = new Map();
    let missingArtistCount = 0;

    for (const occurrence of occurrences || []) {
      const artist = clean(occurrence?.song?.artist);
      if (isUnknownArtistName(artist)) {
        missingArtistCount += 1;
        continue;
      }

      const key = artistRecordKey(artist, normalizeArtist);
      if (!key) {
        missingArtistCount += 1;
        continue;
      }
      if (!records.has(key)) {
        records.set(key, {
          key,
          name: artist,
          count: 0,
          songs: new Map(),
          channels: new Map(),
          occurrences: [],
          aliasCounts: new Map(),
        });
      }

      const record = records.get(key);
      record.count += 1;
      record.occurrences.push(occurrence);
      incrementAliasCount(record.aliasCounts, artist);
      increment(record.songs, clean(occurrence?.song?.title));
      increment(record.channels, clean(occurrence?.item?.channelName));
    }

    const finalizedRecords = Array.from(records.values()).map((record) => finalizeArtistRecord(record, normalizeArtist));
    return { records: finalizedRecords, missingArtistCount };
  }

  function buildArtistSongGroups(occurrences, options = {}) {
    const isNicheSong = typeof options.isNicheSong === "function" ? options.isNicheSong : defaultIsNicheSong;
    const compare = typeof options.compareValues === "function" ? options.compareValues : compareValues;
    return buildSongRecords(occurrences, options)
      .sort((a, b) => b.count - a.count || compare(a.sortKey, b.sortKey) || compare(a.title, b.title))
      .map((record) => ({
        key: record.key,
        title: record.title,
        count: record.count,
        isNiche: record.occurrences.some(({ song }) => isNicheSong(song)),
        occurrences: record.occurrences,
      }));
  }

  function mergeKnownArtistVariants(titleGroup) {
    const recordsByKey = titleGroup.knownArtists;
    const records = Array.from(recordsByKey.values()).sort(compareRecordDominance);
    for (const record of records) {
      if (recordsByKey.get(record.artistKey) !== record) continue;
      const target = selectExistingBaseArtistRecord(record, recordsByKey);
      if (!target) continue;
      mergeRecord(target, record);
      recordsByKey.delete(record.artistKey);
    }
  }

  function selectExistingBaseArtistRecord(record, recordsByKey) {
    let selected = null;
    for (const key of record.artistBaseKeys || []) {
      if (!key || key === record.artistKey) continue;
      const target = recordsByKey.get(key);
      if (!target || target === record) continue;
      if (!selected || compareRecordDominance(target, selected) < 0) selected = target;
    }
    return selected;
  }

  function mergeRecord(target, source) {
    target.count += source.count;
    target.occurrences.push(...source.occurrences);
    mergeCountMap(target.artists, source.artists);
    mergeCountMap(target.channels, source.channels);
  }

  function mergeCountMap(target, source) {
    for (const [key, entry] of source.entries()) {
      if (!target.has(key)) {
        target.set(key, { ...entry });
        continue;
      }
      target.get(key).count += entry.count;
    }
  }

  function selectDominantRecord(records) {
    let selected = null;
    for (const record of records || []) {
      if (!selected || compareRecordDominance(record, selected) < 0) selected = record;
    }
    return selected;
  }

  function findKnownRecordFromCombinedTitle(titleKey, records) {
    const candidates = [];
    for (const record of records || []) {
      if (!record.titleKey || !record.artistTitleKey) continue;
      if (titleKey === `${record.titleKey}${record.artistTitleKey}`) candidates.push(record);
      if (titleKey === `${record.artistTitleKey}${record.titleKey}`) candidates.push(record);
    }
    return selectDominantRecord(candidates);
  }

  function compareRecordDominance(a, b) {
    return b.count - a.count || String(a.key).localeCompare(String(b.key));
  }

  function compareValues(a, b) {
    return String(a || "").localeCompare(String(b || ""), "en", {
      numeric: true,
      sensitivity: "base",
      ignorePunctuation: true,
    });
  }

  function defaultIsNicheSong(song) {
    return song?.isNiche === true || song?.niche === true;
  }

  function incrementTitleCount(map, title) {
    const cleanTitle = cleanText(title);
    if (!cleanTitle) return;
    map.set(cleanTitle, (map.get(cleanTitle) || 0) + 1);
  }

  function applyDisplayTitle(record, title, makeSortKey) {
    if (!title) return;
    record.title = title;
    record.sortKey = makeSortKey(title);
  }

  function artistRecordKey(artist, normalizeArtist) {
    const primaryKey = normalizeArtist(artist);
    if (!primaryKey) return "";
    const baseKeys = artistBaseKeys(artist, normalizeArtist, { preserveIdentityAnnotations: true });
    return baseKeys[0] || primaryKey;
  }

  function incrementAliasCount(map, name) {
    const cleanName = cleanText(name);
    if (!cleanName) return;
    map.set(cleanName, (map.get(cleanName) || 0) + 1);
  }

  function finalizeArtistRecord(record, normalizeArtist) {
    const aliases = Array.from(record.aliasCounts.entries())
      .map(([name, count]) => ({
        key: normalizeArtist(name),
        name,
        count,
      }))
      .sort(compareArtistAlias);
    if (aliases[0]) record.name = aliases[0].name;
    record.aliases = aliases;
    delete record.aliasCounts;
    return record;
  }

  function compareArtistAlias(a, b) {
    return (
      b.count - a.count ||
      artistNameQualityScore(b.name) - artistNameQualityScore(a.name) ||
      a.name.length - b.name.length ||
      compareValues(a.name, b.name)
    );
  }

  function artistNameQualityScore(name) {
    const text = cleanText(name);
    if (!text) return -10;
    let score = 0;
    if (/[\p{Letter}\p{Number}]/u.test(text)) score += 2;
    if (text !== text.normalize("NFKC")) score -= 1;
    if (/[\t]/u.test(text)) score -= 2;
    if (/[(（［\[【「『].*[)）］\]】」』]\s*$/u.test(text)) {
      score += stripTrailingNonArtistParenthetical(text) ? -1 : 0;
    }
    if (stripTrailingNonArtistDescriptor(text)) score -= 1;
    if (stripArtistBeforeWorkAnnotation(text)) score -= 1;
    if (stripArtistBeforeBrokenBracket(text)) score -= 1;
    return score;
  }

  function selectCanonicalTitle(titleCounts) {
    return Array.from(titleCounts.entries())
      .sort((a, b) => titleQualityScore(b[0]) - titleQualityScore(a[0]) || b[1] - a[1] || a[0].length - b[0].length)
      .map(([title]) => title)[0];
  }

  function titleQualityScore(title) {
    let score = 0;
    if (/^[\s#＃\d①-⑳❶-❿⓵-⓾㉑-㉟㊱-㊿(（\[\]【「『╟]/u.test(title)) score -= 2;
    if (/[』」】）\]]\s*$/u.test(title)) score -= 1;
    if (/[\t]/u.test(title)) score -= 2;
    if (/[\p{Letter}\p{Number}]/u.test(title)) score += 1;
    return score;
  }

  function buildCompetitionRanks(records) {
    const ranks = new Map();
    let previousCount = null;
    let currentRank = 0;

    records.forEach((record, index) => {
      if (record.count !== previousCount) {
        currentRank = index + 1;
        previousCount = record.count;
      }
      ranks.set(record.key, currentRank);
    });

    return ranks;
  }

  function addOccurrence(record, occurrence, options) {
    record.count += 1;
    record.occurrences.push(occurrence);
    if (!options.skipArtist) options.increment(record.artists, options.clean(occurrence?.song?.artist));
    options.increment(record.channels, options.clean(occurrence?.item?.channelName));
  }

  function isKnownArtist(artist, artistKey) {
    return Boolean(artistKey) && !UNKNOWN_ARTISTS.has(artistKey) && Boolean(cleanText(artist));
  }

  function isUnknownArtistName(value) {
    const text = cleanText(value);
    if (!text) return true;
    return UNKNOWN_ARTISTS.has(normalizeEntityKey(text));
  }

  function isLikelyNonArtistAnnotation(value) {
    const text = cleanText(value).normalize("NFKC");
    if (!text) return true;
    return (
      /^(?:\+|-)?\d+(?:回目|キー|key)?$/iu.test(text) ||
      /^(?:サウンドチェック|sound\s*check|歌い直し|調整中?|途中|ぼろぼろ)$/iu.test(text)
    );
  }

  function incrementCount(map, name) {
    const cleanName = cleanText(name);
    if (!cleanName) return;
    const key = normalizeEntityKey(cleanName);
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, name: cleanName, count: 0 });
    map.get(key).count += 1;
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeEntityKey(value) {
    return cleanText(value).normalize("NFKC").toLocaleLowerCase();
  }

  function normalizeArtistKey(value) {
    return cleanText(value)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function normalizeSongTitleKey(value) {
    return stripLeadingTitleListMarker(cleanText(value))
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function stripLeadingTitleListMarker(value) {
    let result = String(value ?? "");
    for (let index = 0; index < 4; index += 1) {
      const next = result
        .replace(/^\s*[╟├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼▶▷►▸▹>|・･●○◆◇■□♪♫♬♩♡♥◎★☆\uFE0F\u2600-\u27BF\u{1F300}-\u{1FAFF}⁅⁆]+/u, "")
        .replace(/^\s*[＊*]\s*(?=(?:[#＃]?\d{1,3}[.．](?![0-9０-９])|[#＃]?\d{1,3}[)）、:：]|[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]))/u, "")
        .replace(/^\s*[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]\s*/u, "")
        .replace(
          /^\s*(?:(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[\s。、,,:：)）\]\-|｜/／]+|(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[.．](?![0-9０-９])\s*)/u,
          "",
        );
      if (next === result) break;
      result = next;
    }
    return result;
  }

  function artistBaseKeys(value, normalizeArtist, options = {}) {
    const text = cleanText(value).normalize("NFKC");
    const preserveIdentityAnnotations = options.preserveIdentityAnnotations === true;
    const workBase = stripArtistBeforeWorkAnnotation(text);
    const brokenBracketBase = stripArtistBeforeBrokenBracket(text);
    const candidates = [];
    if (!preserveIdentityAnnotations) addArtistBaseCandidate(candidates, stripArtistBeforeFeat(text), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(text), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(workBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistDescriptor(workBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistDescriptor(brokenBracketBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(brokenBracketBase), normalizeArtist);
    addArtistBaseCandidate(candidates, workBase, normalizeArtist);
    addArtistBaseCandidate(candidates, brokenBracketBase, normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistDescriptor(text), normalizeArtist);
    return uniqueStrings(candidates);
  }

  function addArtistBaseCandidate(candidates, value, normalizeArtist) {
    const key = normalizeArtist(value);
    if (key) candidates.push(key);
  }

  function stripArtistBeforeFeat(value) {
    const match = String(value).match(/^(.+?)(?:\s|[._\-・･/／+＋,&＆])(?:feat(?:uring)?|ft)\.?\s*/iu);
    return match ? match[1].trim() : "";
  }

  function stripTrailingNonArtistParenthetical(value) {
    const match = String(value).match(/^(.*?)\s*[(（［\[【「『]([^()（）\[\]［］【】「」『』]{1,100})[)）］\]】」』]\s*$/u);
    if (!match) return "";
    return isNonArtistDescriptor(match[2]) ? match[1].trim() : "";
  }

  function stripTrailingNonArtistDescriptor(value) {
    const text = String(value);
    const separated = text.match(/^(.+?)\s*(?:[-ー–—|｜:：])\s*(.{1,80})\s*$/u);
    if (separated && isNonArtistDescriptor(separated[2])) return separated[1].trim();
    const spaced = text.match(/^(.+?)\s+([^\s].{0,80})\s*$/u);
    if (!spaced) return "";
    return isStandaloneNonArtistDescriptor(spaced[2]) ? spaced[1].trim() : "";
  }

  function stripArtistBeforeWorkAnnotation(value) {
    const match = String(value).match(/^(.*?)\s*(?:\/|／)\s*(.+)$/u);
    if (!match) return "";
    return isNonArtistDescriptor(match[2]) ? match[1].trim() : "";
  }

  function stripArtistBeforeBrokenBracket(value) {
    const match = String(value).match(/^(.*?)\s*(?:[-ー–—]\s*)?【(.{1,100})$/u);
    if (!match) return "";
    return isNonArtistDescriptor(match[2]) ? match[1].trim() : "";
  }

  function isNonArtistDescriptor(value) {
    const text = cleanText(value).normalize("NFKC");
    if (!text || hasArtistIdentityAnnotation(text)) return false;
    return (
      isStandaloneNonArtistDescriptor(text) ||
      hasWorkDescriptor(text)
    );
  }

  function isStandaloneNonArtistDescriptor(value) {
    const text = cleanText(value).normalize("NFKC");
    if (!text || hasArtistIdentityAnnotation(text)) return false;
    const normalized = text
      .replace(/^[([{【「『]\s*/u, "")
      .replace(/\s*[)\]}】」』]$/u, "")
      .trim();
    return (
      /^(?:19|20)\d{2}年?$/u.test(normalized) ||
      /^(?:(?:self\s*)?cover|covered|original|原曲|原唱|retake|take\s*\d+|key|キー|歌詞|調整|途中)$/iu.test(normalized) ||
      /^(?:(?:piano|acoustic|アコースティック|ピアノ|アカペラ)(?:\s*(?:ver\.?|version|版))?)$/iu.test(normalized) ||
      /^(?:TV\s*size|TV\s*アニメ|TV\s*anime|TV|OP|ED|opening|ending|アニメ|動畫|动画|映画|ドラマ|主題歌|主题歌|テーマ|CM)(?:\s*(?:OP|ED|opening|ending|ver\.?|version|版|サイズ|size))?$/iu.test(
        normalized,
      )
    );
  }

  function hasArtistIdentityAnnotation(value) {
    return /\b(?:cv|starring|feat(?:uring)?|ft|vocal|member|members)\b|歌唱|声優|声优|聲優|组合|組合|成員|成员/iu.test(
      value,
    );
  }

  function hasWorkDescriptor(value) {
    return (
      /(?:TV\s*size|TV\s*アニメ|TV\s*anime|アニメ|動畫|动画|映画|ドラマ|opening|ending|主題歌|主题歌|テーマ|CM|機動戦士|ガンダム|NARUTO|エヴァンゲリオン)/iu.test(
        value,
      ) || /(?:^|[\s/／:：_\-ー–—])(?:OP|ED)(?:$|[\s/／:：_\-ー–—])/iu.test(value)
    );
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  return {
    buildArtistRecords,
    buildArtistSongGroups,
    buildCompetitionRanks,
    buildSongRecords,
    cleanText,
    isUnknownArtistName,
    normalizeArtistKey,
    normalizeEntityKey,
    normalizeSongTitleKey,
  };
});
