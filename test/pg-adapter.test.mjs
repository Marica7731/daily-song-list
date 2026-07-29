import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const ADAPTER = path.join(ROOT, "server", "pg_adapter.py");
const IDENTITY_AUDIT = path.join(ROOT, "scripts", "migration", "audit-ranking-source-identities.py");
const ADAPTER_WORKFLOW = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "deploy-pg-adapter-contract.yml"),
  "utf8",
);

function workflowRunBlocks(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const contentIndent = match[1].length + 2;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) < contentIndent) {
        index -= 1;
        break;
      }
      body.push(line.slice(Math.min(contentIndent, line.length)));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}
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
  runPython(`compile(open(${JSON.stringify(IDENTITY_AUDIT)}, encoding="utf-8").read(), ${JSON.stringify(IDENTITY_AUDIT)}, "exec")`);
});

test("ranking identity audit detects card, occurrence, URL, and thumbnail mismatches", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
assert module.active_revision({"active_revision_id": "direct"}) == "direct"
assert module.active_revision({"meta": {"active_revision_id": "wrapped"}}) == "wrapped"
assert module.active_revision({"meta": {"meta": {"active_revision_id": "http-envelope"}}}) == "http-envelope"
good = {
    "key": "UCGOOD",
    "channelId": "UCGOOD",
    "channelHandle": "/@good",
    "channelUrl": "https://www.youtube.com/channel/UCGOOD",
    "sourceDetailKey": "source-good",
    "occurrences": [{
        "item": {
            "videoId": "video-good",
            "channelId": "UCGOOD",
            "channelHandle": "/@good",
            "thumbnailUrl": "https://i.ytimg.com/vi/video-good/hqdefault.jpg",
        },
        "video": {
            "videoId": "video-good",
            "channelId": "UCGOOD",
            "channelHandle": "/@good",
            "thumbnailUrl": "https://i.ytimg.com/vi/video-good/hqdefault.jpg",
        },
    }],
}
assert module.audit_record(good) == set()
bad = {
    **good,
    "channelId": "UCWRONG",
    "channelHandle": "/@wrong",
    "channelUrl": "https://www.youtube.com/@other",
    "occurrences": [{
        "item": {**good["occurrences"][0]["item"], "thumbnailUrl": "https://i.ytimg.com/vi/other/hqdefault.jpg"},
        "video": good["occurrences"][0]["video"],
    }],
}
problems = module.audit_record(bad)
assert "card_channel_url_mismatch" in problems
assert "card_occurrence_channel_id_mismatch" in problems
assert "card_occurrence_handle_mismatch" in problems
assert "item_video_identity_mismatch" in problems
assert "thumbnail_video_id_mismatch" in problems
print("OK")
`);
  assert.equal(output, "OK");
});

test("ranking identity audit prints its full summary before failing probes", () => {
  const output = runPython(`
import contextlib
import importlib.util
import io
import json
import sys
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
def fetch_json(base_url, path, timeout):
    if path == "/healthz":
        return 200, 1, {"status": "ok"}
    if path == "/api/meta":
        return 200, 1, {"meta": {"active_revision_id": "active"}}
    if path.startswith("/api/sources/source-key"):
        return 200, 1, {
            "found": True,
            "totalOccurrenceCount": 1,
            "record": {"channelId": "UCEXPECTED", "occurrenceCount": 1, "videoCount": 1},
        }
    raise AssertionError(path)
module.fetch_json = fetch_json
sys.argv = [
    "audit", "--base-url", "http://candidate", "--skip-rankings",
    "--negative-query", "", "--expected-active", "active",
    "--source-probe", "source-key,UCEXPECTED,2,2",
]
stream = io.StringIO()
with contextlib.redirect_stdout(stream):
    try:
        module.main()
    except RuntimeError as error:
        assert "gateErrors=2" in str(error)
    else:
        raise AssertionError("probe mismatch must fail")
summary_line = next(line for line in stream.getvalue().splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert summary["affectedRecords"] == 0
assert summary["gateErrors"] == [
    "source occurrence count mismatch: source-key expected=2 actual=1",
    "source video count mismatch: source-key expected=2 actual=1",
]
print("OK")
`);
  assert.equal(output, "OK");
});

test("adapter release workflow is fail-closed around identity and rollback gates", () => {
  assert.match(ADAPTER_WORKFLOW, /expected_active_revision/u);
  assert.match(ADAPTER_WORKFLOW, /audit-ranking-source-identities\.py/u);
  assert.match(
    ADAPTER_WORKFLOW,
    /--range all --range 7d[\s\\]+--metric count --metric songs --metric videos/u,
  );
  assert.match(ADAPTER_WORKFLOW, /--page-size 200 --max-pages 20/u);
  assert.match(ADAPTER_WORKFLOW, /--page-size 200 --max-pages 20 --timeout 60/u);
  assert.equal((ADAPTER_WORKFLOW.match(/--skip-rankings --timeout 60/gu) || []).length, 2);
  assert.match(ADAPTER_WORKFLOW, /trap rollback_adapter ERR/u);
  assert.match(ADAPTER_WORKFLOW, /production-public-identity-audit\.log/u);
  assert.doesNotMatch(ADAPTER_WORKFLOW, /for n in \\\$\(seq 1 20\); do curl .*\/healthz/u);
  assert.match(ADAPTER_WORKFLOW, /ss -ltn 'sport = :18766'/u);
  assert.match(ADAPTER_WORKFLOW, /--max-time 60[\s\\]+http:\/\/127\.0\.0\.1:18766\/healthz/u);
  assert.match(ADAPTER_WORKFLOW, /systemd-run --quiet --collect --unit="\$candidate_unit"/u);
  assert.match(ADAPTER_WORKFLOW, /--property=RuntimeMaxSec=13m/u);
  assert.match(ADAPTER_WORKFLOW, /journalctl -u "\$candidate_unit" -n 80 --no-pager/u);
  assert.match(ADAPTER_WORKFLOW, /timeout --signal=TERM --kill-after=15s 12m/u);
  assert.match(ADAPTER_WORKFLOW, /systemctl stop "\$candidate_unit"/u);
  const blocks = workflowRunBlocks(ADAPTER_WORKFLOW);
  assert.ok(blocks.length >= 6);
  for (const [index, block] of blocks.entries()) {
    const normalized = block.replace(/\$\{\{[^}]+\}\}/gu, "CODEX_WORKFLOW_EXPRESSION");
    const result = spawnSync("bash", ["-n"], {
      input: normalized,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `run block ${index + 1}: ${result.stderr}`);
  }
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

test("channel metadata cannot relabel a card with a different exact source identity", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
mikoto_id = "UCkZif4byA067Xl_c199w3BQ"
shin_id = "UC5zO6IFsWSUHMYgJMv81XKg"
urameshi_id = "UC8VlcljjGFb4-Ny2Heb0-ew"
meda_id = "UC0HX1e5jJnhN5Xn0epV2wzA"
metadata = [
    {"channelId": shin_id, "channelHandle": "/@shingames7857", "channelName": "shin"},
    {"channelId": meda_id, "channelHandle": "/@MEDAzcd", "channelName": "MEDA"},
    {"channelId": mikoto_id, "channelHandle": "/@mikoto_songs", "channelName": "Mikoto"},
    {"channelId": urameshi_id, "channelHandle": "/@urameshi_conta", "channelName": "Conta Urameshi"},
]
mikoto = module._apply_channel_metadata(
    {
        "key": mikoto_id,
        "channelId": mikoto_id,
        "channelHandle": "/@mikoto_songs",
        "channelUrl": "https://www.youtube.com/@shingames7857",
        "sourceDetailKey": "mikoto-source",
        "occurrences": [{"item": {"channelId": mikoto_id, "channelHandle": "/@mikoto_songs"}}],
    },
    {
        "detail_key": mikoto_id,
        "name": "Mikoto",
        "search_text": "Mikoto SHINING STAR",
        "channel_search_text": "@mikoto_songs",
    },
    metadata,
)
assert mikoto["key"] == mikoto_id
assert mikoto["channelId"] == mikoto_id
assert mikoto["channelHandle"] == "/@mikoto_songs"
assert mikoto["name"] == "Mikoto"
assert mikoto["sourceDetailKey"] == "mikoto-source"
assert mikoto["channelUrl"] == f"https://www.youtube.com/channel/{mikoto_id}"
urameshi = module._apply_channel_metadata(
    {
        "key": urameshi_id,
        "channelId": urameshi_id,
        "channelHandle": "/@urameshi_conta",
        "channelUrl": "https://www.youtube.com/@MEDAzcd",
        "occurrences": [{
            "item": {
                "videoId": "expected-video",
                "thumbnailUrl": "https://i.ytimg.com/vi/expected-video/hqdefault.jpg",
                "channelId": urameshi_id,
                "channelHandle": "/@urameshi_conta%20legacy",
            },
            "video": {
                "videoId": "expected-video",
                "thumbnailUrl": "https://i.ytimg.com/vi/expected-video/hqdefault.jpg",
                "channelId": urameshi_id,
                "channelHandle": "/@urameshi_conta%20legacy",
            },
        }],
    },
    {"detail_key": urameshi_id, "search_text": "MEDA", "channel_search_text": "@urameshi_conta"},
    metadata,
    "7d",
)
assert urameshi["key"] == urameshi_id
assert urameshi["channelId"] == urameshi_id
assert urameshi["channelHandle"] == "/@urameshi_conta"
assert urameshi["name"] == "Conta Urameshi"
assert urameshi["sourceDetailKey"] == module._stable_key("source-vtuber", "7d", urameshi_id)
assert urameshi["occurrences"][0]["item"]["channelHandle"] == "/@urameshi_conta"
assert urameshi["occurrences"][0]["video"]["channelHandle"] == "/@urameshi_conta"
assert urameshi["occurrences"][0]["item"]["thumbnailUrl"].endswith("/expected-video/hqdefault.jpg")
print("OK")
`);
  assert.equal(output, "OK");
});

test("a unique occurrence identity repairs cards without metadata and remains addressable", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UCP0Eq4VN3bUB5EJUerAugSQ"
payload = module._apply_channel_metadata(
    {
        "key": channel_id,
        "occurrences": [{
            "item": {"videoId": "video-id", "channelId": channel_id, "channelHandle": "/@Mihako_Tarta"},
            "video": {"videoId": "video-id", "channelId": channel_id, "channelHandle": "/@Mihako_Tarta"},
        }],
    },
    {"detail_key": channel_id},
    [],
)
assert payload["channelId"] == channel_id
assert payload["channelHandle"] == "/@Mihako_Tarta"
assert payload["channelUrl"] == f"https://www.youtube.com/channel/{channel_id}"
assert payload["sourceDetailKey"] == channel_id
assert payload["sourceDetailPath"] == f"/api/sources/{channel_id}"
assert payload["occurrences"][0]["item"] == payload["occurrences"][0]["video"]
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

test("generic source endpoint rebuilds persisted parent detail with accepted overlays", () => {
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
module._runtime_source_payload = lambda connection, revision_id, key, query, allow_derived, overlay_revision_ids: {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "channelId": "UC7DDETAIL", "legacyField": "kept", "videoCount": 1}}
module._runtime_channel_source_payload = lambda connection, revision_id, metadata, key, query, overlay_revision_ids: {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "videoCount": 2, "occurrences": [{"videoId": "new-a"}]}, "page": 1}
result = module.source_payload(object(), "all-key", {"page": "1", "pageSize": "20"})
assert result["sourceKey"] == "all-key" and result["page"] == 1
assert result["record"]["legacyField"] == "kept"
assert result["record"]["sourceDetailKey"] == "all-key"
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

test("VTuber overlay rankings replace parent videos before recomputing counts", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UC8VlcljjGFb4-Ny2Heb0-ew"
def candidate(video_id, occurrence_id, song_key, position):
    return {
        "revision_id": "candidate",
        "video_id": video_id,
        "occurrence_id": occurrence_id,
        "position": position,
        "range_id": "7d",
        "song_key": song_key,
        "title": song_key,
        "artist": "Artist",
        "video_payload_json": {
            "videoId": video_id,
            "channelId": channel_id,
            "channelHandle": "/@urameshi_conta",
            "channelName": "Conta Urameshi",
        },
        "occurrence_payload_json": {
            "occurrenceId": occurrence_id,
            "songKey": song_key,
            "title": song_key,
            "artist": "Artist",
            "rangeId": "7d",
        },
    }
candidate_rows = [
    candidate("video-old", "candidate-old", "song-d", 0),
    candidate("video-new", "candidate-new-1", "song-d", 0),
    candidate("video-new", "candidate-new-2", "song-e", 1),
]
base_row = {
    "rank": 1,
    "detail_key": channel_id,
    "title": "",
    "artist": "",
    "name": "Conta Urameshi",
    "row_count": 3,
    "song_count": 3,
    "video_count": 2,
    "timestamp_count": 3,
    "search_text": "Conta Urameshi",
    "channel_search_text": "@urameshi_conta",
    "payload_json": {
        "type": "vtuber",
        "key": channel_id,
        "channelId": channel_id,
        "channelHandle": "/@urameshi_conta",
        "count": 3,
        "songCount": 3,
        "videoCount": 2,
        "timestampCount": 3,
    },
}
parent_videos = [
    {
        "video_id": "video-old", "title": "Old", "channel_name": "Conta Urameshi",
        "channel_id": channel_id, "channel_handle": "/@urameshi_conta",
        "channel_url": f"https://www.youtube.com/channel/{channel_id}",
        "published_timestamp": 1, "payload_json": {},
    },
    {
        "video_id": "video-keep", "title": "Keep", "channel_name": "Conta Urameshi",
        "channel_id": channel_id, "channel_handle": "/@urameshi_conta",
        "channel_url": f"https://www.youtube.com/channel/{channel_id}",
        "published_timestamp": 2, "payload_json": {},
    },
]
parent_occurrences = [
    {"video_id": "video-old", "occurrence_id": "old-a", "range_id": "all", "song_key": "song-a", "title": "song-a", "artist": "Artist", "payload_json": {}},
    {"video_id": "video-old", "occurrence_id": "old-b", "range_id": "all", "song_key": "song-b", "title": "song-b", "artist": "Artist", "payload_json": {}},
    {"video_id": "video-keep", "occurrence_id": "keep-c", "range_id": "all", "song_key": "song-c", "title": "song-c", "artist": "Artist", "payload_json": {}},
]
parent_video_queries = 0
def rows(connection, sql, params):
    global parent_video_queries
    if "FROM runtime_ranking_rows" in sql:
        return [base_row]
    if "FROM runtime_videos" in sql:
        parent_video_queries += 1
        return parent_videos
    if "FROM runtime_occurrences" in sql:
        return parent_occurrences
    return []
module._rows = rows
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["candidate"]
module._overlay_candidate_rows = lambda *args: candidate_rows
module._runtime_tombstones = lambda *args: []
module._channel_metadata_rows = lambda *args: []
module._VTUBER_REPLACEMENT_CACHE.clear()
query = {"range": "all", "view": "vtubers", "metric": "occurrences", "pageSize": "20"}
first = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, query)
record = first["records"][0]
assert record["channelId"] == channel_id
assert record["count"] == 4
assert record["videoCount"] == 3
assert record["songCount"] == 3
assert {item["videoId"] for item in record["occurrences"]} == {"video-keep", "video-old", "video-new"}
second = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, query)
assert second["records"][0]["count"] == 4
assert parent_video_queries == 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic incremental ranking search includes overlay channel identities", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
matched_row = {
    "video_id": "video-urameshi",
    "video_title": "Karaoke",
    "channel_name": "Conta Urameshi",
    "channel_id": "UC8VlcljjGFb4-Ny2Heb0-ew",
    "channel_handle": "/@urameshi_conta",
    "channel_url": "https://www.youtube.com/@urameshi_conta",
    "occurrence_id": "occurrence-1",
    "position": 0,
    "range_id": "7d",
    "song_key": "song-a",
    "title": "Song A",
    "artist": "Artist A",
}
same_song_other_channel = {
    **matched_row,
    "video_id": "video-other-a",
    "channel_name": "Other Channel",
    "channel_id": "UCOTHER",
    "channel_handle": "/@other",
    "channel_url": "https://www.youtube.com/@urameshi_conta",
    "occurrence_id": "occurrence-2",
}
other_song = {
    **same_song_other_channel,
    "video_id": "video-other-b",
    "occurrence_id": "occurrence-3",
    "song_key": "song-b",
    "title": "Song B",
}
rows = [same_song_other_channel, other_song, matched_row]
groups = module._overlay_candidate_groups(rows, "songs")
assert "@urameshi_conta" not in module._overlay_candidate_search_text(same_song_other_channel)
search = groups["song a::artist a"]["search"]
assert "uc8vlcljjgfb4-ny2heb0-ew" in search
assert "/@urameshi_conta" in search
assert "https://www.youtube.com/@urameshi_conta" in search
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["candidate"]
module._overlay_candidate_rows = lambda connection, revision_ids: rows
module._runtime_tombstones = lambda connection, revision_ids: []
module._rows = lambda connection, sql, params: []
payload = module._generic_overlay_rankings_payload(
    object(),
    "candidate",
    {"revision_id": "candidate"},
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "pageSize": "30",
        "q": "@urameshi_conta",
        "searchFields": "title,channel",
    },
)
assert payload["totalCount"] == 1
assert payload["records"][0]["title"] == "Song A"
assert payload["records"][0]["count"] == 1
assert payload["records"][0]["videoCount"] == 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic overlay occurrences preserve the exact video identity and thumbnail", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UC8VlcljjGFb4-Ny2Heb0-ew"
row = {
    "video_id": "lUDCE3zZmuQ",
    "video_title": "Karaoke",
    "channel_name": "Conta Urameshi",
    "channel_id": channel_id,
    "channel_handle": "/@urameshi_conta",
    "channel_url": "https://www.youtube.com/@MEDAzcd",
    "video_payload_json": {
        "videoId": "lUDCE3zZmuQ",
        "thumbnailUrl": "https://i.ytimg.com/vi/lUDCE3zZmuQ/hqdefault.jpg",
        "channelId": channel_id,
        "channelHandle": "/@urameshi_conta",
    },
    "occurrence_id": "position:9463",
    "position": 0,
    "range_id": "7d",
    "song_key": "song-a",
    "title": "Song A",
    "artist": "Artist A",
    "seconds": 9463,
    "occurrence_payload_json": {"sourceHash": "hash-a"},
}
group = module._overlay_candidate_groups([row], "vtubers")[channel_id]
occurrence = group["occurrences"][0]
assert occurrence["item"] == occurrence["video"]
assert occurrence["item"]["videoId"] == "lUDCE3zZmuQ"
assert occurrence["item"]["channelId"] == channel_id
assert occurrence["item"]["channelHandle"] == "/@urameshi_conta"
assert occurrence["item"]["thumbnailUrl"] == "https://i.ytimg.com/vi/lUDCE3zZmuQ/hqdefault.jpg"
assert occurrence["song"]["seconds"] == 9463
assert occurrence["sourceHash"] == "hash-a"
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic incremental rankings keep stored identity fields after count merges", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
title = "\u6c34\u6d41\u306e\u30ed\u30c3\u30af"
artist = "\u65e5\u98df\u306a\u3064\u3053"
key = f"{title.casefold()}::{artist.casefold()}"
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["candidate"]
module._overlay_candidate_rows = lambda connection, revision_ids: []
module._overlay_candidate_groups = lambda rows, view: {key: {"title": title, "artist": artist, "name": title, "search": f"{title} {artist} @noa_polaris", "occurrences": [{"videoId": "new-video"}], "videoIds": {"new-video"}, "songKeys": {key}}}
module._runtime_tombstones = lambda connection, revision_ids: []
module._channel_metadata_rows = lambda connection, revision_ids: []
module._rows = lambda connection, sql, params: [{"rank": 1, "detail_key": key, "title": title, "artist": artist, "name": "", "row_count": 494, "song_count": 0, "video_count": 475, "timestamp_count": 494, "search_text": f"{title} {artist}", "channel_search_text": "@noa_polaris"}] if "FROM runtime_ranking_rows" in sql else []
module._one = lambda connection, sql, params: {"payload_json": {"type": "song", "key": key, "title": title, "displayArtist": artist, "count": 494, "songCount": 0, "videoCount": 475, "timestampCount": 494, "sourceDetailKey": "source-water"}}
payload = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, {"range": "all", "view": "songs", "metric": "occurrences", "pageSize": "20", "q": f"@noa_polaris {title}"})
record = payload["records"][0]
assert record["title"] == title
assert record["displayArtist"] == artist
assert record["sourceDetailKey"] == "source-water"
assert record["count"] == 495 and record["videoCount"] == 476 and record["songCount"] == 1
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


test("vtuber records expose their existing source endpoint even without metadata", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = module._apply_channel_metadata({"sourceDetailKey": "29ae50b7975dbdcf"}, {}, [])
assert payload["sourceDetailPath"] == "/api/sources/29ae50b7975dbdcf"
assert module._with_source_detail_path({"sourceDetailPath": "/custom", "sourceDetailKey": "src"})["sourceDetailPath"] == "/custom"
print("OK")
`);
  assert.equal(output, "OK");
});


test("VTuber aliases resolve the persisted occurrences-metric source detail", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
def rows(connection, sql, params):
    calls.append((sql, params))
    return [{"payload_json": json.dumps({"sourceDetailKey": "source-noa"})}]
module._rows = rows
assert module._runtime_source_key_for_channel_alias(object(), "active", "UCIu1rRiQLeUU8e1saN6I0eg") == "source-noa"
assert len(calls) == 1 and "metric = 'count'" in calls[0][0]
assert calls[0][1] == ["active", "UCIu1rRiQLeUU8e1saN6I0eg", "%UCIu1rRiQLeUU8e1saN6I0eg%"]
module._runtime_projection_revision = lambda connection: ("active", {})
module._runtime_source_payload = lambda connection, revision_id, key, query, **kwargs: {"schemaVersion": 1, "found": key == "source-noa", "sourceKey": key}
module._channel_metadata_rows = lambda *args: []
module._revision_lineage = lambda *args: []
assert module.source_payload(object(), "UCIu1rRiQLeUU8e1saN6I0eg")["sourceKey"] == "source-noa"
print("OK")
`);
  assert.equal(output, "OK");
});


test("VTuber aliases choose the unique largest persisted source", () => {
  const output = runPython(`
import importlib.util
import json
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._rows = lambda connection, sql, params: [
    {"row_count": 2, "payload_json": json.dumps({"sourceDetailKey": "partial"})},
    {"row_count": 4712, "payload_json": json.dumps({"sourceDetailKey": "full"})},
]
assert module._runtime_source_key_for_channel_alias(object(), "active", "UCIu1rRiQLeUU8e1saN6I0eg") == "full"
module._rows = lambda connection, sql, params: [
    {"row_count": 4712, "payload_json": json.dumps({"sourceDetailKey": "one"})},
    {"row_count": 4712, "payload_json": json.dumps({"sourceDetailKey": "two"})},
]
assert module._runtime_source_key_for_channel_alias(object(), "active", "UCIu1rRiQLeUU8e1saN6I0eg") == ""
print("OK")
`);
  assert.equal(output, "OK");
});


test("generic overlays resolve channel aliases before channel metadata fallback", () => {
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
module._runtime_source_key_for_channel_alias = lambda connection, revision_id, key: "complete-source"
module._runtime_source_payload = lambda connection, revision_id, key, query, **kwargs: {"schemaVersion": 1, "found": key == "complete-source", "sourceKey": key, "record": {"sourceDetailKey": key, "channelId": "UC7DDETAIL", "legacyField": "kept", "occurrences": [{"videoId": "full-video"}]}}
calls = []
def rebuilt(connection, revision_id, metadata, key, query, overlay_revision_ids):
    calls.append((revision_id, metadata["channelId"], key, overlay_revision_ids))
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "occurrences": [{"videoId": "new-video"}]}}
module._runtime_channel_source_payload = rebuilt
module._channel_metadata_rows = lambda *args: (_ for _ in ()).throw(AssertionError("metadata fallback must not run"))
result = module.source_payload(object(), "UCIu1rRiQLeUU8e1saN6I0eg", {"page": "1"})
assert result["found"] is True and result["sourceKey"] == "complete-source"
assert result["record"]["occurrences"] == [{"videoId": "new-video"}]
assert result["record"]["legacyField"] == "kept"
assert calls == [("parent", "UC7DDETAIL", "complete-source", ["active"])]
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic source details rebuild a channel-id key without metadata", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UCP0Eq4VN3bUB5EJUerAugSQ"
module._runtime_projection_revision = lambda connection: None
module._generic_runtime_projection_revision = lambda connection: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["active"]
module._runtime_source_payload = lambda *args, **kwargs: {"schemaVersion": 1, "found": False, "sourceKey": args[2]}
module._runtime_source_key_for_channel_alias = lambda *args: ""
module._channel_metadata_rows = lambda *args: []
module._revision_lineage = lambda *args: ["active", "parent"]
calls = []
def rebuilt(connection, revision_id, metadata, key, query, overlay_revision_ids):
    calls.append((revision_id, metadata, key, overlay_revision_ids))
    return {"schemaVersion": 1, "found": True, "sourceKey": key}
module._runtime_channel_source_payload = rebuilt
result = module.source_payload(object(), channel_id)
assert result["found"] is True and result["sourceKey"] == channel_id
assert calls == [("parent", {"channelId": channel_id}, channel_id, ["active"])]
print("OK")
`);
  assert.equal(output, "OK");
});


test("channel source rebuild preserves a legacy persisted source key", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
metadata = {
    "sourceDetailKey": "cf1354d9534576ab",
    "channelId": "UC7cZJOAJZD1W4aOfqnRgWiA",
    "channelHandle": "/@MunMosh",
}
canonical_key = module._stable_key("source-vtuber", "all", metadata["channelId"])
def rows(connection, sql, params):
    if "FROM runtime_videos" in sql:
        assert "channel_id = %s" in sql
        assert "channel_handle = %s" not in sql and "channel_name = %s" not in sql
        return [{
            "video_id": "parent-video",
            "title": "Parent",
            "channel_name": "MunMosh",
            "channel_id": metadata["channelId"],
            "channel_handle": metadata["channelHandle"],
            "channel_url": "https://youtube.com/@MunMosh",
            "payload_json": {},
        }]
    if "FROM runtime_occurrences" in sql:
        return []
    if "FROM migration_occurrence_rows AS o" in sql:
        return [{
            "revision_id": "candidate",
            "video_id": "overlay-video",
            "occurrence_id": "position:0",
            "position": 1,
            "range_id": "7d",
            "song_key": "song-key",
            "seconds": 770,
            "title": "Song",
            "artist": "Artist",
            "source_id": "@urameshi_conta",
            "raw_hash": "raw",
            "source_system": "youtube_channel_discovery",
            "video_title": "Overlay",
            "channel_name": "",
            "channel_id": "",
            "channel_handle": "",
            "channel_url": "https://youtube.com/@urameshi_conta",
            "published_at": "2026-07-27T11:33:06Z",
            "video_payload_json": {
                "channelId": metadata["channelId"],
                "channelHandle": metadata["channelHandle"],
            },
            "video_tombstone": False,
        }]
    if "FROM migration_video_rows" in sql:
        return [{
            "revision_id": "candidate",
            "video_id": "overlay-video",
            "payload_json": {
                "videoId": "overlay-video",
                "channelId": metadata["channelId"],
                "channelHandle": metadata["channelHandle"],
            },
        }]
    if "FROM migration_occurrence_rows WHERE" in sql:
        return [{
            "revision_id": "candidate",
            "video_id": "overlay-video",
            "occurrence_id": "position:0",
            "position": 1,
            "payload_json": {
                "title": "Song",
                "artist": "Artist",
                "seconds": 770,
            },
        }]
    if "FROM migration_runtime_rows" in sql:
        return []
    raise AssertionError(sql)
module._rows = rows
result = module._runtime_channel_source_payload(
    object(), "parent", metadata, metadata["sourceDetailKey"],
    {"page": "1", "pageSize": "100"}, overlay_revision_ids=["candidate"],
)
assert canonical_key == "f25caaaaafb523a6dd9a8a27"
assert result["found"] is True
assert result["sourceKey"] == metadata["sourceDetailKey"]
assert result["record"]["sourceDetailKey"] == metadata["sourceDetailKey"]
assert result["record"]["sourceDetailPath"] == "/api/sources/cf1354d9534576ab"
matches = [
    item for item in result["record"]["occurrences"]
    if item["videoId"] == "overlay-video"
    and item["song"]["title"] == "Song"
    and item["song"]["artist"] == "Artist"
    and item["song"]["seconds"] == 770
]
assert len(matches) == 1
print("OK")
`);
  assert.equal(output, "OK");
});
