const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalizePayloadSongAliases,
  canonicalizeSongIdentity,
  createSongAliasContext,
  validateSongAliasConfig,
} = require("../scripts/song-aliases");

function kakurenboContext() {
  return createSongAliasContext({
    schemaVersion: 1,
    records: [
      {
        artist: "AliA",
        canonicalTitle: "かくれんぼ",
        aliases: ["Kakurenbo", "かくれんぼ"],
        reason: "verified_same_song",
      },
    ],
  });
}

test("canonicalizes configured aliases only for the same artist", () => {
  const context = kakurenboContext();

  const alia = canonicalizeSongIdentity({ title: "Kakurenbo", artist: "AliA" }, context);
  const otherArtist = canonicalizeSongIdentity({ title: "Kakurenbo", artist: "Other Artist" }, context);

  assert.equal(alia.title, "かくれんぼ");
  assert.equal(alia.artist, "AliA");
  assert.equal(alia.originalTitle, "Kakurenbo");
  assert.equal(alia.alias.changed, true);
  assert.equal(otherArtist.title, "Kakurenbo");
});

test("canonicalizes aliases across payload groups and exposes alias summary", () => {
  const payload = canonicalizePayloadSongAliases(
    {
      groups: {
        "72h": {
          items: [{ videoId: "AAAAAAAAAAA", songs: [{ title: "Kakurenbo", artist: "AliA", seconds: 1, time: "0:00:01" }] }],
        },
      },
      source: {},
    },
    kakurenboContext(),
  );

  assert.equal(payload.groups["72h"].items[0].songs[0].title, "かくれんぼ");
  assert.equal(payload.source.songAliases.recordCount, 1);
  assert.match(payload.aliasVersion, /^song-aliases-v1:/);
});

test("validates alias config shape", () => {
  const validation = validateSongAliasConfig({ schemaVersion: 1, records: [{ artist: "AliA", canonicalTitle: "かくれんぼ" }] });

  assert.deepEqual(validation.errors, ["records[0].aliases must be array"]);
});
