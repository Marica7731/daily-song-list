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
    const normalize = options.normalizeEntityKey || normalizeEntityKey;
    const increment = options.incrementCount || incrementCount;
    const records = new Map();
    let missingArtistCount = 0;

    for (const occurrence of occurrences || []) {
      const artist = clean(occurrence?.song?.artist);
      if (isUnknownArtistName(artist)) {
        missingArtistCount += 1;
        continue;
      }

      const key = normalize(artist);
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
        });
      }

      const record = records.get(key);
      record.count += 1;
      record.occurrences.push(occurrence);
      increment(record.songs, clean(occurrence?.song?.title));
      increment(record.channels, clean(occurrence?.item?.channelName));
    }

    return { records: Array.from(records.values()), missingArtistCount };
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
        .replace(/^\s*[╟├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼▶▷►▸▹>|・･●○◆◇■□♪♫♬♩♡♥◎★☆\uFE0F]+/u, "")
        .replace(/^\s*[\u2460-\u2473\u24f5-\u24fe\u2776-\u2793\u3251-\u325f\u32b1-\u32bf]\s*/u, "")
        .replace(/^\s*(?:[#＃]?\d{1,3}|[0-9０-９]{1,3})[\s.．。、,,:：)）\]\-|｜/／]+/u, "");
      if (next === result) break;
      result = next;
    }
    return result;
  }

  function artistBaseKeys(value, normalizeArtist) {
    const text = cleanText(value).normalize("NFKC");
    const workBase = stripArtistBeforeWorkAnnotation(text);
    const brokenBracketBase = stripArtistBeforeBrokenBracket(text);
    const candidates = [];
    addArtistBaseCandidate(candidates, stripArtistBeforeFeat(text), normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(text), normalizeArtist);
    addArtistBaseCandidate(candidates, workBase, normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(workBase), normalizeArtist);
    addArtistBaseCandidate(candidates, brokenBracketBase, normalizeArtist);
    addArtistBaseCandidate(candidates, stripTrailingNonArtistParenthetical(brokenBracketBase), normalizeArtist);
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
    const match = String(value).match(/^(.*?)\s*[(（［\[]([^()（）\[\]［］]{1,100})[)）］\]]\s*$/u);
    if (!match) return "";
    return isNonArtistDescriptor(match[2]) ? match[1].trim() : "";
  }

  function stripArtistBeforeWorkAnnotation(value) {
    const match = String(value).match(/^(.*?)\s*(?:\/|／)\s*(?:TV|アニメ|映画|ドラマ|OP|ED|主題歌|テーマ).+$/iu);
    return match ? match[1].trim() : "";
  }

  function stripArtistBeforeBrokenBracket(value) {
    const match = String(value).match(/^(.*?)\s*(?:[-ー–—]\s*)?【.*$/u);
    return match ? match[1].trim() : "";
  }

  function isNonArtistDescriptor(value) {
    const text = cleanText(value).normalize("NFKC");
    if (!text || /\b(?:cv|starring|feat|ft|vocal)\b|歌唱|声優/iu.test(text)) return false;
    return (
      /^(?:19|20)\d{2}年?$/u.test(text) ||
      /(?:ver\.?|version|retake|piano|acoustic|cover|key|キー|ピアノ|アカペラ|セルフ|歌詞|調整|途中|原曲)/iu.test(text) ||
      /(?:TV|アニメ|映画|ドラマ|OP|ED|主題歌|テーマ|CM|機動戦士|ガンダム|NARUTO|エヴァンゲリオン)/iu.test(text)
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
    buildCompetitionRanks,
    buildSongRecords,
    cleanText,
    isUnknownArtistName,
    normalizeArtistKey,
    normalizeEntityKey,
    normalizeSongTitleKey,
  };
});
