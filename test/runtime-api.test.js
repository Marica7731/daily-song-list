const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.PYTHON || "python";

test("runtime API serves health and ranking rows from SQLite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "song-rank-api-"));
  const latestPath = path.join(dir, "latest.json");
  const dbPath = path.join(dir, "song-rank.sqlite");
  writeLatestFixture(latestPath);
  execFileSync(
    PYTHON,
    [
      path.join(ROOT, "scripts", "db", "build-runtime-db.py"),
      "--input",
      latestPath,
      "--output",
      dbPath,
      "--no-vsinger",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  const port = await getFreePort();
  const child = spawn(
    PYTHON,
    [
      path.join(ROOT, "server", "song_rank_api.py"),
      "--db",
      dbPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForReady(child);
    const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, "ok");
    assert.equal(health.counts.videos, 2);

    const meta = await fetchJson(`http://127.0.0.1:${port}/api/meta`);
    assert.equal(meta.meta.source_latest_sha256, sha256File(latestPath));
    assert.equal(meta.meta.latest_generated_at, "2026-07-19T00:00:00.000Z");

    const rankings = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&pageSize=5`);
    assert.equal(rankings.totalCount, 2);
    assert.equal(rankings.totalOccurrenceCount, 3);
    assert.equal(rankings.records[0].title, "Song One");
    assert.equal(rankings.records[0].count, 2);

    const videoMetricRankings = await fetchJson(`http://127.0.0.1:${port}/api/rankings?range=all&view=songs&metric=videos&pageSize=5`);
    assert.equal(videoMetricRankings.metric, "videos");
    assert.equal(videoMetricRankings.totalCount, 2);
    assert.equal(videoMetricRankings.records[0].title, "Song One");

    const sourceKey = rankings.records[0].sourceDetailKey;
    const source = await fetchJson(`http://127.0.0.1:${port}/api/sources/${encodeURIComponent(sourceKey)}`);
    assert.equal(source.found, true);
    assert.equal(source.record.title, "Song One");
    assert.equal(source.record.occurrences.length, 2);
  } finally {
    child.kill();
    await waitForExit(child);
    assert.equal(stderr.includes("Traceback"), false, stderr);
  }
});

function writeLatestFixture(latestPath) {
  fs.writeFileSync(
    latestPath,
    JSON.stringify({
      generatedAt: "2026-07-19T00:00:00.000Z",
      capturedAt: "2026-07-19T00:00:00.000Z",
      groups: {
        "7d": {
          items: [
            {
              videoId: "video-a",
              title: "Morning Karaoke",
              channelName: "Alpha Ch.",
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
              ],
            },
          ],
        },
        all: {
          items: [
            {
              videoId: "video-a",
              title: "Morning Karaoke",
              channelName: "Alpha Ch.",
              publishedTimestamp: 1784419200000,
              publishedText: "2026-07-19",
              songs: [
                { title: "Song One", artist: "Singer A", seconds: 10, time: "0:10", isNiche: true },
                { title: "Song Two", artist: "Singer B", seconds: 20, time: "0:20" },
              ],
            },
            {
              videoId: "video-b",
              title: "Night Karaoke",
              channelName: "Beta Ch.",
              publishedTimestamp: 1784422800000,
              publishedText: "2026-07-19",
              songs: [{ title: "Song One", artist: "Singer A", seconds: 30, time: "0:30" }],
            },
          ],
        },
      },
    }),
    "utf8",
  );
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(child) {
  let stdout = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`API did not become ready. stdout=${stdout}`));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("CODEX_RUNTIME_API_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`API exited before ready with code ${code}. stdout=${stdout}`));
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return await response.json();
}
