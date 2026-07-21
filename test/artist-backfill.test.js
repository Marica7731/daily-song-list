const assert = require("node:assert/strict");
const test = require("node:test");

const {
  backfillMissingArtistsInVideos,
  createArtistBackfillContext,
  extractReliableRawArtistCredit,
} = require("../scripts/artist-backfill");
const { createSongAliasContext } = require("../scripts/song-aliases");

const aliasContext = createSongAliasContext({
  schemaVersion: 1,
  records: [
    {
      artist: "ジミーサムP",
      canonicalTitle: "Calc.",
      aliases: ["Calc.", "Calc", "Calc (Eng Ver.)", "33「Calc.」"],
      reason: "verified_same_song",
    },
  ],
});

test("extracts reliable artist credit from raw title slash rows", () => {
  const credit = extractReliableRawArtistCredit({
    title: "Calc",
    artist: "未記載",
    raw: "［05］0:26:06 Calc. / ジミーサムP",
  });

  assert.equal(credit.artist, "ジミーサムP");
});

test("backfills placeholder artist from source context and canonicalizes Calc aliases", () => {
  const result = backfillMissingArtistsInVideos(
    [
      {
        videoId: "AAAAAAAAAAA",
        songs: [
          {
            title: "33「Calc.」",
            artist: "未記載",
            seconds: 120,
            raw: "33 0:02:00 Calc. / ジミーサムP",
          },
        ],
      },
    ],
    { aliasContext, supplementalKnownSongs: [] },
  );
  const song = result[0].songs[0];

  assert.equal(song.title, "Calc.");
  assert.equal(song.artist, "ジミーサムP");
  assert.equal(song.originalArtist, "未記載");
  assert.equal(song.artistBackfill.reason, "source_context_raw_credit");
  assert.equal(result.artistBackfillStats.filledCount, 1);
});

test("backfills placeholder artist from the same canonical song corpus", () => {
  const videos = [
    {
      videoId: "BBBBBBBBBBB",
      songs: [{ title: "群像夏", artist: "Known Artist", seconds: 1 }],
    },
    {
      videoId: "CCCCCCCCCCC",
      songs: [{ title: "群像夏", artist: "未記載", seconds: 2 }],
    },
  ];
  const result = backfillMissingArtistsInVideos(videos, { supplementalKnownSongs: [] });

  assert.equal(result[1].songs[0].artist, "Known Artist");
  assert.equal(result[1].songs[0].artistBackfill.reason, "same_canonical_song_artist");
});

test("does not backfill ambiguous placeholder artist identities", () => {
  const context = createArtistBackfillContext({
    supplementalKnownSongs: [],
    corpusVideos: [
      { videoId: "DDDDDDDDDDD", songs: [{ title: "Same Title", artist: "Artist A", seconds: 1 }] },
      { videoId: "EEEEEEEEEEE", songs: [{ title: "Same Title", artist: "Artist B", seconds: 2 }] },
    ],
  });

  const result = backfillMissingArtistsInVideos(
    [{ videoId: "FFFFFFFFFFF", songs: [{ title: "Same Title", artist: "未記載", seconds: 3 }] }],
    { context },
  );

  assert.equal(result[0].songs[0].artist, "未記載");
  assert.equal(result.artistBackfillStats.filledCount, 0);
  assert.equal(result.artistBackfillStats.unresolvedCount, 1);
});

test("backfills from supplemental known songs when no corpus artist is available", () => {
  const result = backfillMissingArtistsInVideos(
    [{ videoId: "GGGGGGGGGGG", songs: [{ title: "晴るる", artist: "未記載", seconds: 1 }] }],
    { supplementalKnownSongs: [{ title: "晴るる", artist: "あたらよ" }] },
  );

  assert.equal(result[0].songs[0].artist, "あたらよ");
  assert.equal(result[0].songs[0].artistBackfill.reason, "supplemental_known_song");
});
