const fs = require("node:fs");
const path = require("node:path");

const { loadCurationContext } = require("./curation");
const { loadVideoCatalog } = require("./video-catalog");
const {
  filterNonRegressiveImports,
  inputDirsFromArgs,
  projectRelativePath,
  readDiscoveryVideos,
  SOURCE_GROUP,
} = require("./import-channel-discovery");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = inputDirsFromArgs(args);
  const outputPath = path.resolve(ROOT, String(args.output || path.join("data", "external", "youtube-channel-discovery", "accepted", "manual-import.json")));
  const generatedAt = new Date().toISOString();
  const curation = loadCurationContext();
  const catalog = loadVideoCatalog();
  const { videos, stats: readStats } = readDiscoveryVideos(inputs);
  if (!videos.length && !args["allow-empty"]) {
    throw new Error(`no usable channel discovery video details found in ${inputs.join(", ")}`);
  }
  const safeImport = filterNonRegressiveImports(catalog, videos);
  const acceptedVideos = safeImport.videos.map((video) => ({
    ...video,
    curationVersion: curation.version,
    curationHash: curation.hash,
  }));
  const payload = {
    schemaVersion: 1,
    sourceSystem: SOURCE_GROUP,
    kind: "youtube-channel-discovery-increment",
    generatedAt,
    inputs: inputs.map((input) => projectRelativePath(input)),
    readStats: { ...readStats, ...safeImport.stats },
    videoCount: acceptedVideos.length,
    occurrenceCount: acceptedVideos.reduce((total, video) => total + (Array.isArray(video.songs) ? video.songs.length : 0), 0),
    videos: acceptedVideos,
  };
  writeJson(outputPath, payload);
  console.log(
    [
      "CODEX_CHANNEL_DISCOVERY_INCREMENT_OK",
      `inputs=${inputs.length}`,
      `readVideos=${readStats.videoDetails}`,
      `usableVideos=${videos.length}`,
      `acceptedVideos=${acceptedVideos.length}`,
      `skippedRegressions=${safeImport.stats.skippedExistingRegressions}`,
      `occurrences=${payload.occurrenceCount}`,
      `output=${quoteForMarker(outputPath)}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function quoteForMarker(value) {
  return JSON.stringify(String(value || ""));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
};
