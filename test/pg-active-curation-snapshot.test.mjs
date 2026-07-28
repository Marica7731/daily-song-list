import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function resolvePython() {
  const defaults = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const executable of [...new Set([process.env.PYTHON, ...defaults].filter(Boolean))]) {
    try {
      execFileSync(executable, ["--version"], { stdio: "ignore" });
      return executable;
    } catch {
      // Try the next interpreter.
    }
  }
  throw new Error("Python interpreter not found");
}

const python = resolvePython();
const script = path.resolve("scripts/migration/export-pg-active-curation-snapshot.py");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fakeAdapterSource() {
  return String.raw`
from dataclasses import dataclass

class Cursor:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def execute(self, _sql, _params=None):
        return None

class Connection:
    def cursor(self):
        return Cursor()
    def rollback(self):
        return None
    def close(self):
        return None

@dataclass(frozen=True)
class Snapshot:
    revision_id: str
    records: tuple

SNAPSHOT = Snapshot(
    revision_id="accepted_fixture_1",
    records=(
        {
            "video": {"videoId": "video-1", "channelHandle": "@channel"},
            "occurrences": (
                {
                    "occurrenceId": "occ-2",
                    "position": 1,
                    "seconds": None,
                    "title": "Second",
                    "artist": "",
                    "sourceId": "",
                    "sourceHash": "source-hash-2",
                    "rawHash": "raw-hash-2",
                    "rangeId": "all",
                    "sourceSystem": "",
                },
                {
                    "occurrenceId": "occ-1",
                    "position": 0,
                    "seconds": 12,
                    "title": "First",
                    "artist": "Artist",
                    "sourceId": "comment-1",
                    "sourceHash": "source-hash-1",
                    "rawHash": "raw-hash-1",
                    "rangeId": "all",
                    "sourceSystem": "accepted",
                },
            ),
        },
    ),
)

def connect_from_env():
    return Connection()

def _one(_connection, _sql, _params=()):
    return {"state_value": "accepted_fixture_1"}

def _load_snapshot(_connection):
    return SNAPSHOT
`;
}

test("dynamic dataclass adapter loads before export and emits deterministic minimum fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-export-test-"));
  try {
    const adapter = path.join(root, "pg_adapter.py");
    fs.writeFileSync(adapter, fakeAdapterSource(), "utf8");
    const result = spawnSync(python, [
      script,
      "export",
      "--adapter", adapter,
      "--expected-active-revision", "accepted_fixture_1",
      "--progress-every", "1",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.occurrenceId), ["occ-1", "occ-2"]);
    assert.equal(rows[0].channelHandle, "@channel");
    assert.equal(rows[0].sourceHash, "source-hash-1");
    assert.equal(rows[0].rawHash, "raw-hash-1");
    assert.equal(rows[1].seconds, null);
    assert.deepEqual(Object.keys(rows[0]), [
      "videoId", "occurrenceId", "position", "seconds", "title", "artist",
      "sourceId", "sourceHash", "rawHash", "rangeId", "sourceSystem", "channelHandle",
    ]);
    const summaryLine = result.stderr.split("\n").find((line) => line.startsWith("PG_ACTIVE_CURATION_EXPORT_OK "));
    const summary = JSON.parse(summaryLine.slice("PG_ACTIVE_CURATION_EXPORT_OK ".length));
    assert.equal(summary.activeRevisionId, "accepted_fixture_1");
    assert.equal(summary.rows, 2);
    assert.equal(summary.bytes, Buffer.byteLength(result.stdout));
    assert.equal(summary.sha256, sha256(result.stdout));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export fails closed when the audited active revision has drifted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-drift-test-"));
  try {
    const adapter = path.join(root, "pg_adapter.py");
    fs.writeFileSync(adapter, fakeAdapterSource(), "utf8");
    const result = spawnSync(python, [
      script,
      "export",
      "--adapter", adapter,
      "--expected-active-revision", "accepted_other",
    ], { encoding: "utf8" });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /active revision mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture independently hashes the stream and removes output on hard-cap failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-capture-test-"));
  try {
    const rows = [
      {
        videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12,
        title: "Song", artist: "Artist", sourceId: "source-1",
        sourceHash: "source-hash", rawHash: "raw-hash", rangeId: "all",
        sourceSystem: "accepted", channelHandle: "@channel",
      },
      {
        videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: null,
        title: "Song 2", artist: "", sourceId: "", sourceHash: null,
        rawHash: "raw-hash-2", rangeId: "all", sourceSystem: "",
        channelHandle: "@channel",
      },
    ];
    const input = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const output = path.join(root, "snapshot.ndjson");
    const checkpoint = path.join(root, "checkpoint.json");
    const result = spawnSync(python, [
      script,
      "capture",
      "--output", output,
      "--checkpoint-output", checkpoint,
      "--max-bytes", String(Buffer.byteLength(input)),
      "--max-rows", "2",
      "--progress-every", "1",
    ], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, "utf8"), input);
    const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
    assert.equal(saved.complete, true);
    assert.equal(saved.resumable, false);
    assert.equal(saved.rows, 2);
    assert.equal(saved.bytes, Buffer.byteLength(input));
    assert.equal(saved.sha256, sha256(input));

    const blockedOutput = path.join(root, "blocked.ndjson");
    const blockedCheckpoint = path.join(root, "blocked-checkpoint.json");
    const blocked = spawnSync(python, [
      script,
      "capture",
      "--output", blockedOutput,
      "--checkpoint-output", blockedCheckpoint,
      "--max-bytes", String(Buffer.byteLength(input) - 1),
      "--max-rows", "2",
    ], { input, encoding: "utf8" });
    assert.equal(blocked.status, 78, blocked.stderr);
    assert.equal(fs.existsSync(blockedOutput), false);
    assert.equal(JSON.parse(fs.readFileSync(blockedCheckpoint, "utf8")).complete, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finalize binds converter output to independently matched remote and Mac snapshot evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-finalize-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const candidate = path.join(root, "candidate.ndjson");
    const converterManifest = path.join(root, "converter-manifest.json");
    const review = path.join(root, "review.json");
    const snapshotCheckpoint = path.join(root, "snapshot-checkpoint.json");
    const remoteLog = path.join(root, "remote.log");
    const outputManifest = path.join(root, "manifest.json");
    const outputCheckpoint = path.join(root, "producer-checkpoint.json");
    const rulesValue = {
      records: [{}],
      safetyAssertions: [
        { assertionId: "protect-vaundy", expectedMutationCount: 0 },
        { assertionId: "protect-flugel", expectedMutationCount: 0 },
        { assertionId: "exclude-urameshi", expectedMutationCount: 0 },
      ],
    };
    fs.writeFileSync(rules, JSON.stringify(rulesValue), "utf8");
    const rulesSha = sha256(fs.readFileSync(rules));
    fs.writeFileSync(candidate, Array.from({ length: 11 }, (_, index) => JSON.stringify({ entityKey: `occ-${index}` })).join("\n") + "\n", "utf8");
    fs.writeFileSync(converterManifest, JSON.stringify({
      kind: "curation-accepted-increment",
      status: "ready",
      selectorMutationCount: 1,
      aliasMutationCount: 10,
      curationMutationCount: 11,
      snapshotSha256: "snapshot-sha",
      rulesManifestSha256: rulesSha,
    }), "utf8");
    fs.writeFileSync(review, JSON.stringify({
      summary: { accepted: 5 },
      results: rulesValue.safetyAssertions.map((item) => ({
        kind: "safety_assertion",
        assertionId: item.assertionId,
        status: "accepted",
        mutationCount: 0,
      })),
    }), "utf8");
    fs.writeFileSync(snapshotCheckpoint, JSON.stringify({
      complete: true,
      resumable: false,
      rows: 600000,
      bytes: 123456789,
      sha256: "snapshot-sha",
    }), "utf8");
    fs.writeFileSync(remoteLog, `noise\nPG_ACTIVE_CURATION_EXPORT_OK ${JSON.stringify({
      status: "ok",
      activeRevisionId: "accepted_fixture_1",
      rows: 600000,
      bytes: 123456789,
      sha256: "snapshot-sha",
    })}\n`, "utf8");

    const result = spawnSync(python, [
      script,
      "finalize",
      "--converter-manifest", converterManifest,
      "--review", review,
      "--candidate", candidate,
      "--snapshot-checkpoint", snapshotCheckpoint,
      "--remote-log", remoteLog,
      "--rules-manifest", rules,
      "--output-manifest", outputManifest,
      "--output-checkpoint", outputCheckpoint,
      "--expected-active-revision", "accepted_fixture_1",
      "--expected-selector-mutations", "1",
      "--expected-alias-mutations", "10",
      "--producer-commit", "commit-sha",
      "--producer-run-id", "123",
      "--producer-run-attempt", "1",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const finalized = JSON.parse(fs.readFileSync(outputManifest, "utf8"));
    const producerCheckpoint = JSON.parse(fs.readFileSync(outputCheckpoint, "utf8"));
    assert.equal(finalized.activeSnapshotRevisionId, "accepted_fixture_1");
    assert.equal(finalized.snapshotBytes, 123456789);
    assert.equal(finalized.snapshotArtifactIncluded, false);
    assert.equal(finalized.patch_sha256, sha256(fs.readFileSync(candidate)));
    assert.equal(finalized.patch_bytes, fs.statSync(candidate).size);
    assert.equal(producerCheckpoint.complete, true);
    assert.equal(producerCheckpoint.resumable, false);
    assert.equal(producerCheckpoint.snapshot.artifactIncluded, false);
    assert.equal(producerCheckpoint.outputs.candidate.bytes, fs.statSync(candidate).size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
