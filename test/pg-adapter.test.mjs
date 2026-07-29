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
        elif "title AS video_title" in sql and "FROM migration_video_rows" in sql:
            self.description = [(name,) for name in ("revision_id", "video_id", "video_title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_at", "video_payload_json", "video_tombstone")]
            self.rows = [
                ("patch", "new-a", "New A", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-27T00:00:00Z", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-a/hqdefault.jpg"}), False),
                ("patch", "new-b", "New B", "Channel 7D", channel_id, "/@channel7d", "https://youtube.com/@channel7d", "2026-07-28T00:00:00Z", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-b/hqdefault.jpg"}), False),
            ]
        elif "WITH requested_pairs" in sql and "FROM migration_video_rows AS row" in sql:
            self.description = [(name,) for name in ("revision_id", "video_id", "payload_json")]
            self.rows = [("patch", "new-a", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-a/hqdefault.jpg"})), ("patch", "new-b", json.dumps({"thumbnailUrl": "https://i.ytimg.com/vi/new-b/hqdefault.jpg"}))]
        elif "WITH requested_pairs" in sql and "FROM migration_occurrence_rows AS row" in sql:
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
assert page["record"]["songCount"] == 2 and page["record"]["videoCount"] == 2
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

test("generic persisted sources do not revive parent videos after authoritative empty overlays", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._runtime_projection_revision = lambda connection: None
module._generic_runtime_projection_revision = lambda connection: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["accepted-tombstone"]
persisted = {"schemaVersion": 1, "found": True, "sourceKey": "old-key", "record": {"sourceDetailKey": "old-key", "channelId": "UCOLD", "channelHandle": "/@old", "legacyField": "kept", "occurrences": [{"videoId": "video-a"}]}}
def persisted_source(connection, revision_id, key, query, **kwargs):
    if key in {"old-key", "resolved-key", "keep-key"}:
        return {**persisted, "sourceKey": key, "record": {**persisted["record"], "sourceDetailKey": key}}
    return {"schemaVersion": 1, "found": False, "sourceKey": key}
module._runtime_source_payload = persisted_source
module._runtime_source_key_for_channel_alias = lambda connection, revision_id, key: "resolved-key" if key == "alias-key" else ""
module._revision_lineage = lambda *args: ["active", "parent"]
module._channel_metadata_rows = lambda *args: []
def rebuilt(connection, revision_id, metadata, key, query, overlay_revision_ids):
    channel_id = metadata.get("channelId")
    if key == "keep-key":
        return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "channelId": "UCOLD", "occurrences": [{"videoId": "video-keep"}], "videoCount": 1, "songCount": 1}}
    if channel_id == "UCNEW":
        return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"sourceDetailKey": key, "channelId": "UCNEW", "occurrences": [{"videoId": "video-c"}], "videoCount": 1, "songCount": 1}}
    return {"schemaVersion": 1, "found": False, "sourceKey": key}
module._runtime_channel_source_payload = rebuilt
old = module.source_payload(object(), "old-key")
assert old == {"schemaVersion": 1, "found": False, "sourceKey": "old-key"}
resolved = module.source_payload(object(), "alias-key")
assert resolved == {"schemaVersion": 1, "found": False, "sourceKey": "resolved-key"}
keep = module.source_payload(object(), "keep-key")
assert keep["found"] is True and keep["record"]["occurrences"] == [{"videoId": "video-keep"}] and keep["record"]["legacyField"] == "kept"
moved = module.source_payload(object(), "UCNEW")
assert moved["found"] is True and moved["record"]["occurrences"] == [{"videoId": "video-c"}]
# No trusted identity: retain the legacy persisted compatibility fallback.
module._runtime_source_payload = lambda *args, **kwargs: {"schemaVersion": 1, "found": True, "sourceKey": "unknown", "record": {"sourceDetailKey": "unknown", "occurrences": [{"videoId": "legacy"}]}}
module._runtime_channel_source_payload = lambda *args, **kwargs: {"schemaVersion": 1, "found": False, "sourceKey": "unknown"}
unknown = module.source_payload(object(), "unknown")
assert unknown["found"] is True and unknown["record"]["occurrences"] == [{"videoId": "legacy"}]
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

test("newer occurrence-only curation rows override an accepted video projection", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
canonical = "\\u9006\\u5149"
alias_plain = "\\u9006\\u5149(\\u30a6\\u30bf from ONE PIECE FILM RED)"
occurrences = [
    {
        "revision_id": "accepted-old", "video_id": "video-a",
        "occurrence_id": "position:4", "position": 4, "range_id": "all",
        "song_key": "alias", "seconds": 1747, "title": alias_plain,
        "artist": "Ado", "occurrence_payload_json": {"occurrenceId": "position:4"},
    },
    {
        "revision_id": "accepted-old", "video_id": "video-a",
        "occurrence_id": "position:5", "position": 5, "range_id": "all",
        "song_key": "other", "seconds": 1800, "title": "Other",
        "artist": "Artist", "occurrence_payload_json": {"occurrenceId": "position:5"},
    },
]
videos = [{
    "revision_id": "accepted-old", "video_id": "video-a",
    "video_title": "Video A", "channel_id": "UC-A",
    "video_payload_json": {"videoId": "video-a", "channelId": "UC-A"},
    "video_tombstone": False,
}]
module._rows = lambda connection, sql, params: (
    occurrences if "FROM migration_occurrence_rows" in sql else
    videos if "FROM migration_video_rows" in sql else []
)
rows = module._overlay_candidate_rows(object(), ["curation-new", "accepted-old"])
assert len(rows) == 2
by_id = {row["occurrence_id"]: row for row in rows}
assert by_id["position:4"]["revision_id"] == "accepted-old"
assert by_id["position:4"]["title"] == alias_plain
assert by_id["position:4"]["channel_id"] == "UC-A"
assert by_id["position:5"]["title"] == "Other"
module._overlay_runtime_rows = lambda connection, revision_ids: [{
    "revision_id": "curation-new", "entity_type": "occurrences",
    "entity_key": "position:4", "occurrence_id": "position:4",
    "tombstone": False,
    "payload_json": {
        "videoId": "video-a", "occurrenceId": "position:4",
        "position": 4, "rangeId": "all", "seconds": 1747,
        "title": canonical, "artist": "Ado",
        "curationProvenance": {"evidenceUrls": ["private"]},
        "reviewedBy": "private",
        "originalIdentity": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": alias_plain, "artist": "Ado",
        },
    },
}]
changes = module._runtime_tombstones(object(), ["curation-new", "accepted-old"])
replacement_rows = module._runtime_replacement_candidate_rows(changes)
assert len(replacement_rows) == 1
assert replacement_rows[0]["title"] == canonical
public_payload = replacement_rows[0]["occurrence_payload_json"]
assert "curationProvenance" not in public_payload
assert "reviewedBy" not in public_payload
canonical_groups = module._overlay_candidate_groups(replacement_rows, "songs")
assert list(canonical_groups.values())[0]["title"] == canonical
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

test("curation replacements subtract their original song group before adding the canonical row", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
canonical = "\\u9006\\u5149"
alias_star = "\\u2b50\\u9006\\u5149\\uff08\\u30a6\\u30bffrom ONE PIECE FILM RED\\uff09"
alias_display = "\\u9006\\u5149 (\\u30a6\\u30bf from ONE PIECE FILM RED)"
alias_plain = "\\u9006\\u5149(\\u30a6\\u30bf from ONE PIECE FILM RED)"
module._overlay_runtime_rows = lambda connection, revision_ids: [
    {
        "revision_id": "accepted-old", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False, "payload_json": {"title": "Unreviewed"},
    },
    {
        "revision_id": "curation-new", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False,
        "payload_json": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": canonical, "artist": "Ado",
            "originalIdentity": {
                "videoId": "video-a", "occurrenceId": "position:4",
                "title": alias_star, "artist": "Ado",
            },
        },
    },
]
changes = module._runtime_tombstones(object(), ["curation-new", "accepted-old"])
assert len(changes) == 1
assert changes[0]["replacement"] is True
assert changes[0]["title"] == alias_star
assert changes[0]["replacementSameArtist"] is True
assert changes[0]["replacementSameVideo"] is True, changes
assert changes[0]["replacementPayload"]["title"] == canonical, changes
source_rows = [{
    "videoId": "video-a", "occurrenceId": "position:4",
    "seconds": 1747, "title": alias_star, "artist": "Ado",
    "song": {"title": alias_star, "artist": "Ado"},
}]
replaced_source = module._apply_source_overlay(source_rows, changes)
assert len(replaced_source) == 1
assert replaced_source[0]["title"] == canonical
assert replaced_source[0]["song"]["title"] == canonical
groups = {
    "alias-key": {
        "detail_key": "alias-key", "title": alias_display,
        "artist": "Ado", "row_count": 1, "video_count": 1,
        "song_count": 1, "timestamp_count": 1,
        "payload_json": {"count": 1, "videoCount": 1, "timestampCount": 1},
    },
}
module._apply_runtime_tombstone_groups(groups, changes, "songs")
assert groups == {}
partial_group = {
    "alias-key": {
        "detail_key": "alias-key", "title": alias_display,
        "artist": "Ado", "row_count": 3, "video_count": 1,
        "song_count": 1, "timestamp_count": 3,
        "payload_json": {"count": 3, "videoCount": 1, "timestampCount": 3},
    },
}
partial_changes = [
    {
        **changes[0], "occurrenceId": f"position:{index}",
        "originalGroupVideoOccurrenceCount": 3,
    }
    for index in range(2)
]
module._apply_runtime_tombstone_groups(partial_group, partial_changes, "songs")
assert partial_group["alias-key"]["row_count"] == 1
assert partial_group["alias-key"]["video_count"] == 1
artist_groups = {
    "ado": {
        "detail_key": "ado", "artist": "Ado", "row_count": 10,
        "video_count": 10, "song_count": 3, "timestamp_count": 10,
        "payload_json": {},
    },
}
module._apply_runtime_tombstone_groups(artist_groups, changes, "artists")
assert artist_groups["ado"]["row_count"] == 10
artist_change = {
    **changes[0],
    "artist": "Unknown",
    "replacementSameArtist": False,
}
old_artist_groups = {
    "unknown": {
        "detail_key": "unknown", "artist": "Unknown", "row_count": 2,
        "video_count": 2, "song_count": 1, "timestamp_count": 2,
        "payload_json": {},
    },
}
module._apply_runtime_tombstone_groups(old_artist_groups, [artist_change], "artists")
assert old_artist_groups["unknown"]["row_count"] == 1
module._overlay_runtime_rows = lambda connection, revision_ids: [
    {
        "revision_id": "curation-old", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False,
        "payload_json": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": "Middle", "artist": "Ado",
            "originalIdentity": {
                "videoId": "video-a", "occurrenceId": "position:4",
                "title": alias_star, "artist": "Ado",
            },
        },
    },
    {
        "revision_id": "curation-new", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False,
        "payload_json": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": canonical, "artist": "Ado",
            "originalIdentity": {
                "videoId": "video-a", "occurrenceId": "position:4",
                "title": "Middle", "artist": "Ado",
            },
        },
    },
]
chained = module._runtime_tombstones(object(), ["curation-new", "curation-old"])
assert len(chained) == 1
assert chained[0]["title"] == alias_star
assert chained[0]["replacementPayload"]["title"] == canonical
module._overlay_runtime_rows = lambda connection, revision_ids: [
    {
        "revision_id": "curation-old", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False,
        "payload_json": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": "Middle", "artist": "Ado",
            "originalIdentity": {
                "videoId": "video-a", "occurrenceId": "position:4",
                "title": alias_star, "artist": "Ado",
            },
        },
    },
    {
        "revision_id": "accepted-new", "entity_type": "occurrences",
        "entity_key": "position:4", "occurrence_id": "position:4",
        "tombstone": False,
        "payload_json": {
            "videoId": "video-a", "occurrenceId": "position:4",
            "title": "Reviewed accepted", "artist": "Ado",
        },
    },
]
assert module._runtime_tombstones(object(), ["accepted-new", "curation-old"]) == []
replacement_rows = module._runtime_replacement_candidate_rows(changes)
assert len(replacement_rows) == 1
assert replacement_rows[0]["replacement_same_artist"] is True
assert replacement_rows[0]["replacement_same_video"] is True
assert len(module._overlay_candidate_groups(replacement_rows, "songs")) == 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("legacy runtime-row-only chains preserve curation payload sanitization", () => {
  const output = runPython(`
import importlib.util
import json
import sqlite3
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

db = sqlite3.connect(":memory:")
db.execute("""
    CREATE TABLE migration_runtime_rows (
      revision_id TEXT, entity_type TEXT, entity_key TEXT, source_system TEXT,
      range_id TEXT, source_id TEXT, occurrence_id TEXT, tombstone INTEGER,
      payload_json TEXT
    )
""")
def insert(revision, tombstone, payload):
    db.execute(
        "INSERT INTO migration_runtime_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (revision, "occurrences", "occ-1", "accepted", "all", "source-1", "occ-1", tombstone, json.dumps(payload)),
    )

root = {
    "videoId": "video-1", "occurrenceId": "occ-1", "title": "Root A", "artist": "Artist",
    "seconds": 42, "sourceId": "source-1", "rangeId": "all",
}
middle = {
    "videoId": "video-1", "occurrenceId": "occ-1", "title": "Middle B", "artist": "Artist",
    "seconds": 42, "sourceId": "source-1", "rangeId": "all", "originalIdentity": root,
}
final = {
    "videoId": "video-1", "occurrenceId": "occ-1", "title": "Final C", "artist": "Artist",
    "seconds": 42, "sourceId": "source-1", "rangeId": "all", "originalIdentity": middle,
    "curationProvenance": {"evidenceUrls": ["private"]}, "reviewedBy": "private",
    "video": {"videoId": "video-1", "channelId": "UC1", "channelHandle": "/@channel", "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg"},
}
insert("accepted-a", 0, root)
insert("curation-b", 0, middle)
insert("curation-c", 0, final)

def runtime_rows(_connection, revision_ids):
    placeholders = ",".join("?" for _ in revision_ids)
    fields = ("revision_id", "entity_type", "entity_key", "source_system", "range_id", "source_id", "occurrence_id", "tombstone", "payload_json")
    return [dict(zip(fields, row)) for row in db.execute(
        f"SELECT {','.join(fields)} FROM migration_runtime_rows WHERE revision_id IN ({placeholders})", revision_ids
    )]
module._overlay_runtime_rows = runtime_rows

changes = module._runtime_tombstones(object(), ["curation-c", "curation-b", "accepted-a"])
assert len(changes) == 1
assert changes[0]["title"] == "Root A"
assert changes[0]["replacementPayload"]["title"] == "Final C"
assert changes[0]["replacementVideoPayload"]["thumbnailUrl"].endswith("video-1/hqdefault.jpg")
replacement_rows = module._runtime_replacement_candidate_rows(changes)
assert len(replacement_rows) == 1
assert replacement_rows[0]["song_key"] != ""
assert replacement_rows[0]["video_payload_json"]["channelId"] == "UC1"
assert "curationProvenance" not in replacement_rows[0]["occurrence_payload_json"]
assert "reviewedBy" not in replacement_rows[0]["occurrence_payload_json"]

record = {"video": {"videoId": "video-1", "channelId": "UC1", "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg"}, "occurrences": ({"videoId": "video-1", "occurrenceId": "occ-1", "title": "Root A", "artist": "Artist", "seconds": 42},)}
updated = module._apply_record_overlay([record], changes)
assert updated[0]["video"]["thumbnailUrl"].endswith("video-1/hqdefault.jpg")
assert updated[0]["occurrences"][0]["title"] == "Final C"

for view, groups in (
    ("artists", {"artist": {"detail_key": "artist", "artist": "Artist", "row_count": 4, "video_count": 2, "song_count": 3, "timestamp_count": 4, "search_text": "root a artist", "payload_json": {"songCount": 3, "occurrences": [{"videoId": "video-1", "occurrenceId": "occ-1", "seconds": 42, "title": "Root A", "artist": "Artist"}]}}}),
    ("videos", {"video-1": {"detail_key": "video-1", "row_count": 4, "video_count": 1, "song_count": 3, "timestamp_count": 4, "search_text": "root a", "payload_json": {"songCount": 3, "occurrences": [{"videoId": "video-1", "occurrenceId": "occ-1", "seconds": 42, "title": "Root A", "artist": "Artist"}]}}}),
    ("vtubers", {"UC1": {"detail_key": "UC1", "name": "Channel", "row_count": 4, "video_count": 1, "song_count": 3, "timestamp_count": 4, "search_text": "root a", "payload_json": {"songCount": 3, "occurrences": [{"videoId": "video-1", "occurrenceId": "occ-1", "seconds": 42, "title": "Root A", "artist": "Artist"}]}}}),
):
    before = [(row["row_count"], row["video_count"], row["song_count"]) for row in groups.values()]
    module._apply_runtime_tombstone_groups(groups, changes, view)
    module._apply_runtime_change_previews(groups, changes, view)
    after = [(row["row_count"], row["video_count"]) for row in groups.values()]
    assert after == [(count, videos) for count, videos, _songs in before], (view, before, after, groups)
    row = next(iter(groups.values()))
    assert isinstance(row["payload_json"]["songCount"], int)

insert("accepted-new", 0, {"videoId": "video-1", "occurrenceId": "occ-1", "title": "Reviewed", "artist": "Artist"})
assert module._runtime_tombstones(object(), ["accepted-new", "curation-b", "accepted-a"]) == []

db.execute("DELETE FROM migration_runtime_rows WHERE revision_id = 'curation-c'")
insert("curation-c", 1, final)
tombstones = module._runtime_tombstones(object(), ["curation-c", "curation-b", "accepted-a"])
assert len(tombstones) == 1 and tombstones[0]["replacement"] is False
group = {"root": {"detail_key": "root", "title": "Root A", "artist": "Artist", "row_count": 2, "video_count": 1, "timestamp_count": 2, "payload_json": {}}}
tombstones[0]["originalGroupVideoOccurrenceCount"] = 2
module._apply_runtime_tombstone_groups(group, tombstones, "songs")
assert group["root"]["row_count"] == 1 and group["root"]["video_count"] == 1
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
module._runtime_tombstones = lambda *args: []
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
        "range_id": "all",
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
            "rangeId": "all",
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
assert (record["count"], record["videoCount"], record["songCount"]) == (4, 3, 3), record
assert {item["videoId"] for item in record["occurrences"]} == {"video-keep", "video-old", "video-new"}
second = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, query)
assert second["records"][0]["count"] == 4
assert parent_video_queries == 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber replacement aggregation stays in PostgreSQL on real connections", () => {
  const output = runPython(`
import importlib.util
import json
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
        "occurrences": [
            {"videoId": "video-old", "item": {"videoId": "video-old", "channelId": channel_id}},
            {"videoId": "video-keep", "item": {"videoId": "video-keep", "channelId": channel_id}},
        ],
    },
}
aggregate_queries = 0
def rows(connection, sql, params):
    global aggregate_queries
    if "FROM runtime_ranking_rows" in sql:
        assert "'' AS search_text, '' AS channel_search_text" in sql
        return [base_row]
    if "jsonb_to_recordset" in sql:
        aggregate_queries += 1
        assert "o.payload_json::jsonb->>'isNiche'" in sql
        assert sorted(json.loads(params[1])) == ["video-new", "video-old"]
        values = json.loads(params[0])
        assert len(values) == 3
        return [{"channel_id": channel_id, "row_count": 4, "video_count": 3, "song_count": 3}]
    return []
module._rows = rows
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["candidate"]
module._overlay_candidate_rows = lambda *args: candidate_rows
module._runtime_tombstones = lambda *args: []
module._channel_metadata_rows = lambda *args: []
module._VTUBER_REPLACEMENT_CACHE.clear()
class RealConnection:
    def cursor(self):
        raise AssertionError("mocked _rows should own SQL execution")
query = {"range": "7d", "view": "vtubers", "metric": "occurrences", "pageSize": "20"}
payload = module._generic_overlay_rankings_payload(RealConnection(), "candidate", {"revision_id": "candidate"}, query)
record = payload["records"][0]
assert aggregate_queries == 1
assert record["count"] == 4
assert record["videoCount"] == 3
assert record["songCount"] == 3
assert {item["videoId"] for item in record["occurrences"]} == {"video-keep", "video-old", "video-new"}
assert all(item["item"] == item["video"] for item in record["occurrences"])
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
module._runtime_tombstones = lambda *args: []
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

test("overlay candidate rows load each video payload only once", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
occurrences = [
    {"revision_id": "new", "video_id": "video-a", "occurrence_id": "new-1", "position": 0, "occurrence_payload_json": "{}"},
    {"revision_id": "new", "video_id": "video-a", "occurrence_id": "new-2", "position": 1, "occurrence_payload_json": "{}"},
    {"revision_id": "old", "video_id": "video-a", "occurrence_id": "old-1", "position": 0, "occurrence_payload_json": "{}"},
]
video_payload = '{"videoId":"video-a","thumbnailUrl":"https://i.ytimg.com/vi/video-a/hqdefault.jpg"}'
videos = [
    {"revision_id": "new", "video_id": "video-a", "video_title": "New", "channel_id": "UCNEW", "video_payload_json": video_payload, "video_tombstone": False},
    {"revision_id": "old", "video_id": "video-a", "video_title": "Old", "channel_id": "UCOLD", "video_payload_json": '{"videoId":"video-a"}', "video_tombstone": False},
]
queries = []
def rows(connection, sql, params):
    queries.append(sql)
    if "FROM migration_occurrence_rows" in sql:
        assert "migration_video_rows" not in sql
        assert "video_payload_json" not in sql
        return occurrences
    if "FROM migration_video_rows" in sql:
        return videos
    return []
module._rows = rows
resolved = module._overlay_candidate_rows(object(), ["new", "old"])
assert len(queries) == 2
assert [row["occurrence_id"] for row in resolved] == ["new-1", "new-2"]
assert all(row["channel_id"] == "UCNEW" for row in resolved)
assert resolved[0]["video_payload_json"] is resolved[1]["video_payload_json"]
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
module._runtime_tombstones = lambda *args: []
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
    if "WITH requested_pairs" in sql and "FROM migration_occurrence_rows AS row" in sql:
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

test("replacement previews are group-scoped and song cards remove the old identity", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
change = {"entityType": "occurrences", "videoId": "v1", "occurrenceId": "o1", "title": "Old", "artist": "Artist", "replacement": True, "replacementSameArtist": True, "replacementSameVideo": True, "replacementPayload": {"title": "Canonical", "artist": "Artist", "videoId": "v1", "occurrenceId": "o1"}}
song_groups = {
  "old::artist": {"title": "Old", "artist": "Artist", "search_text": "old", "payload_json": {"occurrences": [{"videoId": "v1", "occurrenceId": "o1", "title": "Old", "artist": "Artist"}]}},
  "other::artist": {"title": "Other", "artist": "Artist", "search_text": "other", "payload_json": {"occurrences": [{"videoId": "v2", "occurrenceId": "o2", "title": "Other", "artist": "Artist"}]}},
}
module._apply_runtime_change_previews(song_groups, [change], "songs")
assert song_groups["old::artist"]["payload_json"]["occurrences"] == []
assert "Canonical" not in song_groups["old::artist"]["search_text"]
assert song_groups["other::artist"]["payload_json"]["occurrences"][0]["title"] == "Other"
assert "Canonical" not in song_groups["other::artist"]["search_text"]
artist_groups = {"artist": {"detail_key": "artist", "artist": "Artist", "search_text": "old", "payload_json": {"occurrences": [{"videoId": "v1", "occurrenceId": "o1", "title": "Old", "artist": "Artist"}]}}}
module._apply_runtime_change_previews(artist_groups, [change], "artists")
assert artist_groups["artist"]["payload_json"]["occurrences"][0]["title"] == "Canonical"
assert "Canonical" in artist_groups["artist"]["search_text"]
print("OK")
`);
  assert.equal(output, "OK");
});

test("three-table accepted projections reset runtime chains for rankings and source overlays", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
base = {"videoId": "video-1", "occurrenceId": "occ-1", "title": "A", "artist": "Artist"}
accepted_c = {"videoId": "video-1", "occurrenceId": "occ-1", "title": "C", "artist": "Artist"}
curation_b = {"videoId": "video-1", "occurrenceId": "occ-1", "title": "B", "artist": "Artist", "originalIdentity": base}
curation_d = {"videoId": "video-1", "occurrenceId": "occ-1", "title": "D", "artist": "Artist", "originalIdentity": accepted_c}
def row(revision, payload, tombstone=False):
    return {"revision_id": revision, "entity_type": "occurrences", "entity_key": "occ-1", "occurrence_id": "occ-1", "tombstone": tombstone, "payload_json": payload}
runtime_rows = [row("b", curation_b), row("d", curation_d)]
accepted_occurrences = [
    {"revision_id": "a", "video_id": "video-1", "occurrence_id": "occ-1", "position": 0, "range_id": "all", "source_id": "a", "tombstone": False, "payload_json": base},
    {"revision_id": "c", "video_id": "video-1", "occurrence_id": "occ-1", "position": 0, "range_id": "all", "source_id": "c", "tombstone": False, "payload_json": accepted_c},
]
accepted_videos = [
    {"revision_id": "a", "video_id": "video-1", "tombstone": False, "payload_json": {"videoId": "video-1"}},
    {"revision_id": "c", "video_id": "video-1", "tombstone": False, "payload_json": {"videoId": "video-1"}},
]
module._overlay_runtime_rows = lambda connection, revision_ids: [item for item in runtime_rows if item["revision_id"] in revision_ids]
def rows(_connection, sql, params):
    revision_ids = set(params[0])
    if "FROM migration_occurrence_rows" in sql:
        return [item for item in accepted_occurrences if item["revision_id"] in revision_ids]
    if "FROM migration_video_rows" in sql:
        return [item for item in accepted_videos if item["revision_id"] in revision_ids]
    raise AssertionError(sql)
module._rows = rows
changes = module._runtime_tombstones(object(), ["d", "c", "b", "a"])
assert len(changes) == 1
assert changes[0]["title"] == "C" and changes[0]["replacementPayload"]["title"] == "D"
assert module._runtime_tombstones(object(), ["c", "b", "a"]) == []
runtime_rows[-1] = row("d", {"videoId": "video-1", "occurrenceId": "occ-1", "title": "C", "artist": "Artist"}, tombstone=True)
tombstone = module._runtime_tombstones(object(), ["d", "c", "b", "a"])
assert len(tombstone) == 1 and tombstone[0]["title"] == "C" and tombstone[0]["replacement"] is False
source_rows = [{"videoId": "video-1", "occurrenceId": "occ-1", "title": "C", "artist": "Artist"}]
assert module._apply_source_overlay(source_rows, tombstone) == []
runtime_rows[:] = [row("b", curation_b)]
accepted_occurrences[1] = {**accepted_occurrences[1], "video_id": "video-2", "payload_json": {**accepted_c, "videoId": "video-2"}}
accepted_videos[1] = {**accepted_videos[1], "video_id": "video-2", "payload_json": {"videoId": "video-2"}}
other_video = module._runtime_tombstones(object(), ["c", "b", "a"])
assert len(other_video) == 1 and other_video[0]["title"] == "A"
print("OK")
`);
  assert.equal(output, "OK");
});

test("accepted video resets remove parent cards before public ranking and channel payload overlays", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
parent_a = {"entityType": "occurrences", "videoId": "video-a", "occurrenceId": "old", "title": "Old", "artist": "Artist", "songKey": "old-key", "channel_id": "UC1", "originalGroupVideoOccurrenceCount": 1}
candidate_c = {"revision_id": "accepted-c", "video_id": "video-a", "occurrence_id": "new", "position": 0, "range_id": "all", "song_key": "new-key", "title": "New", "artist": "Artist", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "/@channel", "video_payload_json": {"videoId": "video-a", "channelId": "UC1", "channelName": "Channel", "thumbnailUrl": "c.jpg"}, "occurrence_payload_json": {"videoId": "video-a", "occurrenceId": "new", "songKey": "new-key", "title": "New", "artist": "Artist"}, "video_tombstone": False}
base = [
 {"rank": 1, "detail_key": "old::artist", "title": "Old", "artist": "Artist", "name": "", "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1, "search_text": "old", "channel_search_text": "", "payload_json": {"title": "Old", "displayArtist": "Artist", "count": 1, "songCount": 1, "videoCount": 1, "timestampCount": 1, "occurrences": [{"videoId": "video-a", "occurrenceId": "old", "title": "Old", "artist": "Artist"}]}},
 {"rank": 2, "detail_key": "keep::artist", "title": "Keep", "artist": "Artist", "name": "", "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1, "search_text": "keep", "channel_search_text": "", "payload_json": {"title": "Keep", "displayArtist": "Artist", "count": 1, "songCount": 1, "videoCount": 1, "timestampCount": 1, "occurrences": [{"videoId": "video-keep", "occurrenceId": "keep", "title": "Keep", "artist": "Artist"}]}}
]
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["accepted-c"]
candidate_calls = []
def candidate_loader(*args):
    candidate_calls.append(tuple(args[1]))
    return [candidate_c]
module._overlay_candidate_rows = candidate_loader
module._accepted_video_resets = lambda *args: {"video-a": {"video_id": "video-a", "tombstone": False}}
chain_contexts = []
def chains(*args):
    chain_contexts.append(args[3])
    return []
module._runtime_tombstones = chains
module._enrich_runtime_original_group_counts = lambda *args: None
module._reconcile_affected_song_counts = lambda *args: None
module._channel_metadata_rows = lambda *args: []
def ranking_rows(connection, sql, params):
    if "FROM runtime_ranking_rows" in sql:
        return [dict(row) for row in base]
    if "FROM runtime_occurrences AS o" in sql:
        return [{"video_id": "video-a", "occurrence_id": "old", "song_key": "old-key", "title": "Old", "artist": "Artist", "range_id": "all", "channel_id": "UC1", "channel_name": "Channel", "video_payload_json": {"videoId": "video-a", "channelId": "UC1"}}]
    return []
module._rows = ranking_rows
ranking = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"}, {"range": "all", "view": "songs", "metric": "occurrences", "pageSize": "20"})
assert {record["title"] for record in ranking["records"]} == {"New", "Keep"}
new = next(record for record in ranking["records"] if record["title"] == "New")
assert ranking["totalOccurrenceCount"] == 2 and new["count"] == 1
assert new["occurrences"][0]["occurrenceId"] == "new" and new["occurrences"][0]["item"]["thumbnailUrl"] == "c.jpg"
assert new["sourceDetailKey"] and new.get("sourceDetailPath", "") == ""
assert candidate_calls == [("accepted-c",)] and chain_contexts == [(candidate_c,)]

module._accepted_video_resets = lambda *args: {"video-a": {"video_id": "video-a", "tombstone": True}}
source_candidate_calls = []
def source_candidates(*args):
    source_candidate_calls.append(tuple(args[1]))
    return []
module._overlay_candidate_rows = source_candidates
module._overlay_channel_records = lambda *args: []
source_chain_contexts = []
def source_chains(*args):
    source_chain_contexts.append(args[3])
    return []
module._runtime_tombstones = source_chains
def source_rows(connection, sql, params):
    if "FROM runtime_videos" in sql:
        return [
          {"video_id": "video-a", "title": "Old video", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "/@channel", "channel_url": "https://youtube.com/@channel", "payload_json": {"videoId": "video-a", "thumbnailUrl": "a.jpg"}},
          {"video_id": "video-keep", "title": "Keep video", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "/@channel", "channel_url": "https://youtube.com/@channel", "payload_json": {"videoId": "video-keep", "thumbnailUrl": "keep.jpg"}},
        ]
    if "FROM runtime_occurrences" in sql:
        return [
          {"video_id": "video-a", "occurrence_id": "old", "range_id": "all", "song_key": "old-key", "title": "Old", "artist": "Artist", "payload_json": {}},
          {"video_id": "video-keep", "occurrence_id": "keep", "range_id": "all", "song_key": "keep-key", "title": "Keep", "artist": "Artist", "payload_json": {}},
        ]
    return []
module._rows = source_rows
source = module._runtime_channel_source_payload(object(), "parent", {"channelId": "UC1", "channelName": "Channel"}, "source-key", {"range": "all", "page": "1", "pageSize": "20"}, overlay_revision_ids=["accepted-c"])
assert source["found"] is True
assert {entry["videoId"] for entry in source["record"]["occurrences"]} == {"video-keep"}
assert source["record"]["songCount"] == 1 and source["record"]["videoCount"] == 1
assert source_candidate_calls == [("accepted-c",)] and source_chain_contexts == [()]
print("OK")
`);
  assert.equal(output, "OK");
});

test("accepted video reset parent projection is bounded and excludes unrelated occurrences", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
def rows(connection, sql, params):
    calls.append((sql, params))
    if "FROM migration_video_rows" in sql:
        return [{"revision_id": "accepted-c", "video_id": "video-a", "tombstone": False, "payload_json": {"videoId": "video-a"}}]
    if "FROM runtime_occurrences AS o" in sql:
        # This fake cursor intentionally enforces the PostgreSQL placeholder
        # contract as well as the requested range predicate.  A three-range
        # placeholder expression with only two values would fail here before
        # the public reset projection could silently become stale.
        assert sql.count("%s") == len(params) == 6, (sql, params)
        assert params[:3] == ["parent", "parent", ["video-a"]], params
        assert params[3] == params[4] and params[3] in {"all", "7d"}, params
        rows = [
            {"video_id": "video-a", "occurrence_id": "old-all", "song_key": "old-all", "title": "Old all", "artist": "Artist", "range_id": "all", "channel_id": "UC1", "channel_name": "Channel", "video_payload_json": {"videoId": "video-a", "channelId": "UC1"}},
            {"video_id": "video-a", "occurrence_id": "old-7d", "song_key": "old-7d", "title": "Old 7d", "artist": "Artist", "range_id": "7d", "channel_id": "UC1", "channel_name": "Channel", "video_payload_json": {"videoId": "video-a", "channelId": "UC1"}},
            {"video_id": "video-a", "occurrence_id": "old-legacy", "song_key": "old-legacy", "title": "Old legacy", "artist": "Artist", "range_id": "", "channel_id": "UC1", "channel_name": "Channel", "video_payload_json": {"videoId": "video-a", "channelId": "UC1"}},
        ]
        requested_range = params[3]
        return [row for row in rows if row["range_id"] in {requested_range, ""}]
    raise AssertionError(sql)
module._rows = rows
resets = module._accepted_video_resets(object(), ["accepted-c"])
changes_all = module._accepted_video_reset_changes(object(), "parent", resets, {"range": "all"})
changes_7d = module._accepted_video_reset_changes(object(), "parent", resets, {"range": "7d"})
assert list(resets) == ["video-a"]
assert {change["occurrenceId"] for change in changes_all} == {"old-all", "old-legacy"}
assert {change["occurrenceId"] for change in changes_7d} == {"old-7d", "old-legacy"}
assert all(change["videoId"] != "video-unrelated" for change in changes_all + changes_7d)
video_sql, video_params = calls[0]
parent_sql, parent_params = calls[1]
assert "LIMIT %s" in video_sql and video_params[1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
assert "o.revision_id = %s" in parent_sql and "o.video_id = ANY(%s)" in parent_sql and "LIMIT %s" in parent_sql
assert parent_params[0] == "parent" and parent_params[1] == "parent", repr(parent_params)
assert ["video-a"] in parent_params
assert parent_params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
assert parent_sql.count("%s") == len(parent_params) == 6, (parent_sql, parent_params)
assert "coalesce(o.range_id, '') IN ('all', '')" in parent_sql
assert "coalesce(o.range_id, '') IN ('7d', '')" in parent_sql
assert calls[2][1][3:5] == ["7d", "7d"], calls[2]
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta payload uses bounded effective tuples for resets and replacements", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def occurrence(video_id, occurrence_id, song_key, title="Song", artist="Artist"):
    return {"video_id": video_id, "occurrence_id": occurrence_id, "song_key": song_key, "title": title, "artist": artist, "range_id": "all"}

def candidate(video_id, occurrence_id, song_key, title="Song", artist="Artist"):
    return {
        **occurrence(video_id, occurrence_id, song_key, title, artist),
        "revision_id": "accepted", "position": 0, "range_id": "all",
        "video_payload_json": {"videoId": video_id, "channelId": "UC1"},
        "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": song_key, "title": title, "artist": artist},
        "video_tombstone": False,
    }

def replacement(video_id, occurrence_id, old_key, new_key):
    return {
        "entityType": "occurrences", "videoId": video_id, "occurrenceId": occurrence_id,
        "songKey": old_key, "title": "Alias", "artist": "Artist", "rangeId": "all", "replacement": True,
        "replacementPayload": {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": new_key, "title": "Canonical", "artist": "Artist", "rangeId": "all"},
    }

def meta_case(*, candidates=(), resets=None, reset_changes=(), runtime=(), identity_rows=(), parent_videos=(), song_counts=None):
    resets = dict(resets or {})
    song_counts = dict(song_counts or {})
    module._runtime_projection_revision = lambda *_: None
    module._generic_runtime_projection_revision = lambda *_: ("active", {"status": "accepted", "manifest_json": {}})
    module._generic_parent_runtime_revision = lambda *_: ("parent", {"manifest_json": {}})
    module._overlay_revision_ids = lambda *_: ["accepted"]
    module._overlay_candidate_rows = lambda *_: list(candidates)
    module._accepted_video_resets = lambda *_: resets
    module._accepted_video_reset_changes = lambda *_: list(reset_changes)
    module._runtime_tombstones = lambda *_: list(runtime)
    def rows(_connection, sql, _params):
        if "SELECT key, value FROM runtime_meta" in sql:
            return [
                {"key": "latest_videos", "value": 100},
                {"key": "latest_songs", "value": 50},
                {"key": "latest_occurrences", "value": 200},
                {"key": "latest_ranking_rows", "value": 1},
                {"key": "source_occurrences_rows", "value": 200},
            ]
        if "JOIN unnest" in sql:
            return list(identity_rows)
        if "FROM runtime_ranking_rows" in sql:
            return []
        if "FROM runtime_videos" in sql:
            return [{"video_id": video_id} for video_id in parent_videos]
        if "GROUP BY song_key" in sql:
            return [{"song_key": key, "count": value} for key, value in song_counts.items()]
        raise AssertionError(sql)
    module._rows = rows
    return module.meta_payload(object())["counts"]

# Fourteen Ado alias replacements are occurrence-neutral; canonical already
# exists while every alias is globally unique, so only the vanished aliases
# reduce the distinct-song total.
aliases = [occurrence("video-a", f"alias-{index}", f"alias-{index}", "Alias") for index in range(14)]
replacements = [replacement("video-a", f"alias-{index}", f"alias-{index}", "canonical") for index in range(14)]
counts = meta_case(identity_rows=aliases, runtime=replacements, song_counts={**{f"alias-{index}": 1 for index in range(14)}, "canonical": 6})
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (100, 200, 36)
assert counts["source_occurrences"] == 200

# An accepted full-video projection with a new occurrence id replaces, rather
# than adds to, its parent video.  The old and new unique songs trade places.
counts = meta_case(
    candidates=[candidate("video-a", "new", "new-key", "New")],
    resets={"video-a": {"video_id": "video-a", "tombstone": False}},
    reset_changes=[{**occurrence("video-a", "old", "old-key", "Old"), "videoId": "video-a", "occurrenceId": "old", "songKey": "old-key"}],
    parent_videos=["video-a"], song_counts={"old-key": 1},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (100, 200, 50)
assert counts["source_occurrences"] == 200

# A tombstoned accepted video removes every parent tuple and the video itself.
counts = meta_case(
    resets={"video-dead": {"video_id": "video-dead", "tombstone": True}},
    reset_changes=[
        {**occurrence("video-dead", "one", "dead-one"), "videoId": "video-dead", "occurrenceId": "one", "songKey": "dead-one"},
        {**occurrence("video-dead", "two", "dead-two"), "videoId": "video-dead", "occurrenceId": "two", "songKey": "dead-two"},
    ],
    parent_videos=["video-dead"], song_counts={"dead-one": 1, "dead-two": 1},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (99, 198, 48)
assert counts["source_occurrences"] == 194

# A new accepted video has no parent reset tuple/video but contributes exactly
# its final candidate tuple.  This is also the mixed effective-set invariant.
counts = meta_case(
    candidates=[candidate("video-new", "fresh", "fresh-key", "Fresh")],
    resets={"video-new": {"video_id": "video-new", "tombstone": False}},
    parent_videos=[], song_counts={},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (101, 201, 51)
assert counts["source_occurrences"] == 203

# A legacy accepted occurrence with no range remains one physical occurrence,
# but is deliberately visible through both all and 7d source keys.
legacy = candidate("video-legacy", "legacy", "legacy-key", "Legacy")
legacy.pop("range_id")
legacy["occurrence_payload_json"].pop("rangeId", None)
counts = meta_case(candidates=[legacy], resets={"video-legacy": {"video_id": "video-legacy", "tombstone": False}}, song_counts={})
assert counts["occurrences"] == 201
assert counts["source_occurrences"] == 206
print("OK")
`);
  assert.equal(output, "OK");
});

test("public non-song rankings recount accepted reset aggregates from effective tuples", () => {
  const output = runPython(`
import copy
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def occ(video_id, occurrence_id, song_key, artist="Artist"):
    return {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": song_key, "title": song_key, "artist": artist}

parent = [
    {"video_id": "video-a", "occurrence_id": "a1", "song_key": "a1", "title": "a1", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-a", "channelId": "UCOLD", "channelName": "Old"}},
    {"video_id": "video-a", "occurrence_id": "a2", "song_key": "a2", "title": "a2", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-a", "channelId": "UCOLD", "channelName": "Old"}},
    {"video_id": "video-b", "occurrence_id": "b", "song_key": "b", "title": "b", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-b", "channelId": "UCOLD", "channelName": "Old"}},
]
reset_changes = [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": row["video_id"], "occurrenceId": row["occurrence_id"], "title": row["title"], "artist": row["artist"], "songKey": row["song_key"], "channel_id": "UCOLD", "channel_name": "Old"} for row in parent[:2]]
def candidate(occurrence_id, artist="Artist", channel_id="UCOLD", channel_name="Old", title=None, song_key=None):
    title = title or occurrence_id
    song_key = song_key or occurrence_id
    return {"revision_id": "accepted", "video_id": "video-a", "occurrence_id": occurrence_id, "position": 0, "range_id": "all", "song_key": song_key, "title": title, "artist": artist, "channel_id": channel_id, "channel_name": channel_name, "channel_handle": "/@" + channel_name.lower(), "video_tombstone": False, "video_payload_json": {"videoId": "video-a", "channelId": channel_id, "channelName": channel_name}, "occurrence_payload_json": {"videoId": "video-a", "occurrenceId": occurrence_id, "songKey": song_key, "title": title, "artist": artist}}
def rank(detail_key, *, title="", artist="", name="", rows=(), videos=0):
    count = len(rows)
    return {"rank": 1, "detail_key": detail_key, "title": title, "artist": artist, "name": name, "row_count": count, "song_count": count, "video_count": videos, "timestamp_count": count, "search_text": f"{detail_key} {title} {artist} {name}", "channel_search_text": f"{detail_key} {name}", "payload_json": {"type": "artist", "key": detail_key, "title": title, "displayArtist": artist, "name": name or artist, "count": count, "songCount": count, "videoCount": videos, "timestampCount": count, "occurrences": list(rows)}}

module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["accepted"]
module._accepted_video_resets = lambda *args: {"video-a": {"video_id": "video-a", "tombstone": False}}
module._accepted_video_reset_changes = lambda *args: copy.deepcopy(reset_changes)
module._runtime_tombstones = lambda *args: []
module._enrich_runtime_original_group_counts = lambda *args: None
module._channel_metadata_rows = lambda *args: []
module._overlay_vtuber_replacement_rows = lambda *args: {}

def public(view, candidates, base):
    module._overlay_candidate_rows = lambda *args: copy.deepcopy(candidates)
    def rows(_connection, sql, _params):
        if "FROM runtime_ranking_rows" in sql:
            return copy.deepcopy(base)
        if "FROM runtime_occurrences AS o" in sql:
            return copy.deepcopy(parent)
        return []
    module._rows = rows
    payload = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"}, {"range": "all", "view": view, "metric": "occurrences", "pageSize": "20"})
    return {record["key"]: record for record in payload["records"]}

# Same artist/channel reset: old A's two occurrences are replaced by C's two;
# B and its card identity remain, so count=3 and videoCount=2, never 3.
same = [candidate("c1"), candidate("c2")]
artists = public("artists", same, [rank("artist", artist="Artist", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert (artists["artist"]["count"], artists["artist"]["videoCount"], artists["artist"]["songCount"]) == (3, 2, 3)
assert {item["occurrenceId"] for item in artists["artist"]["occurrences"]} == {"b", "c1", "c2"}

# Channel move: the old VTuber retains only B, while the new one owns C's
# cards.  The unrelated old video cannot be removed or double-counted.
moved = [candidate("c1", channel_id="UCNEW", channel_name="New"), candidate("c2", channel_id="UCNEW", channel_name="New")]
vtubers = public("vtubers", moved, [rank("UCOLD", name="Old", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert (vtubers["UCOLD"]["count"], vtubers["UCOLD"]["videoCount"]) == (1, 1)
assert (vtubers["UCNEW"]["count"], vtubers["UCNEW"]["videoCount"]) == (2, 1)
assert {item["occurrenceId"] for item in vtubers["UCNEW"]["occurrences"]} == {"c1", "c2"}

# Artist rename follows the same bounded effective projection.
renamed = [candidate("c1", artist="Renamed"), candidate("c2", artist="Renamed")]
artist_rename = public("artists", renamed, [rank("artist", artist="Artist", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert (artist_rename["artist"]["count"], artist_rename["artist"]["videoCount"]) == (1, 1)
assert (artist_rename["renamed"]["count"], artist_rename["renamed"]["videoCount"]) == (2, 1)

# Video groups are also reconciled; B is an unaffected parent group.
videos = public("videos", same, [rank("video-a", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2")], videos=1), rank("video-b", rows=[occ("video-b", "b", "b")], videos=1)])
assert (videos["video-a"]["count"], videos["video-a"]["videoCount"]) == (2, 1)
assert (videos["video-b"]["count"], videos["video-b"]["videoCount"]) == (1, 1)

def counts(record):
    return (record["count"], record["videoCount"], record["songCount"], record["timestampCount"])

# An accepted video tombstone has no candidate row.  Public ranking
# reconciliation must still keep the unrelated B tuple only; each view and
# its serialized payload report the same exact one-row result.
module._accepted_video_resets = lambda *args: {"video-a": {"video_id": "video-a", "tombstone": True}}
module._runtime_tombstones = lambda *args: []
tomb_song = public("songs", [], [rank("a1::artist", title="a1", artist="Artist", rows=[occ("video-a", "a1", "a1")], videos=1), rank("a2::artist", title="a2", artist="Artist", rows=[occ("video-a", "a2", "a2")], videos=1), rank("b::artist", title="b", artist="Artist", rows=[occ("video-b", "b", "b")], videos=1)])
assert set(tomb_song) == {"b::artist"} and counts(tomb_song["b::artist"]) == (1, 1, 1, 1)
tomb_artist = public("artists", [], [rank("artist", artist="Artist", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert counts(tomb_artist["artist"]) == (1, 1, 1, 1) and {item["occurrenceId"] for item in tomb_artist["artist"]["occurrences"]} == {"b"}
tomb_video = public("videos", [], [rank("video-a", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2")], videos=1), rank("video-b", rows=[occ("video-b", "b", "b")], videos=1)])
assert set(tomb_video) == {"video-b"} and counts(tomb_video["video-b"]) == (1, 1, 1, 1)
tomb_vtuber = public("vtubers", [], [rank("UCOLD", name="Old", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert counts(tomb_vtuber["UCOLD"]) == (1, 1, 1, 1) and {item["occurrenceId"] for item in tomb_vtuber["UCOLD"]["occurrences"]} == {"b"}

# A later runtime tombstone is also remove-only.  It cannot be reintroduced
# by effective reconciliation after the preliminary aggregate decrement.
module._accepted_video_resets = lambda *args: {}
module._accepted_video_reset_changes = lambda *args: []
module._runtime_tombstones = lambda *args: [{"entityType": "occurrences", "videoId": "video-b", "occurrenceId": "b", "title": "b", "artist": "Artist", "songKey": "b", "channel_id": "UCOLD"}]
runtime_tomb = public("artists", [], [rank("artist", artist="Artist", rows=[occ("video-a", "a1", "a1"), occ("video-a", "a2", "a2"), occ("video-b", "b", "b")], videos=2)])
assert counts(runtime_tomb["artist"]) == (2, 1, 2, 2)
assert {item["occurrenceId"] for item in runtime_tomb["artist"]["occurrences"]} == {"a1", "a2"}

# A non-tombstoned reset may reuse an occurrence id.  Its C candidate remains
# final because accepted reset removals never pop re-added candidate tuples.
module._accepted_video_resets = lambda *args: {"video-a": {"video_id": "video-a", "tombstone": False}}
module._accepted_video_reset_changes = lambda *args: copy.deepcopy(reset_changes)
module._runtime_tombstones = lambda *args: []
same_identity = public("songs", [candidate("a1", title="C", song_key="canonical-c")], [rank("a1::artist", title="a1", artist="Artist", rows=[occ("video-a", "a1", "a1")], videos=1), rank("a2::artist", title="a2", artist="Artist", rows=[occ("video-a", "a2", "a2")], videos=1), rank("b::artist", title="b", artist="Artist", rows=[occ("video-b", "b", "b")], videos=1)])
assert set(same_identity) == {"c::artist", "b::artist"}
assert counts(same_identity["c::artist"]) == (1, 1, 1, 1)
assert same_identity["c::artist"]["occurrences"][0]["occurrenceId"] == "a1"
print("OK")
`);
  assert.equal(output, "OK");
});

test("tombstone chains reuse parsed candidate occurrences and fail closed on fallback cap", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
base = {"videoId": "video-a", "occurrenceId": "occ", "title": "C", "artist": "Artist"}
runtime = [{"revision_id": "d", "entity_type": "occurrences", "entity_key": "occ", "occurrence_id": "occ", "tombstone": False, "payload_json": {"originalIdentity": base, "videoId": "video-a", "occurrenceId": "occ", "title": "D", "artist": "Artist"}}]
candidate = [{"revision_id": "c", "video_id": "video-a", "occurrence_id": "occ", "position": 0, "range_id": "all", "source_id": "c", "occurrence_payload_json": base}]
videos = [{"revision_id": "c", "video_id": "video-a", "tombstone": False, "payload_json": {"videoId": "video-a"}}]
module._overlay_runtime_rows = lambda *args: runtime
calls = []
module._rows = lambda *args: calls.append(args[1]) or (_ for _ in ()).throw(AssertionError("parsed candidate context must avoid migration occurrence query"))
changes = module._runtime_tombstones(object(), ["d", "c"], videos, candidate)
assert len(changes) == 1 and changes[0]["title"] == "C" and changes[0]["replacementPayload"]["title"] == "D"
assert calls == []
fallback_sql = []
def fallback_rows(connection, sql, params):
    fallback_sql.append((sql, params))
    if "FROM migration_occurrence_rows" in sql:
        return [{}] * (module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    return []
module._rows = fallback_rows
try:
    module._runtime_tombstones(object(), ["c"])
except module.PostgresAdapterError as error:
    assert "accepted occurrence reset lookup exceeded bounded occurrence cap" in str(error)
else:
    raise AssertionError("fallback occurrence lookup must fail closed over cap")
sql, params = fallback_sql[0]
assert "LIMIT %s" in sql and params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("source detail recounts unique final songs after canonical merge and deletion", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
record = {"songCount": 99, "videoCount": 99}
rows = [
  {"videoId": "v1", "songKey": "canonical"},
  {"videoId": "v1", "songKey": "canonical"},
  {"videoId": "v2", "song": {"title": "Other", "artist": "Artist"}},
]
counted = module._recount_source_detail(record, rows)
assert (counted["count"], counted["videoCount"], counted["songCount"]) == (3, 2, 2)
deleted = module._recount_source_detail(counted, rows[:2])
assert (deleted["count"], deleted["videoCount"], deleted["songCount"]) == (2, 1, 1)
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic song source rebuild includes accepted and alias tuples without reviving the old source", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)

canonical_source = "80c535cc50c98482"
alias_sources = {
    "alias-one-source": ("alias-one", "Alias one"),
    "alias-two-source": ("alias-two", "Alias two"),
    "alias-three-source": ("alias-three", "Alias three"),
    "alias-four-source": ("alias-four", "Alias four"),
}
assert module._production_source_detail_key_for_group("songs", "all", "逆光::ado") == "80c535cc50c98482"
assert len(module._production_source_detail_key_for_group("artists", "all", "ado")) == 16
assert len(module._production_source_detail_key_for_group("vtubers", "all", "UCADO")) == 16
assert module._production_source_detail_key_for_group("videos", "all", "video-a") == ""
def persisted(key, song_key, title):
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {
        "type": "song", "key": song_key, "title": title, "displayArtist": "Ado",
        "rangeId": "all", "sourceDetailKey": key, "sourceDetailPath": "",
        "legacyField": "kept",
    }}

def parent(video_id, occurrence_id, song_key, title):
    return {"video_id": video_id, "occurrence_id": occurrence_id, "position": 0,
        "range_id": "all", "song_key": song_key, "seconds": 10, "title": title,
        "artist": "Ado", "source_id": occurrence_id, "source_system": "youtube",
        "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id,
            "songKey": song_key, "title": title, "artist": "Ado", "seconds": 10},
        "video_title": "Video " + video_id, "channel_id": "UC" + video_id,
        "channel_name": "Channel " + video_id, "channel_handle": "@" + video_id,
        "channel_url": "https://youtube.com/channel/UC" + video_id,
        "video_payload_json": {"videoId": video_id, "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
            "channelId": "UC" + video_id, "channelName": "Channel " + video_id}}

canonical_parent = [parent("canon-%03d" % index, "canon-%03d" % index, "ado-db-canonical", "逆光") for index in range(399)]
alias_parent = []
for group_index, (song_key, title, count) in enumerate((
    ("alias-one", "Alias one", 11),
    ("alias-two", "Alias two", 1),
    ("alias-three", "Alias three", 1),
    ("alias-four", "Alias four", 1),
)):
    alias_parent.extend(
        parent("alias-%d-%02d" % (group_index, index), "alias-%d-%02d" % (group_index, index), song_key, title)
        for index in range(count)
    )
accepted = [parent("accepted-%d" % index, "accepted-%d" % index, "ado-db-canonical", "逆光") for index in range(3)]
for row in accepted:
    row.update({"revision_id": "accepted", "video_tombstone": False})

changes = []
for index, row in enumerate(alias_parent):
    changes.append({"entityType": "occurrences", "videoId": row["video_id"], "occurrenceId": row["occurrence_id"],
        "songKey": row["song_key"], "title": row["title"], "artist": "Ado", "replacement": True,
        "replacementPayload": {"videoId": row["video_id"], "occurrenceId": row["occurrence_id"],
            "songKey": "ado-db-canonical", "title": "逆光", "artist": "Ado", "seconds": 10},
        "replacementVideoPayload": row["video_payload_json"]})

module._generic_runtime_projection_revision = lambda *_: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["runtime", "accepted"]
def persisted_loader(_connection, revision, key, query, **kwargs):
    if revision != "parent": return {"schemaVersion": 1, "found": False, "sourceKey": key}
    if key == canonical_source: return persisted(key, "逆光::ado", "逆光")
    if key in alias_sources:
        song_key, title = alias_sources[key]
        return persisted(key, song_key, title)
    return {"schemaVersion": 1, "found": False, "sourceKey": key}
module._runtime_source_payload = persisted_loader
module._overlay_candidate_rows = lambda *_: list(accepted)
module._accepted_video_resets = lambda *_: {}
module._runtime_tombstones = lambda *_: list(changes)
module._channel_metadata_rows = lambda *_: []
def rows(_connection, sql, params):
    if "FROM runtime_occurrences AS o" in sql:
        assert "o.song_key = %s" in sql and "LIMIT %s" in sql
        return list(canonical_parent if params[2] == "逆光::ado" else alias_parent[:13] if params[2] == "alias-main" else [])
    if "runtime_ranking_rows" in sql:
        return []
    raise AssertionError(sql)
module._rows = rows

# The runtime table stores the DB song key, while the persisted public source
# key is the normalised display key.  Keep the SQL fixture faithful: each old
# alias group gets only its own parent rows, never a mocked cross-group scan.
def selected_rows(_connection, sql, params):
    if "FROM runtime_occurrences AS o" in sql:
        assert "o.song_key = %s" in sql and "LIMIT %s" in sql
        if str(params[2]).startswith("alias-"):
            return [row for row in alias_parent if row["song_key"] == params[2]]
        if params[2] == "new-db-key" or params[3] == "New overlay song":
            return []
        return list(canonical_parent)
    if "runtime_ranking_rows" in sql:
        return []
    raise AssertionError(sql)
module._rows = selected_rows

canonical = module.source_payload(object(), canonical_source, {"range": "all", "page": "1", "pageSize": "20"})
assert canonical["found"] is True
assert canonical["sourceKey"] == canonical_source
assert canonical["record"]["sourceDetailKey"] == canonical_source, canonical
assert canonical["record"]["sourceDetailPath"] == "", canonical
assert canonical["record"]["legacyField"] == "kept"
assert canonical["record"]["count"] == canonical["totalOccurrenceCount"] == 416
assert len(canonical["record"]["occurrences"]) == 20 and canonical["pageCount"] == 21
assert canonical["record"]["occurrences"][0]["item"]["thumbnailUrl"].startswith("https://i.ytimg.com/vi/")
for alias_source in alias_sources:
    old = module.source_payload(object(), alias_source, {"range": "all", "page": "1", "pageSize": "20"})
    assert old == {"schemaVersion": 1, "found": False, "sourceKey": alias_source}, old

# A full-video accepted reset removes the old parent tuple before the accepted
# projection is added; a tombstone does not let that source revive it.
module._accepted_video_resets = lambda *_: {"canon-000": {"video_id": "canon-000", "tombstone": True}}
module._overlay_candidate_rows = lambda *_: []
module._runtime_tombstones = lambda *_: []
reset = module.source_payload(object(), canonical_source)
assert reset["found"] is True and reset["record"]["count"] == 398

# A delta-only song card has no parent runtime_source_details row.  Its stable
# card key must still resolve through the bounded candidate tuple set.
new_row = parent("new-video", "new-occ", "new-db-key", "New overlay song")
new_row.update({"revision_id": "accepted", "video_tombstone": False})
new_group = "new overlay song::ado"
new_source = module._production_source_detail_key_for_group("songs", "all", new_group)
module._accepted_video_resets = lambda *_: {}
module._overlay_candidate_rows = lambda *_: [new_row]
new_payload = module.source_payload(object(), new_source, {"range": "all", "page": "1", "pageSize": "20"})
assert new_payload["found"] is True and new_payload["record"]["count"] == 1, new_payload
assert new_payload["record"]["sourceDetailKey"] == new_source
assert new_payload["record"]["sourceDetailPath"] == ""
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta ranking rows use bounded display-group existence deltas", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
old = {("video-a", "old"): {"video_id": "video-a", "occurrence_id": "old", "title": "Old", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD"}}
rows = []
for view, count in (("songs", 3), ("artists", 2), ("vtubers", 3), ("videos", 1)):
    key = {"songs": "old::artist", "artists": "artist", "vtubers": "UCOLD", "videos": "video-a"}[view]
    rows.append({"range_id": "all", "view": view, "detail_key": key, "row_count": 1})
calls = []
def loader(_connection, sql, params):
    calls.append((sql, params))
    requested = set(zip(params[0], params[1], params[2]))
    return [row for row in rows if (row["range_id"], row["view"], row["detail_key"]) in requested]
module._rows = loader
assert module._apply_generic_overlay_ranking_row_delta(object(), "parent", old, {}, 9) == 0, calls
new = {("video-b", "new"): {"video_id": "video-b", "occurrence_id": "new", "title": "New", "artist": "Artist", "range_id": "all", "channel_id": "UCNEW"}}
assert module._apply_generic_overlay_ranking_row_delta(object(), "parent", {}, new, 0) == 7, calls
sql, params = calls[0]
assert "WITH affected_groups" in sql and "unnest(%s::text[], %s::text[], %s::text[])" in sql
assert "affected_group.range_id = row.range_id" in sql and "LIMIT %s" in sql
assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("overlay SQL keeps physical ranges strict and bounds exact tuple lookups", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Connection:
    def cursor(self): return object()
candidate = {"revision_id": "accepted", "video_id": "video-a", "occurrence_id": "occ-a", "position": 0, "range_id": "all", "song_key": "song-a", "title": "Song", "artist": "Artist", "channel_id": "UC1", "video_tombstone": False, "video_payload_json": {"videoId": "video-a", "channelId": "UC1", "channelName": "Channel"}, "occurrence_payload_json": {"videoId": "video-a", "occurrenceId": "occ-a", "songKey": "song-a", "title": "Song", "artist": "Artist"}}
range_calls = []
def vtuber_rows(_connection, sql, params):
    assert "(%s = 'all' AND coalesce(o.range_id, '') IN ('all', ''))" in sql
    assert "(%s = '7d' AND coalesce(o.range_id, '') IN ('7d', ''))" in sql
    assert params[5] == params[6] and params[5] in {"all", "7d"}, params
    range_calls.append(tuple(params[5:7]))
    return [{"channel_id": "UC1", "row_count": 1, "video_count": 1, "song_count": 1}]
module._rows = vtuber_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
for public_range in ("all", "7d"):
    module._overlay_vtuber_replacement_rows(Connection(), "active", "parent", [candidate], {"range": public_range}, {})
assert range_calls == [("all", "all"), ("7d", "7d")]

pair_calls = []
def pair_rows(_connection, sql, params):
    pair_calls.append((sql, params))
    assert "WITH requested_pairs" in sql and "unnest(%s::text[], %s::text[])" in sql
    assert params[:2] == [["accepted"], ["video-a"]] and params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
    if "migration_video_rows AS row" in sql:
        return [{"revision_id": "accepted", "video_id": "video-a", "payload_json": {"videoId": "video-a", "channelId": "UC1"}}]
    return [{"revision_id": "accepted", "video_id": "video-a", "occurrence_id": "occ-a", "position": 0, "payload_json": {"title": "Song", "artist": "Artist"}}]
module._rows = pair_rows
records = module._overlay_channel_records(object(), [candidate], {"channelId": "UC1"})
assert len(records) == 1 and len(pair_calls) == 2
def over_video(_connection, sql, params):
    if "migration_video_rows AS row" in sql:
        return [{}] * (module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    return []
module._rows = over_video
try:
    module._overlay_channel_records(object(), [candidate], {"channelId": "UC1"})
    raise AssertionError("video cap was not enforced")
except module.PostgresAdapterError: pass
def over_occurrence(_connection, sql, params):
    if "migration_video_rows AS row" in sql: return []
    return [{}] * (module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
module._rows = over_occurrence
try:
    module._overlay_channel_records(object(), [candidate], {"channelId": "UC1"})
    raise AssertionError("occurrence cap was not enforced")
except module.PostgresAdapterError: pass

source_calls = []
def source_rows(_connection, sql, params):
    source_calls.append((sql, params))
    if "runtime_source_details" in sql:
        return [{"payload_json": {"sourceDetailKey": "source", "occurrences": []}}]
    if "migration_runtime_rows" in sql or "migration_occurrence_rows" in sql:
        return []
    if "migration_video_rows" in sql:
        assert "ORDER BY revision_id, video_id" in sql and "LIMIT %s" in sql
        assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        return [{}] * (module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    raise AssertionError(sql)
module._rows = source_rows
try:
    module._runtime_source_payload(object(), "parent", "source", {"page": "1"}, overlay_revision_ids=["accepted"])
    raise AssertionError("accepted video fallback cap was not enforced")
except module.PostgresAdapterError: pass
assert any("migration_video_rows" in sql for sql, _ in source_calls)

old = {("v", "o"): {"video_id": "v", "occurrence_id": "o", "title": "Old", "artist": "Artist", "range_id": "all", "channel_id": "UC1"}}
meta_calls = []
def meta_rows(_connection, sql, params):
    meta_calls.append((sql, params))
    assert "WITH affected_groups" in sql and "unnest(%s::text[], %s::text[], %s::text[])" in sql
    assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
    requested = set(zip(params[0], params[1], params[2]))
    available = [{"range_id": "all", "view": "songs", "detail_key": "old::artist", "row_count": 1}, {"range_id": "7d", "view": "songs", "detail_key": "old::artist", "row_count": 99}]
    return [row for row in available if (row["range_id"], row["view"], row["detail_key"]) in requested]
module._rows = meta_rows
assert module._apply_generic_overlay_ranking_row_delta(object(), "parent", old, {}, 9) == 6
print("OK")
`);
  assert.equal(output, "OK");
});
