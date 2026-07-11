const assert = require("node:assert/strict");
const test = require("node:test");

const {
  annotatePayloadWithNiche,
  buildIndexBucketModel,
  buildInlineSourceModel,
  buildSourcePreview,
  createSnapshotLoader,
  createSongSearchLookup,
  filterItemsBySearch,
  filterItemsByNiche,
  filterOccurrencesBySearch,
  filterOccurrencesByNiche,
  isSongSearchKnown,
  indexBucketButtonModel,
  normalizeSearch,
  normalizeSongSearchText,
  paginateItems,
  parseUrlState,
  rankToggleModel,
  serializeUrlState,
  visiblePageTokens,
  youtubeChannelLink,
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

test("source preview omits duplicate-channel occurrences from inline preview", () => {
  const preview = buildSourcePreview([occurrence("A", "shared channel"), occurrence("B", "shared channel")], {
    limit: 2,
  });

  assert.deepEqual(
    preview.preview.map(({ item }) => item.videoId),
    ["A"],
  );
  assert.equal(preview.hiddenCount, 1);
  assert.equal(preview.total, 2);
});

test("source preview defaults to one inline source and counts hidden sources", () => {
  const preview = buildSourcePreview([
    occurrence("A", "shared channel"),
    occurrence("B", "other channel"),
    occurrence("C", "third channel"),
  ]);

  assert.deepEqual(
    preview.preview.map(({ item }) => item.videoId),
    ["A"],
  );
  assert.equal(preview.hiddenCount, 2);
  assert.equal(preview.total, 3);

  const single = buildSourcePreview([occurrence("A", "only channel")]);
  assert.deepEqual(
    single.preview.map(({ item }) => item.videoId),
    ["A"],
  );
  assert.equal(single.hiddenCount, 0);
  assert.equal(single.total, 1);
});

test("artist rank toggle uses unique song count", () => {
  const collapsed = rankToggleModel({ mode: "artist", isExpanded: false, songCount: 5, hiddenCount: 12 });
  assert.equal(collapsed.text, "查看5首");
  assert.equal(collapsed.ariaLabel, "查看该歌手的 5 首歌曲");

  const expanded = rankToggleModel({ mode: "artist", isExpanded: true, songCount: 5 });
  assert.equal(expanded.text, "收起曲目");
  assert.equal(expanded.ariaLabel, "收起该歌手曲目");
});

test("song rank toggle uses hidden source count", () => {
  const collapsed = rankToggleModel({ mode: "song", isExpanded: false, hiddenCount: 3, songCount: 1 });
  assert.equal(collapsed.text, "+3 来源");
  assert.equal(collapsed.ariaLabel, "查看该歌曲的全部来源");

  const expanded = rankToggleModel({ mode: "song", isExpanded: true, hiddenCount: 3 });
  assert.equal(expanded.text, "收起来源");
  assert.equal(expanded.ariaLabel, "收起该歌曲来源");
});

test("inline source timestamp link points to YouTube watch time", () => {
  const model = buildInlineSourceModel(occurrence("VideoA", "Channel A", { seconds: 75, time: "1:15" }));

  assert.equal(model.time.href, "https://www.youtube.com/watch?v=VideoA&t=75s");
  assert.equal(model.time.text, "1:15");
  assert.equal(model.time.ariaLabel, "打开视频时间戳：1:15");
});

test("channel link uses handle, channelId, and search fallback", () => {
  assert.equal(
    youtubeChannelLink({ channelHandle: "/@handle", channelId: "UCID", channelName: "Handle Channel" }).href,
    "https://www.youtube.com/@handle",
  );
  assert.equal(
    youtubeChannelLink({ channelId: "UCID", channelName: "Id Channel" }).href,
    "https://www.youtube.com/channel/UCID",
  );
  assert.equal(
    youtubeChannelLink({ channelUrl: "https://www.youtube.com/@DirectHandle", channelName: "Direct Channel" }).href,
    "https://www.youtube.com/@DirectHandle",
  );
  assert.deepEqual(youtubeChannelLink({ channelName: "Search Channel" }), {
    href: "https://www.youtube.com/results?search_query=Search%20Channel",
    isFallbackSearch: true,
  });
});

test("index bucket button model uses button class and aria-pressed", () => {
  const current = indexBucketButtonModel("あ", "あ", true);
  assert.equal(current.className, "index-bucket is-current");
  assert.equal(current.type, "button");
  assert.deepEqual(current.dataset, { indexBucket: "あ" });
  assert.equal(current.ariaPressed, "true");
  assert.equal(current.ariaCurrent, "page");

  const other = indexBucketButtonModel("か", "か", false);
  assert.equal(other.className, "index-bucket");
  assert.equal(other.ariaPressed, "false");
  assert.equal(other.ariaCurrent, "");
});

test("pagination uses pageSize 50 and clamps pages to available bounds", () => {
  const items = Array.from({ length: 121 }, (_, index) => index + 1);
  const page = paginateItems(items, { page: 2, pageSize: 50 });

  assert.deepEqual(page.visible, Array.from({ length: 50 }, (_, index) => index + 51));
  assert.equal(page.visibleCount, 50);
  assert.equal(page.total, 121);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 50);
  assert.equal(page.pageCount, 3);
  assert.equal(page.startIndex, 50);
  assert.equal(page.endIndex, 100);

  const overrun = paginateItems(items, { page: 99, pageSize: 50 });

  assert.deepEqual(overrun.visible, Array.from({ length: 21 }, (_, index) => index + 101));
  assert.equal(overrun.page, 3);
  assert.equal(overrun.startIndex, 100);
  assert.equal(overrun.endIndex, 121);

  const underrun = paginateItems(items, { page: -1, pageSize: 50 });

  assert.deepEqual(underrun.visible.slice(0, 3), [1, 2, 3]);
  assert.equal(underrun.page, 1);
});

test("visible page tokens include ellipses for every numeric gap", () => {
  const cases = [
    { current: 1, total: 10, expected: [1, 2, 3, 4, 5, "ellipsis", 10] },
    { current: 6, total: 12, expected: [1, "ellipsis", 5, 6, 7, "ellipsis", 12] },
    { current: 12, total: 12, expected: [1, "ellipsis", 8, 9, 10, 11, 12] },
    { current: 5, total: 7, expected: [1, 2, 3, 4, 5, 6, 7] },
  ];

  for (const { current, total, expected } of cases) {
    const tokens = visiblePageTokens(current, total);
    assert.deepEqual(tokens, expected);
    assertNoNumericJumpWithoutEllipsis(tokens);
  }
});

test("url state parses and serializes range, view, page, pageSize, bucket, outside, q, and snapshot", () => {
  const options = urlStateOptions();
  const parsed = parseUrlState(
    "?range=1m&view=songAz&page=3&pageSize=100&bucket=%E3%81%82&outside=1&q=First%20Good-Bye&snapshot=archive-20260710",
    options,
  );

  assert.deepEqual(parsed, {
    range: "1m",
    view: "songAz",
    page: 3,
    pageSize: 100,
    bucket: "あ",
    outside: true,
    q: "First Good-Bye",
    snapshotPath: "data/snapshots/2026-07-10.json",
  });

  const serialized = serializeUrlState(parsed, options);

  assert.deepEqual(Object.fromEntries(new URLSearchParams(serialized)), {
    range: "1m",
    view: "songAz",
    page: "3",
    pageSize: "100",
    bucket: "あ",
    outside: "1",
    q: "First Good-Bye",
    snapshot: "archive-20260710",
  });
  assert.deepEqual(parseUrlState(serialized, options), parsed);
});

test("url state falls back to safe defaults and only accepts configured snapshots", () => {
  const options = urlStateOptions();
  const parsed = parseUrlState(
    `?range=week&view=grid&page=0&pageSize=999&outside=no&q=${"x".repeat(
      250,
    )}&snapshot=data/snapshots/not-listed.json`,
    options,
  );

  assert.equal(parsed.range, "72h");
  assert.equal(parsed.view, "songRank");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.bucket, "全部");
  assert.equal(parsed.outside, false);
  assert.equal(parsed.q, "x".repeat(200));
  assert.equal(parsed.snapshotPath, "data/latest.json");

  const legacyOutside = parseUrlState("?libraryOutside=true&snapshot=data/snapshots/2026-07-10.json", options);

  assert.equal(legacyOutside.outside, true);
  assert.equal(legacyOutside.snapshotPath, "data/snapshots/2026-07-10.json");

  const unknownSnapshot = new URLSearchParams(
    serializeUrlState(
      {
        range: "72h",
        view: "songRank",
        page: 1,
        pageSize: 50,
        bucket: "全部",
        outside: false,
        q: "",
        snapshotPath: "data/snapshots/not-listed.json",
      },
      options,
    ),
  );

  assert.equal(unknownSnapshot.has("snapshot"), false);
});

test("song index bucket model uses all records and falls back when the current bucket disappears", () => {
  const records = [
    ...Array.from({ length: 50 }, (_, index) => indexRecord(`a-${index}`, "A")),
    indexRecord("b-1", "B"),
    indexRecord("c-1", "C"),
  ];
  const currentPage = paginateItems(records, { page: 1, pageSize: 50 }).visible;

  assert.deepEqual([...new Set(currentPage.map((record) => record.bucket))], ["A"]);

  const model = buildIndexBucketModel(records, {
    bucket: "C",
    getBucketLabel: (record) => record.bucket,
    compareBuckets: compareBucketFixtures,
  });

  assert.deepEqual(
    model.buckets.map((bucket) => [bucket.label, bucket.records.length]),
    [
      ["A", 50],
      ["B", 1],
      ["C", 1],
    ],
  );
  assert.equal(model.currentBucket, "C");
  assert.deepEqual(
    model.records.map((record) => record.id),
    ["c-1"],
  );

  const afterBucketDisappears = buildIndexBucketModel(
    records.filter((record) => record.bucket !== "C"),
    {
      bucket: "C",
      getBucketLabel: (record) => record.bucket,
      compareBuckets: compareBucketFixtures,
    },
  );

  assert.equal(afterBucketDisappears.currentBucket, "全部");
  assert.equal(afterBucketDisappears.records.length, 51);
});

test("outside-library filters keep songs marked outside the known index", () => {
  const items = [
    video("A", "mixed video", "channel A", [
      song("known song", "artist", { isNiche: false }),
      song("outside song", "artist", { isNiche: true }),
    ]),
    video("B", "legacy video", "channel B", [song("legacy outside", "artist", { niche: true })]),
    video("C", "known video", "channel C", [song("known only", "artist", { isNiche: false })]),
  ];
  const occurrences = items.flatMap((item) => item.songs.map((song) => ({ item, song })));

  assert.deepEqual(
    filterItemsByNiche(items, true).map((item) => item.videoId),
    ["A", "B"],
  );
  assert.deepEqual(
    filterOccurrencesByNiche(occurrences, true).map(({ song }) => song.title),
    ["outside song", "legacy outside"],
  );
  assert.equal(filterItemsByNiche(items, false), items);
  assert.equal(filterOccurrencesByNiche(occurrences, false), occurrences);
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
            song("known song", "other artist", { isNiche: true }),
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

test("song-search lookup tolerates list markers and artist text leaked into titles", () => {
  const lookup = createSongSearchLookup({
    titleKeys: [normalizeSongSearchText("少女レイ"), normalizeSongSearchText("鬼ノ宴")],
    titleArtistKeys: [
      normalizeSongSearchText("少女レイ") + "::" + normalizeSongSearchText("みきとP"),
      normalizeSongSearchText("鬼ノ宴") + "::" + normalizeSongSearchText("友成空"),
    ],
  });

  assert.equal(isSongSearchKnown(song("少女レイ\tみきとP", "未記載"), lookup), true);
  assert.equal(isSongSearchKnown(song("⑪少女レイ", "みきとP"), lookup), true);
  assert.equal(isSongSearchKnown(song("「鬼ノ宴」友成空", "未記載"), lookup), true);
  assert.equal(isSongSearchKnown(song("unknown song\tみきとP", "未記載"), lookup), false);

  const payload = {
    groups: {
      "72h": {
        items: [
          video("A", "video A", "channel A", [
            song("「鬼ノ宴」友成空", "未記載", { isNiche: true }),
            song("unknown song\tみきとP", "未記載", { isNiche: false }),
          ]),
        ],
      },
    },
  };
  const annotated = annotatePayloadWithNiche(payload, lookup);

  assert.deepEqual(
    annotated.groups["72h"].items[0].songs.map((item) => item.isNiche),
    [false, true],
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

function assertNoNumericJumpWithoutEllipsis(tokens) {
  let previousNumber = null;
  let previousToken = null;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (previousNumber !== null && token - previousNumber > 1) {
        assert.equal(previousToken, "ellipsis", `missing ellipsis between ${previousNumber} and ${token}`);
      }
      previousNumber = token;
    }
    previousToken = token;
  }
}

function urlStateOptions() {
  return {
    validRanges: ["72h", "1m"],
    validViews: ["songRank", "artistRank", "songAz", "videos"],
    validPageSizes: [50, 100, 200],
    latestSnapshotPath: "data/latest.json",
    snapshots: [
      { id: "archive-20260710", path: "data/snapshots/2026-07-10.json" },
      { id: "archive-20260711", path: "data/snapshots/2026-07-11.json" },
    ],
    defaults: {
      range: "72h",
      view: "songRank",
      page: 1,
      pageSize: 50,
      bucket: "全部",
      outside: false,
      q: "",
    },
  };
}

function indexRecord(id, bucket) {
  return { id, bucket };
}

function compareBucketFixtures(a, b) {
  return a.label.localeCompare(b.label, "en");
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

function song(title, artist, overrides = {}) {
  return {
    title,
    artist,
    seconds: 60,
    time: "0:01:00",
    ...overrides,
  };
}

function occurrence(videoId, channelName, songOverrides = {}, itemOverrides = {}) {
  return {
    item: {
      videoId,
      title: `video ${videoId}`,
      channelName,
      ...itemOverrides,
    },
    song: song("song", "artist", songOverrides),
  };
}
