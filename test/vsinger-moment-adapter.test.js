const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  McpHttpClient,
  RateLimiter,
  createMcpClient,
  parseRetryAfter,
} = require("../scripts/vsinger-moment/mcp-client");
const {
  ImportState,
  RequestCache,
  makeTempCacheRoot,
  readJsonFile,
} = require("../scripts/vsinger-moment/cache");
const {
  buildSchemaReport,
  requiredTools,
  summarizeSchema,
} = require("../scripts/vsinger-moment/discover-schema");
const {
  extractSongRecords,
  importSongCatalog,
  parseArgs: parseImportArgs,
  planRequests,
} = require("../scripts/vsinger-moment/import-song-catalog");
const {
  SOURCE_SYSTEM,
  assertNoRankingFactFields,
  normalizeExternalSong,
  validateExternalSong,
} = require("../scripts/vsinger-moment/provenance");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "vsinger-moment");
const SONG_FIXTURE = readJsonFile(path.join(FIXTURE_DIR, "songs.json"));
const MCP_FIXTURE = readJsonFile(path.join(FIXTURE_DIR, "mcp-responses.json"));

test("MCP handshake and tool discovery use the public endpoint contract", async () => {
  const seenMethods = [];
  const fetchImpl = createQueuedFetch([
    jsonRpcResponse(MCP_FIXTURE.initialize, { "Mcp-Session-Id": "session-1" }),
    emptyResponse(202),
    jsonRpcResponse(MCP_FIXTURE.toolsList),
  ], seenMethods);
  const client = new McpHttpClient({
    endpoint: "https://vsinger-moment.jp/api/mcp-public",
    fetchImpl,
    requestsPerMinute: 40,
    sleep: async () => {},
  });

  const initialized = await client.initialize();
  const tools = await client.listTools();

  assert.equal(initialized.serverInfo.name, "vsinger-moment");
  assert.deepEqual(seenMethods, ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(client.sessionId, "session-1");
  for (const toolName of requiredTools()) {
    assert.equal(tools.tools.some((tool) => tool.name === toolName), true);
  }
  assert.equal(tools.tools.some((tool) => tool.name === "search"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "fetch"), true);
});

test("schema report preserves discovered request and response schema shape", () => {
  const report = buildSchemaReport({
    endpoint: "https://vsinger-moment.jp/api/mcp-public",
    initializeResult: MCP_FIXTURE.initialize.result,
    toolListResult: MCP_FIXTURE.toolsList.result,
    fetchedAt: "2026-07-17T14:01:04.845Z",
    requestCount: 2,
  });
  const summary = summarizeSchema(report);

  assert.equal(report.protocolVersion, "2025-06-18");
  assert.equal(report.tools.find((tool) => tool.name === "search_songs").inputSchema.required[0], "query");
  assert.equal(report.tools.find((tool) => tool.name === "get_song").outputSchema, null);
  assert.deepEqual(summary.searchFetchPresent, ["search", "fetch"]);
});

test("search_songs and get_song responses normalize into the external song model", () => {
  const standard = normalizeExternalSong(SONG_FIXTURE.records.find((record) => record.case === "standard-japanese-title"), {
    fetchedAt: "2026-07-17T14:01:04.845Z",
  });
  const history = normalizeExternalSong(SONG_FIXTURE.records.find((record) => record.case === "multiple-singing-history"), {
    fetchedAt: "2026-07-17T14:01:04.845Z",
  });

  assert.equal(standard.externalSongId, "song:jp-standard");
  assert.equal(standard.title, "少女レイ");
  assert.equal(standard.artist, "みきとP");
  assert.deepEqual(standard.artistAliases, ["MikitoP", "みきとぴー"]);
  assert.equal(standard.singingCountReference.value, 770);
  assert.equal(standard.singingCountReference.purpose, "quality_reference_only");
  assert.equal(history.latestPerformanceAt, "2026-07-16T12:00:00+09:00");
  assert.equal(validateExternalSong(standard).length, 0);
});

test("fixtures cover title, artist, versioning, missing-link, conflict, API error, and 429 cases", () => {
  const cases = new Set(SONG_FIXTURE.records.map((record) => record.case));

  for (const expectedCase of [
    "standard-japanese-title",
    "english-title",
    "kana-and-romaji-singer",
    "feat-singer",
    "same-title-different-artist-a",
    "same-title-different-artist-b",
    "piano-version",
    "remix",
    "multiple-singing-history",
    "no-youtube-link",
    "data-conflict",
  ]) {
    assert.equal(cases.has(expectedCase), true);
  }
  assert.equal(MCP_FIXTURE.apiError.status, 500);
  assert.equal(MCP_FIXTURE.rateLimited.status, 429);
  assert.equal(MCP_FIXTURE.rateLimited.headers["Retry-After"], "2");
});

test("rate limiter serializes requests below the official 60 request/minute ceiling", async () => {
  let now = 0;
  const sleeps = [];
  const limiter = new RateLimiter({
    requestsPerMinute: 30,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  await limiter.waitForTurn();
  await limiter.waitForTurn();
  await limiter.waitForTurn();

  assert.deepEqual(sleeps, [2000, 2000]);
  assert.throws(() => new RateLimiter({ requestsPerMinute: 61 }), /official 60 requests\/minute/);
});

test("429 Retry-After is honored before exponential backoff fallback", async () => {
  let now = 0;
  const sleeps = [];
  const fetchImpl = createQueuedFetch([
    jsonRpcResponse(MCP_FIXTURE.initialize, { "Mcp-Session-Id": "session-429" }),
    emptyResponse(202),
    httpError(429, { message: "rate limited" }, { "Retry-After": "2" }),
    jsonRpcResponse(MCP_FIXTURE.toolsList),
  ]);
  const client = new McpHttpClient({
    fetchImpl,
    requestsPerMinute: 30,
    maxRetries: 1,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
  });

  await client.initialize();
  const tools = await client.listTools();

  assert.equal(tools.tools.length, MCP_FIXTURE.toolsList.result.tools.length);
  assert.equal(sleeps.includes(2000), true);
  assert.equal(parseRetryAfter("2"), 2000);
});

test("request cache avoids repeated MCP calls for identical tool arguments", async () => {
  const cacheRoot = makeTempCacheRoot();
  const seenMethods = [];
  const firstResult = {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify([SONG_FIXTURE.records[0]]),
        },
      ],
    },
  };
  const fetchImpl = createQueuedFetch([
    jsonRpcResponse(MCP_FIXTURE.initialize, { "Mcp-Session-Id": "session-cache" }),
    emptyResponse(202),
    jsonRpcResponse(firstResult),
  ], seenMethods);
  const client = createMcpClient({
    fetchImpl,
    cache: new RequestCache({ rootDir: cacheRoot }),
    requestsPerMinute: 40,
    sleep: async () => {},
  });

  await client.initialize();
  const first = await client.searchSongs({ query: "少女レイ", limit: 1 });
  const second = await client.searchSongs({ query: "少女レイ", limit: 1 });

  assert.deepEqual(second, first);
  assert.deepEqual(seenMethods, ["initialize", "notifications/initialized", "tools/call"]);
});

test("import state supports resumable and idempotent catalog imports", async () => {
  const cacheRoot = makeTempCacheRoot();
  const searchResult = {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify([SONG_FIXTURE.records[0]]),
        },
      ],
    },
  };

  const first = await importSongCatalog({
    endpoint: "https://example.test/mcp",
    cacheDir: cacheRoot,
    dryRun: false,
    requestsPerMinute: 40,
    maxRequests: 8,
    maxRetries: 0,
    limit: 1,
    queries: ["少女レイ"],
    songIds: [],
    now: "2026-07-17T14:01:04.845Z",
    fetchImpl: createQueuedFetch([
      jsonRpcResponse(MCP_FIXTURE.initialize, { "Mcp-Session-Id": "session-import-1" }),
      emptyResponse(202),
      jsonRpcResponse(searchResult),
    ]),
    sleep: async () => {},
  });

  const second = await importSongCatalog({
    endpoint: "https://example.test/mcp",
    cacheDir: cacheRoot,
    dryRun: false,
    requestsPerMinute: 40,
    maxRequests: 8,
    maxRetries: 0,
    limit: 1,
    queries: ["少女レイ"],
    songIds: [],
    now: "2026-07-17T14:02:04.845Z",
    fetchImpl: createQueuedFetch([
      jsonRpcResponse(MCP_FIXTURE.initialize, { "Mcp-Session-Id": "session-import-2" }),
      emptyResponse(202),
      jsonRpcResponse(searchResult),
    ]),
    sleep: async () => {},
  });
  const state = new ImportState({ rootDir: cacheRoot });

  assert.equal(first.fetched.length, 1);
  assert.equal(second.fetched.length, 0);
  assert.equal(second.skipped[0].externalSongId, "song:jp-standard");
  assert.equal(state.hasFetched("song:jp-standard"), true);
});

test("unbounded full catalog sync is rejected without a bounded query or song id", () => {
  assert.throws(
    () =>
      planRequests({
        queries: [],
        songIds: [],
      }),
    /does not simulate unbounded full catalog sync/,
  );
  assert.deepEqual(parseImportArgs(["--query", "少女レイ", "--song-id", "song:1"]).queries, ["少女レイ"]);
});

test("provenance keeps external references out of local ranking facts", () => {
  const normalized = normalizeExternalSong(SONG_FIXTURE.records.find((record) => record.case === "english-title"), {
    fetchedAt: "2026-07-17T14:01:04.845Z",
  });

  assert.equal(normalized.sourceSystem, SOURCE_SYSTEM);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, "singingCount"), false);
  assert.throws(() => assertNoRankingFactFields({ local: { ranking: 1 } }), /must not be exported/);
});

test("MCP content extraction handles JSON text, arrays, and direct objects", () => {
  const fromText = extractSongRecords(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify([SONG_FIXTURE.records[1]]),
        },
      ],
    },
    { toolName: "search_songs" },
  );
  const fromResults = extractSongRecords({ results: [SONG_FIXTURE.records[2]] }, { toolName: "search_songs" });
  const fromObject = extractSongRecords(SONG_FIXTURE.records[3], { toolName: "get_song" });

  assert.equal(fromText[0].case, "english-title");
  assert.equal(fromResults[0].case, "kana-and-romaji-singer");
  assert.equal(fromObject[0].case, "feat-singer");
});

test("local cache is ignored and fixture data stays small", () => {
  const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  const externalDir = path.join(__dirname, "..", "data", "external", "vsinger-moment");
  const sizes = fs.readdirSync(externalDir).map((fileName) => fs.statSync(path.join(externalDir, fileName)).size);

  assert.match(gitignore, /^\.local-cache\/$/m);
  assert.equal(sizes.every((size) => size < 1024 * 1024), true);
});

function createQueuedFetch(responses, seenMethods = []) {
  const queue = responses.slice();
  return async (_url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    seenMethods.push(body.method);
    if (!queue.length) {
      throw new Error(`Unexpected fetch for ${body.method}`);
    }
    const next = queue.shift();
    return typeof next === "function" ? next(body) : next;
  };
}

function jsonRpcResponse(payload, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders(headers),
    text: async () => JSON.stringify(payload),
  };
}

function emptyResponse(status = 202, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(headers),
    text: async () => "",
  };
}

function httpError(status, payload, headers = {}) {
  return {
    ok: false,
    status,
    headers: makeHeaders(headers),
    text: async () => JSON.stringify(payload),
  };
}

function makeHeaders(headers) {
  return {
    get(name) {
      const lowerName = name.toLowerCase();
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
      return entry ? entry[1] : null;
    },
  };
}
