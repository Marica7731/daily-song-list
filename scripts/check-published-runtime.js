const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://ytb-song-rank.culua.com/";
const baseUrl = normalizeBaseUrl(process.argv[2] || process.env.DAILY_SONG_PUBLISHED_URL || DEFAULT_BASE_URL);
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

  for (const rangeId of ["72h", "1m"]) {
    const rangeMeta = meta.ranges?.[rangeId];
    assert(rangeMeta, `meta.ranges.${rangeId} missing`);
    assert(rangeMeta?.dataVersion === meta.dataVersion, `range ${rangeId} dataVersion must match meta`);
    assert(isSha256(rangeMeta?.sha256), `range ${rangeId} sha256 missing`);
    assert(new RegExp(`^data/ui/${rangeId}\\.[0-9a-f]{12}\\.json$`, "u").test(rangeMeta?.path || ""), `range ${rangeId} path must be hashed`);
    const { json, text, contentType, statusCode } = await fetchJsonWithText(rangeMeta.path);
    assert(statusCode === 200, `range ${rangeId} HTTP status must be 200`);
    assert(contentType.includes("application/json") || contentType.includes("text/plain"), `range ${rangeId} content-type unexpected: ${contentType}`);
    assert(sha256Text(text) === rangeMeta.sha256, `range ${rangeId} sha256 mismatch`);
    assert(json.dataVersion === meta.dataVersion, `range ${rangeId} payload dataVersion mismatch`);
    assert(json.id === rangeId, `range ${rangeId} id mismatch`);
    assert(Array.isArray(json.items), `range ${rangeId} items must be array`);
    assert(json.items.length === rangeMeta.itemCount, `range ${rangeId} itemCount mismatch`);
    assert(json.items.length > 0, `range ${rangeId} items must be non-empty`);
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
      `72h=${meta.ranges["72h"].itemCount}`,
      `1m=${meta.ranges["1m"].itemCount}`,
    ].join(" "),
  );
}

async function fetchJson(path) {
  return (await fetchJsonWithText(path)).json;
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

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
