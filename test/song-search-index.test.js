const assert = require("node:assert/strict");
const test = require("node:test");

const {
  annotatePayloadWithSongSearchNiche,
  buildSongSearchIndex,
  fetchSongSearchIndex,
  mergeSupplementalKnownSongs,
  parseSongSearchDataFile,
} = require("../scripts/song-search-index");
const { createSongAliasContext } = require("../scripts/song-aliases");

test("parses song-search data files without executing remote code", () => {
  const entries = parseSongSearchDataFile(
    `
      window.SONG_DATA = window.SONG_DATA || [];
      window.SONG_DATA.push(
        {
          "title": "Known Song",
          "artist": "Known Artist",
          "collection": "A",
          "source": "sample.js"
        },
        {
          "title": "Another Song",
          "artist": "",
          "collection": "B",
          "source": "sample.js"
        }
      );
    `,
    "sample.js",
  );

  assert.deepEqual(
    entries.map((entry) => [entry.title, entry.artist]),
    [
      ["Known Song", "Known Artist"],
      ["Another Song", ""],
    ],
  );
});

test("builds title and title-artist keys for niche annotation", () => {
  const index = buildSongSearchIndex(
    [
      { title: "Known Song", artist: "Known Artist", sources: new Set(["a.js"]) },
      { title: "Known Song", artist: "Other Artist", sources: new Set(["b.js"]) },
      { title: "No Artist Song", artist: "", sources: new Set(["c.js"]) },
    ],
    { generatedAt: "2026-07-11T00:00:00.000Z", files: ["a.js", "b.js", "c.js"] },
  );

  assert.equal(index.fileCount, 3);
  assert.equal(index.recordCount, 3);
  assert.equal(index.titleKeyCount, 2);
  assert.equal(index.titleArtistKeyCount, 2);
  assert.equal(index.titleKeys.includes("knownsong"), true);
  assert.equal(index.titleArtistKeys.includes("knownsong::knownartist"), true);
});

test("annotates payload songs as niche when they are absent from song-search", () => {
  const index = buildSongSearchIndex([{ title: "Known Song", artist: "Known Artist" }], {
    generatedAt: "2026-07-11T00:00:00.000Z",
    files: ["known.js"],
  });
  const payload = {
    groups: {
      "72h": {
        items: [
          {
            videoId: "AAAAAAAAAAA",
            songs: [
              { title: "Known Song", artist: "Known Artist", seconds: 1, time: "0:00:01" },
              { title: "Rare Song", artist: "Rare Artist", seconds: 2, time: "0:00:02" },
            ],
          },
        ],
      },
    },
  };

  const annotated = annotatePayloadWithSongSearchNiche(payload, index);

  assert.deepEqual(
    annotated.groups["72h"].items[0].songs.map((song) => song.isNiche),
    [false, true],
  );
});

test("merges supplemental known song overrides into niche annotation", () => {
  const index = mergeSupplementalKnownSongs(
    buildSongSearchIndex([{ title: "Known Song", artist: "Known Artist" }], {
      generatedAt: "2026-07-11T00:00:00.000Z",
      files: ["known.js"],
    }),
    [{ title: "高鳴る", artist: "藤田麻衣子", reason: "manual_known_song_confirmation" }],
  );
  const payload = {
    groups: {
      "1m": {
        items: [
          {
            videoId: "DDDDDDDDDDD",
            songs: [
              { title: "高鳴る", artist: "藤田麻衣子", seconds: 1, time: "0:00:01" },
              { title: "高鳴る", artist: "未記載", seconds: 2, time: "0:00:02" },
            ],
          },
        ],
      },
    },
  };

  const annotated = annotatePayloadWithSongSearchNiche(payload, index);

  assert.equal(index.supplementalKnownSongCount, 1);
  assert.deepEqual(
    annotated.groups["1m"].items[0].songs.map((song) => song.isNiche),
    [false, false],
  );
});

test("annotates noisy title matches as known song-search entries", () => {
  const index = buildSongSearchIndex(
    [
      { title: "少女レイ", artist: "みきとP" },
      { title: "鬼ノ宴", artist: "友成空" },
    ],
    {
      generatedAt: "2026-07-11T00:00:00.000Z",
      files: ["known.js"],
    },
  );
  const payload = {
    groups: {
      "72h": {
        items: [
          {
            videoId: "BBBBBBBBBBB",
            songs: [
              { title: "少女レイ\tみきとP", artist: "未記載", seconds: 1, time: "0:00:01" },
              { title: "⑪少女レイ", artist: "みきとP", seconds: 2, time: "0:00:02" },
              { title: "「鬼ノ宴」友成空", artist: "未記載", seconds: 3, time: "0:00:03" },
              { title: "unknown song\tみきとP", artist: "未記載", seconds: 4, time: "0:00:04" },
            ],
          },
        ],
      },
    },
  };

  const annotated = annotatePayloadWithSongSearchNiche(payload, index);

  assert.deepEqual(
    annotated.groups["72h"].items[0].songs.map((song) => song.isNiche),
    [false, false, false, true],
  );
});

test("canonicalizes configured aliases before niche annotation", () => {
  const index = buildSongSearchIndex([{ title: "かくれんぼ", artist: "AliA" }], {
    generatedAt: "2026-07-11T00:00:00.000Z",
    files: ["known.js"],
  });
  const aliasContext = createSongAliasContext({
    schemaVersion: 1,
    records: [{ artist: "AliA", canonicalTitle: "かくれんぼ", aliases: ["Kakurenbo", "かくれんぼ"] }],
  });
  const payload = {
    groups: {
      "72h": {
        items: [
          {
            videoId: "CCCCCCCCCCC",
            songs: [{ title: "Kakurenbo", artist: "AliA", seconds: 1, time: "0:00:01" }],
          },
        ],
      },
    },
  };

  const annotated = annotatePayloadWithSongSearchNiche(payload, index, aliasContext);
  const song = annotated.groups["72h"].items[0].songs[0];

  assert.equal(song.title, "かくれんぼ");
  assert.equal(song.originalTitle, "Kakurenbo");
  assert.equal(song.isNiche, false);
});

test("fetches manifest files with fallback and skips missing files", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/data/index.json")) {
      return jsonResponse({
        files: ["good.js", "missing.js"],
      });
    }
    if (url.endsWith("/data/good.js")) {
      return textResponse(`
        window.SONG_DATA = window.SONG_DATA || [];
        window.SONG_DATA.push({
          "title": "Known Song",
          "artist": "Known Artist",
          "source": "good.js"
        });
      `);
    }
    return {
      ok: false,
      status: 404,
    };
  };

  const index = await fetchSongSearchIndex({
    fetchImpl,
    now: new Date("2026-07-11T00:00:00.000Z"),
    concurrency: 1,
  });

  assert.equal(index.manifestFileCount, 2);
  assert.equal(index.fileCount, 1);
  assert.equal(index.skippedFileCount, 1);
  assert.equal(index.skippedFiles[0].file, "missing.js");
  assert.equal(index.titleKeys.includes("knownsong"), true);
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  };
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    text: async () => value,
  };
}
