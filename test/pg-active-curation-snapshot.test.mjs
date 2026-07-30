import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(candidateRoot, "scripts/migration/export-pg-active-curation-snapshot.py");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function knownTuple(overrides = {}) {
  return { videoId: "video", occurrenceId: "occ", position: 0, seconds: 1, sourceId: "source", sourceHash: "source-hash", rawHash: "raw-hash", rangeId: "all", ...overrides };
}

function tupleDigest(tuples) {
  const canonical = tuples.map((item) => Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))));
  canonical.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256(JSON.stringify(canonical));
}

function protectionContractSha(rules) {
  return sha256(JSON.stringify(Object.fromEntries(rules.safetyAssertions.map((item) => [item.assertionId, tupleDigest(item.knownTuplePresence)]).sort(([a], [b]) => a.localeCompare(b)))));
}

function fakeAdapterSource() {
  return String.raw`
from dataclasses import dataclass
import json
import os

@dataclass(frozen=True)
class Revision:
    revision_id: str
    parent_revision_id: str
    incremental_overlay: bool

REVISIONS = {
    "accepted_fixture_1": Revision("accepted_fixture_1", "overlay_fixture_0", True),
    "overlay_fixture_0": Revision("overlay_fixture_0", "full_fixture_1", True),
    "full_fixture_1": Revision("full_fixture_1", "", False),
}

VIDEOS = {
    "video-a": {"video_id": "video-a", "video_title": "Video A", "channel_name": "A", "channel_id": "A1", "channel_handle": "@base-a", "channel_url": "", "published_timestamp": 1, "video_payload_json": {}},
    "video-b": {"video_id": "video-b", "video_title": "Video B", "channel_name": "B", "channel_id": "B1", "channel_handle": "@base-b", "channel_url": "", "published_timestamp": 2, "video_payload_json": {}},
    "video-c": {"video_id": "video-c", "video_title": "Video C", "channel_name": "C", "channel_id": "C1", "channel_handle": "@base-c", "channel_url": "", "published_timestamp": 3, "video_payload_json": {}},
    "video-d": {"video_id": "video-d", "video_title": "Video D", "channel_name": "D", "channel_id": "D1", "channel_handle": "@base-d", "channel_url": "", "published_timestamp": 4, "video_payload_json": {}},
    "video-z": {"video_id": "video-z", "video_title": "Video Z", "channel_name": "Z", "channel_id": "Z1", "channel_handle": "@base-z", "channel_url": "", "published_timestamp": 5, "video_payload_json": {}},
}

OCCURRENCES = [
    {"occurrence_id": "occ-a1", "range_id": "all", "video_id": "video-a", "song_key": "a1", "seconds": 10, "source_system": "base", "source_id": "a-source-1", "occurrence_title": "A One", "artist": "Artist A", "occurrence_payload_json": {"position": 0, "sourceHash": "a-source-hash-1", "rawHash": "a-raw-1"}},
    {"occurrence_id": "occ-a2", "range_id": "all", "video_id": "video-a", "song_key": "a2", "seconds": 10, "source_system": "base", "source_id": "a-source-2", "occurrence_title": "A Two", "artist": "", "occurrence_payload_json": {"position": 1, "sourceHash": "a-source-hash-2", "rawHash": "a-raw-2"}},
    {"occurrence_id": "occ-b-base", "range_id": "all", "video_id": "video-b", "song_key": "b0", "seconds": 20, "source_system": "base", "source_id": "b-source", "occurrence_title": "B Base", "artist": "Artist B", "occurrence_payload_json": {"position": 0, "sourceHash": "b-source-hash", "rawHash": "b-raw"}},
    {"occurrence_id": "occ-c-base", "range_id": "all", "video_id": "video-c", "song_key": "c0", "seconds": 30, "source_system": "base", "source_id": "c-source", "occurrence_title": "C Base", "artist": "Artist C", "occurrence_payload_json": {"position": 0, "sourceHash": "c-source-hash", "rawHash": "c-raw"}},
    {"occurrence_id": "occ-d1", "range_id": "all", "video_id": "video-d", "song_key": "d1", "seconds": None, "source_system": "base", "source_id": "d-source-1", "occurrence_title": "D Base", "artist": "Artist D", "occurrence_payload_json": {"position": 0, "sourceHash": "d-source-hash-1", "rawHash": "d-raw-1"}},
    {"occurrence_id": "occ-d2", "range_id": "all", "video_id": "video-d", "song_key": "d2", "seconds": None, "source_system": "base", "source_id": "d-source-2", "occurrence_title": "D Drop", "artist": "Artist D", "occurrence_payload_json": {"position": 1, "sourceHash": "d-source-hash-2", "rawHash": "d-raw-2"}},
    {"occurrence_id": "occ-z1", "range_id": "all", "video_id": "video-z", "song_key": "z1", "seconds": 90, "source_system": "base", "source_id": "z-source", "occurrence_title": "Z One", "artist": "Artist Z", "occurrence_payload_json": {"position": 0, "sourceHash": "z-source-hash", "rawHash": "z-raw"}},
]

OVERLAY_VIDEOS = {
    "overlay_fixture_0": [
        {"video_id": "video-b", "title": "Video B Old Overlay", "channel_name": "B", "channel_id": "B1", "channel_handle": "@old-b", "channel_url": "", "published_at": "old", "tombstone": False, "payload_json": {}},
        {"video_id": "video-c", "title": None, "channel_name": None, "channel_id": None, "channel_handle": None, "channel_url": None, "published_at": None, "tombstone": True, "payload_json": {}},
    ],
    "accepted_fixture_1": [
        {"video_id": "video-b", "title": "Video B Final", "channel_name": "B", "channel_id": "B1", "channel_handle": "@final-b", "channel_url": "", "published_at": "final", "tombstone": False, "payload_json": {}},
        {"video_id": "video-e", "title": "Video E", "channel_name": "E", "channel_id": "E1", "channel_handle": "@new-e", "channel_url": "", "published_at": "new", "tombstone": False, "payload_json": {}},
    ],
}

OVERLAY_OCCURRENCES = {
    "overlay_fixture_0": [
        {"video_id": "video-b", "occurrence_key": "b-old", "occurrence_id": "occ-b-old-overlay", "position": 0, "range_id": "all", "song_key": "b-old", "seconds": 21, "title": "B Old Overlay", "artist": "Artist B", "source_id": "b-old", "raw_hash": "b-old-raw", "source_system": "accepted", "payload_json": {"sourceHash": "b-old-source-hash"}},
    ],
    "accepted_fixture_1": [
        {"video_id": "video-b", "occurrence_key": "b-new", "occurrence_id": "occ-b-final", "position": 0, "range_id": "all", "song_key": "b-new", "seconds": 22, "title": "B Final", "artist": "Artist B", "source_id": "b-final", "raw_hash": "b-final-raw", "source_system": "accepted", "payload_json": {"sourceHash": "b-final-source-hash"}},
        {"video_id": "video-e", "occurrence_key": "e-new", "occurrence_id": "occ-e1", "position": 0, "range_id": "all", "song_key": "e-new", "seconds": 50, "title": "E One", "artist": "Artist E", "source_id": "e-source", "raw_hash": "e-raw", "source_system": "accepted", "payload_json": {"sourceHash": "e-source-hash"}},
    ],
}

OVERLAY_RUNTIME = {
    "overlay_fixture_0": [
        {"entity_type": "occurrences", "entity_key": "occ-d1", "source_system": "curation", "range_id": "all", "source_id": "d-source-1", "occurrence_id": "occ-d1", "tombstone": False, "payload_json": {"videoId": "video-d", "occurrenceId": "occ-d1", "position": 0, "seconds": None, "title": "D Old", "artist": "Artist D", "sourceId": "d-source-1", "sourceHash": "d-old-source-hash", "rawHash": "d-raw-1", "rangeId": "all", "sourceSystem": "curation"}},
    ],
    "accepted_fixture_1": [
        {"entity_type": "occurrences", "entity_key": "occ-d1", "source_system": "curation", "range_id": "all", "source_id": "d-source-1", "occurrence_id": "occ-d1", "tombstone": False, "payload_json": {"videoId": "video-d", "occurrenceId": "occ-d1", "position": 0, "seconds": None, "title": "D Final", "artist": "Artist D", "sourceId": "d-source-1", "sourceHash": "d-final-source-hash", "rawHash": "d-raw-1", "rangeId": "all", "sourceSystem": "curation", "originalIdentity": {"occurrenceId": "occ-d1"}}},
        {"entity_type": "occurrences", "entity_key": "occ-d2", "source_system": "curation", "range_id": "all", "source_id": "d-source-2", "occurrence_id": "occ-d2", "tombstone": True, "payload_json": {"videoId": "video-d", "occurrenceId": "occ-d2", "sourceHash": "d-source-hash-2", "rawHash": "d-raw-2"}},
    ],
}

def selected(mapping, revision_id):
    return [dict(row) for row in mapping.get(revision_id, [])]

class Cursor:
    def __init__(self, connection, name):
        self.connection = connection
        self.name = name
        self.description = ()
        self.values = []
        self.offset = 0
        self.itersize = 0
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def execute(self, sql, params=None):
        params = list(params or [])
        normalized = " ".join(sql.split())
        rows = []
        if normalized.startswith("BEGIN") or normalized.startswith("SET LOCAL"):
            pass
        elif normalized.startswith("SELECT pg_try_advisory_xact_lock_shared"):
            rows = [{"locked": True}]
        elif "FROM migration_video_rows" in normalized:
            rows = selected(OVERLAY_VIDEOS, params[0])
        elif "FROM migration_occurrence_rows" in normalized:
            rows = selected(OVERLAY_OCCURRENCES, params[0])
        elif "FROM migration_runtime_rows" in normalized:
            rows = selected(OVERLAY_RUNTIME, params[0])
        elif "FROM runtime_videos" in normalized and "ANY" in normalized:
            rows = [dict(VIDEOS[key]) for key in params[1] if key in VIDEOS]
        elif "FROM runtime_occurrences" in normalized and "ANY" in normalized:
            rows = [dict(row) for row in OCCURRENCES if row["video_id"] in params[1]]
        elif "FROM runtime_occurrences AS o" in normalized:
            rows = []
            for occurrence in OCCURRENCES:
                row = dict(occurrence)
                row.update(VIDEOS[occurrence["video_id"]])
                rows.append(row)
            if os.environ.get("FAKE_LARGE_STREAM") == "1":
                for video_index in range(3):
                    video_id = f"video-m{video_index}"
                    for occurrence_index in range(1001):
                        rows.append({
                            "occurrence_id": f"occ-m{video_index}-{occurrence_index:04d}",
                            "range_id": "all",
                            "video_id": video_id,
                            "song_key": f"m{video_index}",
                            "seconds": occurrence_index,
                            "source_system": "base",
                            "source_id": f"m-source-{occurrence_index}",
                            "occurrence_title": f"M {video_index}",
                            "artist": "Artist M",
                            "occurrence_payload_json": {
                                "position": occurrence_index,
                                "sourceHash": f"m-source-hash-{occurrence_index}",
                                "rawHash": f"m-raw-{occurrence_index}",
                            },
                            "video_title": f"Video M {video_index}",
                            "channel_name": "M",
                            "channel_id": f"M{video_index}",
                            "channel_handle": "@base-m",
                            "channel_url": "",
                            "published_timestamp": 10 + video_index,
                            "video_payload_json": {},
                        })
            rows.sort(key=lambda row: (
                row.get("video_id", ""),
                row.get("range_id", ""),
                row.get("occurrence_id", ""),
            ))
        else:
            raise AssertionError(f"unexpected streaming SQL: {normalized}")
        if os.environ.get("FAKE_EMPTY_ACTIVE") == "1" and not normalized.startswith("SELECT pg_try_advisory_xact_lock_shared"):
            rows = []
        self.is_full_stream = "FROM runtime_occurrences AS o" in normalized
        self.connection.named_cursor_count += int(self.name is not None)
        self.description = [(key,) for key in (rows[0].keys() if rows else [])]
        self.values = [tuple(row[key] for key, in self.description) for row in rows]
    def fetchmany(self, size):
        self.connection.max_fetch_size = max(self.connection.max_fetch_size, size)
        self.connection.fetchmany_calls += 1
        if self.is_full_stream:
            self.connection.full_fetchmany_calls += 1
            fail_after = int(os.environ.get("FAKE_FAIL_FULL_FETCH_AFTER", "0"))
            if fail_after and self.connection.full_fetchmany_calls > fail_after:
                raise RuntimeError("synthetic full stream failure before exhaustion")
        values = self.values[self.offset:self.offset + size]
        self.offset += len(values)
        return values
    def fetchone(self):
        values = self.fetchmany(1)
        return values[0] if values else None
    def fetchall(self):
        self.connection.fetchall_called = True
        raise AssertionError("streaming exporter must not call fetchall")
    def close(self):
        return None

class Connection:
    def __init__(self):
        self.named_cursor_count = 0
        self.max_fetch_size = 0
        self.fetchmany_calls = 0
        self.full_fetchmany_calls = 0
        self.fetchall_called = False
    def cursor(self, name=None):
        return Cursor(self, name)
    def rollback(self):
        return None
    def close(self):
        metrics = os.environ.get("FAKE_ADAPTER_METRICS")
        if metrics:
            with open(metrics, "w", encoding="utf-8") as stream:
                json.dump({
                    "namedCursorCount": self.named_cursor_count,
                    "maxFetchSize": self.max_fetch_size,
                    "fetchmanyCalls": self.fetchmany_calls,
                    "fullFetchmanyCalls": self.full_fetchmany_calls,
                    "fetchallCalled": self.fetchall_called,
                }, stream)

def connect_from_env():
    return Connection()

def _one(_connection, sql, params=()):
    if "migration_state" in sql:
        return {"state_value": "accepted_fixture_1"}
    if "migration_revisions" in sql:
        revision = REVISIONS[params[0]]
        return {
            "revision_id": revision.revision_id,
            "parent_revision_id": revision.parent_revision_id,
            "status": "active" if revision.revision_id == "accepted_fixture_1" else "superseded",
            "manifest_json": {
                "runtimeProjection": True,
                "incrementalOverlay": revision.incremental_overlay,
            },
        }
    raise AssertionError(f"unexpected _one SQL: {sql}")

def _load_snapshot(_connection):
    raise AssertionError("streaming exporter must not materialize _load_snapshot")
`;
}

test("dynamic dataclass adapter streams full parent plus ordered overlays without fetchall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-export-test-"));
  try {
    const adapter = path.join(root, "pg_adapter.py");
    const metrics = path.join(root, "metrics.json");
    fs.writeFileSync(adapter, fakeAdapterSource(), "utf8");
    const result = spawnSync(python, [
      script,
      "export",
      "--adapter", adapter,
      "--expected-active-revision", "accepted_fixture_1",
      "--progress-every", "1",
    ], { encoding: "utf8", env: { ...process.env, FAKE_ADAPTER_METRICS: metrics } });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.occurrenceId), [
      "occ-a1", "occ-a2", "occ-b-final", "occ-d1", "occ-e1", "occ-z1",
    ]);
    assert.deepEqual(rows.slice(0, 2).map((row) => row.seconds), [10, 10]);
    assert.equal(rows[0].channelHandle, "@base-a");
    assert.equal(rows[0].sourceHash, "a-source-hash-1");
    assert.equal(rows[0].rawHash, "a-raw-1");
    assert.equal(rows[2].channelHandle, "@final-b");
    assert.equal(rows[2].sourceHash, "b-final-source-hash");
    assert.equal(rows[3].seconds, null);
    assert.equal(rows[3].title, "D Final");
    assert.equal(rows[3].sourceHash, "d-final-source-hash");
    assert.equal(rows.some((row) => row.videoId === "video-c"), false);
    assert.equal(rows.some((row) => row.occurrenceId === "occ-d2"), false);
    assert.deepEqual(Object.keys(rows[0]), [
      "videoId", "occurrenceId", "position", "seconds", "title", "artist",
      "sourceId", "sourceHash", "rawHash", "rangeId", "sourceSystem", "channelHandle",
    ]);
    const summaryLine = result.stderr.split("\n").find((line) => line.startsWith("PG_ACTIVE_CURATION_EXPORT_OK "));
    const summary = JSON.parse(summaryLine.slice("PG_ACTIVE_CURATION_EXPORT_OK ".length));
    assert.equal(summary.activeRevisionId, "accepted_fixture_1");
    assert.equal(summary.rows, 6);
    assert.equal(summary.bytes, Buffer.byteLength(result.stdout));
    assert.equal(summary.sha256, sha256(result.stdout));
    const cursorMetrics = JSON.parse(fs.readFileSync(metrics, "utf8"));
    assert.equal(cursorMetrics.fetchallCalled, false);
    assert.ok(cursorMetrics.namedCursorCount >= 7);
    assert.equal(cursorMetrics.maxFetchSize, 1000);
    assert.ok(cursorMetrics.fetchmanyCalls >= cursorMetrics.namedCursorCount);
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

test("export emits completed video groups before the bounded parent cursor is exhausted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-stream-order-test-"));
  try {
    const adapter = path.join(root, "pg_adapter.py");
    const metrics = path.join(root, "metrics.json");
    fs.writeFileSync(adapter, fakeAdapterSource(), "utf8");
    const result = spawnSync(python, [
      script,
      "export",
      "--adapter", adapter,
      "--expected-active-revision", "accepted_fixture_1",
      "--progress-every", "1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_ADAPTER_METRICS: metrics,
        FAKE_LARGE_STREAM: "1",
        FAKE_FAIL_FULL_FETCH_AFTER: "2",
      },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /synthetic full stream failure before exhaustion/);
    assert.ok(result.stdout.length > 0, "at least one completed video must stream before later fetch failure");
    assert.ok(result.stdout.trim().split("\n").length >= 2);
    const cursorMetrics = JSON.parse(fs.readFileSync(metrics, "utf8"));
    assert.equal(cursorMetrics.fetchallCalled, false);
    assert.equal(cursorMetrics.fullFetchmanyCalls, 3);
    assert.equal(result.stderr.includes("PG_ACTIVE_CURATION_EXPORT_OK "), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export fails closed before an empty active projection can be attested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-empty-export-test-"));
  try {
    const adapter = path.join(root, "pg_adapter.py");
    fs.writeFileSync(adapter, fakeAdapterSource(), "utf8");
    const result = spawnSync(python, [
      script,
      "export",
      "--adapter", adapter,
      "--expected-active-revision", "accepted_fixture_1",
    ], {
      encoding: "utf8",
      env: { ...process.env, FAKE_EMPTY_ACTIVE: "1" },
    });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /active snapshot stream is empty/);
    assert.equal(result.stderr.includes("PG_ACTIVE_CURATION_EXPORT_OK "), false);
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

    const emptyOutput = path.join(root, "empty.ndjson");
    const emptyCheckpoint = path.join(root, "empty-checkpoint.json");
    const empty = spawnSync(python, [
      script,
      "capture",
      "--output", emptyOutput,
      "--checkpoint-output", emptyCheckpoint,
      "--max-bytes", "1",
      "--max-rows", "1",
    ], { input: "", encoding: "utf8" });
    assert.equal(empty.status, 78, empty.stderr);
    assert.equal(fs.existsSync(emptyOutput), false);
    const emptySaved = JSON.parse(fs.readFileSync(emptyCheckpoint, "utf8"));
    assert.equal(emptySaved.complete, false);
    assert.equal(emptySaved.rows, 0);
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
    const snapshotSha = "a".repeat(64);
    const rulesValue = {
      status: "ready",
      ready: true,
      expectedSelectorMutationCount: 1,
      expectedAliasMutationCount: 10,
      records: [{
        ruleId: "naraetan-finalize",
        expectedCurrentState: "present",
        expectedSelectorMutationCount: 1,
      }],
      safetyAssertions: [
        { assertionId: "protect-vaundy", expectedMutationCount: 0, expectedScopeCount: 3, minScopeCount: 3, knownTuplePresence: [knownTuple({ videoId: "vaundy" })] },
        { assertionId: "protect-flugel", expectedMutationCount: 0, minScopeCount: 2, knownTuplePresence: [knownTuple({ videoId: "flugel" })] },
        { assertionId: "exclude-urameshi", expectedMutationCount: 0, expectedScopeCount: 1, knownTuplePresence: [knownTuple({ videoId: "urameshi" })] },
      ],
      currentActiveEvidence: {
        activeRevisionId: "accepted_fixture_1",
        snapshotSha256: snapshotSha,
        templateRulesManifestSha256: "b".repeat(64),
      },
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
      snapshotSha256: snapshotSha,
      rulesManifestSha256: rulesSha,
      protectionContractSha256: protectionContractSha(rulesValue),
    }), "utf8");
    fs.writeFileSync(review, JSON.stringify({
      summary: { accepted: 5 },
      results: rulesValue.safetyAssertions.map((item) => ({
        kind: "safety_assertion",
        assertionId: item.assertionId,
        status: "accepted",
        mutationCount: 0,
        scopeRowCount: item.expectedScopeCount ?? item.minScopeCount,
        knownTupleCount: item.knownTuplePresence.length,
        expectedKnownTupleDigest: tupleDigest(item.knownTuplePresence),
        observedKnownTupleDigest: tupleDigest(item.knownTuplePresence),
        knownTupleStatuses: item.knownTuplePresence.map((_, index) => ({ index, status: "present" })),
      })),
    }), "utf8");
    fs.writeFileSync(snapshotCheckpoint, JSON.stringify({
      complete: true,
      resumable: false,
      rows: 600000,
      bytes: 123456789,
      sha256: snapshotSha,
    }), "utf8");
    fs.writeFileSync(remoteLog, `noise\nPG_ACTIVE_CURATION_EXPORT_OK ${JSON.stringify({
      status: "ok",
      activeRevisionId: "accepted_fixture_1",
      rows: 600000,
      bytes: 123456789,
      sha256: snapshotSha,
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

test("finalize rejects a ready converter when an exact protected scope count drifted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pg-curation-finalize-scope-test-"));
  try {
    const rules = path.join(root, "rules.json");
    const candidate = path.join(root, "candidate.ndjson");
    const converter = path.join(root, "converter.json");
    const review = path.join(root, "review.json");
    const checkpoint = path.join(root, "checkpoint.json");
    const remote = path.join(root, "remote.log");
    const output = path.join(root, "output.json");
    const producer = path.join(root, "producer.json");
    const snapshotSha = "c".repeat(64);
    const rulesValue = {
      status: "ready",
      ready: true,
      expectedSelectorMutationCount: 0,
      expectedAliasMutationCount: 0,
      records: [{ ruleId: "naraetan-scope", expectedCurrentState: "absent", expectedSelectorMutationCount: 0 }],
      safetyAssertions: [{
        assertionId: "scope", expectedMutationCount: 0, expectedScopeCount: 3919,
        minScopeCount: 3919, knownTuplePresence: [knownTuple()],
      }],
      currentActiveEvidence: {
        activeRevisionId: "accepted_fixture_1",
        snapshotSha256: snapshotSha,
        templateRulesManifestSha256: "d".repeat(64),
      },
    };
    fs.writeFileSync(rules, JSON.stringify(rulesValue));
    fs.writeFileSync(candidate, "");
    fs.writeFileSync(converter, JSON.stringify({
      kind: "curation-accepted-increment", status: "ready", selectorMutationCount: 0,
      aliasMutationCount: 0, curationMutationCount: 0, snapshotSha256: snapshotSha,
      rulesManifestSha256: sha256(fs.readFileSync(rules)),
      protectionContractSha256: protectionContractSha(rulesValue),
    }));
    fs.writeFileSync(review, JSON.stringify({
      summary: { accepted: 1 },
      results: [{
        kind: "safety_assertion", assertionId: "scope", status: "accepted",
        mutationCount: 0, scopeRowCount: 3918, knownTupleCount: 1,
        expectedKnownTupleDigest: tupleDigest(rulesValue.safetyAssertions[0].knownTuplePresence),
        observedKnownTupleDigest: tupleDigest(rulesValue.safetyAssertions[0].knownTuplePresence),
        knownTupleStatuses: [{ index: 0, status: "present" }],
      }],
    }));
    fs.writeFileSync(checkpoint, JSON.stringify({ complete: true, resumable: false, rows: 1, bytes: 1, sha256: snapshotSha }));
    fs.writeFileSync(remote, `PG_ACTIVE_CURATION_EXPORT_OK ${JSON.stringify({ status: "ok", activeRevisionId: "accepted_fixture_1", rows: 1, bytes: 1, sha256: snapshotSha })}\n`);
    const result = spawnSync(python, [script, "finalize", "--converter-manifest", converter, "--review", review, "--candidate", candidate, "--snapshot-checkpoint", checkpoint, "--remote-log", remote, "--rules-manifest", rules, "--output-manifest", output, "--output-checkpoint", producer, "--expected-active-revision", "accepted_fixture_1", "--producer-commit", "sha", "--producer-run-id", "1", "--producer-run-attempt", "1"], { encoding: "utf8" });
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /safety scope mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
