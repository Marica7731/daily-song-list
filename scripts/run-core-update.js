const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  catalogToVideos,
  loadVideoCatalog,
  mergeVideosIntoCatalog,
  writeVideoCatalog,
} = require("./video-catalog");

const ROOT = path.resolve(__dirname, "..");
const COMPENSATION_CRON = "37 * * * *";
const FRESH_THRESHOLD_MINUTES = 75;
const BACKFILL_INBOX_DIR = path.join(ROOT, "data", "backfill-inbox");
const CORE_RESTORE_PATHS = [
  "data/latest.json",
  "data/7d.json",
  "data/all.json",
  "data/72h.json",
  "data/1m.json",
  "data/audit.json",
  "data/inspection-cache.json",
  "data/video-catalog.json",
  "data/song-search-known-songs.json",
  "data/snapshots",
  "data/diff",
  "data/ui",
  "data/catalog-segments",
];

if (require.main === module) {
  const command = process.argv[2] || "run";
  if (command === "restore-after-failure") {
    const result = restoreAfterCoreFailure();
    process.exit(result.status || 0);
  }
  runCoreUpdate();
}

function runCoreUpdate(options = {}) {
  const env = options.env || process.env;
  const root = options.root || ROOT;
  const outputs = options.outputs || setOutput;
  const logger = options.logger || console;
  const exit = options.exit || ((code) => process.exit(code));
  const nowMs = options.nowMs || Date.now();
  const runMode = env.DAILY_SONG_UPDATE_MODE || "fast";
  const preflight = evaluateCorePreflight({
    eventName: env.GITHUB_EVENT_NAME || "",
    eventSchedule: env.DAILY_SONG_EVENT_SCHEDULE || "",
    dispatchReason: env.DAILY_SONG_DISPATCH_REASON || "",
    capturedAt: latestCapturedAt(root),
    nowMs,
  });

  if (preflight.checked) {
    outputs("age_minutes", formatAgeMinutes(preflight.ageMinutes));
    outputs("reason", preflight.reason);
    if (preflight.skip) {
      logger.log(
        `[core-preflight] skip ${preflight.kind}: capturedAt=${preflight.capturedAt} ageMinutes=${formatAgeMinutes(preflight.ageMinutes)}`,
      );
      outputs("skipped", "true");
      outputs("updated", "false");
      outputs("mode", runMode);
      return exit(0);
    }
    logger.log(
      `[core-preflight] run ${preflight.kind}: capturedAt=${preflight.capturedAt || "missing"} ageMinutes=${formatAgeMinutes(
        preflight.ageMinutes,
      )}`,
    );
  }

  const backfill = consumeBackfillInbox({ root, logger });
  outputs("backfill_bundles", String(backfill.bundleCount));
  outputs("backfill_videos", String(backfill.uniqueVideoCount));
  outputs("skipped", "false");
  outputs("mode", runMode);

  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = (options.spawnSync || spawnSync)(command, ["run", "update:core"], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    logger.error(`[core-update] failed to start npm run update:core: ${result.error.message}`);
    return exit(1);
  }
  if (result.signal) {
    logger.error(`[core-update] npm run update:core stopped by signal ${result.signal}`);
    return exit(1);
  }
  if ((result.status || 0) === 0) outputs("updated", "true");
  return exit(result.status || 0);
}

function evaluateCorePreflight({ eventName, eventSchedule, dispatchReason, capturedAt, nowMs = Date.now(), thresholdMinutes = FRESH_THRESHOLD_MINUTES }) {
  const isCompensationSchedule = eventName === "schedule" && eventSchedule === COMPENSATION_CRON;
  const isWatchdogDispatch = dispatchReason === "watchdog";
  const kind = isCompensationSchedule ? "compensation_schedule" : isWatchdogDispatch ? "watchdog_dispatch" : "";
  if (!kind) {
    return { checked: false, skip: false, reason: "regular_fast", kind: "regular_fast", capturedAt: capturedAt || "", ageMinutes: null };
  }
  const ageMinutes = capturedAt ? (nowMs - Date.parse(capturedAt)) / 60000 : Number.POSITIVE_INFINITY;
  const fresh = Number.isFinite(ageMinutes) && ageMinutes >= 0 && ageMinutes < thresholdMinutes;
  return {
    checked: true,
    skip: fresh,
    reason: fresh ? "fresh_data" : "stale_data",
    kind,
    capturedAt: capturedAt || "",
    ageMinutes,
  };
}

function latestCapturedAt(root = ROOT) {
  const meta = readJson(path.join(root, "data", "ui", "meta.json"));
  if (meta?.capturedAt) return meta.capturedAt;
  if (meta?.dataCapturedAt) return meta.dataCapturedAt;
  const latest = readJson(path.join(root, "data", "latest.json"));
  return latest?.capturedAt || latest?.generatedAt || "";
}

function consumeBackfillInbox(options = {}) {
  const root = options.root || ROOT;
  const inboxDir = options.inboxDir || path.join(root, "data", "backfill-inbox");
  const catalogPath = path.join(root, "data", "video-catalog.json");
  const logger = options.logger || console;
  const bundles = readBackfillBundles(inboxDir);
  const videos = dedupeBackfillVideos(bundles.flatMap((bundle) => backfillVideosFromBundle(bundle.payload)));
  const catalog = loadVideoCatalog(catalogPath);
  const beforeCount = catalogToVideos(catalog).length;
  if (!videos.length) {
    if (bundles.length) logger.log(`[backfill-consume] bundles=${bundles.length} videos=0`);
    return { bundleCount: bundles.length, videoCount: 0, uniqueVideoCount: 0, beforeCount, afterCount: beforeCount };
  }

  const merged = mergeVideosIntoCatalog(catalog, videos, new Date().toISOString(), {
    qualityStatus: "usable",
  });
  const afterCount = catalogToVideos(merged.catalog).length;
  writeVideoCatalog(merged.catalog, catalogPath, { baseDir: "data/catalog-segments" });
  logger.log(`[backfill-consume] bundles=${bundles.length} videos=${videos.length} catalog=${beforeCount}->${afterCount}`);
  return {
    bundleCount: bundles.length,
    videoCount: bundles.reduce((sum, bundle) => sum + backfillVideosFromBundle(bundle.payload).length, 0),
    uniqueVideoCount: videos.length,
    beforeCount,
    afterCount,
  };
}

function readBackfillBundles(inboxDir = BACKFILL_INBOX_DIR) {
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(inboxDir, name);
      return { filePath, payload: readJson(filePath) };
    })
    .filter((bundle) => bundle.payload?.kind === "daily-song-list-backfill-inbox");
}

function backfillVideosFromBundle(bundle) {
  const candidates = [...arrayValue(bundle?.catalogVideos), ...arrayValue(bundle?.videos), ...arrayValue(bundle?.items)];
  return candidates.map(normalizeBackfillVideo).filter(Boolean);
}

function normalizeBackfillVideo(video) {
  const videoId = String(video?.videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) return null;
  const songs = arrayValue(video.songs).filter((song) => song && Number.isFinite(Number(song.seconds)) && song.title);
  if (!songs.length) return null;
  return {
    videoId,
    title: stringValue(video.title),
    channelName: stringValue(video.channelName),
    channelId: stringValue(video.channelId),
    channelHandle: stringValue(video.channelHandle),
    publishedTimestamp: finiteTimestamp(video.publishedTimestamp),
    sourceGroups: uniqueValues(["backfill", ...arrayValue(video.sourceGroups), video.sourceGroup]),
    sourceUrls: uniqueValues(arrayValue(video.sourceUrls)),
    selectedSourceId: stringValue(video.selectedSourceId || video.sourceId),
    selectedSourceHash: stringValue(video.selectedSourceHash || video.sourceHash),
    lastInspectedAt: stringValue(video.lastInspectedAt || video.catalogLastInspectedAt),
    songs,
  };
}

function dedupeBackfillVideos(videos) {
  const byVideoId = new Map();
  for (const video of videos) {
    const existing = byVideoId.get(video.videoId);
    if (!existing || (video.songs?.length || 0) > (existing.songs?.length || 0)) byVideoId.set(video.videoId, video);
  }
  return [...byVideoId.values()];
}

function restoreAfterCoreFailure(options = {}) {
  const result = (options.spawnSync || spawnSync)("git", ["restore", "--worktree", "--", ...CORE_RESTORE_PATHS], {
    cwd: options.root || ROOT,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
  });
  if (result.error && options.logger) options.logger.error(result.error.message);
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT || "";
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${String(value)}\n`, "utf8");
}

function formatAgeMinutes(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "unknown";
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function uniqueValues(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

module.exports = {
  BACKFILL_INBOX_DIR,
  COMPENSATION_CRON,
  CORE_RESTORE_PATHS,
  FRESH_THRESHOLD_MINUTES,
  backfillVideosFromBundle,
  consumeBackfillInbox,
  dedupeBackfillVideos,
  evaluateCorePreflight,
  latestCapturedAt,
  normalizeBackfillVideo,
  readBackfillBundles,
  restoreAfterCoreFailure,
  runCoreUpdate,
};
