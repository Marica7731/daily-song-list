const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(__dirname, "..", "assets", "styles.css"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("mobile information architecture exposes one-row toolbar, bottom nav, search, filter, and detail dialogs", () => {
  assert.match(indexSource, /id="openSearchButton"/u);
  assert.match(indexSource, /id="openFilterButton"/u);
  assert.match(indexSource, /id="mobileBottomNav"[\s\S]*data-view="songRank"[\s\S]*data-view="artistRank"[\s\S]*data-view="songAz"[\s\S]*data-view="videos"/u);
  assert.match(indexSource, /id="searchDialog"[\s\S]*role="dialog"[\s\S]*id="searchSuggestions"/u);
  assert.match(indexSource, /id="filterDialog"[\s\S]*role="dialog"[\s\S]*id="trendFilterSelect"[\s\S]*id="minCountSelect"/u);
  assert.match(indexSource, /id="detailDialog"[\s\S]*role="dialog"[\s\S]*id="detailSourceList"/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*grid-template-areas: "range actions"/u);
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.mobile-bottom-nav[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/u);
});

test("new URL state, filter draft, and detail state are wired through app state", () => {
  assert.match(appSource, /trend:\s*"all"/u);
  assert.match(appSource, /minCount:\s*1/u);
  assert.match(appSource, /detail:\s*""/u);
  assert.match(appSource, /validTrendFilters: Object\.keys\(TREND_FILTERS\)/u);
  assert.match(appSource, /validMinCounts: MIN_COUNT_OPTIONS/u);
  assert.match(appSource, /function makeFilterDraftFromState/u);
  assert.match(appSource, /function applyFilterDraft/u);
  assert.match(appSource, /function detailParam/u);
});

test("source detail is external and initially batched", () => {
  assert.match(appSource, /const DETAIL_BATCH_SIZE = 20/u);
  assert.match(appSource, /data-open-detail/u);
  assert.match(appSource, /function renderDetailSources/u);
  assert.match(appSource, /filtered\.slice\(0, state\.detailSourceLimit\)/u);
  assert.match(appSource, /function groupOccurrencesByVideo/u);
  assert.match(appSource, /openDetail\(sourceToggle\.dataset\.detail/u);
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
  assert.match(appSource, /variant === "top"[\s\S]*`\$\{pageInfo\.startIndex \+ 1\}-\$\{pageInfo\.endIndex\} \/ \$\{pageInfo\.total\}/u);
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
