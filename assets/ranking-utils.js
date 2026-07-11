(function initRankingUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.RankingUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createRankingUtils() {
  const UNKNOWN_ARTISTS = new Set(["unknown", "n/a", "na", "未記載", "未记载", "不明", "无", "なし", "-"]);

  function buildSongRecords(occurrences, options = {}) {
    const clean = options.cleanText || cleanText;
    const normalize = options.normalizeEntityKey || normalizeEntityKey;
    const makeSortKey = options.makeSongSortKey || ((value) => normalize(value));
    const increment = options.incrementCount || incrementCount;
    const titleGroups = new Map();

    for (const occurrence of occurrences || []) {
      const title = clean(occurrence?.song?.title);
      const titleKey = normalize(title);
      if (!titleKey) continue;

      if (!titleGroups.has(titleKey)) {
        titleGroups.set(titleKey, {
          titleKey,
          title,
          knownArtists: new Map(),
          unknownOccurrences: [],
        });
      }

      const titleGroup = titleGroups.get(titleKey);
      const artist = clean(occurrence?.song?.artist);
      const artistKey = normalize(artist);
      if (isKnownArtist(artist, artistKey)) {
        if (!titleGroup.knownArtists.has(artistKey)) {
          titleGroup.knownArtists.set(artistKey, {
            key: `${titleKey}::${artistKey}`,
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

    const records = [];
    for (const titleGroup of titleGroups.values()) {
      const knownRecords = Array.from(titleGroup.knownArtists.values());
      for (const record of knownRecords) records.push(record);

      if (!titleGroup.unknownOccurrences.length) continue;
      if (knownRecords.length === 1) {
        for (const occurrence of titleGroup.unknownOccurrences) {
          addOccurrence(knownRecords[0], occurrence, { clean, increment, skipArtist: true });
        }
        continue;
      }

      const unknownRecord = {
        key: `${titleGroup.titleKey}::unknown`,
        title: titleGroup.title,
        sortKey: makeSortKey(titleGroup.title),
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

  return {
    buildCompetitionRanks,
    buildSongRecords,
    cleanText,
    normalizeEntityKey,
  };
});
