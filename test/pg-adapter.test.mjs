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
    "sourceDetailKey": module._stable_key("source-vtuber", "all", channel_id),
}
records = [{
    "video": {"videoId": "eKx6coop-bo", "title": "歌枠", "channelId": channel_id, "channelName": ""},
    "occurrences": ({"occurrenceId": "o-1", "position": 0, "rangeId": "all", "title": "Song A", "artist": "Artist A", "seconds": None},),
}]
source = module._source_payload_from_channel_records(records, metadata, metadata["sourceDetailKey"], {"page": "1", "pageSize": "1"})
assert source["found"] is True
assert source["record"]["channelName"] == "なれたん Naraetan Ch."
assert source["record"]["avatarUrl"].startswith("https://yt3.googleusercontent.com/")
assert source["record"]["occurrences"][0]["song"]["seconds"] is None
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

test("range-specific channel source details use the requested range", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UCFP9UkgIM_U8NfzRbYEOQdA"
mMetadata = {"channelId": channel_id, "channelName": "なれたん Naraetan Ch.", "channelHandle": "/@naraetanV", "expectedSongCount": 1404, "sourceDetailKey": module._stable_key("source-vtuber", "all", channel_id)}
range_key = module._stable_key("source-vtuber", "7d", channel_id)
assert module._metadata_for_source_key([mMetadata], range_key) is mMetadata
ranking = module._apply_channel_metadata({"key": channel_id, "count": 54, "videoCount": 2, "songCount": 0}, {"detail_key": channel_id, "channel_search_text": "naraetan"}, [mMetadata], "7d")
assert ranking["sourceDetailKey"] == range_key and ranking["songCount"] == 0
class Cursor:
    def execute(self, sql, params):
        if "FROM runtime_videos" in sql:
            self.description = [("video_id",), ("title",), ("channel_name",), ("channel_id",), ("channel_handle",), ("channel_url",), ("published_timestamp",), ("payload_json",)]
            self.rows = [("video-7d", "歌枠", "なれたん Naraetan Ch.", channel_id, "/@naraetanV", "https://www.youtube.com/@naraetanV", "2026-07-27T00:00:00Z", {})]
        elif "FROM runtime_occurrences" in sql:
            assert "COALESCE(range_id, 'all') = %s" in sql and params[-1] == "7d"
            self.description = [("occurrence_id",), ("range_id",), ("video_id",), ("song_key",), ("seconds",), ("source_system",), ("source_id",), ("title",), ("artist",), ("is_niche",), ("is_unknown_artist",), ("payload_json",)]
            self.rows = [("occ-7d", "7d", "video-7d", "song-7d", 12, "youtube", "src-7d", "Song 7D", "Artist", False, False, {})]
        else:
            self.description = []
            self.rows = []
    def fetchall(self): return self.rows
    def close(self): pass
class Connection:
    def cursor(self): return Cursor()
source = module._runtime_channel_source_payload(Connection(), "rev", mMetadata, range_key, {"page": "1", "pageSize": "20"})
assert source["found"] is True and source["sourceKey"] == range_key
assert len(source["record"]["occurrences"]) == 1
assert source["record"]["occurrences"][0]["song"]["rangeId"] == "7d"
print("OK")
`);
  assert.equal(output, "OK");
});


test("channel source details merge active overlay videos and occurrences", () => {
  const output = runPython("import importlib.util\nspec = importlib.util.spec_from_file_location(\"pg_adapter\", " + JSON.stringify(ADAPTER) + ")\nmodule = importlib.util.module_from_spec(spec)\nimport sys\nsys.modules[spec.name] = module\nspec.loader.exec_module(module)\nchannel_id = \"UCFP9UkgIM_U8NfzRbYEOQdA\"\nmetadata = {\"channelId\": channel_id, \"channelHandle\": \"/@naraetanV\", \"channelName\": \"\u00e3\u0081\u00aa\u00e3\u201a\u0152\u00e3\u0081\u0178\u00e3\u201a\u201c Naraetan Ch.\", \"sourceDetailKey\": module._stable_key(\"source-vtuber\", \"all\", channel_id)}\nrange_key = module._stable_key(\"source-vtuber\", \"7d\", channel_id)\nclass Cursor:\n    def execute(self, sql, params):\n        if \"FROM runtime_videos\" in sql:\n            self.description = [(name,) for name in (\"video_id\", \"title\", \"channel_name\", \"channel_id\", \"channel_handle\", \"channel_url\", \"published_timestamp\", \"payload_json\")]\n            self.rows = [(\"video-parent\", \"Parent\", \"Naraetan\", channel_id, \"/@naraetanV\", \"https://youtube.com/@naraetanV\", \"2026-07-27T00:00:00Z\", {})]\n        elif \"FROM runtime_occurrences\" in sql:\n            self.description = [(name,) for name in (\"occurrence_id\", \"range_id\", \"video_id\", \"song_key\", \"seconds\", \"source_system\", \"source_id\", \"title\", \"artist\", \"is_niche\", \"is_unknown_artist\", \"payload_json\")]\n            self.rows = [(\"parent-occ\", \"7d\", \"video-parent\", \"parent-song\", 10, \"youtube\", \"src\", \"Parent song\", \"Artist\", False, False, {})]\n        elif \"FROM migration_video_rows\" in sql:\n            self.description = [(name,) for name in (\"revision_id\", \"video_id\", \"title\", \"channel_name\", \"channel_id\", \"channel_handle\", \"channel_url\", \"published_timestamp\", \"tombstone\", \"payload_json\")]\n            self.rows = [(\"overlay\", \"video-overlay\", \"Overlay\", \"Naraetan\", channel_id, \"/@naraetanV\", \"https://youtube.com/@naraetanV\", \"2026-07-27T01:00:00Z\", False, {})]\n        elif \"FROM migration_occurrence_rows\" in sql:\n            self.description = [(name,) for name in (\"revision_id\", \"occurrence_key\", \"occurrence_id\", \"position\", \"range_id\", \"video_id\", \"song_key\", \"seconds\", \"source_system\", \"source_id\", \"title\", \"artist\", \"is_niche\", \"is_unknown_artist\", \"raw_hash\", \"payload_json\")]\n            self.rows = [(\"overlay\", \"overlay-key\", \"overlay-occ\", 0, \"7d\", \"video-overlay\", \"overlay-song\", 20, \"youtube\", \"src\", \"Overlay song\", \"Artist\", False, False, \"hash\", {})]\n        else:\n            self.description = []\n            self.rows = []\n    def fetchall(self): return self.rows\n    def close(self): pass\nclass Connection:\n    def cursor(self): return Cursor()\nsource = module._runtime_channel_source_payload(Connection(), \"full\", metadata, range_key, {\"page\": \"1\", \"pageSize\": \"20\"}, overlay_revision_ids=[\"overlay\"])\nassert source[\"found\"] is True\nassert source[\"totalVideoCount\"] == 2 and source[\"totalOccurrenceCount\"] == 2\nassert {item[\"videoId\"] for item in source[\"record\"][\"occurrences\"]} == {\"video-parent\", \"video-overlay\"}\nprint(\"OK\")\n");
  assert.equal(output, "OK");
});
