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
            self.description = [(name,) for name in ("revision_id", "video_id", "occurrence_id", "position", "range_id", "song_key", "seconds", "title", "artist", "source_id", "raw_hash", "source_system", "video_title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_at", "video_tombstone")]
            self.rows = [
                ("patch", "new-a", "a-song", 0, "7d", "a-key", 10, "Song A", "Artist A", "src-a", "hash-a", "youtube_channel_discovery", "New A", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-27T00:00:00Z", False),
                ("patch", "new-b", "b-song", 0, "7d", "b-key", 20, "Song B", "Artist B", "src-b", "hash-b", "youtube_channel_discovery", "New B", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-28T00:00:00Z", False),
            ]
        elif "SELECT revision_id, video_id, payload_json FROM migration_video_rows" in sql:
            self.description = [(name,) for name in ("revision_id", "video_id", "payload_json")]
            self.rows = [("patch", "new-a", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-a/hqdefault.jpg"})), ("patch", "new-b", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-b/hqdefault.jpg"}))]
        elif "SELECT revision_id, video_id, occurrence_id, position, payload_json FROM migration_occurrence_rows" in sql:
            self.description = [(name,) for name in ("revision_id", "video_id", "occurrence_id", "position", "payload_json")]
            self.rows = [("patch", "new-a", "a-song", 0, "{}"), ("patch", "new-b", "b-song", 0, "{}")]
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


test("persisted source details prefer a nested thumbnail matching the row video", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
item = module._runtime_source_occurrence({"video_id": "right-video", "payload_json": json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/wrong-video/hqdefault.jpg", "video": {"thumbnailUrl": "https://i.ytimg.com/vi/right-video/hqdefault.jpg"}})})
assert item["thumbnailUrl"] == "https://i.ytimg.com/vi/right-video/hqdefault.jpg"
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic incremental rankings return their merged song count", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["candidate"]
module._overlay_candidate_rows = lambda connection, revision_ids: []
module._overlay_candidate_groups = lambda rows, view: {"channel": {"title": "", "artist": "", "name": "Channel", "search": "channel", "occurrences": [{"videoId": "new-video"}], "videoIds": {"new-video"}, "songKeys": {"song-a", "song-b"}}}
module._runtime_tombstones = lambda connection, revision_ids: []
module._channel_metadata_rows = lambda connection, revision_ids: []
module._rows = lambda connection, sql, params: [{"rank": 1, "detail_key": "channel", "title": "", "artist": "", "name": "Channel", "row_count": 8, "song_count": 7, "video_count": 1, "timestamp_count": 8, "search_text": "channel", "channel_search_text": "channel", "payload_json": {"type": "vtuber", "key": "channel", "name": "Channel", "count": 8, "songCount": 0, "videoCount": 1, "timestampCount": 8}}] if "FROM runtime_ranking_rows" in sql else []
payload = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, {"range": "all", "view": "vtubers", "metric": "occurrences", "pageSize": "20"})
assert payload["records"][0]["songCount"] == 9
print("OK")
`);
  assert.equal(output, "OK");
});


test("runtime ranking search uses every whitespace-delimited link token", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
options = module._query_options({"q": "@noa_polaris 10月無口な君を忘れる"})
assert options["searchTokens"] == ["@noa_polaris", "10月無口な君を忘れる"]
assert module._matches_search_tokens("Noa @noa_polaris 10月無口な君を忘れる", options["searchTokens"])
assert not module._matches_search_tokens("Noa @noa_polaris", options["searchTokens"])
module._rows = lambda connection, sql, params: [{"rank": 1, "row_count": 11, "song_count": 1, "video_count": 11, "timestamp_count": 11, "search_text": "10月無口な君を忘れる あたらよ", "channel_search_text": "ノア @noa_polaris", "payload_json": {"title": "10月無口な君を忘れる"}}]
payload = module._runtime_rankings_payload(object(), "rev", {"range": "all", "view": "songs", "metric": "occurrences", "q": "@noa_polaris 10月無口な君を忘れる"})
assert payload["totalCount"] == 1 and payload["records"][0]["title"] == "10月無口な君を忘れる"
print("OK")
`);
  assert.equal(output, "OK");
});

test("unpaged source detail provides one real-video preview per song", () => {
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
            self.rows = [(json.dumps({"sourceDetailKey": "src-noa", "rangeId": "all", "occurrencePreviewLimited": True, "occurrences": [{"videoId": "legacy", "thumbnailUrl": "legacy.jpg"}]}),)]
        elif "runtime_source_occurrences" in sql:
            self.description = [(name,) for name in ("position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "payload_json")]
            self.rows = [
                (0, "video-a", "A", "Noa", "channel", "@noa", "https://youtube.com/@noa", 1, 0, json.dumps({"item": {"videoId": "video-a", "thumbnailUrl": "a.jpg"}, "song": {"songKey": "song-a", "title": "Song A"}})),
                (1, "video-a2", "A2", "Noa", "channel", "@noa", "https://youtube.com/@noa", 2, 1, json.dumps({"item": {"videoId": "video-a2", "thumbnailUrl": "a2.jpg"}, "song": {"songKey": "song-a", "title": "Song A"}})),
                (2, "video-b", "B", "Noa", "channel", "@noa", "https://youtube.com/@noa", 3, 2, json.dumps({"item": {"videoId": "video-b", "thumbnailUrl": "b.jpg"}, "song": {"songKey": "song-b", "title": "Song B"}})),
                (3, "video-c", "C", "Noa", "channel", "@noa", "https://youtube.com/@noa", 4, 3, json.dumps({"item": {"videoId": "video-c", "thumbnailUrl": "c.jpg"}, "song": {"songKey": "song-c", "title": "Song C"}})),
            ]
        else:
            raise AssertionError(sql)
    def fetchall(self): return self.rows
    def close(self): pass
class Connection:
    def cursor(self): return Cursor()
result = module._runtime_source_payload(Connection(), "rev", "src-noa")
assert result["found"] is True
assert result["record"]["occurrenceCount"] == 4 and result["record"]["videoCount"] == 4
previews = result["record"]["occurrences"]
assert [item["item"]["thumbnailUrl"] for item in previews] == ["a.jpg", "b.jpg", "c.jpg"]
assert {item["item"]["videoId"] for item in previews} == {"video-a", "video-b", "video-c"}
print("OK")
`);
  assert.equal(output, "OK");
});
