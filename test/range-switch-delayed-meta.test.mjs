import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets", "app.js"));
const appText = app.toString("utf8");
const index = readFileSync(join(root, "index.html"), "utf8");
const bundleMatch = index.match(/assets\/app-h([0-9a-f]{12})\.js/u);
assert.ok(bundleMatch, "fingerprinted app bundle is missing");
assert.equal(index.match(/assets\/app-h[0-9a-f]{12}\.js/gu)?.length, 1);
const bundle = readFileSync(join(root, "assets", `app-h${bundleMatch[1]}.js`));
assert.equal(Buffer.compare(app, bundle), 0, "app.js and fingerprint bundle differ");

for (const pattern of [
  /rangeIntent/u,
  /initializationMetaPending/u,
  /if \(state\.initializationMetaPending\)/u,
  /isCurrentRangeIntent/u,
  /expectedRange/u,
  /loadRuntimeRange\(requestedRange\)/u,
]) assert.match(appText, pattern);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const state = {
  range: "7d",
  rangeIntent: "7d",
  initializationMetaPending: true,
  skeleton: true,
  loadedRange: null,
  toastCount: 0,
};
const requests = [];
const meta = deferred();
const load = (range) => {
  const pending = deferred();
  requests.push({ range, pending });
  return pending.promise;
};
const accept = (result, expectedRange) => {
  if (state.rangeIntent !== expectedRange || state.range !== expectedRange) return false;
  state.loadedRange = result.range;
  state.skeleton = false;
  return true;
};
const init = meta.promise.then(async () => {
  state.initializationMetaPending = false;
  const requestedRange = state.rangeIntent;
  return accept(await load(requestedRange), requestedRange);
});
const stale7d = load("7d");
state.range = "all";
state.rangeIntent = "all";
assert.equal(state.skeleton, true);
requests.find((entry) => entry.range === "7d").pending.resolve({ range: "7d" });
assert.equal(accept(await stale7d, "7d"), false);
assert.equal(state.loadedRange, null);
meta.resolve();
await Promise.resolve();
const all = requests.find((entry) => entry.range === "all");
assert.ok(all, "meta readiness must request the latest range intent");
assert.equal(requests.filter((entry) => entry.range === "all").length, 1);
all.pending.resolve({ range: "all" });
await init;
assert.equal(state.loadedRange, "all");
assert.equal(state.skeleton, false);
assert.equal(state.toastCount, 0);

console.log("RANGE_SWITCH_DELAYED_META_OK tests=2 failed=0");
