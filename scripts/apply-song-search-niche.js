const fs = require("node:fs");
const path = require("node:path");
const {
  annotatePayloadWithSongSearchNiche,
  refreshSongSearchIndex,
  songSearchSourceSummary,
} = require("./song-search-index");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const AUDIT_PATH = path.join(DATA_DIR, "audit.json");
const SNAPSHOT_INDEX_PATH = path.join(DATA_DIR, "snapshots", "index.json");
const SONG_SEARCH_INDEX_PATH = path.join(DATA_DIR, "song-search-known-songs.json");

if (require.main === module) {
  main().catch((error) => {
    console.error(`[song-search-niche] ${error.stack || error.message}`);
    process.exit(1);
  });
}

async function main() {
  const previousIndex = readJsonIfExists(SONG_SEARCH_INDEX_PATH);
  const songSearchIndex = await refreshSongSearchIndex({ previousIndex });
  const summary = songSearchSourceSummary(songSearchIndex);
  writeJson(SONG_SEARCH_INDEX_PATH, songSearchIndex);

  const latest = readJsonIfExists(LATEST_PATH);
  if (!latest?.groups) {
    console.log("[song-search-niche] no data/latest.json payload to annotate");
    return;
  }

  const annotatedLatest = attachSongSearchSummary(annotatePayloadWithSongSearchNiche(latest, songSearchIndex), summary);
  writeJson(LATEST_PATH, annotatedLatest);
  if (annotatedLatest.groups["72h"]) writeJson(path.join(DATA_DIR, "72h.json"), annotatedLatest.groups["72h"]);
  if (annotatedLatest.groups["1m"]) writeJson(path.join(DATA_DIR, "1m.json"), annotatedLatest.groups["1m"]);

  annotateLatestSnapshot(annotatedLatest, summary);
  annotateAudit(summary);

  console.log(
    `[song-search-niche] files=${summary.fileCount}/${summary.manifestFileCount} skipped=${summary.skippedFileCount} titleKeys=${summary.titleKeyCount} titleArtistKeys=${summary.titleArtistKeyCount}`,
  );
}

function attachSongSearchSummary(payload, summary) {
  return {
    ...payload,
    source: {
      ...(payload.source || {}),
      songSearch: summary,
    },
  };
}

function annotateLatestSnapshot(annotatedLatest, summary) {
  const snapshotIndex = readJsonIfExists(SNAPSHOT_INDEX_PATH);
  const latestEntry =
    (snapshotIndex?.snapshots || []).find((entry) => entry.id === snapshotIndex.latestSnapshotId) ||
    snapshotIndex?.snapshots?.[0];
  if (!latestEntry?.path) return;

  const snapshotPath = path.join(ROOT, latestEntry.path);
  const snapshot = readJsonIfExists(snapshotPath);
  if (!snapshot?.groups) return;
  writeJson(snapshotPath, {
    ...attachSongSearchSummary(snapshot, summary),
    groups: annotatedLatest.groups,
  });
}

function annotateAudit(summary) {
  const audit = readJsonIfExists(AUDIT_PATH);
  if (!audit) return;
  writeJson(AUDIT_PATH, {
    ...audit,
    songSearch: summary,
  });
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
