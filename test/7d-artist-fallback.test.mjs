import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "assets", "app.js");
const source = fs.readFileSync(appPath, "utf8");

function extractFunction(text, name) {
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

assert.match(source, /function validSongArtistCandidate\(value\)/);
assert.match(source, /function fallbackSongArtist\(record\)/);
assert.match(source, /record\.displayArtist/);
assert.match(source, /occurrence\?\.song\?\.artist/);
assert.match(source, /primary: dominantArtist \|\| fallbackArtist \|\|/);

const unknownNames = new Set(["unknown", "未知", "未知歌手", "待补歌手"]);
const context = {
  cleanText(value) {
    return value == null ? "" : String(value).trim();
  },
  isNicheRecord() {
    return false;
  },
  sortedCountEntries(map) {
    return Array.from(map?.values?.() || []).sort((a, b) => (b.count || 0) - (a.count || 0));
  },
  window: {
    RankingUtils: {
      isUnknownArtistName(value) {
        return unknownNames.has(String(value || "").trim().toLowerCase());
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(
  ["validSongArtistCandidate", "fallbackSongArtist", "songMeta"]
    .map((name) => extractFunction(source, name))
    .join("\n"),
  context,
);

function record(artists, displayArtist = "", occurrences = []) {
  return {
    artists: new Map(artists.map(([name, count]) => [name, { key: name, name, count }])),
    displayArtist,
    occurrences,
  };
}

const cases = [
  {
    name: "known artists Map wins",
    input: record([["Map Artist", 1]], "Display Artist", [{ song: { artist: "Occurrence Artist" } }]),
    primary: "Map Artist",
    missing: false,
  },
  {
    name: "known Map beats unknown high count",
    input: record([["Unknown", 99], ["Known Map Artist", 1]], "Display Artist"),
    primary: "Known Map Artist",
    missing: false,
  },
  {
    name: "displayArtist fallback",
    input: record([], "Display Artist", [{ song: { artist: "Occurrence Artist" } }]),
    primary: "Display Artist",
    missing: false,
  },
  {
    name: "unknown Map does not block displayArtist",
    input: record([["Unknown", 99]], "Display Artist", [{ song: { artist: "Occurrence Artist" } }]),
    primary: "Display Artist",
    missing: false,
  },
  {
    name: "occurrence artist fallback",
    input: record([], "Unknown", [{ song: { artist: "Unknown" } }, { song: { artist: "Occurrence Artist" } }]),
    primary: "Occurrence Artist",
    missing: false,
  },
  {
    name: "true missing",
    input: record([["Unknown", 99]], "Unknown", [{ song: { artist: "Unknown" } }]),
    primary: "待补歌手",
    missing: true,
  },
];

for (const testCase of cases) {
  const result = context.songMeta(testCase.input);
  assert.equal(result.primary, testCase.primary, testCase.name);
  assert.equal(result.missingPrimary, testCase.missing, `${testCase.name}: missingPrimary`);
}

console.log(`7D_ARTIST_FALLBACK_FOCUSED_OK tests=${cases.length} passed=${cases.length} failed=0`);
