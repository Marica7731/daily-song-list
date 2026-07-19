#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { readJson, writeJson } = require("./bundle-writer");
const { sha256 } = require("./html-utils");
const { parseArgs } = require("./crawl-core");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SINGERS_FILE = path.join(ROOT, "artifacts", "vsinger-http-backfill", "current-singers", "singers.json");
const DEFAULT_BACKFILL_DIR = path.join(ROOT, "data", "external", "vsinger-http", "backfill");
const DEFAULT_OUTPUT = path.join(ROOT, "data", "external", "vsinger-http", "singer-catalog.json");
const DEFAULT_REPORT = path.join(ROOT, "data", "external", "vsinger-http", "singer-catalog-report.md");
const DEFAULT_TARGETS = path.join(ROOT, "artifacts", "vsinger-http-backfill", "current-singers", "backfill-targets.json");

function auditSingerCatalog(options = {}) {
  const args = { ...options };
  const generatedAt = args.generatedAt || new Date().toISOString();
  const singersFile = path.resolve(args["singers-file"] || DEFAULT_SINGERS_FILE);
  const backfillDir = path.resolve(args["backfill-dir"] || DEFAULT_BACKFILL_DIR);
  const outputPath = path.resolve(args.output || DEFAULT_OUTPUT);
  const reportPath = path.resolve(args.report || DEFAULT_REPORT);
  const targetsPath = path.resolve(args["targets-output"] || DEFAULT_TARGETS);
  const minVideoGap = Number(args["min-video-gap"] || 1);

  const singers = readJson(singersFile, null);
  if (!Array.isArray(singers)) throw new Error(`Singer catalog must be an array: ${singersFile}`);
  const manifest = readJson(path.join(backfillDir, "manifest.json"), null);
  if (!manifest) throw new Error(`Missing VSinger backfill manifest: ${path.join(backfillDir, "manifest.json")}`);
  const videos = readManifestArrayShards(backfillDir, manifest, "videos");
  const importedByName = countImportedVideosBySingerName(videos);

  const rows = singers.map((singer) => {
    const importedVideoCount = importedByName.get(cleanText(singer.singerName)) || 0;
    const sourceVideoCount = positiveIntegerOrZero(singer.streamVideoCount);
    const videoGap = Math.max(0, sourceVideoCount - importedVideoCount);
    return {
      externalSingerId: singer.externalSingerId || "",
      singerName: singer.singerName || "",
      singerPageUrl: singer.singerPageUrl || "",
      singerSongsUrl: singer.singerSongsUrl || "",
      singerStreamsUrl: singer.singerStreamsUrl || "",
      youtubeChannelUrl: singer.youtubeChannelUrl || "",
      youtubeChannelId: singer.youtubeChannelId || "",
      imageUrl: singer.imageUrl || "",
      lastStreamText: singer.lastStreamText || "",
      lastStreamDate: singer.lastStreamDate || "",
      sourceTotalSingingCount: positiveIntegerOrZero(singer.totalSingingCount),
      sourceStreamVideoCount: sourceVideoCount,
      sourceRepertoireSongCount: positiveIntegerOrZero(singer.repertoireSongCount),
      importedVideoCountBySingerName: importedVideoCount,
      videoGap,
      importStatus: classifyImportStatus({ sourceVideoCount, importedVideoCount, videoGap, minVideoGap }),
      sourceSystem: singer.sourceSystem || "vsinger_moment_http",
      sourceFetchedAt: singer.fetchedAt || "",
    };
  });

  const targets = rows
    .filter((row) => row.videoGap >= minVideoGap && row.sourceStreamVideoCount > 0)
    .sort((left, right) => right.videoGap - left.videoGap || left.singerName.localeCompare(right.singerName, "ja"))
    .map((row) => ({
      externalSingerId: row.externalSingerId,
      singerName: row.singerName,
      singerSongsUrl: row.singerSongsUrl,
      sourceStreamVideoCount: row.sourceStreamVideoCount,
      importedVideoCountBySingerName: row.importedVideoCountBySingerName,
      videoGap: row.videoGap,
      importStatus: row.importStatus,
    }));

  const payload = {
    schemaVersion: 1,
    kind: "vsinger-moment-current-singer-catalog",
    generatedAt,
    source: {
      singersFile: relativePath(singersFile),
      singersSha256: sha256(JSON.stringify(singers)),
      backfillManifest: relativePath(path.join(backfillDir, "manifest.json")),
      backfillGeneratedAt: manifest.generatedAt || "",
      comparisonKey: "singerName exact match against committed external_videos.singerName",
    },
    counts: {
      sourceSingerCount: rows.length,
      sourceTotalSingingCount: rows.reduce((sum, row) => sum + row.sourceTotalSingingCount, 0),
      sourceStreamVideoCount: rows.reduce((sum, row) => sum + row.sourceStreamVideoCount, 0),
      sourceRepertoireSongCount: rows.reduce((sum, row) => sum + row.sourceRepertoireSongCount, 0),
      importedSingerNameCount: importedByName.size,
      missingByNameCount: rows.filter((row) => row.importStatus === "missing-by-name").length,
      sourceAheadCount: rows.filter((row) => row.importStatus === "source-ahead-by-name").length,
      targetCount: targets.length,
      targetVideoGap: targets.reduce((sum, row) => sum + row.videoGap, 0),
    },
    rows,
    targets,
    notes: [
      "This catalog is a small committed snapshot of the public /singers listing for future diff checks.",
      "The comparison is conservative: the committed backfill bundle currently keeps singerName in external videos but not the source singerId, so renamed singers can appear as gaps until refreshed by singerId.",
      "Song-search totals are global song totals, not per-singer occurrence totals; use singerId-scoped backfill for exact singer additions.",
    ],
  };

  writeJson(outputPath, payload);
  writeJson(targetsPath, {
    schemaVersion: 1,
    generatedAt,
    targets,
    singers: targets.map((target) => ({
      externalSingerId: target.externalSingerId,
      singerName: target.singerName,
      singerSongsUrl: target.singerSongsUrl,
    })),
  });
  writeMarkdownReport(reportPath, payload);
  console.log(
    [
      "CODEX_VSINGER_SINGER_CATALOG_AUDIT_OK",
      `singers=${payload.counts.sourceSingerCount}`,
      `importedNames=${payload.counts.importedSingerNameCount}`,
      `missingByName=${payload.counts.missingByNameCount}`,
      `sourceAhead=${payload.counts.sourceAheadCount}`,
      `targets=${payload.counts.targetCount}`,
      `targetVideoGap=${payload.counts.targetVideoGap}`,
    ].join(" "),
  );
  return payload;
}

function readManifestArrayShards(backfillDir, manifest, key) {
  const shards = manifest?.shards?.[key] || [];
  const result = [];
  for (const shard of shards) {
    const filePath = path.join(backfillDir, shard.file || "");
    const value = readJson(filePath, null);
    if (!Array.isArray(value)) throw new Error(`Manifest shard must be an array: ${filePath}`);
    if (sha256(JSON.stringify(value)) !== shard.sha256) throw new Error(`Checksum mismatch for ${key} shard: ${shard.file}`);
    if (Number.isInteger(shard.count) && value.length !== shard.count) throw new Error(`Count mismatch for ${key} shard: ${shard.file}`);
    result.push(...value);
  }
  return result;
}

function countImportedVideosBySingerName(videos) {
  const result = new Map();
  for (const video of videos || []) {
    const name = cleanText(video.singerName || video.singer_name);
    if (!name) continue;
    result.set(name, (result.get(name) || 0) + 1);
  }
  return result;
}

function classifyImportStatus({ sourceVideoCount, importedVideoCount, videoGap, minVideoGap }) {
  if (!sourceVideoCount) return "no-source-videos";
  if (!importedVideoCount) return "missing-by-name";
  if (videoGap >= minVideoGap) return "source-ahead-by-name";
  return "covered-by-name";
}

function positiveIntegerOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function writeMarkdownReport(reportPath, payload) {
  const lines = [
    "# VSinger Moment Singer Catalog Audit",
    "",
    `Generated at: ${payload.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Source singers: ${payload.counts.sourceSingerCount}`,
    `- Source stream videos: ${payload.counts.sourceStreamVideoCount}`,
    `- Imported singer names: ${payload.counts.importedSingerNameCount}`,
    `- Missing by exact singer name: ${payload.counts.missingByNameCount}`,
    `- Source ahead by exact singer name: ${payload.counts.sourceAheadCount}`,
    `- Backfill targets: ${payload.counts.targetCount}`,
    `- Target video gap: ${payload.counts.targetVideoGap}`,
    "",
    "## Top Backfill Targets",
    "",
    "| Singer | Singer ID | Source videos | Imported videos | Gap | Status |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const row of payload.targets.slice(0, 80)) {
    lines.push(
      `| ${escapeMarkdown(row.singerName)} | \`${row.externalSingerId}\` | ${row.sourceStreamVideoCount} | ${row.importedVideoCountBySingerName} | ${row.videoGap} | ${row.importStatus} |`,
    );
  }
  lines.push(
    "",
    "## Notes",
    "",
    ...payload.notes.map((note) => `- ${note}`),
    "",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${lines.join("\n")}`, "utf8");
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function relativePath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/gu, "/");
}

if (require.main === module) {
  try {
    auditSingerCatalog(parseArgs());
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  auditSingerCatalog,
};
