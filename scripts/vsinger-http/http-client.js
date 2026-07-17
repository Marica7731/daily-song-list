const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { sha256 } = require("./html-utils");

const DEFAULT_USER_AGENT =
  "daily-song-list-vsinger-http-backfill/0.1 (+https://github.com/Marica7731/daily-song-list; contact: github.com/Marica7731)";

class VsingerHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VsingerHttpError";
    Object.assign(this, details);
  }
}

class VsingerHttpClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || "https://vsinger-moment.jp";
    this.cacheDir = options.cacheDir || path.resolve(process.cwd(), ".local-cache", "vsinger-http");
    this.userAgent = options.userAgent || process.env.VSINGER_HTTP_USER_AGENT || DEFAULT_USER_AGENT;
    this.requestIntervalMs = Math.max(0, Number(options.requestIntervalMs ?? process.env.VSINGER_HTTP_REQUEST_INTERVAL_MS ?? 1000));
    this.connectTimeoutMs = Number(options.connectTimeoutMs ?? process.env.VSINGER_HTTP_CONNECT_TIMEOUT_MS ?? 15000);
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? process.env.VSINGER_HTTP_REQUEST_TIMEOUT_MS ?? 30000);
    this.maxRetries = Number(options.maxRetries ?? 3);
    this.transport = options.transport || globalThis.fetch;
    this.lastRequestAt = 0;
    this.metrics = {
      requestCount: 0,
      networkRequestCount: 0,
      cacheHitCount: 0,
      totalBytes: 0,
      totalElapsedMs: 0,
      statuses: {},
    };
    if (!this.transport) throw new Error("global fetch is unavailable; Node.js 20+ is required.");
  }

  setMinimumIntervalMs(intervalMs) {
    const parsed = Number(intervalMs);
    if (Number.isFinite(parsed)) this.requestIntervalMs = Math.max(this.requestIntervalMs, parsed);
  }

  async getText(urlOrPath, options = {}) {
    const url = new URL(urlOrPath, this.baseUrl).toString();
    const cacheEntry = this.readCache(url);
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      await this.throttle();
      const headers = {
        "user-agent": this.userAgent,
        accept: "text/html",
        "accept-encoding": "gzip, br",
        ...options.headers,
      };
      if (cacheEntry?.etag) headers["if-none-match"] = cacheEntry.etag;
      if (cacheEntry?.lastModified) headers["if-modified-since"] = cacheEntry.lastModified;

      const startedAt = Date.now();
      let response;
      try {
        const signal = AbortSignal.timeout(this.requestTimeoutMs);
        response = await this.transport(url, { headers, signal });
      } catch (error) {
        lastError = error;
        if (attempt > this.maxRetries) break;
        await delay(backoffMs(attempt));
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      this.metrics.requestCount += 1;
      this.metrics.networkRequestCount += 1;
      this.metrics.totalElapsedMs += elapsedMs;
      this.metrics.statuses[response.status] = (this.metrics.statuses[response.status] || 0) + 1;

      if (response.status === 304 && cacheEntry) {
        const body = fs.readFileSync(cacheEntry.bodyPath, "utf8");
        this.metrics.cacheHitCount += 1;
        return this.recordResult({ url, status: 304, headers: headersObject(response.headers), body, fromCache: true, elapsedMs });
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (attempt > this.maxRetries) {
          throw new VsingerHttpError("VSinger Moment returned HTTP 429 after retries.", { status: 429, url, retryAfterMs: retryAfter });
        }
        await delay(retryAfter || backoffMs(attempt));
        continue;
      }

      if (response.status === 403) {
        throw new VsingerHttpError("VSinger Moment returned HTTP 403; crawler must pause.", { status: 403, url, pauseRequired: true });
      }

      if (response.status >= 500) {
        if (attempt > this.maxRetries) {
          throw new VsingerHttpError(`VSinger Moment returned HTTP ${response.status} after retries.`, { status: response.status, url });
        }
        await delay(backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        throw new VsingerHttpError(`VSinger Moment returned HTTP ${response.status}.`, { status: response.status, url });
      }

      const body = await response.text();
      const responseHeaders = headersObject(response.headers);
      this.writeCache(url, responseHeaders, body);
      return this.recordResult({ url, status: response.status, headers: responseHeaders, body, fromCache: false, elapsedMs });
    }

    throw new VsingerHttpError(`Request failed for ${url}: ${lastError?.message || "unknown error"}`, { url, cause: lastError });
  }

  readCache(url) {
    const key = sha256(url);
    const metaPath = path.join(this.cacheDir, `${key}.json`);
    const bodyPath = path.join(this.cacheDir, `${key}.html`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return { ...meta, bodyPath };
    } catch {
      return null;
    }
  }

  writeCache(url, headers, body) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const key = sha256(url);
    const metaPath = path.join(this.cacheDir, `${key}.json`);
    const bodyPath = path.join(this.cacheDir, `${key}.html`);
    fs.writeFileSync(bodyPath, body, "utf8");
    fs.writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          url,
          fetchedAt: new Date().toISOString(),
          etag: headers.etag || "",
          lastModified: headers["last-modified"] || "",
          bodyPath,
          byteLength: Buffer.byteLength(body),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  recordResult(result) {
    const bytes = Buffer.byteLength(result.body || "");
    this.metrics.totalBytes += bytes;
    return { ...result, bytes };
  }

  async throttle() {
    const waitMs = this.lastRequestAt + this.requestIntervalMs - Date.now();
    if (waitMs > 0) await delay(waitMs);
    this.lastRequestAt = Date.now();
  }
}

function backoffMs(attempt) {
  return Math.min(30000, 500 * 2 ** Math.max(0, attempt - 1));
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function headersObject(headers) {
  const object = {};
  if (!headers) return object;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      object[key.toLowerCase()] = value;
    });
  }
  return object;
}

module.exports = {
  DEFAULT_USER_AGENT,
  VsingerHttpClient,
  VsingerHttpError,
  parseRetryAfter,
};
