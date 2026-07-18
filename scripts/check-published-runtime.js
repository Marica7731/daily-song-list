const crypto = require("node:crypto");
const fs = require("node:fs");

const DEFAULT_BASE_URL = "https://ytb-song-rank.culua.com/";
const LARGE_RANGE_FULL_FETCH_LIMIT = positiveInteger(process.env.DAILY_SONG_PUBLISHED_FULL_RANGE_LIMIT_BYTES, 12 * 1024 * 1024);
const options = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.DAILY_SONG_PUBLISHED_URL || DEFAULT_BASE_URL);
const expectedMeta = loadExpectedMeta(options.expectedMetaPath || process.env.DAILY_SONG_EXPECTED_META || "");
const errors = [];

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const checkedAt = new Date().toISOString();
  const meta = await fetchJson("data/ui/meta.json");
  assert(meta.schemaVersion === 1, "meta.schemaVersion must be 1");
  assert(isSha256(meta.dataVersion), "meta.dataVersion must be sha256");
  assert(meta.capturedAt, "meta.capturedAt missing");
  if (expectedMeta) {
    assert(meta.dataVersion === expectedMeta.dataVersion, `published dataVersion ${meta.dataVersion} must match expected ${expectedMeta.dataVersion}`);
    assert(meta.capturedAt === expectedMeta.capturedAt, `published capturedAt ${meta.capturedAt} must match expected ${expectedMeta.capturedAt}`);
  }

  const status = await fetchJson("data/status.json").catch((error) => {
    errors.push(`status.json unavailable: ${error.message}`);
    return null;
  });
  if (status) {
    assert(status.status === "success", `status.json must be success, got ${status.status || "missing"}`);
    if (status.dataVersion) assert(status.dataVersion === meta.dataVersion, "status.json dataVersion must match meta");
    if (status.capturedAt) assert(status.capturedAt === meta.capturedAt, "status.json capturedAt must match meta");
    if (status.dataCapturedAt) assert(status.dataCapturedAt === meta.dataCapturedAt, "status.json dataCapturedAt must match meta");
  }
  if (meta.status) {
    assert(meta.status.status === "success", `meta.status must be success, got ${meta.status.status || "missing"}`);
    if (meta.status.dataVersion) assert(meta.status.dataVersion === meta.dataVersion, "meta.status dataVersion must match meta");
    if (meta.status.capturedAt) assert(meta.status.capturedAt === meta.capturedAt, "meta.status capturedAt must match meta");
  }

  assert(meta.rangeAliases?.["72h"] === "7d", "meta.rangeAliases.72h must point to 7d");
  assert(meta.rangeAliases?.["1m"] === "all", "meta.rangeAliases.1m must point to all");
  assert(Array.isArray(meta.canonicalRanges), "meta.canonicalRanges must be array");
  assert(meta.canonicalRanges.includes("7d"), "meta.canonicalRanges must include 7d");
  assert(meta.canonicalRanges.includes("all"), "meta.canonicalRanges must include all");

  for (const [legacyId, canonicalId] of [
    ["72h", "7d"],
    ["1m", "all"],
  ]) {
    const alias = await fetchJson(`data/ui/${legacyId}.json`);
    const canonicalRange = meta.ranges?.[canonicalId];
    assert(alias.schemaVersion === 1, `data/ui/${legacyId}.json schemaVersion must be 1`);
    assert(alias.id === legacyId, `data/ui/${legacyId}.json id mismatch`);
    assert(alias.aliasOf === canonicalId, `data/ui/${legacyId}.json aliasOf must be ${canonicalId}`);
    assert(alias.path === canonicalRange?.path, `data/ui/${legacyId}.json path must point to hashed ${canonicalId} runtime`);
    assert(alias.legacyPath === canonicalRange?.legacyPath, `data/ui/${legacyId}.json legacyPath must point to ${canonicalId} runtime`);
    assert(alias.dataVersion === meta.dataVersion, `data/ui/${legacyId}.json dataVersion must match meta`);
    assert(alias.itemCount === canonicalRange?.itemCount, `data/ui/${legacyId}.json itemCount must match ${canonicalId}`);
  }

  for (const rangeId of ["7d", "all"]) {
    const rangeMeta = meta.ranges?.[rangeId];
    assert(rangeMeta, `meta.ranges.${rangeId} missing`);
    assert(rangeMeta?.dataVersion === meta.dataVersion, `range ${rangeId} dataVersion must match meta`);
    assert(isSha256(rangeMeta?.sha256), `range ${rangeId} sha256 missing`);
    assert(new RegExp(`^data/ui/${rangeId}\\.[0-9a-f]{12}\\.json$`, "u").test(rangeMeta?.path || ""), `range ${rangeId} path must be hashed`);
    if (Number.isFinite(rangeMeta.bytes) && rangeMeta.bytes > LARGE_RANGE_FULL_FETCH_LIMIT) {
      await checkReachableJson(rangeMeta.path, `range ${rangeId}`);
    } else {
      const { json, text, contentType, statusCode } = await fetchJsonWithText(rangeMeta.path);
      assert(statusCode === 200, `range ${rangeId} HTTP status must be 200`);
      assert(isJsonContentType(contentType), `range ${rangeId} content-type unexpected: ${contentType}`);
      assert(sha256Text(text) === rangeMeta.sha256, `range ${rangeId} sha256 mismatch`);
      assert(json.dataVersion === meta.dataVersion, `range ${rangeId} payload dataVersion mismatch`);
      assert(json.id === rangeId, `range ${rangeId} id mismatch`);
      assert(Array.isArray(json.items), `range ${rangeId} items must be array`);
      assert(json.items.length === rangeMeta.itemCount, `range ${rangeId} itemCount mismatch`);
      assert(json.items.length > 0, `range ${rangeId} items must be non-empty`);
    }

    await checkReachableJson(rangeMeta.legacyPath || `data/ui/${rangeId}.json`, null, `data/ui/${rangeId}.json`);

    await checkShard(rangeId, "runtime", rangeMeta.shards?.runtime, meta, "runtime-page-manifest", "items");
    await checkShard(rangeId, "sourceDetails", rangeMeta.shards?.sourceDetails, meta, "source-detail-manifest", "sources");
    await checkShard(rangeId, "search", rangeMeta.shards?.search, meta, "search-manifest", "records");
    await checkRequestRuntime(rangeId, rangeMeta.shards?.request, meta);
  }

  if (errors.length) {
    for (const error of errors) console.error(`[published-runtime] ${error}`);
    process.exit(1);
  }

  console.log(
    [
      "PUBLISHED_RUNTIME_OK",
      `checkedAt=${checkedAt}`,
      `baseUrl=${baseUrl}`,
      `dataVersion=${meta.dataVersion}`,
      `capturedAt=${meta.capturedAt}`,
      `status=${status?.status || "unknown"}`,
      `7d=${meta.ranges["7d"].itemCount}`,
      `all=${meta.ranges["all"].itemCount}`,
      `7dPages=${meta.ranges["7d"].shards.runtime.pageCount}`,
      `allPages=${meta.ranges["all"].shards.runtime.pageCount}`,
      `expected=${expectedMeta ? "matched" : "not-set"}`,
    ].join(" "),
  );
}

async function checkRequestRuntime(rangeId, requestMeta, meta) {
  assert(requestMeta, `range ${rangeId} request runtime missing`);
  const summary = await fetchJson(requestMeta.summary?.path || "");
  assert(summary.kind === "request-summary", `range ${rangeId} request summary kind mismatch`);
  assert(summary.dataVersion === meta.dataVersion, `range ${rangeId} request summary dataVersion mismatch`);
  const defaultView = requestMeta.views?.songRank?.occurrences?.all;
  assert(defaultView?.bootstrapPath, `range ${rangeId} request bootstrap missing`);
  const page = await fetchJson(defaultView.bootstrapPath);
  assert(page.kind === "request-view-page", `range ${rangeId} request bootstrap kind mismatch`);
  assert(page.dataVersion === meta.dataVersion, `range ${rangeId} request bootstrap dataVersion mismatch`);
  assert(Array.isArray(page.records) && page.records.length > 0, `range ${rangeId} request bootstrap records empty`);
  const searchManifest = await fetchJson(requestMeta.search?.manifestPath || "");
  assert(searchManifest.kind === "request-search-manifest", `range ${rangeId} request search manifest kind mismatch`);
  assert(searchManifest.dataVersion === meta.dataVersion, `range ${rangeId} request search dataVersion mismatch`);
}

async function checkShard(rangeId, shardName, shardMeta, meta, expectedKind, recordField) {
  assert(shardMeta, `range ${rangeId} ${shardName} shard missing`);
  assert(new RegExp(`^data/ui/.+/${rangeId}/manifest\\.[0-9a-f]{12}\\.json$`, "u").test(shardMeta?.manifestPath || ""), `range ${rangeId} ${shardName} manifest path must be hashed`);
  assert(shardMeta?.manifestLegacyPath?.endsWith(`/${rangeId}/manifest.json`), `range ${rangeId} ${shardName} legacy manifest path missing`);
  assert(isSha256(shardMeta?.sha256), `range ${rangeId} ${shardName} sha256 missing`);
  assert(Number.isFinite(shardMeta?.pageCount) && shardMeta.pageCount > 0, `range ${rangeId} ${shardName} pageCount must be positive`);
  assert(Number.isFinite(shardMeta?.itemCount) && shardMeta.itemCount > 0, `range ${rangeId} ${shardName} itemCount must be positive`);

  const { json: manifest, text: manifestText, statusCode } = await fetchJsonWithText(shardMeta.manifestPath);
  assert(statusCode === 200, `range ${rangeId} ${shardName} manifest HTTP status must be 200`);
  assert(sha256Text(manifestText) === shardMeta.sha256, `range ${rangeId} ${shardName} manifest sha256 mismatch`);
  assert(manifest.kind === expectedKind, `range ${rangeId} ${shardName} manifest kind mismatch`);
  assert(manifest.rangeId === rangeId, `range ${rangeId} ${shardName} manifest rangeId mismatch`);
  assert(manifest.dataVersion === meta.dataVersion, `range ${rangeId} ${shardName} manifest dataVersion mismatch`);
  assert(manifest.itemCount === shardMeta.itemCount, `range ${rangeId} ${shardName} manifest itemCount mismatch`);
  assert(manifest.pageCount === shardMeta.pageCount, `range ${rangeId} ${shardName} manifest pageCount mismatch`);
  assert(Array.isArray(manifest.pages) && manifest.pages.length === manifest.pageCount, `range ${rangeId} ${shardName} manifest pages mismatch`);

  const samplePages = uniqueSamplePages(manifest.pages);
  for (const pageMeta of samplePages) {
    assert(pageMeta.path && isSha256(pageMeta.sha256), `range ${rangeId} ${shardName} page metadata invalid`);
    const { json: page, text: pageText } = await fetchJsonWithText(pageMeta.path);
    assert(sha256Text(pageText) === pageMeta.sha256, `range ${rangeId} ${shardName} page ${pageMeta.index} sha256 mismatch`);
    assert(page.rangeId === rangeId, `range ${rangeId} ${shardName} page ${pageMeta.index} rangeId mismatch`);
    assert(page.dataVersion === meta.dataVersion, `range ${rangeId} ${shardName} page ${pageMeta.index} dataVersion mismatch`);
    assert(page.pageIndex === pageMeta.index, `range ${rangeId} ${shardName} page ${pageMeta.index} index mismatch`);
    assert(Array.isArray(page[recordField]), `range ${rangeId} ${shardName} page ${pageMeta.index} ${recordField} must be array`);
    assert(page[recordField].length === pageMeta.itemCount, `range ${rangeId} ${shardName} page ${pageMeta.index} itemCount mismatch`);
    assert(page[recordField].length > 0, `range ${rangeId} ${shardName} page ${pageMeta.index} must be non-empty`);
  }
}

function uniqueSamplePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return [];
  const indexes = [0, Math.floor((pages.length - 1) / 2), pages.length - 1];
  const seen = new Set();
  return indexes
    .map((index) => pages[index])
    .filter((page) => {
      if (!page || seen.has(page.index)) return false;
      seen.add(page.index);
      return true;
    });
}

async function fetchJson(path) {
  return (await fetchJsonWithText(path)).json;
}

async function checkReachableJson(path, label = path) {
  const head = await fetchHead(path);
  assert(head.statusCode === 200, `${label} HTTP status must be 200`);
  assert(isJsonContentType(head.contentType), `${label} content-type unexpected: ${head.contentType}`);
}

async function fetchHead(path) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, { method: "HEAD", cache: "no-store" });
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "",
  };
}

async function fetchJsonWithText(path) {
  const url = new URL(path, baseUrl);
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return {
    json: JSON.parse(text),
    text,
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "",
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/u.test(String(value || ""));
}

function isJsonContentType(value) {
  const contentType = String(value || "");
  return contentType.includes("application/json") || contentType.includes("text/plain");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(args) {
  const result = { baseUrl: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expected-meta") {
      result.expectedMetaPath = args[index + 1] || "";
      index += 1;
    } else if (!result.baseUrl) {
      result.baseUrl = arg;
    }
  }
  return result;
}

function loadExpectedMeta(filePath) {
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
