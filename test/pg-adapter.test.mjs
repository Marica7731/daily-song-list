import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const ADAPTER = path.join(ROOT, "server", "pg_adapter.py");
function resolvePython() {
  const candidates = process.env.PYTHON
    ? [process.env.PYTHON]
    : process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python interpreter not found; set PYTHON or install python3/python");
}

const PYTHON = resolvePython();

function runPython(script) {
  const result = spawnSync(PYTHON, ["-c", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("adapter parses without creating pycache files", () => {
  runPython(`compile(open(${JSON.stringify(ADAPTER)}, encoding="utf-8").read(), ${JSON.stringify(ADAPTER)}, "exec")`);
});

test("DSN selection does not expose the connection secret", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
assert module.resolve_dsn_from_env({"DAILY_SONG_POSTGRES_DSN": "postgresql://secret"}) == {"key": "DAILY_SONG_POSTGRES_DSN", "present": True}
assert module.resolve_dsn_from_env({}) == {"key": None, "present": False}
print("OK")
`);
  assert.equal(output, "OK");
});

test("rankings and source details preserve endpoint fields", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
records = [
  {"video": {"videoId": "AAAAAAAAAAA", "title": "Stream A", "channelName": "Channel A"}, "occurrences": ({"title": "Song A", "artist": "Artist A", "songKey": "song-a", "position": 0, "rangeId": "all", "sourceId": "src-a"},)},
  {"video": {"videoId": "BBBBBBBBBBB", "title": "Stream B", "channelName": "Channel B"}, "occurrences": ({"title": "Song A", "artist": "Artist A", "songKey": "song-a", "position": 1, "rangeId": "all", "sourceId": "src-b"},)},
]
ranking = module.rankings_payload_from_records(records, {"range": "all", "view": "songs", "pageSize": "5"})
assert ranking["schemaVersion"] == 1 and ranking["rangeId"] == "all"
assert ranking["records"][0]["title"] == "Song A"
assert ranking["records"][0]["sourceDetailKey"]
source = module.source_payload_from_records(records, ranking["records"][0]["sourceDetailKey"])
assert source["found"] is True and len(source["record"]["occurrences"]) == 2
missing = module.source_payload_from_records(records, "missing-source")
assert missing == {"schemaVersion": 1, "found": False, "sourceKey": "missing-source"}
print("OK")
`);
  assert.equal(output, "OK");
});

test("channel metadata repairs a missing vtuber identity without changing the public contract", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
row = {"detail_key": "", "name": "", "search_text": "", "channel_search_text": "naraetan naraetanv"}
metadata = [{
    "channelKey": "UCFP9UkgIM_U8NfzRbYEOQdA",
    "channelId": "UCFP9UkgIM_U8NfzRbYEOQdA",
    "channelHandle": "/@naraetanV",
    "channelName": "なれたん Naraetan Ch.",
    "channelUrl": "https://www.youtube.com/@naraetanV",
    "avatarUrl": "https://yt3.googleusercontent.com/example=s900",
    "expectedSongCount": 1636,
}]
payload = module._apply_channel_metadata({"count": 4483, "videoCount": 293, "songCount": 0}, row, metadata)
assert payload["name"] == "なれたん Naraetan Ch."
assert payload["channelId"] == "UCFP9UkgIM_U8NfzRbYEOQdA"
assert payload["channelHandle"] == "/@naraetanV"
assert payload["avatarUrl"].startswith("https://yt3.googleusercontent.com/")
assert payload["songCount"] == 1636
assert payload["sourceDetailKey"]
assert module._metadata_for_source_key(metadata, "UCFP9UkgIM_U8NfzRbYEOQdA") is metadata[0]
assert module._metadata_for_source_key(metadata, "/@naraetanV") is metadata[0]
print("OK")
`);
  assert.equal(output, "OK");
});

test("channel source details stay bounded and reuse parent occurrences", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UCFP9UkgIM_U8NfzRbYEOQdA"
metadata = {
    "channelId": channel_id,
    "channelHandle": "/@naraetanV",
    "channelName": "なれたん Naraetan Ch.",
    "avatarUrl": "https://yt3.googleusercontent.com/example=s900",
    "thumbnailUrl": "https://i.ytimg.com/vi/source-default/hqdefault.jpg",
    "sourceDetailKey": module._stable_key("source-vtuber", "all", channel_id),
}
records = [{
    "video": {"videoId": "eKx6coop-bo", "title": "歌枠", "channelId": channel_id, "channelName": ""},
    "occurrences": ({"occurrenceId": "o-1", "position": 0, "rangeId": "all", "title": "Song A", "artist": "Artist A", "seconds": None},),
}]
records[0]["video"]["thumbnailUrl"] = "https://i.ytimg.com/vi/eKx6coop-bo/hqdefault.jpg"
source = module._source_payload_from_channel_records(records, metadata, metadata["sourceDetailKey"], {"page": "1", "pageSize": "1"})
assert source["found"] is True
assert source["record"]["channelName"] == "なれたん Naraetan Ch."
assert source["record"]["avatarUrl"].startswith("https://yt3.googleusercontent.com/")
assert source["record"]["occurrences"][0]["item"]["thumbnailUrl"] == "https://i.ytimg.com/vi/eKx6coop-bo/hqdefault.jpg"
assert source["record"]["occurrences"][0]["song"]["seconds"] is None
print("OK")
`);
  assert.equal(output, "OK");
});

test("persisted source detail pages use every occurrence row and keep its video thumbnail", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Cursor:
    def execute(self, sql, params):
        if "runtime_source_details" in sql:
            self.description = [("payload_json",)]
            self.rows = [(json.dumps({
                "sourceDetailKey": "src-noa",
                "channelName": "Noa",
                "occurrences": [{"videoId": "legacy-preview", "thumbnailUrl": "legacy.jpg"}],
                "songs": ["Song A", "Song B", "Song C"],
            }),)]
        elif "runtime_source_occurrences" in sql:
            self.description = [(name,) for name in ("position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "payload_json")]
            self.rows = [
                (0, "video-a", "A", "Noa", "channel", "@noa", "https://youtube.com/@noa", 1, None, json.dumps({"thumbnailUrl": "a.jpg"})),
                (1, "video-b", "B", "Noa", "channel", "@noa", "https://youtube.com/@noa", 2, 30, json.dumps({"thumbnailUrl": "b.jpg"})),
                (2, "video-c", "C", "Noa", "channel", "@noa", "https://youtube.com/@noa", 3, 60, json.dumps({"thumbnailUrl": "c.jpg"})),
            ]
        else:
            raise AssertionError(sql)
    def fetchall(self):
        return self.rows
    def close(self):
        pass
class Connection:
    def cursor(self):
        return Cursor()
page = module._runtime_source_payload(Connection(), "rev", "src-noa", {"page": "2", "pageSize": "2"})
assert page["found"] is True
assert page["pageCount"] == 2 and page["totalCount"] == 3
assert page["record"]["occurrences"] == [{"thumbnailUrl": "c.jpg", "videoId": "video-c", "title": "C", "channelName": "Noa", "channelId": "channel", "channelHandle": "@noa", "channelUrl": "https://youtube.com/@noa", "publishedAt": 3, "seconds": 60}]
assert page["record"]["occurrencePreviewLimited"] is True
assert module._runtime_source_occurrence({"video_id": "video-null", "seconds": None, "payload_json": "{}"})["seconds"] is None
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic 7d source details replace stale parent previews with accepted rows", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UC7DDETAIL"
key = module._stable_key("source-vtuber", "7d", channel_id)
metadata = {"channelId": channel_id, "channelName": "Channel 7D", "sourceDetailKey": module._stable_key("source-vtuber", "all", channel_id)}
class Cursor:
    def execute(self, sql, params):
        if "FROM runtime_videos" in sql:
            self.description = [(name,) for name in ("video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "payload_json")]
            self.rows = [("old-video", "Old", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", 1, json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/old-video/hqdefault.jpg"}))]
        elif "FROM runtime_occurrences" in sql:
            self.description = [(name,) for name in ("occurrence_id", "range_id", "video_id", "song_key", "seconds", "source_system", "source_id", "title", "artist", "is_niche", "is_unknown_artist", "payload_json")]
            self.rows = [("old-song", "all", "old-video", "old-key", 1, "latest_json", "", "Old song", "Artist", False, False, "{}")]
        elif "FROM migration_occurrence_rows AS o" in sql:
            self.description = [(name,) for name in ("revision_id", "video_id", "occurrence_id", "position", "range_id", "song_key", "seconds", "title", "artist", "source_id", "raw_hash", "source_system", "occurrence_payload_json", "video_title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_at", "video_payload_json", "video_tombstone")]
            self.rows = [
                ("patch", "new-a", "a-song", 0, "7d", "a-key", 10, "Song A", "Artist A", "src-a", "hash-a", "youtube_channel_discovery", "{}", "New A", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-27T00:00:00Z", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-a/hqdefault.jpg"}), False),
                ("patch", "new-b", "b-song", 0, "7d", "b-key", 20, "Song B", "Artist B", "src-b", "hash-b", "youtube_channel_discovery", "{}", "New B", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-28T00:00:00Z", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-b/hqdefault.jpg"}), False),
            ]
        elif "FROM migration_runtime_rows" in sql:
            self.description = [("revision_id",)]
            self.rows = []
        else:
            raise AssertionError(sql)
    def fetchall(self):
        return self.rows
    def close(self):
        pass
class Connection:
    def cursor(self):
        return Cursor()
page = module._runtime_channel_source_payload(Connection(), "parent", metadata, key, {"page": "1", "pageSize": "20"}, overlay_revision_ids=["patch"])
assert page["found"] is True and page["sourceKey"] == key
assert page["record"]["sourceDetailKey"] == key
assert page["totalCount"] == 2 and page["totalOccurrenceCount"] == 2
items = {entry["videoId"]: entry["item"]["thumbnailUrl"] for entry in page["record"]["occurrences"]}
assert items == {"new-a": "https://i.ytimg.com/vi/new-a/hqdefault.jpg", "new-b": "https://i.ytimg.com/vi/new-b/hqdefault.jpg"}
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic source endpoint repairs only a stale range-keyed parent record", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._runtime_projection_revision = lambda connection: None
module._generic_runtime_projection_revision = lambda connection: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["active"]
module._runtime_source_payload = lambda connection, revision_id, key, query, allow_derived, overlay_revision_ids: {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": "all-key", "channelId": "UC7DDETAIL", "legacyField": "kept"}}
module._runtime_channel_source_payload = lambda connection, revision_id, metadata, key, query, overlay_revision_ids: {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "videoCount": 2, "occurrences": [{"videoId": "new-a"}]}, "page": 1}
result = module.source_payload(object(), "seven-day-key", {"page": "1", "pageSize": "20"})
assert result["sourceKey"] == "seven-day-key" and result["page"] == 1
assert result["record"]["legacyField"] == "kept"
assert result["record"]["sourceDetailKey"] == "seven-day-key"
assert result["record"]["videoCount"] == 2
print("OK")
`);
  assert.equal(output, "OK");
});

test("source endpoint prefers persisted detail rows before channel fallback", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Cursor:
    def execute(self, sql, params):
        if "runtime_source_details" in sql:
            self.description = [("payload_json",)]
            self.rows = [(json.dumps({"sourceDetailKey": "src", "occurrences": []}),)]
        elif "runtime_source_occurrences" in sql:
            self.description = [(name,) for name in ("position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "payload_json")]
            self.rows = []
        else:
            raise AssertionError("channel fallback should not be queried: " + sql)
    def fetchall(self):
        return self.rows
    def close(self):
        pass
class Connection:
    def cursor(self):
        return Cursor()
module._runtime_projection_revision = lambda connection: ("rev", {})
result = module.source_payload(Connection(), "src", {"page": "1", "pageSize": "20"})
assert result["found"] is True and result["sourceKey"] == "src"
print("OK")
`);
  assert.equal(output, "OK");
});

test("missing migration tables are an explicit schema error", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class MissingTablesCursor:
    description = [("table_name",)]
    def execute(self, sql, params):
        self.rows = [("migration_state",)]
    def fetchall(self):
        return self.rows
    def close(self):
        pass
class MissingTablesConnection:
    def cursor(self):
        return MissingTablesCursor()
try:
    module.ensure_schema(MissingTablesConnection())
except module.PostgresSchemaError as error:
    assert "missing PostgreSQL migration table(s)" in str(error)
    assert "migration_revisions" in str(error)
else:
    raise AssertionError("expected PostgresSchemaError")
print("OK")
`);
  assert.equal(output, "OK");
});

test("an empty PostgreSQL target is not reported as a healthy active runtime", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class EmptyCursor:
    description = [("state_value",)]
    def execute(self, sql, params):
        if "information_schema.tables" in sql:
            self.description = [("table_name",)]
            self.rows = [(name,) for name in ("migration_revisions", "migration_video_rows", "migration_occurrence_rows", "migration_audit_rows", "migration_state", "migration_runtime_rows")]
        elif "migration_state" in sql:
            self.description = [("state_value",)]
            self.rows = [("")]
        else:
            self.description = [("value",)]
            self.rows = []
    def fetchall(self):
        return self.rows
    def close(self):
        pass
class EmptyConnection:
    def cursor(self):
        return EmptyCursor()
try:
    module.health_payload(EmptyConnection())
except module.PostgresAdapterError as error:
    assert "no active PostgreSQL revision" in str(error)
else:
    raise AssertionError("empty PostgreSQL target must not be healthy")
print("OK")
`);
  assert.equal(output, "OK");
});

test("adapter reads generic runtime video and occurrence overlays", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Cursor:
    def execute(self, sql, params):
        if "parent_revision_id" in sql:
            self.description = [("revision_id",), ("parent_revision_id",)]
            self.rows = [("rev-runtime", None)]
        elif "migration_runtime_rows" in sql:
            self.description = [("entity_type",), ("entity_key",), ("source_system",), ("range_id",), ("source_id",), ("occurrence_id",), ("tombstone",), ("payload_json",)]
            self.rows = [
                ("videos", "video-1", None, None, None, None, False, {"video_id": "AAAAAAAAAAA", "title": "Runtime video", "channel_name": "Channel"}),
                ("occurrences", "video-1-0", "runtime", "all", "src", "occ-1", False, {"video_id": "AAAAAAAAAAA", "position": 0, "seconds": None, "title": "Song", "artist": "", "source_id": "", "range_id": "all"}),
            ]
        else:
            self.description = []
            self.rows = []
    def fetchall(self): return self.rows
    def close(self): pass
class Connection:
    def cursor(self): return Cursor()
snapshot = module._load_generic_runtime_snapshot(Connection(), "rev-runtime", {"manifest_json": {}})
assert len(snapshot.records) == 1
song = snapshot.records[0]["occurrences"][0]
assert song["seconds"] is None and song["artist"] == "" and song["sourceId"] == ""
assert snapshot.records[0]["video"]["channelName"] == "Channel"
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic overlays do not replay ancestors of the full runtime parent", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._revision_lineage = lambda connection, revision_id: ["candidate", "full-runtime", "old-increment"]
assert module._overlay_revision_ids(object(), "candidate", "full-runtime") == ["candidate"]
try:
    module._overlay_revision_ids(object(), "candidate", "missing-full")
except module.PostgresAdapterError as error:
    assert "not in active revision lineage" in str(error)
else:
    raise AssertionError("missing full parent must fail closed")
print("OK")
`);
  assert.equal(output, "OK");
});

test("runtime occurrence tombstones remove one source occurrence only when identity is unique", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Cursor:
    def execute(self, sql, params):
        if "migration_runtime_rows" not in sql:
            raise AssertionError(sql)
        self.description = [(name,) for name in ("revision_id", "entity_type", "entity_key", "source_system", "range_id", "source_id", "occurrence_id", "tombstone", "payload_json")]
        self.rows = [("rev", "occurrences", "occ-1", "latest_json", "all", None, "occ-1", True, json.dumps({"videoId": "video-1", "occurrenceId": "occ-1", "seconds": 30, "title": "Song", "artist": "Artist"}))]
    def fetchall(self): return self.rows
    def close(self): pass
class Connection:
    def cursor(self): return Cursor()
changes = module._runtime_tombstones(Connection(), ["rev"])
one = [{"videoId": "video-1", "seconds": 30, "song": {"title": "Song", "artist": "Artist"}}]
assert module._apply_source_overlay(one, changes) == []
ambiguous = one + [dict(one[0])]
assert len(module._apply_source_overlay(ambiguous, changes)) == 2
assert module._runtime_change_group_key(changes[0], "songs") == "song::artist"
print("OK")
`);
  assert.equal(output, "OK");
});
