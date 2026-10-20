"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CATALOG_ROOT = path.resolve(
  process.env.STATIC_ARTIST_CATALOG_ROOT
    || path.resolve(__dirname, "../../config/artist-catalogs"),
);

let defaultGateCache = null;

function loadArtistCatalogGate(options = {}) {
  if (!options.catalogRoot && defaultGateCache) return defaultGateCache;
  const catalogRoot = path.resolve(options.catalogRoot || DEFAULT_CATALOG_ROOT);
  const files = fs.readdirSync(catalogRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`artist catalog directory is empty: ${catalogRoot}`);

  const catalogs = files.map((name) => loadCatalog(path.join(catalogRoot, name)));
  const artistAliases = new Map();
  for (const catalog of catalogs) {
    for (const alias of catalog.artistAliases) {
      const key = compactText(alias);
      const previous = artistAliases.get(key);
      if (previous && previous.id !== catalog.id) {
        throw new Error(`artist alias belongs to multiple catalogs: ${alias}`);
      }
      artistAliases.set(key, catalog);
    }
  }

  const gate = { catalogs, artistAliases };
  if (!options.catalogRoot) defaultGateCache = gate;
  return gate;
}

function loadCatalog(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`unable to read artist catalog ${path.basename(file)}: ${error.message}`);
  }
  if (!payload || payload.schemaVersion !== 1) {
    throw new Error(`invalid artist catalog schema: ${path.basename(file)}`);
  }
  const id = String(payload.artistId || "").trim();
  const officialName = String(payload.officialName || "").trim();
  const catalogSource = String(payload.catalogSource || "").trim();
  const catalogRetrievedAt = String(payload.catalogRetrievedAt || "").trim();
  const maxUniqueTitles = Number(payload.maxUniqueTitles);
  if (!id || !officialName || !catalogSource || !catalogRetrievedAt) {
    throw new Error(`incomplete artist catalog identity: ${path.basename(file)}`);
  }
  if (!Array.isArray(payload.artistAliases) || !payload.artistAliases.length) {
    throw new Error(`artist aliases must be non-empty: ${id}`);
  }
  if (!payload.artistAliases.some((alias) => compactText(alias) === compactText(officialName))) {
    throw new Error(`official artist name must also be an alias: ${id}`);
  }
  if (!Array.isArray(payload.officialTitles) || !payload.officialTitles.length) {
    throw new Error(`official titles must be non-empty: ${id}`);
  }

  const officialTitles = payload.officialTitles.map((title) => String(title || "").trim());
  const titleByKey = new Map();
  for (const title of officialTitles) {
    const key = compactText(title);
    if (!key) throw new Error(`empty official title: ${id}`);
    if (titleByKey.has(key)) throw new Error(`duplicate official title after normalization: ${title}`);
    titleByKey.set(key, title);
  }
  if (!Number.isInteger(maxUniqueTitles) || maxUniqueTitles !== officialTitles.length) {
    throw new Error(`maxUniqueTitles must equal the official title count: ${id}`);
  }

  const titleAliases = new Map();
  for (const [alias, title] of Object.entries(payload.titleAliases || {})) {
    const target = titleByKey.get(compactText(title));
    if (!target) throw new Error(`title alias targets an unknown official title: ${id}: ${title}`);
    const key = compactText(alias);
    if (!key) throw new Error(`empty title alias: ${id}`);
    titleAliases.set(key, target);
  }

  return {
    id,
    officialName,
    catalogSource,
    catalogRetrievedAt,
    maxUniqueTitles,
    officialTitles,
    titleByKey,
    titleAliases,
    artistAliases: payload.artistAliases.map((alias) => String(alias || "").trim()).filter(Boolean),
    artistMatchers: payload.artistAliases.map((alias) => artistAliasPattern(alias)),
    reason: String(payload.reason || "verified_official_release_catalog"),
  };
}

function analyzeArtistCatalogSong(song) {
  if (!song || typeof song !== "object") return { matched: false, song };
  const gate = loadArtistCatalogGate();
  const title = String(song.title || "").normalize("NFKC").trim();
  const artist = String(song.artist || "").normalize("NFKC").trim();
  if (!title) return { matched: false, song };

  for (const catalog of gate.catalogs) {
    const artistEvidence = findArtistEvidence(title, artist, catalog);
    if (!artistEvidence) continue;

    const cleanedTitle = removeArtistEvidence(title, catalog).trim();
    const officialTitle = resolveOfficialTitle(cleanedTitle, catalog);
    if (!officialTitle) {
      return {
        matched: true,
        archived: true,
        catalog,
        artistEvidence,
        officialTitle: "",
        reason: "outside_official_release_catalog",
        song,
      };
    }

    const titleChanged = title !== officialTitle ||
      String(song.title || "").trim() !== officialTitle;
    const artistChanged = artist !== catalog.officialName ||
      String(song.artist || "").trim() !== catalog.officialName;
    const repaired = {
      ...song,
      title: officialTitle,
      artist: catalog.officialName,
      canonicalTitle: officialTitle,
      canonicalArtist: catalog.officialName,
      artistCatalogId: catalog.id,
      artistCatalogRepair: artistEvidence,
      ...(titleChanged ? { originalTitle: song.title } : {}),
      ...(artistChanged ? { originalArtist: song.artist } : {}),
    };
    return {
      matched: true,
      archived: false,
      catalog,
      artistEvidence,
      officialTitle,
      changed: titleChanged || artistChanged,
      titleChanged,
      artistChanged,
      song: repaired,
    };
  }
  return { matched: false, song };
}

function findArtistEvidence(title, artist, catalog) {
  if (catalog.artistMatchers.some((matcher) => matcher.test(artist))) return "official_artist_alias";
  if (!isUnknownOrVersionArtist(artist)) return "";
  if (catalog.artistAliases.some((alias) => includesAlias(title, alias))) return "title_embedded_artist";
  return "";
}

function resolveOfficialTitle(title, catalog) {
  const key = compactText(title);
  if (!key) return "";
  return catalog.titleAliases.get(key) || catalog.titleByKey.get(key) || "";
}

function removeArtistEvidence(title, catalog) {
  let value = String(title || "").normalize("NFKC");
  for (const alias of [...catalog.artistAliases].sort((left, right) => right.length - left.length)) {
    value = value.replace(aliasPattern(alias), " ");
  }
  return value.replace(/\s+/gu, " ").trim();
}

function isUnknownOrVersionArtist(value) {
  const text = String(value || "").normalize("NFKC").trim();
  return !text || /^(?:未記載|不明|未知歌手|unknown|ver\.?|version)$/iu.test(text);
}

function includesAlias(value, alias) {
  return aliasPattern(alias).test(String(value || "").normalize("NFKC"));
}

function artistAliasPattern(alias) {
  const escaped = escapeRegExp(String(alias || "").normalize("NFKC").trim());
  return new RegExp(
    `^${escaped}(?=$|[\\s（(\\[【/／,、・&+]|feat(?:uring)?\\b|ft\\.?\\b|の曲$)`,
    "iu",
  );
}

function aliasPattern(alias) {
  return new RegExp(escapeRegExp(String(alias || "").normalize("NFKC").trim()), "giu");
}

function compactText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resetArtistCatalogCache() {
  defaultGateCache = null;
}

module.exports = {
  analyzeArtistCatalogSong,
  loadArtistCatalogGate,
  resetArtistCatalogCache,
};
