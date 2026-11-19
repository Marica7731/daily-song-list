const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const asset = (file) => fs.readFileSync(path.join(__dirname, "../assets", file), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const base = "data/static/v1/";

function element(value = "") {
  const listeners = new Map();
  return {
    value, dataset: {}, attributes: {}, textContent: "", children: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector: () => element(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  };
}

const rank = (range, name, type = "songs") => [
  `rankings/${range}/${type}/page-0001.json`, { items: [{ name, rank: 1 }] },
];

function buildView() {
  const ranking = { pageCount: 1, totalCount: 1 };
  const range = (count) => ({ stats: { videoCount: count }, songs: ranking, artists: ranking });
  const payloads = new Map([
    ["meta.json", {
      generatedAt: "2026-11-19T09:00:00Z",
      ranges: { today: range(2), "3d": range(5), all: range(8) },
    }],
    rank("today", "Today Song"), rank("3d", "Three Day Song"), rank("all", "All Song"),
    rank("today", "Today Artist", "artists"),
    ["search/manifest.json", { shards: [{ path: "search/fixture.json" }] }],
    ["search/fixture.json", { items: ["17", "*Luna"].map((name) => ({
      type: "songs", name, occurrenceCount: 9, videoCount: 8,
      rangeMetrics: { today: { occurrenceCount: 3, videoCount: 2 }, "3d": { occurrenceCount: 6, videoCount: 5 } },
    })) }],
  ]);
  const nodes = new Map([["range", element("today")], ["type", element("songs")]]);
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const waits = new Map();
  const requests = [];
  const errors = [];
  let timer;
  const context = vm.createContext({
    document: {
      getElementById: get,
      documentElement: element(),
      querySelector: () => element(),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element(),
      createDocumentFragment: () => element(),
    },
    fetch: async (url) => {
      assert.ok(url.startsWith(base));
      const relative = url.slice(base.length);
      requests.push(relative);
      if (waits.has(relative)) await waits.get(relative);
      return {
        ok: payloads.has(relative),
        status: 404,
        json: async () => payloads.get(relative),
      };
    },
    setTimeout: (fn) => { timer = fn; },
    clearTimeout: () => { timer = null; },
    console: { error: (error) => errors.push(error) },
  });
  vm.runInContext(asset("static-search-utils.js"), context);
  vm.runInContext(asset("static-app.js"), context);
  return {
    get, requests, errors,
    input(id, value, type = "input") {
      get(id).value = value;
      get(id).dispatchEvent({ type });
    },
    flushSearch() { const run = timer; timer = null; run(); },
    hold(relative) {
      let resolve;
      waits.set(relative, new Promise((done) => { resolve = done; }));
      return resolve;
    },
    firstRow() { return get("ranking").children[0]?.children[1]?.innerHTML; },
  };
}

test("last selected range wins even if an older ranking fetch finishes later", async () => {
  const view = buildView();
  await settle();
  const release = view.hold(rank("3d")[0]);
  view.input("range", "3d", "change");
  view.input("range", "all", "change");
  await settle();
  assert.match(view.firstRow(), /All Song/);
  release();
  await settle();
  assert.match(view.firstRow(), /All Song/);
  assert.match(view.get("summary").textContent, /全部/);
  assert.match(view.get("status").textContent, /8 个视频/);
  assert.equal(view.get("ranking").attributes["aria-busy"], "false");
});

test("overlapping searches share the download and keep only the current query/range", async () => {
  const view = buildView();
  await settle();
  const release = view.hold("search/fixture.json");
  view.input("search", "*Luna");
  view.flushSearch();
  await settle();
  view.input("range", "3d", "change");
  view.input("search", "17");
  view.flushSearch();
  release();
  await settle();
  assert.equal(view.requests.filter((request) => request === "search/manifest.json").length, 1);
  assert.equal(view.requests.filter((request) => request === "search/fixture.json").length, 1);
  assert.match(view.firstRow(), /17/);
  assert.match(view.get("summary").textContent, /近 3 天搜索.*17/);
  assert.match(view.get("status").textContent, /5 个视频/);
});

test("punctuation-only input returns to the ranking without loading search or erroring", async () => {
  const view = buildView();
  await settle();
  view.input("search", "*");
  view.flushSearch();
  await settle();
  assert.equal(view.errors.length, 0);
  assert.match(view.firstRow(), /Today Song/);
  assert.equal(view.requests.filter((request) => request === rank("today")[0]).length, 2);
  assert.ok(!view.requests.includes("search/manifest.json"));
});
