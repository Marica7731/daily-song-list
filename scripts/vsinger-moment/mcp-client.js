const { RequestCache, stableStringify } = require("./cache");

const DEFAULT_ENDPOINT = "https://vsinger-moment.jp/api/mcp-public";
const DEFAULT_REQUESTS_PER_MINUTE = 36;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
const JSON_RPC_VERSION = "2.0";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateValue = Date.parse(value);
  if (Number.isFinite(dateValue)) {
    return Math.max(0, dateValue - now);
  }
  return null;
}

function parseMcpResponseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const messages = [];
  let dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
      continue;
    }
    if (!line.trim() && dataLines.length) {
      const data = dataLines.join("\n").trim();
      if (data && data !== "[DONE]") {
        messages.push(JSON.parse(data));
      }
      dataLines = [];
    }
  }
  if (dataLines.length) {
    const data = dataLines.join("\n").trim();
    if (data && data !== "[DONE]") {
      messages.push(JSON.parse(data));
    }
  }
  if (!messages.length) {
    throw new Error("MCP response was not JSON or SSE JSON");
  }
  return messages[messages.length - 1];
}

class McpRpcError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "McpRpcError";
    this.status = options.status || null;
    this.code = options.code || null;
    this.details = options.details || null;
    this.retryAfterMs = options.retryAfterMs || null;
  }
}

class RateLimiter {
  constructor(options = {}) {
    const requestsPerMinute = options.requestsPerMinute || DEFAULT_REQUESTS_PER_MINUTE;
    if (requestsPerMinute <= 0 || requestsPerMinute > 60) {
      throw new Error("requestsPerMinute must be greater than 0 and no more than the official 60 requests/minute limit");
    }
    this.requestsPerMinute = requestsPerMinute;
    this.minIntervalMs = Math.ceil(60000 / requestsPerMinute);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.nextAvailableAt = 0;
  }

  async waitForTurn() {
    const now = this.now();
    const waitMs = Math.max(0, this.nextAvailableAt - now);
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    const afterWait = this.now();
    this.nextAvailableAt = Math.max(this.nextAvailableAt, afterWait) + this.minIntervalMs;
  }
}

class McpHttpClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error("A fetch implementation is required");
    }
    this.rateLimiter =
      options.rateLimiter ||
      new RateLimiter({
        requestsPerMinute: options.requestsPerMinute || DEFAULT_REQUESTS_PER_MINUTE,
        sleep: options.sleep,
        now: options.now,
      });
    this.sleep = options.sleep || defaultSleep;
    this.random = options.random || Math.random;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRequests = options.maxRequests ?? Infinity;
    this.requestCount = 0;
    this.nextId = 1;
    this.sessionId = null;
    this.initialized = false;
    this.protocolVersion = null;
    this.protocolVersions = options.protocolVersions || DEFAULT_PROTOCOL_VERSIONS;
    this.cache = options.cache === false ? null : options.cache || null;
  }

  async initialize(clientInfo = {}) {
    let lastError = null;
    for (const protocolVersion of this.protocolVersions) {
      this.sessionId = null;
      try {
        const result = await this.request(
          "initialize",
          {
            protocolVersion,
            capabilities: {},
            clientInfo: {
              name: clientInfo.name || "daily-song-list-vsinger-adapter",
              version: clientInfo.version || "0.1.0",
            },
          },
          { cache: false },
        );
        this.protocolVersion = result && result.protocolVersion ? result.protocolVersion : protocolVersion;
        this.initialized = true;
        await this.notifyInitialized();
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async notifyInitialized() {
    try {
      await this.sendNotification("notifications/initialized", {});
    } catch (error) {
      if (error.status && error.status >= 400) {
        throw error;
      }
    }
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async listTools() {
    await this.ensureInitialized();
    return this.request("tools/list", {}, { cache: true });
  }

  async callTool(name, args = {}, options = {}) {
    await this.ensureInitialized();
    return this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      { cache: options.cache !== false },
    );
  }

  searchSongs(args = {}, options = {}) {
    return this.callTool("search_songs", args, options);
  }

  getSong(args = {}, options = {}) {
    return this.callTool("get_song", args, options);
  }

  searchSingers(args = {}, options = {}) {
    return this.callTool("search_singers", args, options);
  }

  getSinger(args = {}, options = {}) {
    return this.callTool("get_singer", args, options);
  }

  getVideoSetlist(args = {}, options = {}) {
    return this.callTool("get_video_setlist", args, options);
  }

  async request(method, params = {}, options = {}) {
    const rpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: this.nextId++,
      method,
      params,
    };
    const cacheRequest = { endpoint: this.endpoint, method, params };
    if (options.cache && this.cache) {
      const cached = this.cache.get(cacheRequest);
      if (cached) {
        return cached.response;
      }
    }
    const response = await this.requestWithRetries(rpcRequest);
    if (options.cache && this.cache) {
      this.cache.set(cacheRequest, response);
    }
    return response;
  }

  async sendNotification(method, params = {}) {
    const payload = {
      jsonrpc: JSON_RPC_VERSION,
      method,
      params,
    };
    return this.requestWithRetries(payload, { notification: true });
  }

  async requestWithRetries(payload, options = {}) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.maxRetries) {
      try {
        return await this.sendOnce(payload, options);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= this.maxRetries) {
          throw error;
        }
        const delayMs = this.retryDelayMs(attempt, error.retryAfterMs);
        await this.sleep(delayMs);
        attempt += 1;
      }
    }
    throw lastError;
  }

  retryDelayMs(attempt, retryAfterMs) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return retryAfterMs;
    }
    const exponential = Math.min(30000, 500 * 2 ** attempt);
    const jitter = Math.floor(this.random() * 250);
    return exponential + jitter;
  }

  async sendOnce(payload, options = {}) {
    if (this.requestCount >= this.maxRequests) {
      throw new McpRpcError(`MCP request budget exhausted at ${this.maxRequests}`, {
        code: "MCP_REQUEST_BUDGET_EXHAUSTED",
      });
    }
    await this.rateLimiter.waitForTurn();
    this.requestCount += 1;

    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const nextSessionId = getHeader(response.headers, "mcp-session-id");
    if (nextSessionId) {
      this.sessionId = nextSessionId;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new McpRpcError(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`, {
        status: response.status,
        retryAfterMs: parseRetryAfter(getHeader(response.headers, "retry-after")),
        details: text,
      });
    }
    if (options.notification && (!text || response.status === 202)) {
      return null;
    }
    const message = parseMcpResponseBody(text);
    if (Array.isArray(message)) {
      return message;
    }
    if (message && message.error) {
      throw new McpRpcError(message.error.message || "MCP JSON-RPC error", {
        code: message.error.code,
        details: message.error,
      });
    }
    return message ? message.result : null;
  }
}

function getHeader(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return null;
}

function isRetryableError(error) {
  return error && (error.status === 429 || error.status === 408 || error.status >= 500);
}

function createMcpClient(options = {}) {
  const cache =
    options.cache === false
      ? false
      : options.cache ||
        (options.cacheDir
          ? new RequestCache({
              rootDir: options.cacheDir,
            })
          : null);
  return new McpHttpClient({
    ...options,
    cache,
  });
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PROTOCOL_VERSIONS,
  DEFAULT_REQUESTS_PER_MINUTE,
  McpHttpClient,
  McpRpcError,
  RateLimiter,
  createMcpClient,
  defaultSleep,
  parseMcpResponseBody,
  parseRetryAfter,
  stableStringify,
};
