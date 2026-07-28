import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const helper = path.resolve(
  "scripts/migration/accepted-source-identities.py",
);
const converter = path.resolve(
  "scripts/migration/accepted-files-to-patch.py",
);

function acceptedRecord({
  channelId,
  channelHandle,
  videoId,
  occurrenceId,
  title,
  artist = null,
  seconds = null,
}) {
  return {
    channelId,
    channelHandle,
    videoId,
    songs: [{ occurrenceId, title, artist, seconds }],
  };
}

function writePatch(filePath, records) {
  const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (filePath.endsWith(".gz")) {
    fs.writeFileSync(filePath, zlib.gzipSync(body));
  } else {
    fs.writeFileSync(filePath, body);
  }
}

function runHelper(root, patchPath, { manifest } = {}) {
  const outputPath = path.join(root, "evidence.json");
  const args = [helper, "--patch", patchPath, "--output", outputPath];
  if (manifest) {
    args.push("--verify-manifest", manifest);
  }
  const result = spawnSync("python3", args, { encoding: "utf8" });
  return {
    ...result,
    evidence: result.status === 0
      ? JSON.parse(fs.readFileSync(outputPath, "utf8"))
      : null,
  };
}

function withTempRoot(callback) {
  const root = fs.mkdtempSync(
    path.join(process.cwd(), ".tmp-accepted-source-identities-"),
  );
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("builds one deterministic identity probe per distinct accepted source", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    const records = [
      acceptedRecord({
        channelId: "UCB",
        channelHandle: "/@source-b",
        videoId: "video-z",
        occurrenceId: "position:9",
        title: "B song",
        artist: "B artist",
        seconds: 20,
      }),
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-z",
        occurrenceId: "position:2",
        title: "Later A song",
        seconds: 30,
      }),
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-a",
        occurrenceId: "position:0",
        title: "First A song",
        artist: "A artist",
        seconds: 10,
      }),
    ];
    writePatch(patchPath, records);

    const result = runHelper(root, patchPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.evidence.sourceIdentityCount, 2);
    assert.deepEqual(
      result.evidence.sourceIdentityEvidence.map(
        ({
          sourceDetailKey,
          videoId,
          acceptedVideoCount,
          acceptedOccurrenceCount,
          acceptedSongGroupCount,
        }) => ({
          sourceDetailKey,
          videoId,
          acceptedVideoCount,
          acceptedOccurrenceCount,
          acceptedSongGroupCount,
        }),
      ),
      [
        {
          sourceDetailKey: "UCA",
          videoId: "video-a",
          acceptedVideoCount: 2,
          acceptedOccurrenceCount: 2,
          acceptedSongGroupCount: 2,
        },
        {
          sourceDetailKey: "UCB",
          videoId: "video-z",
          acceptedVideoCount: 1,
          acceptedOccurrenceCount: 1,
          acceptedSongGroupCount: 1,
        },
      ],
    );
    assert.deepEqual(
      result.evidence.identityEvidence,
      result.evidence.sourceIdentityEvidence[0],
    );
    const reversedPatchPath = path.join(root, "candidate-reversed.ndjson");
    writePatch(reversedPatchPath, [...records].reverse());
    const reversed = runHelper(root, reversedPatchPath);
    assert.equal(reversed.status, 0, reversed.stderr);
    assert.deepEqual(reversed.evidence, result.evidence);
  });
});

test("reads gzip patches and verifies an exact manifest binding", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson.gz");
    writePatch(patchPath, [
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-a",
        occurrenceId: "position:0",
        title: "Song",
        seconds: 42,
      }),
    ]);
    const built = runHelper(root, patchPath);
    assert.equal(built.status, 0, built.stderr);
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        handoffKind: "github-accepted-paths",
        ...built.evidence,
      }),
    );

    const verified = runHelper(root, patchPath, { manifest: manifestPath });
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(verified.evidence, built.evidence);
  });
});

test("consumes the real accepted-file converter output for multiple sources", () => {
  withTempRoot((root) => {
    const sourceRoot = path.join(root, "repository");
    const acceptedRoot = path.join(
      sourceRoot,
      "data",
      "external",
      "youtube-channel-discovery",
      "accepted",
    );
    fs.mkdirSync(acceptedRoot, { recursive: true });
    const inputs = [
      {
        name: "source-b.json",
        channelId: "UCB",
        channelHandle: "/@source-b",
        videoId: "video-b",
      },
      {
        name: "source-a.json",
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-a",
      },
    ].map(({ name, channelId, channelHandle, videoId }) => {
      const filePath = path.join(acceptedRoot, name);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          kind: "youtube-channel-discovery-increment",
          sourceSystem: "youtube_channel_discovery",
          videoCount: 1,
          occurrenceCount: 1,
          videos: [{
            channelId,
            channelHandle,
            videoId,
            songs: [{ title: `${videoId} song`, artist: null, seconds: 10 }],
          }],
        }),
      );
      return filePath;
    });
    const patchPath = path.join(root, "candidate.ndjson");
    const converterManifest = path.join(root, "converter-manifest.json");
    const converted = spawnSync(
      "python3",
      [
        converter,
        "--input", inputs[0],
        "--input", inputs[1],
        "--output", patchPath,
        "--manifest-output", converterManifest,
        "--range-id", "all",
        "--source-key", "UCA",
        "--source-root", sourceRoot,
        "--reviewed-at", "2026-07-28T12:34:56Z",
      ],
      { encoding: "utf8" },
    );
    assert.equal(converted.status, 0, converted.stderr);

    const result = runHelper(root, patchPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.evidence.sourceIdentityCount, 2);
    assert.deepEqual(
      result.evidence.sourceIdentityEvidence.map(
        ({ sourceDetailKey, occurrenceId }) => ({
          sourceDetailKey,
          occurrenceId,
        }),
      ),
      [
        { sourceDetailKey: "UCA", occurrenceId: "position:0" },
        { sourceDetailKey: "UCB", occurrenceId: "position:0" },
      ],
    );
  });
});

test("selects a deterministic API-visible tuple that is unique within its source", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    const record = acceptedRecord({
      channelId: "UCA",
      channelHandle: "/@source-a",
      videoId: "video-a",
      occurrenceId: "position:0",
      title: "duplicate",
      artist: "artist",
      seconds: 10,
    });
    record.songs.push(
      {
        occurrenceId: "position:1",
        title: "duplicate",
        artist: "artist",
        seconds: 10,
      },
      {
        occurrenceId: "position:2",
        title: "unique",
        artist: "artist",
        seconds: 20,
      },
    );
    writePatch(patchPath, [record]);

    const result = runHelper(root, patchPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.evidence.identityEvidence.occurrenceId, "position:2");
    assert.equal(result.evidence.identityEvidence.title, "unique");
  });
});

test("normalizes accepted song groups exactly like the PG overlay", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    writePatch(patchPath, [
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-a",
        occurrenceId: "position:0",
        title: "Ｆｏｏ   Song",
        artist: " Artist ",
        seconds: 10,
      }),
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-b",
        occurrenceId: "position:0",
        title: "foo song",
        artist: "artist",
        seconds: 20,
      }),
    ]);

    const result = runHelper(root, patchPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.evidence.sourceIdentityEvidence[0].acceptedSongGroupCount,
      1,
    );
    assert.equal(
      result.evidence.sourceIdentityEvidence[0].acceptedOccurrenceCount,
      2,
    );
  });
});

test("fails closed when a source has no API-visible unique tuple", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    const record = acceptedRecord({
      channelId: "UCA",
      channelHandle: "/@source-a",
      videoId: "video-a",
      occurrenceId: "position:0",
      title: "duplicate",
      seconds: 10,
    });
    record.songs.push({
      occurrenceId: "position:1",
      title: "duplicate",
      seconds: 10,
    });
    writePatch(patchPath, [record]);

    const result = runHelper(root, patchPath);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /no API-visible unique tuple for sources: UCA/u);
  });
});

test("fails closed when a manifest omits a source or changes its tuple", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    writePatch(patchPath, [
      acceptedRecord({
        channelId: "UCA",
        channelHandle: "/@source-a",
        videoId: "video-a",
        occurrenceId: "position:0",
        title: "A song",
      }),
      acceptedRecord({
        channelId: "UCB",
        channelHandle: "/@source-b",
        videoId: "video-b",
        occurrenceId: "position:0",
        title: "B song",
      }),
    ]);
    const built = runHelper(root, patchPath);
    assert.equal(built.status, 0, built.stderr);

    for (const mutation of [
      (evidence) => ({
        ...evidence,
        sourceIdentityCount: 1,
        sourceIdentityEvidence: evidence.sourceIdentityEvidence.slice(0, 1),
      }),
      (evidence) => ({
        ...evidence,
        sourceIdentityEvidence: evidence.sourceIdentityEvidence.map(
          (item, index) => index === 0 ? { ...item, title: "tampered" } : item,
        ),
      }),
    ]) {
      const manifestPath = path.join(root, "manifest.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          handoffKind: "github-accepted-paths",
          ...mutation(built.evidence),
        }),
      );
      const result = runHelper(root, patchPath, { manifest: manifestPath });
      assert.equal(result.status, 78);
      assert.match(
        result.stderr,
        /does not match deterministic patch evidence/u,
      );
    }
  });
});

test("fails closed when a patch record has no source identity", () => {
  withTempRoot((root) => {
    const patchPath = path.join(root, "candidate.ndjson");
    writePatch(patchPath, [
      acceptedRecord({
        videoId: "video-a",
        occurrenceId: "position:0",
        title: "Song",
      }),
    ]);
    const result = runHelper(root, patchPath);
    assert.equal(result.status, 78);
    assert.match(result.stderr, /channelId or channelHandle is required/u);
  });
});
