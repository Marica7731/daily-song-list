const fs = require("node:fs");
const path = require("node:path");
const {
  buildSongRecords,
  cleanText,
  normalizeArtistKey,
  normalizeSongTitleKey,
  normalizeSongWorkTitle,
  songWorkTitleKey,
} = require("../assets/ranking-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_ROOT = path.join(ROOT, "artifacts", "diagnostics", "song-dedup");

function main() {
  const args = process.argv.slice(2);
  const title = readArg(args, "--title") || args.find((arg) => !arg.startsWith("--"));
  if (!title) throw new Error("Usage: npm run diagnose:song-dedup -- --title <song title>");
  const payload = readJson(path.join(DATA_DIR, "latest.json"));
  const occurrences = collectOccurrences(payload?.groups?.all?.items || [], title);
  const beforeGroups = groupByLegacyIdentity(occurrences);
  const afterRecords = buildSongRecords(occurrences);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    title,
    occurrenceCount: occurrences.length,
    beforeRecordCount: beforeGroups.length,
    afterRecordCount: afterRecords.length,
    before: beforeGroups,
    after: afterRecords.map(compactRecord),
    occurrences: occurrences.map(compactOccurrence),
    explanation: explain(beforeGroups, afterRecords),
  };
  const outDir = path.join(OUT_ROOT, safePathSegment(title));
  fs.mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, "diagnostic.json"), report);
  fs.writeFileSync(path.join(outDir, "diagnostic.md"), markdown(report), "utf8");
  console.log(`DIAGNOSE_SONG_DEDUP_OK title=${title} occurrences=${occurrences.length} before=${beforeGroups.length} after=${afterRecords.length}`);
}

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] || "";
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function collectOccurrences(items, queryTitle) {
  const queryKey = normalizeSongTitleKey(queryTitle);
  const queryWorkKey = songWorkTitleKey(queryTitle);
  const result = [];
  for (const item of items || []) {
    for (const song of item.songs || []) {
      const title = cleanText(song.title);
      const titleKey = normalizeSongTitleKey(title);
      const workKey = songWorkTitleKey(title);
      if (titleKey !== queryKey && workKey !== queryWorkKey && !titleKey.includes(queryKey) && !workKey.includes(queryWorkKey)) continue;
      result.push({ item, song });
    }
  }
  return result;
}

function groupByLegacyIdentity(occurrences) {
  const groups = new Map();
  for (const occurrence of occurrences) {
    const title = cleanText(occurrence.song?.title);
    const artist = cleanText(occurrence.song?.artist);
    const titleKey = normalizeSongTitleKey(title);
    const artistKey = normalizeArtistKey(artist) || "unknown";
    const key = `${titleKey}::${artistKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title,
        artist,
        titleKey,
        artistKey,
        songIdentityKey: key,
        count: 0,
        videos: [],
        rawTitles: new Set(),
        rawArtists: new Set(),
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.videos.push(occurrence.item?.videoId || "");
    group.rawTitles.add(title);
    group.rawArtists.add(artist);
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    videos: [...new Set(group.videos)].filter(Boolean),
    rawTitles: [...group.rawTitles],
    rawArtists: [...group.rawArtists],
  }));
}

function compactRecord(record) {
  return {
    key: record.key,
    displayTitle: record.title,
    displayArtist: record.displayArtist || "",
    workTitle: record.workTitle || record.title,
    canonicalWorkTitleKey: record.canonicalWorkTitleKey || record.titleKey,
    artistIdentityKey: record.artistIdentityKey || "",
    songIdentityKey: record.songIdentityKey || "",
    count: record.count,
    videoCount: new Set(record.occurrences.map(({ item }) => item.videoId)).size,
    variantLabels: record.variantLabels || [],
    isNiche: record.occurrences.length > 0 && record.occurrences.every(({ song }) => song.isNiche === true || song.niche === true),
    rawTitles: [...new Set(record.occurrences.map(({ song }) => cleanText(song.title)))],
    rawArtists: [...new Set(record.occurrences.map(({ song }) => cleanText(song.artist)))],
    videos: [...new Set(record.occurrences.map(({ item }) => item.videoId).filter(Boolean))],
  };
}

function compactOccurrence({ item, song }) {
  const work = normalizeSongWorkTitle(song.title);
  const titleKey = normalizeSongTitleKey(song.title);
  const artistKey = normalizeArtistKey(song.artist) || "unknown";
  const workKey = songWorkTitleKey(song.title);
  return {
    rawTitle: cleanText(song.title),
    rawArtist: cleanText(song.artist),
    normalizedTitle: normalizeSongTitleKey(song.title),
    normalizedArtist: normalizeArtistKey(song.artist),
    workTitle: work.workTitle,
    variantLabel: work.variantLabel,
    titleKey,
    artistKey,
    artistIdentityKey: artistKey,
    songIdentityKey: `${workKey}::${artistKey}`,
    sourceVideoId: item.videoId || "",
    seconds: Math.max(0, Number(song.seconds) || 0),
    rawHash: song.rawHash || "",
  };
}

function explain(before, after) {
  const reasons = [];
  if (before.length > after.length) reasons.push("legacy_title_artist_keys_split_same_work");
  if (before.some((group) => /piano|ピアノ/iu.test(group.title))) reasons.push("version_suffix_was_part_of_title_key");
  if (before.some((group) => /radwinps/iu.test(group.artistKey))) reasons.push("dominant_artist_typo_variant");
  if (before.some((group) => /\d{1,3}曲目/u.test(group.title))) reasons.push("trailing_setlist_index_was_part_of_title_key");
  return reasons.length ? reasons : ["no_split_detected"];
}

function markdown(report) {
  return [
    `# Song Dedup Diagnostic: ${report.title}`,
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- occurrences: ${report.occurrenceCount}`,
    `- before records: ${report.beforeRecordCount}`,
    `- after records: ${report.afterRecordCount}`,
    `- explanation: ${report.explanation.join(", ")}`,
    "",
    "## Before",
    ...report.before.map((group) => `- ${group.title} / ${group.artist || "待补歌手"} key=${group.songIdentityKey} count=${group.count} videos=${group.videos.join(",")}`),
    "",
    "## After",
    ...report.after.map((record) => `- ${record.displayTitle} / ${record.displayArtist || "待补歌手"} key=${record.songIdentityKey} count=${record.count} variants=${record.variantLabels.join(",") || "-"}`),
    "",
  ].join("\n");
}

function safePathSegment(value) {
  return cleanText(value).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").slice(0, 80) || "song";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main();
