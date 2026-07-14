const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "assets", "styles.css"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const verifySource = fs.readFileSync(path.join(__dirname, "..", "scripts", "verify-local-performance.js"), "utf8");

test("mobile information architecture exposes one-row toolbar, bottom nav, search, and filter dialogs", () => {
  assert.match(indexSource, /id="openSearchButton"/u);
  assert.match(indexSource, /id="openFilterButton"/u);
  assert.match(indexSource, /id="mobileBottomNav"[\s\S]*data-view="songRank"[\s\S]*data-view="artistRank"[\s\S]*data-view="songAz"[\s\S]*data-view="videos"/u);
  assert.match(indexSource, /id="searchDialog"[\s\S]*role="dialog"[\s\S]*id="searchSuggestions"/u);
  assert.match(indexSource, /id="filterDialog"[\s\S]*role="dialog"[\s\S]*id="trendFilterSelect"[\s\S]*id="minCountSelect"/u);
  assert.doesNotMatch(indexSource, /id="detailDialog"/u);
  assert.match(indexSource, /class="filter-toggle-list"/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*grid-template-areas: "range actions"/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.mobile-bottom-nav[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.doesNotMatch(cssSource, /@media \(max-width: 620px\)/u);
});

test("new URL state, filter draft, and share state are wired through app state", () => {
  assert.match(appSource, /trend:\s*"all"/u);
  assert.match(appSource, /minCount:\s*1/u);
  assert.match(appSource, /sharedUrlApplied:\s*false/u);
  assert.match(appSource, /validTrendFilters: Object\.keys\(TREND_FILTERS\)/u);
  assert.match(appSource, /validMinCounts: MIN_COUNT_OPTIONS/u);
  assert.match(appSource, /function makeFilterDraftFromState/u);
  assert.match(appSource, /function applyFilterDraft/u);
  assert.match(appSource, /function buildShareUrl/u);
  assert.match(appSource, /includeShared:\s*true/u);
});

test("source drawer is inline, grouped, and visible on mobile", () => {
  assert.doesNotMatch(appSource, /DETAIL_BATCH_SIZE|data-open-detail|function renderDetailSources|openDetail\(/u);
  assert.match(appSource, /toggleSourceDrawer\(sourceToggle\.closest\("\.rank-row, \.index-row"\)\)/u);
  assert.match(appSource, /FrontendUtils\.groupOccurrencesByVideo\(occurrences\)/u);
  assert.match(appSource, /const SOURCE_TIMESTAMP_INITIAL_LIMIT = 10/u);
  assert.match(appSource, /const SOURCE_MOBILE_GROUP_INITIAL_LIMIT = 3/u);
  assert.match(appSource, /const SOURCE_MOBILE_GROUP_BATCH_SIZE = 3/u);
  assert.match(appSource, /查看更多来源（剩余 \$\{remaining\}）/u);
  assert.match(appSource, /dataset\.collapseSource = "true"/u);
  assert.match(appSource, /dataset\.copySongLinks = "true"/u);
  assert.match(appSource, /buildSongSourceLinksText\(occurrences\)/u);
  assert.match(appSource, /closeOtherMobileSourceDrawers\(row\)/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.rank-row\s*\{[\s\S]*"rank content count"[\s\S]*"drawer drawer drawer"/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.rank-header\s*\{[\s\S]*display: none/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.source-drawer\s*\{[\s\S]*grid-column: 1 \/ -1;[\s\S]*grid-row: 2;[\s\S]*width: 100%;[\s\S]*min-width: 0;/u);
  assert.doesNotMatch(cssSource, /\.source-drawer\s*\{[\s\S]*grid-area: drawer/u);
  assert.doesNotMatch(cssSource, /@media \(max-width: 720px\)[\s\S]*\.source-drawer\s*\{[\s\S]*display: none/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.rank-count\.is-strong\s*\{[\s\S]*background: transparent;[\s\S]*color: var\(--muted\);/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.rank-row\.rank-top-1,[\s\S]*\.rank-row\.rank-top-2,[\s\S]*\.rank-row\.rank-top-3\s*\{[\s\S]*border-left-color: transparent;/u);
  assert.match(cssSource, /\.filter-count\[hidden\]\s*\{[\s\S]*display: none;/u);
});

test("third-round mobile component rules are encoded in css and browser checks", () => {
  assert.match(cssSource, /--radius-control:\s*8px/u);
  assert.match(cssSource, /--control-compact:\s*36px/u);
  assert.match(cssSource, /--control-default:\s*44px/u);
  assert.match(cssSource, /--control-large:\s*48px/u);
  assert.match(cssSource, /--rank-leading-width:\s*44px/u);
  assert.match(cssSource, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/u);
  assert.match(cssSource, /\.sheet-toggle\s*\{[\s\S]*align-items: center;[\s\S]*min-height: var\(--control-large\);[\s\S]*border-radius: var\(--radius-control\);/u);
  assert.match(cssSource, /\.sheet-actions\s*\{[\s\S]*display: grid;[\s\S]*grid-template-columns: 1fr 1fr/u);
  assert.match(cssSource, /\.rank-actions-line\s*\{[\s\S]*gap: var\(--space-2\);/u);
  assert.match(cssSource, /\.rank-trend-inline\s*\{[\s\S]*width: max-content;[\s\S]*max-width: 120px;/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.source-drawer\s*\{[\s\S]*gap: 0;/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.source-video-group\s*\{[\s\S]*padding: var\(--space-3\) 0 var\(--space-3\) var\(--rank-leading-width\);/u);
  assert.match(cssSource, /@media \(max-width: 340px\)[\s\S]*\.source-video-header/u);
  assert.match(verifySource, /async function mobileFilterSheetFlow/u);
  assert.match(verifySource, /async function mobileRankVisualGeometry/u);
  assert.match(verifySource, /filter-sheet-bottom-\$\{viewport\.join\("x"\)\}\.png/u);
  assert.match(verifySource, /rank-expanded-trend-\$\{viewport\.join\("x"\)\}\.png/u);
});

test("search suggestions highlight safely without assigning untrusted innerHTML", () => {
  const highlightBody = functionBody("function appendHighlightedText");
  assert.match(highlightBody, /document\.createElement\("mark"\)/u);
  assert.match(highlightBody, /mark\.textContent/u);
  assert.doesNotMatch(highlightBody, /innerHTML/u);
  assert.match(appSource, /RECENT_SEARCHES_KEY/u);
});

test("range cache song records are lazy getters", () => {
  assert.match(appSource, /defineLazySongCache\(cache, "allSongRecords"/u);
  assert.match(appSource, /defineLazySongCache\(cache, "nicheSongRecords"/u);
  assert.match(appSource, /defineLazySongCache\(cache, "visibleSongRecords"/u);
  assert.match(appSource, /defineLazySongCache\(cache, "visibleNicheSongRecords"/u);
  assert.doesNotMatch(functionBody("function createRangeCache"), /buildSongRecords/u);
});

test("mobile summary and pagination have compact rules", () => {
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.summary-range,[\s\S]*\.summary-actions[\s\S]*display: none/u);
  assert.match(appSource, /summary-metrics/u);
  assert.match(appSource, /variant === "top"[\s\S]*`\$\{pageInfo\.startIndex \+ 1\}-\$\{pageInfo\.endIndex\} \/ \$\{pageInfo\.total\}/u);
  assert.match(appSource, /const compactTop = isMobileViewport\(\)/u);
  assert.match(appSource, /renderPageButton\("上一页"[\s\S]*\{ icon: "prev" \}/u);
  assert.match(appSource, /renderPageButton\("下一页"[\s\S]*\{ icon: "next" \}/u);
  assert.match(appSource, /if \(!compactTop\) controls\.append\(renderPageJumpControl\(pageInfo\)\)/u);
  assert.match(appSource, /function renderPageJumpControl/u);
});

function functionBody(signature) {
  const start = appSource.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const braceStart = appSource.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < appSource.length; index += 1) {
    const char = appSource[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return appSource.slice(braceStart, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}
