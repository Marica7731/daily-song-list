import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canonicalizeStaticSong, loadYorushikaCatalog, shouldPublishStaticSong } = require("../scripts/static/yorushika-catalog.js");
const { compareSearchResults } = require("../assets/static-search-utils.js");

test("yorushika catalog repairs swapped and fragmented derived song identities", () => {
  assert.deepEqual(canonicalizeStaticSong({ title: "ヨルシカ", artist: "晴る" }), {
    title: "晴る",
    artist: "ヨルシカ",
    originalTitle: "ヨルシカ",
    originalArtist: "晴る",
    canonicalTitle: "晴る",
    canonicalArtist: "ヨルシカ",
    catalogRepair: "yorushika_official_catalog",
  });
  assert.equal(canonicalizeStaticSong({ title: "𝟎𝟏. ノーチラス", artist: "ヨルシカ" }).title, "ノーチラス");
  assert.equal(canonicalizeStaticSong({ title: "盜作", artist: "ヨルシカ" }).title, "盗作");
  assert.equal(canonicalizeStaticSong({ title: "若者のすべて", artist: "suis from ヨルシカ" }).artist, "ヨルシカ");
  assert.deepEqual(
    canonicalizeStaticSong({ title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" }),
    { title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" },
  );
  assert.deepEqual(
    canonicalizeStaticSong({ title: "声", artist: "Aimer" }),
    { title: "声", artist: "Aimer" },
  );
});

test("yorushika publishes only catalog-covered songs after alias repair", () => {
  assert.equal(loadYorushikaCatalog().titles.length, 82);
  const officialVariants = [
    { title: "Hitchcock", artist: "ヨルシカ" },
    { title: "Shayou", artist: "ヨルシカ" },
    { title: "26┊だから僕は音楽をやめた", artist: "ヨルシカ" },
    { title: "ただきみに晴れ", artist: "ヨルシカ" },
    { title: "花に亡霊", artist: "ヨルシカ" },
  ];
  for (const song of officialVariants) {
    assert.equal(shouldPublishStaticSong(song), true, song.title);
  }
  assert.equal(canonicalizeStaticSong(officialVariants[0]).title, "ヒッチコック");
  assert.equal(canonicalizeStaticSong(officialVariants[2]).title, "だから僕は音楽を辞めた");

  assert.equal(shouldPublishStaticSong({ title: "夜に駆ける", artist: "ヨルシカ" }), false);
  assert.equal(shouldPublishStaticSong({ title: "若者のすべて", artist: "suis from ヨルシカ" }), false);
  assert.deepEqual(
    canonicalizeStaticSong({ title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" }),
    { title: "ナイトルーティーン feat.suis from ヨルシカ", artist: "キタニタツヤ" },
  );
  assert.deepEqual(
    canonicalizeStaticSong({ title: "声", artist: "Aimer" }),
    { title: "声", artist: "Aimer" },
  );
  assert.equal(shouldPublishStaticSong({ title: "声", artist: "Aimer" }), true);
});

test("yorushika search orders exact artist matches by occurrence count", () => {
  const items = [
    { name: "ヨルシカ", secondary: "晴る", occurrenceCount: 1, videoCount: 1 },
    { name: "花に亡霊", secondary: "ヨルシカ", occurrenceCount: 494, videoCount: 493 },
    { name: "ヨルシカ ｰ 嘘月", secondary: "練歌", occurrenceCount: 1, videoCount: 1 },
  ];
  const sorted = [...items].sort((left, right) => compareSearchResults(left, right, "ヨルシカ"));
  assert.deepEqual(sorted.map((item) => item.occurrenceCount), [494, 1, 1]);
});

test("static search exposes real result pagination", () => {
  const app = fs.readFileSync(path.resolve("assets/static-app.js"), "utf8");
  assert.match(app, /compareSearchResults\(left, right, raw\)/u);
  assert.match(app, /state\.pageCount = Math\.max\(1, Math\.ceil\(results\.length \/ 50\)\)/u);
  assert.match(app, /render\(pageResults\);\s*renderPager\(\);/u);
  assert.doesNotMatch(app, /el\.page\.textContent = "搜索"/u);
  assert.doesNotMatch(app, /function goPage\(target\) \{\s*if \(el\.search\.value\.trim\(\)\) return;/u);
});
