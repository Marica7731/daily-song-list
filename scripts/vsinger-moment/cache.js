const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_CACHE_ROOT = path.join(".local-cache", "vsinger-moment");
const DEFAULT_SCHEMA_VERSION = "vsinger-moment.import-state.v1";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function defaultCacheRoot(cwd = process.cwd()) {
  return path.resolve(cwd, DEFAULT_CACHE_ROOT);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFileAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.writeFileSync(tempPath, payload);
  fs.renameSync(tempPath, filePath);
}

class RequestCache {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || defaultCacheRoot());
    this.requestDir = path.join(this.rootDir, "requests");
  }

  keyFor(request) {
    return sha256(stableStringify(request));
  }

  pathForKey(key) {
    return path.join(this.requestDir, `${key}.json`);
  }

  get(request) {
    const key = this.keyFor(request);
    const entry = readJsonFile(this.pathForKey(key), null);
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      cacheKey: key,
      cacheHit: true,
    };
  }

  set(request, response, metadata = {}) {
    const key = this.keyFor(request);
    const entry = {
      schemaVersion: "vsinger-moment.request-cache.v1",
      cacheKey: key,
      cachedAt: metadata.cachedAt || new Date().toISOString(),
      request,
      response,
      rawHash: sha256(stableStringify(response)),
    };
    writeJsonFileAtomic(this.pathForKey(key), entry);
    return entry;
  }
}

class ImportState {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(options.rootDir || defaultCacheRoot(), "import-state.json"));
    const state = normalizeImportState(readJsonFile(this.filePath, null), options);
    this.schemaVersion = state.schemaVersion;
    this.lastCursor = state.lastCursor;
    this.fetchedExternalSongIds = new Set(state.fetchedExternalSongIds);
    this.lastFetchedAt = state.lastFetchedAt;
    this.failures = { ...state.failures };
    this.retryCounts = { ...state.retryCounts };
  }

  hasFetched(externalSongId) {
    return this.fetchedExternalSongIds.has(String(externalSongId));
  }

  markFetched(externalSongId, fetchedAt = new Date().toISOString()) {
    this.fetchedExternalSongIds.add(String(externalSongId));
    this.lastFetchedAt = fetchedAt;
    delete this.failures[String(externalSongId)];
  }

  setCursor(cursor) {
    this.lastCursor = cursor || null;
  }

  recordFailure(key, error) {
    const id = String(key);
    this.retryCounts[id] = (this.retryCounts[id] || 0) + 1;
    this.failures[id] = {
      key: id,
      message: error && error.message ? error.message : String(error),
      failedAt: new Date().toISOString(),
      retryCount: this.retryCounts[id],
    };
  }

  toJSON() {
    return {
      schemaVersion: this.schemaVersion,
      lastCursor: this.lastCursor,
      fetchedExternalSongIds: Array.from(this.fetchedExternalSongIds).sort(),
      lastFetchedAt: this.lastFetchedAt,
      failures: this.failures,
      retryCounts: this.retryCounts,
    };
  }

  save() {
    writeJsonFileAtomic(this.filePath, this.toJSON());
  }
}

function normalizeImportState(state, options = {}) {
  return {
    schemaVersion: (state && state.schemaVersion) || options.schemaVersion || DEFAULT_SCHEMA_VERSION,
    lastCursor: state && state.lastCursor ? state.lastCursor : null,
    fetchedExternalSongIds: Array.isArray(state && state.fetchedExternalSongIds) ? state.fetchedExternalSongIds : [],
    lastFetchedAt: state && state.lastFetchedAt ? state.lastFetchedAt : null,
    failures: state && state.failures && typeof state.failures === "object" ? state.failures : {},
    retryCounts: state && state.retryCounts && typeof state.retryCounts === "object" ? state.retryCounts : {},
  };
}

function makeTempCacheRoot(prefix = "vsinger-moment-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  DEFAULT_CACHE_ROOT,
  DEFAULT_SCHEMA_VERSION,
  ImportState,
  RequestCache,
  defaultCacheRoot,
  ensureDir,
  makeTempCacheRoot,
  readJsonFile,
  sha256,
  stableStringify,
  writeJsonFileAtomic,
};
