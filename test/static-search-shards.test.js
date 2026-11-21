"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeSearch } = require("../scripts/static/collect-and-build");

const now = new Date("2026-11-21T02:30:00.000Z");
const entity = (id, name) => ({ id, type: "songs", name, text: name, secondary: "歌手" });
const size = (items) => Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1, generatedAt: now.toISOString(), items }, null, 2)}\n`);
const workspace = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-search-shards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

test("a search bucket at its exact encoded byte limit retains the existing path", (t) => {
  const root = workspace(t);
  const items = [entity("301", "あいう😀"), entity("302", '引用 "a"\n風')];
  writeSearch(root, items, now, size(items));
  const manifest = read(root, "search/manifest.json");
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.shards, [{ bucket: "3", path: "search/3.json", itemCount: 2, bytes: size(items) }]);
  assert.deepEqual(read(root, "search/3.json").items, items);
});

test("an overflowing bucket splits in input order without changing other buckets", (t) => {
  const root = workspace(t);
  const items = [
    entity("3ffd", "同じ名前🎵"),
    entity("300a", "同じ名前🎵"),
    entity("3ccc", "同じ名前🎵"),
    entity("3bbb", "同じ名前🎵"),
    entity("3aaa", "同じ名前🎵"),
  ];
  const ordinary = entity("81", "通常");
  const limit = size(items.slice(0, 2));
  const input = [items[0], ordinary, ...items.slice(1)];
  writeSearch(root, input, now, limit);
  const manifest = read(root, "search/manifest.json");
  assert.deepEqual(manifest.shards.map((s) => s.path), [
    "search/3-part-0001.json", "search/3-part-0002.json", "search/3-part-0003.json", "search/8.json",
  ]);
  assert.equal(fs.existsSync(path.join(root, "search/3.json")), false);
  assert.deepEqual(manifest.shards.flatMap((s) => {
    const itemFile = read(root, s.path);
    assert.equal(s.bytes, fs.statSync(path.join(root, s.path)).size);
    assert.equal(s.bytes, size(itemFile.items));
    assert.ok(s.bytes <= limit);
    assert.equal(s.itemCount, itemFile.items.length);
    return itemFile.items;
  }), [...items, ordinary]);
  writeSearch(root, input, now, limit);
  assert.deepEqual(read(root, "search/manifest.json"), manifest);
});

test("a single entity that cannot fit fails instead of publishing an incomplete manifest", (t) => {
  const root = workspace(t);
  const item = entity("3abc", "🎵漢字".repeat(50));
  assert.throws(() => writeSearch(root, [item], now, size([item]) - 1), /search entity 3abc exceeds shard limit/);
  assert.equal(fs.existsSync(path.join(root, "search/manifest.json")), false);
});
