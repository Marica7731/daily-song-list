const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_ENDPOINT, createMcpClient } = require("./mcp-client");
const { defaultCacheRoot, ensureDir, writeJsonFileAtomic } = require("./cache");

const DEFAULT_OUTPUT_PATH = path.join("data", "external", "vsinger-moment", "mcp-schema.json");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const client = createMcpClient({
    endpoint: options.endpoint,
    cacheDir: options.cacheDir,
    cache: options.dryRun ? false : undefined,
    requestsPerMinute: options.requestsPerMinute,
    maxRequests: options.maxRequests,
    maxRetries: options.maxRetries,
  });
  const initializeResult = await client.initialize();
  const toolListResult = await client.listTools();
  const schema = buildSchemaReport({
    endpoint: options.endpoint,
    initializeResult,
    toolListResult,
    fetchedAt: startedAt,
    requestCount: client.requestCount,
  });

  if (!options.dryRun) {
    ensureDir(path.dirname(options.outputPath));
    writeJsonFileAtomic(options.outputPath, schema);
  }

  const summary = summarizeSchema(schema);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `CODEX_VSINGER_DISCOVER_SCHEMA_OK dryRun=${options.dryRun ? "true" : "false"} toolCount=${schema.tools.length} requestCount=${client.requestCount}\n`,
  );
}

function buildSchemaReport({ endpoint, initializeResult, toolListResult, fetchedAt, requestCount }) {
  const tools = Array.isArray(toolListResult && toolListResult.tools) ? toolListResult.tools : [];
  return {
    schemaVersion: "vsinger-moment.mcp-schema-report.v1",
    endpoint,
    fetchedAt,
    requestCount,
    protocolVersion: initializeResult && initializeResult.protocolVersion ? initializeResult.protocolVersion : null,
    serverInfo: initializeResult && initializeResult.serverInfo ? initializeResult.serverInfo : null,
    capabilities: initializeResult && initializeResult.capabilities ? initializeResult.capabilities : null,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || null,
      outputSchema: tool.outputSchema || null,
      annotations: tool.annotations || null,
    })),
  };
}

function summarizeSchema(schema) {
  return {
    endpoint: schema.endpoint,
    fetchedAt: schema.fetchedAt,
    protocolVersion: schema.protocolVersion,
    serverInfo: schema.serverInfo,
    toolNames: schema.tools.map((tool) => tool.name),
    requiredToolsPresent: requiredTools().filter((toolName) => schema.tools.some((tool) => tool.name === toolName)),
    searchFetchPresent: schema.tools.filter((tool) => tool.name === "search" || tool.name === "fetch").map((tool) => tool.name),
  };
}

function requiredTools() {
  return ["search_songs", "get_song", "search_singers", "get_singer", "get_video_setlist"];
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    endpoint: process.env.VSINGER_MOMENT_MCP_ENDPOINT || DEFAULT_ENDPOINT,
    outputPath: DEFAULT_OUTPUT_PATH,
    cacheDir: process.env.VSINGER_MOMENT_CACHE_DIR || defaultCacheRoot(),
    requestsPerMinute: Number(process.env.VSINGER_MOMENT_REQUESTS_PER_MINUTE || 36),
    maxRequests: Number(process.env.VSINGER_MOMENT_MAX_REQUESTS || 12),
    maxRetries: Number(process.env.VSINGER_MOMENT_MAX_RETRIES || 3),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--endpoint") {
      options.endpoint = readValue(args, ++index, arg);
    } else if (arg === "--output") {
      options.outputPath = readValue(args, ++index, arg);
    } else if (arg === "--cache-dir") {
      options.cacheDir = readValue(args, ++index, arg);
    } else if (arg === "--requests-per-minute") {
      options.requestsPerMinute = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--max-requests") {
      options.maxRequests = readPositiveNumber(readValue(args, ++index, arg), arg);
    } else if (arg === "--max-retries") {
      options.maxRetries = readPositiveNumber(readValue(args, ++index, arg), arg);
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
  process.stdout.write(`Usage: node scripts/vsinger-moment/discover-schema.js [--dry-run]\n`);
  process.stdout.write(`Discovers the official VSinger Moment MCP handshake and tool schemas.\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSchemaReport,
  parseArgs,
  requiredTools,
  summarizeSchema,
};
