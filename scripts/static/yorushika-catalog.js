"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_PATH = path.resolve(
  process.env.STATIC_YORUSHIKA_CATALOG
    || path.resolve(__dirname, "../../config/yorushika-catalog.json"),
);

let catalogCache = null;

function canonicalizeStaticSong(song) {
  if (!song || typeof song !== "object") return song;
  const rawTitle = String(song.title || "").trim();
  const title = stripLeadingNewMarker(rawTitle);
  const artist = String(song.artist || "").trim();
  const titleMentionsYorushika = /(?:ヨルシカ|yorushika)/iu.test(title);
  const artistMentionsYorushika = /(?:ヨルシカ|yorushika)/iu.test(artist);
  const hasYorushikaEvidence = titleMentionsYorushika || artistMentionsYorushika;
  const exactYorushikaTitle = compactText(title) === compactText("ヨルシカ");
  const officialTitle = hasYorushikaEvidence
    ? resolveOfficialTitle(title, artist, titleMentionsYorushika || exactYorushikaTitle)
    : "";

  let cleaned = song;
  if (title !== rawTitle) {
    cleaned = {
      ...song,
      title,
      originalTitle: rawTitle,
      titleRepair: "leading_new_marker",
    };
  }

  if (officialTitle) {
    const changedTitle = title !== officialTitle;
    const changedArtist = artist !== "ヨルシカ";
    if (!changedTitle && !changedArtist) return cleaned;
    return {
      ...cleaned,
      title: officialTitle,
      artist: "ヨルシカ",
      ...(changedTitle ? { originalTitle: rawTitle } : {}),
      ...(changedArtist ? { originalArtist: artist } : {}),
      canonicalTitle: officialTitle,
      canonicalArtist: "ヨルシカ",
      catalogRepair: "yorushika_official_catalog",
    };
  }

  // Artist aliases still merge valid non-album titles, while title-only Yorushika text
  // must not rewrite another artist's song.
  if (artistMentionsYorushika && artist !== "ヨルシカ") {
    return {
      ...cleaned,
      artist: "ヨルシカ",
      originalArtist: artist,
      canonicalArtist: "ヨルシカ",
      catalogRepair: "yorushika_official_artist",
    };
  }
  return cleaned;
}

function shouldPublishStaticSong(song) {
  if (!song || typeof song !== "object") return false;
  const canonical = canonicalizeStaticSong(song);
  if (!canonical || typeof canonical !== "object") return false;
  if (canonical.artist !== "ヨルシカ") return true;
  return loadCatalog().titles.includes(canonical.title);
}

function resolveOfficialTitle(title, artist, allowArtistFallback) {
  const candidates = [title];
  if (allowArtistFallback) candidates.push(artist);
  for (const candidate of candidates) {
    const alias = matchOfficialTitle(candidate, { aliasesOnly: true });
    if (alias) return alias;
    const contained = matchOfficialTitle(candidate);
    if (contained) return contained;
  }
  return "";
}

function matchOfficialTitle(value, options = {}) {
  const variants = titleVariants(value);
  if (!variants.length) return "";
  const catalog = loadCatalog();
  for (const text of variants) {
    const alias = catalog.aliases.get(text);
    if (alias) return alias;
    if (!options.aliasesOnly) {
      // Prefer the longest official title so short works such as "451" cannot win a partial match.
      const contained = catalog.orderedTitles.find((title) => text.includes(compactText(title)));
      if (contained) return contained;
    }
  }
  return "";
}

function titleVariants(value) {
  const compact = compactText(value);
  if (!compact) return [];
  const variants = new Set([compact]);
  const withoutTrackNumber = compact.replace(/^\d+(?:曲目|曲|track|part)?/u, "");
  const withoutTrackLabel = compact.replace(/^(?:曲目|曲|track|part)/u, "");
  for (const base of [compact, withoutTrackNumber, withoutTrackLabel]) {
    if (!base) continue;
    variants.add(base);
    variants.add(base.replace(/(?:ヨルシカ|yorushika)/gu, ""));
    variants.add(base.replace(/(?:officialvideo|musicvideo|officiallyricvideo|ver|version)/gu, ""));
  }
  return [...variants].filter(Boolean);
}

function loadCatalog() {
  if (catalogCache) return catalogCache;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`unable to read yorushika catalog: ${error.message}`);
  }
  if (!payload || payload.schemaVersion !== 1 || payload.artist !== "ヨルシカ") {
    throw new Error("invalid yorushika catalog configuration");
  }
  if (!Array.isArray(payload.titles) || !payload.titles.length) {
    throw new Error("yorushika catalog titles must be non-empty");
  }
  const aliases = new Map();
  for (const [alias, title] of Object.entries(payload.aliases || {})) {
    if (!payload.titles.includes(title)) throw new Error(`yorushika alias targets unknown title: ${title}`);
    aliases.set(compactText(alias), title);
  }
  catalogCache = {
    aliases,
    orderedTitles: [...payload.titles].sort((left, right) => right.length - left.length),
    titles: payload.titles,
  };
  return catalogCache;
}

function stripLeadingNewMarker(value) {
  return String(value || "")
    .replace(/^\s*🆕(?:\s*新曲)?\s*/u, "")
    .trim();
}

function compactText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

module.exports = {
  canonicalizeStaticSong,
  loadYorushikaCatalog: loadCatalog,
  shouldPublishStaticSong,
};
