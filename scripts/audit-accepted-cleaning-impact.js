#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { normalizeArtistKey, normalizeSongTitleKey } = require("../assets/ranking-utils");
const { filterBlockedVideos, isBlockedSongEntry, isSingletonPseudoSongEntry } = require("../assets/source-filter");
const { applyCurationToVideos, classifyEntry, loadCurationContext, isUnknownArtist } = require("./curation");

const ROOT = path.resolve(__dirname, "..");
const ACCEPTED_DIR = path.join(ROOT, "data", "external", "youtube-channel-discovery", "accepted");
const RUNTIME_JSON_PATHS = [
  path.join(ROOT, "data", "latest.json"),
  path.join(ROOT, "data", "all.json"),
];

const TARGETS = [
  {
    id: "naraetan",
    label: "なれたん Naraetan Ch.",
    acceptedFile: "2026-07-19-naraetanV-full.json",
    match: /(?:naraetan|なれたん)/iu,
  },
  {
    id: "kanaruhanon",
    label: "Hanon Ch. 香鳴ハノン【パレプロ】",
    acceptedFile: "2026-07-19-kanaruhanon-full.json",
    match: /(?:kanaruhanon|香鳴ハノン)/iu,
  },
  {
    id: "isakiriona",
    label: "Riona Ch. 響咲リオナ - FLOW GLOW",
    acceptedFile: "",
    match: /(?:isakiriona|響咲リオナ|riona ch\.)/iu,
  },
];

const SAFE_SONGS = [
  ["START:DASH!!", "μ's"],
  ["ENDLESS STORY", "REIRA starring YUNA ITO"],
  ["Never Ending Story", "Limahl"],
];

const QUERY_TARGETS = [
  { id: "haru", q: "晴る" },
  { id: "bansanka", q: "晩餐歌" },
  { id: "hananinattee", q: "花になって" },
];

function main() {
  const context = loadCurationContext();
  const acceptedVideos = loadAcceptedVideos();
  const runtimeVideos = loadRuntimeVideos();
  const allVideos = [...acceptedVideos, ...runtimeVideos];
  const globalTitleStats = buildGlobalTitleStats(allVideos);
  const summaries = TARGETS.map((target) => summarizeTarget(target, acceptedVideos, runtimeVideos, globalTitleStats, context));
  const globalSummary = summarizeGlobal(allVideos, globalTitleStats, context);
  const querySummaries = QUERY_TARGETS.map((target) => summarizeQuery(target, allVideos, globalTitleStats, context));
  const safeSongChecks = SAFE_SONGS.map(([title, artist]) => {
    const source = { channelName: "Safety Fixture", channelHandle: "@safety" };
    const song = { title, artist, seconds: 1, raw: `0:01 ${title} / ${artist}` };
    const curated = applyCurationToVideos([{ videoId: "SAFESONG001", ...source, songs: [song] }], context);
    return {
      title,
      artist,
      sourceFilterBlocked: isBlockedSongEntry(song, source),
      curationKept: curated[0]?.songs?.length === 1,
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    acceptedDir: path.relative(ROOT, ACCEPTED_DIR).replace(/\\/g, "/"),
    runtimeJsons: RUNTIME_JSON_PATHS.filter((filePath) => fs.existsSync(filePath)).map((filePath) => path.relative(ROOT, filePath).replace(/\\/g, "/")),
    sourceInventory: buildSourceInventory(acceptedVideos),
    globalSummary,
    summaries,
    querySummaries,
    safeSongChecks,
  };

  const failedSafeSongs = safeSongChecks.filter((check) => check.sourceFilterBlocked || !check.curationKept);
  if (failedSafeSongs.length) {
    throw new Error(`safe song checks failed: ${failedSafeSongs.map((item) => `${item.title} / ${item.artist}`).join(", ")}`);
  }

  console.log(JSON.stringify(result, null, 2));
  console.log(
    [
      "CODEX_ACCEPTED_CLEANING_IMPACT_OK",
      ...summaries.map((summary) => `${summary.id}Raw=${summary.before.songRows}`),
      ...summaries.map((summary) => `${summary.id}After=${summary.after.songRows}`),
      ...summaries.map((summary) => `${summary.id}RawUnique=${summary.before.uniqueTitleRows}`),
      ...summaries.map((summary) => `${summary.id}AfterUnique=${summary.after.uniqueTitleRows}`),
      ...summaries.map((summary) => `${summary.id}SingletonPseudoBefore=${summary.before.singletonPseudoRows}`),
      ...summaries.map((summary) => `${summary.id}SingletonPseudoAfter=${summary.after.singletonPseudoRows}`),
      ...summaries.map((summary) => `${summary.id}DirtyBefore=${summary.before.ruleCandidateRows}`),
      ...summaries.map((summary) => `${summary.id}DirtyAfter=${summary.after.ruleCandidateRows}`),
      `globalRaw=${globalSummary.before.songRows}`,
      `globalAfter=${globalSummary.after.songRows}`,
      `globalDirtyBefore=${globalSummary.before.ruleCandidateRows}`,
      `globalDirtyAfter=${globalSummary.after.ruleCandidateRows}`,
      `globalSingletonPseudoBefore=${globalSummary.before.singletonPseudoRows}`,
      `globalSingletonPseudoAfter=${globalSummary.after.singletonPseudoRows}`,
      ...querySummaries.map((summary) => `${summary.id}Before=${summary.before.matchingTitleRows}`),
      ...querySummaries.map((summary) => `${summary.id}After=${summary.after.matchingTitleRows}`),
      ...querySummaries.map((summary) => `${summary.id}DirtyBefore=${summary.before.ruleCandidateRows}`),
      ...querySummaries.map((summary) => `${summary.id}DirtyAfter=${summary.after.ruleCandidateRows}`),
      `safeSongChecks=${safeSongChecks.length}`,
    ].join(" "),
  );
}

function buildSourceInventory(acceptedVideos) {
  const acceptedFiles = fs.existsSync(ACCEPTED_DIR) ? fs.readdirSync(ACCEPTED_DIR).filter((name) => name.endsWith(".json")).sort() : [];
  const artifactDiscoveryDir = path.join(ROOT, "artifacts", "channel-discovery");
  const artifactDiscoveryDirs = fs.existsSync(artifactDiscoveryDir) ? fs.readdirSync(artifactDiscoveryDir).sort() : [];
  const vsingerManifest = path.join(ROOT, "data", "external", "vsinger-http", "backfill", "manifest.json");
  return {
    acceptedFileCount: acceptedFiles.length,
    acceptedVideoRows: acceptedVideos.length,
    acceptedTargetFiles: TARGETS.filter((target) => target.acceptedFile).map((target) => ({
      id: target.id,
      file: target.acceptedFile,
      exists: fs.existsSync(path.join(ACCEPTED_DIR, target.acceptedFile)),
    })),
    artifactChannelDiscoveryDirs: artifactDiscoveryDirs,
    vsingerBackfillManifestExists: fs.existsSync(vsingerManifest),
    runtimeJsonsExist: RUNTIME_JSON_PATHS.map((filePath) => ({
      file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
      exists: fs.existsSync(filePath),
    })),
  };
}

function summarizeGlobal(allVideos, globalTitleStats, context) {
  const curationContext = { ...context, titleStats: globalTitleStats };
  const before = summarizeVideos(allVideos, allVideos, globalTitleStats, curationContext);
  const curated = applyCurationToVideos(filterBlockedVideos(deepClone(allVideos)), curationContext);
  const after = summarizeVideos(curated, allVideos, globalTitleStats, curationContext);
  return {
    sourceVideoRows: allVideos.length,
    before,
    after,
    delta: {
      songRows: before.songRows - after.songRows,
      unknownArtistRows: before.unknownArtistRows - after.unknownArtistRows,
      singletonUnknownRows: before.singletonUnknownRows - after.singletonUnknownRows,
      singletonPseudoRows: before.singletonPseudoRows - after.singletonPseudoRows,
      ruleCandidateRows: before.ruleCandidateRows - after.ruleCandidateRows,
      englishGlossArtistRows: before.englishGlossArtistRows - after.englishGlossArtistRows,
    },
    curationStats: curated.curationStats || {},
  };
}

function loadAcceptedVideos() {
  if (!fs.existsSync(ACCEPTED_DIR)) return [];
  const videos = [];
  for (const fileName of fs.readdirSync(ACCEPTED_DIR).filter((name) => name.endsWith(".json")).sort()) {
    const filePath = path.join(ACCEPTED_DIR, fileName);
    const payload = readJson(filePath);
    for (const video of Array.isArray(payload.videos) ? payload.videos : []) {
      if (!video || typeof video !== "object") continue;
      videos.push({
        ...video,
        sourceAuditKind: "accepted",
        sourceAuditFile: fileName,
      });
    }
  }
  return videos;
}

function loadRuntimeVideos() {
  const videos = [];
  for (const filePath of RUNTIME_JSON_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    const payload = readJson(filePath);
    const groups = payload.groups && typeof payload.groups === "object" ? payload.groups : {};
    const allItems = Array.isArray(groups.all?.items) ? groups.all.items : Array.isArray(payload.items) ? payload.items : [];
    for (const video of allItems) {
      if (!video || typeof video !== "object") continue;
      videos.push({
        ...video,
        sourceAuditKind: "runtime",
        sourceAuditFile: path.basename(filePath),
      });
    }
  }
  return videos;
}

function summarizeTarget(target, acceptedVideos, runtimeVideos, globalTitleStats, context) {
  const acceptedMatches = acceptedVideos.filter((video) => {
    if (target.acceptedFile && video.sourceAuditFile !== target.acceptedFile) return false;
    return matchesTarget(video, target);
  });
  const runtimeMatches = runtimeVideos.filter((video) => matchesTarget(video, target));
  const sourceVideos = acceptedMatches.length ? acceptedMatches : runtimeMatches;
  const sourceKind = acceptedMatches.length ? "accepted" : runtimeMatches.length ? "runtime" : "missing";
  const sourceFiles = [...new Set(sourceVideos.map((video) => video.sourceAuditFile).filter(Boolean))].sort();
  const curationContext = { ...context, titleStats: globalTitleStats };
  const before = summarizeVideos(sourceVideos, sourceVideos, globalTitleStats, curationContext);
  const curated = applyCurationToVideos(filterBlockedVideos(deepClone(sourceVideos)), curationContext);
  const after = summarizeVideos(curated, sourceVideos, globalTitleStats, curationContext);
  return {
    id: target.id,
    label: target.label,
    sourceKind,
    sourceFiles,
    videoRows: sourceVideos.length,
    before,
    after,
    delta: {
      songRows: before.songRows - after.songRows,
      unknownArtistRows: before.unknownArtistRows - after.unknownArtistRows,
      singletonUnknownRows: before.singletonUnknownRows - after.singletonUnknownRows,
      ruleCandidateRows: before.ruleCandidateRows - after.ruleCandidateRows,
    },
    curationStats: curated.curationStats || {},
  };
}

function summarizeQuery(target, videos, globalTitleStats, context) {
  const queryKey = singletonTitleKey(target.q);
  const sourceVideos = (videos || []).filter((video) => (video.songs || []).some((song) => queryMatchesSong(song, queryKey)));
  const curationContext = { ...context, titleStats: globalTitleStats };
  const before = summarizeQueryVideos(sourceVideos, sourceVideos, globalTitleStats, curationContext, queryKey);
  const curated = applyCurationToVideos(filterBlockedVideos(deepClone(sourceVideos)), curationContext);
  const after = summarizeQueryVideos(curated, sourceVideos, globalTitleStats, curationContext, queryKey);
  return {
    id: target.id,
    q: target.q,
    sourceVideoRows: sourceVideos.length,
    before,
    after,
    delta: {
      matchingTitleRows: before.matchingTitleRows - after.matchingTitleRows,
      exactTitleRows: before.exactTitleRows - after.exactTitleRows,
      unknownArtistRows: before.unknownArtistRows - after.unknownArtistRows,
      ruleCandidateRows: before.ruleCandidateRows - after.ruleCandidateRows,
    },
  };
}

function summarizeQueryVideos(videos, sourceVideos, globalTitleStats, context, queryKey) {
  const sourceByVideoId = new Map(sourceVideos.map((video) => [video.videoId, video]));
  const entries = [];
  for (const video of videos || []) {
    const source = sourceByVideoId.get(video.videoId) || video;
    for (const song of Array.isArray(video.songs) ? video.songs : []) {
      if (queryMatchesSong(song, queryKey)) entries.push({ song, source });
    }
  }
  return {
    matchingTitleRows: entries.length,
    exactTitleRows: entries.filter(({ song }) => songTitleKey(song) === queryKey).length,
    uniqueTitleRows: new Set(entries.map(({ song }) => songTitleKey(song)).filter(Boolean)).size,
    artistVariantRows: new Set(entries.map(({ song }) => normalizeArtistKey(song?.artist || "")).filter(Boolean)).size,
    unknownArtistRows: entries.filter(({ song }) => isUnknownArtist(song?.artist)).length,
    singletonPseudoRows: entries.filter(({ song }) => isSingletonPseudoSongEntry(song, globalTitleStats)).length,
    ruleCandidateRows: entries.filter(({ song, source }) => isRuleCandidate(song, source, context)).length,
    sampleRows: sampleSongs(entries, 8),
  };
}

function summarizeVideos(videos, sourceVideos, globalTitleStats, context) {
  const sourceByVideoId = new Map(sourceVideos.map((video) => [video.videoId, video]));
  const songs = [];
  for (const video of videos || []) {
    const source = sourceByVideoId.get(video.videoId) || video;
    for (const song of Array.isArray(video.songs) ? video.songs : []) {
      songs.push({ song, source });
    }
  }
  const unknownArtistRows = songs.filter(({ song }) => isUnknownArtist(song?.artist)).length;
  const singletonUnknownRows = songs.filter(({ song }) => isUnknownArtist(song?.artist) && globalTitleStats.get(songTitleKey(song))?.sourceCount === 1).length;
  const uniqueTitleRows = new Set(songs.map(({ song }) => songTitleKey(song)).filter(Boolean)).size;
  const singletonTitleRows = songs.filter(({ song }) => globalTitleStats.get(songTitleKey(song))?.sourceCount === 1).length;
  const englishGlossArtistRows = songs.filter(({ song }) => isEnglishGlossArtistRow(song)).length;
  const ruleCandidateRows = songs.filter(({ song, source }) => isRuleCandidate(song, source, context)).length;
  const singletonPseudoRows = songs.filter(({ song }) => isSingletonPseudoSongEntry(song, globalTitleStats)).length;
  return {
    songRows: songs.length,
    uniqueTitleRows,
    singletonTitleRows,
    singletonPseudoRows,
    unknownArtistRows,
    singletonUnknownRows,
    englishGlossArtistRows,
    ruleCandidateRows,
    safeSongRows: songs.filter(({ song }) => isSafeSong(song)).length,
    sampleRuleCandidates: sampleSongs(songs.filter(({ song, source }) => isRuleCandidate(song, source, context)), 10),
    sampleSingletonUnknowns: sampleSongs(songs.filter(({ song }) => isUnknownArtist(song?.artist) && globalTitleStats.get(songTitleKey(song))?.sourceCount === 1), 10),
    sampleEnglishGlossArtists: sampleSongs(songs.filter(({ song }) => isEnglishGlossArtistRow(song)), 10),
  };
}

function isRuleCandidate(song, source, context) {
  if (isBlockedSongEntry(song, source)) return true;
  const classification = classifyEntry(song, { video: source, rules: context.nonSongRules });
  return classification.suggestedAction === "drop_entry";
}

function buildGlobalTitleStats(videos) {
  const stats = new Map();
  for (const video of videos || []) {
    const sourceId = video.videoId || `${video.sourceAuditFile}:${video.title || ""}:${video.channelName || ""}`;
    for (const song of Array.isArray(video.songs) ? video.songs : []) {
      const key = songTitleKey(song);
      if (!key) continue;
      if (!stats.has(key)) stats.set(key, { rows: 0, sources: new Set(), artists: new Set() });
      const record = stats.get(key);
      record.rows += 1;
      record.sources.add(sourceId);
      if (!isUnknownArtist(song.artist)) record.artists.add(normalizeArtistKey(song.artist));
    }
  }
  for (const record of stats.values()) {
    record.sourceCount = record.sources.size;
    record.knownArtistCount = record.artists.size;
    delete record.sources;
    delete record.artists;
  }
  return stats;
}

function matchesTarget(video, target) {
  return target.match.test([video.channelName, video.channelHandle, video.channelUrl, video.channelId, video.title].filter(Boolean).join(" "));
}

function songTitleKey(song) {
  return singletonTitleKey(song?.title || "");
}

function queryMatchesSong(song, queryKey) {
  const key = songTitleKey(song);
  return Boolean(key && queryKey && key.includes(queryKey));
}

function isSafeSong(song) {
  const titleKey = normalizeSongTitleKey(song?.title || "");
  const artistKey = normalizeArtistKey(song?.artist || "");
  return SAFE_SONGS.some(([title, artist]) => titleKey === normalizeSongTitleKey(title) && artistKey === normalizeArtistKey(artist));
}

function singletonTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦♪♫♬♩]+/gu, "")
    .trim();
}

function isEnglishGlossArtistRow(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC");
  if (!title || !artist || isUnknownArtist(artist)) return false;
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(title)) return false;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(artist)) return false;
  if (!/[A-Za-z]/u.test(artist)) return false;
  if (!/[\/／]\s*[A-Za-z]/u.test(raw)) return false;
  const words = artist.match(/[A-Za-z][A-Za-z'’]*/gu) || [];
  if (words.length >= 4) return true;
  if (/^(?:I|I'm|I’m|You|We|They|It|That|This|There|A|An|The|Why|What|When|Where|How|Can|Will|Was|Were|For|Those|Things|Still|Collaboration|Did|My)\b/u.test(artist)) return true;
  return /\b(?:about|accidental|comment|chat|guide|hospital|food|drink|throat|birthday|surprised|recommendations?|poisoning|song|songs|story)\b/iu.test(artist);
}

function sampleSongs(entries, limit) {
  const seen = new Set();
  const result = [];
  for (const { song, source } of entries) {
    const label = `${song?.title || ""} / ${song?.artist || ""} @ ${source?.videoId || ""}`;
    if (seen.has(label)) continue;
    seen.add(label);
    result.push({
      title: song?.title || "",
      artist: song?.artist || "",
      videoId: source?.videoId || "",
      channelName: source?.channelName || "",
      raw: song?.raw || "",
    });
    if (result.length >= limit) break;
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`CODEX_ACCEPTED_CLEANING_IMPACT_FAIL ${error.stack || error.message}`);
    process.exit(1);
  }
}
