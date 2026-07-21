const path = require("node:path");

const { VsingerHttpClient } = require("./vsinger-http/http-client");
const { channelDiscoveryOptionsFromArgs, parseCliArgs, runChannelDiscovery } = require("./youtube-channel-discovery-core");
const { fetchChannelPageWithYtDlp, inspectVideoSongListWithYtDlp } = require("./youtube-yt-dlp-fallback");

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const options = channelDiscoveryOptionsFromArgs(args);
  process.env.DAILY_SONG_REQUEST_DELAY_MS = String(options.requestIntervalMs);
  process.env.DAILY_SONG_REQUEST_JITTER_MS = String(options.requestJitterMs);
  process.env.DAILY_SONG_VIDEO_CONCURRENCY = "1";

  const { extractSearchItems, fetchVideoSongList } = require("./update-songlist");
  const client = new VsingerHttpClient({
    baseUrl: "https://www.youtube.com",
    serviceName: "YouTube",
    cacheDir: options.cacheDir,
    userAgent: process.env.YOUTUBE_DISCOVERY_USER_AGENT || BROWSER_USER_AGENT,
    requestIntervalMs: options.requestIntervalMs,
    requestTimeoutMs: Number(process.env.YOUTUBE_DISCOVERY_REQUEST_TIMEOUT_MS || 30000),
    connectTimeoutMs: Number(process.env.YOUTUBE_DISCOVERY_CONNECT_TIMEOUT_MS || 15000),
  });
  const startedAt = Date.now();
  const result = await runChannelDiscovery(options, {
    client,
    extractSearchItems,
    inspectVideoSongList: fetchVideoSongList,
    fetchChannelPageFallback: fetchChannelPageWithYtDlp,
    inspectVideoSongListFallback: inspectVideoSongListWithYtDlp,
    fetchImpl: fetch,
    userAgent: client.userAgent,
  });
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    [
      "CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK",
      `channel=${quoteForMarker(result.manifest.channelUrl)}`,
      `candidates=${result.manifest.candidateCount}`,
      `inspected=${result.manifest.inspectedInLatestRun}`,
      `videos=${result.manifest.usableVideoCount}`,
      `occurrences=${result.manifest.occurrenceCount}`,
      `elapsedSeconds=${elapsedSeconds}`,
      `outputDir=${quoteForMarker(path.resolve(options.outputDir))}`,
    ].join(" "),
  );
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
