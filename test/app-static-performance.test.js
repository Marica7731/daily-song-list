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
  assert.match(functionBody("function trendForRecord"), /trendForKey\(mode, record\?\.key\)/u);
  assert.match(functionBody("function trendForKey"), /\.get\(key\)/u);
  assert.match(appSource, /function createRangeCacheObject[\s\S]*defineLazyArtistCache/u);
  assert.match(appSource, /function createRangeCacheObject[\s\S]*normalizedVideoSearchData/u);
});

test("runtime range load validates meta-bound payloads and has fallback paths", () => {
  assert.match(functionBody("async function loadRuntimeRange"), /runtime meta missing/u);
  assert.match(appSource, /async function tryRuntimeRangeLoad[\s\S]*validateRuntimeRangePayload/u);
  assert.match(appSource, /async function loadRuntimeRangeFallback[\s\S]*runtimeRangeIdCandidates\(rangeId\)\.map/u);
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

test("monthly range copy describes all-range catalog semantics", () => {
  assert.doesNotMatch(indexSource, /来自 YouTube 月度搜索筛选/u);
  assert.match(indexSource, /累计全量；YouTube 月度搜索和历史快照用于补充发现视频。/u);
  assert.match(indexSource, /最近7天和累计全量时间戳歌单快照/u);
  assert.match(appSource, /monthlyCoverageNote/u);
});

test("record videoCount is used for rank values and row rendering", () => {
  assert.match(functionBody("function rankValue"), /record\.videoCount/u);
  assert.doesNotMatch(functionBody("function rankValue"), /uniqueVideoCount/u);
  assert.match(appSource, /videoCount:\s*record\.videoCount/u);
});

test("song and index rows inline source previews and expand only remaining videos", () => {
  const rankRecordBody = functionBody("function renderRankRecord");
  assert.match(rankRecordBody, /const sourceVideoCount = Math\.max\(0, Number\(videoCount\) \|\| 0\)/u);
  assert.match(rankRecordBody, /const safeOccurrences = occurrences \|\| \[\]/u);
  assert.match(rankRecordBody, /const occurrenceCount = safeOccurrences\.length/u);
  assert.match(rankRecordBody, /sourcePresentationModel\(safeOccurrences/u);
  assert.match(rankRecordBody, /Boolean\(sourcePresentation\?\.canExpand\)/u);
  assert.match(rankRecordBody, /row\._sourceDetailOccurrences = sourcePresentation\?\.hiddenGroups\?\.flatMap/u);
  assert.match(rankRecordBody, /occurrences: mode === "artist" \? safeOccurrences : row\._sourceDetailOccurrences/u);
  assert.match(rankRecordBody, /copyOccurrences: safeOccurrences/u);
  assert.match(rankRecordBody, /renderRankSide/u);
  assert.match(rankRecordBody, /renderSourceInlineStrip\(sourcePresentation/u);

  const indexRecordBody = functionBody("function renderIndexRecord");
  assert.match(indexRecordBody, /const sourceVideoCount = Math\.max\(0, Number\(record\.videoCount\) \|\| 0\)/u);
  assert.match(indexRecordBody, /sourcePresentationModel\(record\.occurrences/u);
  assert.match(indexRecordBody, /const expandable = sourcePresentation\.canExpand/u);
  assert.match(indexRecordBody, /row\._sourceDetailOccurrences = sourcePresentation\.hiddenGroups\.flatMap/u);
  assert.match(indexRecordBody, /occurrences: row\._sourceDetailOccurrences/u);
  assert.match(indexRecordBody, /copyOccurrences: record\.occurrences/u);
  assert.match(indexRecordBody, /renderRankSide/u);
  assert.match(indexRecordBody, /renderSourceInlineStrip\(sourcePresentation/u);

  const contentBody = functionBody("function renderRecordContent");
  assert.doesNotMatch(contentBody, /renderSourceInlineStrip/u);
  assert.doesNotMatch(contentBody, /sourcePresentationModel\(occurrences/u);

  const sideBody = functionBody("function renderRankSide");
  assert.match(sideBody, /if \(mode === "artist"\)/u);
  assert.match(sideBody, /renderSourceToggleButton/u);
  assert.match(sideBody, /return side/u);
  assert.doesNotMatch(sideBody, /renderSingleSourceCopyIconButton/u);

  const stripBody = functionBody("function renderSourceInlineStrip");
  assert.match(stripBody, /source-inline-empty/u);
  assert.match(stripBody, /renderSourceInlineGroup/u);
  assert.match(stripBody, /renderSourceInlineMoreButton/u);
  assert.match(stripBody, /model\.showCopyAll && options\.showCopyAll !== false && !options\.isExpanded/u);
  assert.match(stripBody, /renderInlineCopySongLinksButton/u);
});

test("source drawer append-more reveals all remaining sources without rebuilding old cards", () => {
  const expandBody = functionBody("function expandSourceVideoGroups");
  assert.match(expandBody, /const nextVisible = groups\.length/u);
  assert.match(expandBody, /SOURCE_EXPAND_CHUNK_SIZE/u);
  assert.match(expandBody, /await yieldToBrowser\(\)/u);
  assert.match(expandBody, /convertSourceGroupMoreToCollapse\(button, drawer\)/u);
  assert.doesNotMatch(expandBody, /sourceBatchSizeForMode/u);

  const appendRangeBody = functionBody("function appendSourceGroupRange");
  assert.match(appendRangeBody, /document\.createDocumentFragment\(\)/u);
  assert.match(appendRangeBody, /drawer\.insertBefore\(fragment/u);
  assert.doesNotMatch(appendRangeBody, /replaceChildren/u);

  const footerBody = functionBody("function convertSourceGroupMoreToCollapse");
  assert.match(footerBody, /delete button\.dataset\.toggleSourceGroups/u);
  assert.match(footerBody, /button\.dataset\.collapseSource = "true"/u);
  assert.doesNotMatch(footerBody, /createElement\("button"\)|remove\(\)/u);

  const expandedBody = functionBody("async function setSourceDrawerExpanded");
  assert.match(expandedBody, /drawer\.dataset\.sourceDeferred === "true"/u);
  assert.doesNotMatch(expandedBody, /replaceChildren|isCompactRankMode\(\)[\s\S]*appendSourceDrawerLinks/u);
});

test("artist rank song details share inline source model and append remaining songs in batches", () => {
  const appendArtistBody = functionBody("function appendArtistSongGroups");
  assert.match(appendArtistBody, /appendArtistSongGroupRange/u);
  assert.doesNotMatch(appendArtistBody, /appendSourceDrawerLinks|renderSourceVideoGroup/u);

  const renderArtistBody = functionBody("function renderArtistSongGroup");
  assert.match(renderArtistBody, /sourcePresentationModel\(group\.occurrences/u);
  assert.match(renderArtistBody, /renderSourceInlineStrip\(sourcePresentation/u);
  assert.match(renderArtistBody, /sources\.dataset\.sourceDeferred = "true"/u);
  assert.match(renderArtistBody, /sourcePresentation\.hiddenGroups\.flatMap/u);
  assert.doesNotMatch(renderArtistBody, /dataset\.toggleArtistSongSource = "true"/u);
  assert.match(renderArtistBody, /renderCopySongLinksIconButton\(group\.occurrences\)/u);

  const toggleSourceBody = functionBody("function toggleArtistSongSource");
  assert.match(toggleSourceBody, /sources\.dataset\.sourceDeferred === "true"/u);
  assert.match(toggleSourceBody, /copyOccurrences: sources\._songSourceOccurrences \|\| sources\._sourceOccurrences/u);
  assert.match(toggleSourceBody, /showToolbar: false/u);
  assert.match(functionBody("function appendSourceDrawerLinks"), /drawer\.dataset\.sourceMode === "artist-song"/u);
  assert.match(toggleSourceBody, /closeSiblingArtistSongSources\(section\)/u);

  const toggleLimitBody = functionBody("function toggleArtistSongLimit");
  assert.match(toggleLimitBody, /const nextVisible = Math\.min\(songGroups\.length, current \+ ARTIST_SONG_GROUP_BATCH_SIZE\)/u);
  assert.match(toggleLimitBody, /appendArtistSongGroupRange\(drawer, songGroups, current, nextVisible\)/u);
  assert.doesNotMatch(toggleLimitBody, /replaceChildren/u);
});

test("delayed trend diffs update visible badges without rerendering the list for all trend", () => {
  const scheduleBody = functionBody("function scheduleCurrentRankDiffLoad");
  assert.match(scheduleBody, /state\.trend === "all"[\s\S]*updateVisibleTrendBadges\(\)/u);
  assert.match(scheduleBody, /else \{[\s\S]*render\(\{ syncUrl: false \}\)/u);

  const updateBody = functionBody("function updateVisibleTrendBadges");
  assert.match(updateBody, /querySelectorAll\("\.rank-row\[data-trend-mode\]\[data-trend-key\]"\)/u);
  assert.match(updateBody, /querySelector\("\.rank-side-trend"\)/u);
  assert.match(updateBody, /trendSlot\.replaceChildren\(\)/u);
  assert.doesNotMatch(updateBody, /els\.content\.replaceChildren|render\(/u);
});

test("selection builds only the records needed by the current view", () => {
  const selectionBody = functionBody("function currentSelection");
  assert.match(selectionBody, /const key = `\$\{state\.view\}::/u);
  assert.doesNotMatch(selectionBody, /const baseSongRecords/u);
  assert.doesNotMatch(selectionBody, /buildArtistRecords\(occurrences\)[\s\S]*buildSongRecords\(occurrences\)/u);

  const prewarmBody = functionBody("async function prewarmDefaultSorts");
  assert.match(prewarmBody, /if \(state\.view === "videos"\) return/u);
  assert.ok(prewarmBody.indexOf('state.view === "artistRank"') < prewarmBody.indexOf("selectedSongRecords"));
});

test("explicit search stays intersected with hidden unknown-artist filtering", () => {
  const selectionBody = functionBody("function currentSelection");
  assert.match(selectionBody, /const occurrences = baseOccurrences\.filter\(\(occurrence\) => occurrence\.searchText\.includes\(filterKey\)\)/u);
  assert.doesNotMatch(selectionBody, /searchBaseOccurrences/u);

  const collectBody = functionBody("function collectSongOccurrences");
  assert.match(collectBody, /\[item\.videoId, item\.title, item\.channelName, item\.keyword, song\.title, song\.artist\]/u);

  const videoBody = functionBody("function buildVideoViewItems");
  assert.match(videoBody, /const videoMatched = matchesSearch\(\[item\.videoId, item\.title, item\.channelName, item\.keyword\], filter\)/u);
  assert.match(videoBody, /const matchedSongs = sourceSongs\.filter\(\(song\) => matchesSearch/u);
  assert.doesNotMatch(videoBody, /searchableSongs/u);
});

test("query overlay opens before suggestions and result preview work", () => {
  const openBody = functionBody("function openQueryOverlay");
  const setActiveIndex = openBody.indexOf('state.activeOverlay = "query"');
  const openIndex = openBody.indexOf("setDialogOpen(els.queryDialog, true)");
  const inertIndex = openBody.indexOf("setPageInert(true)");
  const syncIndex = openBody.indexOf("syncQueryControlsFromDraft");
  assert.ok(setActiveIndex >= 0 && openIndex > setActiveIndex, "query overlay should set active overlay before opening");
  assert.ok(syncIndex > openIndex, "query overlay should light-sync controls after the shell is visible");
  assert.match(openBody, /syncQueryControlsFromDraft\(state\.queryDraft, \{ light: true, forceSnapshot: false \}\)/u);
  assert.ok(inertIndex > syncIndex, "query overlay should delay page inert work until after the visible shell");
  const beforeOpen = openBody.slice(0, openIndex);
  assert.doesNotMatch(beforeOpen, /renderSearchSuggestions|queryDraftResultCount|buildSongRecords|buildArtistRecords|buildVideoViewItems/u);
  assert.match(openBody, /requestAnimationFrame\(\(\) => \{[\s\S]*setTimeout\(\(\) => \{[\s\S]*setPageInert\(true\);[\s\S]*hydrateQueryOverlayAfterFirstFrame\(revision\)/u);

  const bindBody = functionBody("function bindQueryOverlayEvents");
  assert.match(bindBody, /compositionstart/u);
  assert.match(bindBody, /compositionend/u);
  assert.match(bindBody, /event\.isComposing \|\| state\.queryComposing/u);
  assert.match(bindBody, /updateQueryDraft\(\{ q: els\.queryInput\.value \}, \{[\s\S]*sync: "input"/u);

  const suggestionBody = functionBody("function renderSearchSuggestions");
  assert.ok(suggestionBody.indexOf("if (!hasQuery) return") < suggestionBody.indexOf("buildSearchSuggestions"));
  assert.match(appSource, /const QUERY_SUGGESTION_SCAN_LIMIT = 360;/u);
  const countBody = functionBody("function queryDraftResultCount");
  assert.doesNotMatch(countBody, /buildSongRecords|buildArtistRecords|buildVideoViewItems/u);
  assert.match(countBody, /queryResultCountCache/u);
  assert.match(functionBody("function createRangeCacheObject"), /queryIndexes:[\s\S]*queryIndexLoads:[\s\S]*queryResultCountCache:/u);
});

test("range prefetch stays fast and does not use an 8 second delay", () => {
  const scheduleBody = functionBody("function scheduleOtherRangePrefetch");
  assert.match(scheduleBody, /window\.setTimeout\(\(\) => \{[\s\S]*requestIdleCallback\(run, \{ timeout: 1200 \}\)/u);
  assert.match(scheduleBody, /\}, 300\)/u);
  assert.doesNotMatch(scheduleBody, /8000|8\s*\*\s*1000/u);

  const intentBody = functionBody("function bindRangeIntentPrefetch");
  assert.match(intentBody, /\["pointerdown", "touchstart", "mousedown", "focus"\]/u);
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
