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
    const normalizeTitle = options.songWorkTitleKey || songWorkTitleKey;
    const makeSortKey = options.makeSongSortKey || ((value) => normalize(value));
    const increment = options.incrementCount || incrementCount;
    const titleGroups = new Map();

    for (const occurrence of occurrences || []) {
      const title = clean(occurrence?.song?.title);
      const work = normalizeSongWorkTitle(title);
      const titleKey = normalizeTitle(work.workTitle);
      if (!titleKey) continue;

      if (!titleGroups.has(titleKey)) {
        titleGroups.set(titleKey, {
          titleKey,
          title: work.workTitle,
          titleCounts: new Map(),
          rawTitleCounts: new Map(),
          knownArtists: new Map(),
          unknownOccurrences: [],
        });
      }

      const titleGroup = titleGroups.get(titleKey);
      incrementTitleCount(titleGroup.titleCounts, work.workTitle);
      incrementTitleCount(titleGroup.rawTitleCounts, title);
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
            title: work.workTitle,
            workTitle: work.workTitle,
            canonicalWorkTitleKey: titleKey,
            sortKey: makeSortKey(title),
            count: 0,
            artists: new Map(),
            channels: new Map(),
            variantLabelCounts: new Map(),
            occurrences: [],
          });
        }
        addOccurrence(titleGroup.knownArtists.get(artistKey), occurrence, { clean, increment, variantLabel: work.variantLabel });
      } else {
        titleGroup.unknownOccurrences.push({ occurrence, variantLabel: work.variantLabel });
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
        for (const { occurrence, variantLabel } of titleGroup.unknownOccurrences) {
          addOccurrence(unknownTarget, occurrence, { clean, increment, skipArtist: true, variantLabel });
        }
        continue;
      }

      const unknownRecord = {
        key: `${titleGroup.titleKey}::unknown`,
        title: displayTitle,
        workTitle: displayTitle,
        canonicalWorkTitleKey: titleGroup.titleKey,
        sortKey: makeSortKey(displayTitle),
        count: 0,
        artists: new Map(),
        channels: new Map(),
        variantLabelCounts: new Map(),
        occurrences: [],
      };
      for (const { occurrence, variantLabel } of titleGroup.unknownOccurrences) {
        addOccurrence(unknownRecord, occurrence, { clean, increment, skipArtist: true, variantLabel });
      }
      records.push(unknownRecord);
    }

    return finalizeSongRecords(mergeFinalDuplicateSongRecords(records, { makeSortKey, normalizeArtist }));
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

    mergePartialArtistRankingVariants(records);
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
      isNiche: record.occurrences.length > 0 && record.occurrences.every(({ song }) => isNicheSong(song)),
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
    mergeKanaRomajiArtistVariants(recordsByKey);
    mergeLikelyArtistTypoVariants(recordsByKey);
    mergePartialSameTitleArtistVariants(recordsByKey);
  }

  function mergeKanaRomajiArtistVariants(recordsByKey) {
    let changed = true;
    while (changed) {
      changed = false;
      const records = Array.from(recordsByKey.values()).sort(compareRecordDominance);
      for (const record of records) {
        if (recordsByKey.get(record.artistKey) !== record) continue;
        const target = selectKanaRomajiTarget(record, recordsByKey);
        if (!target) continue;
        const [winner, loser] = compareRecordDominance(target, record) <= 0 ? [target, record] : [record, target];
        if (winner === loser) continue;
        mergeRecord(winner, loser);
        recordsByKey.delete(loser.artistKey);
        changed = true;
        break;
      }
    }
  }

  function selectKanaRomajiTarget(record, recordsByKey) {
    const matches = [];
    for (const candidate of recordsByKey.values()) {
      if (candidate === record) continue;
      if (artistIdentityMatch(record, candidate)) matches.push(candidate);
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }

  function mergeLikelyArtistTypoVariants(recordsByKey) {
    let changed = true;
    while (changed) {
      changed = false;
      const records = Array.from(recordsByKey.values()).sort(compareRecordDominance);
      for (const record of records) {
        if (recordsByKey.get(record.artistKey) !== record || record.count > 1) continue;
        const target = selectLikelyArtistTypoTarget(record, recordsByKey);
        if (!target) continue;
        mergeRecord(target, record);
        recordsByKey.delete(record.artistKey);
        changed = true;
        break;
      }
    }
  }

  function selectLikelyArtistTypoTarget(record, recordsByKey) {
    const matches = [];
    for (const candidate of recordsByKey.values()) {
      if (candidate === record || candidate.count < 3) continue;
      if (candidate.titleKey !== record.titleKey) continue;
      if (hasAnyArtistIdentityAnnotation(record) || hasAnyArtistIdentityAnnotation(candidate)) continue;
      if (isLikelyArtistKeyTypo(record.artistKey, candidate.artistKey)) matches.push(candidate);
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }

  function mergePartialSameTitleArtistVariants(recordsByKey) {
    let changed = true;
    const caches = createPartialArtistMergeCaches();
    while (changed) {
      changed = false;
      const records = Array.from(recordsByKey.values()).sort(compareRecordDominance);
      for (const record of records) {
        if (recordsByKey.get(record.artistKey) !== record) continue;
        const target = selectPartialArtistTarget(record, recordsByKey, { requireSharedSong: false, ...caches });
        if (!target) continue;
        const [winner, loser] = compareRecordDominance(target, record) <= 0 ? [target, record] : [record, target];
        if (winner === loser) continue;
        mergeRecord(winner, loser);
        invalidatePartialArtistMergeCache(caches, winner);
        recordsByKey.delete(loser.artistKey);
        changed = true;
        break;
      }
    }
  }

  function mergePartialArtistRankingVariants(recordsByKey) {
    let changed = true;
    const caches = createPartialArtistMergeCaches();
    while (changed) {
      changed = false;
      const records = Array.from(recordsByKey.values()).sort(compareRecordDominance);
      for (const record of records) {
        if (recordsByKey.get(record.key) !== record) continue;
        const target = selectPartialArtistTarget(record, recordsByKey, { requireSharedSong: true, ...caches });
        if (!target) continue;
        const [winner, loser] = compareRecordDominance(target, record) <= 0 ? [target, record] : [record, target];
        if (winner === loser) continue;
        mergeArtistRankRecord(winner, loser);
        invalidatePartialArtistMergeCache(caches, winner);
        recordsByKey.delete(loser.key);
        changed = true;
        break;
      }
    }
  }

  function selectPartialArtistTarget(record, recordsByKey, options = {}) {
    const matches = [];
    for (const candidate of recordsByKey.values()) {
      if (candidate === record) continue;
      if (options.requireSharedSong && !artistRecordsShareSong(record, candidate, options)) continue;
      if (partialArtistIdentityMatch(record, candidate, options)) matches.push(candidate);
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }

  function partialArtistIdentityMatch(a, b, options = {}) {
    const aNames = partialArtistRecordNamesCached(a, options);
    const bNames = partialArtistRecordNamesCached(b, options);
    for (const left of aNames) {
      for (const right of bNames) {
        if (isConservativePartialArtistNameMatch(left, right)) return true;
      }
    }
    return false;
  }

  function isConservativePartialArtistNameMatch(left, right) {
    if (hasArtistIdentityAnnotation(left) || hasArtistIdentityAnnotation(right)) return false;
    const leftKey = normalizeArtistKey(left);
    const rightKey = normalizeArtistKey(right);
    if (!leftKey || !rightKey || leftKey === rightKey) return false;
    const [shortName, longName, shortKey, longKey] =
      leftKey.length <= rightKey.length ? [left, right, leftKey, rightKey] : [right, left, rightKey, leftKey];
    if (!isSafePartialArtistKey(shortKey, longKey)) return false;
    return hasSafePartialArtistBoundary(shortName, longName) || hasSafeCjkPartialArtistSuffix(shortName, longName);
  }

  function isSafePartialArtistKey(shortKey, longKey) {
    if (shortKey.length < 4) return false;
    if (longKey.length / shortKey.length > 3.2) return false;
    if (!longKey.startsWith(shortKey) && !longKey.endsWith(shortKey)) return false;
    if (new Set(["artist", "official", "channel", "vocal", "cover", "music"]).has(shortKey)) return false;
    return true;
  }

  function hasSafePartialArtistBoundary(shortName, longName) {
    const shortText = cleanText(shortName).normalize("NFKC");
    const longText = cleanText(longName).normalize("NFKC");
    if (!shortText || !longText || shortText === longText) return false;
    if (/[\/／&＆+＋、,，]/u.test(longText)) return false;
    const boundary = String.raw`[\s\u3000._・･\-ー–—]+`;
    return new RegExp(`(?:^|${boundary})${escapeRegExp(shortText)}(?:$|${boundary})`, "iu").test(longText);
  }

  function hasSafeCjkPartialArtistSuffix(shortName, longName) {
    const shortText = cleanText(shortName).normalize("NFKC");
    const longText = cleanText(longName).normalize("NFKC");
    if (!shortText || !longText || shortText === longText) return false;
    if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(shortText)) return false;
    if (Array.from(shortText).length < 4) return false;
    return longText.startsWith(shortText) || longText.endsWith(shortText);
  }

  function partialArtistRecordNames(record) {
    const names = artistRecordNames(record);
    for (const entry of record.aliasCounts?.values?.() || []) {
      if (entry?.name) names.push(entry.name);
    }
    if (record.name) names.push(record.name);
    return uniqueStrings(names);
  }

  function createPartialArtistMergeCaches() {
    return {
      partialNames: new WeakMap(),
      songKeys: new WeakMap(),
    };
  }

  function invalidatePartialArtistMergeCache(caches, record) {
    caches?.partialNames?.delete?.(record);
    caches?.songKeys?.delete?.(record);
  }

  function partialArtistRecordNamesCached(record, options = {}) {
    const cache = options.partialNames;
    if (!cache) return partialArtistRecordNames(record);
    let names = cache.get(record);
    if (!names) {
      names = partialArtistRecordNames(record);
      cache.set(record, names);
    }
    return names;
  }

  function artistSongKeySetCached(record, options = {}) {
    const cache = options.songKeys;
    if (!cache) return new Set(countMapNames(record.songs).map(normalizeSongTitleKey).filter(Boolean));
    let keys = cache.get(record);
    if (!keys) {
      keys = new Set(countMapNames(record.songs).map(normalizeSongTitleKey).filter(Boolean));
      cache.set(record, keys);
    }
    return keys;
  }

  function artistRecordsShareSong(a, b, options = {}) {
    const aKeys = artistSongKeySetCached(a, options);
    if (!aKeys.size) return false;
    const bKeys = artistSongKeySetCached(b, options);
    for (const key of bKeys) {
      if (aKeys.has(key)) return true;
    }
    return false;
  }

  function hasAnyArtistIdentityAnnotation(record) {
    return artistRecordNames(record).some(hasArtistIdentityAnnotation);
  }

  function isLikelyArtistKeyTypo(left, right) {
    const a = String(left || "");
    const b = String(right || "");
    if (a.length < 6 || b.length < 6) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    return editDistanceAtMostOne(a, b);
  }

  function editDistanceAtMostOne(a, b) {
    if (a === b) return true;
    if (a.length === b.length) {
      let diff = 0;
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) diff += 1;
        if (diff > 1) return false;
      }
      return true;
    }
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    let diff = 0;
    let shortIndex = 0;
    for (let longIndex = 0; longIndex < longer.length; longIndex += 1) {
      if (longer[longIndex] === shorter[shortIndex]) {
        shortIndex += 1;
        continue;
      }
      diff += 1;
      if (diff > 1) return false;
    }
    return true;
  }

  function artistIdentityMatch(a, b) {
    const aNames = artistRecordNames(a);
    const bNames = artistRecordNames(b);
    for (const left of aNames) {
      for (const right of bNames) {
        if (hasArtistIdentityAnnotation(left) || hasArtistIdentityAnnotation(right)) continue;
        if (kanaNameMatchesLatinName(left, right) || kanaNameMatchesLatinName(right, left)) return true;
      }
    }
    return false;
  }

  function artistRecordNames(record) {
    const names = [];
    for (const entry of record.artists?.values?.() || []) {
      if (entry?.name) names.push(entry.name);
    }
    return uniqueStrings(names);
  }

  function kanaNameMatchesLatinName(kanaName, latinName) {
    const romanizedValues = kanaRomajiKeys(kanaName);
    if (!romanizedValues.length) return false;
    const tokens = latinArtistTokens(latinName);
    if (!tokens.length) return false;
    for (const romanized of romanizedValues) {
      if (romanized.length < 4) continue;
      for (const token of tokens) {
        if (token === romanized || token.startsWith(romanized) || token.endsWith(romanized)) return true;
      }
    }
    return false;
  }

  function kanaRomajiKeys(value) {
    const normalized = cleanText(value).normalize("NFKC");
    const segments = normalized.match(/[ぁ-んァ-ンー]{2,}/gu) || [];
    return uniqueStrings(
      segments
        .filter((segment) => kanaMoraCount(segment) >= 2)
        .map((segment) => normalizeArtistKey(romanizeJapaneseKana(segment)))
        .filter((key) => key.length >= 4),
    );
  }

  function kanaMoraCount(value) {
    return Array.from(toHiraganaString(value)).filter((char) => !/[ゃゅょぁぃぅぇぉゎー]/u.test(char)).length;
  }

  function latinArtistTokens(value) {
    return cleanText(value)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[a-z0-9]{2,}/gu) || [];
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
    mergeCountMap(target.variantLabelCounts, source.variantLabelCounts || new Map());
  }

  function mergeArtistRankRecord(target, source) {
    target.count += source.count;
    target.occurrences.push(...source.occurrences);
    mergeCountMap(target.songs, source.songs);
    mergeCountMap(target.channels, source.channels);
    mergeCountMap(target.aliasCounts, source.aliasCounts);
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
    incrementVariantLabel(record.variantLabelCounts, options.variantLabel);
  }

  function incrementVariantLabel(map, label) {
    const cleanLabel = cleanText(label);
    if (!cleanLabel) return;
    const key = normalizeEntityKey(cleanLabel);
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, name: cleanLabel, count: 0 });
    map.get(key).count += 1;
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
    return normalizeArtistIdentityText(value)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function normalizeSongTitleKey(value) {
    return normalizeJapaneseMonthWords(stripLeadingTitleListMarker(cleanText(value)))
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function normalizeSongWorkTitle(value) {
    const text = stripLeadingTitleListMarker(cleanText(value));
    const extracted = extractSongVariant(text);
    return {
      displayTitle: text,
      workTitle: extracted.workTitle || text,
      variantLabel: extracted.variantLabel || "",
      variantKind: extracted.variantKind || "",
    };
  }

  function songWorkTitleKey(value) {
    return normalizeSongTitleKey(normalizeSongWorkTitle(value).workTitle);
  }

  function extractSongVariant(value) {
    const text = cleanText(value).normalize("NFKC");
    if (!text) return { workTitle: "", variantLabel: "", variantKind: "" };
    const bracket = text.match(/^(.+?)\s*[(（［\[【「『]\s*([^()（）\[\]［］【】「」『』]{1,80})\s*[)）］\]】」』]\s*$/u);
    if (bracket && isWhitelistedSongVariant(bracket[2])) {
      return { workTitle: bracket[1].trim(), variantLabel: cleanVariantLabel(bracket[2]), variantKind: "version" };
    }
    const separated = text.match(/^(.+?)\s*(?:[-ー–—|｜:：/／])\s*(.{1,80})\s*$/u);
    if (separated && isWhitelistedSongVariant(separated[2])) {
      return { workTitle: separated[1].trim(), variantLabel: cleanVariantLabel(separated[2]), variantKind: "version" };
    }
    const spacedVariant = text.match(/^(.+?)\s+(.{1,80})\s*$/u);
    if (spacedVariant && isWhitelistedSongVariant(spacedVariant[2])) {
      return { workTitle: spacedVariant[1].trim(), variantLabel: cleanVariantLabel(spacedVariant[2]), variantKind: "version" };
    }
    const trailingListIndex = text.match(/^(.+?)\s+(?:[#＃]?\d{1,3}\s*(?:曲目|曲|番目))\s*$/u);
    if (trailingListIndex) {
      return { workTitle: trailingListIndex[1].trim(), variantLabel: cleanVariantLabel(text.slice(trailingListIndex[1].length)), variantKind: "list_marker" };
    }
    return { workTitle: text, variantLabel: "", variantKind: "" };
  }

  function cleanVariantLabel(value) {
    return cleanText(value).replace(/^[\s:：\-ー–—|｜/／]+/u, "").trim();
  }

  function isWhitelistedSongVariant(value) {
    const text = cleanVariantLabel(value).normalize("NFKC");
    return (
      /^(?:piano\s*(?:ver\.?|version)?|ピアノ\s*(?:ver\.?|版)?|acoustic\s*(?:ver\.?|version)?|アコースティック|弾き語り|a\s*cappella|acappella|アカペラ|short\s*(?:ver\.?|version)?|full\s*(?:ver\.?|version)?|tv\s*size|key\s*[+-]\s*\d+|キー\s*[+-]?\s*\d+|原キー|キー変更)$/iu.test(text)
    );
  }

  function finalizeSongRecords(records) {
    return records.map(finalizeSongRecord);
  }

  function finalizeSongRecord(record) {
    record.variantLabels = sortedCountEntries(record.variantLabelCounts || new Map()).map((entry) => entry.name);
    record.displayArtist = selectDisplayArtist(record);
    record.artistIdentityKey = record.displayArtist ? normalizeArtistKey(record.displayArtist) : "unknown";
    record.songIdentityKey = `${record.canonicalWorkTitleKey || record.titleKey || normalizeSongTitleKey(record.title)}::${record.artistIdentityKey}`;
    return record;
  }

  function mergeFinalDuplicateSongRecords(records, options = {}) {
    const byKey = new Map();
    for (const record of records) {
      const displayArtist = selectDisplayArtist(record);
      const key = [
        record.canonicalWorkTitleKey || record.titleKey || normalizeSongTitleKey(record.title),
        displayArtist ? normalizeArtistKey(displayArtist) : record.artistKey || "unknown",
      ].join("::");
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, record);
        continue;
      }
      const [winner, loser] = compareRecordDominance(existing, record) <= 0 ? [existing, record] : [record, existing];
      mergeRecord(winner, loser);
      if (winner === record) byKey.set(key, winner);
      applyDisplayTitle(winner, selectCanonicalTitle(new Map([[winner.title, winner.count], [loser.title, loser.count]])) || winner.title, options.makeSortKey || ((value) => value));
    }
    return Array.from(byKey.values());
  }

  function selectDisplayArtist(record) {
    const entries = sortedCountEntries(record.artists);
    if (!entries.length) return "";
    if (entries.length === 1 || shouldCollapseArtistAliases(entries)) return entries[0].name;
    return entries.slice(0, 2).map((entry) => (entry.count > 1 ? `${entry.name} (${entry.count})` : entry.name)).join("、");
  }

  function shouldCollapseArtistAliases(entries) {
    if (entries.length <= 1) return true;
    const dominant = entries[0];
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    const dominantKey = normalizeArtistKey(dominant.name);
    if (dominantKey && entries.every((entry) => normalizeArtistKey(entry.name) === dominantKey)) return true;
    if (dominant.count / total < 0.75) return false;
    return entries.slice(1).every((entry) => isDisplayArtistAliasOf(entry.name, dominant.name) || isLikelyArtistKeyTypo(normalizeArtistKey(entry.name), dominantKey));
  }

  function isDisplayArtistAliasOf(alias, canonical) {
    const canonicalKey = normalizeArtistKey(canonical);
    if (!canonicalKey) return false;
    return artistBaseKeys(alias, normalizeArtistKey).includes(canonicalKey);
  }

  function sortedCountEntries(map) {
    return Array.from(map?.values?.() || []).sort((a, b) => b.count - a.count || compareValues(a.name, b.name));
  }

  function countMapNames(map) {
    return Array.from(map?.values?.() || []).map((entry) => entry?.name || entry?.title || "").filter(Boolean);
  }

  function stripLeadingTitleListMarker(value) {
    let result = String(value ?? "");
    for (let index = 0; index < 4; index += 1) {
      const next = result
        .replace(/^\s*[╟├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼▶▷►▸▹>|・･●○◆◇■□♪♫♬♩♡♥◎★☆\uFE0F\u2600-\u27BF\u{1F300}-\u{1FAFF}⁅⁆]+/u, "")
        .replace(/^\s*[＊*]\s*(?=(?:[#＃]?\d{1,3}[.．](?![0-9０-９])|[#＃]?\d{1,3}[)）、:：]|[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]))/u, "")
        .replace(/^\s*[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]\s*/u, "")
        .replace(/^\s*(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})\s*(?:曲目|曲|番目)\s*(?:[.．。、,,:：)）\]\-|｜/／]+|\s+)/u, "")
        .replace(
          /^\s*(?:(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[\s。、,,:：)）\]\-|｜/／]+|(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[.．](?![0-9０-９])\s*)/u,
          "",
        );
      if (next === result) break;
      result = next;
    }
    return result;
  }

  function normalizeJapaneseMonthWords(value) {
    const monthDigits = {
      一: "1",
      二: "2",
      三: "3",
      四: "4",
      五: "5",
      六: "6",
      七: "7",
      八: "8",
      九: "9",
      十: "10",
      十一: "11",
      十二: "12",
    };
    return String(value ?? "").replace(/(十一|十二|十|[一二三四五六七八九])月/gu, (match, month) => `${monthDigits[month] || month}月`);
  }

  function normalizeArtistIdentityText(value) {
    let text = cleanText(value).normalize("NFKC");
    for (let index = 0; index < 4; index += 1) {
      const next = text
        .replace(/^[\s/／|｜￤∣丨┊┋・･:：\-—–−]+/u, "")
        .replace(/[\s/／|｜￤∣丨┊┋・･:：\-—–−]+$/u, "")
        .replace(/\s*(?:様|さん|氏)\s*$/u, "")
        .replace(/[\s/／|｜￤∣丨┊┋・･:：\-—–−]+$/u, "");
      if (next === text) break;
      text = next;
    }
    const duplicate = stripDuplicateArtistParenthetical(text);
    return duplicate || text;
  }

  function stripDuplicateArtistParenthetical(value) {
    const match = String(value).match(/^(.*?)\s*[(（［\[【「『]([^()（）\[\]［］【】「」『』]{1,100})[)）］\]】」』]\s*$/u);
    if (!match) return "";
    const base = match[1].trim();
    const annotation = match[2].trim();
    if (!base || !annotation || hasArtistIdentityAnnotation(annotation)) return "";
    const normalizedBase = base.toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
    const normalizedAnnotation = annotation.toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
    if (normalizedBase && normalizedBase === normalizedAnnotation) return base;
    if (/^[\p{Script=Latin}\p{Number}\s'’‘\-ー–—.]+$/u.test(annotation) && annotation.trim().split(/\s+/u).length >= 4) return base;
    return "";
  }

  function artistBaseKeys(value, normalizeArtist, options = {}) {
    const text = normalizeArtistIdentityText(value);
    const preserveIdentityAnnotations = options.preserveIdentityAnnotations === true;
    const workBase = stripArtistBeforeWorkAnnotation(text);
    const brokenBracketBase = stripArtistBeforeBrokenBracket(text);
    const candidates = [];
    if (!preserveIdentityAnnotations) addArtistBaseCandidate(candidates, stripArtistBeforeFeat(text), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(text), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(workBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistDescriptor(workBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistDescriptor(brokenBracketBase), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingLatinAlias(text), normalizeArtist);
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

  function stripTrailingLatinAlias(value) {
    const match = String(value).normalize("NFKC").match(/^(.+?)\s+([A-Z][A-Z0-9]{2,12})\s*$/u);
    if (!match) return "";
    if (!/[^\p{Script=Latin}\p{Number}\s]/u.test(match[1])) return "";
    return match[1].trim();
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
      /^\d{1,5}$/u.test(normalized) ||
      /^(?:(?:self\s*)?cover|covered|original|原曲|原唱|retake|take\s*\d+|key|キー|歌詞|調整|途中)$/iu.test(normalized) ||
      /^(?:official|channel|ch\.?|youtube|yt)$/iu.test(normalized) ||
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

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const KANA_DIGRAPHS = {
    きゃ: "kya", きゅ: "kyu", きょ: "kyo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
    しゃ: "sha", しゅ: "shu", しょ: "sho", しぇ: "she", じゃ: "ja", じゅ: "ju", じょ: "jo", じぇ: "je",
    ちゃ: "cha", ちゅ: "chu", ちょ: "cho", ちぇ: "che", にゃ: "nya", にゅ: "nyu", にょ: "nyo",
    ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo", びゃ: "bya", びゅ: "byu", びょ: "byo",
    ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo", みゃ: "mya", みゅ: "myu", みょ: "myo",
    りゃ: "rya", りゅ: "ryu", りょ: "ryo", ゔぁ: "va", ゔぃ: "vi", ゔぇ: "ve", ゔぉ: "vo",
    ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo", てぃ: "ti", でぃ: "di", とぅ: "tu", どぅ: "du",
  };

  const KANA_ROMAJI = {
    あ: "a", い: "i", う: "u", え: "e", お: "o", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
    か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
    さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
    た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to", だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
    な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
    ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
    ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo", ゃ: "ya", ゅ: "yu", ょ: "yo",
    ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n", ゔ: "vu",
  };

  function romanizeJapaneseKana(value) {
    const normalized = toHiraganaString(value);
    let result = "";
    let doubleNext = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (char === "っ") {
        doubleNext = true;
        continue;
      }
      if (char === "ー") {
        result += lastVowel(result);
        doubleNext = false;
        continue;
      }
      const pair = char + (normalized[index + 1] || "");
      let romanized = KANA_DIGRAPHS[pair];
      if (romanized) index += 1;
      else romanized = KANA_ROMAJI[char];
      if (romanized) {
        if (doubleNext) result += firstConsonant(romanized);
        result += romanized;
        doubleNext = false;
      } else {
        result += char;
        doubleNext = false;
      }
    }
    return result;
  }

  function toHiraganaString(value) {
    return String(value ?? "").normalize("NFKC").replace(/[ァ-ヶ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
  }

  function firstConsonant(value) {
    const match = String(value).match(/^[bcdfghjklmnpqrstvwxyz]/iu);
    return match ? match[0].toLowerCase() : "";
  }

  function lastVowel(value) {
    const match = String(value).match(/[aeiou](?!.*[aeiou])/iu);
    return match ? match[0].toLowerCase() : "";
  }

  return {
    buildArtistRecords,
    buildArtistSongGroups,
    buildCompetitionRanks,
    buildSongRecords,
    cleanText,
    extractSongVariant,
    isUnknownArtistName,
    artistIdentityMatch,
    kanaRomajiKeys,
    normalizeArtistKey,
    normalizeEntityKey,
    normalizeSongWorkTitle,
    normalizeSongTitleKey,
    songWorkTitleKey,
  };
});
