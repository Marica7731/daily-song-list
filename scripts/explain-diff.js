const fs = require("node:fs");
const path = require("node:path");
const { buildRankDiffs } = require("./update-songlist");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "artifacts", "diff-explanations");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = args.range || "all";
  const latest = readJson(path.join(DATA_DIR, "latest.json"));
  const compactDiff = readJson(path.join(DATA_DIR, "diff", `latest-${range}.json`)) || {};
  const previousPath = args.from ? snapshotPath(args.from) : compactDiff.previous?.path || "";
  const previousPayload = previousPath ? readJson(path.join(ROOT, previousPath)) : null;
  const diff = buildRankDiffs(latest, previousPayload ? { entry: { id: previousPayload.snapshotId || path.basename(previousPath, ".json"), path: previousPath }, payload: previousPayload } : null)[range];
  if (!diff) throw new Error(`Unknown range: ${range}`);
  const explanation = explainRangeDiff({ range, diff, latest, previousPayload, args });
  const targetDir = path.join(OUT_DIR, range);
  fs.mkdirSync(targetDir, { recursive: true });
  writeJson(path.join(targetDir, "latest.json"), explanation);
  fs.writeFileSync(path.join(targetDir, "latest.md"), markdown(explanation), "utf8");
  console.log(`EXPLAIN_DIFF_OK range=${range} current=${explanation.current.snapshotId || "latest"} previous=${explanation.previous?.snapshotId || "none"} songs=${explanation.songRank.length}`);
}

function explainRangeDiff({ range, diff, latest, previousPayload, args }) {
  const currentItems = rangeItems(latest, range);
  const previousItems = rangeItems(previousPayload, range);
  const currentOccurrences = occurrenceMap(currentItems);
  const previousOccurrences = occurrenceMap(previousItems);
  const removedOccurrences = [...previousOccurrences.keys()].filter((key) => !currentOccurrences.has(key));
  const addedOccurrences = [...currentOccurrences.keys()].filter((key) => !previousOccurrences.has(key));
  const shrinkVideos = sameVideoShrink(currentItems, previousItems);
  const songFilter = args.song || "";
  const videoFilter = args.video || "";
  const songRank = (diff.songRank || [])
    .filter((entry) => !songFilter || entry.entityKey === songFilter || entry.label === songFilter)
    .slice(0, songFilter ? 1000 : 200);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    range,
    current: diff.current,
    previous: diff.previous,
    filters: { song: songFilter, video: videoFilter },
    songRank,
    summary: {
      currentVideoCount: currentItems.length,
      previousVideoCount: previousItems.length,
      currentOccurrenceCount: currentOccurrences.size,
      previousOccurrenceCount: previousOccurrences.size,
      addedOccurrenceCount: addedOccurrences.length,
      removedOccurrenceCount: removedOccurrences.length,
      sameVideoShrinkCount: shrinkVideos.length,
      reasonCodes: reasonCodes({ latest, addedOccurrences, removedOccurrences, shrinkVideos }),
    },
    addedOccurrences: addedOccurrences.slice(0, 200).map((key) => currentOccurrences.get(key)),
    removedOccurrences: removedOccurrences.slice(0, 200).map((key) => previousOccurrences.get(key)),
    sameVideoShrink: shrinkVideos.slice(0, 100),
  };
}

function sameVideoShrink(currentItems, previousItems) {
  const currentById = new Map((currentItems || []).map((item) => [item.videoId, item]));
  const result = [];
  for (const previous of previousItems || []) {
    const current = currentById.get(previous.videoId);
    if (!current) continue;
    const previousCount = (previous.songs || []).length;
    const currentCount = (current.songs || []).length;
    if (currentCount < previousCount) {
      result.push({
        videoId: previous.videoId,
        title: current.title || previous.title || "",
        previousCount,
        currentCount,
        countDelta: currentCount - previousCount,
        reasonCode: current.regressionAudit?.reason || current.removalReason || "unexplained_same_video_shrink",
      });
    }
  }
  return result;
}

function occurrenceMap(items) {
  const map = new Map();
  for (const item of items || []) {
    for (const song of item.songs || []) {
      const entry = {
        videoId: item.videoId,
        title: song.title || "",
        artist: song.artist || "",
        seconds: Number.isInteger(song.seconds) ? song.seconds : 0,
        sourceId: song.sourceId || item.selectedSourceId || "",
        sourceHash: song.sourceHash || item.selectedSourceHash || "",
        rawHash: song.rawHash || "",
      };
      map.set([entry.videoId, entry.sourceId || entry.sourceHash, entry.seconds, entry.rawHash, entry.title, entry.artist].join("::"), entry);
    }
  }
  return map;
}

function reasonCodes({ latest, removedOccurrences, shrinkVideos }) {
  const codes = {};
  if (!removedOccurrences.length && !shrinkVideos.length) codes.no_unexplained_decrease = 1;
  for (const item of shrinkVideos) codes[item.reasonCode] = (codes[item.reasonCode] || 0) + 1;
  if (latest?.curationHash) codes[`curation:${latest.curationHash}`] = 1;
  if (latest?.blocklistHash) codes[`blocklist:${latest.blocklistHash}`] = 1;
  return codes;
}

function rangeItems(payload, range) {
  return payload?.groups?.[range]?.items || payload?.groups?.["1m"]?.items || [];
}

function snapshotPath(value) {
  if (!value) return "";
  if (value.startsWith("data/")) return value;
  return `data/snapshots/${value.replace(/\.json$/u, "")}.json`;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      result[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
    }
  }
  return result;
}

function markdown(explanation) {
  return [
    `# Diff Explanation: ${explanation.range}`,
    "",
    `- generatedAt: ${explanation.generatedAt}`,
    `- currentOccurrenceCount: ${explanation.summary.currentOccurrenceCount}`,
    `- previousOccurrenceCount: ${explanation.summary.previousOccurrenceCount}`,
    `- addedOccurrenceCount: ${explanation.summary.addedOccurrenceCount}`,
    `- removedOccurrenceCount: ${explanation.summary.removedOccurrenceCount}`,
    `- sameVideoShrinkCount: ${explanation.summary.sameVideoShrinkCount}`,
    `- reasonCodes: ${JSON.stringify(explanation.summary.reasonCodes)}`,
    "",
  ].join("\n");
}

function readJson(filePath) {
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

main();
