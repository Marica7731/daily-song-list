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
  assert.match(body, /数据库构建于/u);
  assert.match(body, /源数据采集于/u);
  assert.match(body, /state\.runtimeApi\.available/u);
  assert.doesNotMatch(body, /STATUS_STALE/u);
  assert.doesNotMatch(body, /超过\$\{STATUS_STALE_MINUTES\}分钟未更新/u);
  assert.match(body, /freshnessAt=/u);
  assert.match(body, /页面数据重建于/u);
  assert.doesNotMatch(body, /rebuiltDerivedAt \|\| status\.completedAt/u);
  assert.match(functionBody("function runtimeMetaFromApiMeta"), /const \{ diffs: _staticDiffs, \.\.\.fallbackRuntimeMeta \} = fallbackMeta \|\| \{\}/u);
  assert.match(functionBody("function runtimeMetaFromApiMeta"), /\.\.\.fallbackRuntimeMeta/u);
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
  assert.doesNotMatch(appSource, /monthlyCoverageNote/u);
});

test("record videoCount is used for rank values and row rendering", () => {
  assert.match(functionBody("function rankValue"), /record\.videoCount/u);
  assert.doesNotMatch(functionBody("function rankValue"), /uniqueVideoCount/u);
  assert.match(appSource, /videoCount:\s*record\.videoCount/u);
});

test("song and index rows inline source previews and expand to full source lists", () => {
  const rankRecordBody = functionBody("function renderRankRecord");
  assert.match(rankRecordBody, /const sourceVideoCount = Math\.max\(0, Number\(videoCount\) \|\| 0\)/u);
  assert.match(rankRecordBody, /const safeOccurrences = occurrences \|\| \[\]/u);
  assert.match(rankRecordBody, /const occurrenceCount = safeOccurrences\.length/u);
  assert.match(rankRecordBody, /sourcePresentationModel\(safeOccurrences/u);
  assert.match(rankRecordBody, /Boolean\(sourcePresentation\?\.canExpand\)/u);
  assert.match(rankRecordBody, /row\._sourceDetailOccurrences = safeOccurrences/u);
  assert.match(rankRecordBody, /occurrences: row\._sourceDetailOccurrences/u);
  assert.match(rankRecordBody, /copyOccurrences: safeOccurrences/u);
  assert.match(rankRecordBody, /renderRankSide/u);
  assert.match(rankRecordBody, /renderSourceInlineStrip\(sourcePresentation/u);

  const indexRecordBody = functionBody("function renderIndexRecord");
  assert.match(indexRecordBody, /const sourceVideoCount = Math\.max\(0, Number\(record\.videoCount\) \|\| 0\)/u);
  assert.match(indexRecordBody, /sourcePresentationModel\(record\.occurrences/u);
  assert.match(indexRecordBody, /const expandable = sourcePresentation\.canExpand/u);
  assert.match(indexRecordBody, /row\._sourceDetailOccurrences = record\.occurrences/u);
  assert.match(indexRecordBody, /occurrences: row\._sourceDetailOccurrences/u);
  assert.match(indexRecordBody, /copyOccurrences: record\.occurrences/u);
  assert.match(indexRecordBody, /renderRankSide/u);
  assert.match(indexRecordBody, /renderSourceInlineStrip\(sourcePresentation/u);

  const contentBody = functionBody("function renderRecordContent");
  assert.doesNotMatch(contentBody, /renderSourceInlineStrip/u);
  assert.doesNotMatch(contentBody, /sourcePresentationModel\(occurrences/u);

  const sideBody = functionBody("function renderRankSide");
  assert.match(sideBody, /if \(mode === "artist" \|\| mode === "vtuber"\)/u);
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

test("source drawer renders paged source lists without inserting all cards", () => {
  const appendLinksBody = functionBody("function appendSourceDrawerLinks");
  assert.match(appendLinksBody, /const visibleCount = groups\.length/u);
  assert.match(appendLinksBody, /clearSourceDrawerPageContent\(drawer\)/u);
  assert.match(appendLinksBody, /appendSourceGroupRange\(drawer, groups, 0, visibleCount\)/u);
  assert.match(appendLinksBody, /appendSourceDrawerPager\(drawer, pageInfo\)/u);
  assert.doesNotMatch(appendLinksBody, /sourceVisibleGroupCount|syncSourceGroupMoreButton|sourceBatchSizeForMode/u);

  const appendRangeBody = functionBody("function appendSourceGroupRange");
  assert.match(appendRangeBody, /document\.createDocumentFragment\(\)/u);
  assert.match(appendRangeBody, /drawer\.insertBefore\(fragment/u);
  assert.doesNotMatch(appendRangeBody, /replaceChildren/u);

  assert.doesNotMatch(appSource, /function expandSourceVideoGroups|function convertSourceGroupMoreToCollapse|data-toggle-source-groups/u);

  const expandedBody = functionBody("async function setSourceDrawerExpanded");
  assert.match(expandedBody, /drawer\.dataset\.sourceDeferred === "true"/u);
  assert.match(expandedBody, /let songGroups =/u);
  assert.match(expandedBody, /sourceDetailPageForContainer\(row, drawerOccurrences/u);
  assert.match(expandedBody, /showSourceDrawerStatus\(drawer, "正在加载来源\.\.\."/u);
  assert.match(expandedBody, /clearSourceDrawerStatus\(drawer\);[\s\S]*initializeSourceDrawer/u);
  assert.doesNotMatch(expandedBody, /mode !== "artist"/u);
  assert.doesNotMatch(expandedBody, /replaceChildren|isCompactRankMode\(\)[\s\S]*appendSourceDrawerLinks/u);
  assert.match(functionBody("function sourceDetailOccurrencesForContainer"), /mergeCompleteSourceOccurrences/u);
  assert.match(functionBody("async function loadSourceDetailPage"), /pageSize/u);
  assert.doesNotMatch(appSource, /function remainingSourceDetailOccurrences/u);
});

test("artist rank song details share inline source model and append remaining songs in batches", () => {
  const appendArtistBody = functionBody("function appendArtistSongGroups");
  assert.match(appendArtistBody, /appendArtistSongGroupRange/u);
  assert.doesNotMatch(appendArtistBody, /appendSourceDrawerLinks|renderSourceVideoGroup/u);

  const renderArtistBody = functionBody("function renderArtistSongGroup");
  assert.match(renderArtistBody, /sourcePresentationModel\(group\.occurrences/u);
  assert.match(renderArtistBody, /renderSourceInlineStrip\(sourcePresentation/u);
  assert.match(renderArtistBody, /sources\.dataset\.sourceDeferred = "true"/u);
  assert.match(renderArtistBody, /sources\._sourceOccurrences = group\.occurrences/u);
  assert.doesNotMatch(renderArtistBody, /dataset\.toggleArtistSongSource = "true"/u);
  assert.match(renderArtistBody, /renderCopySongLinksIconButton\(group\.occurrences\)/u);

  const toggleSourceBody = functionBody("function toggleArtistSongSource");
  assert.match(toggleSourceBody, /sources\.dataset\.sourceDeferred === "true"/u);
  assert.match(toggleSourceBody, /copyOccurrences: sources\._songSourceOccurrences \|\| sources\._sourceOccurrences/u);
  assert.match(toggleSourceBody, /showToolbar: false/u);
  assert.match(toggleSourceBody, /closeSiblingArtistSongSources\(section\)/u);

  const toggleLimitBody = functionBody("function toggleArtistSongLimit");
  assert.match(toggleLimitBody, /const nextVisible = Math\.min\(songGroups\.length, current \+ artistSongBatchSize\(drawer\)\)/u);
  assert.match(toggleLimitBody, /appendArtistSongGroupRange\(drawer, songGroups, current, nextVisible\)/u);
  assert.doesNotMatch(toggleLimitBody, /replaceChildren/u);

  assert.match(appSource, /const ARTIST_SONG_GROUP_INITIAL_LIMIT = 8/u);
  assert.match(appSource, /const ARTIST_SONG_GROUP_BATCH_SIZE = 8/u);
  assert.match(appSource, /function lightweightSongGroupsForRecord\(record\)/u);
  assert.match(appSource, /function hydrateArtistSongGroup\(group\)/u);
  assert.match(appSource, /function shouldShowSongGroupTitle\(title\)/u);
  assert.match(functionBody("function shouldShowSongGroupTitle"), /エンドカード\|endcard/u);
  assert.match(functionBody("function shouldShowSongGroupTitle"), /えんどかーど/u);
  assert.match(functionBody("function shouldShowSongGroupTitle"), /endcard/u);
  assert.match(functionBody("function getArtistSongGroups"), /lightweightSongGroupsForRecord\(record\)/u);
  assert.doesNotMatch(functionBody("function getArtistSongGroups"), /buildArtistSongGroups\(record\.occurrences\)/u);
  assert.match(functionBody("function renderRequestedPageResult"), /result\.view === "vtuberRank"[\s\S]*getSongGroups: \(\) => getArtistSongGroups\(record\)/u);
});

test("VTuber song details use bounded progressive render and filter dirty preview titles", () => {
  assert.match(appSource, /const VTUBER_SONG_GROUP_INITIAL_LIMIT = 40;/u);
  assert.match(appSource, /const VTUBER_SONG_GROUP_BATCH_SIZE = 40;/u);
  assert.match(functionBody("function artistSongInitialLimit"), /sourceMode === "vtuber" \? VTUBER_SONG_GROUP_INITIAL_LIMIT/u);
  assert.match(functionBody("function artistSongBatchSize"), /sourceMode === "vtuber" \? VTUBER_SONG_GROUP_BATCH_SIZE/u);
  assert.match(functionBody("function vtuberSongPreview"), /sortedDisplaySongEntries\(record\.songs\)/u);
  assert.match(functionBody("function shouldShowSongGroupTitle"), /op\|ed\|end\|start\|opening\|ending/u);
});

test("VTuber ranking does not create standalone records from collaboration channel names", () => {
  const keyBody = functionBody("function vtuberRecordKey");
  assert.match(keyBody, /const directKey = directVtuberRecordKey\(item\)/u);
  assert.match(keyBody, /if \(directKey\) return directKey/u);
  assert.match(keyBody, /if \(isCompositeChannelName\(item\?\.channelName\)\) return ""/u);
  assert.match(functionBody("function directVtuberRecordKey"), /vtuberHandleFromChannelUrl\(vtuberChannelUrlCandidate\(item\)\)/u);
  assert.match(functionBody("function mergeVtuberRecordIdentity"), /const sourceUrl = cleanText\(item\.sourceUrl\)/u);
  assert.match(functionBody("function isCompositeChannelName"), /(?:ch\\\.\?|channel|ちゃんねる|チャンネル)/u);
});

test("delayed trend diffs update visible badges without rerendering the list for all trend", () => {
  const scheduleBody = functionBody("function scheduleCurrentRankDiffLoad");
  assert.match(scheduleBody, /state\.runtimeApi\.available/u);
  assert.match(scheduleBody, /updateQueryAvailability\(\)/u);
  assert.match(scheduleBody, /state\.trend === "all"[\s\S]*updateVisibleTrendBadges\(\)/u);
  assert.match(scheduleBody, /else \{[\s\S]*render\(\{ syncUrl: false \}\)/u);

  const sanitizeBody = functionBody("function sanitizeQueryDraft");
  assert.match(sanitizeBody, /state\.runtimeApi\.available \? \{ \.\.\.next, trend: "all" \} : next/u);
  const normalizeBody = functionBody("function normalizeTrendStateForRuntime");
  assert.match(normalizeBody, /state\.trend = "all"/u);
  assert.match(normalizeBody, /state\.queryDraft = \{ \.\.\.state\.queryDraft, trend: "all" \}/u);
  const availabilityBody = functionBody("function updateQueryAvailability");
  assert.match(availabilityBody, /els\.trendFilterGroup\.hidden = state\.runtimeApi\.available/u);
  assert.doesNotMatch(availabilityBody, /API模式暂不支持趋势筛选/u);
  assert.match(functionBody("async function loadRankDiffForRange"), /if \(state\.runtimeApi\.available\) return false/u);
  assert.match(functionBody("async function filterRequestIndexEntries"), /!state\.runtimeApi\.available && filters\.trend/u);

  const updateBody = functionBody("function updateVisibleTrendBadges");
  assert.match(updateBody, /querySelectorAll\("\.rank-row\[data-trend-mode\]\[data-trend-key\]"\)/u);
  assert.match(updateBody, /querySelector\("\.rank-side-trend"\)/u);
  assert.match(updateBody, /trendSlot\.replaceChildren\(\)/u);
  assert.doesNotMatch(updateBody, /els\.content\.replaceChildren|render\(/u);
});

test("API request summaries show entity totals and song collection counts", () => {
  const summaryBody = functionBody("function renderRequestSummary");
  assert.match(summaryBody, /metrics\.push\(metric\(occurrenceCount, "条歌曲收录"\)\)/u);
  assert.match(summaryBody, /metrics\.push\(metric\(occurrenceCount, "个时间戳"\)\)/u);
  assert.doesNotMatch(summaryBody, /metrics\.push\(metric\(videoCount,/u);
  assert.doesNotMatch(summaryBody, /metrics\.push\(metric\(videoCount, "个视频"\)\)/u);
});

test("selection builds only the records needed by the current view", () => {
  const selectionBody = functionBody("function currentSelection");
  assert.match(selectionBody, /const key = `\$\{state\.view\}::/u);
  assert.doesNotMatch(selectionBody, /const baseSongRecords/u);
  assert.doesNotMatch(selectionBody, /buildArtistRecords\(occurrences\)[\s\S]*buildSongRecords\(occurrences\)/u);

  const prewarmBody = functionBody("async function prewarmDefaultSorts");
  assert.match(prewarmBody, /if \(state\.view === "videos"\) return/u);
  assert.ok(prewarmBody.indexOf('state.view === "artistRank"') < prewarmBody.indexOf("selectedSongRecords"));
  assert.match(prewarmBody, /state\.view === "vtuberRank"[\s\S]*cache\.nicheVtuberRecords[\s\S]*cache\.allVtuberRecords/u);
  assert.match(functionBody("function createRangeCacheObject"), /defineLazyVtuberCache\(cache, "all", occurrences\)/u);
  assert.match(functionBody("function createRangeCacheObject"), /defineLazyVtuberCache\(cache, "niche", nicheOccurrences\)/u);
});

test("explicit search scopes query text by current view", () => {
  const selectionBody = functionBody("function currentSelection");
  assert.match(selectionBody, /occurrenceSearchTextForCurrentView\(occurrence\)\.includes\(filterKey\)/u);
  assert.doesNotMatch(selectionBody, /baseOccurrences\.filter\(\(occurrence\) => occurrence\.searchText\.includes\(filterKey\)\)/u);

  const scopedSearchBody = functionBody("function occurrenceSearchTextForCurrentView");
  assert.match(scopedSearchBody, /state\.view === "artistRank"[\s\S]*artistOccurrenceSearchText\(occurrence\)/u);
  assert.match(scopedSearchBody, /state\.view === "vtuberRank"[\s\S]*vtuberOccurrenceSearchText\(occurrence\)/u);
  assert.match(scopedSearchBody, /state\.view === "songRank" \|\| state\.view === "songAz"[\s\S]*songOccurrenceSearchText\(occurrence\)/u);
  assert.match(scopedSearchBody, /return occurrence\?\.searchText \|\| ""/u);
  assert.match(functionBody("function queryDraftOccurrences"), /songOccurrenceSearchText\(occurrence, draft\.searchFields\)\.includes\(filterKey\)/u);

  const songScopedSearchBody = functionBody("function songOccurrenceSearchText");
  assert.match(songScopedSearchBody, /item\.videoId,[\s\S]*item\.title,[\s\S]*item\.channelName,[\s\S]*item\.channelHandle,[\s\S]*item\.channelId,[\s\S]*item\.keyword,[\s\S]*song\.title,[\s\S]*song\.artist/u);
  assert.match(songScopedSearchBody, /if \(fields\.includes\("title"\)\) parts\.push\(song\.title\)/u);
  assert.match(songScopedSearchBody, /if \(fields\.includes\("artist"\)\) parts\.push\(song\.artist\)/u);
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

  assert.doesNotMatch(functionBody("function bindQueryOverlayEvents"), /searchSuggestions/u);
  assert.doesNotMatch(functionBody("function hydrateQueryOverlayAfterFirstFrame"), /scheduleSearchSuggestions/u);
  assert.doesNotMatch(appSource, /id="searchSuggestions"|function renderSearchSuggestions|scheduleSearchSuggestions/u);
  const shellBody = functionBody("function prepareQueryPreviewShell");
  assert.match(shellBody, /els\.queryResultPreview\.textContent = "可查看结果"/u);
  assert.match(shellBody, /els\.applyQueryButton\.disabled = false;[\s\S]*els\.applyQueryButton\.textContent = "查看结果"/u);
  assert.doesNotMatch(shellBody, /正在计算|查看 \$\{cached\}/u);
  const previewBody = functionBody("async function renderQueryDraftPreview");
  assert.doesNotMatch(previewBody, /resolveQueryDraftResultCount\(draft/u);
  assert.doesNotMatch(previewBody, /const count = queryDraftResultCount\(draft\)/u);
  const resolveBody = functionBody("async function resolveQueryDraftResultCount");
  assert.match(resolveBody, /canUseRequestRuntime\(state\.range\)[\s\S]*requestQueryDraftResultCount\(draft, options\)/u);
  const requestCountBody = functionBody("async function requestQueryDraftResultCount");
  assert.match(requestCountBody, /requestViewPage\(\{[\s\S]*filters: requestFilterStateFromDraft\(draft\),[\s\S]*prefetch: true,[\s\S]*signal: options\.signal/u);
  assert.match(requestCountBody, /setCurrentResultSummary\(draft, result\.totalCount\);[\s\S]*return result\.totalCount;/u);
  const draftFilterBody = functionBody("function requestFilterStateFromDraft");
  assert.match(draftFilterBody, /q: draft\.q \|\| ""/u);
  assert.match(draftFilterBody, /searchScope: draft\.searchScope \|\| "all"/u);
  assert.match(draftFilterBody, /searchFields: draft\.searchFields \|\| DEFAULT_SEARCH_FIELDS/u);
  assert.match(draftFilterBody, /hideUnknownArtist: queryDraftHideUnknownForView\(draft\)/u);
  const countBody = functionBody("function queryDraftResultCount");
  assert.doesNotMatch(countBody, /buildSongRecords|buildArtistRecords|buildVideoViewItems/u);
  assert.match(countBody, /queryResultCountCache/u);
  assert.match(functionBody("function queryResultCountKey"), /draft\.searchScope \|\| "all"/u);
  assert.match(functionBody("function queryResultCountKey"), /normalizedSearchFieldKey\(draft\.searchFields \|\| DEFAULT_SEARCH_FIELDS\)/u);
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
