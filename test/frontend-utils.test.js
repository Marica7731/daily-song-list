const assert = require("node:assert/strict");
const test = require("node:test");

const {
  annotatePayloadWithNiche,
  activeQueryConditionCount,
  buildSetlistText,
  buildSongSourceLinksText,
  buildIndexBucketModel,
  buildInlineSourceModel,
  buildSourcePreview,
  compactSourceToggleModel,
  createSnapshotLoader,
  createSongSearchLookup,
  createTrendLookup,
  desktopPageTokens,
  defaultQueryDraft,
  filterItemsBySearch,
  filterItemsByNiche,
  filterOccurrencesBySearch,
  filterOccurrencesByNiche,
  formatSetlistTime,
  formatSeconds,
  groupOccurrencesByVideo,
  isSongSearchKnown,
  indexBucketButtonModel,
  makeQueryDraftFromState,
  mobilePageModel,
  mobilePageStepperModel,
  normalizeSearch,
  normalizeSetlistSongs,
  normalizeSongSearchText,
  paginateItems,
  parseUrlState,
  queryTriggerModel,
  rankToggleModel,
  runtimeRangePayloadFromGroup,
  runtimeRangePath,
  serializeUrlState,
  sanitizeQueryDraft,
  shouldPrefetchRuntimeRange,
  shouldSkipSourceFilter,
  sourcePresentationModel,
  summaryVideoCountModel,
  trendDisplayModel,
  validateRuntimeRangePayload,
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
  assert.equal(collapsed.text, "5首曲目");
  assert.equal(collapsed.ariaLabel, "查看该歌手的 5 首歌曲");

  const compact = rankToggleModel({ mode: "artist", isExpanded: false, songCount: 5, compact: true });
  assert.equal(compact.text, "5首曲目");
  assert.equal(compact.ariaLabel, "查看该歌手的 5 首歌曲");

  const expanded = rankToggleModel({ mode: "artist", isExpanded: true, songCount: 5 });
  assert.equal(expanded.text, "收起");
  assert.equal(expanded.ariaLabel, "收起该歌手曲目");
});

test("song rank toggle uses video and timestamp counts", () => {
  const multiVideo = rankToggleModel({ mode: "song", isExpanded: false, videoCount: 3, occurrenceCount: 8 });
  assert.equal(multiVideo.text, "3个来源");
  assert.equal(multiVideo.ariaLabel, "查看该歌曲的 3 个来源视频");

  const sameVideo = rankToggleModel({ mode: "song", isExpanded: false, videoCount: 1, occurrenceCount: 4 });
  assert.equal(sameVideo.text, "4个时间点");
  assert.equal(sameVideo.ariaLabel, "查看该歌曲的 4 个时间点");

  const compact = rankToggleModel({ mode: "song", isExpanded: false, rankMetric: "occurrences", rankCount: 9, videoCount: 3, occurrenceCount: 8, compact: true });
  assert.equal(compact.text, "3个来源");
  assert.equal(compact.ariaLabel, "查看该歌曲的 3 个来源视频");

  const sameVideoCompact = rankToggleModel({ mode: "song", isExpanded: false, videoCount: 1, occurrenceCount: 4, compact: true });
  assert.equal(sameVideoCompact.text, "4个时间点");
  assert.equal(sameVideoCompact.ariaLabel, "查看该歌曲的 4 个时间点");

  const expanded = rankToggleModel({ mode: "song", isExpanded: true, hiddenCount: 3 });
  assert.equal(expanded.text, "收起");
  assert.equal(expanded.ariaLabel, "收起该歌曲来源");
});

test("compact source toggle model removes repeated rank counts", () => {
  assert.deepEqual(
    compactSourceToggleModel({
      isExpanded: false,
      rankMetric: "occurrences",
      rankCount: 36,
      videoCount: 36,
      occurrenceCount: 36,
    }),
    { text: "来源", kind: "source" },
  );
  assert.deepEqual(
    compactSourceToggleModel({
      isExpanded: false,
      rankMetric: "occurrences",
      rankCount: 27,
      videoCount: 25,
      occurrenceCount: 27,
    }),
    { text: "25个来源", kind: "source" },
  );
  assert.deepEqual(
    compactSourceToggleModel({
      isExpanded: false,
      rankMetric: "videos",
      rankCount: 25,
      videoCount: 25,
      occurrenceCount: 27,
    }),
    { text: "来源", kind: "source" },
  );
  assert.deepEqual(
    compactSourceToggleModel({
      isExpanded: false,
      rankMetric: "occurrences",
      rankCount: 3,
      videoCount: 1,
      occurrenceCount: 3,
    }),
    { text: "3个时间点", kind: "time" },
  );
  assert.deepEqual(compactSourceToggleModel({ isExpanded: true, videoCount: 25, occurrenceCount: 27 }), { text: "收起", kind: "expanded" });
});

test("trend display model uses compact semantic Chinese labels", () => {
  assert.equal(trendDisplayModel(null), null);
  assert.deepEqual(trendDisplayModel({ isNew: true, rankDelta: 12, countDelta: 3 }), {
    text: "新",
    kind: "new",
    title: "本期新进入榜单",
    ariaLabel: "本期新进入榜单",
  });
  assert.deepEqual(trendDisplayModel({ rankDelta: 3, countDelta: 2 }), {
    text: "升3",
    kind: "up",
    title: "排名上升 3 名，收录增加 2 次",
    ariaLabel: "排名上升 3 名，收录增加 2 次",
  });
  assert.deepEqual(trendDisplayModel({ rankDelta: -4, countDelta: -1 }), {
    text: "降4",
    kind: "down",
    title: "排名下降 4 名，收录减少 1 次",
    ariaLabel: "排名下降 4 名，收录减少 1 次",
  });
  assert.deepEqual(trendDisplayModel({ rankDelta: 0, countDelta: 5 }), {
    text: "增5",
    kind: "increase",
    title: "收录增加 5 次",
    ariaLabel: "收录增加 5 次",
  });
  assert.deepEqual(trendDisplayModel({ rankDelta: 0, countDelta: -2 }), {
    text: "减2",
    kind: "decrease",
    title: "收录减少 2 次",
    ariaLabel: "收录减少 2 次",
  });
  assert.equal(trendDisplayModel({ rankDelta: 0, countDelta: 0 }), null);
});

test("groups source occurrences by video with sorted timestamps", () => {
  const groups = groupOccurrencesByVideo([
    occurrence("B", "channel B", { seconds: 30, title: "song" }),
    occurrence("A", "channel A", { seconds: 90, title: "song" }),
    occurrence("A", "channel A", { seconds: 12, title: "song" }),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.videoId, group.occurrences.map(({ song }) => song.seconds)]),
    [
      ["A", [12, 90]],
      ["B", [30]],
    ],
  );
});

test("builds whole-video setlist text from original songs", () => {
  const item = {
    _allSongs: [
      { seconds: 352, title: "KING", artist: "Kanaria" },
      { seconds: 352, title: "KING", artist: "Kanaria" },
      { seconds: 12, title: "Opening", artist: "待补歌手" },
      { seconds: 4200, title: "Long Song", artist: "" },
      { seconds: 353, title: "KING", artist: "Kanaria" },
    ],
    songs: [{ seconds: 999, title: "filtered", artist: "artist" }],
  };

  assert.equal(formatSetlistTime(352), "05:52");
  assert.deepEqual(
    normalizeSetlistSongs(item._allSongs, { isUnknownArtistName: (value) => value === "待补歌手" }).map((song) => [
      song.seconds,
      song.title,
      song.artist,
    ]),
    [
      [12, "Opening", ""],
      [352, "KING", "Kanaria"],
      [353, "KING", "Kanaria"],
      [4200, "Long Song", ""],
    ],
  );
  assert.equal(
    buildSetlistText(item, { isUnknownArtistName: (value) => value === "待补歌手" }),
    ["00:12 01. Opening", "05:52 02. KING - Kanaria", "05:53 03. KING - Kanaria", "1:10:00 04. Long Song"].join("\n"),
  );
});

test("builds same-song source link text from unique source videos", () => {
  const links = buildSongSourceLinksText([
    occurrence("VideoA", "羽海乃ゆき", { seconds: 75, title: "song" }),
    occurrence("VideoA", "Channel A", { seconds: 180, title: "song" }),
    occurrence("VideoB", "こは太郎", { seconds: 12, title: "song" }),
    occurrence("VideoA", "Channel A", { seconds: 75, title: "song" }),
    occurrence("VideoC", "", { seconds: 9, title: "song" }),
    occurrence("VideoD", "中文频道", { seconds: 120, title: "song" }),
    occurrence("VideoE", "Orihime Haruka", { seconds: 121, title: "song" }),
    occurrence("", "Broken Channel", { seconds: 1, title: "song" }),
    occurrence("VideoF", "No Time Channel", { seconds: null, title: "song" }),
  ]);

  assert.equal(
    links,
    [
      "未知频道 https://www.youtube.com/watch?v=VideoC&t=9s",
      "こは太郎 https://www.youtube.com/watch?v=VideoB&t=12s",
      "羽海乃ゆき https://www.youtube.com/watch?v=VideoA&t=75s",
      "中文频道 https://www.youtube.com/watch?v=VideoD&t=120s",
      "Orihime Haruka https://www.youtube.com/watch?v=VideoE&t=121s",
    ].join("\n"),
  );
  assert.match(links, /&t=\d+s/u);
  assert.doesNotMatch(links, /No Time Channel|VideoF/u);
  assert.doesNotMatch(links, /^\d+\.|^- |\[[^\]]+\]\(/um);
  assert.equal(links.split("\n").length, 5);
  assert.equal(new Set(links.split("\n").map((line) => line.match(/watch\?v=([^&\s]+)&t=(\d+)s/u)?.[1])).size, 5);
  assert.equal(links.endsWith("\n"), false);
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

test("visible page tokens use non-clickable ellipsis markers", () => {
  const cases = [
    {
      current: 1,
      total: 68,
      options: { maxTokens: 5 },
      expected: [
        { type: "page", page: 1, current: true },
        { type: "page", page: 2, current: false },
        { type: "page", page: 3, current: false },
        { type: "ellipsis", side: "right" },
        { type: "page", page: 68, current: false },
      ],
    },
    {
      current: 8,
      total: 68,
      options: { maxTokens: 5 },
      expected: [
        { type: "page", page: 1, current: false },
        { type: "ellipsis", side: "left" },
        { type: "page", page: 8, current: true },
        { type: "ellipsis", side: "right" },
        { type: "page", page: 68, current: false },
      ],
    },
    {
      current: 8,
      total: 68,
      options: { maxTokens: 7 },
      expected: [
        { type: "page", page: 1, current: false },
        { type: "ellipsis", side: "left" },
        { type: "page", page: 7, current: false },
        { type: "page", page: 8, current: true },
        { type: "page", page: 9, current: false },
        { type: "ellipsis", side: "right" },
        { type: "page", page: 68, current: false },
      ],
    },
    {
      current: 67,
      total: 68,
      options: { maxTokens: 5 },
      expected: [
        { type: "page", page: 1, current: false },
        { type: "ellipsis", side: "left" },
        { type: "page", page: 66, current: false },
        { type: "page", page: 67, current: true },
        { type: "page", page: 68, current: false },
      ],
    },
    {
      current: 5,
      total: 7,
      options: { maxTokens: 7, jumpStep: 10 },
      expected: Array.from({ length: 7 }, (_, index) => ({ type: "page", page: index + 1, current: index + 1 === 5 })),
    },
  ];

  for (const { current, total, options, expected } of cases) {
    const tokens = visiblePageTokens(current, total, options);
    assert.deepEqual(tokens, expected);
    assert.deepEqual(desktopPageTokens(current, total, options), expected);
    assertPageTokensOrdered(tokens);
    assert.equal(tokens.filter((token) => token.type === "page" && token.current).length, 1);
  }
});

test("mobile page stepper exposes stable neighbor and arrow targets", () => {
  assert.deepEqual(mobilePageModel(7, 59), {
    currentPage: 7,
    totalPages: 59,
    pageCount: 59,
    hasPrevious: true,
    hasNext: true,
    previousPage: 6,
    previousNeighbors: [6],
    currentLabel: "7/59",
    nextNeighbors: [8],
    nextPage: 8,
  });
  assert.deepEqual(mobilePageModel(1, 59), {
    currentPage: 1,
    totalPages: 59,
    pageCount: 59,
    hasPrevious: false,
    hasNext: true,
    previousPage: null,
    previousNeighbors: [],
    currentLabel: "1/59",
    nextNeighbors: [2],
    nextPage: 2,
  });
  assert.deepEqual(mobilePageModel(99, 3), {
    currentPage: 3,
    totalPages: 3,
    pageCount: 3,
    hasPrevious: true,
    hasNext: false,
    previousPage: 2,
    previousNeighbors: [2],
    currentLabel: "3/3",
    nextNeighbors: [],
    nextPage: null,
  });
  assert.equal(mobilePageStepperModel(7, 59).previousNeighbor, 6);
  assert.equal(mobilePageStepperModel(7, 59).nextNeighbor, 8);
  assert.deepEqual(mobilePageModel(1, 1), {
    currentPage: 1,
    totalPages: 1,
    pageCount: 1,
    hasPrevious: false,
    hasNext: false,
    previousPage: null,
    previousNeighbors: [],
    currentLabel: "1/1",
    nextNeighbors: [],
    nextPage: null,
  });
});

test("source presentation model inlines up to three videos and expands only the rest", () => {
  const empty = sourcePresentationModel([]);
  assert.equal(empty.mode, "none");
  assert.equal(empty.videoCount, 0);
  assert.equal(empty.inlineGroups.length, 0);
  assert.equal(empty.canExpand, false);

  const oneVideo = sourcePresentationModel([
    occurrence("A", "channel A", { seconds: 10 }),
    occurrence("A", "channel A", { seconds: 20 }),
  ]);
  assert.equal(oneVideo.mode, "inline");
  assert.equal(oneVideo.videoCount, 1);
  assert.equal(oneVideo.occurrenceCount, 2);
  assert.equal(oneVideo.inlineGroups.length, 1);
  assert.equal(oneVideo.remainingCount, 0);
  assert.equal(oneVideo.canExpand, false);
  assert.equal(oneVideo.showCopyAll, false);

  const twoVideosWithDuplicateTimestamps = sourcePresentationModel([
    occurrence("A", "channel A", { seconds: 10 }),
    occurrence("A", "channel A", { seconds: 20 }),
    occurrence("B", "channel B", { seconds: 30 }),
  ]);
  assert.equal(twoVideosWithDuplicateTimestamps.videoCount, 2);
  assert.equal(twoVideosWithDuplicateTimestamps.occurrenceCount, 3);
  assert.deepEqual(
    twoVideosWithDuplicateTimestamps.inlineGroups.map((group) => `${group.videoId}:${group.occurrences.length}`),
    ["A:2", "B:1"],
  );
  assert.equal(twoVideosWithDuplicateTimestamps.canExpand, false);
  assert.equal(twoVideosWithDuplicateTimestamps.showCopyAll, false);

  const threeVideos = sourcePresentationModel([
    occurrence("A", "channel A"),
    occurrence("B", "channel B"),
    occurrence("C", "channel C"),
  ]);
  assert.equal(threeVideos.mode, "inline");
  assert.deepEqual(
    threeVideos.inlineGroups.map((group) => group.videoId),
    ["A", "B", "C"],
  );
  assert.equal(threeVideos.showCopyAll, true);

  const fourVideos = sourcePresentationModel([
    occurrence("A", "channel A"),
    occurrence("B", "channel B"),
    occurrence("C", "channel C"),
    occurrence("D", "channel D"),
  ]);
  assert.equal(fourVideos.mode, "collapsed");
  assert.equal(fourVideos.inlineVisibleCount, 3);
  assert.deepEqual(
    fourVideos.inlineGroups.map((group) => group.videoId),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    fourVideos.hiddenGroups.map((group) => group.videoId),
    ["D"],
  );
  assert.equal(fourVideos.remainingCount, 1);
  assert.equal(fourVideos.collapsedLabel, "+1来源");
  assert.equal(fourVideos.collapsedAriaLabel, "查看其余 1 个来源");
  assert.equal(fourVideos.expandedLabel, "收起");
  assert.equal(fourVideos.hasMore, true);
  assert.equal(fourVideos.canExpand, true);
  assert.equal(fourVideos.showCopyAll, false);

  const expanded = sourcePresentationModel(
    [
      occurrence("A", "channel A"),
      occurrence("B", "channel B"),
      occurrence("C", "channel C"),
      occurrence("D", "channel D"),
    ],
    { expanded: true },
  );
  assert.equal(expanded.mode, "expanded");
  assert.equal(expanded.inlineVisibleCount, 3);
  assert.deepEqual(
    expanded.detailGroups.map((group) => group.videoId),
    ["D"],
  );
  assert.equal(expanded.hasMore, false);
});

test("source presentation distinguishes videos from many timestamps", () => {
  const manyVideos = Array.from({ length: 114 }, (_, index) => occurrence(`V${index + 1}`, `channel ${index + 1}`, { seconds: index }));
  const model = sourcePresentationModel(manyVideos);
  assert.equal(model.videoCount, 114);
  assert.equal(model.inlineVisibleCount, 3);
  assert.equal(model.remainingCount, 111);
  assert.equal(model.collapsedLabel, "+111来源");
  assert.equal(model.collapsedAriaLabel, "查看其余 111 个来源");

  const oneVideoManyTimes = sourcePresentationModel(
    Array.from({ length: 89 }, (_, index) => occurrence("A", "channel A", { seconds: index + 1 })),
  );
  assert.equal(oneVideoManyTimes.videoCount, 1);
  assert.equal(oneVideoManyTimes.occurrenceCount, 89);
  assert.equal(oneVideoManyTimes.inlineVisibleCount, 1);
  assert.equal(oneVideoManyTimes.remainingCount, 0);
  assert.equal(oneVideoManyTimes.canExpand, false);
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
    rankMetric: "occurrences",
    videoLayout: "cards",
    outside: true,
    showUnknown: false,
    q: "First Good-Bye",
    snapshotPath: "data/snapshots/2026-07-10.json",
    trend: "all",
    minCount: 1,
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

test("url state parses trend, minCount, and legacy shared marker", () => {
  const options = urlStateOptions();
  const parsed = parseUrlState("?trend=up&minCount=5&detail=song%3Atitle%253A%253Aartist", options);

  assert.equal(parsed.trend, "up");
  assert.equal(parsed.minCount, 5);
  assert.equal(Object.hasOwn(parsed, "detail"), false);

  const serialized = serializeUrlState(
    {
      range: "72h",
      view: "songRank",
      page: 1,
      pageSize: 50,
      bucket: "全部",
      rankMetric: "occurrences",
      videoLayout: "cards",
      outside: false,
      showUnknown: false,
      q: "",
      snapshotPath: "data/latest.json",
      trend: "up",
      minCount: 5,
    },
    { ...options, includeShared: true },
  );

  assert.deepEqual(Object.fromEntries(new URLSearchParams(serialized)), {
    trend: "up",
    minCount: "5",
    shared: "1",
  });
  assert.equal(parseUrlState("?trend=sideways&minCount=999&detail=javascript:alert(1)", options).trend, "all");
  assert.equal(parseUrlState("?trend=sideways&minCount=999&detail=javascript:alert(1)", options).minCount, 1);
  assert.equal(Object.hasOwn(parseUrlState("?detail=javascript:alert(1)", options), "detail"), false);
});

test("url state uses showUnknown=1 only when unknown artists are visible", () => {
  const options = urlStateOptions();
  const parsed = parseUrlState("?showUnknown=1&outside=1", options);

  assert.equal(parsed.showUnknown, true);
  assert.equal(parsed.outside, true);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(serializeUrlState(parsed, options))), {
    outside: "1",
    showUnknown: "1",
  });

  const defaults = parseUrlState("?showUnknown=0", options);
  assert.equal(defaults.showUnknown, false);
  assert.equal(new URLSearchParams(serializeUrlState(defaults, options)).has("showUnknown"), false);
});

test("query draft derives search and every filter field from applied state", () => {
  const draft = makeQueryDraftFromState(
    {
      filter: "少女レイ",
      nicheOnly: true,
      hideUnknownArtist: false,
      rankMetric: "videos",
      trend: "up",
      minCount: 5,
      pageSize: 100,
      currentSnapshotPath: "data/latest.json",
    },
    queryDraftOptions(),
  );

  assert.deepEqual(draft, {
    q: "少女レイ",
    nicheOnly: true,
    hideUnknownArtist: false,
    rankMetric: "videos",
    trend: "up",
    minCount: 5,
    pageSize: 100,
    snapshotPath: "data/latest.json",
  });
  assert.deepEqual(defaultQueryDraft({ pageSize: 100, snapshotPath: "data/snapshots/2026-07-10.json" }), {
    q: "",
    nicheOnly: false,
    hideUnknownArtist: true,
    rankMetric: "occurrences",
    trend: "all",
    minCount: 1,
    pageSize: 100,
    snapshotPath: "data/snapshots/2026-07-10.json",
  });
});

test("query draft sanitizes snapshot trend and counts only active conditions", () => {
  const options = queryDraftOptions();
  const snapshotDraft = sanitizeQueryDraft(
    {
      q: "少女レイ",
      nicheOnly: true,
      hideUnknownArtist: false,
      rankMetric: "videos",
      trend: "up",
      minCount: 5,
      pageSize: 100,
      snapshotPath: "data/snapshots/2026-07-10.json",
    },
    options,
  );

  assert.equal(snapshotDraft.trend, "all");
  assert.equal(activeQueryConditionCount(snapshotDraft, { ...options, view: "songRank" }), 6);
  assert.equal(activeQueryConditionCount({ ...snapshotDraft, pageSize: 50 }, { ...options, view: "songRank" }), 6);
  assert.equal(activeQueryConditionCount({ ...snapshotDraft, rankMetric: "videos", minCount: 10 }, { ...options, view: "videos" }), 4);
  assert.equal(activeQueryConditionCount({ ...snapshotDraft, trend: "up", minCount: 10 }, { ...options, view: "songAz" }), 5);
  assert.equal(activeQueryConditionCount(defaultQueryDraft(), { ...options, view: "songRank" }), 0);
  assert.equal(activeQueryConditionCount({ ...defaultQueryDraft(), hideUnknownArtist: false }, { ...options, view: "songRank" }), 1);
  assert.equal(activeQueryConditionCount({ ...defaultQueryDraft(), q: "少女レイ" }, { ...options, view: "songRank" }), 1);
  assert.equal(
    activeQueryConditionCount({ ...defaultQueryDraft(), q: "少女レイ", nicheOnly: true, minCount: 2 }, { ...options, view: "songRank" }),
    3,
  );

  assert.deepEqual(queryTriggerModel(defaultQueryDraft(), { ...options, view: "songRank", mode: "mobile" }), {
    count: 0,
    labels: [],
    hasActive: false,
    visibleCountText: "",
    ariaLabel: "打开搜索与筛选",
  });
  assert.deepEqual(
    queryTriggerModel(
      { ...defaultQueryDraft(), q: "少女レイ", nicheOnly: true, minCount: 2 },
      { ...options, view: "songRank", mode: "mobile" },
    ),
    {
      count: 3,
      labels: ["少女レイ", "只看小众", "2次以上"],
      hasActive: true,
      visibleCountText: "",
      ariaLabel: "打开搜索与筛选，当前有 3 个条件：少女レイ、只看小众、2次以上",
    },
  );
  assert.equal(
    queryTriggerModel({ ...defaultQueryDraft(), hideUnknownArtist: false }, { ...options, view: "songRank" }).visibleCountText,
    "1",
  );
});

test("summary video count keeps source totals separate from hidden-unknown visibility", () => {
  assert.deepEqual(summaryVideoCountModel({
    visibleCount: 1099,
    sourceCount: 1224,
    hideUnknownArtist: true,
    filter: "",
  }), {
    count: 1099,
    note: "",
    sourceCount: 1224,
    visibleCount: 1099,
    ratioText: "1099/1224",
    usesSourceCount: true,
  });

  assert.deepEqual(summaryVideoCountModel({
    visibleCount: 37,
    sourceCount: 1224,
    hideUnknownArtist: true,
    filter: "テオ",
  }), {
    count: 37,
    note: "",
    sourceCount: 1224,
    visibleCount: 37,
    ratioText: "37",
    usesSourceCount: false,
  });

  assert.deepEqual(summaryVideoCountModel({
    visibleCount: 1224,
    sourceCount: 1224,
    hideUnknownArtist: false,
  }), {
    count: 1224,
    note: "",
    sourceCount: 1224,
    visibleCount: 1224,
    ratioText: "1224/1224",
    usesSourceCount: true,
  });
});

test("runtime range path follows URL range and meta paths", () => {
  const parsed = parseUrlState("?range=1m", urlStateOptions());
  assert.equal(parsed.range, "1m");
  assert.equal(
    runtimeRangePath(parsed.range, {
      ranges: {
        "1m": { path: "data/ui/1m.abcdef123456.json" },
      },
    }),
    "data/ui/1m.abcdef123456.json",
  );
  assert.equal(runtimeRangePath("72h", null), "data/ui/72h.json");
  assert.throws(() => runtimeRangePath("72h", null, { requireMeta: true }), /runtime meta missing/u);
});

test("runtime range validation rejects version mismatches and empty current ranges", () => {
  const meta = {
    dataVersion: "a".repeat(64),
    ranges: {
      "1m": { itemCount: 1, dataVersion: "a".repeat(64), path: "data/ui/1m.abcdef123456.json" },
    },
  };
  const valid = runtimePayloadFixture({ dataVersion: "a".repeat(64) });
  assert.equal(validateRuntimeRangePayload(valid, { rangeId: "1m", meta }).items.length, 1);

  assert.throws(
    () => validateRuntimeRangePayload(runtimePayloadFixture({ dataVersion: "b".repeat(64) }), { rangeId: "1m", meta }),
    /dataVersion mismatch/u,
  );
  assert.throws(
    () => validateRuntimeRangePayload(runtimePayloadFixture({ items: [] }), { rangeId: "1m", meta }),
    /items length does not match meta/u,
  );
});

test("runtime legacy group fallback converts to a validated runtime payload", () => {
  const group = {
    id: "1m",
    title: "月度",
    generatedAt: "2026-07-13T15:56:10.026Z",
    items: [video("AAAAAAAAAAA", "video", "channel", [song("song", "artist", { isNiche: false })])],
  };
  const payload = runtimeRangePayloadFromGroup(group, {
    rangeId: "1m",
    capturedAt: "2026-07-13T15:56:10.026Z",
    filterVersion: 3,
    fallbackFrom: "data/1m.json",
  });

  assert.equal(payload.id, "1m");
  assert.equal(payload.fallbackFrom, "data/1m.json");
  assert.equal(validateRuntimeRangePayload(payload, { rangeId: "1m", allowLegacyDataVersion: true }), payload);
});

test("url state keeps rank metric and video layout only when relevant", () => {
  const options = urlStateOptions();
  const metricState = {
    range: "72h",
    view: "artistRank",
    page: 1,
    pageSize: 50,
    bucket: "全部",
    rankMetric: "videos",
    videoLayout: "cards",
    outside: false,
    q: "",
    snapshotPath: "data/latest.json",
  };

  assert.deepEqual(Object.fromEntries(new URLSearchParams(serializeUrlState(metricState, options))), {
    view: "artistRank",
    metric: "videos",
  });
  assert.equal(parseUrlState("?view=artistRank&metric=videos", options).rankMetric, "videos");

  const compactVideo = {
    ...metricState,
    view: "videos",
    rankMetric: "occurrences",
    videoLayout: "compact",
  };
  assert.deepEqual(Object.fromEntries(new URLSearchParams(serializeUrlState(compactVideo, options))), {
    view: "videos",
    layout: "compact",
  });
  assert.equal(parseUrlState("?view=videos&layout=compact", options).videoLayout, "compact");
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
  assert.equal(parsed.showUnknown, false);
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
        showUnknown: false,
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

test("runtime prefetch is disabled for saveData, 2g, slow-2g, and hidden pages", () => {
  assert.equal(shouldPrefetchRuntimeRange({ connection: {}, visibilityState: "visible" }), true);
  assert.equal(shouldPrefetchRuntimeRange({ connection: { saveData: true }, visibilityState: "visible" }), false);
  assert.equal(shouldPrefetchRuntimeRange({ connection: { effectiveType: "2g" }, visibilityState: "visible" }), false);
  assert.equal(shouldPrefetchRuntimeRange({ connection: { effectiveType: "slow-2g" }, visibilityState: "visible" }), false);
  assert.equal(shouldPrefetchRuntimeRange({ connection: {}, visibilityState: "hidden" }), false);
});

test("trend lookup converts arrays into Map lookups", () => {
  const lookup = createTrendLookup({
    songRank: [{ entityKey: "song-a", rankDelta: 1, countDelta: 2, isNew: false }],
    artistRank: [{ entityKey: "artist-a", rankDelta: null, countDelta: 1, isNew: true }],
  });

  assert.equal(lookup.songRank.get("song-a").countDelta, 2);
  assert.equal(lookup.artistRank.get("artist-a").isNew, true);
  assert.equal(lookup.songRank.get("missing"), undefined);
});

test("current source filter skip requires both filterVersion and blocklistHash", () => {
  assert.equal(shouldSkipSourceFilter({ filterVersion: 3, blocklistHash: "hash-a" }, 3, "hash-a"), true);
  assert.equal(shouldSkipSourceFilter({ filterVersion: 4, blocklistHash: "hash-a" }, 3, "hash-a"), true);
  assert.equal(shouldSkipSourceFilter({ filterVersion: 2, blocklistHash: "hash-a" }, 3, "hash-a"), false);
  assert.equal(shouldSkipSourceFilter({ filterVersion: 3 }, 3, "hash-a"), false);
  assert.equal(shouldSkipSourceFilter({ filterVersion: 3, blocklistHash: "stale" }, 3, "hash-a"), false);
  assert.equal(shouldSkipSourceFilter({}, 3, "hash-a"), false);
});

test("formatSeconds derives display time from seconds", () => {
  assert.equal(formatSeconds(75), "1:15");
  assert.equal(formatSeconds(3723), "1:02:03");
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
    titleKeys: [normalizeSongSearchText("少女レイ"), normalizeSongSearchText("鬼ノ宴"), normalizeSongSearchText("星間飛行"), normalizeSongSearchText("KICK BACK")],
    titleArtistKeys: [
      normalizeSongSearchText("少女レイ") + "::" + normalizeSongSearchText("みきとP"),
      normalizeSongSearchText("鬼ノ宴") + "::" + normalizeSongSearchText("友成空"),
      normalizeSongSearchText("星間飛行") + "::" + normalizeSongSearchText("中島愛"),
    ],
  });

  assert.equal(isSongSearchKnown(song("少女レイ\tみきとP", "未記載"), lookup), true);
  assert.equal(isSongSearchKnown(song("⑪少女レイ", "みきとP"), lookup), true);
  assert.equal(isSongSearchKnown(song("「鬼ノ宴」友成空", "未記載"), lookup), true);
  assert.equal(isSongSearchKnown(song("⁆🦊03.星間飛行", "中島愛"), lookup), true);
  assert.equal(isSongSearchKnown(song("＊ 04. KICK BACK", "未記載"), lookup), true);
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

function assertPageTokensOrdered(tokens) {
  let previousPage = 0;
  const pages = [];
  for (const token of tokens) {
    if (token.type === "page") {
      assert.ok(token.page > previousPage, `page token out of order: ${JSON.stringify(tokens)}`);
      previousPage = token.page;
      pages.push(token.page);
    } else {
      assert.equal(token.type, "ellipsis");
      assert.match(token.side, /^(left|right)$/u);
      assert.equal(Object.hasOwn(token, "target"), false, `ellipsis must not be clickable: ${JSON.stringify(token)}`);
    }
  }
  assert.equal(new Set(pages).size, pages.length, `duplicate page token: ${JSON.stringify(tokens)}`);
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
      showUnknown: false,
      q: "",
    },
  };
}

function queryDraftOptions() {
  return {
    validRankMetrics: ["occurrences", "videos"],
    validTrendFilters: ["all", "new", "up", "down"],
    validMinCounts: [1, 2, 5, 10],
    validPageSizes: [50, 100],
    latestSnapshotPath: "data/latest.json",
    snapshots: [
      { id: "archive-20260710", path: "data/snapshots/2026-07-10.json" },
      { id: "archive-20260711", path: "data/snapshots/2026-07-11.json" },
    ],
    defaults: {
      pageSize: 50,
      snapshotPath: "data/latest.json",
      hideUnknownArtist: true,
      rankMetric: "occurrences",
      trend: "all",
      minCount: 1,
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

function runtimePayloadFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "1m",
    title: "月度",
    generatedAt: "2026-07-13T15:56:10.026Z",
    capturedAt: "2026-07-13T15:56:10.026Z",
    dataVersion: "a".repeat(64),
    filterVersion: 3,
    nicheAnnotated: true,
    items: [video("AAAAAAAAAAA", "video", "channel", [song("song", "artist", { isNiche: false })])],
    ...overrides,
  };
}
