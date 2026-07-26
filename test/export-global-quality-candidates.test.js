"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  exportGlobalQualityCandidates,
} = require("../scripts/export-global-quality-candidates");

const TALK_RAW_HASH = "66cb9e129f135600d5b881595110822a7e7bb01175eeb5d7d138763768188f1e";
const TALK_SOURCE_HASH = "5a84ddcb0ff7c6f66409f9d5b93f1c0c258769dbe6ad300a6b27a1907a37c07f";

test("complete candidate export preserves exact evidence and defaults unreviewed rows to keep", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-global-quality-export-"));
  try {
    const inventoryPath = path.join(root, "inventory.jsonl.gz");
    const inventoryMetaPath = path.join(root, "inventory-meta.json");
    const runtimePath = path.join(root, "runtime-singletons.jsonl.gz");
    const runtimeMetaPath = path.join(root, "runtime-singletons.meta.json");
    const curationPath = path.join(root, "curation-overrides.json");
    const aliasesPath = path.join(root, "song-aliases.json");
    const outputDir = path.join(root, "output");

    const inventory = [
      video("lUDCE3zZmuQ", "@naraetanV", [
        song(
          9463,
          "辛いことがある人生でも",
          "Even in a life full of hardships",
          TALK_RAW_HASH,
          "Ugxw2-DEUVx0aNsvVyR4AaABAg",
          TALK_SOURCE_HASH,
          "02:37:43 辛いことがある人生でも... / Even in a life full of hardships...",
        ),
      ]),
      video("Vx0HGME8hWw", "@naraetanV", [
        song(2667, "逆光（ウタ from ONE PIECE FILM RED）", "Ado", "alias-raw", "alias-source", "alias-hash"),
      ]),
      video("AAAAAAAAAAA", "@fixture", [
        song(10, "逆光", "Ado", "ado-1-raw", "ado-1-source", "ado-1-hash"),
      ]),
      video("BBBBBBBBBBB", "@fixture", [
        song(20, "逆光", "Ado", "ado-2-raw", "ado-2-source", "ado-2-hash"),
      ]),
      video("CCCCCCCCCCC", "@fixture", [
        song(30, "Mystery Song", "", "unknown-raw", "unknown-source", "unknown-hash"),
      ]),
      video("DDDDDDDDDDD", "@fixture", [
        song(40, "Mystery Song", "Known Artist", "known-raw", "known-source", "known-hash"),
      ]),
      video("EEEEEEEEEEE", "@fixture", [
        song(50, "逆光 - replica", "Vaundy", "vaundy-raw", "vaundy-source", "vaundy-hash"),
      ]),
    ];
    writeJsonlGzip(inventoryPath, inventory);
    writeJson(inventoryMetaPath, {
      schemaVersion: 1,
      videoCount: inventory.length,
      occurrenceCount: inventory.length,
      ...digest(inventoryPath),
    });

    const runtimeRows = [
      runtimeSingleton("runtime-talk", "talk-key", "lUDCE3zZmuQ", 9463, "辛いことがある人生でも", "Even in a life full of hardships"),
      runtimeSingleton("runtime-vaundy", "vaundy-key", "EEEEEEEEEEE", 50, "逆光 - replica", "Vaundy"),
    ];
    writeJsonlGzip(runtimePath, runtimeRows);
    writeJson(runtimeMetaPath, {
      schemaVersion: 1,
      status: "complete",
      rowCount: runtimeRows.length,
      db: { quickCheck: "ok" },
      output: { path: runtimePath, ...digest(runtimePath) },
    });

    writeJson(curationPath, {
      schemaVersion: 1,
      records: [
        {
          action: "drop_entry",
          videoId: "lUDCE3zZmuQ",
          sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg",
          sourceHash: TALK_SOURCE_HASH,
          seconds: 9463,
          rawHash: TALK_RAW_HASH,
          reason: "verified_translated_commentary_not_song",
          note: "[fixture-followup] Evidence: https://www.youtube.com/watch?v=lUDCE3zZmuQ&t=9463s",
          reviewedAt: "2026-07-26T16:36:56+08:00",
          reviewedBy: "codex",
        },
      ],
    });
    writeJson(aliasesPath, {
      schemaVersion: 1,
      records: [
        {
          artist: "Ado",
          canonicalTitle: "逆光",
          aliases: [
            "逆光",
            "逆光（ウタ from ONE PIECE FILM RED）",
          ],
          reason: "verified_same_song_official_album_title",
          batchTag: "fixture-followup",
          evidenceUrls: [
            "https://sp.universal-music.co.jp/ado/uta-no-uta/",
          ],
        },
      ],
    });

    const args = {
      inventory: inventoryPath,
      inventoryMeta: inventoryMetaPath,
      runtimeSingletons: runtimePath,
      runtimeMeta: runtimeMetaPath,
      outputDir,
      checkpointDir: path.join(outputDir, "checkpoint"),
      curationOverrides: curationPath,
      songAliases: aliasesPath,
      batchTag: "fixture-followup",
      resume: true,
    };
    const manifest = await exportGlobalQualityCandidates(args);
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.candidateCount, 5);
    assert.deepEqual(manifest.cohorts, {
      runtimeSingleton: 2,
      sourceUnknownArtist: 1,
      targetedReview: 2,
    });
    assert.deepEqual(manifest.classifications, {
      confirmed_chat_or_translation: 2,
      merge_same_song_high_frequency: 1,
      insufficient_evidence_keep: 2,
    });
    assert.deepEqual(manifest.decisions, {
      drop_entry: 2,
      merge: 1,
      keep: 2,
    });
    assert.equal(manifest.runtimeSingletons.matchedCount, 2);
    assert.equal(manifest.runtimeSingletons.unmatchedCount, 0);

    const candidates = readJsonlGzip(path.join(outputDir, "candidate-classifications.jsonl.gz"));
    assert.equal(candidates.length, manifest.candidateCount);
    const runtimeTalk = candidates.find((candidate) => candidate.candidateId === "runtime-talk");
    assert.equal(runtimeTalk.classification, "confirmed_chat_or_translation");
    assert.equal(runtimeTalk.decision, "drop_entry");
    assert.equal(runtimeTalk.sourceEvidence[0].sourceId, "Ugxw2-DEUVx0aNsvVyR4AaABAg");
    assert.equal(runtimeTalk.sourceEvidence[0].rawHash, TALK_RAW_HASH);
    assert.match(runtimeTalk.sourceEvidence[0].sourcePath, /accepted\/fixture\.json$/u);

    const alias = candidates.find((candidate) => candidate.current?.title === "逆光");
    assert.equal(alias.classification, "merge_same_song_high_frequency");
    assert.equal(alias.current.artist, "Ado");
    assert.equal(alias.canonicalOccurrenceCount, 3);
    assert.ok(alias.evidenceUrls.includes("https://sp.universal-music.co.jp/ado/uta-no-uta/"));

    const unknown = candidates.find((candidate) => candidate.cohorts.includes("source_unknown_artist"));
    assert.equal(unknown.classification, "insufficient_evidence_keep");
    assert.equal(unknown.decision, "keep");
    assert.deepEqual(unknown.sameTitleKnownArtists, [{ artist: "Known Artist", count: 1 }]);
    assert.equal(unknown.mergePriority, "review_same_title_known_artist_before_artist_fill");

    const vaundy = candidates.find((candidate) => candidate.candidateId === "runtime-vaundy");
    assert.equal(vaundy.classification, "insufficient_evidence_keep");
    assert.equal(vaundy.runtime.title, "逆光 - replica");
    assert.equal(vaundy.runtime.artist, "Vaundy");

    const firstOutput = fs.readFileSync(path.join(outputDir, "candidate-classifications.jsonl.gz"));
    const resumed = await exportGlobalQualityCandidates(args);
    assert.equal(resumed.analysisKey, manifest.analysisKey);
    assert.deepEqual(
      fs.readFileSync(path.join(outputDir, "candidate-classifications.jsonl.gz")),
      firstOutput,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function video(videoId, channelHandle, songs) {
  return {
    videoId,
    title: `Fixture ${videoId}`,
    channelName: "Fixture Channel",
    channelHandle,
    sourceUrl: `https://www.youtube.com/${channelHandle}`,
    sourceGroups: ["youtube_channel_discovery"],
    discoveryImport: { acceptedFile: "fixture.json" },
    songs,
  };
}

function song(seconds, title, artist, rawHash, sourceId, sourceHash, raw = "") {
  return {
    seconds,
    time: `0:${String(seconds).padStart(2, "0")}`,
    title,
    artist,
    raw: raw || `${seconds} ${title}${artist ? ` / ${artist}` : ""}`,
    rawHash,
    sourceId,
    sourceHash,
  };
}

function runtimeSingleton(candidateId, songKey, videoId, seconds, title, artist) {
  return {
    schemaVersion: 1,
    candidateId,
    cohort: "runtime_singleton",
    occurrenceId: `${candidateId}-occurrence`,
    songKey,
    occurrenceCount: 1,
    videoId,
    seconds,
    title,
    artist,
    isUnknownArtist: !artist,
    sourceSystem: "fixture",
    sourceId: `${candidateId}-source`,
  };
}

function writeJsonlGzip(filePath, rows) {
  const payload = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  fs.writeFileSync(filePath, zlib.gzipSync(payload, { level: 6, mtime: 0 }));
}

function readJsonlGzip(filePath) {
  return zlib.gunzipSync(fs.readFileSync(filePath))
    .toString("utf8")
    .split(/\r?\n/gu)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(filePath) {
  const content = fs.readFileSync(filePath);
  return {
    bytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}
