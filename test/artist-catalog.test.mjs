import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  analyzeArtistCatalogSong,
  loadArtistCatalogGate,
  resetArtistCatalogCache,
} = require("../scripts/static/artist-catalog.js");

test("Kasamura Tota catalog uses the official artist name and a 65-title gate", () => {
  resetArtistCatalogCache();
  const catalog = loadArtistCatalogGate().catalogs.find((item) => item.id === "kasamura-tota");
  assert.ok(catalog);
  assert.equal(catalog.officialName, "傘村トータ");
  assert.equal(catalog.maxUniqueTitles, 65);
  assert.equal(catalog.officialTitles.length, 65);
  assert.equal(new Set(catalog.officialTitles).size, 65);
});

test("official aliases and reviewed title variants canonicalize instead of being archived", () => {
  const repaired = analyzeArtistCatalogSong({
    title: "開けない夜のリリィ",
    artist: "傘村トーた",
  });
  assert.equal(repaired.matched, true);
  assert.equal(repaired.archived, false);
  assert.equal(repaired.song.title, "明けない夜のリリィ");
  assert.equal(repaired.song.artist, "傘村トータ");
  assert.equal(repaired.song.canonicalTitle, "明けない夜のリリィ");
  assert.equal(repaired.song.canonicalArtist, "傘村トータ");

  const embedded = analyzeArtistCatalogSong({
    title: "贖罪🎤🐟傘村トータ",
    artist: "ver.",
  });
  assert.equal(embedded.matched, true);
  assert.equal(embedded.archived, false);
  assert.equal(embedded.song.title, "贖罪");
  assert.equal(embedded.song.artist, "傘村トータ");
});

test("confirmed non-release and miscredited titles are archived without touching other artists", () => {
  const archived = analyzeArtistCatalogSong({
    title: "ラブレター",
    artist: "傘村トータ",
  });
  assert.equal(archived.matched, true);
  assert.equal(archived.archived, true);
  assert.equal(archived.reason, "outside_official_release_catalog");

  const otherArtist = analyzeArtistCatalogSong({
    title: "目抜き通り",
    artist: "椎名林檎とトータス松本",
  });
  assert.equal(otherArtist.matched, false);
});
