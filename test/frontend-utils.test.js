const assert = require("node:assert/strict");
const test = require("node:test");

const {
  annotatePayloadWithNiche,
  buildSourcePreview,
  createSnapshotLoader,
  createSongSearchLookup,
  filterItemsBySearch,
  filterItemsByNiche,
  filterOccurrencesBySearch,
  filterOccurrencesByNiche,
  isSongSearchKnown,
  normalizeSearch,
  normalizeSongSearchText,
  paginateItems,
} = require("../assets/frontend-utils");

test("snapshot request race keeps the latest response", async () => {
  const deferred = {
    old: createDeferred(),
    next: createDeferred(),
  };
  const applied = [];
  const loader = createSnapshotLoader({
    readJson: (path) => deferred[path].promise,
    onSuccess: ({ path, payload }) => applied.push({ path, payload }),
  });

  const oldRequest = loader.loadSnapshot({ path: "old", previousPath: "current" });
  const nextRequest = loader.loadSnapshot({ path: "next", previousPath: "current" });
  deferred.old.resolve({ generatedAt: "old" });
  deferred.next.resolve({ generatedAt: "next" });

  assert.equal((await oldRequest).status, "stale");
  assert.equal((await nextRequest).status, "success");
  assert.deepEqual(applied, [{ path: "next", payload: { generatedAt: "next" } }]);
});

test("snapshot failure preserves previous path through failure callback", async () => {
  let failure = null;
  const loader = createSnapshotLoader({
    readJson: async () => {
      throw new Error("HTTP 404");
    },
    onFailure: (event) => {
      failure = event;
    },
  });

  const result = await loader.loadSnapshot({ path: "missing", previousPath: "data/latest.json" });

  assert.equal(result.status, "failure");
  assert.equal(failure.path, "missing");
  assert.equal(failure.previousPath, "data/latest.json");
  assert.equal(failure.error.message, "HTTP 404");
});

test("search clear and filtering use title, artist, channel, and video title", () => {
  const items = [
    video("A", "歌枠 archive", "AZKi Channel", [
      song("First Good-Bye", "梶浦由記"),
      song("you", "癒月"),
    ]),
    video("B", "雑談", "talk channel", [song("雑談", "")]),
  ];
  const occurrences = items.flatMap((item) => item.songs.map((song) => ({ item, song })));

  assert.deepEqual(
    filterItemsBySearch(items, "azki").map((item) => item.videoId),
    ["A"],
  );
  assert.deepEqual(
    filterItemsBySearch(items, "first").map((item) => item.videoId),
    ["A"],
  );
  assert.deepEqual(
    filterOccurrencesBySearch(occurrences, "癒月").map(({ song }) => song.title),
    ["you"],
  );
  assert.equal(filterItemsBySearch(items, normalizeSearch("")).length, 2);
  assert.equal(filterOccurrencesBySearch(occurrences, "").length, 3);
});

test("source preview prioritizes different channels before duplicates", () => {
  const preview = buildSourcePreview(
    [
      occurrence("A", "shared channel"),
      occurrence("B", "shared channel"),
      occurrence("C", "other channel"),
      occurrence("D", "third channel"),
    ],
    { limit: 2 },
  );

  assert.deepEqual(
    preview.preview.map(({ item }) => item.videoId),
    ["A", "C"],
  );
  assert.equal(preview.hiddenCount, 2);
  assert.equal(preview.total, 4);
});

test("source preview fills open slots with duplicate-channel occurrences", () => {
  const preview = buildSourcePreview([occurrence("A", "shared channel"), occurrence("B", "shared channel")], {
    limit: 2,
  });

  assert.deepEqual(
    preview.preview.map(({ item }) => item.videoId),
    ["A", "B"],
  );
  assert.equal(preview.hiddenCount, 0);
});

test("pagination clamps pages and returns stable page metadata", () => {
  const page = paginateItems([1, 2, 3, 4, 5], { page: 9, pageSize: 2 });

  assert.deepEqual(page.visible, [5]);
  assert.equal(page.page, 3);
  assert.equal(page.pageCount, 3);
  assert.equal(page.startIndex, 4);
  assert.equal(page.endIndex, 5);
});

test("song-search lookup annotates and filters niche songs", () => {
  const lookup = createSongSearchLookup({
    titleKeys: [normalizeSongSearchText("known song")],
    titleArtistKeys: [normalizeSongSearchText("exact song") + "::" + normalizeSongSearchText("exact artist")],
  });
  const payload = {
    groups: {
      "72h": {
        items: [
          video("A", "video A", "channel A", [
            song("known song", "other artist"),
            song("exact song", "exact artist"),
            song("rare song", "rare artist"),
          ]),
        ],
      },
    },
  };

  assert.equal(isSongSearchKnown(song("known song", "other artist"), lookup), true);
  assert.equal(isSongSearchKnown(song("rare song", "rare artist"), lookup), false);

  const annotated = annotatePayloadWithNiche(payload, lookup);
  const songs = annotated.groups["72h"].items[0].songs;
  assert.deepEqual(
    songs.map((item) => item.isNiche),
    [false, false, true],
  );
  assert.equal(filterItemsByNiche(annotated.groups["72h"].items, true).length, 1);
  assert.deepEqual(
    filterOccurrencesByNiche(
      annotated.groups["72h"].items[0].songs.map((item) => ({ item: annotated.groups["72h"].items[0], song: item })),
      true,
    ).map(({ song }) => song.title),
    ["rare song"],
  );
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function video(videoId, title, channelName, songs) {
  return {
    videoId,
    title,
    channelName,
    keyword: "歌枠",
    songs,
  };
}

function song(title, artist) {
  return {
    title,
    artist,
    seconds: 60,
    time: "0:01:00",
  };
}

function occurrence(videoId, channelName) {
  return {
    item: {
      videoId,
      title: `video ${videoId}`,
      channelName,
    },
    song: song("song", "artist"),
  };
}
