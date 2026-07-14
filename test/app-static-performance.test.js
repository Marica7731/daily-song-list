const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("initial app load does not fetch full latest or rank diffs in init", () => {
  const initBody = functionBody("async function init");
  assert.doesNotMatch(initBody, /readJson\(SNAPSHOT_LATEST_PATH/u);
  assert.doesNotMatch(initBody, /loadRankDiff/u);
  assert.match(initBody, /loadRuntimeRange\(initialRange\)/u);
  assert.match(initBody, /UI_META_PATH/u);
  assert.match(initBody, /STATUS_PATH/u);
  assert.doesNotMatch(initBody, /Promise\.all\(\[[\s\S]*loadRuntimeRange\(initialRange\)/u);
  assert.ok(initBody.indexOf("state.runtimeMeta = meta") < initBody.indexOf("loadRuntimeRange(initialRange)"));
});

test("range cache and trend Map are wired into rendering", () => {
  assert.match(appSource, /rangeCache:\s*new Map\(\)/u);
  assert.match(appSource, /currentSelection\(rangeCache\)/u);
  assert.match(functionBody("function currentSelection"), /hideUnknownForView/u);
  assert.match(functionBody("function trendForRecord"), /\.get\(record\.key\)/u);
  assert.match(appSource, /function createRangeCacheObject[\s\S]*defineLazyArtistCache/u);
  assert.match(appSource, /function createRangeCacheObject[\s\S]*normalizedVideoSearchData/u);
});

test("runtime range load validates meta-bound payloads and has fallback paths", () => {
  assert.match(functionBody("async function loadRuntimeRange"), /runtime meta missing/u);
  assert.match(appSource, /async function tryRuntimeRangeLoad[\s\S]*validateRuntimeRangePayload/u);
  assert.match(appSource, /async function loadRuntimeRangeFallback[\s\S]*data\/\$\{rangeId\}\.json/u);
  assert.match(appSource, /async function loadRuntimeRangeFallback[\s\S]*SNAPSHOT_LATEST_PATH/u);
  assert.doesNotMatch(functionBody("async function loadRuntimeRangeFallback"), /state\.runtimeMeta\?\.filterVersion/u);
  assert.match(functionBody("async function loadRuntimeRangeFallback"), /filterVersion: Number\.isInteger\(raw\.filterVersion\) \? raw\.filterVersion : 0/u);
});

test("status display separates capture time from derived rebuild time", () => {
  const body = functionBody("function renderStatus");
  assert.match(body, /数据抓取于/u);
  assert.match(body, /页面数据重建于/u);
  assert.doesNotMatch(body, /rebuiltDerivedAt \|\| status\.completedAt/u);
});

test("home controls remove legacy info buttons and expose hide-unknown toggle", () => {
  assert.doesNotMatch(indexSource, /data-info-topic/u);
  assert.doesNotMatch(appSource, /data-info-topic/u);
  assert.doesNotMatch(appSource, /function infoText/u);
  assert.match(indexSource, /id="hideUnknownToggle"/u);
  assert.match(appSource, /hideUnknownToggle/u);
});

test("initial URL state accepts ordinary query params without shared marker", () => {
  const body = functionBody("function applyInitialUrlState");
  assert.match(body, /stateParamKeys/u);
  assert.match(body, /urlParams\.has\(key\)/u);
  assert.match(body, /!shouldApplySharedState && !hasStateParams/u);
  assert.match(body, /state\.sharedUrlApplied = shouldApplySharedState/u);
});

test("monthly range copy describes 35 day catalog semantics", () => {
  assert.doesNotMatch(indexSource, /来自 YouTube 月度搜索筛选/u);
  assert.match(indexSource, /最近35天累计；YouTube 月度搜索用于补充发现视频。/u);
  assert.match(indexSource, /最近72小时和最近35天累计时间戳歌单快照/u);
  assert.match(appSource, /monthlyCoverageNote/u);
});

test("record videoCount is used for rank values and row rendering", () => {
  assert.match(functionBody("function rankValue"), /record\.videoCount/u);
  assert.doesNotMatch(functionBody("function rankValue"), /uniqueVideoCount/u);
  assert.match(appSource, /videoCount:\s*record\.videoCount/u);
});

test("same-video multiple timestamps are expandable instead of becoming inline-only", () => {
  const rankRecordBody = functionBody("function renderRankRecord");
  assert.match(rankRecordBody, /const sourceVideoCount = mode === "artist" \? videoCount : window\.FrontendUtils\.groupOccurrencesByVideo\(occurrences\)\.length/u);
  assert.match(rankRecordBody, /const occurrenceCount = occurrences\.length/u);
  assert.match(rankRecordBody, /const expandable = mode === "artist" \? artistSongCount > 1 \|\| sourceVideoCount > 1 \|\| occurrenceCount > 1 : sourceVideoCount > 1 \|\| occurrenceCount > 1/u);

  const indexRecordBody = functionBody("function renderIndexRecord");
  assert.match(indexRecordBody, /const sourceVideoCount = window\.FrontendUtils\.groupOccurrencesByVideo\(record\.occurrences\)\.length/u);
  assert.match(indexRecordBody, /const expandable = sourceVideoCount > 1 \|\| record\.occurrences\.length > 1/u);

  const sublineBody = functionBody("function appendSublineSource");
  assert.match(sublineBody, /if \(groupedSources\.length === 1 && occurrences\.length === 1\)/u);
  assert.doesNotMatch(sublineBody, /groupedSources\.length === 1\)\s*\{/u);
});

test("source drawer append-more reveals all remaining sources without rebuilding old cards", () => {
  const expandBody = functionBody("function expandSourceVideoGroups");
  assert.match(expandBody, /const nextVisible = groups\.length/u);
  assert.match(expandBody, /appendSourceGroupRange\(drawer, groups, current, nextVisible\)/u);
  assert.doesNotMatch(expandBody, /sourceBatchSizeForMode|current \+ /u);

  const appendRangeBody = functionBody("function appendSourceGroupRange");
  assert.match(appendRangeBody, /document\.createDocumentFragment\(\)/u);
  assert.match(appendRangeBody, /drawer\.insertBefore\(fragment/u);
  assert.doesNotMatch(appendRangeBody, /replaceChildren/u);

  const expandedBody = functionBody("function setSourceDrawerExpanded");
  assert.match(expandedBody, /drawer\.dataset\.sourceDeferred === "true"/u);
  assert.doesNotMatch(expandedBody, /replaceChildren|isCompactRankMode\(\)[\s\S]*appendSourceDrawerLinks/u);
});

test("artist rank source details use two-level lazy loading and append remaining songs once", () => {
  const appendArtistBody = functionBody("function appendArtistSongGroups");
  assert.match(appendArtistBody, /appendArtistSongGroupRange/u);
  assert.doesNotMatch(appendArtistBody, /appendSourceDrawerLinks|renderSourceVideoGroup/u);

  const renderArtistBody = functionBody("function renderArtistSongGroup");
  assert.match(renderArtistBody, /sources\.dataset\.sourceDeferred = "true"/u);
  assert.match(renderArtistBody, /dataset\.toggleArtistSongSource = "true"/u);
  assert.match(renderArtistBody, /renderCopySongLinksIconButton\(group\.occurrences\)/u);

  const toggleSourceBody = functionBody("function toggleArtistSongSource");
  assert.match(toggleSourceBody, /sources\.dataset\.sourceDeferred === "true"/u);
  assert.match(toggleSourceBody, /appendSourceDrawerLinks\(sources, sources\._sourceOccurrences \|\| \[\],[\s\S]*showToolbar: false/u);
  assert.match(toggleSourceBody, /closeSiblingArtistSongSources\(section\)/u);

  const toggleLimitBody = functionBody("function toggleArtistSongLimit");
  assert.match(toggleLimitBody, /const nextVisible = songGroups\.length/u);
  assert.match(toggleLimitBody, /appendArtistSongGroupRange\(drawer, songGroups, current, nextVisible\)/u);
  assert.doesNotMatch(toggleLimitBody, /replaceChildren|ARTIST_SONG_GROUP_BATCH/u);
});

function functionBody(signature) {
  const start = appSource.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const parenStart = appSource.indexOf("(", start);
  assert.notEqual(parenStart, -1, `missing parameter list for ${signature}`);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let index = parenStart; index < appSource.length; index += 1) {
    const char = appSource[index];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (parenDepth === 0) {
      parenEnd = index;
      break;
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated parameter list for ${signature}`);
  const braceStart = appSource.indexOf("{", parenEnd);
  let depth = 0;
  for (let index = braceStart; index < appSource.length; index += 1) {
    const char = appSource[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return appSource.slice(braceStart, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}
