const fs = require("node:fs");
const path = require("node:path");
const {
  artistIdentityMatch,
  buildSongRecords,
  cleanText,
  kanaRomajiKeys,
  normalizeArtistKey,
  normalizeSongTitleKey,
} = require("../assets/ranking-utils");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "artifacts", "diagnostics", "song-identities");
const REVIEW_PATH = path.join(DATA_DIR, "review", "song-identity-candidates.json");

function main() {
  const latest = readJson(path.join(DATA_DIR, "latest.json"));
  const rawOccurrences = collectOccurrences(latest?.groups?.all?.items || []);
  const occurrences = rawOccurrences.filter((occurrence) => normalizeSongTitleKey(occurrence.song.title));
  const beforeKeys = new Set(occurrences.map((occurrence) => `${normalizeSongTitleKey(occurrence.song.title)}::${normalizeArtistKey(occurrence.song.artist) || "unknown"}`));
  const records = buildSongRecords(occurrences);
  const afterOccurrenceCount = records.reduce((sum, record) => sum + record.count, 0);
  const afterKeys = new Set(records.map((record) => record.key));
  const clusters = buildClusters(occurrences);
  const candidates = identityCandidates(clusters);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    titleClusterCount: clusters.length,
    multiArtistTitleClusterCount: clusters.filter((cluster) => cluster.artists.length > 1).length,
    autoMergeCandidateCount: candidates.filter((item) => item.match.confidence >= 0.85 && !item.match.blockers.length).length,
    reviewCandidateCount: candidates.length,
    possibleWrongMergeCount: candidates.filter((item) => item.match.blockers.length).length,
    beforeUniqueSongCount: beforeKeys.size,
    afterUniqueSongCount: afterKeys.size,
    ignoredInvalidTitleOccurrenceCount: rawOccurrences.length - occurrences.length,
    beforeOccurrenceCount: occurrences.length,
    afterOccurrenceCount,
    occurrenceConserved: occurrences.length === afterOccurrenceCount,
    candidates: candidates.slice(0, 500),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeJson(path.join(OUT_DIR, "diagnostic.json"), report);
  fs.writeFileSync(path.join(OUT_DIR, "diagnostic.md"), markdown(report), "utf8");
  writeJson(REVIEW_PATH, {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    identityVersion: "song-identity-v1",
    candidateCount: candidates.length,
    candidates,
  });
  console.log(
    `DIAGNOSE_SONG_IDENTITIES_OK clusters=${report.multiArtistTitleClusterCount} auto=${report.autoMergeCandidateCount} review=${report.reviewCandidateCount} occurrences=${report.beforeOccurrenceCount}/${report.afterOccurrenceCount} ignoredInvalidTitle=${report.ignoredInvalidTitleOccurrenceCount}`,
  );
  if (!report.occurrenceConserved) {
    throw new Error(`song identity occurrence conservation failed: ${report.beforeOccurrenceCount}/${report.afterOccurrenceCount}`);
  }
}

function collectOccurrences(items) {
  const result = [];
  for (const item of items || []) {
    for (const song of item.songs || []) {
      if (!cleanText(song.title)) continue;
      result.push({ item, song });
    }
  }
  return result;
}

function buildClusters(occurrences) {
  const byTitle = new Map();
  for (const occurrence of occurrences) {
    const titleKey = normalizeSongTitleKey(occurrence.song.title);
    const artist = cleanText(occurrence.song.artist);
    const artistKey = normalizeArtistKey(artist);
    if (!titleKey || !artistKey) continue;
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, { titleKey, titles: new Map(), artists: new Map(), occurrences: [] });
    const cluster = byTitle.get(titleKey);
    increment(cluster.titles, cleanText(occurrence.song.title));
    if (!cluster.artists.has(artistKey)) cluster.artists.set(artistKey, { artistKey, names: new Map(), occurrences: [] });
    increment(cluster.artists.get(artistKey).names, artist);
    cluster.artists.get(artistKey).occurrences.push(occurrence);
    cluster.occurrences.push(occurrence);
  }
  return [...byTitle.values()]
    .map((cluster) => ({
      ...cluster,
      title: topName(cluster.titles),
      artists: [...cluster.artists.values()].map((artist) => ({ ...artist, name: topName(artist.names), count: artist.occurrences.length })),
    }))
    .filter((cluster) => cluster.artists.length > 1);
}

function identityCandidates(clusters) {
  const candidates = [];
  for (const cluster of clusters) {
    for (let left = 0; left < cluster.artists.length; left += 1) {
      for (let right = left + 1; right < cluster.artists.length; right += 1) {
        const a = cluster.artists[left];
        const b = cluster.artists[right];
        const match = artistIdentityMatch(recordLike(a), recordLike(b));
        const kanaEvidence = [...kanaRomajiKeys(a.name), ...kanaRomajiKeys(b.name)];
        if (!match && !kanaEvidence.length) continue;
        const blockers = identityBlockers(a.name, b.name, cluster);
        const confidence = match && !blockers.length ? 0.9 : match ? 0.62 : 0.45;
        candidates.push({
          candidateId: `identity-candidate:${cluster.titleKey}:${a.artistKey}:${b.artistKey}`,
          kind: "artist_identity",
          current: { title: cluster.title, titleKey: cluster.titleKey, artist: a.name, artistKey: a.artistKey },
          proposed: { canonicalArtist: a.count >= b.count ? a.name : b.name, candidateArtist: a.count >= b.count ? b.name : a.name },
          match: {
            method: match ? "kana_romaji" : "review_only",
            confidence,
            reasons: match ? ["same_title", "kana_romaji_token_match", "unique_title_cluster_pair"] : ["same_title", "kana_romaji_evidence"],
            blockers,
          },
          evidence: {
            kanaRomajiKeys: kanaEvidence,
            videoIds: uniqueValues([...a.occurrences, ...b.occurrences].map((occurrence) => occurrence.item.videoId)).slice(0, 20),
            sourceHashes: uniqueValues([...a.occurrences, ...b.occurrences].map((occurrence) => occurrence.song.sourceHash)).slice(0, 20),
            occurrenceCount: a.count + b.count,
          },
          decision: { status: blockers.length ? "needs_review" : "pending", reviewedAt: "", reviewedBy: "", note: "" },
        });
      }
    }
  }
  return candidates.sort((a, b) => b.match.confidence - a.match.confidence || b.evidence.occurrenceCount - a.evidence.occurrenceCount);
}

function recordLike(artist) {
  return { artistKey: artist.artistKey, artists: new Map([[artist.artistKey, { name: artist.name, count: artist.count }]]) };
}

function identityBlockers(a, b, cluster) {
  const blockers = [];
  if (/\b(?:cv|starring|feat(?:uring)?|ft|member|members)\b|歌唱|声優|声优|聲優|組合|组合|成員|成员/iu.test(`${a} ${b}`)) {
    blockers.push("identity_annotation_conflict");
  }
  if (cluster.artists.length > 2) blockers.push("multi_candidate_title_group");
  return blockers;
}

function increment(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topName(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

function markdown(report) {
  return [
    "# Song Identity Diagnostic",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- 同标题多歌手 cluster 数: ${report.multiArtistTitleClusterCount}`,
    `- 可自动归并候选数: ${report.autoMergeCandidateCount}`,
    `- 需人工审查数: ${report.reviewCandidateCount}`,
    `- 归并前唯一歌曲数: ${report.beforeUniqueSongCount}`,
    `- 归并后唯一歌曲数: ${report.afterUniqueSongCount}`,
    `- 不参与身份迁移的无效标题 occurrence 数: ${report.ignoredInvalidTitleOccurrenceCount}`,
    `- occurrence 守恒: ${report.beforeOccurrenceCount} -> ${report.afterOccurrenceCount}`,
    "",
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

main();
