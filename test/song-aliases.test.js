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

test("canonicalizes reviewed page title variants without merging different songs", () => {
  const context = createSongAliasContext({
    schemaVersion: 1,
    records: [
      {
        artist: "ヨルシカ",
        canonicalTitle: "晴る",
        aliases: ["晴る [Sunny]", "晴る [Piano ver.]", "晴る\tヨルシカ"],
        reason: "verified_same_song",
      },
      {
        artist: "緑黄色社会",
        canonicalTitle: "花になって",
        aliases: ["花になって - Be a flower", "Be a Flower/Hana ni Natte (花になって)"],
        reason: "verified_same_song",
      },
      {
        artist: "tuki.",
        canonicalTitle: "晩餐歌",
        aliases: ["晩餐歌 (Bansanka)", "『晩餐歌』Tuki"],
        reason: "verified_same_song",
      },
    ],
  });

  assert.equal(canonicalizeSongIdentity({ title: "晴る [Sunny]", artist: "ヨルシカ" }, context).title, "晴る");
  assert.equal(canonicalizeSongIdentity({ title: "花になって - Be a flower", artist: "緑黄色社会" }, context).title, "花になって");
  assert.equal(canonicalizeSongIdentity({ title: "晩餐歌 (Bansanka)", artist: "tuki." }, context).title, "晩餐歌");
  assert.equal(canonicalizeSongIdentity({ title: "雨晴るる", artist: "ヨルシカ" }, context).title, "雨晴るる");
  assert.equal(canonicalizeSongIdentity({ title: "晴るる", artist: "あたらよ" }, context).title, "晴るる");
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
