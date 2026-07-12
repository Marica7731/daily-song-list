const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const appSource = fs.readFileSync(path.join(__dirname, "..", "assets", "app.js"), "utf8");

test("initial app load does not fetch full latest or rank diffs in init", () => {
  const initBody = functionBody("async function init");
  assert.doesNotMatch(initBody, /readJson\(SNAPSHOT_LATEST_PATH/u);
  assert.doesNotMatch(initBody, /loadRankDiff/u);
  assert.match(initBody, /loadRuntimeRange\(initialRange\)/u);
  assert.match(initBody, /UI_META_PATH/u);
});

test("range cache and trend Map are wired into rendering", () => {
  assert.match(appSource, /rangeCache:\s*new Map\(\)/u);
  assert.match(appSource, /currentSelection\(rangeCache\)/u);
  assert.match(functionBody("function trendForRecord"), /\.get\(record\.key\)/u);
});

test("record videoCount is used for rank values and row rendering", () => {
  assert.match(functionBody("function rankValue"), /record\.videoCount/u);
  assert.doesNotMatch(functionBody("function rankValue"), /uniqueVideoCount/u);
  assert.match(appSource, /videoCount:\s*record\.videoCount/u);
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
