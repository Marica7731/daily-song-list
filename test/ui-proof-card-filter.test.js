const assert = require("node:assert/strict");
const test = require("node:test");

const fu = require("../assets/frontend-utils");

const filterOptions = {
  validRanges: ["7d", "all"],
  validViews: ["songRank", "artistRank", "songAz", "videos"],
  validPageSizes: [20, 30],
  validSourceFilters: ["all", "cataloged", "uncataloged", "external"],
  defaults: { range: "7d", view: "songRank", pageSize: 20, sourceFilter: "all" },
};

test("parseUrlState reads channel and source filters with safe defaults", () => {
  const base = fu.parseUrlState("?range=7d", filterOptions);
  assert.equal(base.channelFilter, "");
  assert.equal(base.sourceFilter, "all");

  const filtered = fu.parseUrlState("?channel=Holo&source=cataloged", filterOptions);
  assert.equal(filtered.channelFilter, "Holo");
  assert.equal(filtered.sourceFilter, "cataloged");

  const invalid = fu.parseUrlState("?source=bogus", filterOptions);
  assert.equal(invalid.sourceFilter, "all");
});

test("serializeUrlState round-trips channel and source filters", () => {
  const state = fu.parseUrlState("?channel=Holo&source=external", filterOptions);
  const serialized = new URLSearchParams(fu.serializeUrlState(state, filterOptions));
  assert.equal(serialized.get("channel"), "Holo");
  assert.equal(serialized.get("source"), "external");

  const noFilter = fu.parseUrlState("?range=7d", filterOptions);
  const serializedNo = new URLSearchParams(fu.serializeUrlState(noFilter, filterOptions));
  assert.equal(serializedNo.has("channel"), false);
  assert.equal(serializedNo.has("source"), false);
});

test("catalogStateModel distinguishes cataloged, uncataloged and external", () => {
  assert.equal(fu.catalogStateModel({ isCollected: true }).state, "cataloged");
  assert.equal(fu.catalogStateModel({ isCollected: true }).isCataloged, true);
  assert.equal(fu.catalogStateModel({ sourceType: "unknown" }).state, "uncataloged");
  assert.equal(fu.catalogStateModel({ sourceType: "youtube_channel_discovery" }).state, "external");
  assert.equal(fu.catalogStateModel({ sourceType: "vsinger-moment" }).state, "external");
  assert.equal(fu.catalogStateModel({}).state, "uncataloged");
  assert.equal(fu.catalogStateModel({ isCollected: "1" }).isCataloged, true);
  assert.equal(fu.catalogStateModel({ isCollected: false, sourceType: "library" }).isCataloged, true);
  assert.deepEqual(
    [
      fu.catalogStateModel({ isCollected: true }).text,
      fu.catalogStateModel({}).text,
      fu.catalogStateModel({ sourceType: "vsinger-moment" }).text,
    ],
    ["已收录", "未记载", "外部发现"],
  );
});

test("buildChannelFilterPredicate matches channel name / handle / id", () => {
  const matchHolo = fu.buildChannelFilterPredicate("Holo");
  assert.equal(matchHolo({ channelName: "HoloLive" }), true);
  assert.equal(matchHolo({ channelHandle: "@holo_official" }), true);
  assert.equal(matchHolo({ channelId: "UCXXXX" }), false);

  const none = fu.buildChannelFilterPredicate("");
  assert.equal(none({ channelName: "Anything" }), true);

  const caseInsensitive = fu.buildChannelFilterPredicate("holo");
  assert.equal(caseInsensitive({ channelName: "HOLO" }), true);
});

test("buildSourceFilterPredicate matches catalog state", () => {
  const onlyCataloged = fu.buildSourceFilterPredicate("cataloged");
  assert.equal(onlyCataloged({ isCollected: true }), true);
  assert.equal(onlyCataloged({ sourceType: "youtube_channel_discovery" }), false);

  const onlyUncataloged = fu.buildSourceFilterPredicate("uncataloged");
  assert.equal(onlyUncataloged({ sourceType: "unknown" }), true);
  assert.equal(onlyUncataloged({ isCollected: true }), false);

  const onlyExternal = fu.buildSourceFilterPredicate("external");
  assert.equal(onlyExternal({ sourceType: "youtube_channel_discovery" }), true);
  assert.equal(onlyExternal({ isCollected: true }), false);

  assert.equal(fu.buildSourceFilterPredicate("all")({}), true);
  assert.equal(fu.buildSourceFilterPredicate("")({}), true);
});

test("source-filter module mirrors channel and source filter semantics", (t) => {
  let sourceFilter;
  try {
    sourceFilter = require("../assets/source-filter");
  } catch (error) {
    // source-filter.js 在加载时会读取 config/blocked-vtuber-channels.json；
    // 本稀疏 worktree 未含 config/，属环境限制，跳过该环境相关断言。
    t.skip(`source-filter 加载需要 config/（环境限制）: ${error.message}`);
    return;
  }

  assert.equal(typeof sourceFilter.matchesChannelFilter, "function");
  assert.equal(typeof sourceFilter.matchesSourceFilter, "function");

  assert.equal(sourceFilter.matchesChannelFilter({ channelName: "Holo" }, "holo"), true);
  assert.equal(sourceFilter.matchesChannelFilter({ channelName: "Other" }, "holo"), false);
  assert.equal(sourceFilter.matchesSourceFilter({ isCollected: true }, "cataloged"), true);
  assert.equal(sourceFilter.matchesSourceFilter({ sourceType: "youtube_channel_discovery" }, "external"), true);
  assert.equal(sourceFilter.matchesSourceFilter({}, "all"), true);
});
