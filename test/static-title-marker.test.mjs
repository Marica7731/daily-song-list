import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { canonicalizeStaticSong } = require("../scripts/static/yorushika-catalog");

test("leading new-song markers are removed from derived static titles", () => {
  const cleaned = canonicalizeStaticSong({
    title: "🆕 もう森へ帰ろうか？",
    artist: "欅坂46",
  });

  assert.equal(cleaned.title, "もう森へ帰ろうか？");
  assert.equal(cleaned.originalTitle, "🆕 もう森へ帰ろうか？");
  assert.equal(cleaned.titleRepair, "leading_new_marker");
  assert.equal(cleaned.artist, "欅坂46");
});

test("new-song marker cleanup still allows official Yorushika canonicalization", () => {
  const cleaned = canonicalizeStaticSong({
    title: "🆕 晴る",
    artist: "ヨルシカ",
  });

  assert.equal(cleaned.title, "晴る");
  assert.equal(cleaned.artist, "ヨルシカ");
  assert.equal(cleaned.originalTitle, "🆕 晴る");
});
