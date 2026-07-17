const crypto = require("node:crypto");

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = new RegExp(UUID_PATTERN);

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function decodeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripTags(html) {
  return normalizeText(decodeHtml(String(html || "").replace(/<[^>]*>/g, " ")));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getAttr(tag, name) {
  if (!tag) return "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`${escaped}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[2] || match?.[3] || match?.[4] || "");
}

function extractMetaContent(html, selectorName, selectorValue) {
  const tagRe = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(tagRe)) {
    const tag = match[0];
    if (getAttr(tag, selectorName) === selectorValue) return getAttr(tag, "content");
  }
  return "";
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(match?.[1] || "");
}

function absoluteUrl(href, baseUrl = "https://vsinger-moment.jp") {
  if (!href) return "";
  return new URL(decodeHtml(href), baseUrl).toString();
}

function extractUuidFromPath(value, prefix) {
  const path = value ? new URL(value, "https://vsinger-moment.jp").pathname : "";
  const match = path.match(new RegExp(`^/${prefix}/(${UUID_PATTERN})$`, "i"));
  return match?.[1] || "";
}

function parseJapaneseDate(value) {
  const text = stripTags(value);
  const match = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseTimestampToSeconds(value) {
  const text = stripTags(value);
  const match = text.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseYouTubeVideoId(value) {
  if (!value) return "";
  const decoded = decodeHtml(value);
  try {
    const url = new URL(decoded, "https://www.youtube.com");
    if (url.hostname === "youtu.be") return cleanYouTubeId(url.pathname.slice(1));
    if (url.hostname.endsWith("youtube.com")) {
      if (url.pathname === "/watch") return cleanYouTubeId(url.searchParams.get("v") || "");
      const embed = url.pathname.match(/^\/(?:embed|shorts)\/([^/?#]+)/);
      if (embed) return cleanYouTubeId(embed[1]);
    }
  } catch {
    const match = decoded.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
    return cleanYouTubeId(match?.[1] || "");
  }
  const direct = decoded.match(/^[A-Za-z0-9_-]{11}$/);
  return direct ? decoded : "";
}

function cleanYouTubeId(value) {
  const match = String(value || "").match(/[A-Za-z0-9_-]{11}/);
  return match?.[0] || "";
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

module.exports = {
  UUID_PATTERN,
  UUID_RE,
  absoluteUrl,
  decodeHtml,
  extractMetaContent,
  extractTitle,
  extractUuidFromPath,
  getAttr,
  normalizeText,
  parseJapaneseDate,
  parseTimestampToSeconds,
  parseYouTubeVideoId,
  sha256,
  stripTags,
  uniqueBy,
};
