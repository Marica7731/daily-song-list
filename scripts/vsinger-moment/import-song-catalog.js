const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_ENDPOINT, createMcpClient } = require("./mcp-client");
const { ImportState, defaultCacheRoot, ensureDir, writeJsonFileAtomic } = require("./cache");
const {
  SOURCE_SYSTEM,
  assertNoRankingFactFields,
  buildProvenanceEnvelope,
  normalizeExternalSong,
  validateExternalSong,
} = require("./provenance");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await importSongCatalog(options);
  process.stdout.write(`${JSON.stringify(summarizeImportResult(result), null, 2)}\n`);
  process.stdout.write(
    `CODEX_VSINGER_IMPORT_OK dryRun=${options.dryRun ? "true" : "false"} fetched=${result.fetched.length} skipped=${result.skipped.length} failures=${result.failures.length}\n`,
  );
}

async function importSongCatalog(options) {
  const state = new ImportState({
    rootDir: options.cacheDir,
  });
  const client = createMcpClient({
    endpoint: options.endpoint,
    cacheDir: options.cacheDir,
    cache: options.dryRun ? false : undefined,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.nowMs,
    random: options.random,
    requestsPerMinute: options.requestsPerMinute,
    maxRequests: options.maxRequests,
    maxRetries: options.maxRetries,
  });
  await client.initialize();

  const planned = planRequests(options);
  const fetched = [];
  const skipped = [];
  const failures = [];
  for (const request of planned) {
    if (request.externalSongId && state.hasFetched(request.externalSongId)) {
      skipped.push({
        reason: "already-fetched",
        externalSongId: request.externalSongId,
      });
      continue;
    }
    try {
      const toolResult = await callPlannedRequest(client, request);
      const records = extractSongRecords(toolResult, request);
      for (const raw of records) {
        const normalized = normalizeExternalSong(raw, {
          fetchedAt: options.now || new Date().toISOString(),
        });
        const errors = validateExternalSong(normalized);
        if (errors.length) {
          failures.push({
            request,
            errors,
          });
          continue;
        }
        if (!options.dryRun && state.hasFetched(normalized.externalSongId)) {
          skipped.push({
            reason: "already-fetched",
            externalSongId: normalized.externalSongId,
          });
          continue;
        }
        assertNoRankingFactFields({
          title: normalized.title,
          artist: normalized.artist,
          titleAliases: normalized.titleAliases,
          artistAliases: normalized.artistAliases,
          latestPerformanceAt: normalized.latestPerformanceAt,
          sourcePageUrl: normalized.sourcePageUrl,
        });
        fetched.push({
          song: normalized,
          provenance: buildProvenanceEnvelope({
            toolName: request.toolName,
            arguments: request.args,
            result: raw,
            fetchedAt: normalized.fetchedAt,
          }),
        });
        if (!options.dryRun) {
          state.markFetched(normalized.externalSongId, normalized.fetchedAt);
        }
      }
    } catch (error) {
      failures.push({
        request,
        message: error.message,
      });
      if (!options.dryRun) {
        state.recordFailure(request.externalSongId || request.query || request.toolName, error);
      }
    }
  }

  if (!options.dryRun) {
    state.save();
    if (options.outputPath) {
      writeImportOutput(options.outputPath, fetched);
    }
  }

  return {
    sourceSystem: SOURCE_SYSTEM,
    endpoint: options.endpoint,
    dryRun: options.dryRun,
    requestCount: client.requestCount,
    planned,
    fetched,
    skipped,
    failures,
    state: state.toJSON(),
  };
}

function planRequests(options) {
  const requests = [];
  for (const query of options.queries) {
    requests.push({
      toolName: "search_songs",
      query,
      args: {
        query,
        limit: options.limit,
      },
    });
  }
  for (const externalSongId of options.songIds) {
    requests.push({
      toolName: "get_song",
      externalSongId,
      args: {
        songId: externalSongId,
      },
    });
  }
  if (!requests.length) {
    throw new Error(
      "No bounded import request was provided. Use --query or --song-id. This adapter intentionally does not simulate unbounded full catalog sync.",
    );
  }
  return requests;
}

async function callPlannedRequest(client, request) {
  if (request.toolName === "search_songs") {
    return client.searchSongs(request.args);
  }
  if (request.toolName === "get_song") {
    return client.getSong(request.args);
  }
  throw new Error(`Unsupported planned request: ${request.toolName}`);
}

function extractSongRecords(toolResult, request) {
  const content = Array.isArray(toolResult && toolResult.content) ? toolResult.content : null;
  if (content) {
    const records = [];
    for (const item of content) {
      if (item.type === "json" && item.json) {
        records.push(...extractSongRecords(item.json, request));
      } else if (item.type === "text" && item.text) {
        const parsed = tryParseJson(item.text);
        if (parsed) {
          records.push(...extractSongRecords(parsed, request));
        }
      }
    }
    return records;
  }
  if (Array.isArray(toolResult)) {
    return toolResult.flatMap((item) => extractSongRecords(item, request));
  }
  if (Array.isArray(toolResult && toolResult.songs)) {
    return toolResult.songs;
  }
  if (Array.isArray(toolResult && toolResult.results)) {
    return toolResult.results;
  }
  if (toolResult && typeof toolResult === "object") {
    return [toolResult];
  }
  throw new Error(`Could not extract song records from ${request.toolName} response`);
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function writeImportOutput(outputPath, fetched) {
  const output = {
    schemaVersion: "vsinger-moment.import-output.v1",
    generatedAt: new Date().toISOString(),
    songs: fetched.map((item) => item.song),
    provenance: fetched.map((item) => item.provenance),
  };
  ensureDir(path.dirname(outputPath));
  writeJsonFileAtomic(outputPath, output);
}

function summarizeImportResult(result) {
  return {
    sourceSystem: result.sourceSystem,
    endpoint: result.endpoint,
    dryRun: result.dryRun,
    requestCount: result.requestCount,
    plannedCount: result.planned.length,
    fetchedCount: result.fetched.length,
    skippedCount: result.skipped.length,
    failureCount: result.failures.length,
    externalSongIds: result.fetched.map((item) => item.song.externalSongId),
  };
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    endpoint: process.env.VSINGER_MOMENT_MCP_ENDPOINT || DEFAULT_ENDPOINT,
    cacheDir: process.env.VSINGER_MOMENT_CACHE_DIR || defaultCacheRoot(),
    requestsPerMinute: Number(process.env.VSINGER_MOMENT_REQUESTS_PER_MINUTE || 36),
    maxRequests: Number(process.env.VSINGER_MOMENT_MAX_REQUESTS || 20),
    maxRetries: Number(process.env.VSINGER_MOMENT_MAX_RETRIES || 4),
    limit: 10,
    queries: [],
    songIds: [],
    outputPath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--endpoint") {
      options.endpoint = readValue(args, ++index, arg);
    } else if (arg === "--cache-dir") {
      options.cacheDir = readValue(args, ++index, arg);
    } else if (arg === "--requests-per-minute") {
      options.requestsPerMinute = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--max-requests") {
      options.maxRequests = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--max-retries") {
      options.maxRetries = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--limit") {
      options.limit = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--query") {
      options.queries.push(readValue(args, ++index, arg));
    } else if (arg === "--song-id") {
      options.songIds.push(readValue(args, ++index, arg));
    } else if (arg === "--output") {
      options.outputPath = readValue(args, ++index, arg);
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readValue(args, index, name) {
  if (index >= args.length || args[index].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index];
}

function readPositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} requires a non-negative number`);
  }
  return number;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/vsinger-moment/import-song-catalog.js --query <text> [--dry-run]\n`);
  process.stdout.write(`Runs bounded, resumable VSinger Moment MCP imports. Full catalog crawling is intentionally unsupported.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  extractSongRecords,
  importSongCatalog,
  parseArgs,
  planRequests,
  summarizeImportResult,
};
