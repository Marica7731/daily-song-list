#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const RankingUtils = require("../assets/ranking-utils");
const { isUnknownArtist } = require("./curation");
const { classifyTitlePattern, normalizeHandle } = require("./audit-global-song-quality");

const DEFAULT_API_BASE = "https://ytb-song-rank.culua.com";
const PAGE_SIZE = 20;

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_PRODUCTION_PAGE_AUDIT_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.mkdirSync(args.checkpointDir, { recursive: true });

  const health = await fetchJson(`${args.apiBase}/healthz`, args.timeoutMs);
  const meta = await fetchJson(`${args.apiBase}/api/meta`, args.timeoutMs);
  const sourceSignature = sha256Json({
    apiBase: args.apiBase,
    healthBuiltAt: health.builtAt || health.latestGeneratedAt || "",
    meta: meta.meta || meta,
  });

  const pages = [];
  for (const spec of pageSpecs()) {
    const checkpointPath = path.join(args.checkpointDir, `${spec.id}.json`);
    let payload = readJsonIfExists(checkpointPath);
    if (payload?.checkpoint?.sourceSignature === sourceSignature) {
      console.log(`CODEX_PRODUCTION_PAGE_AUDIT_PHASE phase=page_resume page=${spec.id}`);
    } else {
      const query = new URLSearchParams({
        range: "all",
        view: "vtubers",
        metric: spec.metric,
        page: String(spec.page),
        pageSize: String(PAGE_SIZE),
      });
      const response = await fetchJson(`${args.apiBase}/api/rankings?${query}`, args.timeoutMs);
      payload = {
        checkpoint: {
          sourceSignature,
          fetchedAt: new Date().toISOString(),
          apiUrl: `${args.apiBase}/api/rankings?${query}`,
        },
        spec,
        response,
      };
      writeJsonAtomic(checkpointPath, payload);
      console.log(`CODEX_PRODUCTION_PAGE_AUDIT_PHASE phase=page_fetch_ok page=${spec.id} records=${response.records?.length || 0}`);
    }
    pages.push(auditPagePayload(spec, payload.response));
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apiBase: args.apiBase,
    sourceSignature,
    health,
    meta,
    pages,
  };
  writeArtifacts(args.outputDir, report);
  console.log(
    `CODEX_PRODUCTION_PAGE_AUDIT_OK output=${args.outputDir} pages=${pages.length} `
      + `channels=${pages.reduce((sum, page) => sum + page.channels.length, 0)} `
      + `expandedSongs=${pages.reduce((sum, page) => sum + page.expandedSongCount, 0)}`,
  );
}

function parseArgs(argv) {
  const args = {
    apiBase: DEFAULT_API_BASE,
    outputDir: "",
    checkpointDir: "",
    timeoutMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--api-base") args.apiBase = requireValue(argv, ++index, name).replace(/\/+$/u, "");
    else if (name === "--output-dir") args.outputDir = requireValue(argv, ++index, name);
    else if (name === "--checkpoint-dir") args.checkpointDir = requireValue(argv, ++index, name);
    else if (name === "--timeout-ms") args.timeoutMs = positiveInteger(requireValue(argv, ++index, name), 30_000);
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!args.outputDir) throw new Error("--output-dir is required");
  args.outputDir = path.resolve(args.outputDir);
  args.checkpointDir = path.resolve(args.checkpointDir || path.join(args.outputDir, "checkpoint-pages"));
  return args;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function pageSpecs() {
  return [
    { id: "occurrences-page-1", metric: "count", page: 1, uiQuery: "range=all&view=vtuberRank&pageSize=20&page=1" },
    { id: "occurrences-page-2", metric: "count", page: 2, uiQuery: "range=all&view=vtuberRank&pageSize=20&page=2" },
    { id: "songs-page-1", metric: "songs", page: 1, uiQuery: "range=all&view=vtuberRank&metric=songs&pageSize=20&page=1" },
    { id: "songs-page-2", metric: "songs", page: 2, uiQuery: "range=all&view=vtuberRank&metric=songs&pageSize=20&page=2" },
  ];
}

function auditPagePayload(spec, response) {
  const records = Array.isArray(response?.records) ? response.records : [];
  if (records.length !== PAGE_SIZE) {
    throw new Error(`${spec.id} expected ${PAGE_SIZE} channel records, received ${records.length}`);
  }
  const channels = records.map((record) => auditChannelRecord(record, spec));
  const incomplete = channels.filter((channel) => channel.expandedSongs !== channel.songCount);
  return {
    id: spec.id,
    metric: spec.metric,
    page: spec.page,
    uiUrl: `${DEFAULT_API_BASE}/?${spec.uiQuery}`,
    apiPage: Number(response.page) || spec.page,
    pageSize: Number(response.pageSize) || PAGE_SIZE,
    total: Number(response.total) || 0,
    pageCount: Number(response.pageCount) || 0,
    channelCount: channels.length,
    expandedSongCount: channels.reduce((sum, channel) => sum + channel.expandedSongs, 0),
    summaryCountMismatchCount: incomplete.length,
    summaryCountMismatches: incomplete.map((channel) => ({
      rank: channel.rank,
      name: channel.name,
      songCount: channel.songCount,
      expandedSongs: channel.expandedSongs,
    })),
    issueCounts: sumIssueCounts(channels),
    channels,
  };
}

function auditChannelRecord(record, spec = {}) {
  const songs = Array.isArray(record?.songs) ? record.songs.map(normalizeSongRecord) : [];
  const groups = groupSongsByTitle(songs);
  const unknownArtist = songs.filter((song) => song.unknownArtist);
  const obviousConversation = songs.filter((song) => song.titlePattern === "conversation_or_transition"
    || song.titlePattern === "numeric_only"
    || song.titlePattern === "punctuation_only");
  const singletonLikelyReal = songs.filter((song) => song.occurrences === 1
    && !song.unknownArtist
    && song.titlePattern === "normal");
  const unknownFillCandidates = [];
  const sameTitleArtistConflicts = [];
  for (const group of groups.values()) {
    const knownArtists = Array.from(group.knownArtists.entries())
      .map(([artist, occurrences]) => ({ artist, occurrences }))
      .sort((left, right) => right.occurrences - left.occurrences || left.artist.localeCompare(right.artist));
    if (group.unknown.length && knownArtists.length === 1 && knownArtists[0].occurrences >= 3) {
      unknownFillCandidates.push({
        title: group.title,
        unknownOccurrences: group.unknown.reduce((sum, song) => sum + song.occurrences, 0),
        inferredArtist: knownArtists[0].artist,
        knownOccurrences: knownArtists[0].occurrences,
      });
    }
    if (knownArtists.length > 1) {
      sameTitleArtistConflicts.push({
        title: group.title,
        knownArtists,
        hasUnknownArtist: group.unknown.length > 0,
      });
    }
  }
  return {
    pageMetric: spec.metric || "",
    page: Number(spec.page) || 0,
    rank: Number(record.rank) || 0,
    key: cleanText(record.key),
    sourceDetailKey: cleanText(record.sourceDetailKey),
    name: cleanText(record.name || record.channelName),
    channelId: cleanText(record.channelId),
    handle: normalizeHandle(record.channelHandle || record.channelUrl || record.sourceUrl),
    sourceUrl: cleanText(record.sourceUrl || record.channelUrl),
    occurrences: Number(record.count) || 0,
    videoCount: Number(record.videoCount) || 0,
    songCount: Number(record.songCount) || 0,
    singletonSongCount: Number(record.singletonSongCount) || songs.filter((song) => song.occurrences === 1).length,
    expandedSongs: songs.length,
    issues: {
      summaryCountMismatch: songs.length !== Number(record.songCount),
      obviousConversation,
      unknownArtist,
      unknownFillCandidates,
      possibleSpellingSplits: possibleSpellingSplits(songs),
      sameTitleArtistConflicts,
    },
    preservedSingletonSamples: singletonLikelyReal.slice(0, 20),
    songs,
  };
}

function normalizeSongRecord(song) {
  const title = cleanText(song.canonicalTitle || song.title || song.displayTitle || song.name);
  const artist = cleanText(song.canonicalArtist || song.displayArtist || song.artist);
  const artistAvailable = Boolean(artist);
  const occurrences = Number(song.count ?? song.occurrences ?? song.occurrenceCount) || 0;
  return {
    key: cleanText(song.key),
    title,
    artist,
    artistAvailable,
    occurrences,
    videoCount: Number(song.videoCount) || 0,
    isNiche: song.isNiche === true,
    unknownArtist: artistAvailable && isUnknownArtist(artist),
    titlePattern: classifyTitlePattern(title, artist || "未記載"),
  };
}

function groupSongsByTitle(songs) {
  const groups = new Map();
  for (const song of songs) {
    const key = RankingUtils.songWorkTitleKey(song.title) || RankingUtils.normalizeSongTitleKey(song.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { title: song.title, knownArtists: new Map(), unknown: [] });
    const group = groups.get(key);
    if (song.unknownArtist) group.unknown.push(song);
    else group.knownArtists.set(song.artist, (group.knownArtists.get(song.artist) || 0) + song.occurrences);
  }
  return groups;
}

function possibleSpellingSplits(songs) {
  const byLooseKey = new Map();
  for (const song of songs) {
    const looseKey = looseTitleKey(song.title);
    if (!looseKey) continue;
    if (!byLooseKey.has(looseKey)) byLooseKey.set(looseKey, []);
    byLooseKey.get(looseKey).push(song);
  }
  return Array.from(byLooseKey.values())
    .filter((records) => new Set(records.map((song) => `${song.title}\u0001${song.artist}`)).size > 1)
    .map((records) => ({
      variants: records.map((song) => ({
        title: song.title,
        artist: song.artist,
        occurrences: song.occurrences,
      })),
    }))
    .slice(0, 100);
}

function looseTitleKey(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/(?:feat\.?|ft\.?|cover|ver\.?|version)/giu, "")
    .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’・･,，.。:：;；!！?？~～\-—–−_/／|｜￤∣丨✦♪♫♬♩]/gu, "");
}

function sumIssueCounts(channels) {
  return {
    obviousConversation: channels.reduce((sum, channel) => sum + channel.issues.obviousConversation.length, 0),
    unknownArtist: channels.reduce((sum, channel) => sum + channel.issues.unknownArtist.length, 0),
    unknownFillCandidates: channels.reduce((sum, channel) => sum + channel.issues.unknownFillCandidates.length, 0),
    possibleSpellingSplits: channels.reduce((sum, channel) => sum + channel.issues.possibleSpellingSplits.length, 0),
    sameTitleArtistConflicts: channels.reduce((sum, channel) => sum + channel.issues.sameTitleArtistConflicts.length, 0),
  };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "daily-song-list-audit/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeArtifacts(outputDir, report) {
  writeJsonAtomic(path.join(outputDir, "four-pages.json"), report);
  const flatRows = [];
  for (const page of report.pages) {
    for (const channel of page.channels) {
      for (const song of channel.songs) {
        flatRows.push({
          pageId: page.id,
          metric: page.metric,
          page: page.page,
          rank: channel.rank,
          channelKey: channel.key,
          channelName: channel.name,
          channelId: channel.channelId,
          channelHandle: channel.handle,
          ...song,
        });
      }
    }
  }
  fs.writeFileSync(
    path.join(outputDir, "four-pages.jsonl.gz"),
    zlib.gzipSync(`${flatRows.map((row) => JSON.stringify(row)).join("\n")}\n`, { level: 9 }),
  );
  fs.writeFileSync(path.join(outputDir, "four-pages.md"), renderMarkdown(report), "utf8");
  const names = ["four-pages.json", "four-pages.jsonl.gz", "four-pages.md"];
  writeJsonAtomic(path.join(outputDir, "four-pages-manifest.json"), {
    schemaVersion: 1,
    status: "complete",
    generatedAt: report.generatedAt,
    sourceSignature: report.sourceSignature,
    pages: report.pages.map((page) => ({
      id: page.id,
      channelCount: page.channelCount,
      expandedSongCount: page.expandedSongCount,
    })),
    artifacts: Object.fromEntries(names.map((name) => [name, fileDigest(path.join(outputDir, name))])),
  });
}

function renderMarkdown(report) {
  const lines = [
    "# Production VTuber ranking pages audit",
    "",
    `- API: \`${report.apiBase}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Source signature: \`${report.sourceSignature}\``,
    "",
  ];
  for (const page of report.pages) {
    lines.push(
      `## ${page.id}`,
      "",
      `UI: ${page.uiUrl}`,
      "",
      `Channels: ${page.channelCount}; expanded songs: ${page.expandedSongCount}.`,
      "",
      "| Rank | Channel | Songs | Expanded | Videos | Occurrences | Count mismatch | Explicit unknown | Conversation/numeric | Spelling splits | Same-title conflicts |",
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...page.channels.map((channel) => (
        `| ${channel.rank} | ${escapeMarkdown(channel.name || channel.handle || channel.key)} | `
          + `${channel.songCount} | ${channel.expandedSongs} | ${channel.videoCount} | ${channel.occurrences} | `
          + `${channel.issues.summaryCountMismatch ? "yes" : ""} | `
          + `${channel.issues.unknownArtist.length} | ${channel.issues.obviousConversation.length} | `
          + `${channel.issues.possibleSpellingSplits.length} | ${channel.issues.sameTitleArtistConflicts.length} |`
      )),
      "",
    );
  }
  lines.push(
    "The full expanded song rows are retained in `four-pages.json` and `four-pages.jsonl.gz`.",
    "The VTuber ranking expansion exposes song name/key/count but not artist; missing artist fields are not counted as unknown.",
    "A ranking `songCount`/embedded-song mismatch is retained as an audit finding; source-level completeness is checked against the materialized SQLite report.",
    "Singleton rows are never marked for deletion from frequency alone.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function fileDigest(filePath) {
  const value = fs.readFileSync(filePath);
  return { bytes: value.length, sha256: sha256(value) };
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function escapeMarkdown(value) {
  return cleanText(value).replace(/\|/gu, "\\|");
}

module.exports = {
  auditChannelRecord,
  auditPagePayload,
  looseTitleKey,
  pageSpecs,
};
