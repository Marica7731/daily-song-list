#!/usr/bin/env node
"use strict";

// Materialize high-confidence review candidates from the already-published static sources.
// Review sources are a bounded job artifact, not a second copy committed to git.

const fs = require("node:fs");
const path = require("node:path");
const { hashNormalizedText } = require("../curation");
const { parseTimestampSongs, repairPublishedSongMetadata } = require("../song-utils");

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = path.resolve(process.env.STATIC_DATA_ROOT || path.join(ROOT, "data/static/v1"));
const REVIEW_ROOT = path.resolve(process.env.STATIC_REVIEW_ROOT || path.join(ROOT, "data/review"));
const SOURCES_ROOT = path.join(DATA_ROOT, "sources");
const OUTPUT_ROOT = path.join(REVIEW_ROOT, "sources");
const NOW = new Date(process.env.STATIC_NOW || Date.now());

const EXPLICIT_PROMO_OR_SCHEDULE_RE = /(?:NEWS\s*速報|次回配信|記念配信|朝活配信|(?:発売|販売|受注|予約)中(?:です)?|(?:販売|受注|予約|受付)期間)/iu;
const DATE_OR_TIME_CONTEXT_RE = /(?:\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*日|\d{1,2}\s*(?::|時)\s*\d{0,2}|まで)/u;
const UNKNOWN_ARTIST_RE = /^(?:|未記載|unknown|n\/a)$/iu;
const CONFIRMED_RAW_REJECTIONS = new Set([
  "empty_after_timestamp",
  "obvious_non_song_text",
  "custom_emoji_only",
  "bad_title",
  "bad_artist",
  "section_marker_pair",
  "activity_marker_title",
  "activity_title",
  "title_only_non_song_candidate",
]);

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[static-dirty-export] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function main() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  for (const name of fs.readdirSync(OUTPUT_ROOT)) {
    if (name.endsWith(".json")) fs.rmSync(path.join(OUTPUT_ROOT, name), { force: true });
  }

  const files = listJsonFiles(SOURCES_ROOT);
  let sourceCount = 0;
  let candidateCount = 0;
  for (const file of files) {
    const video = readJson(file);
    if (!video || !/^[A-Za-z0-9_-]{11}$/u.test(String(video.videoId || ""))) continue;
    const groups = collectVideoCandidates(video);
    for (const group of groups.values()) {
      if (!group.entries.length) continue;
      writeJson(path.join(OUTPUT_ROOT, fileNameFor(video, group.sourceHash)), {
        schemaVersion: 1,
        generatedAt: NOW.toISOString(),
        video: {
          videoId: video.videoId,
          title: video.title || "",
          channelName: video.channelName || "",
          publishedAt: video.publishedAt || "",
        },
        source: {
          sourceId: group.sourceId,
          sourceHash: group.sourceHash,
        },
        entries: group.entries,
      });
      sourceCount += 1;
      candidateCount += group.entries.length;
    }
  }

  console.log(
    `[static-dirty-export] scannedSources=${files.length} reviewSources=${sourceCount} candidates=${candidateCount} output=${path.relative(ROOT, OUTPUT_ROOT)}`,
  );
}

function collectVideoCandidates(video) {
  const groups = new Map();
  for (const song of Array.isArray(video.songs) ? video.songs : []) {
    const seconds = Number(song?.seconds);
    if (!Number.isInteger(seconds) || seconds < 0) continue;
    const sourceId = String(
      song.sourceId || video.selectedSourceId || video.sourceId || `legacy:${video.videoId}`,
    );
    const sourceHash = String(
      song.sourceHash ||
        video.selectedSourceHash ||
        video.sourceHash ||
        hashNormalizedText(JSON.stringify((video.songs || []).map((entry) => [
          entry.seconds,
          entry.title,
          entry.artist,
          entry.raw || "",
        ]))),
    );
    const repaired = repairPublishedSongMetadata(song);
    let classification = "";
    let replacementSuggestion = null;
    let riskReasons = [];
    if (repaired.parserCorruption) {
      classification = "parser_corruption";
      replacementSuggestion = { title: repaired.title, artist: repaired.artist };
      riskReasons = ["published_artist_fragment"];
    } else {
      const rawNoiseReason = classifyRawLine(song, video, sourceId, sourceHash);
      if (rawNoiseReason) {
        classification = "confirmed_noise";
        riskReasons = [rawNoiseReason];
      }
    }
    if (!classification) continue;

    const key = `${sourceId}\u001f${sourceHash}`;
    if (!groups.has(key)) groups.set(key, { sourceId, sourceHash, entries: [] });
    groups.get(key).entries.push({
      seconds,
      rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || seconds} ${song.title || ""}`),
      title: song.title || "",
      artist: song.artist || "",
      raw: song.raw || "",
      classification,
      suggestedAction: classification === "confirmed_noise" ? "drop_entry" : "replace_entry",
      replacementSuggestion,
      riskReasons,
    });
  }
  return groups;
}

function classifyRawLine(song, video, sourceId, sourceHash) {
  const raw = String(song?.raw || "").trim();
  if (!raw) return "";

  const artist = String(song?.artist || "").trim();
  if (
    UNKNOWN_ARTIST_RE.test(artist) &&
    EXPLICIT_PROMO_OR_SCHEDULE_RE.test(raw) &&
    DATE_OR_TIME_CONTEXT_RE.test(raw)
  ) {
    return "explicit_schedule_or_promotion";
  }

  // Published fields have already lost list markers and artist fragments. Reparse the immutable
  // raw line before declaring noise so real songs with degraded display metadata stay intact.
  const rejections = [];
  const parsed = parseTimestampSongs(
    [{ text: raw, videoId: video.videoId, sourceId, sourceHash }],
    { onReject: (rejection) => rejections.push(rejection) },
  );
  if (parsed.length) return "";
  const rejection = rejections.find((candidate) => CONFIRMED_RAW_REJECTIONS.has(candidate.reason));
  return rejection ? `raw_${rejection.reason}` : "";
}

function listJsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...listJsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(target);
  }
  return result;
}

function fileNameFor(video, sourceHash) {
  const scope = isHistory(video.publishedAt) ? "history" : "current";
  return `${scope}-static-${video.videoId}-${String(sourceHash).slice(0, 20)}.json`;
}

function isHistory(publishedAt) {
  const timestamp = Date.parse(publishedAt || "");
  if (!Number.isFinite(timestamp)) return true;
  return timestamp < NOW.getTime() - 7 * 86400000;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

module.exports = {
  collectVideoCandidates,
  listJsonFiles,
};
