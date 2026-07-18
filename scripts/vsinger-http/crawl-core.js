const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./html-utils");
const { VsingerHttpClient } = require("./http-client");
const { crawlDelaySeconds, isAllowed, parseRobotsTxt } = require("./robots");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function createClient(args = {}) {
  return new VsingerHttpClient({
    cacheDir: args["cache-dir"] || path.resolve(process.cwd(), ".local-cache", "vsinger-http"),
    requestIntervalMs: args["request-interval-ms"] ? Number(args["request-interval-ms"]) : undefined,
  });
}

async function loadRobots(client) {
  const response = await client.getText("/robots.txt");
  const policy = parseRobotsTxt(response.body);
  const crawlDelay = crawlDelaySeconds(policy, client.userAgent);
  if (crawlDelay != null) client.setMinimumIntervalMs(crawlDelay * 1000);
  return {
    response,
    policy,
    crawlDelay,
    songsAllowed: isAllowed(policy, "/songs", client.userAgent) && isAllowed(policy, "/songs?cursor=test", client.userAgent),
    streamsAllowed: isAllowed(policy, "/streams", client.userAgent) && isAllowed(policy, "/streams?cursor=test", client.userAgent),
    singersAllowed: isAllowed(policy, "/singers", client.userAgent) && isAllowed(policy, "/singers?cursor=test", client.userAgent) && isAllowed(policy, "/singers/test", client.userAgent),
    singerSongsQueryAllowed: isAllowed(policy, "/songs?singerId=test", client.userAgent),
    singerStreamsQueryAllowed: isAllowed(policy, "/streams?singerId=test", client.userAgent),
    videosAllowed: isAllowed(policy, "/videos/test", client.userAgent),
    apiAllowed: isAllowed(policy, "/api/test", client.userAgent),
  };
}

function ensureRobotsAllowed(robots, route) {
  const key = route === "songs" ? "songsAllowed" : route === "streams" ? "streamsAllowed" : route === "singers" ? "singersAllowed" : "videosAllowed";
  if (!robots[key]) {
    const error = new Error(`robots.txt does not allow /${route}; production crawl stopped.`);
    error.code = "ROBOTS_DISALLOW";
    throw error;
  }
}

function loadCheckpoint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveCheckpoint(filePath, checkpoint) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

function classifyCoverage({ stopReason, observedSiteSongCount, uniqueCount, cursorLoopDetected, noProgressDetected, parseErrors = 0 }) {
  if (parseErrors > 0) return "parse-error";
  if (cursorLoopDetected) return "cursor-loop";
  if (noProgressDetected) return "no-progress";
  if (stopReason !== "no-next-cursor") return "partial";
  if (observedSiteSongCount && uniqueCount && Math.abs(observedSiteSongCount - uniqueCount) > Math.max(3, observedSiteSongCount * 0.01)) {
    return "count-mismatch";
  }
  return stopReason === "no-next-cursor" ? "complete" : "partial";
}

function cursorKey(url) {
  const parsed = new URL(url, "https://vsinger-moment.jp");
  return parsed.searchParams.get("cursor") || "__first_page__";
}

function requestStatsFromPages(pages) {
  const responseTimes = pages.map((page) => page.elapsedMs).filter((value) => Number.isFinite(value));
  const bytes = pages.map((page) => page.bytes).filter((value) => Number.isFinite(value));
  return {
    requestCount: pages.length,
    averageHtmlBytes: average(bytes),
    averageResponseTimeMs: average(responseTimes),
    totalBytes: bytes.reduce((sum, value) => sum + value, 0),
  };
}

function average(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function writeRunOutput(outputDir, name, payload) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${name}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function stopRecord(reason, extra = {}) {
  return {
    reason,
    stoppedAt: new Date().toISOString(),
    ...extra,
  };
}

module.exports = {
  classifyCoverage,
  createClient,
  cursorKey,
  ensureRobotsAllowed,
  loadCheckpoint,
  loadRobots,
  parseArgs,
  requestStatsFromPages,
  saveCheckpoint,
  sha256,
  stopRecord,
  writeRunOutput,
};
