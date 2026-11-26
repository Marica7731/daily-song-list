"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readDayVideos } = require("../scripts/static/collect-and-build");
const { hashNormalizedText, validateCurationOverrides } = require("../scripts/curation");

const id = "uuxqNYVtNN4";
const sourceId = "Ugzdfg27pl1BQlPbJ7l4AaABAg";
const sourceHash = "8f76f84ee84d1a11034bb839a3af1be3f761c47e82f2a69674c4dda8b4631406";
const lostSong = { occurrenceId: id + ":31:974", seconds: 974, title: "がらくた", artist: "", sourceId, sourceHash,
  raw: "00:16:14 [01] がらくた / 米津玄師 (2024) 映画「ラストマイル」主題歌" };
const regularSong = { occurrenceId: id + ":79:1991", seconds: 1991, title: "怪獣の花唄", artist: "Vaundy", sourceId, sourceHash,
  raw: "00:33:11 [02] 怪獣の花唄 / Vaundy (2020)" };
const patch = { action: "replace_entry", videoId: id, occurrenceId: lostSong.occurrenceId, seconds: 974, sourceId, sourceHash,
  rawHash: hashNormalizedText(lostSong.raw), replacement: { title: "がらくた", artist: "米津玄師" },
  reason: "verified performance", reviewedAt: "2026-11-26T18:34:00Z", reviewedBy: "dot", reviewedStaticPrefilterRecovery: true };
const wrap = (records) => ({ schemaVersion: 1, records });

test("the normal raw-day path admits a prefiltered performance only for a full reviewed match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-static-prefilter-"));
  try {
    const folder = path.join(dir, "days");
    fs.mkdirSync(folder);
    const file = path.join(folder, "2026-11-26.json");
    const run = (record, changes = {}, videoId = id) => {
      fs.writeFileSync(file, JSON.stringify({ videos: [{videoId, selectedSourceId: sourceId, selectedSourceHash: sourceHash,
        title: "歌枠", songs: [{...lostSong,...changes}, regularSong]}] }));
      const result = validateCurationOverrides(wrap(record ? [record] : []));
      assert.equal(result.valid, true, result.errors.join("\n"));
      return readDayVideos(dir, [], { overrides: result.overrides })[0].songs;
    };
    const { reviewedStaticPrefilterRecovery: _unused, ...unflagged } = patch;
    const plain = run(null);
    assert.deepEqual(plain.map(x=>x.title), ["怪獣の花唄"]);
    assert.deepEqual(run(unflagged), plain);
    const recovered = run(patch);
    assert.deepEqual(recovered, [{...lostSong,artist:"米津玄師"}, ...plain]);
    for (const change of [
      {sourceId: "different"}, {sourceHash: "a".repeat(64)}, {seconds: 975},
      {raw: lostSong.raw + " 予告"}, {occurrenceId: id + ":32:974"}
    ]) {
      assert.deepEqual(run(patch, change), plain);
    }
    assert.deepEqual(run(patch, {}, "xuxqNYVtNN4"), plain);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery flag fails closed for partial, altered time, and unreviewed exceptions", () => {
  assert.equal(validateCurationOverrides(wrap([patch])).valid,true);
  for (const mutation of [
    { sourceId: "" }, { sourceHash: "bad" }, { rawHash: "" }, { seconds: 975 },
    { reviewedBy: "" }, { reviewedAt: "" }, { reason: "" }, { action: "force_keep" },
    { replacement: { ...patch.replacement, seconds: 974 } }, { reviewedStaticPrefilterRecovery: "true" },
  ]) assert.ok(validateCurationOverrides(wrap([{...patch,...mutation}])).errors.some(e=>e.includes("reviewedStaticPrefilterRecovery")));
});
