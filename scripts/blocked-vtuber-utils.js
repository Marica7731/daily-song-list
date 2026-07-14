const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BLOCKLIST_PATH = path.join(ROOT_DIR, "config", "blocked-vtuber-channels.json");
const DEFAULT_GENERATED_ASSET_PATH = path.join(ROOT_DIR, "assets", "blocked-vtuber-channels.js");
const VALID_REGIONS = new Set(["TW", "HK", "LEGACY_REVIEW"]);
const VALID_STATUS = new Set(["blocked"]);
const DANGEROUS_BROAD_TERMS = new Set(
  [
    "Taiwan",
    "Taiwan VTuber",
    "台灣",
    "台湾",
    "台V",
    "台v",
    "港V",
    "港v",
    "香港Vtuber",
    "HKVtuber",
    "VTuber",
    "Vtuber",
    "個人勢",
    "个人势",
    "Narrator",
  ].map(normalizeTerm),
);

function loadBlocklist(filePath = DEFAULT_BLOCKLIST_PATH) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function canonicalizeBlocklist(blocklist) {
  return {
    schemaVersion: blocklist.schemaVersion,
    listVersion: blocklist.listVersion,
    updatedAt: blocklist.updatedAt,
    entries: (blocklist.entries || []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      regions: [...(entry.regions || [])],
      reason: entry.reason,
      status: entry.status,
      channelIds: uniqueSorted(entry.channelIds || []),
      handles: uniqueSorted((entry.handles || []).map(formatHandle)),
      channelUrls: uniqueSorted((entry.channelUrls || []).map(normalizeUrlForStorage)),
      aliases: uniqueSorted(entry.aliases || []),
      titleAliases: uniqueSorted(entry.titleAliases || []),
      unsafeBroadAliases: uniqueSorted(entry.unsafeBroadAliases || []),
      verifiedAt: entry.verifiedAt,
      evidence: uniqueSorted(entry.evidence || []),
    })),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function blocklistHash(blocklist) {
  return sha256Text(stableJson(canonicalizeBlocklist(blocklist)));
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function validateBlocklist(blocklist, options = {}) {
  const errors = [];
  if (!blocklist || typeof blocklist !== "object" || Array.isArray(blocklist)) errors.push("blocklist must be object");
  if (blocklist?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!String(blocklist?.listVersion || "").trim()) errors.push("listVersion is required");
  if (!String(blocklist?.updatedAt || "").trim()) errors.push("updatedAt is required");
  if (!Array.isArray(blocklist?.entries)) errors.push("entries must be array");

  const ids = new Set();
  const channelIds = new Set();
  const handles = new Set();
  const channelUrls = new Set();

  for (const [index, entry] of (blocklist?.entries || []).entries()) {
    const label = entry?.id || `entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}: entry must be object`);
      continue;
    }
    if (!String(entry.id || "").trim()) errors.push(`${label}: id is required`);
    if (ids.has(entry.id)) errors.push(`${label}: duplicate id`);
    ids.add(entry.id);
    if (!String(entry.name || "").trim()) errors.push(`${label}: name is required`);
    if (!Array.isArray(entry.regions) || entry.regions.length === 0) {
      errors.push(`${label}: regions must be non-empty array`);
    } else {
      for (const region of entry.regions) {
        if (!VALID_REGIONS.has(region)) errors.push(`${label}: invalid region ${region}`);
      }
    }
    if (!VALID_STATUS.has(entry.status)) errors.push(`${label}: invalid status ${entry.status}`);
    for (const field of ["channelIds", "handles", "channelUrls", "aliases", "titleAliases", "unsafeBroadAliases", "evidence"]) {
      if (!Array.isArray(entry[field])) errors.push(`${label}: ${field} must be array`);
    }
    for (const channelId of entry.channelIds || []) {
      if (!/^UC[A-Za-z0-9_-]{20,}$/u.test(channelId)) errors.push(`${label}: invalid channelId ${channelId}`);
      if (channelIds.has(channelId)) errors.push(`${label}: duplicate channelId ${channelId}`);
      channelIds.add(channelId);
    }
    for (const handle of entry.handles || []) {
      const normalized = normalizeHandle(handle);
      if (!normalized) errors.push(`${label}: invalid handle ${handle}`);
      if (handles.has(normalized)) errors.push(`${label}: duplicate handle ${handle}`);
      handles.add(normalized);
    }
    for (const url of entry.channelUrls || []) {
      const key = normalizeChannelUrl(url);
      if (!key) errors.push(`${label}: invalid channelUrl ${url}`);
      if (channelUrls.has(key)) errors.push(`${label}: duplicate channelUrl ${url}`);
      channelUrls.add(key);
    }
    for (const field of ["aliases", "titleAliases"]) {
      for (const value of entry[field] || []) {
        if (DANGEROUS_BROAD_TERMS.has(normalizeTerm(value))) {
          errors.push(`${label}: dangerous broad term in ${field}: ${value}`);
        }
      }
    }
  }

  if (options.requireGeneratedAsset) {
    const assetPath = options.assetPath || DEFAULT_GENERATED_ASSET_PATH;
    if (!fs.existsSync(assetPath)) {
      errors.push(`${path.relative(ROOT_DIR, assetPath)} missing`);
    } else {
      const asset = fs.readFileSync(assetPath, "utf8");
      const expectedHash = blocklistHash(blocklist);
      if (!asset.includes(`blocklistHash: "${expectedHash}"`)) errors.push("generated asset blocklistHash mismatch");
      if (!asset.includes(`listVersion: "${blocklist.listVersion}"`)) errors.push("generated asset listVersion mismatch");
    }
  }

  return { ok: errors.length === 0, errors };
}

function createBlockedSourceMatcher(blocklist) {
  const entries = (blocklist.entries || []).filter((entry) => entry.status === "blocked");
  const channelIdIndex = new Map();
  const handleIndex = new Map();
  const channelUrlIndex = new Map();
  const aliasIndex = new Map();
  const titleAliasIndex = new Map();

  for (const entry of entries) {
    const meta = entryMeta(entry);
    for (const value of entry.channelIds || []) channelIdIndex.set(value, { ...meta, matchedField: "channelId", matchedValue: value, matchType: "exact" });
    for (const value of entry.handles || []) {
      const normalized = normalizeHandle(value);
      if (normalized) handleIndex.set(normalized, { ...meta, matchedField: "handle", matchedValue: value, matchType: "exact" });
    }
    for (const value of entry.channelUrls || []) {
      const normalized = normalizeChannelUrl(value);
      if (normalized) channelUrlIndex.set(normalized, { ...meta, matchedField: "channelUrl", matchedValue: value, matchType: "exact" });
    }
    for (const value of [entry.name, ...(entry.aliases || [])]) {
      const normalized = normalizeChannelAlias(value);
      if (normalized) aliasIndex.set(normalized, { ...meta, matchedField: "channelName", matchedValue: value, matchType: "exact" });
    }
    for (const value of entry.titleAliases || []) {
      const normalized = normalizeTitleText(value);
      if (normalized) titleAliasIndex.set(normalized, { ...meta, matchedField: "title", matchedValue: value, matchType: "contains" });
    }
  }

  return function matchBlockedSource(item = {}) {
    for (const value of channelIdValues(item)) {
      const match = channelIdIndex.get(value);
      if (match) return match;
    }
    for (const value of handleValues(item)) {
      const normalized = normalizeHandle(value);
      const match = normalized ? handleIndex.get(normalized) : null;
      if (match) return match;
    }
    for (const value of channelUrlValues(item)) {
      const normalized = normalizeChannelUrl(value);
      const match = normalized ? channelUrlIndex.get(normalized) || handleIndex.get(normalized.replace(/^@/u, "")) : null;
      if (match) return match;
    }
    for (const value of channelNameValues(item)) {
      const normalized = normalizeChannelAlias(value);
      const match = normalized ? aliasIndex.get(normalized) : null;
      if (match) return match;
    }
    const title = normalizeTitleText(item.title || "");
    if (title) {
      for (const [alias, match] of titleAliasIndex.entries()) {
        if (title.includes(alias)) return match;
      }
    }
    return null;
  };
}

function entryMeta(entry) {
  return {
    entryId: entry.id,
    name: entry.name,
    region: (entry.regions || []).join(","),
  };
}

function channelIdValues(item) {
  return uniqueStrings([item.channelId, item.authorChannelId, item.ownerChannelId]);
}

function handleValues(item) {
  const values = [item.channelHandle, item.handle, item.ownerHandle];
  for (const url of channelUrlValues(item)) {
    const parsed = normalizeChannelUrl(url);
    if (parsed?.startsWith("@")) values.push(parsed);
  }
  return uniqueStrings(values);
}

function channelUrlValues(item) {
  return uniqueStrings([item.channelUrl, item.authorUrl, item.ownerUrl]);
}

function channelNameValues(item) {
  return uniqueStrings([item.channelName, item.ownerText, item.longBylineText, item.shortBylineText]);
}

function normalizeChannelAlias(value) {
  return normalizeWhitespace(String(value || "").normalize("NFKC")).toLocaleLowerCase();
}

function normalizeTitleText(value) {
  return normalizeChannelAlias(value);
}

function normalizeHandle(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?youtube\.com\//iu, "")
    .replace(/^\/+/u, "")
    .split(/[/?#]/u)[0]
    .replace(/^@/u, "")
    .trim();
  return /^[A-Za-z0-9._-]+$/u.test(cleaned) ? cleaned.toLocaleLowerCase() : "";
}

function formatHandle(value) {
  const normalized = normalizeHandle(value);
  return normalized ? `@${normalized}` : String(value || "").trim();
}

function normalizeChannelUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://www.youtube.com");
    const host = url.hostname.replace(/^www\./iu, "").toLocaleLowerCase();
    if (!["youtube.com", "m.youtube.com"].includes(host)) return "";
    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) return "";
    if (segments[0].startsWith("@")) return `@${normalizeHandle(segments[0])}`;
    if (segments[0] === "channel" && segments[1]) return segments[1];
    return `/${segments.slice(0, 2).join("/")}`.toLocaleLowerCase();
  } catch {
    return "";
  }
}

function normalizeUrlForStorage(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  const parsed = normalizeChannelUrl(raw);
  if (parsed?.startsWith("@")) return `https://www.youtube.com/${parsed}`;
  if (parsed?.startsWith("UC")) return `https://www.youtube.com/channel/${parsed}`;
  return raw;
}

function normalizeTerm(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueSorted(values) {
  return uniqueStrings(values).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

module.exports = {
  DEFAULT_BLOCKLIST_PATH,
  DEFAULT_GENERATED_ASSET_PATH,
  VALID_REGIONS,
  blocklistHash,
  canonicalizeBlocklist,
  createBlockedSourceMatcher,
  loadBlocklist,
  normalizeChannelUrl,
  normalizeHandle,
  stableJson,
  validateBlocklist,
};
