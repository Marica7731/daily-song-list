const fs = require("node:fs");
const path = require("node:path");
const { normalizeArtistKey, normalizeSongTitleKey } = require("../assets/ranking-utils");

const ROOT = path.resolve(__dirname, "..");
const SONG_ALIASES_PATH = path.join(ROOT, "config", "song-aliases.json");

function loadSongAliasContext(filePath = SONG_ALIASES_PATH) {
  const config = readJsonIfExists(filePath) || { schemaVersion: 1, records: [] };
  return createSongAliasContext(config);
}

function createSongAliasContext(config = {}) {
  const records = Array.isArray(config.records) ? config.records : [];
  const aliasesByKey = new Map();
  const errors = [];

  if (config.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Array.isArray(config.records)) errors.push("records must be array");
  for (const [index, record] of records.entries()) {
    const artist = cleanText(record.artist);
    const canonicalTitle = cleanText(record.canonicalTitle);
    const artistKey = normalizeArtistKey(artist);
    const canonicalTitleKey = normalizeSongTitleKey(canonicalTitle);
    if (!artist || !artistKey) errors.push(`records[${index}].artist invalid`);
    if (!canonicalTitle || !canonicalTitleKey) errors.push(`records[${index}].canonicalTitle invalid`);
    if (!Array.isArray(record.aliases)) errors.push(`records[${index}].aliases must be array`);
    const aliases = [...new Set([...(record.aliases || []), canonicalTitle].map(cleanText).filter(Boolean))];
    if (!aliases.length) errors.push(`records[${index}].aliases empty`);
    for (const alias of aliases) {
      const aliasTitleKey = normalizeSongTitleKey(alias);
      if (!artistKey || !aliasTitleKey) continue;
      const key = aliasKey(artistKey, aliasTitleKey);
      const value = {
        artist,
        artistKey,
        canonicalTitle,
        canonicalTitleKey,
        alias,
        aliasTitleKey,
        reason: cleanText(record.reason) || "verified_same_song",
      };
      const existing = aliasesByKey.get(key);
      if (existing && existing.canonicalTitleKey !== canonicalTitleKey) {
        errors.push(`records[${index}] conflicts for ${artist} / ${alias}`);
        continue;
      }
      aliasesByKey.set(key, value);
    }
  }

  return {
    schemaVersion: config.schemaVersion || 1,
    aliasVersion: aliasVersion(config),
    aliasesByKey,
    records,
    errors,
  };
}

function canonicalizeSongIdentity(song, aliasContext = null) {
  const context = aliasContext || loadSongAliasContext();
  if (!song || typeof song !== "object" || !context?.aliasesByKey?.size) return song;
  const title = cleanText(song.title);
  const artist = cleanText(song.artist);
  const artistKey = normalizeArtistKey(artist);
  const titleKey = normalizeSongTitleKey(title);
  const match = context.aliasesByKey.get(aliasKey(artistKey, titleKey));
  if (!match) return song;

  const changed = title !== match.canonicalTitle;
  const next = {
    ...song,
    title: match.canonicalTitle,
    alias: {
      ...(song.alias || {}),
      changed,
      aliasTitle: title,
      canonicalTitle: match.canonicalTitle,
      artist: match.artist,
      reason: match.reason,
      aliasVersion: context.aliasVersion,
    },
  };
  if (changed && !next.originalTitle) next.originalTitle = title;
  return next;
}

function canonicalizePayloadSongAliases(payload, aliasContext = null) {
  const context = aliasContext || loadSongAliasContext();
  if (!payload?.groups || !context?.aliasesByKey?.size) return payload;
  return {
    ...payload,
    aliasVersion: context.aliasVersion,
    groups: Object.fromEntries(
      Object.entries(payload.groups || {}).map(([groupId, group]) => [
        groupId,
        {
          ...group,
          aliasVersion: context.aliasVersion,
          items: (group.items || []).map((item) => ({
            ...item,
            songs: (item.songs || []).map((song) => canonicalizeSongIdentity(song, context)),
          })),
        },
      ]),
    ),
    source: {
      ...(payload.source || {}),
      songAliases: {
        schemaVersion: context.schemaVersion,
        aliasVersion: context.aliasVersion,
        recordCount: context.records.length,
      },
    },
  };
}

function validateSongAliasConfig(config = {}) {
  const context = createSongAliasContext(config);
  return { errors: context.errors, context };
}

function aliasKey(artistKey, titleKey) {
  return `${artistKey || ""}::${titleKey || ""}`;
}

function aliasVersion(config) {
  return `song-aliases-v${config.schemaVersion || 1}:${recordsHash(config.records || [])}`;
}

function recordsHash(records) {
  const text = JSON.stringify(records);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  SONG_ALIASES_PATH,
  canonicalizePayloadSongAliases,
  canonicalizeSongIdentity,
  createSongAliasContext,
  loadSongAliasContext,
  validateSongAliasConfig,
};
