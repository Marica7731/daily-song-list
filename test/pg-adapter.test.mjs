import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const SUPPORT_ROOT = process.env.PG_ADAPTER_TEST_SUPPORT_ROOT
  ? path.resolve(process.env.PG_ADAPTER_TEST_SUPPORT_ROOT)
  : ROOT;
const ADAPTER = process.env.PG_ADAPTER_UNDER_TEST
  ? path.resolve(process.env.PG_ADAPTER_UNDER_TEST)
  : path.join(ROOT, "server", "pg_adapter.py");
const IDENTITY_AUDIT = path.join(
  SUPPORT_ROOT,
  "scripts",
  "migration",
  "audit-ranking-source-identities.py",
);
const ADAPTER_WORKFLOW_PATH = path.join(
  SUPPORT_ROOT,
  ".github",
  "workflows",
  "deploy-pg-adapter-contract.yml",
);
const ADAPTER_WORKFLOW_BYTES = fs.existsSync(ADAPTER_WORKFLOW_PATH)
  ? fs.readFileSync(ADAPTER_WORKFLOW_PATH)
  : Buffer.from("");
const ADAPTER_WORKFLOW = ADAPTER_WORKFLOW_BYTES.toString("utf8");

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

function projectRuntimeVideo(row) {
  const encoded = JSON.stringify(JSON.stringify(row));
  const view = JSON.stringify(row.view ?? "");
  return JSON.parse(runPython(`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
row = json.loads(${encoded})
result = module._project_runtime_video_payload(row, view=${view})
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
`));
}

function runtimeVideoProjectionError(row) {
  const encoded = JSON.stringify(JSON.stringify(row));
  const view = JSON.stringify(row.view ?? "");
  return runPython(`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
row = json.loads(${encoded})
try:
    module._project_runtime_video_payload(row, view=${view})
except module.PostgresAdapterError as exc:
    print(str(exc))
else:
    raise AssertionError("expected a fail-closed video identity conflict")
`);
}

test("adapter parses without creating pycache files", () => {
  runPython(`compile(open(${JSON.stringify(ADAPTER)}, encoding="utf-8").read(), ${JSON.stringify(ADAPTER)}, "exec")`);
  runPython(`compile(open(${JSON.stringify(IDENTITY_AUDIT)}, encoding="utf-8").read(), ${JSON.stringify(IDENTITY_AUDIT)}, "exec")`);
});

test("focused runtime video ranking cards project bounded active-overlay metadata", () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(TEST_DIR, "..", "..", "fixture", "runtime-video-rankings.json"), "utf8"),
  );
  const output = runPython(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
fixture = json.loads(${JSON.stringify(JSON.stringify(fixture))})
row = fixture["runtimeVideoRow"]

def rows(_connection, sql, params):
    if "FROM migration_video_rows" in sql:
        assert list(params[0]) == ["accepted-current", "accepted-parent"]
        assert list(params[1]) == [row["video_id"]]
        assert list(params[2]) == ["accepted-current", "accepted-parent"]
        return [row]
    assert "FROM migration_occurrence_rows" in sql
    assert list(params[0]) == ["accepted-current"]
    assert list(params[1]) == [row["video_id"]]
    return [
        {
            "revision_id": "accepted-current",
            "video_id": row["video_id"],
            "occurrence_key": f"occ-{index}",
            "occurrence_id": f"occ-{index}",
            "position": index,
            "range_id": "all",
            "song_key": f"song-{index % 44}",
            "seconds": index * 10,
            "title": f"Song {index % 44}",
            "artist": f"Artist {index % 7}",
            "source_id": "source-jul22",
            "raw_hash": f"raw-{index}",
            "source_system": "youtube_channel_discovery",
            "payload_json": {},
        }
        for index in range(88)
    ]

module._rows = rows
result = module._project_generic_overlay_video_records(
    object(), ("accepted-current", "accepted-parent"),
    fixture["response"], view="videos",
)
record = result["records"][0]
assert record["videoId"] == row["video_id"]
assert record["channelId"] == "UC-authoritative"
assert record["channelName"] == "Authoritative Channel"
assert record["publishedAt"] == "2026-07-22T00:00:00Z"
assert record["publishedTimestamp"] == 1784678400000
assert record["sourceSystem"] == "youtube_channel_discovery"
assert record["rangeId"] == "all"
assert record["sourceDetailKey"] == module._stable_key(
    "source-video", "all", row["video_id"],
)
assert record["title"] == "Authoritative Jul22 video"
assert record["name"] == "Authoritative Jul22 video"
assert record["count"] == 88
assert record["timestampCount"] == 88
assert record["songCount"] == 44
assert record["videoCount"] == 1
assert len(record["songs"]) == 88
assert record["songs"][0]["occurrenceId"] == "occ-0"
assert record["songs"][87]["position"] == 87
assert "totalOccurrenceCount" not in record
assert module._project_generic_overlay_video_records(
    object(), ("accepted-current",), fixture["response"], view="songs",
) == fixture["response"]
print("OK")
`);
  assert.equal(output, "OK");
});

test("page-1 VTuber preparation keeps accepted overlay aggregation inside PostgreSQL", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self):
        return object()

base = {
    "rank": 1, "detail_key": "UC-TOP", "title": "", "artist": "",
    "name": "Top", "row_count": 10, "song_count": 8,
    "video_count": 4, "timestamp_count": 10,
    "payload_json": {
        "type": "vtuber", "key": "UC-TOP", "channelId": "UC-TOP",
        "channelName": "Top", "channelHandle": "@top",
        "count": 10, "songCount": 8, "videoCount": 4,
        "timestampCount": 10, "occurrences": [],
    },
}
accepted = {
    "accepted-video": {
        "revision_id": "accepted", "video_id": "accepted-video",
        "video_title": "Accepted", "channel_name": "Top",
        "channel_id": "UC-TOP", "channel_handle": "@top",
        "channel_url": "https://www.youtube.com/@top",
        "published_at": None, "tombstone": False, "payload_json": None,
    },
}
calls = {"candidate": 0, "direct": 0}

module._overlay_revision_ids = lambda *_: ["accepted"]
module._resolve_exact_vtuber_channel_scope = lambda *_: None
module._accepted_video_resets = lambda *_args: dict(accepted)
module._accepted_video_reset_identity_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args: []
module._runtime_replacement_candidate_rows = lambda *_args: []
module._channel_metadata_rows = lambda *_args: []

def forbidden_candidate_loader(*_args):
    calls["candidate"] += 1
    raise AssertionError("page-1 used the unbounded overlay candidate row loader")

module._overlay_candidate_rows = forbidden_candidate_loader

def rows(_connection, sql, params):
    if "FROM runtime_ranking_rows" in sql:
        return [dict(base)]
    raise AssertionError(sql)

module._rows = rows

def exact(
    _connection, _active, _parent, candidate_rows, _options, _groups,
    _reset_changes=(), _runtime_changes=(), _replacement_rows=(),
    accepted_video_resets=None, exact_required=False,
    exact_channel_scope=None, direct_overlay_revision_ids=(),
):
    calls["direct"] += 1
    assert candidate_rows == ()
    assert tuple(direct_overlay_revision_ids) == ("accepted",)
    assert tuple(accepted_video_resets) == ("accepted-video",)
    assert accepted_video_resets["accepted-video"]["channel_id"] == "UC-TOP"
    assert exact_required is True
    assert exact_channel_scope is None
    return {"UC-TOP": dict(base)}

module._overlay_vtuber_replacement_rows = exact
prepared = module._prepare_generic_overlay_rankings(
    Connection(), "active", ("parent", {"revision_id": "parent"}),
    {
        "range": "all", "view": "vtubers", "metric": "count",
        "q": "", "searchTokens": [], "searchScope": "all",
        "searchFields": [], "page": 1, "pageSize": 20, "minCount": 1,
        "nicheOnly": False, "hideUnknownArtist": False,
    },
)
assert calls == {"candidate": 0, "direct": 1}, calls
assert [row["detail_key"] for row in prepared["filtered"]] == ["UC-TOP"]
assert prepared["overlayRevisionIds"] == ("accepted",)
print("OK")
`);
  assert.equal(output, "OK");
});

test("direct page-1 accepted reset uses selected immutable identity for a legacy parent", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self):
        return object()

base = {
    "rank": 1, "detail_key": "UC-SELECTED", "title": "", "artist": "",
    "name": "Selected", "row_count": 1, "song_count": 1,
    "video_count": 1, "timestamp_count": 1,
    "payload_json": {
        "type": "vtuber", "key": "UC-SELECTED",
        "channelId": "UC-SELECTED", "channelName": "Selected",
        "channelHandle": "@selected", "count": 1, "songCount": 1,
        "videoCount": 1, "timestampCount": 1, "occurrences": [],
    },
}
selected_reset = {
    "revision_id": "accepted", "video_id": "legacy-video",
    "video_title": "Accepted", "channel_name": "Selected",
    "channel_id": "UC-SELECTED", "channel_handle": "@selected",
    "channel_url": "https://www.youtube.com/@selected",
    "published_at": None, "tombstone": False,
    "payload_json": {
        "videoId": "legacy-video", "channelId": "UC-SELECTED",
        "channelName": "Selected", "channelHandle": "@selected",
        "channelUrl": "https://www.youtube.com/@selected",
    },
}
legacy_parent = {
    "video_id": "legacy-video", "title": "Legacy",
    "video_title": "Legacy", "channel_name": "", "channel_id": "",
    "channel_handle": "", "channel_url": "",
    "payload_json": {"videoId": "legacy-video"},
    "video_payload_json": {"videoId": "legacy-video"},
}

module._overlay_revision_ids = lambda *_: ["accepted"]
module._resolve_exact_vtuber_channel_scope = lambda *_: None
module._accepted_video_resets = lambda *_: {"legacy-video": dict(selected_reset)}
module._runtime_tombstones = lambda *_: []
module._runtime_replacement_candidate_rows = lambda *_: []
module._channel_metadata_rows = lambda *_: []

parent_row = dict(legacy_parent)
def rows(_connection, sql, params):
    if "FROM runtime_ranking_rows" in sql:
        return [dict(base)]
    if "FROM runtime_videos" in sql:
        assert params[0] == "parent"
        assert params[1] == ["legacy-video"]
        assert params[2] <= 50001
        return [dict(parent_row)]
    raise AssertionError(sql)

module._rows = rows
captured = []
def exact(
    _connection, _active, _parent, candidate_rows, _options, _groups,
    reset_changes=(), runtime_changes=(), replacement_rows=(),
    accepted_video_resets=None, exact_required=False,
    exact_channel_scope=None, direct_overlay_revision_ids=(),
):
    assert candidate_rows == ()
    assert runtime_changes == () and replacement_rows == ()
    assert tuple(direct_overlay_revision_ids) == ("accepted",)
    assert exact_required is True and exact_channel_scope is None
    assert tuple(accepted_video_resets) == ("legacy-video",)
    assert len(reset_changes) == 1
    change = reset_changes[0]
    assert change["entityType"] == "videos"
    assert change["videoId"] == "legacy-video"
    assert change["acceptedVideoReset"] is True
    assert change["channel_id"] == "UC-SELECTED"
    assert change["channel_handle"] == "selected"
    assert change["videoPayload"]["videoId"] == "legacy-video"
    assert change["videoPayload"]["channelId"] == "UC-SELECTED"
    captured.append(dict(change))
    return {"UC-SELECTED": dict(base)}

module._overlay_vtuber_replacement_rows = exact
options = {
    "range": "all", "view": "vtubers", "metric": "count",
    "q": "", "searchTokens": [], "searchScope": "all",
    "searchFields": [], "page": 1, "pageSize": 20, "minCount": 1,
    "nicheOnly": False, "hideUnknownArtist": False,
}
prepared = module._prepare_generic_overlay_rankings(
    Connection(), "active", ("parent", {"revision_id": "parent"}), options,
)
assert [row["detail_key"] for row in prepared["filtered"]] == ["UC-SELECTED"]
assert len(captured) == 1

# The repair is narrowly same-video evidence.  Conflicting scalar/payload
# parent channels remain fail-closed before exact aggregation.
parent_row = {
    **legacy_parent,
    "channel_id": "UC-PARENT",
    "channel_handle": "@parent",
    "video_payload_json": {
        "videoId": "legacy-video", "channelId": "UC-CONFLICT",
        "channelHandle": "@conflict",
    },
    "payload_json": {
        "videoId": "legacy-video", "channelId": "UC-CONFLICT",
        "channelHandle": "@conflict",
    },
}
try:
    module._prepare_generic_overlay_rankings(
        Connection(), "active", ("parent", {"revision_id": "parent"}), options,
    )
    raise AssertionError("cross-channel parent evidence reached exact aggregation")
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber exact overlay change is missing required immutable identity"
assert len(captured) == 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("direct page-1 summaries and previews preserve totals, order, and same-source identities", () => {
  const output = runPython(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self):
        return object()

summary_sql = []
def summary_rows(_connection, sql, params):
    summary_sql.append(sql)
    assert "direct unfiltered VTuber overlay summary" in sql
    assert "overlay_lineage AS MATERIALIZED" in sql
    assert "selected_overlay_videos AS MATERIALIZED" in sql
    assert "accepted_overlay_occurrences AS MATERIALIZED" in sql
    selected = sql[
        sql.index("selected_overlay_videos AS MATERIALIZED"):
        sql.index("accepted_overlay_occurrences AS MATERIALIZED")
    ]
    assert "affected_channels" not in selected
    assert "JOIN affected_channels AS affected" in sql[
        sql.index("accepted_overlay_occurrences AS MATERIALIZED"):
    ]
    assert "jsonb_to_recordset" in sql
    assert params[6] == ["accepted-new", "accepted-old"]
    assert params[7] == ["runtime-removed-video"]
    assert json.loads(params[5]) == [{
        "channel_id": "UC-RUNTIME", "video_id": "runtime-video",
        "song_key": "runtime-song",
    }]
    return [
        {"channel_id": "UC-1", "row_count": 101,
         "video_count": 11, "song_count": 31},
        {"channel_id": "UC-2", "row_count": 99,
         "video_count": 9, "song_count": 29},
    ]

module._rows = summary_rows
summaries = module._unfiltered_vtuber_summary_rows(
    Connection(), "parent", {"UC-1", "UC-2"},
    {"accepted-video"}, {("runtime-video", "runtime-old-occ")},
    ["all", ""],
    [{"channel_id": "UC-RUNTIME", "video_id": "runtime-video",
      "song_key": "runtime-song"}],
    {"range": "all", "nicheOnly": False, "hideUnknownArtist": False},
    ("accepted-new", "accepted-old"), {"runtime-removed-video"},
)
assert [(row["channel_id"], row["row_count"]) for row in summaries] == [
    ("UC-1", 101), ("UC-2", 99),
]
assert len(summary_sql) == 1

channels = [f"UC-{index:02d}" for index in range(20)]
filtered = []
for index, channel_id in enumerate(channels):
    count = 200 - index
    filtered.append({
        "detail_key": channel_id, "title": "", "artist": "",
        "name": f"Channel {index}", "row_count": count,
        "song_count": 100 - index, "video_count": 40 - index,
        "timestamp_count": count,
        "payload_json": {
            "type": "vtuber", "key": channel_id, "channelId": channel_id,
            "channelName": f"Channel {index}", "channelHandle": f"@handle{index}",
            "channelUrl": f"https://www.youtube.com/@handle{index}",
            "sourceDetailKey": f"source-{index}", "count": count,
            "songCount": 100 - index, "videoCount": 40 - index,
            "timestampCount": count, "occurrences": [],
        },
    })

def preview_rows(_connection, sql, params):
    assert "bounded direct overlay VTuber previews" in sql
    assert "newest_videos AS MATERIALIZED" in sql
    assert sql.index("newest_videos AS MATERIALIZED") < sql.index("selected_videos AS MATERIALIZED")
    assert "WHERE preview_rank = 1" in sql
    assert params[0] == channels
    assert params[1] == ["accepted-new", "accepted-old"]
    assert params[-1] == 21
    rows = []
    for index, channel_id in enumerate(channels):
        video_id = f"video-{index}"
        occurrence_id = f"occ-{index}"
        rows.append({
            "channel_id": channel_id, "channel_name": f"Channel {index}",
            "channel_handle": f"@handle{index}",
            "channel_url": f"https://www.youtube.com/@handle{index}",
            "video_id": video_id, "video_title": f"Stream {index}",
            "published_at": None, "revision_id": "accepted-new",
            "occurrence_id": occurrence_id, "position": index,
            "range_id": "all", "song_key": f"song-{index}",
            "seconds": index, "title": f"Song {index}", "artist": "Artist",
            "source_id": f"source-id-{index}", "source_system": "youtube",
            "video_payload_json": {
                "videoId": video_id, "channelId": channel_id,
                "channelName": f"Channel {index}",
                "channelHandle": f"@handle{index}",
                "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
            },
            "occurrence_payload_json": {
                "videoId": video_id, "occurrenceId": occurrence_id,
                "position": index, "rangeId": "all",
                "songKey": f"song-{index}", "title": f"Song {index}",
                "artist": "Artist", "seconds": index,
            },
        })
    return rows

module._rows = preview_rows
rendered = module._render_generic_overlay_rankings(
    Connection(),
    {
        "filtered": tuple(filtered), "metadata": (), "candidateRows": (),
        "parentRevisionId": "parent",
        "overlayRevisionIds": ("accepted-new", "accepted-old"),
        "overlayPreviewExcludedVideoIds": ("runtime-removed-video",),
        "previewExcludedVideoIds": ("accepted-video",),
        "previewExcludedOccurrenceIds": (("runtime-video", "runtime-old-occ"),),
    },
    {"range": "all", "view": "vtubers", "metric": "count",
     "page": 1, "pageSize": 20},
)
assert len(rendered["records"]) == 20
assert rendered["totalCount"] == 20
assert rendered["totalOccurrenceCount"] == sum(200 - index for index in range(20))
assert rendered["totalVideoCount"] == sum(40 - index for index in range(20))
assert [record["rank"] for record in rendered["records"]] == list(range(1, 21))
for index, record in enumerate(rendered["records"]):
    assert record["sourceDetailKey"] == f"source-{index}"
    assert len(record["occurrences"]) == 1
    preview = record["occurrences"][0]
    assert preview["videoId"] == preview["item"]["videoId"] == preview["video"]["videoId"]
    assert record["channelId"] == preview["item"]["channelId"] == preview["video"]["channelId"]
    assert preview["occurrenceId"] == f"occ-{index}"
print("OK")
`);
  assert.equal(output, "OK");
});

test("ranking identity audit emits a bounded TimeoutError diagnostic", () => {
  const output = runPython(`
import contextlib
import importlib.util
import io
import sys
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.urlopen = lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("fixture timeout"))
stream = io.StringIO()
with contextlib.redirect_stdout(stream):
    try:
        module.fetch_json("http://candidate", "/api/rankings?range=all", 0.25)
    except TimeoutError:
        pass
    else:
        raise AssertionError("expected TimeoutError")
lines = stream.getvalue().splitlines()
assert lines[0].startswith("AUDIT_REQUEST_START phase=unspecified url=http://candidate/api/rankings?range=all timeoutSeconds=0.25")
assert "AUDIT_REQUEST_TIMEOUT phase=unspecified url=http://candidate/api/rankings?range=all timeoutSeconds=0.25" in lines[1]
assert "error=TimeoutError" in lines[1]
print("OK")
`);
  assert.equal(output, "OK");
});

test("concurrent ranking pages share one immutable expensive preparation", () => {
  const output = runPython(`
import concurrent.futures
import importlib.util
import sys
import threading
import time

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

calls = {"candidate": 0, "reset": 0, "exact": 0}
counter_lock = threading.Lock()
base = {
    "detail_key": "UC1", "title": "Channel", "artist": "",
    "name": "Channel", "row_count": 1, "song_count": 1,
    "video_count": 1, "timestamp_count": 1,
    "payload_json": {"type": "vtuber", "key": "UC1", "count": 1,
                     "songCount": 1, "videoCount": 1, "timestampCount": 1},
}
candidate = {
    "revision_id": "accepted", "video_id": "video-1", "occurrence_id": "occ-1",
    "position": 0, "range_id": "all", "song_key": "song-1",
    "title": "Song", "artist": "Artist", "channel_id": "UC1",
    "channel_name": "Channel", "video_tombstone": False,
    "video_payload_json": {"videoId": "video-1", "channelId": "UC1",
                           "channelName": "Channel"},
    "occurrence_payload_json": {"videoId": "video-1", "occurrenceId": "occ-1",
                                "songKey": "song-1", "title": "Song",
                                "artist": "Artist", "rangeId": "all"},
}

module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["accepted"]
module._rows = lambda *_: [dict(base)]
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: None
module._runtime_replacement_candidate_rows = lambda *_: []
module._channel_metadata_rows = lambda *_: []
module._hydrate_overlay_page_previews = lambda *_: None

def counted(name, value):
    def loader(*_args):
        with counter_lock:
            calls[name] += 1
        time.sleep(0.05)
        return value
    return loader

module._overlay_candidate_rows = counted("candidate", [candidate])
module._accepted_video_resets = counted("reset", {})
module._overlay_vtuber_replacement_rows = counted("exact", {"UC1": dict(base)})

def request(page):
    return module._generic_overlay_rankings_payload(
        object(), "active-revision", {"revision_id": "active-revision"},
        {"range": "all", "view": "vtubers", "metric": "count",
         "page": str(page), "pageSize": "20"},
    )

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(request, (2, 3, 4, 5)))

assert all(result["totalCount"] == 1 for result in results), results
assert calls == {"candidate": 1, "reset": 1, "exact": 1}, calls
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact cache does not share nested preview identity with callers", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._VTUBER_REPLACEMENT_CACHE.clear()
options = {
    "range": "all", "q": "", "searchScope": "all", "searchFields": (),
    "metric": "count", "minCount": 1, "nicheOnly": False,
    "hideUnknownArtist": False,
}
cache_key = (
    "active", "parent", "all", "", "all", (), "count", 1, False, False,
)
video = {
    "videoId": "video-1", "channelId": "UC1", "channelName": "Channel",
    "channelHandle": "/@channel", "channelUrl": "https://www.youtube.com/channel/UC1",
    "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
}
occurrence = {
    "videoId": "video-1", "occurrenceId": "occ-1", "position": 0,
    "item": dict(video), "video": dict(video),
}
cached_row = {
    "detail_key": "UC1", "title": "", "artist": "", "name": "Channel",
    "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1,
    "payload_json": {
        "type": "vtuber", "key": "UC1", "name": "Channel",
        "channelName": "Channel", "channelId": "UC1",
        "channelHandle": "/@channel",
        "channelUrl": "https://www.youtube.com/channel/UC1",
        "count": 1, "songCount": 1, "videoCount": 1, "timestampCount": 1,
        "occurrences": [occurrence],
    },
    "search_text": "", "channel_search_text": "",
}
module._VTUBER_REPLACEMENT_CACHE[cache_key] = {"UC1": cached_row}
candidate = {
    "revision_id": "active", "video_id": "video-1", "occurrence_id": "occ-1",
    "position": 0, "range_id": "all", "song_key": "song-1",
    "title": "Song", "artist": "Artist", "channel_id": "UC1",
    "channel_name": "Channel", "video_tombstone": False,
    "video_payload_json": dict(video),
    "occurrence_payload_json": {
        "videoId": "video-1", "occurrenceId": "occ-1", "position": 0,
        "rangeId": "all", "songKey": "song-1", "title": "Song",
        "artist": "Artist",
    },
}

def read_cache():
    return module._overlay_vtuber_replacement_rows(
        object(), "active", "parent", [candidate], options, {"UC1": cached_row},
        accepted_video_resets={}, exact_required=True,
    )

first = read_cache()
first["UC1"]["payload_json"]["occurrences"][0]["item"]["channelId"] = "UCX"
second = read_cache()
assert second["UC1"]["payload_json"]["occurrences"][0]["item"]["channelId"] == "UC1"
assert module._VTUBER_REPLACEMENT_CACHE[cache_key]["UC1"]["payload_json"]["occurrences"][0]["item"]["channelId"] == "UC1"
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact cache permits more rows than the entry-count LRU cap", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

cached = {}
for index in range(9):
    channel_id = f"UC{index}"
    cached[channel_id] = {
        "detail_key": channel_id,
        "title": "",
        "artist": "",
        "name": f"Channel {index}",
        "row_count": 0,
        "song_count": 0,
        "video_count": 0,
        "timestamp_count": 0,
        "payload_json": {
            "type": "vtuber",
            "key": channel_id,
            "channelId": channel_id,
            "name": f"Channel {index}",
            "count": 0,
            "songCount": 0,
            "videoCount": 0,
            "timestampCount": 0,
            "occurrences": [],
        },
    }

assert module._cached_vtuber_rows_are_safe(cached, set(cached), {})
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic single-flight waiters retain the completed result across LRU eviction", () => {
  const output = runPython(`
import concurrent.futures
import importlib.util
import sys
import threading

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
module._GENERIC_RANKING_PREPARATION_FLIGHTS.clear()
module._GENERIC_RANKING_PREPARATION_CAP = 1
waiter_entered = threading.Event()
allow_waiter = threading.Event()
build_started = threading.Event()
allow_build = threading.Event()

class ControlledEvent:
    def __init__(self, event):
        self.event = event
    def wait(self):
        waiter_entered.set()
        self.event.wait()
        if not allow_waiter.wait(2):
            raise RuntimeError("test did not release waiter")
    def set(self):
        self.event.set()

class ControlledFlight:
    def __init__(self, event):
        self.event = ControlledEvent(event)
        self.error = None
        self.result = None

module._RankingPreparationFlight = ControlledFlight
key_a = ("a",)
key_b = ("b",)

def build_a():
    build_started.set()
    if not allow_build.wait(2):
        raise RuntimeError("test did not release owner")
    return {"label": "a"}

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    owner = pool.submit(module._cached_generic_ranking_preparation, key_a, build_a)
    assert build_started.wait(2)
    waiter = pool.submit(
        module._cached_generic_ranking_preparation,
        key_a,
        lambda: {"label": "unexpected"},
    )
    assert waiter_entered.wait(2)
    allow_build.set()
    assert owner.result(timeout=2)["label"] == "a"
    assert module._cached_generic_ranking_preparation(
        key_b, lambda: {"label": "b"},
    )["label"] == "b"
    allow_waiter.set()
    assert waiter.result(timeout=2)["label"] == "a"

assert key_a not in module._GENERIC_RANKING_PREPARATION_CACHE
assert module._GENERIC_RANKING_PREPARATION_CACHE[key_b]["label"] == "b"
print("OK")
`);
  assert.equal(output, "OK");
});

test("ordinary pagination reads one bounded SQL bucket and keeps full aggregate totals", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
module._GENERIC_RANKING_PREPARATION_FLIGHTS.clear()
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: []
module._overlay_candidate_rows = lambda *_: []
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: None
module._runtime_replacement_candidate_rows = lambda *_: []
module._reconcile_affected_song_counts = lambda *_: None
module._hydrate_overlay_page_previews = lambda *_: None

base_queries = []
def rows(_connection, sql, params):
    if "SELECT COUNT(*) AS total_count" in sql:
        return [{
            "total_count": 197000,
            "total_occurrence_count": 600000,
            "total_song_count": 197000,
            "total_video_count": 250000,
        }]
    if "FROM runtime_ranking_rows" in sql and "ORDER BY rank" in sql:
        assert "LIMIT %s" in sql, sql
        base_queries.append(int(params[-1]))
        return [{
            "rank": index,
            "detail_key": f"song-{index}::artist",
            "title": f"Song {index}",
            "artist": "Artist",
            "name": f"Song {index}",
            "row_count": 1,
            "song_count": 1,
            "video_count": 1,
            "timestamp_count": 1,
            "payload_json": {
                "type": "song", "key": f"song-{index}::artist",
                "title": f"Song {index}", "displayArtist": "Artist",
                "count": 1, "songCount": 1, "videoCount": 1,
                "timestampCount": 1, "occurrences": [],
            },
            "search_text": "", "channel_search_text": "",
        } for index in range(1, 121)]
    return []
module._rows = rows

def request(page):
    return module._generic_overlay_rankings_payload(
        object(), "active", {"revision_id": "active"},
        {"range": "all", "view": "songs", "metric": "occurrences",
         "page": str(page), "pageSize": "20"},
    )

page2 = request(2)
page5 = request(5)
assert base_queries == [4196], base_queries
assert [row["rank"] for row in page2["records"]] == list(range(21, 41))
assert [row["rank"] for row in page5["records"]] == list(range(81, 101))
for payload in (page2, page5):
    assert payload["totalCount"] == 197000
    assert payload["totalOccurrenceCount"] == 600000
    assert payload["pageCount"] == 9850

request(6)
assert base_queries == [4196, 4296], base_queries
print("OK")
`);
  assert.equal(output, "OK");
});

test("oversized generic and VTuber values are returned but not retained in caches", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
module._GENERIC_RANKING_PREPARATION_FLIGHTS.clear()
module._GENERIC_RANKING_PREPARATION_MAX_BYTES = 512
key = ("oversized",)
prepared = module._cached_generic_ranking_preparation(
    key, lambda: {"filtered": (), "large": "x" * 4096},
)
assert prepared["large"].startswith("x")
assert key not in module._GENERIC_RANKING_PREPARATION_CACHE

module._VTUBER_REPLACEMENT_CACHE.clear()
module._VTUBER_REPLACEMENT_CACHE_MAX_OCCURRENCES = 0
cache_key = ("vtuber",)
exact = {"UC1": {"payload_json": {"occurrences": [{"occurrenceId": "one"}]}}}
module._store_vtuber_replacement_cache(cache_key, exact)
assert cache_key not in module._VTUBER_REPLACEMENT_CACHE

module._VTUBER_REPLACEMENT_CACHE_MAX_OCCURRENCES = 4
module._store_vtuber_replacement_cache(cache_key, exact)
assert module._VTUBER_REPLACEMENT_CACHE[cache_key] is exact
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic ranking preparation isolates keys, failures, eviction, and returned pages", () => {
  const output = runPython(`
import concurrent.futures
import importlib.util
import sys
import threading
import time

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
module._GENERIC_RANKING_PREPARATION_FLIGHTS.clear()

calls = []
def build(label, fail=False):
    def run():
        calls.append(label)
        time.sleep(0.04)
        if fail:
            raise RuntimeError("expected build failure")
        return {"label": label}
    return run

key = ("active", "parent", "all", "vtubers", "count", "", "all", (), 1, False, False)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    values = list(pool.map(lambda _: module._cached_generic_ranking_preparation(key, build("same")), range(4)))
assert calls == ["same"] and all(value["label"] == "same" for value in values), calls

for variant in (
    ("active", "parent", "7d", "vtubers", "count", "", "all", (), 1, False, False),
    ("active", "parent", "all", "vtubers", "songs", "", "all", (), 1, False, False),
    ("other-active", "parent", "all", "vtubers", "count", "", "all", (), 1, False, False),
    ("active", "parent", "all", "vtubers", "count", "needle", "all", (), 1, False, False),
):
    module._cached_generic_ranking_preparation(variant, build(str(variant)))
assert len(calls) == 5, calls

failure_key = ("failure", "parent", "all", "vtubers", "count", "", "all", (), 1, False, False)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    futures = [pool.submit(module._cached_generic_ranking_preparation, failure_key, build("failure", True)) for _ in range(3)]
    errors = []
    for future in futures:
        try:
            future.result()
        except RuntimeError as error:
            errors.append(str(error))
assert errors == ["expected build failure"] * 3, errors
assert calls.count("failure") == 1, calls
assert module._cached_generic_ranking_preparation(failure_key, build("retry"))["label"] == "retry"
assert calls.count("retry") == 1, calls

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
for index in range(module._GENERIC_RANKING_PREPARATION_CAP + 1):
    eviction_key = ("evict-" + str(index), "parent", "all", "vtubers", "count", "", "all", (), 1, False, False)
    module._cached_generic_ranking_preparation(eviction_key, build("evict-" + str(index)))
assert len(module._GENERIC_RANKING_PREPARATION_CACHE) == module._GENERIC_RANKING_PREPARATION_CAP
assert ("evict-0", "parent", "all", "vtubers", "count", "", "all", (), 1, False, False) not in module._GENERIC_RANKING_PREPARATION_CACHE

module._GENERIC_RANKING_PREPARATION_CACHE.clear()
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: []
module._rows = lambda *_: [{
    "detail_key": "song::artist", "title": "Song", "artist": "Artist", "name": "Song",
    "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1,
    "payload_json": {"type": "song", "title": "Original", "occurrences": []},
}]
module._overlay_candidate_rows = lambda *_: []
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: None
module._runtime_replacement_candidate_rows = lambda *_: []
module._reconcile_affected_song_counts = lambda *_: None
module._hydrate_overlay_page_previews = lambda *_: None

first = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
    {"range": "all", "view": "songs", "metric": "count", "page": "1", "pageSize": "20"})
first["records"][0]["title"] = "caller mutation"
second = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
    {"range": "all", "view": "songs", "metric": "count", "page": "2", "pageSize": "20"})
assert first is not second and second["records"] == [], (first, second)
third = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
    {"range": "all", "view": "songs", "metric": "count", "page": "1", "pageSize": "20"})
assert third["records"][0]["title"] == "Original", third
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber caller installs exact coverage once and rejects incomplete overlay identities", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

real_accepted_video_resets = module._accepted_video_resets

module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["accepted"]
module._enrich_runtime_original_group_counts = lambda *_: None
module._channel_metadata_rows = lambda *_: []

def candidate(video_id, occurrence_id, channel_id, key):
    handle = "@" + channel_id.lower()
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {
        "revision_id": "accepted", "video_id": video_id, "occurrence_id": occurrence_id,
        "position": 0, "range_id": "all", "song_key": key, "title": key, "artist": "Artist",
        "seconds": 37, "channel_id": channel_id, "channel_name": channel_id,
        "channel_handle": handle, "video_tombstone": False,
        "video_payload_json": {"videoId": video_id, "channelId": channel_id,
          "channelName": channel_id, "channelHandle": handle, "thumbnailUrl": thumbnail},
        "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id,
          "position": 0, "songKey": key, "title": key, "artist": "Artist",
          "seconds": 37, "rangeId": "all"},
    }

def video(video_id, channel_id):
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {"video_id": video_id, "title": video_id, "channel_id": channel_id,
      "channel_name": channel_id, "channel_handle": "@" + channel_id.lower(),
      "channel_url": "https://www.youtube.com/channel/" + channel_id,
      "thumbnail_url": thumbnail,
      "published_timestamp": "2026-07-29T00:00:00Z",
      "payload_json": {"videoId": video_id, "channelId": channel_id,
        "channelName": channel_id, "channelHandle": "@" + channel_id.lower(),
        "thumbnailUrl": thumbnail}}

def occurrence(video_id, occurrence_id):
    return {"video_id": video_id, "occurrence_id": occurrence_id, "range_id": "all",
      "song_key": occurrence_id, "seconds": 37, "title": occurrence_id,
      "artist": "Artist", "source_id": "fixture", "source_system": "test",
      "payload_json": {"videoId": video_id, "occurrenceId": occurrence_id,
        "position": 0, "rangeId": "all", "songKey": occurrence_id,
        "seconds": 37, "title": occurrence_id, "artist": "Artist"}}

def base(channel_id, count):
    payload = {"type": "vtuber", "key": channel_id, "channelId": channel_id,
      "channelName": channel_id, "name": channel_id, "count": count, "songCount": count,
      "videoCount": count, "timestampCount": count, "occurrences": []}
    return {"rank": 1, "detail_key": channel_id, "title": "", "artist": "", "name": channel_id,
      "row_count": count, "song_count": count, "video_count": count, "timestamp_count": count,
      "search_text": channel_id, "channel_search_text": channel_id, "payload_json": payload}

def execute(base_rows, parent_videos, parent_occurrences, candidates=(), resets=None, reset_changes=(), runtime_changes=(), prewarm=None):
    # Fixtures deliberately replace the contents of the same synthetic
    # revision between calls; production revisions are immutable.
    module._GENERIC_RANKING_PREPARATION_CACHE.clear()
    module._overlay_candidate_rows = lambda *_: list(candidates)
    module._accepted_video_resets = lambda *_: dict(resets or {})
    module._accepted_video_reset_changes = lambda *_: [dict(change) for change in reset_changes]
    module._runtime_tombstones = lambda *_: [dict(change) for change in runtime_changes]
    # The caller must not replay exact VTuber tuples through either generic
    # reconciler.  This turns a future double-preview/decrement regression
    # into a direct integration-test failure.
    module._apply_runtime_tombstone_groups = lambda *_: (_ for _ in ()).throw(AssertionError("generic VTuber tombstone replay"))
    module._apply_runtime_change_previews = lambda *_: (_ for _ in ()).throw(AssertionError("generic VTuber preview replay"))
    def rows(_connection, sql, _params):
        if "FROM runtime_ranking_rows" in sql:
            return [dict(row) for row in base_rows]
        if "bounded final VTuber previews" in sql:
            requested = set(_params[0])
            excluded_videos = set(_params[1])
            excluded_occurrences = set(zip(_params[2], _params[3]))
            range_values = set(_params[4])
            videos_by_id = {row["video_id"]: row for row in parent_videos}
            selected = {}
            for parent_occurrence in sorted(
                parent_occurrences,
                key=lambda row: (row["video_id"], row["occurrence_id"]),
            ):
                parent_video = videos_by_id.get(parent_occurrence["video_id"])
                if not parent_video or parent_video["channel_id"] not in requested:
                    continue
                if parent_occurrence["video_id"] in excluded_videos:
                    continue
                if (
                    parent_occurrence["video_id"],
                    parent_occurrence["occurrence_id"],
                ) in excluded_occurrences:
                    continue
                if parent_occurrence["range_id"] not in range_values:
                    continue
                channel_id = parent_video["channel_id"]
                if channel_id in selected:
                    continue
                selected[channel_id] = {
                    **dict(parent_occurrence),
                    "revision_id": "parent",
                    "channel_id": channel_id,
                    "channel_name": parent_video["channel_name"],
                    "channel_handle": parent_video["channel_handle"],
                    "channel_url": parent_video["channel_url"],
                    "video_title": parent_video["title"],
                    "thumbnail_url": parent_video["thumbnail_url"],
                    "video_payload_json": parent_video["payload_json"],
                    "occurrence_payload_json": parent_occurrence["payload_json"],
                }
            return [selected[channel_id] for channel_id in sorted(selected)]
        if "FROM runtime_videos" in sql:
            return [dict(row) for row in parent_videos]
        if "FROM runtime_occurrences" in sql:
            return [dict(row) for row in parent_occurrences]
        return []
    module._rows = rows
    module._VTUBER_REPLACEMENT_CACHE.clear()
    if prewarm is not None:
        module._VTUBER_REPLACEMENT_CACHE[("active", "parent", "all", "", "", (), "", 0, False, False)] = prewarm
    return module._generic_overlay_rankings_payload(
        object(), "active", {"revision_id": "active"},
        {"range": "all", "view": "vtubers", "metric": "count", "pageSize": "20"},
    )

# Real caller -> real exact fallback: a channel move leaves old-channel B=1
# while the new channel has its inherited C plus the accepted tuple (C=2).
moved = execute(
    [base("UCOLD", 2), base("UCNEW", 1)],
    [video("old-target", "UCOLD"), video("old-b", "UCOLD"), video("new-existing", "UCNEW")],
    [occurrence("old-target", "target"), occurrence("old-b", "B"), occurrence("new-existing", "C")],
    [candidate("new-target", "new", "UCNEW", "new")],
    {"old-target": {"video_id": "old-target", "tombstone": False}},
    [{"entityType": "videos", "videoId": "old-target", "channel_id": "UCOLD"}],
)
assert {row["channelId"]: row["count"] for row in moved["records"]} == {"UCNEW": 2, "UCOLD": 1}
moved_by_channel = {row["channelId"]: row for row in moved["records"]}
assert "new-target" in {
    occurrence["item"]["videoId"]
    for occurrence in moved_by_channel["UCNEW"]["occurrences"]
}, moved
assert moved_by_channel["UCOLD"]["occurrences"][0]["item"]["videoId"] == "old-b", moved
assert "old-target" not in {
    occurrence["item"]["videoId"]
    for row in moved["records"]
    for occurrence in row["occurrences"]
}, moved

# A pure occurrence tombstone removes its target once, retaining B=1 rather
# than applying an additional generic decrement after exact installation.
tombstoned = execute(
    [base("UCOLD", 2)], [video("old-target", "UCOLD"), video("old-b", "UCOLD")],
    [occurrence("old-target", "target"), occurrence("old-b", "B")], runtime_changes=[
      {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "channel_id": "UCOLD"}
    ],
)
assert [(row["channelId"], row["count"]) for row in tombstoned["records"]] == [("UCOLD", 1)]
assert tombstoned["records"][0]["occurrences"][0]["item"]["videoId"] == "old-b", tombstoned
assert all(
    occurrence["occurrenceId"] != "target"
    for occurrence in tombstoned["records"][0]["occurrences"]
)

# Historical runtime curation can retain only the occurrence identity.  Its
# missing channel may be recovered solely from the bounded parent-video tuple
# for that same immutable video; this must reach exact coverage rather than a
# generic fallback or a 503.
legacy_parent = video("old-target", "UCOLD")
for field in ("channel_id", "channel_name", "channel_handle", "channel_url"):
    legacy_parent[field] = ""
legacy_runtime = execute(
    [base("UCOLD", 2)], [legacy_parent, video("old-b", "UCOLD")],
    [occurrence("old-target", "target"), occurrence("old-b", "B")], runtime_changes=[
      {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}
    ],
)
assert [(row["channelId"], row["count"]) for row in legacy_runtime["records"]] == [("UCOLD", 1)]

# Accepted full-video resets use the same parent tuple evidence.  Conversely,
# a payload that claims another video cannot prove this change's identity.
legacy_reset = execute(
    [base("UCOLD", 1)], [legacy_parent], [occurrence("old-target", "target")],
    resets={"old-target": {"video_id": "old-target", "tombstone": True}},
    reset_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target",
                    "acceptedVideoReset": True}],
)
assert legacy_reset["records"] == []
wrong_parent = video("old-target", "UCOLD")
wrong_parent["channel_id"] = ""
wrong_parent["payload_json"] = {"videoId": "other-video", "channelId": "UCOTHER"}
try:
    execute(
        [base("UCOLD", 1)], [wrong_parent], [occurrence("old-target", "target")], runtime_changes=[
          {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}
        ],
    )
    raise AssertionError("mismatched parent video proved a legacy identity")
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber exact overlay change is missing required immutable identity"

# Every pre-existing source is evidence, never a scalar-precedence fallback.
# These were the v9 P1 holes: a conflicting payload could silently return the
# scalar's UCOLD card (SCALAR_PAYLOAD_CONFLICT_NOT_REJECTED returned=UCOLD:1).
def expect_identity_rejection(label, parent_videos, runtime_changes=(), reset_changes=(), resets=None):
    try:
        execute(
            [base("UCOLD", 1)], parent_videos,
            [occurrence("old-target", "target")],
            resets=resets, reset_changes=reset_changes, runtime_changes=runtime_changes,
        )
        raise AssertionError(label + " was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact overlay change is missing required immutable identity"

expect_identity_rejection(
    "scalar/payload video conflict", [video("old-target", "UCOLD")],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target",
                      "channel_id": "UCOLD", "videoPayload": {"videoId": "other-video", "channelId": "UCOLD"}}],
)
expect_identity_rejection(
    "scalar/payload channel conflict", [video("old-target", "UCOLD")],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target",
                      "channel_id": "UCOLD", "videoPayload": {"videoId": "old-target", "channelId": "UCOTHER"}}],
)
parent_payload_conflict = video("old-target", "UCOLD")
parent_payload_conflict["payload_json"] = {"videoId": "old-target", "channelId": "UCOTHER"}
expect_identity_rejection(
    "parent scalar/payload conflict", [parent_payload_conflict],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}],
)
expect_identity_rejection(
    "duplicate parent tuples", [video("old-target", "UCOLD"), video("old-target", "UCOLD")],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}],
)
expect_identity_rejection(
    "missing parent tuple", [],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}],
)

# The legal resetChanges8032 shape has ten immutable occurrences but no
# denormalised channel identity.  One bounded parent tuple restores all ten.
reset_ten = [
    {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "reset-%d" % index,
     "acceptedVideoReset": True}
    for index in range(10)
]
reset_ten_result = execute(
    [base("UCOLD", 10)], [video("old-target", "UCOLD")],
    [occurrence("old-target", "reset-%d" % index) for index in range(10)],
    resets={"old-target": {"video_id": "old-target", "tombstone": True}},
    reset_changes=reset_ten,
)
assert reset_ten_result["records"] == []

# Some legacy parent video projections retain the immutable video id but no
# channel tuple at all.  A selected accepted reset for that *same* video is
# still immutable evidence; use it only after exact video-id validation.
parent_without_channel = video("old-target", "UCOLD")
for field in ("channel_id", "channel_name", "channel_handle", "channel_url"):
    parent_without_channel[field] = ""
parent_without_channel["payload_json"] = {"videoId": "old-target"}
accepted_same_video = video("old-target", "UCOLD")
accepted_reset_identity = execute(
    [base("UCOLD", 1)], [parent_without_channel], [occurrence("old-target", "target")],
    resets={"old-target": {**accepted_same_video, "tombstone": True}},
    reset_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target",
                    "acceptedVideoReset": True}],
)
assert accepted_reset_identity["records"] == []

def expect_accepted_reset_rejection(label, change, candidates):
    try:
        module._accepted_reset_identity_evidence(change, candidates)
        raise AssertionError(label + " was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact overlay change is missing required immutable identity"

expect_accepted_reset_rejection(
    "duplicate accepted reset identity", {"videoId": "old-target"},
    [accepted_same_video, accepted_same_video],
)
accepted_channel_conflict = dict(accepted_same_video)
accepted_channel_conflict["payload_json"] = {"videoId": "old-target", "channelId": "UCOTHER"}
expect_accepted_reset_rejection(
    "accepted scalar/payload channel conflict", {"videoId": "old-target"},
    [accepted_channel_conflict],
)
accepted_handle_conflict = dict(accepted_same_video)
accepted_handle_conflict["payload_json"] = {
    "videoId": "old-target", "channelId": "UCOLD", "channelHandle": "@other"
}
expect_accepted_reset_rejection(
    "accepted scalar/payload handle conflict", {"videoId": "old-target"},
    [accepted_handle_conflict],
)
accepted_url_pollution = dict(accepted_same_video)
accepted_url_pollution["channel_url"] = "https://www.youtube.com/channel/UCOTHER"
accepted_url_pollution["payload_json"] = {
    "videoId": "old-target", "channelId": "UCOLD",
    "channelHandle": "@ucold", "channelUrl": "https://www.youtube.com/channel/UCOTHER",
}
canonical_evidence = module._accepted_reset_identity_evidence(
    {"videoId": "old-target"}, [accepted_url_pollution],
)
assert canonical_evidence["channel_url"] == "https://www.youtube.com/@ucold"
assert "UCOTHER" not in repr(canonical_evidence)

# URL-only legacy pollution is discarded instead of selecting a channel.  The
# public card and both occurrence aliases must expose the same canonical tuple.
polluted_candidate = candidate("old-target", "target", "UCOLD", "target")
polluted_candidate["video_payload_json"].update({
    "channelHandle": "@ucold", "channelUrl": "https://www.youtube.com/channel/UCOTHER",
})
canonical_public = execute(
    [base("UCOLD", 1)], [parent_without_channel], [occurrence("old-target", "target")],
    candidates=[polluted_candidate],
    resets={"old-target": {**accepted_url_pollution, "tombstone": False}},
    reset_changes=[{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target",
                    "acceptedVideoReset": True}],
)
card = canonical_public["records"][0]
assert card["channelId"] == "UCOLD" and card["channelHandle"] == "ucold"
assert card["channelUrl"] == "https://www.youtube.com/@ucold"
assert "_canonicalChannelUrl" not in repr(card)
for public_occurrence in card["occurrences"]:
    for nested in (public_occurrence["item"], public_occurrence["video"]):
        assert nested["videoId"] == "old-target"
        assert nested["channelId"] == "UCOLD" and nested["channelHandle"] == "ucold"
        assert nested["channelUrl"] == "https://www.youtube.com/@ucold"
        assert "UCOTHER" not in repr(nested)
expect_accepted_reset_rejection(
    "accepted conflicts with existing identity", {"videoId": "old-target", "channel_id": "UCOTHER"},
    [accepted_same_video],
)

consistent = execute(
    [base("UCOLD", 1)], [video("old-target", "UCOLD")], [occurrence("old-target", "target")],
    runtime_changes=[{"entityType": "occurrences", "videoId": "old-target", "video_id": "old-target",
                      "occurrenceId": "target", "channel_id": "UCOLD", "channelId": "UCOLD",
                      "videoPayload": {"videoId": "old-target", "channelId": "UCOLD"}}],
)
assert consistent["records"] == []

# All tuples deleted yields a zero coverage marker internally, then one public
# removal: no card and no total contribution.
zero = execute(
    [base("UCZERO", 1)], [video("dead", "UCZERO")], [occurrence("dead", "dead")], runtime_changes=[
      {"entityType": "occurrences", "videoId": "dead", "occurrenceId": "dead", "channel_id": "UCZERO"}
    ],
)
assert zero["records"] == [] and zero["totalCount"] == 0 and zero["totalOccurrenceCount"] == 0

# Runtime replacement likewise remains exact-owned; the guarded generic
# caller hooks above prove no second preview mutation is attempted.
replaced = execute(
    [base("UCOLD", 2)], [video("old-target", "UCOLD"), video("old-b", "UCOLD")],
    [occurrence("old-target", "target"), occurrence("old-b", "B")], runtime_changes=[
      {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "rangeId": "all", "channel_id": "UCOLD", "replacement": True,
       "replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "title": "New", "artist": "Artist",
         "rangeId": "all", "position": 0, "channelId": "UCOLD", "channelName": "UCOLD"}}
    ],
)
assert replaced["records"][0]["count"] == 2
replaced_video_ids = {
    occurrence["item"]["videoId"]
    for occurrence in replaced["records"][0]["occurrences"]
}
assert replaced_video_ids == {"new-target", "old-b"}, replaced_video_ids
assert "old-target" not in replaced_video_ids

# Replacement identities are new-side-only.  An old immutable channel/video
# may locate the removed tuple, but must never be borrowed for the replacement.
for malformed in (
    {"replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "title": "New", "artist": "Artist"}},
    {"replacementPayload": {"occurrenceId": "new", "title": "New", "artist": "Artist", "channelId": "UCNEW"}},
    {"replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "artist": "Artist", "channelId": "UCNEW"}},
):
    try:
        execute(
            [base("UCOLD", 1)], [video("old-target", "UCOLD")], [occurrence("old-target", "target")], runtime_changes=[
              {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "rangeId": "all", "channel_id": "UCOLD", "replacement": True, **malformed}
            ],
        )
        raise AssertionError("malformed replacement reached VTuber exact coverage")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact replacement is missing required immutable identity"

# A direct runtime/accepted reset change without an immutable channel cannot
# fall through to generic reconciliation or an exact-empty partial result.
for reset_changes, runtime_changes in (
    ([], [{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target"}]),
    ([{"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "acceptedVideoReset": True}], []),
):
    try:
        execute(
            [base("UCOLD", 1)], [], [occurrence("old-target", "target")],
            reset_changes=reset_changes, runtime_changes=runtime_changes,
        )
        raise AssertionError("missing immutable channel reached exact-empty reconciliation")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact overlay change is missing required immutable identity"

# A channel move must project public identity only from the new side.  The old
# tuple's handle/URL can locate its removal but never appear on the new card.
moved_public = execute(
    [base("UCOLD", 1)], [video("old-target", "UCOLD")], [occurrence("old-target", "target")], runtime_changes=[
      {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "rangeId": "all",
       "channel_id": "UCOLD", "channel_handle": "@old_handle", "channel_url": "https://youtube.com/@old_handle",
       "videoPayload": {"videoId": "old-target", "channelId": "UCOLD", "title": "Old video", "thumbnailUrl": "https://i.ytimg.com/vi/old-target/hqdefault.jpg"},
       "replacement": True,
       "replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "title": "New", "artist": "Artist", "rangeId": "all", "channelId": "UCNEW", "channelHandle": "/@new_handle"},
       "replacementVideoPayload": {"videoId": "new-target", "channelId": "UCNEW", "channelHandle": "/@new_handle", "channelUrl": "https://youtube.com/@new_handle", "thumbnailUrl": "https://i.ytimg.com/vi/new-target/hqdefault.jpg"}}
    ],
)
assert [(row["channelId"], row.get("channelHandle", ""), row["channelUrl"])
  for row in moved_public["records"]] == [("UCNEW", "/@new_handle", "https://www.youtube.com/@new_handle")]
moved_item = moved_public["records"][0]["occurrences"][0]["item"]
assert moved_item["videoId"] == "new-target" and moved_item["channelId"] == "UCNEW"
assert moved_item["thumbnailUrl"].endswith("/new-target/hqdefault.jpg")
assert "old_handle" not in str(moved_public) and "old-target" not in str(moved_public)

# Bad new-side IDs and an old-video thumbnail are rejected before a preheated
# exact cache could be read.
for payload in (
    {"videoId": "old-target", "channelId": "UCNEW"},
    {"videoId": "new-target", "channelId": "UCNEW", "thumbnailUrl": "https://i.ytimg.com/vi/old-target/hqdefault.jpg"},
):
    try:
        execute(
            [base("UCOLD", 1)], [video("old-target", "UCOLD")], [occurrence("old-target", "target")], runtime_changes=[
              {"entityType": "occurrences", "videoId": "old-target", "occurrenceId": "target", "rangeId": "all", "channel_id": "UCOLD", "replacement": True,
               "replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "title": "New", "artist": "Artist", "rangeId": "all", "channelId": "UCNEW"},
               "replacementVideoPayload": payload}
            ], prewarm={"UCOLD": {"detail_key": "UCOLD", "payload_json": {"channelId": "UCOLD"}}},
        )
        raise AssertionError("invalid replacement public identity reached exact cache")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact replacement public identity is invalid"

# Same-channel new videos may retain channel metadata, never old video fields.
same_channel = module._runtime_replacement_candidate_rows([{
  "videoId": "old-target", "occurrenceId": "target", "channel_id": "UCOLD", "channel_handle": "@old", "channel_url": "https://youtube.com/@old",
  "videoPayload": {"videoId": "old-target", "channelId": "UCOLD", "title": "Old video", "thumbnailUrl": "https://i.ytimg.com/vi/old-target/hqdefault.jpg"},
  "replacement": True,
  "replacementPayload": {"videoId": "new-target", "occurrenceId": "new", "title": "New video", "artist": "Artist", "channelId": "UCOLD"},
  "replacementVideoPayload": {"videoId": "new-target", "channelId": "UCOLD"},
}], True)[0]
assert same_channel["channel_handle"] == "@old" and same_channel["channel_url"] == "https://youtube.com/@old"
assert same_channel["video_payload_json"]["title"] == "New video"
assert same_channel["video_payload_json"]["thumbnailUrl"].endswith("/new-target/hqdefault.jpg")
assert "old-target" not in str(same_channel["video_payload_json"])

same_video = module._runtime_replacement_candidate_rows([{
  "videoId": "same", "occurrenceId": "old", "channel_id": "UCOLD",
  "videoPayload": {"videoId": "same", "channelId": "UCOLD", "title": "Verified", "thumbnailUrl": "https://i.ytimg.com/vi/same/hqdefault.jpg"},
  "replacement": True,
  "replacementPayload": {"videoId": "same", "occurrenceId": "new", "title": "Canonical", "artist": "Artist", "channelId": "UCOLD"},
  "replacementVideoPayload": {"videoId": "same", "channelId": "UCOLD"},
}], True)[0]
assert same_video["video_payload_json"]["thumbnailUrl"].endswith("/same/hqdefault.jpg")

try:
    module._runtime_replacement_candidate_rows([{
      "videoId": "same", "occurrenceId": "old", "channel_id": "UCOLD", "replacement": True,
      "replacementPayload": {"videoId": "same", "occurrenceId": "new", "title": "New", "artist": "Artist", "channelId": "UCNEW"},
      "replacementVideoPayload": {"videoId": "same", "channelId": "UCNEW"},
    }], True)
    raise AssertionError("same-video channel move was accepted")
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber exact replacement public identity is invalid"

# Required accepted reset boundaries are not silently filtered by the caller.
module._accepted_video_resets = real_accepted_video_resets
module._overlay_candidate_rows = lambda *_: []
module._overlay_revision_ids = lambda *_: ["accepted"]
def malformed_reset_rows(_connection, sql, _params):
    if "runtime_ranking_rows" in sql:
        return [base("UCBASE", 1)]
    if "migration_video_rows" in sql:
        return [{"revision_id": "accepted", "video_id": "", "tombstone": True}]
    return []
module._rows = malformed_reset_rows
try:
    module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
      {"range": "all", "view": "vtubers", "metric": "count", "pageSize": "20"})
    raise AssertionError("malformed accepted reset was silently filtered")
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber accepted video reset is missing required immutable identity"

# No overlay tuple leaves the baseline untouched and does not claim exact ownership.
baseline = execute(
    [base("UCBASE", 1)], [video("base-target", "UCBASE")], [occurrence("base-target", "base")],
)
assert [(row["channelId"], row["count"]) for row in baseline["records"]] == [("UCBASE", 1)]
baseline_card = baseline["records"][0]
assert len(baseline_card["occurrences"]) == 1, baseline_card
baseline_occurrence = baseline_card["occurrences"][0]
for nested in (baseline_occurrence["item"], baseline_occurrence["video"]):
    assert nested["videoId"] == "base-target"
    assert nested["channelId"] == "UCBASE"
    assert nested["channelHandle"].lstrip("/@").casefold() == "ucbase"
    assert module.thumbnail_matches_video(nested["thumbnailUrl"], "base-target")
assert baseline_card["thumbnailUrl"] == baseline_occurrence["item"]["thumbnailUrl"]
assert baseline_card["videoThumbnailUrl"] == baseline_occurrence["item"]["thumbnailUrl"]
assert baseline_occurrence["title"] == baseline_occurrence["song"]["title"] == "base"
assert baseline_occurrence["artist"] == baseline_occurrence["song"]["artist"] == "Artist"
assert baseline_occurrence["seconds"] == baseline_occurrence["song"]["seconds"] == 37

try:
    execute([base("UCBROKEN", 1)], [], [])
    raise AssertionError("positive card without a real tuple did not fail closed")
except module.PostgresAdapterError as error:
    assert str(error) == "positive VTuber ranking card has no canonical occurrence preview"

for bad in (
    candidate("video-present", "occ", "", "bad"),
    {**candidate("", "occ", "UC1", "bad"), "video_payload_json": {"channelId": "UC1"}},
):
    module._VTUBER_REPLACEMENT_CACHE.clear()
    try:
        module._overlay_vtuber_replacement_rows(object(), "bad", "parent", [bad], {"range": "all"}, {})
        raise AssertionError("incomplete exact identity was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact overlay candidate is missing required immutable identity"

# Validation happens before the exact-cache read, so a malformed new tuple
# cannot reuse an older partial entry and the error path does not replace it.
cache_key = ("cached", "parent", "all", "", "", (), "", 0, False, False)
cached = {"UCOLD": {"detail_key": "UCOLD", "payload_json": {"channelId": "UCOLD"}}}
module._VTUBER_REPLACEMENT_CACHE.clear()
module._VTUBER_REPLACEMENT_CACHE[cache_key] = cached
try:
    module._overlay_vtuber_replacement_rows(
        object(), "cached", "parent", [candidate("video", "occ", "", "bad")],
        {"range": "all"}, {}, exact_required=True,
    )
    raise AssertionError("partial exact cache was reused for malformed identity")
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber exact overlay change is missing required immutable identity"
assert module._VTUBER_REPLACEMENT_CACHE[cache_key] is cached

# The strict runtime boundary needs both old immutable IDs.  It also binds an
# explicit new thumbnail instead of merely looking for the older /vi/ spelling.
def strict_change(thumbnail="", handle="@new", channel_url="https://youtube.com/@new"):
    video = {"videoId": "new-video", "channelId": "UCNEW", "channelHandle": handle, "channelUrl": channel_url}
    if thumbnail:
        video["thumbnailUrl"] = thumbnail
    return {"videoId": "old-video", "occurrenceId": "old-occ", "channel_id": "UCOLD",
      "channel_handle": "@old", "channel_url": "https://youtube.com/@old",
      "videoPayload": {"videoId": "old-video", "channelId": "UCOLD", "channelHandle": "@old", "channelUrl": "https://youtube.com/@old", "thumbnailUrl": "https://i.ytimg.com/vi/old-video/hqdefault.jpg"},
      "replacement": True,
      "replacementPayload": {"videoId": "new-video", "occurrenceId": "new-occ", "title": "New", "artist": "Artist", "channelId": "UCNEW"},
      "replacementVideoPayload": video}

for bad_thumbnail in (
    "https://i.ytimg.com/vi_webp/old-video/hqdefault.webp",
    "https://i.ytimg.com/an_webp/old-video/mqdefault_6s.webp",
    "https://third.example/old-video.jpg",
    "https://third.example/unknown.jpg",
):
    try:
        module._runtime_replacement_candidate_rows([strict_change(bad_thumbnail)], True)
        raise AssertionError("unbound or old thumbnail was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact replacement public identity is invalid"
for good_thumbnail in (
    "https://i.ytimg.com/vi/new-video/hqdefault.jpg",
    "https://i.ytimg.com/vi_webp/new-video/hqdefault.webp",
    "https://i.ytimg.com/an_webp/new-video/mqdefault_6s.webp",
    "https://i.ytimg.com/thumbnail.jpg?videoId=new-video",
):
    assert module._runtime_replacement_candidate_rows([strict_change(good_thumbnail)], True)[0]["video_payload_json"]["thumbnailUrl"] == good_thumbnail
for malformed in (
    {key: value for key, value in strict_change().items() if key != "channel_id"},
    strict_change("https://i.ytimg.com/vi/new-video/hqdefault.jpg", "@old", "https://youtube.com/@new"),
    strict_change("https://i.ytimg.com/vi/new-video/hqdefault.jpg", "@new", "https://youtube.com/@old"),
):
    try:
        module._runtime_replacement_candidate_rows([malformed], True)
        raise AssertionError("old immutable/channel public identity was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact replacement public identity is invalid"
valid_move = module._runtime_replacement_candidate_rows([
    strict_change("https://i.ytimg.com/vi/new-video/hqdefault.jpg")
], True)[0]
assert valid_move["channel_handle"] == "@new" and valid_move["channel_url"] == "https://youtube.com/@new"

# Cache hits happen only after candidates are public/identity-complete.  A
# legal cache avoids SQL; poisoned key/card/occurrence/thumbnail variants
# raise and leave the cached object untouched.
class CacheConnection:
    def cursor(self): return object()
cache_candidate = candidate("cache-video", "cache-occ", "UCNEW", "cache")
cache_candidate["video_payload_json"].update({"channelHandle": "@new", "channelUrl": "https://youtube.com/@new", "thumbnailUrl": "https://i.ytimg.com/vi/cache-video/hqdefault.jpg"})
cache_candidate["occurrence_payload_json"].update({"videoId": "cache-video"})
cache_calls = []
def cache_rows(_connection, sql, _params):
    cache_calls.append(sql)
    return [{"channel_id": "UCNEW", "row_count": 1, "video_count": 1, "song_count": 1, "has_empty_song_key": False}]
module._rows = cache_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
cache_options = {"range": "all"}
cache_first = module._overlay_vtuber_replacement_rows(CacheConnection(), "cache-safe", "parent", [cache_candidate], cache_options, {})
assert cache_calls
module._rows = lambda *_: (_ for _ in ()).throw(AssertionError("legal cache queried SQL"))
assert module._overlay_vtuber_replacement_rows(CacheConnection(), "cache-safe", "parent", [cache_candidate], cache_options, {})["UCNEW"]["row_count"] == 1
cache_key = ("cache-safe", "parent", "all", "", "", (), "", 0, False, False)
legal_cached = module._VTUBER_REPLACEMENT_CACHE[cache_key]
for poisoned in (
    {},
    {"UCNEW": {**legal_cached["UCNEW"], "detail_key": "UCOLD"}},
    {"UCNEW": {**legal_cached["UCNEW"], "payload_json": {**legal_cached["UCNEW"]["payload_json"], "channelId": "UCOLD"}}},
    {"UCNEW": {**legal_cached["UCNEW"], "payload_json": {
        **legal_cached["UCNEW"]["payload_json"],
        "occurrences": [{"item": {"videoId": "cache-video", "channelId": "UCNEW", "thumbnailUrl": "https://i.ytimg.com/vi/old-video/hqdefault.jpg"}}],
    }}},
):
    module._VTUBER_REPLACEMENT_CACHE[cache_key] = poisoned
    try:
        module._overlay_vtuber_replacement_rows(CacheConnection(), "cache-safe", "parent", [cache_candidate], cache_options, {})
        raise AssertionError("poisoned cache was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == "VTuber exact replacement cache identity is invalid"
    assert module._VTUBER_REPLACEMENT_CACHE[cache_key] is poisoned
module._VTUBER_REPLACEMENT_CACHE[cache_key] = legal_cached
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber missing previews use one bounded channel tuple query and fail closed on inexact sets", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def joined(channel_id, video_id, occurrence_id, title):
    handle = "@" + channel_id.lower()
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {
      "revision_id": "parent", "channel_id": channel_id,
      "channel_name": channel_id, "channel_handle": handle,
      "channel_url": "https://www.youtube.com/channel/" + channel_id,
      "video_id": video_id, "video_title": video_id,
      "thumbnail_url": thumbnail,
      "video_payload_json": {
        "videoId": video_id, "channelId": channel_id,
        "channelName": channel_id, "channelHandle": handle,
        "thumbnailUrl": thumbnail,
      },
      "occurrence_id": occurrence_id, "range_id": "all",
      "song_key": occurrence_id, "seconds": 41, "title": title,
      "artist": "Artist", "source_id": "fixture", "source_system": "test",
      "occurrence_payload_json": {
        "videoId": video_id, "occurrenceId": occurrence_id, "position": 0,
        "rangeId": "all", "songKey": occurrence_id, "seconds": 41,
        "title": title, "artist": "Artist",
      },
    }

returned = [joined("UC1", "video-1", "occ-1", "Song 1"),
            joined("UC2", "video-2", "occ-2", "Song 2")]
def exact_rows(_connection, sql, params):
    assert "bounded final VTuber previews" in sql
    assert "requested_channels AS MATERIALIZED" in sql
    assert "row_number() OVER" in sql
    assert "requested.channel_id = v.channel_id" in sql
    assert "scope.range_id = o.range_id" in sql
    assert "CROSS JOIN LATERAL" in sql
    assert "LIMIT 1" in sql
    assert "WHERE preview_rank = 1" in sql
    assert "v.thumbnail_url" in sql
    assert "NULL::integer AS position" in sql
    assert "o.position" not in sql
    assert "ORDER BY v.channel_id, o.video_id, o.occurrence_id" in sql
    assert params == [
      ["UC1", "UC2"], [], [], [], ["all", ""],
      "parent", "parent", False, False, 3,
    ], params
    return list(returned)
module._rows = exact_rows
previews = module._bounded_final_vtuber_previews(
  object(), "parent", ["UC2", "UC1"], "all",
)
assert set(previews) == {"UC1", "UC2"}
assert previews["UC1"]["item"]["videoId"] == "video-1"
assert previews["UC2"]["item"]["channelId"] == "UC2"
assert previews["UC1"]["song"]["title"] == previews["UC1"]["title"] == "Song 1"
assert previews["UC1"]["song"]["seconds"] == previews["UC1"]["seconds"] == 41

def expect_failure(label, rows, channels, message):
    module._rows = lambda *_: list(rows)
    try:
        module._bounded_final_vtuber_previews(
          object(), "parent", channels, "all",
        )
        raise AssertionError(label + " was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == message, (label, str(error))

expect_failure(
  "cross-channel tuple",
  [joined("UC2", "video-2", "occ-2", "Song 2")],
  ["UC1"],
  "bounded VTuber preview query returned an inexact channel set",
)
expect_failure(
  "missing channel tuple",
  [joined("UC1", "video-1", "occ-1", "Song 1")],
  ["UC1", "UC2"],
  "bounded VTuber preview query returned an inexact channel set",
)
expect_failure(
  "cap plus one",
  [
    joined("UC1", "video-1", "occ-1", "Song 1"),
    joined("UC2", "video-2", "occ-2", "Song 2"),
    joined("UC2", "video-3", "occ-3", "Song 3"),
  ],
  ["UC1", "UC2"],
  "bounded VTuber preview query exceeded its channel cap",
)
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber page hydration batches exact exclusions and validates every public tuple", () => {
  const output = runPython(`
import copy
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def joined(channel_id, index):
    video_id = "video-" + str(index)
    occurrence_id = "occ-" + str(index)
    handle = "/@" + channel_id.lower()
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {
      "revision_id": "parent", "channel_id": channel_id,
      "channel_name": channel_id, "channel_handle": handle,
      "channel_url": "https://www.youtube.com/channel/" + channel_id,
      "video_id": video_id, "video_title": video_id,
      "thumbnail_url": thumbnail,
      # Scalar thumbnail is intentional: runtime payload JSON is not required
      # to duplicate this canonical schema column.
      "video_payload_json": {"videoId": video_id, "channelId": channel_id,
        "channelName": channel_id, "channelHandle": handle},
      "occurrence_id": occurrence_id, "position": None, "range_id": "all",
      "song_key": occurrence_id, "seconds": 40 + index,
      "title": "Song " + str(index), "artist": "Artist",
      "source_id": "fixture", "source_system": "test",
      "occurrence_payload_json": {"videoId": video_id,
        "occurrenceId": occurrence_id, "rangeId": "all",
        "songKey": occurrence_id, "seconds": 40 + index,
        "title": "Song " + str(index), "artist": "Artist"},
    }

calls = []
def rows(_connection, sql, params):
    assert "bounded final VTuber previews" in sql
    calls.append((sql, params))
    return [joined(channel_id, index + 1)
      for index, channel_id in enumerate(params[0])]
module._rows = rows

def ranking_row(channel_id, row_count=1, timestamp_count=1):
    return {"detail_key": channel_id, "name": channel_id,
      "row_count": row_count, "song_count": 1, "video_count": 1,
      "timestamp_count": timestamp_count, "payload_json": {
        "type": "vtuber", "key": channel_id, "channelId": channel_id,
        "channelName": channel_id, "count": row_count, "songCount": 1,
        "videoCount": 1, "timestampCount": timestamp_count, "occurrences": [],
      }}

prepared = {
  "filtered": (ranking_row("UC1"), ranking_row("UC2")),
  "metadata": (), "candidateRows": (), "parentRevisionId": "parent",
  "exactAffectedChannelIds": ("UC1", "UC2"),
  "previewExcludedVideoIds": ("reset-video",),
  "previewExcludedOccurrenceIds": (("changed-video", "changed-occ"),),
}
payload = module._render_generic_overlay_rankings(
  object(), prepared,
  {"range": "all", "view": "vtubers", "metric": "count",
   "page": "1", "pageSize": "20"},
)
assert len(calls) == 1
sql, params = calls[0]
assert params[0] == ["UC1", "UC2"]
assert params[1] == ["reset-video"]
assert list(zip(params[2], params[3])) == [("changed-video", "changed-occ")]
assert "CROSS JOIN LATERAL" in sql and "o.position" not in sql
assert [row["channelId"] for row in payload["records"]] == ["UC1", "UC2"]
for row in payload["records"]:
    occurrence = row["occurrences"][0]
    assert occurrence["item"] == occurrence["video"]
    assert occurrence["videoId"] == occurrence["item"]["videoId"]
    assert occurrence["item"]["channelId"] == row["channelId"]
    assert occurrence["item"]["channelHandle"] == row["channelHandle"]
    assert row["channelHandle"].startswith("/@")
    assert row["thumbnailUrl"] == occurrence["item"]["thumbnailUrl"]
    assert occurrence["title"] == occurrence["song"]["title"]
    assert occurrence["artist"] == occurrence["song"]["artist"]
    assert occurrence["seconds"] == occurrence["song"]["seconds"]

# timestampCount alone is a positive card.  The real preview handle wins over
# aggregate-card formatting while comparison remains normalized.
timestamp_only = copy.deepcopy(payload["records"][0])
timestamp_only["count"] = 0
timestamp_only["timestampCount"] = 1
timestamp_only["channelHandle"] = "/@MiXeD"
timestamp_only["occurrences"][0]["item"]["channelHandle"] = "@mixed"
timestamp_only["occurrences"][0]["video"]["channelHandle"] = "mixed"
module._canonicalize_vtuber_card_preview(timestamp_only, "UC1")
assert timestamp_only["channelHandle"] == "@mixed"
assert timestamp_only["occurrences"][0]["item"]["channelHandle"] == "@mixed"

# A timestamp-only empty card must reach the same public page batch hydration
# path; directly testing the canonicalizer would not lock this discovery gate.
calls.clear()
timestamp_prepared = {
  "filtered": (ranking_row("UCTS", 0, 1),),
  "metadata": (), "candidateRows": (), "parentRevisionId": "parent",
  "exactAffectedChannelIds": ("UCTS",),
  "previewExcludedVideoIds": (),
  "previewExcludedOccurrenceIds": (),
}
timestamp_payload = module._render_generic_overlay_rankings(
  object(), timestamp_prepared,
  {"range": "all", "view": "vtubers", "metric": "count",
   "page": "1", "pageSize": "20"},
)
assert len(calls) == 1
assert calls[0][1][0] == ["UCTS"]
assert timestamp_payload["records"][0]["count"] == 0
assert timestamp_payload["records"][0]["timestampCount"] == 1
assert timestamp_payload["records"][0]["occurrences"][0]["item"]["channelId"] == "UCTS"

def rejected(card, message):
    try:
        module._canonicalize_vtuber_card_preview(card, card["channelId"])
        raise AssertionError("invalid preview was accepted")
    except module.PostgresAdapterError as error:
        assert str(error) == message, str(error)

missing_handle = copy.deepcopy(payload["records"][0])
missing_handle["channelHandle"] = ""
for nested in (missing_handle["occurrences"][0]["item"],
               missing_handle["occurrences"][0]["video"]):
    nested["channelHandle"] = ""
rejected(missing_handle, "VTuber ranking preview identity is invalid")

card_handle_conflict = copy.deepcopy(payload["records"][0])
card_handle_conflict["channelHandle"] = "@one"
for nested in (card_handle_conflict["occurrences"][0]["item"],
               card_handle_conflict["occurrences"][0]["video"]):
    nested["channelHandle"] = "@other"
module._canonicalize_vtuber_card_preview(
    card_handle_conflict, card_handle_conflict["channelId"],
)
assert card_handle_conflict["channelHandle"] == "@other"
assert card_handle_conflict["channelUrl"] == "https://www.youtube.com/@other"
assert (
    card_handle_conflict["occurrences"][0]["item"]
    == card_handle_conflict["occurrences"][0]["video"]
)

tuple_handle_conflict = copy.deepcopy(payload["records"][0])
tuple_handle_conflict["channelHandle"] = "@one"
tuple_handle_conflict["occurrences"][0]["item"]["channelHandle"] = "@one"
tuple_handle_conflict["occurrences"][0]["video"]["channelHandle"] = "@other"
rejected(tuple_handle_conflict, "VTuber ranking preview identity is invalid")

for field in ("title", "artist", "seconds"):
    mismatch = copy.deepcopy(payload["records"][0])
    mismatch["occurrences"][0]["song"][field] = "wrong"
    rejected(mismatch, "VTuber ranking preview song tuple is invalid")

stale_second = copy.deepcopy(payload["records"][0])
bad = copy.deepcopy(stale_second["occurrences"][0])
bad["item"]["channelId"] = "UCOTHER"
bad["video"]["channelId"] = "UCOTHER"
stale_second["occurrences"].append(bad)
rejected(stale_second, "VTuber ranking preview identity is invalid")

bad_url = copy.deepcopy(payload["records"][0])
bad_url["occurrences"][0]["item"]["channelUrl"] = "https://youtube.com/@other"
bad_url["occurrences"][0]["video"]["channelUrl"] = "https://youtube.com/@other"
rejected(bad_url, "VTuber ranking preview channel URL is invalid")
print("OK")
`);
  assert.equal(output, "OK");
});

test("unscoped overlay reconstruction admits mature lineages for rankings and source detail", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

video = {
    "revision_id": "accepted", "video_id": "video-a", "video_title": "Video",
    "channel_name": "Channel", "channel_id": "UC1", "channel_handle": "@one",
    "channel_url": "https://youtube.com/@one", "published_at": None,
    "video_payload_json": None, "video_tombstone": False,
}
occurrence = {
    "revision_id": "accepted", "video_id": "video-a", "occurrence_id": "occ-a",
    "position": 0, "range_id": "all", "song_key": "song-a", "seconds": 18,
    "title": "Song", "artist": "Artist", "source_id": "source-a",
    "raw_hash": "raw-a", "source_system": "fixture",
    "occurrence_payload_json": None,
}
limits = []
def rows(_connection, sql, params):
    if "FROM migration_video_rows" in sql:
        assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        return [video]
    if "FROM migration_occurrence_rows AS o" in sql:
        limits.append(params[-1])
        return [occurrence] * (module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1)
    raise AssertionError(sql)

module._rows = rows
scalar = module._overlay_candidate_rows(object(), ["accepted"], False)
assert len(scalar) == 1 and scalar[0]["occurrence_id"] == "occ-a"
detailed = module._overlay_candidate_rows(object(), ["accepted"], True)
assert len(detailed) == 1 and detailed[0]["occurrence_id"] == "occ-a"
assert limits == [
    module._MAX_UNSCOPED_OVERLAY_OCCURRENCES + 1,
    module._MAX_UNSCOPED_OVERLAY_OCCURRENCES + 1,
]
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic cold meta cache is revision-bound and ranking previews hydrate only returned tuples", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

active = ["accepted-a"]
applied = []
module._runtime_projection_revision = lambda *_: None
module._generic_runtime_projection_revision = lambda *_: (active[0], {"status": "active", "manifest_json": {}, "content_sha256": active[0]})
module._generic_parent_runtime_revision = lambda *_: ("parent-" + active[0], {"manifest_json": {}})
module._overlay_revision_ids = lambda *_: [active[0]]
module._generic_public_all_range_baseline = lambda *_args: (585076, 1755228)
module._apply_generic_overlay_meta_counts = lambda _c, parent, overlays, counts, *_args: (applied.append((parent, tuple(overlays))) or {**counts, "videos": len(applied)})
module._rows = lambda _c, sql, _p: ([{"key": "latest_videos", "value": 10}] if "SELECT key, value FROM runtime_meta" in sql else [])
module._GENERIC_META_COUNTS_CACHE.clear()
assert module.health_payload(object())["counts"]["videos"] == 1
assert module.meta_payload(object())["counts"]["videos"] == 1
assert applied == [("parent-accepted-a", ("accepted-a",))]
active[0] = "accepted-b"
assert module.meta_payload(object())["counts"]["videos"] == 2
assert applied[-1] == ("parent-accepted-b", ("accepted-b",))
active[0] = "accepted-a"
assert module.meta_payload(object())["counts"]["videos"] == 1
assert len(applied) == 2

rows = [
    {"revision_id": "accepted-a", "video_id": f"video-{index}", "occurrence_id": f"occ-{index}", "position": 0,
     "range_id": "all", "song_key": "song", "title": "Song", "artist": "Artist",
     "channel_id": "UC1", "channel_handle": "@one", "channel_name": "One", "video_title": f"Video {index}",
     "video_tombstone": False, "occurrence_payload_json": None, "video_payload_json": None}
    for index in range(4000)
]
groups = module._overlay_candidate_groups(rows, "vtubers")
assert groups["UC1"]["occurrenceCount"] == 4000
assert len(groups["UC1"]["occurrences"]) == 20
payload = {"occurrences": groups["UC1"]["occurrences"]}
sql_calls = []
def scalar_rows(_connection, sql, _params):
    sql_calls.append(sql)
    if "migration_occurrence_rows" in sql:
        return rows
    if "migration_video_rows" in sql:
        return [{
            "revision_id": "accepted-a", "video_id": row["video_id"], "video_title": row["video_title"],
            "channel_id": "UC1", "channel_handle": "@one", "channel_name": "One", "video_tombstone": False,
            "video_payload_json": None,
        } for row in rows]
    raise AssertionError(sql)
module._rows = scalar_rows
module._json_object = lambda value: (_ for _ in ()).throw(AssertionError("scalar overlay parsed JSON"))
lean = module._overlay_candidate_rows(object(), ["accepted-a"], False)
assert len(lean) == 4000
assert len(module._accepted_video_resets(object(), ["accepted-a"], False)) == 4000
assert all("NULL::jsonb AS" in sql for sql in sql_calls)
module._json_object = lambda value: dict(value) if isinstance(value, dict) else {}
hydration = []
def hydrate_rows(_connection, sql, params):
    assert "WITH requested" in sql and "migration_occurrence_rows" in sql
    assert len(params[0]) == len(params[1]) == len(params[2]) == len(params[3]) == 20
    assert params[-1] == 21
    hydration.append(tuple(params[1]))
    return [{
        "revision_id": "accepted-a", "video_id": video_id, "occurrence_id": occurrence_id, "position": 0,
        "joined_video_id": video_id,
        "occurrence_payload_json": {"occurrenceId": occurrence_id},
        "video_payload_json": {"videoId": video_id, "channelId": "UC1", "channelHandle": "@one", "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"},
        "video_title": video_id, "channel_id": "UC1", "channel_handle": "@one", "channel_name": "One",
    } for video_id, occurrence_id in zip(params[1], params[2])]
module._rows = hydrate_rows
module._hydrate_overlay_page_previews(object(), rows, [payload])
assert len(hydration) == 1 and len(hydration[0]) == 20
assert payload["occurrences"][0]["item"]["thumbnailUrl"].endswith("/video-0/hqdefault.jpg")
assert payload["occurrences"][0]["item"] == payload["occurrences"][0]["video"]
print("OK")
`);
  assert.equal(output, "OK");
});

test("overlay preview hydration rejects inexact returned identities and permits a bounded 400-tuple page", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

candidate_rows = [
    {"revision_id": "accepted-a", "video_id": f"video-{index:03d}", "occurrence_id": f"occ-{index:03d}", "position": 0}
    for index in range(400)
]
payloads = []
for start in range(0, 400, 20):
    payloads.append({"occurrences": [
        {"videoId": f"video-{index:03d}", "occurrenceId": f"occ-{index:03d}", "position": 0,
         "item": {"videoId": f"video-{index:03d}"}}
        for index in range(start, start + 20)
    ]})

def hydrated(row):
    return {
        **row,
        "joined_video_id": row["video_id"],
        "occurrence_payload_json": {"occurrenceId": row["occurrence_id"], "position": row["position"]},
        "video_payload_json": {"videoId": row["video_id"], "channelId": "UC1", "thumbnailUrl": f"https://i.ytimg.com/vi/{row['video_id']}/hqdefault.jpg"},
        "video_title": row["video_id"], "channel_id": "UC1", "channel_name": "One",
    }

def install(returned):
    def rows(_connection, sql, params):
        assert "WITH requested" in sql
        assert len(params[0]) == len(params[1]) == len(params[2]) == len(params[3]) == 400
        assert params[-1] == 401
        return returned
    module._rows = rows

install([hydrated(row) for row in candidate_rows])
module._hydrate_overlay_page_previews(object(), candidate_rows, payloads)
assert payloads[-1]["occurrences"][-1]["item"]["thumbnailUrl"].endswith("/video-399/hqdefault.jpg")

def expect_failure(returned, marker):
    fresh_payloads = [{"occurrences": [dict(item) for item in payload["occurrences"]]} for payload in payloads]
    install(returned)
    try:
        module._hydrate_overlay_page_previews(object(), candidate_rows, fresh_payloads)
    except module.PostgresAdapterError as exc:
        assert marker in str(exc), str(exc)
    else:
        raise AssertionError(f"expected {marker}")

expect_failure([hydrated(row) for row in candidate_rows[1:]], "missing=1")
expect_failure([hydrated(candidate_rows[0]), hydrated(candidate_rows[0]), *[hydrated(row) for row in candidate_rows[2:]]], "duplicate identity")
unexpected = dict(candidate_rows[-1], video_id="video-unexpected", occurrence_id="occ-unexpected")
expect_failure([*[hydrated(row) for row in candidate_rows[:-1]], hydrated(unexpected)], "unexpected=1")
revision_tampered = dict(hydrated(candidate_rows[-1]), revision_id="accepted-tampered")
expect_failure([*[hydrated(row) for row in candidate_rows[:-1]], revision_tampered], "missing=1")
print("OK")
`);
  assert.equal(output, "OK");
});

test("overlay preview hydration permits empty object payloads but requires the video join", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

candidate = {"revision_id": "accepted-a", "video_id": "video-a", "occurrence_id": "occ-a", "position": 0}
payload = {"occurrences": [{"videoId": "video-a", "occurrenceId": "occ-a", "position": 0, "item": {"videoId": "video-a"}}]}
def returned(joined_video_id):
    return [{"revision_id": "accepted-a", "video_id": "video-a", "occurrence_id": "occ-a", "position": 0,
             "joined_video_id": joined_video_id, "occurrence_payload_json": {}, "video_payload_json": {},
             "video_title": "Video A", "channel_id": "UC1", "channel_name": "One"}]
def rows(_connection, sql, _params):
    assert "v.video_id AS joined_video_id" in sql
    return returned("video-a")
module._rows = rows
module._hydrate_overlay_page_previews(object(), [candidate], [payload])
assert payload["occurrences"][0]["item"]["videoId"] == "video-a"

module._rows = lambda *_: returned(None)
try:
    module._hydrate_overlay_page_previews(object(), [candidate], [{"occurrences": [dict(payload["occurrences"][0])]}])
except module.PostgresAdapterError as exc:
    assert "incomplete video join" in str(exc), str(exc)
else:
    raise AssertionError("missing video join was accepted")
print("OK")
`);
  assert.equal(output, "OK");
});

test("overlay preview cap preserves candidate, generic parent, VTuber, artist, and video input ordering", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

rows = [
    {"video_id": f"video-{index:02d}", "occurrence_id": f"occ-{index:02d}", "position": 0,
     "title": "Song", "artist": "Artist", "song_key": "song", "range_id": "all",
     "channel_id": "UC1", "channel_name": "One", "video_title": f"Video {index:02d}",
     "video_payload_json": {"videoId": f"video-{index:02d}", "channelId": "UC1"},
     "occurrence_payload_json": {"occurrenceId": f"occ-{index:02d}", "position": 0}}
    for index in range(25, -1, -1)
]
group = module._overlay_candidate_groups(rows, "songs")["song::artist"]
expected_candidate = [f"video-{index:02d}" for index in range(25, 5, -1)]
assert [item["videoId"] for item in group["occurrences"]] == expected_candidate
artist_group = module._overlay_candidate_groups(rows, "artists")["artist"]
video_group = module._overlay_candidate_groups(rows, "videos")["video-25"]
assert [item["videoId"] for item in artist_group["occurrences"]] == expected_candidate
assert [item["videoId"] for item in video_group["occurrences"]] == ["video-25"]
parent = [{"videoId": "video-19", "occurrenceId": "old", "position": 9}, {"videoId": "video-20", "occurrenceId": "old", "position": 0}]
merged = module._bounded_overlay_previews([*parent, *group["occurrences"]])
assert [item["videoId"] for item in merged] == ["video-19", "video-20", *expected_candidate[:18]]
vtuber_merged = module._bounded_overlay_previews([*group["occurrences"], *parent])
assert [item["videoId"] for item in vtuber_merged] == expected_candidate
print("OK")
`);
  assert.equal(output, "OK");
});

test("real-shape scalar and payload overlay fixtures keep reset, replacement, tombstone, ranking, and source results identical", () => {
  const output = runPython(`
import copy
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

videos = [
    {"revision_id": "accepted", "video_id": "video-accepted", "title": "Accepted video", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "@channel", "channel_url": "https://youtube.com/@channel", "published_at": "2026-07-29T00:00:00Z", "tombstone": False, "payload_json": {"videoId": "video-accepted", "title": "Accepted video", "channelId": "UC1", "channelName": "Channel", "channelHandle": "@channel", "thumbnailUrl": "accepted.jpg"}},
    {"revision_id": "accepted", "video_id": "video-replacement", "title": "Replacement video", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "@channel", "channel_url": "https://youtube.com/@channel", "published_at": "2026-07-29T00:00:01Z", "tombstone": False, "payload_json": {"videoId": "video-replacement", "title": "Replacement video", "channelId": "UC1", "channelName": "Channel", "channelHandle": "@channel", "thumbnailUrl": "replacement.jpg"}},
    {"revision_id": "accepted", "video_id": "video-7d", "title": "Seven video", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "@channel", "channel_url": "https://youtube.com/@channel", "published_at": "2026-07-29T00:00:02Z", "tombstone": False, "payload_json": {"videoId": "video-7d", "title": "Seven video", "channelId": "UC1", "channelName": "Channel", "channelHandle": "@channel", "thumbnailUrl": "seven.jpg"}},
    {"revision_id": "accepted", "video_id": "video-tombstone", "title": "Removed", "channel_id": "UC1", "channel_name": "Channel", "channel_handle": "@channel", "channel_url": "https://youtube.com/@channel", "published_at": "2026-07-29T00:00:03Z", "tombstone": True, "payload_json": {"videoId": "video-tombstone", "channelId": "UC1"}},
]
occurrences = [
    {"revision_id": "accepted", "video_id": "video-accepted", "occurrence_id": "accepted", "position": 0, "range_id": "all", "song_key": "accepted", "seconds": 11, "title": "Accepted", "artist": "Singer", "source_id": "src-a", "raw_hash": "a", "source_system": "fixture", "payload_json": {"occurrenceId": "accepted", "position": 0, "rangeId": "all", "songKey": "accepted", "seconds": 11, "title": "Accepted", "artist": "Singer", "sourceId": "src-a", "sourceSystem": "fixture"}},
    {"revision_id": "accepted", "video_id": "video-replacement", "occurrence_id": "replacement", "position": 0, "range_id": "all", "song_key": "replacement", "seconds": 22, "title": "Replacement", "artist": "Singer", "source_id": "src-r", "raw_hash": "r", "source_system": "fixture", "payload_json": {"occurrenceId": "replacement", "position": 0, "rangeId": "all", "songKey": "replacement", "seconds": 22, "title": "Replacement", "artist": "Singer", "sourceId": "src-r", "sourceSystem": "fixture", "originalIdentity": {"videoId": "video-replacement", "title": "Old", "artist": "Singer"}}},
    {"revision_id": "accepted", "video_id": "video-7d", "occurrence_id": "seven", "position": 0, "range_id": "7d", "song_key": "seven", "seconds": 33, "title": "Seven", "artist": "Singer", "source_id": "src-7", "raw_hash": "7", "source_system": "fixture", "payload_json": {"occurrenceId": "seven", "position": 0, "rangeId": "7d", "songKey": "seven", "seconds": 33, "title": "Seven", "artist": "Singer", "sourceId": "src-7", "sourceSystem": "fixture"}},
]

def rows(_connection, sql, _params):
    if "FROM migration_occurrence_rows" in sql:
        result = copy.deepcopy(occurrences)
        for row in result:
            if "NULL::jsonb" in sql:
                row["occurrence_payload_json"] = None
            else:
                row["occurrence_payload_json"] = row.pop("payload_json")
        return result
    if "FROM migration_video_rows" in sql:
        result = copy.deepcopy(videos)
        for row in result:
            row["video_title"] = row.pop("title")
            row["video_tombstone"] = row["tombstone"]
            if "NULL::jsonb" in sql:
                row["video_payload_json"] = None
            else:
                row["video_payload_json"] = row.pop("payload_json")
        return result
    raise AssertionError(sql)
module._rows = rows

full = module._overlay_candidate_rows(object(), ["accepted"], True)
scalar = module._overlay_candidate_rows(object(), ["accepted"], False)
assert all(row["video_payload_json"] is None and row["occurrence_payload_json"] is None for row in scalar)
full_resets = module._accepted_video_resets(object(), ["accepted"], True)
scalar_resets = module._accepted_video_resets(object(), ["accepted"], False)
assert {
    key: (row["revision_id"], row["video_id"], row["tombstone"])
    for key, row in full_resets.items()
} == {
    key: (row["revision_id"], row["video_id"], row["tombstone"])
    for key, row in scalar_resets.items()
}
assert scalar_resets["video-tombstone"]["tombstone"] is True

# The bounded path hydrates just returned tuples.  This fixture materializes
# all three live previews only to compare it against the detailed full-payload
# path; the production page cap is tested independently above.
by_identity = {(row["video_id"], row["occurrence_id"], row["position"]): row for row in full}
hydrated = []
for row in scalar:
    key = (row["video_id"], row["occurrence_id"], row["position"])
    source = by_identity[key]
    hydrated.append({**row, "video_payload_json": source["video_payload_json"], "occurrence_payload_json": source["occurrence_payload_json"]})

def records(rows):
    result = []
    for row in rows:
        record = module._overlay_source_record(row)
        if record is not None:
            result.append(record)
    return result

full_records, scalar_records = records(full), records(hydrated)
assert full_records == scalar_records
for range_id in ("all", "7d"):
    for view in ("songs", "vtubers"):
        query = {"range": range_id, "view": view, "metric": "occurrences", "q": "singer" if view == "songs" else "channel", "page": "1", "pageSize": "1"}
        expected = module.rankings_payload_from_records(full_records, query)
        actual = module.rankings_payload_from_records(scalar_records, query)
        assert actual == expected
        for card in actual["records"]:
            assert card["count"] == card["timestampCount"]
            assert card["sourceDetailKey"]
            for occurrence in card["occurrences"]:
                assert occurrence["item"]["videoId"].startswith("video-")
                assert occurrence["item"]["channelId"] == "UC1"
                assert occurrence.get("video", occurrence["item"])["videoId"] == occurrence["item"]["videoId"]
            source = module.source_payload_from_records(full_records, card["sourceDetailKey"], {"range": range_id, "page": "1", "pageSize": "1"})
            scalar_source = module.source_payload_from_records(scalar_records, card["sourceDetailKey"], {"range": range_id, "page": "1", "pageSize": "1"})
            assert scalar_source == source
            if source.get("found"):
                record = source["record"]
                assert record["count"] == record["timestampCount"]
                assert record["videoCount"] >= 1
print("OK")
`);
  assert.equal(output, "OK");
});

test("ranking identity audit bounds every CLI request and pagination control", () => {
  const output = runPython(`
import contextlib
import importlib.util
import io
import sys
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
for flag, value in (
    ("--page-size", "21"), ("--page-size", "0"), ("--page-size", "-1"),
    ("--max-pages", "201"), ("--max-pages", "0"),
    ("--concurrency", "5"),
    ("--timeout", "0"), ("--timeout", "61"),
):
    sys.argv = ["audit", "--base-url", "http://candidate", flag, value]
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            module.main()
        except SystemExit as error:
            assert error.code == 2, (flag, value, error.code)
        else:
            raise AssertionError(f"expected parser failure: {flag}={value}")
print("OK")
`);
  assert.equal(output, "OK");
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
assert module.normalized_handle("　／＠ＥxＰｅＣｔｅＤ　") == "expected"
assert module.normalized_handle("/@Expected") == "expected"
assert module.normalized_handle("@EXPECTED") == "expected"
assert module.normalized_handle("@@expected") == ""
assert module.normalized_handle("//@expected") == ""
assert module.normalized_handle("@/expected") == ""
assert module.channel_url_matches("https://www.youtube.com/@Expected/", "UCEXPECTED", "expected")
assert module.channel_url_matches("https://youtube.com/channel/UCEXPECTED", "UCEXPECTED", "expected")
assert module.thumbnail_matches_video("https://i.ytimg.com/vi/video-good/hqdefault.jpg", "video-good")
assert module.thumbnail_matches_video("https://i.ytimg.com/vi_webp/video-good/hqdefault.webp", "video-good")
assert module.thumbnail_matches_video("https://img.youtube.com/an_webp/video-good/mqdefault_6s.webp", "video-good")
for thumbnail in (
    "https://evil.example/vi/video-good/hqdefault.jpg",
    "https://i.ytimg.com/static/video-good/hqdefault.jpg",
    "https://i.ytimg.com/vi/other-video/hqdefault.jpg?video=video-good",
    "data:image/jpeg;base64,video-good",
):
    assert not module.thumbnail_matches_video(thumbnail, "video-good"), thumbnail
for url in (
    "https://youtube.com/@expected-evil",
    "https://youtube.com.evil/@expected",
    "https://youtube.com/@other?next=@expected",
    "https://youtube.com/@other#@expected",
):
    assert not module.channel_url_matches(url, "UCEXPECTED", "expected"), url
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
expected_card = {
    **good,
    "key": "UCEXPECTED",
    "channelId": "UCEXPECTED",
    "channelHandle": "/@expected",
    "channelUrl": "https://youtube.com/@expected",
    "occurrences": good["occurrences"],
}
for url in (
    "https://youtube.com/@expected-evil",
    "https://youtube.com.evil/@expected",
    "https://youtube.com/@other?next=@expected",
    "https://youtube.com/@other#@expected",
):
    assert "card_channel_url_mismatch" in module.audit_record({**expected_card, "channelUrl": url}), url
assert module.audit_record({**good, "occurrences": [{"item": good["occurrences"][0]["item"]}]}) == set()
assert module.audit_record({**good, "occurrences": [{"video": good["occurrences"][0]["video"]}]}) == set()
assert "invalid_occurrence_item_schema" in module.audit_record({**good, "occurrences": [{"item": None, "video": good["occurrences"][0]["video"]}]})
assert "invalid_occurrence_video_schema" in module.audit_record({**good, "occurrences": [{"item": good["occurrences"][0]["item"], "video": None}]})
assert "missing_card_occurrences" in module.audit_record({**good, "occurrences": []})
missing_occurrences = dict(good)
missing_occurrences.pop("occurrences")
assert "missing_card_occurrences" in module.audit_record(missing_occurrences)
assert "invalid_card_occurrences" in module.audit_record({**good, "occurrences": {}})
top_missing = module.audit_record({**good, "channelHandle": "", "channelUrl": ""})
assert "missing_card_channel_handle" in top_missing
assert "missing_card_channel_url" in top_missing
for field, problem in (
    ("videoId", "missing_occurrence_video_id"),
    ("channelId", "missing_occurrence_channel_id"),
    ("channelHandle", "missing_occurrence_channel_handle"),
    ("thumbnailUrl", "missing_occurrence_thumbnail"),
):
    item = dict(good["occurrences"][0]["item"])
    item.pop(field)
    assert problem in module.audit_record({**good, "occurrences": [{"item": item}]}), (field, problem)
assert "missing_occurrence_video_identity" in module.audit_record({**good, "occurrences": [{"videoId": "flat"}]})
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

test("source identity audit validates compact source metadata before reporting summary", () => {
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
def fetch_json(base_url, path, timeout, *unused):
    if path == "/healthz":
        return 200, 1, {"status": "ok"}
    if path == "/api/meta":
        return 200, 1, {"meta": {"active_revision_id": "active"}}
    if path.startswith("/api/rankings"):
        return 200, 1, {"totalCount": 1, "records": [{
            "key": "UCEXPECTED", "channelId": "UCEXPECTED", "channelHandle": "/@expected",
            "channelUrl": "https://www.youtube.com/@expected", "sourceDetailKey": "source-key", "occurrences": [{"item": {"videoId": "probe-video", "channelId": "UCEXPECTED", "channelHandle": "/@expected", "thumbnailUrl": "https://i.ytimg.com/vi/probe-video/hqdefault.jpg"}}],
        }]}
    if path.startswith("/api/sources/source-key"):
        return 200, 1, {
            "found": True,
            "sourceKey": "source-key",
            "page": 1,
            "pageSize": 20,
            "pageCount": 1,
            "totalCount": 1,
            "totalVideoCount": 1,
            "totalOccurrenceCount": 1,
            "record": {
                "sourceDetailKey": "source-key",
                "channelId": "UCEXPECTED",
                "channelHandle": "/@expected",
                "channelUrl": "https://www.youtube.com/@expected",
                "occurrences": [{
                    "videoId": "video-1",
                    "item": {"videoId": "video-1", "channelId": "UCEXPECTED", "channelHandle": "/@expected", "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg"},
                    "song": {"occurrenceId": "position:0"},
                }],
            },
        }
    raise AssertionError(path)
module.fetch_json = fetch_json
sys.argv = [
    "audit", "--base-url", "http://candidate", "--skip-rankings",
    "--negative-query", "", "--expected-active", "active",
    "--channel-probe", "@expected=UCEXPECTED",
    "--source-probe", "source-key,UCEXPECTED,1,1",
]
stream = io.StringIO()
with contextlib.redirect_stdout(stream):
    assert module.main() == 0
summary_line = next(line for line in stream.getvalue().splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert summary["affectedRecords"] == 0
assert summary["gateErrors"] == []
assert summary["sourceProbeCoverage"] == {"source-key": {"pages": 1, "videos": 1, "occurrences": 1}}
print("OK")
`);
  assert.equal(output, "OK");
});

test("ranking identity audit uses a bounded concurrent window and fails closed on bad pages", () => {
  const output = runPython(`
import contextlib
import gc
import importlib.util
import io
import json
import sys
import threading
import time
import weakref
from urllib.parse import parse_qs, urlsplit
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Payload(dict):
    pass
mode = "success"
calls = []
payload_refs = []
active = 0
peak_active = 0
lock = threading.Lock()
blob = "x" * 200000
def record(identity, rank=None, source_key=None):
    key = "UC" + str(identity)
    if mode == "missing-key":
        key = ""
    if source_key is None:
        source_key = "" if mode == "sample-order" else "source-" + str(identity)
    if rank is None:
        rank = identity
    if mode == "rank-zero" and identity == 1:
        rank = 0
    if mode == "rank-invalid" and identity == 1:
        rank = "1"
    if mode == "rank-missing" and identity == 1:
        rank = None
    if mode == "rank-duplicate" and identity == 2:
        rank = 1
    if mode == "rank-out-of-bounds" and identity == 4:
        rank = 5
    channel_id = "UC-mismatch" if mode == "key-channel-mismatch" and identity == 1 else key
    handle = "/@fixture" + str(identity)
    video_id = "fixture-video-" + str(identity)
    return {"key": key, "rank": rank, "channelId": channel_id, "channelHandle": handle, "channelUrl": "https://youtube.com/channel/" + channel_id, "sourceDetailKey": source_key, "occurrences": [{"item": {"videoId": video_id, "channelId": channel_id, "channelHandle": handle, "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"}}], "synthetic": blob}
def fetch_json(base_url, path, timeout, *unused):
    global active, peak_active
    if path == "/healthz":
        return 200, 1, {"status": "ok"}
    if path == "/api/meta":
        return 200, 1, {"active_revision_id": "active"}
    if path.startswith("/api/rankings"):
        page = int(parse_qs(urlsplit(path).query)["page"][0])
        calls.append(page)
        if page > 1:
            with lock:
                active += 1
                peak_active = max(peak_active, active)
            try:
                if mode == "request-failure" and page == 2:
                    raise RuntimeError("fixture page failure")
                time.sleep(0.03 * (5 - page))
            finally:
                with lock:
                    active -= 1
        if mode == "zero":
            total, page_count, rows = 0, 1, []
        elif mode == "page-redistribution":
            total, page_count = 40, 2
            values = range(1, 22) if page == 1 else range(22, 41)
            rows = [record(value) for value in values]
        else:
            total = 5 if mode == "total-drift" and page == 3 else 4
            page_count = 3 if mode == "page-count-inconsistent" else 4
            if mode == "missing" and page == 4:
                rows = []
            elif mode == "page-size-mismatch" and page == 2:
                rows = [record(2), record(3)]
            elif mode == "same-key-different-source" and page == 2:
                rows = [record(1, rank=2, source_key="source-changed")]
            else:
                rows = [record(1 if mode == "duplicate" and page == 2 else page)]
        payload = Payload({"page": page, "pageCount": page_count, "totalCount": total, "records": rows})
        payload_refs.append(weakref.ref(payload))
        return 200, len(blob), payload
    raise AssertionError(path)
module.fetch_json = fetch_json
def run_case(next_mode):
    global mode, active, peak_active
    mode = next_mode
    calls.clear()
    payload_refs.clear()
    active = 0
    peak_active = 0
    page_size = "20" if next_mode == "page-redistribution" else "1"
    sys.argv = ["audit", "--base-url", "http://candidate", "--range", "all", "--metric", "count", "--page-size", page_size, "--max-pages", "4", "--concurrency", "4", "--negative-query", "", "--expected-active", "active"]
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        try:
            result = module.main()
        except RuntimeError as error:
            return stream.getvalue(), error
    return stream.getvalue(), result
stream, result = run_case("success")
assert result == 0
assert calls[0] == 1 and calls.count(1) == 1
assert 1 < peak_active <= 4
summary_line = next(line for line in stream.splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert summary["concurrency"] == 4 and summary["maxInFlight"] == 3
assert summary["rankingCoverage"] == {"all|count": {"expected": 4, "scanned": 4, "unique": 4, "ranks": 4}}
assert summary["bytesRead"] >= 4 * len(blob)
gc.collect()
assert all(reference() is None for reference in payload_refs)
for bad_mode, expected in (("request-failure", "fixture page failure"), ("total-drift", "ranking total changed during audit"), ("duplicate", "duplicate ranking record during audit"), ("same-key-different-source", "duplicate ranking record during audit"), ("missing-key", "missing stable key"), ("key-channel-mismatch", "key/channelId mismatch"), ("rank-zero", "rank out of bounds"), ("rank-invalid", "invalid ranking rank"), ("rank-missing", "invalid ranking rank"), ("rank-duplicate", "duplicate ranking rank"), ("rank-out-of-bounds", "rank out of bounds"), ("page-count-inconsistent", "pageCount inconsistent"), ("page-size-mismatch", "page size mismatch"), ("page-redistribution", "page size mismatch"), ("missing", "page size mismatch")):
    stream, error = run_case(bad_mode)
    assert expected in str(error), (bad_mode, str(error))
    assert "IDENTITY_AUDIT_SUMMARY" not in stream
stream, result = run_case("zero")
assert result == 0
summary_line = next(line for line in stream.splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert summary["rankingCoverage"] == {"all|count": {"expected": 0, "scanned": 0, "unique": 0, "ranks": 0}}
stream, error = run_case("sample-order")
assert "identity audit failed" in str(error)
summary_line = next(line for line in stream.splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert [sample["key"] for sample in summary["samples"]] == ["UC1", "UC2", "UC3", "UC4"]
print("OK")
`);
  assert.equal(output, "OK");
});

test("source identity audit fully pages video groups with bounded payload retention", () => {
  const output = runPython(`
import contextlib
import gc
import importlib.util
import io
import json
import sys
import threading
import time
import weakref
from urllib.parse import parse_qs, urlsplit
spec = importlib.util.spec_from_file_location("identity_audit", ${JSON.stringify(IDENTITY_AUDIT)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Payload(dict):
    pass
mode = "success"
calls = []
payload_refs = []
active = 0
peak_active = 0
lock = threading.Lock()
blob = "x" * 200000
def source_rows(page):
    start = (page - 1) * 20 + 1
    count = 20 if page < 3 else 9
    rows = []
    for video_number in range(start, start + count):
        repeats = 2 if video_number <= 5 else 1
        for position in range(repeats):
            rows.append({
                "videoId": f"video-{video_number}",
                "item": {
                    "videoId": f"video-{video_number}", "channelId": "UCEXPECTED",
                    "channelHandle": "/@expected",
                    "thumbnailUrl": f"https://i.ytimg.com/vi/video-{video_number}/hqdefault.jpg",
                },
                "video": {
                    "videoId": f"video-{video_number}", "channelId": "UCEXPECTED",
                    "channelHandle": "/@expected",
                    "thumbnailUrl": f"https://i.ytimg.com/vi/video-{video_number}/hqdefault.jpg",
                },
                "song": {"occurrenceId": f"position:{position}"},
                "rangeId": "all",
                "synthetic": blob,
            })
    return rows
def fetch_json(base_url, path, timeout, *unused):
    global active, peak_active
    if path == "/healthz":
        return 200, 1, {"status": "ok"}
    if path == "/api/meta":
        return 200, 1, {"active_revision_id": "active"}
    if path.startswith("/api/rankings"):
        query = parse_qs(urlsplit(path).query)
        assert query["pageSize"] == ["20"]
        return 200, 1, {"totalCount": 1, "records": [{
            "key": "UCEXPECTED", "channelId": "UCEXPECTED", "channelHandle": "/@expected",
            "channelUrl": "https://www.youtube.com/@expected", "sourceDetailKey": "source-key", "occurrences": [{"item": {"videoId": "probe-video", "channelId": "UCEXPECTED", "channelHandle": "/@expected", "thumbnailUrl": "https://i.ytimg.com/vi/probe-video/hqdefault.jpg"}}],
        }]}
    if path.startswith("/api/sources/source-key"):
        query = parse_qs(urlsplit(path).query)
        page = int(query["page"][0])
        assert query["pageSize"] == ["20"]
        calls.append(page)
        if page > 1:
            with lock:
                active += 1
                peak_active = max(peak_active, active)
            try:
                if mode == "request-failure" and page == 2:
                    raise RuntimeError("fixture source request failure")
                time.sleep(0.03 * (4 - page))
            finally:
                with lock:
                    active -= 1
        rows = source_rows(page)
        total_occurrences = 54
        page_count = 3
        total_videos = 49
        if mode == "total-drift" and page == 2:
            total_occurrences = 55
        if mode == "page-count-drift" and page == 2:
            page_count = 4
        if mode == "missing-page" and page == 3:
            rows = []
        if mode == "duplicate-video" and page == 2:
            rows[0]["item"]["videoId"] = "video-1"
            rows[0]["video"]["videoId"] = "video-1"
            rows[0]["videoId"] = "video-1"
            rows[0]["item"]["thumbnailUrl"] = "https://i.ytimg.com/vi/video-1/hqdefault.jpg"
            rows[0]["video"]["thumbnailUrl"] = "https://i.ytimg.com/vi/video-1/hqdefault.jpg"
            rows[0]["song"]["occurrenceId"] = "position:99"
        if mode == "duplicate-occurrence" and page == 2:
            rows.insert(1, dict(rows[0]))
        if mode == "wrong-channel" and page == 2:
            rows[0]["item"] = {"videoId": rows[0]["videoId"], "channelId": "UCWRONG"}
        if mode == "missing-item-thumbnail" and page == 2:
            rows[0]["item"].pop("thumbnailUrl")
        if mode == "wrong-item-thumbnail" and page == 2:
            rows[0]["item"]["thumbnailUrl"] = "https://i.ytimg.com/vi/other-video/hqdefault.jpg"
        if mode == "legacy-missing-thumbnail" and page == 2:
            rows[0]["video"].pop("thumbnailUrl")
        if mode == "legacy-wrong-thumbnail" and page == 2:
            rows[0]["video"]["thumbnailUrl"] = "https://i.ytimg.com/vi/other-video/hqdefault.jpg"
        if mode == "legacy-different-thumbnail" and page == 2:
            rows[0]["video"]["thumbnailUrl"] = "https://i.ytimg.com/vi/video-21/default.jpg"
        if mode == "legacy-alias-thumbnail" and page == 2:
            rows[0]["video"]["videoThumbnailUrl"] = rows[0]["video"].pop("thumbnailUrl")
        if mode == "source-video-null" and page == 2:
            rows[0]["video"] = None
        if mode == "source-video-scalar" and page == 2:
            rows[0]["video"] = "not-an-object"
        if mode == "item-only":
            for row in rows:
                row.pop("video")
        record_url = "https://www.youtube.com/@expected"
        if mode == "record-url":
            record_url = "https://www.youtube.com/@wrong"
        elif mode == "record-url-evil":
            record_url = "https://youtube.com.evil/@expected"
        payload = Payload({
            "found": True,
            "sourceKey": "source-key",
            "page": page,
            "pageSize": 20,
            "pageCount": page_count,
            "totalCount": total_videos,
            "totalVideoCount": total_videos,
            "totalOccurrenceCount": total_occurrences,
            "record": {
                "sourceDetailKey": "source-key",
                "channelId": "UCEXPECTED",
                "channelHandle": "/@expected" if mode != "record-handle" else "/@wrong",
                "channelUrl": record_url,
                "occurrences": rows,
            },
        })
        if mode == "item-handle" and page == 2:
            payload["record"]["occurrences"][0]["item"]["channelHandle"] = "/@wrong"
        payload_refs.append(weakref.ref(payload))
        return 200, len(blob), payload
    raise AssertionError(path)
module.fetch_json = fetch_json
def run_case(next_mode):
    global mode, active, peak_active
    mode = next_mode
    calls.clear()
    payload_refs.clear()
    active = 0
    peak_active = 0
    sys.argv = [
        "audit", "--base-url", "http://candidate", "--skip-rankings",
        "--negative-query", "", "--expected-active", "active",
        "--max-pages", "4", "--concurrency", "4",
        "--channel-probe", "@expected=UCEXPECTED",
        "--source-probe", "source-key,UCEXPECTED,54,49",
    ]
    if next_mode == "handle-ambiguity":
        sys.argv.extend(["--channel-probe", "@different=UCEXPECTED"])
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        try:
            result = module.main()
        except RuntimeError as error:
            return stream.getvalue(), error
    return stream.getvalue(), result
stream, result = run_case("success")
assert result == 0
assert calls[0] == 1 and calls.count(1) == 1
assert 1 < peak_active <= 4
summary_line = next(line for line in stream.splitlines() if line.startswith("IDENTITY_AUDIT_SUMMARY "))
summary = json.loads(summary_line.split(" ", 1)[1])
assert summary["sourceProbeCoverage"] == {"source-key": {"pages": 3, "videos": 49, "occurrences": 54}}
assert summary["maxInFlight"] == 2
assert stream.index("AUDIT_SOURCE_PAGE source=source-key page=1/3") < stream.index("AUDIT_SOURCE_PAGE source=source-key page=2/3")
gc.collect()
assert all(reference() is None for reference in payload_refs)
for compatible_mode in ("item-only", "legacy-alias-thumbnail"):
    stream, result = run_case(compatible_mode)
    assert result == 0, compatible_mode
for bad_mode, expected in (
    ("request-failure", "fixture source request failure"),
    ("total-drift", "source occurrence total changed during audit"),
    ("page-count-drift", "source pageCount inconsistent"),
    ("missing-page", "source video page coverage mismatch"),
    ("duplicate-video", "duplicate source video during audit"),
    ("duplicate-occurrence", "duplicate source occurrence during audit"),
    ("wrong-channel", "source occurrence item channel mismatch"),
    ("missing-item-thumbnail", "source occurrence missing item thumbnail"),
    ("wrong-item-thumbnail", "source occurrence item thumbnail videoId mismatch"),
    ("legacy-missing-thumbnail", "source occurrence missing video thumbnail"),
    ("legacy-wrong-thumbnail", "source occurrence video thumbnail videoId mismatch"),
    ("legacy-different-thumbnail", "source occurrence item/video thumbnail mismatch"),
    ("source-video-null", "source occurrence invalid video schema"),
    ("source-video-scalar", "source occurrence invalid video schema"),
    ("record-handle", "source record handle mismatch"),
    ("item-handle", "source occurrence item handle mismatch"),
    ("record-url", "source record channelUrl mismatch"),
    ("record-url-evil", "source record channelUrl mismatch"),
    ("handle-ambiguity", "ambiguous expected handle for channel"),
):
    stream, error = run_case(bad_mode)
    assert expected in str(error), (bad_mode, str(error))
    assert "IDENTITY_AUDIT_SUMMARY" not in stream
    if bad_mode == "request-failure":
        assert "AUDIT_SOURCE_PAGE_ERROR source=source-key page=2" in stream
print("OK")
`);
  assert.equal(output, "OK");
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

test("channel source details bind item and compatibility video to one immutable tuple", () => {
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
occurrence = source["record"]["occurrences"][0]
assert occurrence["videoId"] == "eKx6coop-bo"
assert occurrence["item"] == occurrence["video"]
assert occurrence["item"]["videoId"] == occurrence["videoId"]
assert occurrence["item"]["channelId"] == channel_id
assert occurrence["item"]["thumbnailUrl"] == "https://i.ytimg.com/vi/eKx6coop-bo/hqdefault.jpg"
assert occurrence["song"]["seconds"] is None
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
            self.description = [("revision_id",), ("range_id",), ("payload_json",)]
            self.rows = [("rev", "all", json.dumps({
                "sourceDetailKey": "src-noa",
                "channelName": "Noa",
                "occurrences": [{"videoId": "legacy-preview", "thumbnailUrl": "legacy.jpg"}],
                "songs": ["Song A", "Song B", "Song C"],
            }))]
        elif "source_occurrence_count" in sql:
            self.description = [("total_occurrence_count",), ("total_video_count",), ("source_occurrence_count",)]
            self.rows = [(3, 3, 3)]
        elif "GROUP BY video_id" in sql:
            self.description = [("video_id",), ("first_position",)]
            self.rows = [("video-c", 2)]
        elif "runtime_source_occurrences" in sql:
            self.description = [(name,) for name in ("position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "search_text", "payload_json")]
            self.rows = [
                (2, "video-c", "C", "Noa", "channel", "@noa", "https://youtube.com/@noa", 3, 60, "c noa", json.dumps({"thumbnailUrl": "c.jpg"})),
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

test("source replacement query normalization matches the published searchScope contract", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
song = module._query_options({"q": "naretan", "searchFields": "title,artist"})
assert song["searchScope"] == "song" and song["searchFields"] == ["title", "artist"]
assert module.rankings_payload_from_records([], {
    "range": "all", "view": "songs", "q": "naretan",
    "searchFields": "title,artist", "pageSize": "5",
})["searchScope"] == "song"
mixed = module._query_options({"q": "naretan", "searchFields": "title,channel"})
assert mixed["searchScope"] == "source" and mixed["searchFields"] == ["title", "channel"]
explicit = module._query_options({"q": "naretan", "searchScope": "channel",
    "searchFields": "title,artist"})
assert explicit["searchScope"] == "channel"
assert module._query_options({"searchScope": "songs"})["searchScope"] == "song"
for query in ({"searchScope": "wrong"}, {"searchFields": "title,wrong"}):
    try:
        module._query_options(query)
        raise AssertionError("invalid search contract was accepted")
    except ValueError:
        pass
print("OK")
`);
  assert.equal(output, "OK");
});

test("source replacement pager keeps Haru counts variants range and literal search bounded", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
haru_key = "01fc9d6830d3c230"
small_key = "969a36392237f00d"
artists = [{"name": name, "count": count} for name, count in (
    ("ヨルシカ", 4600), ("Yorushika", 40), ("suis", 30),
    ("n-buna", 20), ("ヨルシカ feat.suis", 7),
)]
def physical(video_id, position):
    return {"position": position, "video_id": video_id, "title": "Haru cover",
        "channel_name": "Singer", "channel_id": "UC" + video_id,
        "channel_handle": "@" + video_id, "channel_url": "https://youtube.com/@" + video_id,
        "published_timestamp": position, "seconds": 30 + position,
        "search_text": "haru singer " + video_id,
        "payload_json": {"thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
            "item": {"videoId": video_id},
            "song": {"title": "晴る", "artist": "ヨルシカ"}}}
def rows(_connection, sql, params):
    params = list(params)
    calls.append((sql, params))
    if "FROM runtime_source_details" in sql:
        key, range_id = params[1], params[2]
        assert params[0] == ["overlay-new", "parent"]
        return [{"revision_id": "parent", "range_id": range_id, "payload_json": {
            "type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
            "artist": "ヨルシカ", "displayArtist": "ヨルシカ", "artists": artists,
            "sourceDetailKey": key, "rangeId": range_id,
            "occurrences": [{"videoId": "legacy-preview"}],
        }}]
    if "source_occurrence_count" in sql:
        key, range_id = params[1], params[2]
        assert params[4] == key and params[5] == range_id
        if "ILIKE" in sql:
            slash = chr(92)
            assert params[-1] == "%100" + slash + "%" + slash + "_mix" + slash + slash + "x%", params
            return [{"total_occurrence_count": 0, "total_video_count": 0,
                "source_occurrence_count": 4697}]
        if key == haru_key:
            return [{"total_occurrence_count": 4697, "total_video_count": 4485,
                "source_occurrence_count": 4697}]
        assert key == small_key and range_id == "7d"
        return [{"total_occurrence_count": 17, "total_video_count": 17,
            "source_occurrence_count": 17}]
    if "GROUP BY video_id" in sql:
        if "ILIKE" in sql:
            return []
        if params[1] == haru_key:
            if params[-2] == 20:
                return [{"video_id": "haru-%02d" % index, "first_position": index}
                    for index in range(20)]
            return [{"video_id": "haru-c", "first_position": 2},
                {"video_id": "haru-d", "first_position": 3}]
        return [{"video_id": "small-a", "first_position": 0}]
    if "SELECT position, video_id" in sql:
        selected = list(params[-2])
        result = [physical(video_id, index + 2) for index, video_id in enumerate(selected)]
        if len(selected) == 20:
            result.append(physical(selected[0], 100))
        return result
    raise AssertionError(sql)
module._rows = rows

page = module._runtime_source_payload(
    object(), "parent", haru_key, {"range": "all", "page": "2", "pageSize": "2"},
    overlay_revision_ids=["overlay-new"],
)
assert page["found"] is True and page["sourceRevisionId"] == "parent"
assert page["sourceKey"] == haru_key and page["record"]["sourceDetailKey"] == haru_key
assert page["record"]["key"] == "晴る::ヨルシカ" and page["record"]["artists"] == artists
assert page["pageCount"] == 2243 and page["totalCount"] == 4485
assert page["totalOccurrenceCount"] == page["record"]["occurrenceCount"] == 4697
assert [item["videoId"] for item in page["record"]["occurrences"]] == ["haru-c", "haru-d"]

page20 = module._runtime_source_payload(
    object(), "parent", haru_key, {"range": "all", "page": "1", "pageSize": "20"},
    overlay_revision_ids=["overlay-new"],
)
page20_occurrences = page20["record"]["occurrences"]
assert page20["pageCount"] == 225 and page20["totalVideoCount"] == 4485
assert len({item["videoId"] for item in page20_occurrences}) == 20
assert len(page20_occurrences) == 21
assert sum(item["videoId"] == "haru-00" for item in page20_occurrences) == 2

query_q = "100%_mix" + chr(92) + "x"
empty_search = module._runtime_source_payload(
    object(), "parent", haru_key,
    {"range": "all", "q": query_q, "page": "1", "pageSize": "2"},
    overlay_revision_ids=["overlay-new"],
)
assert empty_search["found"] is True and empty_search["totalOccurrenceCount"] == 0
assert empty_search["record"]["occurrences"] == []

small = module._runtime_source_payload(
    object(), "parent", small_key, {"range": "7d", "page": "1", "pageSize": "1"},
    overlay_revision_ids=["overlay-new"],
)
assert small["found"] is True and small["totalOccurrenceCount"] == 17
assert small["pageCount"] == 17 and small["record"]["rangeId"] == "7d"
assert all("runtime_occurrences" not in sql for sql, _ in calls)
physical_sql = "\\n".join(sql for sql, _ in calls if "runtime_source_occurrences" in sql)
for forbidden in ("occurrence_id", "song_key", " artist,"):
    assert forbidden not in physical_sql, forbidden
assert "search_text ILIKE %s" in physical_sql and "LIMIT %s" in physical_sql

class OverflowRows:
    def __len__(self):
        return module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
def overflow_rows(_connection, sql, params):
    if "source_occurrence_count" in sql:
        return [{"total_occurrence_count": 1, "total_video_count": 1,
            "source_occurrence_count": 1}]
    if "GROUP BY video_id" in sql:
        return [{"video_id": "overflow", "first_position": 0}]
    if "SELECT position, video_id" in sql:
        assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        return OverflowRows()
    raise AssertionError(sql)
module._rows = overflow_rows
try:
    module._runtime_source_table_page(
        object(), "parent", haru_key, {"range": "all", "page": "1", "pageSize": "1"},
    )
    raise AssertionError("source hydration cap was not enforced")
except module.PostgresAdapterError:
    pass
print("OK")
`);
  assert.equal(output, "OK");
});

test("source replacement nearest detail distinguishes absence inheritance from explicit empty authority", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
try:
    module.source_payload(object(), "  ", {"range": "all"})
    raise AssertionError("empty source key was not rejected")
except ValueError as error:
    assert str(error) == "source key is required"
mode = ["empty"]
calls = []
def rows(_connection, sql, params):
    calls.append((sql, list(params)))
    if "FROM runtime_source_details" in sql:
        revision = "overlay" if mode[0] in {"empty", "shrink"} else "parent"
        if mode[0] == "truncated":
            revision = "overlay"
            return [{"revision_id": revision, "range_id": "all", "payload_json": {
                "type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
                "artist": "ヨルシカ", "sourceDetailKey": "source", "rangeId": "all",
                "occurrences": [{"videoId": "preview-a"}, {"videoId": "preview-b"},
                    {"videoId": "preview-c"}],
                "count": 4697, "occurrenceCount": 4697, "videoCount": 4485,
                "occurrencePreviewLimited": True,
            }}]
        return [{"revision_id": revision, "range_id": "all", "payload_json": {
            "type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
            "artist": "ヨルシカ", "artists": [{"name": "ヨルシカ", "count": 1 if mode[0] == "shrink" else 0}],
            "sourceDetailKey": "source", "rangeId": "all", "occurrences": [],
            "count": 1 if mode[0] == "shrink" else 0,
            "occurrenceCount": 1 if mode[0] == "shrink" else 0,
            "videoCount": 1 if mode[0] == "shrink" else 0,
        }}]
    if "source_occurrence_count" in sql:
        if mode[0] in {"empty", "truncated"}:
            assert params[0] == "overlay" and params[3] == "overlay"
            return [{"total_occurrence_count": 0, "total_video_count": 0,
                "source_occurrence_count": 0}]
        if mode[0] == "shrink":
            assert params[0] == "overlay" and params[3] == "overlay"
            return [{"total_occurrence_count": 1, "total_video_count": 1,
                "source_occurrence_count": 1}]
        assert params[0] == "parent" and params[3] == "parent"
        return [{"total_occurrence_count": 1, "total_video_count": 1,
            "source_occurrence_count": 1}]
    if "GROUP BY video_id" in sql:
        return [{"video_id": "overlay-video" if mode[0] == "shrink" else "parent-video",
            "first_position": 0}]
    if "SELECT position, video_id" in sql:
        video_id = "overlay-video" if mode[0] == "shrink" else "parent-video"
        return [{"position": 0, "video_id": video_id, "title": "Detail",
            "channel_name": "Detail", "channel_id": "UCDETAIL", "channel_handle": "@detail",
            "channel_url": "https://youtube.com/@detail", "published_timestamp": 1,
            "seconds": 2, "search_text": "detail", "payload_json": {"videoId": video_id}}]
    raise AssertionError(sql)
module._rows = rows
empty = module._runtime_source_payload(
    object(), "parent", "source", {"range": "all"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
assert empty["found"] is True and empty["sourceRevisionId"] == "overlay"
assert empty["record"]["occurrenceCount"] == 0 and empty["record"]["occurrences"] == []

mode[0] = "truncated"
try:
    module._runtime_source_payload(
        object(), "parent", "source", {"range": "all"},
        allow_derived=False, overlay_revision_ids=["overlay"],
    )
    raise AssertionError("preview-only authoritative source was accepted as a complete page")
except module.PostgresAdapterError as error:
    assert "physical occurrence rows" in str(error)

mode[0] = "inherit"
inherited = module._runtime_source_payload(
    object(), "parent", "source", {"range": "all", "page": "1", "pageSize": "1"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
assert inherited["found"] is True and inherited["sourceRevisionId"] == "parent"
assert inherited["record"]["occurrences"][0]["videoId"] == "parent-video"

mode[0] = "shrink"
shrunk = module._runtime_source_payload(
    object(), "parent", "source", {"range": "all", "page": "1", "pageSize": "20"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
assert shrunk["found"] is True and shrunk["sourceRevisionId"] == "overlay"
assert shrunk["totalOccurrenceCount"] == shrunk["totalVideoCount"] == 1
assert shrunk["record"]["occurrences"][0]["videoId"] == "overlay-video"

# Once a nearest overlay detail exists, top-level source routing must not
# invoke parent delta or channel reconstruction and revive older positions.
module._generic_runtime_projection_revision = lambda *_: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["overlay"]
module._runtime_source_payload = lambda *_args, **_kwargs: empty
def forbidden(*_args, **_kwargs):
    raise AssertionError("authoritative overlay detail was rebuilt")
module._generic_song_source_payload = forbidden
module._runtime_channel_source_payload = forbidden
assert module.source_payload(object(), "source", {"range": "all"}) == empty
module._runtime_source_payload = lambda *_args, **_kwargs: shrunk
assert module.source_payload(object(), "source", {"range": "all"}) == shrunk
module._runtime_source_payload = lambda *_args, **_kwargs: empty

captured = []
marker = {"schemaVersion": 1, "found": True, "sourceKey": "source",
    "record": {"sourceDetailKey": "source", "occurrenceCount": 1}}
module._overlay_revision_ids = lambda *_: ["newer", "overlay"]
def apply_newer(_connection, base_revision, _record, _key, _query, revision_ids):
    captured.append((base_revision, list(revision_ids)))
    return marker
module._generic_song_source_payload = apply_newer
assert module.source_payload(object(), "source", {"range": "all"}) == marker
assert captured == [("overlay", ["newer"])]

# Re-import to exercise the real fail-closed helper after the routing sentinel.
spec2 = importlib.util.spec_from_file_location("pg_adapter_identity", ${JSON.stringify(ADAPTER)})
module2 = importlib.util.module_from_spec(spec2)
sys.modules[spec2.name] = module2
spec2.loader.exec_module(module2)
blocked = module2._generic_song_source_payload(
    object(), "parent",
    {"type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
        "displayArtist": "ヨルシカ", "sourceDetailKey": "source"},
    "source", {"range": "all"}, ["overlay"], [], {}, [],
)
assert blocked["found"] is False and blocked["sourceDetailState"] == "missing_exact_song_identity"
print("OK")
`);
  assert.equal(output, "OK");
});

test("source replacement rejects a zero-count preview-only detail without physical rows", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def rows(_connection, sql, params):
    if "FROM runtime_source_details" in sql:
        assert list(params)[0] == ["overlay", "parent"]
        return [{"revision_id": "overlay", "range_id": "all", "payload_json": {
            "type": "song", "key": "Song::Artist", "title": "Song",
            "artist": "Artist", "sourceDetailKey": "opaque", "rangeId": "all",
            "occurrences": [], "count": 0, "occurrenceCount": 0, "videoCount": 0,
            "occurrencePreviewLimited": True,
        }}]
    if "source_occurrence_count" in sql:
        assert list(params)[:4] == ["overlay", "opaque", "all", "overlay"]
        return [{"total_occurrence_count": 0, "total_video_count": 0,
            "source_occurrence_count": 0}]
    raise AssertionError(sql)

module._rows = rows
try:
    module._runtime_source_payload(
        object(), "parent", "opaque", {"range": "all", "page": "1", "pageSize": "20"},
        allow_derived=False, overlay_revision_ids=["overlay"],
    )
    raise AssertionError("zero-count preview-only detail did not fail closed")
except module.PostgresAdapterError as error:
    assert "physical occurrence rows" in str(error)
print("OK")
`);
  assert.equal(output, "OK");
});

test("source replacement complete embedded fallback pages unique videos and hydrates siblings", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

occurrences = [
    {"videoId": "video-00", "occurrenceId": "video-00-a"},
    {"videoId": "video-00", "occurrenceId": "video-00-b"},
]
occurrences.extend(
    {"videoId": "video-%02d" % index, "occurrenceId": "video-%02d-a" % index}
    for index in range(1, 21)
)

def rows(_connection, sql, params):
    if "FROM runtime_source_details" in sql:
        return [{"revision_id": "overlay", "range_id": "all", "payload_json": {
            "type": "song", "key": "Song::Artist", "title": "Song",
            "artist": "Artist", "sourceDetailKey": "opaque", "rangeId": "all",
            "occurrences": occurrences, "count": 22, "occurrenceCount": 22,
            "videoCount": 21, "occurrencePreviewLimited": False,
        }}]
    if "source_occurrence_count" in sql:
        return [{"total_occurrence_count": 0, "total_video_count": 0,
            "source_occurrence_count": 0}]
    raise AssertionError(sql)

module._rows = rows
page_one = module._runtime_source_payload(
    object(), "parent", "opaque", {"range": "all", "page": "1", "pageSize": "20"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
page_two = module._runtime_source_payload(
    object(), "parent", "opaque", {"range": "all", "page": "2", "pageSize": "20"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
page_one_rows = page_one["record"]["occurrences"]
page_two_rows = page_two["record"]["occurrences"]
assert page_one["page"] == 1 and page_two["page"] == 2
assert page_one["pageSize"] == page_two["pageSize"] == 20
assert page_one["pageCount"] == page_two["pageCount"] == 2
assert page_one["totalCount"] == page_two["totalCount"] == 21
assert page_one["totalVideoCount"] == page_two["totalVideoCount"] == 21
assert page_one["totalOccurrenceCount"] == page_two["totalOccurrenceCount"] == 22
assert page_one["record"]["occurrenceCount"] == page_two["record"]["occurrenceCount"] == 22
assert len({item["videoId"] for item in page_one_rows}) == 20
assert len(page_one_rows) == 21
assert sum(item["videoId"] == "video-00" for item in page_one_rows) == 2
assert [item["videoId"] for item in page_two_rows] == ["video-20"]
assert page_one["record"]["occurrencePreviewLimited"] is True
assert page_two["record"]["occurrencePreviewLimited"] is True

unpaged = module._runtime_source_payload(
    object(), "parent", "opaque", {"range": "all"},
    allow_derived=False, overlay_revision_ids=["overlay"],
)
assert "page" not in unpaged and len(unpaged["record"]["occurrences"]) == 22
assert unpaged["record"]["occurrencePreviewLimited"] is False
print("OK")
`);
  assert.equal(output, "OK");
});

test("source routing keeps the authoritative Haru card across the synthetic 23 394 5 generic delta", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
source_key = "01fc9d6830d3c230"
def source_row(video_id, occurrence_id, position):
    return {"position": position, "video_id": video_id, "title": "Haru cover",
        "channel_name": "Singer", "channel_id": "UC" + video_id,
        "channel_handle": "@" + video_id, "channel_url": "https://youtube.com/@" + video_id,
        "published_timestamp": position, "seconds": position,
        "search_text": "晴る ヨルシカ " + video_id,
        "payload_json": {"video": {"videoId": video_id, "channelId": "UC" + video_id,
            "channelName": "Singer", "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"},
            "occurrenceId": occurrence_id, "position": position, "rangeId": "all",
            "songKey": "db-haru", "title": "晴る", "artist": "ヨルシカ"}}
affected = []
for position in range(394):
    video_id = "affected-%02d" % (position % 23)
    affected.append(source_row(video_id, "old-%03d" % position, position))
def candidate(video_index):
    video_id = "affected-%02d" % video_index
    occurrence_id = "accepted-%02d" % video_index
    return {"revision_id": "accepted", "video_id": video_id,
        "occurrence_id": occurrence_id, "position": video_index, "range_id": "all",
        "song_key": "db-haru", "title": "晴る", "artist": "ヨルシカ",
        "video_tombstone": False,
        "video_payload_json": {"videoId": video_id, "channelId": "UC" + video_id,
            "channelName": "Singer", "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"},
        "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id,
            "position": video_index, "rangeId": "all", "songKey": "db-haru",
            "title": "晴る", "artist": "ヨルシカ"}}
candidates = [candidate(index) for index in range(20)]
resets = {"affected-%02d" % index: {"video_id": "affected-%02d" % index,
    "payload_json": {"rangeId": "all"}}
    for index in range(23)}
changes = [{"entityType": "occurrences", "videoId": "affected-%02d" % index,
    "occurrenceId": "accepted-%02d" % index, "songKey": "db-haru",
    "title": "晴る", "artist": "ヨルシカ", "rangeId": "all"}
    for index in range(4)]
changes.append({"entityType": "occurrences", "videoId": "affected-04",
    "occurrenceId": "accepted-04", "songKey": "db-haru", "title": "晴る",
    "artist": "ヨルシカ", "rangeId": "all", "replacement": True,
    "replacementPayload": {"videoId": "affected-04", "occurrenceId": "accepted-04",
        "songKey": "other", "title": "Other", "artist": "Other", "rangeId": "all"},
    "replacementVideoPayload": candidates[4]["video_payload_json"]})
calls = []
def rows(_connection, sql, params):
    params = list(params)
    calls.append((sql, params))
    if "WITH overlay_videos" in sql:
        assert len(params[0]) == 15 and len(params[5]) == 23
        return [{"video_id": "affected-05", "first_position": 5},
            {"video_id": "unaffected", "first_position": 500}]
    if "count(*) AS total_occurrence_count" in sql:
        assert params[:3] == ["parent", source_key, "all"]
        return [{"total_occurrence_count": 4697, "total_video_count": 4485,
            "max_position": 4696}]
    if "FROM runtime_source_occurrences" in sql and "video_id = ANY" in sql:
        requested = set(params[-2])
        assert params[0:3] == ["parent", source_key, "all"]
        assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        if "unaffected" in requested:
            return [source_row("unaffected", "unaffected-occ", 500)]
        assert requested == set(resets)
        return list(affected)
    raise AssertionError(sql)
module._rows = rows
persisted = {"type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
    "artist": "ヨルシカ", "displayArtist": "ヨルシカ",
    "artists": [{"name": "ヨルシカ", "count": 4697}],
    "sourceDetailKey": source_key, "rangeId": "all", "songCount": 1}
payload = module._generic_song_source_payload(
    object(), "parent", persisted, source_key,
    {"range": "all", "page": "1", "pageSize": "2"}, ["accepted", "runtime"],
    candidates, resets, changes,
)
assert payload["found"] is True
assert payload["totalOccurrenceCount"] == payload["record"]["occurrenceCount"] == 4318
assert payload["totalVideoCount"] == payload["record"]["videoCount"] == 4477
assert payload["record"]["artists"] == [{"name": "ヨルシカ", "count": 4318}]
assert payload["pageCount"] == 2239
assert [item["videoId"] for item in payload["record"]["occurrences"]] == ["affected-05", "unaffected"]
assert not any(item["videoId"] in {"affected-00", "affected-01", "affected-02", "affected-03", "affected-04"}
    for item in payload["record"]["occurrences"])
assert all("runtime_occurrences" not in sql for sql, _ in calls)
assert len(affected) == 394 and len(resets) == 23 and len(changes) == 5

# The helper result above remains correct for a same-range source delta.  The
# production-shaped intersection has 23 reset videos and 394 candidate rows,
# but every one is 7d; the all-range source must retain its authoritative
# 4697/4485 card and bounded, unique-video page.
page_occurrences = [{"videoId": "haru-%02d" % index,
    "occurrenceId": "haru-occ-%02d" % index} for index in range(20)]
authoritative = {"schemaVersion": 1, "found": True, "sourceKey": source_key,
    "sourceRevisionId": "parent", "record": {
        "type": "song", "key": "晴る::ヨルシカ", "title": "晴る",
        "artist": "ヨルシカ", "displayArtist": "ヨルシカ",
        "artists": [{"name": "ヨルシカ", "count": 4697}],
        "sourceDetailKey": source_key, "rangeId": "all",
        "count": 4697, "occurrenceCount": 4697, "videoCount": 4485,
        "occurrences": page_occurrences, "occurrencePreviewLimited": True,
    }, "page": 1, "pageSize": 20, "pageCount": 225,
    "totalCount": 4485, "totalVideoCount": 4485,
    "totalOccurrenceCount": 4697, "totalSongCount": 5}
module._runtime_projection_revision = lambda *_: None
module._generic_runtime_projection_revision = lambda *_: ("active", {"revision_id": "active"})
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["runtime", "accepted"]
module._runtime_source_payload = lambda *_args, **_kwargs: authoritative
cross_range_candidates = []
for index in range(394):
    row = candidate(index % 23)
    row["occurrence_id"] = "cross-%03d" % index
    row["range_id"] = "7d"
    row["occurrence_payload_json"] = {
        **row["occurrence_payload_json"],
        "occurrenceId": row["occurrence_id"], "rangeId": "7d",
    }
    cross_range_candidates.append(row)
cross_range_resets = {
    "affected-%02d" % index: {
        "video_id": "affected-%02d" % index,
        "payload_json": {"rangeId": "7d"},
    }
    for index in range(23)
}
cross_range_changes = [{**change, "rangeId": "7d"} for change in changes]
module._overlay_candidate_rows = lambda *_args, **_kwargs: cross_range_candidates
module._accepted_video_resets = lambda *_args, **_kwargs: cross_range_resets
module._runtime_tombstones = lambda *_args, **_kwargs: cross_range_changes
module._runtime_channel_source_payload = lambda *_args, **_kwargs: (
    (_ for _ in ()).throw(AssertionError("song source fell through to channel reconstruction"))
)
result = module.source_payload(
    object(), source_key, {"range": "all", "page": "1", "pageSize": "20"},
)
assert result == authoritative
assert result["record"]["count"] == result["totalOccurrenceCount"] == 4697
assert result["record"]["videoCount"] == result["totalCount"] == 4485
assert result["pageCount"] == 225 and len(result["record"]["occurrences"]) == 20
assert len({item["videoId"] for item in result["record"]["occurrences"]}) == 20

# A video row with neither a same-range occurrence nor an explicit range has
# no authority to reset either public source range.
module._overlay_candidate_rows = lambda *_args, **_kwargs: []
module._accepted_video_resets = lambda *_args, **_kwargs: {
    "ambiguous-video": {"video_id": "ambiguous-video", "payload_json": {}},
}
module._runtime_tombstones = lambda *_args, **_kwargs: []
assert module.source_payload(
    object(), source_key, {"range": "all", "page": "1", "pageSize": "20"},
) == authoritative

# The range boundary is symmetric: an all-range overlay cannot reset a 7d
# persisted song source either.
authoritative_7d = {**authoritative,
    "record": {**authoritative["record"], "rangeId": "7d",
        "count": 17, "occurrenceCount": 17, "videoCount": 17,
        "occurrences": page_occurrences[:17]},
    "pageCount": 1, "totalCount": 17, "totalVideoCount": 17,
    "totalOccurrenceCount": 17}
module._runtime_source_payload = lambda *_args, **_kwargs: authoritative_7d
module._overlay_candidate_rows = lambda *_args, **_kwargs: candidates
module._accepted_video_resets = lambda *_args, **_kwargs: {
    key: {**value, "payload_json": {"rangeId": "all"}}
    for key, value in resets.items()
}
module._runtime_tombstones = lambda *_args, **_kwargs: changes
result_7d = module.source_payload(
    object(), source_key, {"range": "7d", "page": "1", "pageSize": "20"},
)
assert result_7d == authoritative_7d
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
        if "FROM runtime_source_occurrences" in sql:
            self.description = [("position",)]
            self.rows = []
        elif "FROM runtime_videos" in sql:
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

test("generic source detail keeps persisted base rows when parent channel scalars are stale", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)

channel_id = "UC8VlcljjGFb4-Ny2Heb0-ew"
channel_handle = "/@urameshi_conta"
source_key = module._stable_key("source-vtuber", "all", channel_id)
metadata = {
    "type": "vtuber",
    "sourceDetailKey": source_key,
    "channelId": channel_id,
    "channelHandle": channel_handle,
    "channelName": "Conta Urameshi",
}

def video(video_id):
    return {
        "videoId": video_id,
        "channelId": channel_id,
        "channelHandle": channel_handle,
        "channelName": "Conta Urameshi",
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }

base_occurrences = []
for index in range(214):
    video_id = f"base-{index % 17:03d}"
    occurrence = {
        "videoId": video_id,
        "occurrenceId": f"base-occurrence-{index}",
        "position": index // 272,
        "rangeId": "all",
        "songKey": f"base-song-{index}",
        "seconds": index,
        "title": f"Base song {index}",
        "artist": "Base artist",
    }
    base_occurrences.append({
        "videoId": video_id,
        "channelId": "UCPOLLUTED-SCALAR",
        "channelHandle": "/@polluted-scalar",
        "item": video(video_id),
        "song": {**occurrence, "song": occurrence, "video": video(video_id)},
    })

overlay_records = {}
for index in range(3705):
    video_id = f"overlay-{index % 272:03d}"
    record = overlay_records.setdefault(
        video_id,
        {"video": video(video_id), "occurrences": []},
    )
    record["occurrences"].append({
        "occurrenceId": f"overlay-occurrence-{index}",
        "position": index // 272,
        "rangeId": "7d",
        "songKey": f"overlay-song-{index}",
        "seconds": 10000 + index,
        "title": f"Overlay song {index}",
        "artist": "Overlay artist",
    })
overlay_records = [
    {"video": record["video"], "occurrences": tuple(record["occurrences"])}
    for record in overlay_records.values()
]

# The historical scalar channel lookup is empty.  The parent all-source rows
# remain authoritative, while accepted physical 7d rows are exposed through
# this channel's compatible all-source endpoint.
module._rows = lambda connection, sql, params: []
module._runtime_source_occurrences = lambda *args: base_occurrences
module._overlay_candidate_rows = lambda *args, **kwargs: [{"video_id": "overlay-marker"}]
module._accepted_video_resets = lambda *args, **kwargs: {}
module._overlay_channel_records = lambda *args, **kwargs: overlay_records
module._runtime_tombstones = lambda *args, **kwargs: []

page_one = module._runtime_channel_source_payload(
    object(), "parent", metadata, source_key,
    {"page": "1", "pageSize": "200"}, overlay_revision_ids=["accepted"],
)
page_two = module._runtime_channel_source_payload(
    object(), "parent", metadata, source_key,
    {"page": "2", "pageSize": "200"}, overlay_revision_ids=["accepted"],
)
for payload in (page_one, page_two):
    assert payload["found"] is True
    assert payload["sourceKey"] == source_key
    assert payload["totalOccurrenceCount"] == 3919
    assert payload["totalVideoCount"] == 289
    assert payload["record"]["count"] == 3919
    assert payload["record"]["videoCount"] == 289
    assert all(
        item["item"]["channelId"] == channel_id
        and item["item"]["channelHandle"] == channel_handle
        and item["videoId"] == item["item"]["videoId"]
        for item in payload["record"]["occurrences"]
    )
assert page_one["pageCount"] == 2 and page_two["pageCount"] == 2
assert (
    len(page_one["record"]["occurrences"])
    + len(page_two["record"]["occurrences"])
) == 3919
assert {
    item["videoId"]
    for item in (
        page_one["record"]["occurrences"]
        + page_two["record"]["occurrences"]
    )
} == {
    *(f"base-{index:03d}" for index in range(17)),
    *(f"overlay-{index:03d}" for index in range(272)),
}

# Ordinary runtime 7d rows retain their physical range and never leak into an
# all-source query; only accepted channel records receive the local projection.
runtime_7d = {
    "videoId": "runtime-7d",
    "item": video("runtime-7d"),
    "song": {
        "videoId": "runtime-7d",
        "occurrenceId": "runtime-7d-occurrence",
        "position": 0,
        "rangeId": "7d",
        "songKey": "runtime-7d-song",
        "title": "Runtime 7d",
        "artist": "Runtime artist",
    },
}
ordinary = module._source_payload_from_channel_records(
    module._persisted_source_records([base_occurrences[0], runtime_7d], metadata),
    metadata,
    source_key,
    {"page": "1", "pageSize": "20"},
)
assert ordinary["totalOccurrenceCount"] == 1
assert ordinary["record"]["occurrences"][0]["videoId"].startswith("base-")

# Neither a canonical-looking URL nor a matching polluted scalar identity may
# complete a partial nested video tuple.
assert module._persisted_source_records([{
    "videoId": "partial",
    "channelId": channel_id,
    "channelHandle": channel_handle,
    "channelUrl": f"https://www.youtube.com/channel/{channel_id}",
    "item": {
        "videoId": "partial",
        "channelUrl": f"https://www.youtube.com/channel/{channel_id}",
    },
    "song": {"occurrenceId": "partial-occurrence", "title": "Bad", "artist": "Bad"},
}], metadata) == []

# A full-video reset is authoritative for a persisted source row with the same
# video identity, and a later tombstone must not revive the old occurrences.
reset_video = video("reset-video")
reset_base = [
    {
        "videoId": "reset-video",
        "item": reset_video,
        "song": {
            "videoId": "reset-video",
            "occurrenceId": f"old-{index}",
            "position": index,
            "rangeId": "all",
            "songKey": f"old-song-{index}",
            "title": f"Old {index}",
            "artist": "Old artist",
        },
    }
    for index in range(2)
]
reset_overlay = [{
    "video": reset_video,
    "occurrences": ({
        "occurrenceId": "replacement",
        "position": 0,
        "rangeId": "all",
        "songKey": "replacement-song",
        "title": "Replacement",
        "artist": "New artist",
    },),
}]
module._runtime_source_occurrences = lambda *args: reset_base
module._accepted_video_resets = lambda *args, **kwargs: {"reset-video": {"video_id": "reset-video"}}
module._overlay_channel_records = lambda *args, **kwargs: reset_overlay
module._runtime_tombstones = lambda *args, **kwargs: []
reset_result = module._runtime_channel_source_payload(
    object(), "parent", metadata, source_key,
    {"page": "1", "pageSize": "20"}, overlay_revision_ids=["accepted"],
)
assert reset_result["totalOccurrenceCount"] == 1
assert [
    item["song"]["occurrenceId"]
    for item in reset_result["record"]["occurrences"]
] == ["replacement"]
module._runtime_tombstones = lambda *args, **kwargs: [{
    "entityType": "occurrences",
    "videoId": "reset-video",
    "occurrenceId": "replacement",
    "replacement": False,
}]
tombstoned = module._runtime_channel_source_payload(
    object(), "parent", metadata, source_key,
    {"page": "1", "pageSize": "20"}, overlay_revision_ids=["accepted"],
)
assert tombstoned["found"] is False
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

test("incremental VTuber rankings retain their exact merged song count", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module._generic_parent_runtime_revision = lambda connection, revision_id, revision: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda connection, revision_id, parent_id: ["candidate"]
module._overlay_candidate_rows = lambda *args: []
grouper_calls = []
module._overlay_candidate_groups = lambda rows, view: grouper_calls.append(view) or {}
module._runtime_tombstones = lambda *args: []
module._channel_metadata_rows = lambda connection, revision_ids: []
thumbnail = "https://i.ytimg.com/vi/video-channel/hqdefault.jpg"
preview = {"videoId": "video-channel", "occurrenceId": "occ-channel",
  "position": 0, "rangeId": "all", "songKey": "song-channel",
  "seconds": 12, "title": "Song", "artist": "Artist",
  "song": {"title": "Song", "artist": "Artist", "seconds": 12,
    "songKey": "song-channel", "rangeId": "all"},
  "item": {"videoId": "video-channel", "channelId": "channel",
    "channelHandle": "@channel", "thumbnailUrl": thumbnail},
  "video": {"videoId": "video-channel", "channelId": "channel",
    "channelHandle": "@channel", "thumbnailUrl": thumbnail}}
module._overlay_vtuber_replacement_rows = lambda *args: {"channel": {"detail_key": "channel", "title": "", "artist": "", "name": "Channel", "row_count": 8, "song_count": 9, "video_count": 1, "timestamp_count": 8, "payload_json": {"type": "vtuber", "key": "channel", "channelId": "channel", "channelHandle": "@channel", "name": "Channel", "count": 8, "songCount": 9, "videoCount": 1, "timestampCount": 8, "occurrences": [preview]}}}
module._rows = lambda connection, sql, params: [{"rank": 1, "detail_key": "channel", "title": "", "artist": "", "name": "Channel", "row_count": 8, "song_count": 7, "video_count": 1, "timestamp_count": 8, "search_text": "channel", "channel_search_text": "channel", "payload_json": {"type": "vtuber", "key": "channel", "name": "Channel", "count": 8, "songCount": 0, "videoCount": 1, "timestampCount": 8}}] if "FROM runtime_ranking_rows" in sql else []
payload = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, {"range": "all", "view": "vtubers", "metric": "occurrences", "pageSize": "20"})
assert payload["records"][0]["songCount"] == 9
assert grouper_calls == []
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
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
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
            "thumbnailUrl": thumbnail,
        },
        "occurrence_payload_json": {
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "position": position,
            "songKey": song_key,
            "seconds": 31,
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
        "published_timestamp": 1, "payload_json": {
            "videoId": "video-old", "channelId": channel_id,
            "channelHandle": "/@urameshi_conta",
            "thumbnailUrl": "https://i.ytimg.com/vi/video-old/hqdefault.jpg",
        },
    },
    {
        "video_id": "video-keep", "title": "Keep", "channel_name": "Conta Urameshi",
        "channel_id": channel_id, "channel_handle": "/@urameshi_conta",
        "channel_url": f"https://www.youtube.com/channel/{channel_id}",
        "published_timestamp": 2, "payload_json": {
            "videoId": "video-keep", "channelId": channel_id,
            "channelHandle": "/@urameshi_conta",
            "thumbnailUrl": "https://i.ytimg.com/vi/video-keep/hqdefault.jpg",
        },
    },
]
parent_occurrences = [
    {"video_id": "video-old", "occurrence_id": "old-a", "position": 0, "range_id": "all", "song_key": "song-a", "seconds": 11, "title": "song-a", "artist": "Artist", "channel_id": channel_id, "payload_json": {"videoId": "video-old", "occurrenceId": "old-a", "position": 0, "rangeId": "all", "songKey": "song-a", "seconds": 11, "title": "song-a", "artist": "Artist"}},
    {"video_id": "video-old", "occurrence_id": "old-b", "position": 1, "range_id": "all", "song_key": "song-b", "seconds": 22, "title": "song-b", "artist": "Artist", "channel_id": channel_id, "payload_json": {"videoId": "video-old", "occurrenceId": "old-b", "position": 1, "rangeId": "all", "songKey": "song-b", "seconds": 22, "title": "song-b", "artist": "Artist"}},
    {"video_id": "video-keep", "occurrence_id": "keep-c", "position": 0, "range_id": "all", "song_key": "song-c", "seconds": 33, "title": "song-c", "artist": "Artist", "channel_id": channel_id, "payload_json": {"videoId": "video-keep", "occurrenceId": "keep-c", "position": 0, "rangeId": "all", "songKey": "song-c", "seconds": 33, "title": "song-c", "artist": "Artist"}},
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
        if "o.video_id = ANY" in sql:
            return [row for row in parent_occurrences if row["video_id"] in params[2]]
        return parent_occurrences
    return []
module._rows = rows
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["candidate"]
module._overlay_candidate_rows = lambda *args: candidate_rows
module._accepted_video_resets = lambda *args: {video_id: {"video_id": video_id, "tombstone": False} for video_id in {"video-old", "video-new"}}
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
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
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
            "thumbnailUrl": thumbnail,
        },
        "occurrence_payload_json": {
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "position": position,
            "songKey": song_key,
            "seconds": 31,
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
            {"videoId": "video-old", "occurrenceId": "old", "position": 0,
              "title": "Old", "artist": "Artist", "seconds": 10,
              "song": {"title": "Old", "artist": "Artist", "seconds": 10},
              "item": {"videoId": "video-old", "channelId": channel_id,
                "channelHandle": "/@urameshi_conta",
                "channelUrl": "https://www.youtube.com/@urameshi_conta",
                "thumbnailUrl": "https://i.ytimg.com/vi/video-old/hqdefault.jpg"}},
            {"videoId": "video-keep", "occurrenceId": "keep", "position": 0,
              "title": "Keep", "artist": "Artist", "seconds": 20,
              "song": {"title": "Keep", "artist": "Artist", "seconds": 20},
              "item": {"videoId": "video-keep", "channelId": channel_id,
                "channelHandle": "/@urameshi_conta",
                "channelUrl": "https://www.youtube.com/@urameshi_conta",
                "thumbnailUrl": "https://i.ytimg.com/vi/video-keep/hqdefault.jpg"}},
        ],
    },
}
aggregate_queries = 0
def rows(connection, sql, params):
    global aggregate_queries
    if "SELECT COUNT(*) AS total_count" in sql:
        return [{
            "total_count": 1,
            "total_occurrence_count": 3,
            "total_song_count": 3,
            "total_video_count": 2,
        }]
    if "FROM runtime_ranking_rows" in sql:
        assert "'' AS search_text, '' AS channel_search_text" in sql
        return [base_row]
    if "direct unfiltered VTuber overlay summary" in sql:
        aggregate_queries += 1
        return [{"channel_id": channel_id, "row_count": 4, "video_count": 3, "song_count": 3}]
    if "bounded direct overlay VTuber previews" in sql:
        return [{
            "channel_id": channel_id, "channel_name": "Conta Urameshi",
            "channel_handle": "/@urameshi_conta",
            "channel_url": "https://www.youtube.com/@urameshi_conta",
            "video_id": "video-new", "video_title": "New",
            "published_at": None, "revision_id": "candidate",
            "occurrence_id": "candidate-new-1", "position": 0,
            "range_id": "7d", "song_key": "song-d", "seconds": 31,
            "title": "song-d", "artist": "Artist", "source_id": "",
            "source_system": "youtube",
            "video_payload_json": {
                "videoId": "video-new", "channelId": channel_id,
                "channelHandle": "/@urameshi_conta",
                "channelName": "Conta Urameshi",
                "thumbnailUrl": "https://i.ytimg.com/vi/video-new/hqdefault.jpg",
            },
            "occurrence_payload_json": {
                "videoId": "video-new", "occurrenceId": "candidate-new-1",
                "position": 0, "rangeId": "7d", "songKey": "song-d",
                "seconds": 31, "title": "song-d", "artist": "Artist",
            },
        }]
    return []
module._rows = rows
module._generic_parent_runtime_revision = lambda *args: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *args: ["candidate"]
module._overlay_candidate_rows = lambda *args: (_ for _ in ()).throw(
    AssertionError("unfiltered VTuber path fetched candidate occurrences")
)
module._accepted_video_resets = lambda *args: {
    video_id: {
        "video_id": video_id, "video_title": video_id,
        "channel_id": channel_id, "channel_handle": "/@urameshi_conta",
        "channel_name": "Conta Urameshi",
        "channel_url": "https://www.youtube.com/@urameshi_conta",
        "tombstone": False, "payload_json": {
            "videoId": video_id, "channelId": channel_id,
            "channelHandle": "/@urameshi_conta",
            "channelName": "Conta Urameshi",
            "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg",
        },
    }
    for video_id in {"video-old", "video-new"}
}
module._accepted_video_reset_identity_changes = lambda *args: []
module._runtime_tombstones = lambda *args: []
module._channel_metadata_rows = lambda *args: []
module._VTUBER_REPLACEMENT_CACHE.clear()
class RealConnection:
    def cursor(self):
        raise AssertionError("mocked _rows should own SQL execution")
query = {"range": "7d", "view": "vtubers", "metric": "occurrences", "pageSize": "20"}
payload = module._generic_overlay_rankings_payload(RealConnection(), "candidate", {"revision_id": "candidate"}, query)
record = payload["records"][0]
assert aggregate_queries == 1, aggregate_queries
assert record["count"] == 4, record
assert record["videoCount"] == 3, record
assert record["songCount"] == 3, record
assert {item["videoId"] for item in record["occurrences"]} == {"video-keep"}, record
assert all(item["item"] == item["video"] for item in record["occurrences"]), record
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
module._overlay_candidate_rows = lambda *args: rows
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
module._overlay_candidate_rows = lambda *args: []
module._overlay_candidate_groups = lambda rows, view: {key: {"title": title, "artist": artist, "name": title, "search": f"{title} {artist} @noa_polaris", "occurrences": [{"videoId": "new-video"}], "videoIds": {"new-video"}, "songKeys": {key}}}
module._runtime_tombstones = lambda *args: []
module._channel_metadata_rows = lambda connection, revision_ids: []
module._rows = lambda connection, sql, params: [{"rank": 1, "detail_key": key, "title": title, "artist": artist, "name": "", "row_count": 494, "song_count": 0, "video_count": 475, "timestamp_count": 494, "search_text": f"{title} {artist}", "channel_search_text": "@noa_polaris"}] if "FROM runtime_ranking_rows" in sql else []
module._one = lambda connection, sql, params: {"payload_json": {
    "type": "song", "key": key, "title": title,
    "displayArtist": artist, "count": 494, "songCount": 0,
    "videoCount": 475, "timestampCount": 494,
    "sourceDetailKey": "source-water",
    "occurrences": [{"videoId": "stored-video"}],
}}
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

test("unpaged source detail returns every occurrence inside its bounded default page", () => {
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
            self.description = [("revision_id",), ("range_id",), ("payload_json",)]
            self.rows = [("rev", "all", json.dumps({"sourceDetailKey": "src-noa", "rangeId": "all", "occurrencePreviewLimited": True, "occurrences": [{"videoId": "legacy", "thumbnailUrl": "legacy.jpg"}]}))]
        elif "source_occurrence_count" in sql:
            self.description = [("total_occurrence_count",), ("total_video_count",), ("source_occurrence_count",)]
            self.rows = [(4, 4, 4)]
        elif "GROUP BY video_id" in sql:
            self.description = [("video_id",), ("first_position",)]
            self.rows = [("video-a", 0), ("video-a2", 1), ("video-b", 2), ("video-c", 3)]
        elif "runtime_source_occurrences" in sql:
            self.description = [(name,) for name in ("position", "video_id", "title", "channel_name", "channel_id", "channel_handle", "channel_url", "published_timestamp", "seconds", "search_text", "payload_json")]
            self.rows = [
                (0, "video-a", "A", "Noa", "channel", "@noa", "https://youtube.com/@noa", 1, 0, "a", json.dumps({"item": {"videoId": "video-a", "thumbnailUrl": "a.jpg"}, "song": {"songKey": "song-a", "title": "Song A"}})),
                (1, "video-a2", "A2", "Noa", "channel", "@noa", "https://youtube.com/@noa", 2, 1, "a2", json.dumps({"item": {"videoId": "video-a2", "thumbnailUrl": "a2.jpg"}, "song": {"songKey": "song-a", "title": "Song A"}})),
                (2, "video-b", "B", "Noa", "channel", "@noa", "https://youtube.com/@noa", 3, 2, "b", json.dumps({"item": {"videoId": "video-b", "thumbnailUrl": "b.jpg"}, "song": {"songKey": "song-b", "title": "Song B"}})),
                (3, "video-c", "C", "Noa", "channel", "@noa", "https://youtube.com/@noa", 4, 3, "c", json.dumps({"item": {"videoId": "video-c", "thumbnailUrl": "c.jpg"}, "song": {"songKey": "song-c", "title": "Song C"}})),
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
assert [item["item"]["thumbnailUrl"] for item in previews] == ["a.jpg", "a2.jpg", "b.jpg", "c.jpg"]
assert {item["item"]["videoId"] for item in previews} == {"video-a", "video-a2", "video-b", "video-c"}
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
    if "FROM runtime_source_occurrences" in sql:
        return []
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
            "range_id": "all",
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
enrich_changes = []
module._enrich_runtime_original_group_counts = (
    lambda _connection, _parent, _candidates, changes:
    enrich_changes.append(tuple(changes))
)
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
assert enrich_changes == [()], enrich_changes

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
assert "o.payload_json" not in parent_sql and "v.payload_json" not in parent_sql
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
    module._GENERIC_META_COUNTS_CACHE.clear()
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
    module._generic_public_all_range_baseline = lambda *_args: (200, 600)
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
assert counts["source_occurrences"] == 600

# An accepted full-video projection with a new occurrence id replaces, rather
# than adds to, its parent video.  The old and new unique songs trade places.
counts = meta_case(
    candidates=[candidate("video-a", "new", "new-key", "New")],
    resets={"video-a": {"video_id": "video-a", "tombstone": False}},
    reset_changes=[{**occurrence("video-a", "old", "old-key", "Old"), "videoId": "video-a", "occurrenceId": "old", "songKey": "old-key"}],
    parent_videos=["video-a"], song_counts={"old-key": 1},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (100, 200, 50)
assert counts["source_occurrences"] == 600

# A tombstoned accepted video removes every parent tuple and the video itself.
counts = meta_case(
    resets={"video-dead": {"video_id": "video-dead", "tombstone": True}},
    reset_changes=[
        {**occurrence("video-dead", "one", "dead-one"), "videoId": "video-dead", "occurrenceId": "one", "songKey": "dead-one"},
        {**occurrence("video-dead", "two", "dead-two"), "videoId": "video-dead", "occurrenceId": "two", "songKey": "dead-two"},
    ],
    parent_videos=["video-dead"], song_counts={"dead-one": 1, "dead-two": 1},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (99, 200, 48)
assert counts["source_occurrences"] == 600

# A new accepted video has no parent reset tuple/video but contributes exactly
# its final candidate tuple.  This is also the mixed effective-set invariant.
counts = meta_case(
    candidates=[candidate("video-new", "fresh", "fresh-key", "Fresh")],
    resets={"video-new": {"video_id": "video-new", "tombstone": False}},
    parent_videos=[], song_counts={},
)
assert (counts["videos"], counts["occurrences"], counts["songs"]) == (101, 200, 51)
assert counts["source_occurrences"] == 600

# A legacy accepted occurrence with no range remains one physical occurrence,
# but is deliberately visible through both all and 7d source keys.
legacy = candidate("video-legacy", "legacy", "legacy-key", "Legacy")
legacy.pop("range_id")
legacy["occurrence_payload_json"].pop("rangeId", None)
counts = meta_case(candidates=[legacy], resets={"video-legacy": {"video_id": "video-legacy", "tombstone": False}}, song_counts={})
assert counts["occurrences"] == 200
assert counts["source_occurrences"] == 600
print("OK")
`);
  assert.equal(output, "OK");
});

test("empty ranking groups skip affected parent occurrence reconciliation", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

change = {
    "entityType": "occurrences",
    "videoId": "video-1",
    "occurrenceId": "occurrence-1",
    "title": "Target",
    "artist": "Artist",
}

def unexpected_parent_scan(*_args):
    raise AssertionError("empty groups reached the parent occurrence scan")

module._bounded_affected_parent_occurrences = unexpected_parent_scan
empty_groups = {}
module._reconcile_affected_song_counts(
    object(), "parent", (), (), (change,), empty_groups, "songs", {"range": "all"},
)
assert empty_groups == {}

scan_calls = []
def parent_scan(*args):
    scan_calls.append(args)
    return []

module._bounded_affected_parent_occurrences = parent_scan
groups = {
    "target::artist": {
        "detail_key": "target::artist",
        "title": "Target",
        "artist": "Artist",
        "row_count": 1,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 1,
        "payload_json": {
            "count": 1,
            "songCount": 1,
            "videoCount": 1,
            "timestampCount": 1,
        },
    },
}
module._reconcile_affected_song_counts(
    object(), "parent", (), (), (change,), groups, "songs", {"range": "all"},
)
assert len(scan_calls) == 1
assert groups["target::artist"]["row_count"] == 0
print("OK")
`);
  assert.equal(output, "OK");
});

test("song reconciliation keeps title and artist paired and scans only returned groups", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

queries = []
def rows(_connection, sql, params):
    queries.append((sql, params))
    return []

module._rows = rows
changes = (
    {
        "entityType": "occurrences",
        "videoId": "video-target",
        "occurrenceId": "old-target",
        "title": "Alpha",
        "artist": "Singer A",
        "replacement": True,
        "replacementPayload": {
            "videoId": "video-target",
            "occurrenceId": "old-target",
            "title": "Beta",
            "artist": "Singer B",
        },
    },
)
list(module._bounded_affected_parent_occurrences(
    object(), "parent", changes, "songs", {"range": "all"},
))
sql, params = queries.pop()
assert "FROM unnest(%s::text[], %s::text[])" in sql
assert "(lower(coalesce(o.title, '')), lower(coalesce(o.artist, ''))) IN" in sql
assert "EXISTS (" not in sql
assert "lower(coalesce(o.title, '')) = ANY" not in sql
assert "o.payload_json" not in sql and "v.payload_json" not in sql
assert params[2] == ["alpha", "beta"]
assert params[3] == ["singer a", "singer b"]

captured = []
module._bounded_affected_parent_occurrences = (
    lambda _connection, _parent, lookup, _view, _options:
    (captured.extend(lookup) or [])
)
candidate = {
    "revision_id": "accepted",
    "video_id": "video-target",
    "occurrence_id": "new-target",
    "title": "Alpha",
    "artist": "Singer A",
    "song_key": "target",
    "range_id": "all",
    "video_payload_json": {"videoId": "video-target", "channelId": "UC-TARGET"},
}
unrelated = tuple({
    **candidate,
    "video_id": f"video-unrelated-{index}",
    "occurrence_id": f"new-unrelated-{index}",
    "title": f"Gamma {index}",
    "artist": f"Singer C {index}",
    "song_key": f"unrelated-{index}",
    "video_payload_json": {
        "videoId": f"video-unrelated-{index}",
        "channelId": "UC-OTHER",
    },
} for index in range(1200))
groups = {
    "alpha::singer a": {
        "detail_key": "alpha::singer a",
        "title": "Alpha",
        "artist": "Singer A",
        "row_count": 1,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 1,
        "payload_json": {},
    },
}
module._reconcile_affected_song_counts(
    object(),
    "parent",
    (candidate, *unrelated),
    (),
    (
        changes[0],
        *({
            "entityType": "occurrences",
            "videoId": f"video-unrelated-{index}",
            "occurrenceId": f"old-unrelated-{index}",
            "title": f"Gamma {index}",
            "artist": f"Singer C {index}",
        } for index in range(1200)),
    ),
    groups,
    "songs",
    {"range": "all"},
)
assert len(captured) == 2
assert {
    (item.get("title"), item.get("artist"))
    for item in captured
} == {("Alpha", "Singer A")}
assert (
    groups["alpha::singer a"]["row_count"],
    groups["alpha::singer a"]["song_count"],
    groups["alpha::singer a"]["video_count"],
) == (1, 1, 1)
print("OK")
`);
  assert.equal(output, "OK");
});

test("song fast path preserves multi-occurrence video counts across reset, replacement, and zero rows", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def rank(title, artist, count, videos):
    key = f"{title.casefold()}::{artist.casefold()}"
    return key, {
        "detail_key": key,
        "title": title,
        "artist": artist,
        "row_count": count,
        "song_count": 1,
        "video_count": videos,
        "timestamp_count": count,
        "payload_json": {
            "count": count,
            "songCount": 1,
            "videoCount": videos,
            "timestampCount": count,
        },
    }

def change(occurrence_id, *, title="Old", artist="Singer", count=2):
    return {
        "entityType": "occurrences",
        "acceptedVideoReset": True,
        "videoId": "video-a",
        "occurrenceId": occurrence_id,
        "title": title,
        "artist": artist,
        "originalGroupVideoOccurrenceCount": count,
    }

# A full-video reset removes both old occurrences and decrements its one video
# exactly once.  The accepted replacement contributes two occurrences but one
# video and one song group.
old_key, old_row = rank("Old", "Singer", 2, 1)
groups = {old_key: old_row}
module._apply_runtime_tombstone_groups(
    groups,
    (change("old-1"), change("old-2")),
    "songs",
)
assert groups == {}

def candidate(occurrence_id):
    return {
        "video_id": "video-a",
        "occurrence_id": occurrence_id,
        "song_key": "canonical-new",
        "title": "New",
        "artist": "Singer",
        "range_id": "all",
        "video_tombstone": False,
        "occurrence_payload_json": {
            "videoId": "video-a",
            "occurrenceId": occurrence_id,
            "songKey": "canonical-new",
            "title": "New",
            "artist": "Singer",
        },
        "video_payload_json": {
            "videoId": "video-a",
            "channelId": "UC-A",
        },
    }

delta = module._overlay_candidate_groups(
    (candidate("new-1"), candidate("new-2")),
    "songs",
)
new_group = delta["new::singer"]
assert (
    new_group["occurrenceCount"],
    len(new_group["videoIds"]),
    len(new_group["songKeys"]),
) == (2, 1, 1)

# A partial replacement removes one of two tuples from the old card.  Because
# one tuple from the same video remains, its videoCount and songCount stay one;
# the replacement card gets one occurrence/video/song.
old_key, old_row = rank("Old", "Singer", 2, 1)
groups = {old_key: old_row}
partial = {
    **change("old-1"),
    "acceptedVideoReset": False,
    "replacement": True,
}
module._apply_runtime_tombstone_groups(groups, (partial,), "songs")
assert (
    groups[old_key]["row_count"],
    groups[old_key]["video_count"],
    groups[old_key]["song_count"],
) == (1, 1, 1)

# Removing the sole tuple is an explicit zero-row card, so it disappears
# instead of surviving with stale count metadata.
zero_key, zero_row = rank("Zero", "Singer", 1, 1)
groups = {zero_key: zero_row}
module._apply_runtime_tombstone_groups(
    groups,
    (change("zero-1", title="Zero", count=1),),
    "songs",
)
assert groups == {}
print("OK")
`);
  assert.equal(output, "OK");
});

test("song reset and preview application use exact group indexes instead of cartesian scans", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

groups = {}
changes = []
for index in range(600):
    key = f"song {index}::artist {index}"
    occurrence = {
        "videoId": f"video-{index}",
        "occurrenceId": f"occ-{index}",
        "title": f"Song {index}",
        "artist": f"Artist {index}",
    }
    groups[key] = {
        "detail_key": key,
        "title": f"Song {index}",
        "artist": f"Artist {index}",
        "row_count": 2,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 2,
        "payload_json": {"occurrences": [dict(occurrence)]},
    }
    changes.append({
        "entityType": "occurrences",
        **occurrence,
        "originalGroupVideoOccurrenceCount": 2,
    })

module._runtime_change_matches_group = lambda *_: (_ for _ in ()).throw(
    AssertionError("non-VTuber indexed path used cartesian matcher")
)
module._apply_runtime_tombstone_groups(groups, changes, "songs")
assert all(row["row_count"] == 1 for row in groups.values())
module._apply_runtime_change_previews(groups, changes, "songs")
assert all(row["payload_json"]["occurrences"] == [] for row in groups.values())
print("OK")
`);
  assert.equal(output, "OK");
});

test("public artist and video rankings recount accepted reset aggregates from effective tuples", () => {
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
    # Each fixture below changes the synthetic active revision's rows.
    module._GENERIC_RANKING_PREPARATION_CACHE.clear()
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

# A full-video reset can remove two old tuples while another video keeps the
# same canonical song group alive.  Refreshing the removed video with two
# accepted tuples restores three occurrences and two videos, but still only
# one song.  The delta merge must not add the same song group a second time.
parent[:] = [
    {"video_id": "video-a", "occurrence_id": "old-a1", "song_key": "shared", "title": "Same", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-a", "channelId": "UCOLD", "channelName": "Old"}},
    {"video_id": "video-a", "occurrence_id": "old-a2", "song_key": "shared", "title": "Same", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-a", "channelId": "UCOLD", "channelName": "Old"}},
    {"video_id": "video-b", "occurrence_id": "keep-b", "song_key": "shared", "title": "Same", "artist": "Artist", "range_id": "all", "channel_id": "UCOLD", "channel_name": "Old", "channel_handle": "/@old", "video_payload_json": {"videoId": "video-b", "channelId": "UCOLD", "channelName": "Old"}},
]
reset_changes = [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": row["video_id"], "occurrenceId": row["occurrence_id"], "title": row["title"], "artist": row["artist"], "songKey": row["song_key"], "channel_id": "UCOLD", "channel_name": "Old"} for row in parent[:2]]
same_song_base = rank(
    "same::artist",
    title="Same",
    artist="Artist",
    rows=[
        occ("video-a", "old-a1", "shared"),
        occ("video-a", "old-a2", "shared"),
        occ("video-b", "keep-b", "shared"),
    ],
    videos=2,
)
same_song_base["song_count"] = 1
same_song_base["payload_json"]["songCount"] = 1
same_song = public(
    "songs",
    [
        candidate("new-a1", title="Same", song_key="shared"),
        candidate("new-a2", title="Same", song_key="shared"),
    ],
    [same_song_base],
)
assert set(same_song) == {"same::artist"}
assert counts(same_song["same::artist"]) == (3, 2, 1, 3)
assert {
    item["occurrenceId"]
    for item in same_song["same::artist"]["occurrences"]
} == {"new-a1", "new-a2", "keep-b"}
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
    return {"schemaVersion": 1, "found": True, "sourceKey": key,
        "sourceRevisionId": "parent", "record": {
        "type": "song", "key": song_key, "title": title, "artist": "Ado",
        "displayArtist": "Ado", "artists": [{"name": "Ado", "count": 0}],
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
def source_row(row, position):
    payload = dict(row["occurrence_payload_json"])
    payload["video"] = dict(row["video_payload_json"])
    return {"position": position, "video_id": row["video_id"],
        "title": row["video_title"], "channel_name": row["channel_name"],
        "channel_id": row["channel_id"], "channel_handle": row["channel_handle"],
        "channel_url": row["channel_url"], "published_timestamp": position,
        "seconds": row["seconds"], "search_text": row["title"] + " " + row["artist"],
        "payload_json": payload}
source_rows = {
    canonical_source: [source_row(row, index) for index, row in enumerate(canonical_parent)],
}
for source_key, (song_key, _title) in alias_sources.items():
    source_rows[source_key] = [
        source_row(row, index) for index, row in enumerate(alias_parent)
        if row["song_key"] == song_key
    ]
def selected_rows(_connection, sql, params):
    params = list(params)
    if "WITH overlay_videos" in sql:
        source_key = params[3]
        excluded = set(params[5])
        videos = {}
        for row in source_rows.get(source_key, []):
            if row["video_id"] not in excluded:
                videos[row["video_id"]] = min(
                    videos.get(row["video_id"], row["position"]), row["position"],
                )
        for video_id, position in zip(params[0], params[1]):
            videos[video_id] = position
        ordered = sorted(videos.items(), key=lambda item: (item[1], item[0]))
        limit, offset = params[-2], params[-1]
        return [{"video_id": video_id, "first_position": position}
            for video_id, position in ordered[offset:offset + limit]]
    if "count(*) AS total_occurrence_count" in sql:
        rows = source_rows.get(params[1], [])
        return [{"total_occurrence_count": len(rows),
            "total_video_count": len({row["video_id"] for row in rows}),
            "max_position": max((row["position"] for row in rows), default=0)}]
    if "FROM runtime_source_occurrences" in sql and "video_id = ANY" in sql:
        requested = set(params[-2])
        assert params[-1] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        return [row for row in source_rows.get(params[1], [])
            if row["video_id"] in requested]
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
module._accepted_video_resets = lambda *_: {"canon-000": {
    "video_id": "canon-000", "tombstone": True,
    "payload_json": {"rangeId": "all", "deleted": True},
}}
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

test("VTuber exact aggregation defers parent preview hydration with exact exclusion state", () => {
  const output = runPython(`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Connection:
    def cursor(self): return object()

def candidate(video_id, occurrence_id, channel_id, key):
    handle = "@" + channel_id.lower()
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {"revision_id": "accepted", "video_id": video_id, "occurrence_id": occurrence_id,
      "position": 0, "range_id": "all", "song_key": key, "title": key, "artist": "Artist",
      "seconds": 13, "channel_id": channel_id, "channel_name": channel_id,
      "channel_handle": handle, "video_tombstone": False,
      "video_payload_json": {"videoId": video_id, "channelId": channel_id,
        "channelName": channel_id, "channelHandle": handle,
        "channelUrl": "https://www.youtube.com/channel/" + channel_id,
        "thumbnailUrl": thumbnail},
      "occurrence_payload_json": {"videoId": video_id,
        "occurrenceId": occurrence_id, "position": 0, "songKey": key,
        "seconds": 13, "title": key, "artist": "Artist", "rangeId": "all"}}

accepted = candidate("accepted-reset", "accepted-occ", "UCNEW", "accepted-song")
replacement = candidate("runtime-replacement", "replacement-occ", "UCMOVED", "canonical")
reset_changes = [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": "accepted-reset", "occurrenceId": "old", "channel_id": "UCOLD"}]
runtime_changes = [
  {"entityType": "occurrences", "videoId": "runtime-tombstone", "occurrenceId": "dead", "channel_id": "UCOLD"},
  {"entityType": "occurrences", "videoId": "runtime-replacement", "occurrenceId": "old-name", "channel_id": "UCOLD", "replacement": True},
]
seen = []
preview_seen = []
def rows(_connection, sql, params):
    if "bounded final VTuber previews" in sql:
        preview_seen.append((sql, params))
        thumbnail = "https://i.ytimg.com/vi/keep/hqdefault.jpg"
        return [{"revision_id": "parent", "channel_id": "UCOLD",
          "channel_name": "Old", "channel_handle": "@old",
          "channel_url": "https://www.youtube.com/@old",
          "video_id": "keep", "video_title": "Keep",
          "video_payload_json": {"videoId": "keep", "channelId": "UCOLD",
            "channelHandle": "@old", "thumbnailUrl": thumbnail},
          "occurrence_id": "keep", "position": 0, "range_id": "all",
          "song_key": "keep", "seconds": 5, "title": "Keep",
          "artist": "Artist", "source_id": "fixture", "source_system": "test",
          "occurrence_payload_json": {"videoId": "keep", "occurrenceId": "keep",
            "position": 0, "rangeId": "all", "songKey": "keep",
            "seconds": 5, "title": "Keep", "artist": "Artist"}}]
    if "affected_parent_videos AS MATERIALIZED" not in sql:
        return []
    seen.append((sql, params))
    return [
      {"channel_id": "UCOLD", "row_count": 1, "video_count": 1, "song_count": 1},
      {"channel_id": "UCNEW", "row_count": 1, "video_count": 1, "song_count": 1},
      {"channel_id": "UCMOVED", "row_count": 1, "video_count": 1, "song_count": 1},
    ]
module._rows = rows
module._VTUBER_REPLACEMENT_CACHE.clear()
base = {"UCOLD": {"payload_json": {"channelId": "UCOLD",
  "channelHandle": "@ucold", "occurrences": [
  {"videoId": "runtime-tombstone", "occurrenceId": "dead",
   "title": "Dead", "artist": "Artist", "seconds": 3,
   "song": {"title": "Dead", "artist": "Artist", "seconds": 3},
   "item": {"videoId": "runtime-tombstone", "channelId": "UCOLD",
     "channelHandle": "@ucold",
     "thumbnailUrl": "https://i.ytimg.com/vi/runtime-tombstone/hqdefault.jpg"}},
  {"videoId": "keep", "occurrenceId": "keep",
   "title": "Keep", "artist": "Artist", "seconds": 5,
   "song": {"title": "Keep", "artist": "Artist", "seconds": 5},
   "item": {"videoId": "keep", "channelId": "UCOLD",
     "channelHandle": "@ucold",
     "thumbnailUrl": "https://i.ytimg.com/vi/keep/hqdefault.jpg"}},
]}}}
exact = module._overlay_vtuber_replacement_rows(
  Connection(), "active", "parent", [accepted], {"range": "all"}, base,
  reset_changes, runtime_changes, [replacement], {"accepted-reset": {"tombstone": False}},
)
assert (
    set(exact) == {"UCOLD", "UCNEW", "UCMOVED"}
    and exact["UCOLD"]["row_count"] == 1
    and {item["videoId"] for item in exact["UCOLD"]["payload_json"]["occurrences"]} == {"keep"}
    and exact["UCNEW"]["payload_json"]["sourceDetailKey"] == module._stable_key("source-vtuber", "all", "UCNEW")
    and len(seen) == 1
    and len(preview_seen) == 0
), {"exact": exact, "seen": seen, "preview_seen": preview_seen}
for channel_id, row in exact.items():
    assert row["_preview_excluded_video_ids"] == ("accepted-reset",)
    assert row["_preview_excluded_occurrence_ids"] == (
      ("runtime-replacement", "old-name"), ("runtime-tombstone", "dead"),
    )
    module._canonicalize_vtuber_card_preview(row["payload_json"], channel_id)
assert exact["UCNEW"]["payload_json"]["occurrences"][0]["item"]["videoId"] == "accepted-reset"
assert exact["UCMOVED"]["payload_json"]["occurrences"][0]["item"]["videoId"] == "runtime-replacement"
summary_params = seen[0][1]
assert summary_params[1] == ["accepted-reset"]
assert set(zip(summary_params[2], summary_params[3])) == {
  ("runtime-replacement", "old-name"), ("runtime-tombstone", "dead"),
}

# A nonempty exact VTuber projection is complete for its channels, so the
# generic bounded reconcile must not execute a second parent occurrence scan.
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["candidate"]
module._overlay_candidate_rows = lambda *_: []
module._accepted_video_resets = lambda *_: {}
module._runtime_tombstones = lambda *_: []
module._channel_metadata_rows = lambda *_: []
thumbnail = "https://i.ytimg.com/vi/video-1/hqdefault.jpg"
preview = {"videoId": "video-1", "occurrenceId": "occ-1", "position": 0,
  "rangeId": "all", "songKey": "song-1", "seconds": 7,
  "title": "Song", "artist": "Artist",
  "song": {"title": "Song", "artist": "Artist", "seconds": 7,
    "songKey": "song-1", "rangeId": "all"},
  "item": {"videoId": "video-1", "channelId": "UC1",
    "channelHandle": "@one", "thumbnailUrl": thumbnail},
  "video": {"videoId": "video-1", "channelId": "UC1",
    "channelHandle": "@one", "thumbnailUrl": thumbnail}}
module._overlay_vtuber_replacement_rows = lambda *_args: {"UC1": {"detail_key": "UC1", "name": "One", "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1, "payload_json": {"type": "vtuber", "key": "UC1", "channelId": "UC1", "channelHandle": "@one", "count": 1, "songCount": 1, "videoCount": 1, "timestampCount": 1, "occurrences": [preview]}}}
reconcile_calls = []
module._reconcile_affected_song_counts = lambda *args: reconcile_calls.append(args)
module._rows = lambda _connection, sql, _params: [{"rank": 1, "detail_key": "UC1", "title": "", "artist": "", "name": "One", "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1, "search_text": "", "channel_search_text": "", "payload_json": {"type": "vtuber", "key": "UC1", "channelId": "UC1"}}] if "runtime_ranking_rows" in sql else []
payload = module._generic_overlay_rankings_payload(object(), "candidate", {"revision_id": "candidate"}, {"range": "all", "view": "vtubers", "metric": "count", "pageSize": "20"})
assert payload["records"][0]["channelId"] == "UC1"
assert reconcile_calls == []
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact rankings skip the generic candidate grouper without changing exact counts", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

candidate = {"revision_id": "accepted", "video_id": "video-1", "occurrence_id": "occ-1",
  "position": 0, "range_id": "all", "song_key": "song-1", "title": "Song", "artist": "Artist",
  "channel_id": "UC1", "channel_name": "One", "video_tombstone": False,
  "video_payload_json": {"videoId": "video-1", "channelId": "UC1", "channelName": "One",
    "channelHandle": "@one", "thumbnailUrl": "https://i.ytimg.com/vi/video-1/hqdefault.jpg"},
  "occurrence_payload_json": {"videoId": "video-1", "occurrenceId": "occ-1",
    "position": 0, "songKey": "song-1", "seconds": 9,
    "title": "Song", "artist": "Artist", "rangeId": "all"}}
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["accepted"]
module._overlay_candidate_rows = lambda *_: [candidate]
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: None
module._channel_metadata_rows = lambda *_: []
module._reconcile_affected_song_counts = lambda *_: None
module._hydrate_overlay_page_previews = lambda *_: None
grouper_calls = []
def generic_grouper(rows, view):
    grouper_calls.append((view, list(rows)))
    return {"song::artist": {"title": "Song", "artist": "Artist", "name": "Song", "search": "song artist",
      "occurrences": [], "occurrenceCount": 3, "videoIds": {"video-1"}, "songKeys": {"song-1"}}}
module._overlay_candidate_groups = generic_grouper
preview = {"videoId": "video-1", "occurrenceId": "occ-1", "position": 0,
  "rangeId": "all", "songKey": "song-1", "seconds": 9,
  "title": "Song", "artist": "Artist",
  "song": {"title": "Song", "artist": "Artist", "seconds": 9,
    "songKey": "song-1", "rangeId": "all"},
  "item": dict(candidate["video_payload_json"]),
  "video": dict(candidate["video_payload_json"])}
module._overlay_vtuber_replacement_rows = lambda *_: {"UC1": {"detail_key": "UC1", "name": "One",
  "row_count": 2, "song_count": 1, "video_count": 1, "timestamp_count": 2,
  "payload_json": {"type": "vtuber", "key": "UC1", "channelId": "UC1",
    "channelHandle": "@one", "count": 2, "songCount": 1, "videoCount": 1,
    "timestampCount": 2, "occurrences": [preview]}}}
module._rows = lambda _connection, sql, _params: []

vtubers = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
  {"range": "all", "view": "vtubers", "metric": "count", "pageSize": "20"})
assert grouper_calls == []
assert [(row["channelId"], row["count"], row["songCount"], row["videoCount"])
  for row in vtubers["records"]] == [("UC1", 2, 1, 1)]

songs = module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"},
  {"range": "all", "view": "songs", "metric": "count", "pageSize": "20"})
assert [view for view, _rows in grouper_calls] == ["songs"]
assert songs["records"][0]["count"] == 3
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact candidate input replaces accepted occurrence chains without dropping sibling or reset rows", () => {
  const output = runPython(`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Connection:
    def cursor(self): return object()

def candidate(video_id, occurrence_id, key):
    return {
      "revision_id": "accepted", "video_id": video_id, "occurrence_id": occurrence_id,
      "position": 0, "range_id": "all", "song_key": key, "title": key, "artist": "Artist",
      "channel_id": "UC1", "channel_name": "One", "video_tombstone": False,
      "video_payload_json": {"videoId": video_id, "channelId": "UC1", "channelName": "One"},
      "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": key, "title": key, "artist": "Artist", "rangeId": "all", "isNiche": True},
    }

old = candidate("same-video", "changed", "old-key")
untouched = candidate("same-video", "untouched", "keep-key")
tombstoned = candidate("dead-video", "dead", "dead-key")
accepted_reset = candidate("reset-video", "reset", "reset-key")
canonical = candidate("same-video", "changed", "canonical-key")
reset_changes = [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": "reset-video", "occurrenceId": "reset", "channel_id": "UC1"}]
runtime_changes = [
  {"entityType": "occurrences", "videoId": "same-video", "occurrenceId": "changed", "channel_id": "UC1", "replacement": True},
  {"entityType": "occurrences", "videoId": "dead-video", "occurrenceId": "dead", "channel_id": "UC1"},
]
calls = []
def rows(_connection, sql, params):
    values = {(item["video_id"], item["song_key"]) for item in json.loads(params[5])}
    assert values == {("same-video", "canonical-key"), ("same-video", "keep-key"), ("reset-video", "reset-key")}, values
    if "fast_parent_occurrences AS" in sql:
        calls.append("fast")
        return [{"channel_id": "UC1", "row_count": 3, "video_count": 2, "song_count": 3, "has_empty_song_key": False}]
    if "parent_occurrences AS" in sql:
        calls.append("fallback")
        return [{"channel_id": "UC1", "row_count": 3, "video_count": 2, "song_count": 3}]
    raise AssertionError(sql)
module._rows = rows
base = {"UC1": {"payload_json": {"channelId": "UC1", "channelName": "One", "occurrences": []}}}
module._VTUBER_REPLACEMENT_CACHE.clear()
fast = module._overlay_vtuber_replacement_rows(Connection(), "fast-chain", "parent", [old, untouched, tombstoned, accepted_reset], {"range": "all"}, base, reset_changes, runtime_changes, [canonical], {"reset-video": {"tombstone": False}})
module._VTUBER_REPLACEMENT_CACHE.clear()
legacy = module._overlay_vtuber_replacement_rows(Connection(), "legacy-chain", "parent", [old, untouched, tombstoned, accepted_reset], {"range": "all", "nicheOnly": "1"}, base, reset_changes, runtime_changes, [canonical], {"reset-video": {"tombstone": False}})
assert calls == ["fast", "fallback"], calls
assert (fast["UC1"]["row_count"], fast["UC1"]["video_count"], fast["UC1"]["song_count"]) == (3, 2, 3)
assert (legacy["UC1"]["row_count"], legacy["UC1"]["video_count"], legacy["UC1"]["song_count"]) == (3, 2, 3)
for result in (fast, legacy):
    keys = {item["song"]["songKey"] for item in result["UC1"]["payload_json"]["occurrences"]}
    assert keys == {"canonical-key", "keep-key", "reset-key"}, keys
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact SQL materializes parent videos before indexed occurrence lookup", () => {
  const adapter = fs.readFileSync(ADAPTER, "utf8");
  assert.match(adapter, /affected_parent_videos AS MATERIALIZED/u);
  assert.match(adapter, /FROM runtime_videos AS v[\s\S]*?touched\.video_id IS NULL/u);
  assert.match(adapter, /FROM affected_parent_videos AS parent[\s\S]*?o\.video_id = parent\.video_id/u);
  assert.match(adapter, /range_values AS MATERIALIZED[\s\S]*?scope\.range_id = o\.range_id/u);
  assert.match(adapter, /bounded_parent_occurrences AS MATERIALIZED/u);
  assert.match(adapter, /ORDER BY v\.video_id[\s\S]*?LIMIT %s/u);
  assert.match(adapter, /ORDER BY o\.video_id, o\.occurrence_id[\s\S]*?LIMIT %s/u);
  assert.match(adapter, /bool_or\(residual_match\) AS residual_match/u);
  assert.match(adapter, /coalesce\([\s\S]*?nullif\(parent\.song_key, ''\)/u);
});

test("VTuber bounded exact matches filtered summaries and guards physical ranges", () => {
  const output = runPython(`
import contextlib
import importlib.util
import io
import os
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Connection:
    def cursor(self): return object()

changes = [
    {"entityType": "occurrences", "videoId": f"touched-{index}", "occurrenceId": f"old-{index}", "channel_id": "UC1"}
    for index in range(13)
]
base = {"UC1": {"payload_json": {"channelId": "UC1", "channelName": "One", "occurrences": []}}}
summary = {"channel_id": "UC1", "row_count": 19, "video_count": 7, "song_count": 11, "has_empty_song_key": False}
calls = []
range_calls = []
def joined_preview(params):
    range_id = params[4][0]
    thumbnail = "https://i.ytimg.com/vi/keep/hqdefault.jpg"
    return {"revision_id": "parent", "channel_id": "UC1",
      "channel_name": "One", "channel_handle": "@one",
      "channel_url": "https://www.youtube.com/@one",
      "video_id": "keep", "video_title": "Keep",
      "video_payload_json": {"videoId": "keep", "channelId": "UC1",
        "channelHandle": "@one", "thumbnailUrl": thumbnail},
      "occurrence_id": "keep-occ", "position": 0, "range_id": range_id,
      "song_key": "keep-song", "seconds": 14, "title": "Keep",
      "artist": "Artist", "source_id": "fixture", "source_system": "test",
      "occurrence_payload_json": {"videoId": "keep",
        "occurrenceId": "keep-occ", "position": 0, "rangeId": range_id,
        "songKey": "keep-song", "seconds": 14, "title": "Keep",
        "artist": "Artist", "isNiche": True}}
def rows(_connection, sql, params):
    if "bounded final VTuber previews" in sql:
        return [joined_preview(params)]
    if "fast_parent_occurrences AS" in sql:
        calls.append("fast")
        range_calls.append(("fast", params[4]))
        assert len(params[2]) == len(params[3]) == 13
        return [dict(summary)]
    if "parent_occurrences AS" in sql:
        calls.append("fallback")
        range_calls.append(("fallback", params[4]))
        assert len(params[2]) == len(params[3]) == 13
        return [dict(summary)]
    raise AssertionError(sql)
module._rows = rows
module._VTUBER_REPLACEMENT_CACHE.clear()
os.environ["DAILY_SONG_PG_ADAPTER_PHASE_TRACE"] = "1"
trace = io.StringIO()
with contextlib.redirect_stderr(trace):
    fast = module._overlay_vtuber_replacement_rows(Connection(), "fast", "parent", [], {"range": "all"}, base, (), changes, (), {})
module._VTUBER_REPLACEMENT_CACHE.clear()
legacy = module._overlay_vtuber_replacement_rows(Connection(), "legacy", "parent", [], {"range": "all", "nicheOnly": "1"}, base, (), changes, (), {})
module._VTUBER_REPLACEMENT_CACHE.clear()
fast_7d = module._overlay_vtuber_replacement_rows(Connection(), "fast-7d", "parent", [], {"range": "7d"}, base, (), changes, (), {})
module._VTUBER_REPLACEMENT_CACHE.clear()
legacy_7d = module._overlay_vtuber_replacement_rows(Connection(), "legacy-7d", "parent", [], {"range": "7d", "nicheOnly": "1"}, base, (), changes, (), {})
assert calls == ["fast", "fallback", "fast", "fallback"], calls
assert range_calls == [("fast", ["all", ""]), ("fallback", ["all", ""]), ("fast", ["7d", ""]), ("fallback", ["7d", ""])], range_calls
assert (fast["UC1"]["row_count"], fast["UC1"]["video_count"], fast["UC1"]["song_count"]) == (19, 7, 11)
assert (legacy["UC1"]["row_count"], legacy["UC1"]["video_count"], legacy["UC1"]["song_count"]) == (19, 7, 11)
assert (fast_7d["UC1"]["row_count"], fast_7d["UC1"]["video_count"], fast_7d["UC1"]["song_count"]) == (19, 7, 11)
assert (legacy_7d["UC1"]["row_count"], legacy_7d["UC1"]["video_count"], legacy_7d["UC1"]["song_count"]) == (19, 7, 11)
assert "phase=exact_build_inputs" in trace.getvalue()
assert "phase=exact_sql" in trace.getvalue()

fallback_calls = []
def empty_rows(_connection, sql, params):
    if "bounded final VTuber previews" in sql:
        return [joined_preview(params)]
    if "fast_parent_occurrences AS" in sql:
        fallback_calls.append("fast")
        assert len(params[2]) == len(params[3]) == 1
        return [dict(summary)]
    raise AssertionError(sql)
module._rows = empty_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
fallback = module._overlay_vtuber_replacement_rows(Connection(), "empty", "parent", [], {"range": "all"}, base, (), changes[:1], (), {})
assert fallback_calls == ["fast"], fallback_calls
assert fallback["UC1"]["song_count"] == 11
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact preview bounds once per channel while preserving the legacy ordered result", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self): return object()

def candidate(channel_id, index):
    video_id = f"{channel_id}-video"
    occurrence_id = f"{channel_id}-{index}"
    return {
        "revision_id": "accepted", "video_id": video_id,
        "occurrence_id": occurrence_id, "position": index, "range_id": "all",
        "song_key": occurrence_id, "title": occurrence_id, "artist": "Artist",
        "channel_id": channel_id, "channel_name": channel_id, "video_tombstone": False,
        "video_payload_json": {"videoId": video_id, "channelId": channel_id, "channelName": channel_id},
        "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": occurrence_id, "title": occurrence_id, "artist": "Artist", "rangeId": "all"},
    }

channels = ["UC-A", "UC-B", "UC-C"]
rows = [candidate(channel, index) for channel in channels for index in range(400)]
def sql_rows(_connection, sql, params):
    assert "affected_parent_videos AS MATERIALIZED" in sql
    assert params[0] == channels
    assert len(__import__("json").loads(params[5])) == 1200
    return [{"channel_id": channel, "row_count": 400, "video_count": 1, "song_count": 400} for channel in channels]
module._rows = sql_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
original = module._bounded_overlay_previews
calls = []
def spy(items):
    materialized = list(items)
    calls.append(len(materialized))
    return original(materialized)
module._bounded_overlay_previews = spy
exact = module._overlay_vtuber_replacement_rows(
    Connection(), "preview-scale", "parent", rows, {"range": "all"}, {}, (), (), (), {},
)
assert len(calls) == len(channels) and calls == [400, 400, 400], calls
for channel in channels:
    # The old repeated bound was exactly the first 20 caller-ordered entries.
    expected = [f"{channel}-{index}" for index in range(20)]
    actual = [item["song"]["occurrenceId"] for item in exact[channel]["payload_json"]["occurrences"]]
    assert actual == expected, (channel, actual)
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact rows retain untouched runtime-video songs and physical-range boundaries", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def candidate(video_id, occurrence_id, key, range_id="all"):
    return {"revision_id": "accepted", "video_id": video_id, "occurrence_id": occurrence_id, "position": 0, "range_id": range_id, "song_key": key, "title": key, "artist": "Artist", "channel_id": "UC1", "channel_name": "One", "video_tombstone": False, "video_payload_json": {"videoId": video_id, "channelId": "UC1", "channelName": "One"}, "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id, "songKey": key, "title": key, "artist": "Artist", "rangeId": range_id}}

parent_videos = [
  {"video_id": "full", "title": "Full", "channel_id": "UC1", "channel_name": "One", "payload_json": {}},
  {"video_id": "runtime", "title": "Runtime", "channel_id": "UC1", "channel_name": "One", "payload_json": {}},
  {"video_id": "other", "title": "Other", "channel_id": "UC1", "channel_name": "One", "payload_json": {}},
]
parent_occurrences = [
  {"video_id": "full", "occurrence_id": "old-all", "range_id": "all", "song_key": "old-all", "title": "old-all", "artist": "Artist", "payload_json": {}},
  {"video_id": "full", "occurrence_id": "old-7d", "range_id": "7d", "song_key": "old-7d", "title": "old-7d", "artist": "Artist", "payload_json": {}},
  {"video_id": "runtime", "occurrence_id": "remove", "range_id": "all", "song_key": "remove", "title": "remove", "artist": "Artist", "payload_json": {}},
  {"video_id": "runtime", "occurrence_id": "replace", "range_id": "all", "song_key": "old-name", "title": "old-name", "artist": "Artist", "payload_json": {}},
  {"video_id": "runtime", "occurrence_id": "keep", "range_id": "all", "song_key": "keep", "title": "keep", "artist": "Artist", "payload_json": {}},
  {"video_id": "runtime", "occurrence_id": "seven", "range_id": "7d", "song_key": "seven", "title": "seven", "artist": "Artist", "payload_json": {}},
  {"video_id": "other", "occurrence_id": "other", "range_id": "all", "song_key": "other", "title": "other", "artist": "Artist", "payload_json": {}},
]
def rows(_connection, sql, _params):
    if "FROM runtime_videos" in sql: return parent_videos
    if "FROM runtime_occurrences" in sql: return parent_occurrences
    raise AssertionError(sql)
module._rows = rows
runtime_changes = [
  {"entityType": "occurrences", "videoId": "runtime", "occurrenceId": "remove", "channel_id": "UC1"},
  {"entityType": "occurrences", "videoId": "runtime", "occurrenceId": "replace", "channel_id": "UC1", "replacement": True},
]
all_rows = module._overlay_vtuber_replacement_rows(
  object(), "active-all", "parent", [candidate("full", "fresh", "fresh")], module._query_options({"range": "all", "view": "vtubers"}), {},
  [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": "full", "occurrenceId": "old-all", "channel_id": "UC1"}],
  runtime_changes, [candidate("runtime", "replace", "canonical")], {"full": {"tombstone": False}},
)
all_payload = all_rows["UC1"]["payload_json"]
all_ids = {item["song"]["occurrenceId"] for item in all_payload["occurrences"]}
assert all_ids == {"fresh", "replace", "keep", "other"}, all_payload
assert (all_payload["count"], all_payload["videoCount"], all_payload["songCount"]) == (4, 3, 4)
assert all_payload["sourceDetailKey"] == module._stable_key("source-vtuber", "all", "UC1")

# The same full-video boundary removes old 7d rows, while all-only runtime
# chains and candidates never cross the physical range boundary.
seven_rows = module._overlay_vtuber_replacement_rows(
  object(), "active-7d", "parent", [], module._query_options({"range": "7d", "view": "vtubers"}), {},
  [{"entityType": "occurrences", "acceptedVideoReset": True, "videoId": "full", "occurrenceId": "old-7d", "channel_id": "UC1"}],
  [], [], {"full": {"tombstone": False}},
)
seven_payload = seven_rows["UC1"]["payload_json"]
assert {item["song"]["occurrenceId"] for item in seven_payload["occurrences"]} == {"seven"}
assert seven_payload["sourceDetailKey"] == module._stable_key("source-vtuber", "7d", "UC1")
print("OK")
`);
  assert.equal(output, "OK");
});

test("VTuber exact input is range-filtered and candidate filters preserve SQL semantics", () => {
  const output = runPython(`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def candidate(video_id, occurrence_id, range_id, artist="Artist", niche=True):
    return {"revision_id": "accepted", "video_id": video_id, "occurrence_id": occurrence_id, "position": 0, "range_id": range_id, "song_key": occurrence_id, "seconds": 16, "title": occurrence_id, "artist": artist, "channel_id": "UC1", "channel_name": "One", "channel_handle": "@one", "video_tombstone": False, "video_payload_json": {"videoId": video_id, "channelId": "UC1", "channelName": "One", "channelHandle": "@one", "thumbnailUrl": "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"}, "occurrence_payload_json": {"videoId": video_id, "occurrenceId": occurrence_id, "position": 0, "songKey": occurrence_id, "seconds": 16, "title": occurrence_id, "artist": artist, "rangeId": range_id, "isNiche": niche}}

all_row = candidate("all-video", "all-occ", "all")
seven_row = candidate("seven-video", "seven-occ", "7d")
captured = []
module._generic_parent_runtime_revision = lambda *_: ("parent", {"revision_id": "parent"})
module._overlay_revision_ids = lambda *_: ["accepted"]
module._overlay_candidate_rows = lambda *_: [all_row, seven_row]
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: [
  {"entityType": "occurrences", "videoId": "all-video", "occurrenceId": "all-occ", "rangeId": "all", "channel_id": "UC1"},
  {"entityType": "occurrences", "videoId": "seven-video", "occurrenceId": "seven-occ", "rangeId": "7d", "channel_id": "UC1"},
]
module._enrich_runtime_original_group_counts = lambda *_: None
module._channel_metadata_rows = lambda *_: []
real_exact = module._overlay_vtuber_replacement_rows
seven_preview = module._overlay_candidate_groups([seven_row], "vtubers")["UC1"]["occurrences"][0]
def exact(*args):
    captured.append(args)
    return {"UC1": {"detail_key": "UC1", "name": "One", "row_count": 1, "song_count": 1, "video_count": 1, "timestamp_count": 1, "payload_json": {"type": "vtuber", "key": "UC1", "channelId": "UC1", "channelHandle": "@one", "occurrences": [seven_preview]}}}
module._overlay_vtuber_replacement_rows = exact
module._rows = lambda _connection, sql, _params: []
module._generic_overlay_rankings_payload(object(), "active", {"revision_id": "active"}, {"range": "7d", "view": "vtubers", "metric": "count", "pageSize": "20"})
rows, _options, _base, _reset, changes, replacements = captured[0][3:9]
assert [row["range_id"] for row in rows] == ["7d"]
assert [change["rangeId"] for change in changes] == ["7d"]
assert replacements == ()
module._overlay_vtuber_replacement_rows = real_exact

# SQL candidate values honour both niche and unknown-artist gates before the
# aggregate query; this does not need a schema/index migration.
class Connection:
    def cursor(self): return object()
seen = []
def sql_rows(_connection, sql, params):
    seen.append((sql, params))
    assert "CREATE INDEX" not in sql and "jsonb_array_elements_text" not in sql
    assert "affected_parent_videos AS MATERIALIZED" in sql
    values = json.loads(params[5])
    assert [(item["video_id"], item["song_key"]) for item in values] == [("known", "known")]
    return [{"channel_id": "UC1", "row_count": 1, "video_count": 1, "song_count": 1}]
module._rows = sql_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
module._overlay_vtuber_replacement_rows(Connection(), "filters", "parent", [candidate("known", "known", "all"), candidate("unknown", "unknown", "all", artist=""), candidate("broad", "broad", "all", niche=False)], module._query_options({"range": "all", "view": "vtubers", "nicheOnly": "1", "hideUnknownArtist": "1"}), {}, (), (), (), {})
assert len(seen) == 1, seen
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
candidate = {"revision_id": "accepted", "video_id": "video-a", "occurrence_id": "occ-a", "position": 0, "range_id": "all", "song_key": "song-a", "seconds": 18, "title": "Song", "artist": "Artist", "channel_id": "UC1", "channel_handle": "@one", "video_tombstone": False, "video_payload_json": {"videoId": "video-a", "channelId": "UC1", "channelName": "Channel", "channelHandle": "@one", "thumbnailUrl": "https://i.ytimg.com/vi/video-a/hqdefault.jpg"}, "occurrence_payload_json": {"videoId": "video-a", "occurrenceId": "occ-a", "position": 0, "songKey": "song-a", "seconds": 18, "title": "Song", "artist": "Artist"}}
range_calls = []
def vtuber_rows(_connection, sql, params):
    assert "range_values AS MATERIALIZED" in sql
    assert "JOIN range_values AS scope" in sql
    assert params[4] in (["all", ""], ["7d", ""]), params
    range_calls.append(params[4])
    count = 1 if params[4][0] == "all" else 0
    return [{"channel_id": "UC1", "row_count": count,
      "video_count": count, "song_count": count}]
module._rows = vtuber_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
for public_range in ("all", "7d"):
    module._overlay_vtuber_replacement_rows(Connection(), "active", "parent", [candidate], {"range": public_range}, {})
assert range_calls == [["all", ""], ["7d", ""]]

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
    module._generic_song_source_payload(
        object(), "parent",
        {"type": "song", "key": "song::artist", "title": "Song",
            "artist": "Artist", "sourceDetailKey": "source"},
        "source", {"page": "1"}, ["accepted"],
    )
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

test("exact VTuber handles resolve only one immutable channel and reject URL contamination", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

assert module._exact_vtuber_handle_query({
  "view": "vtubers", "q": "@UTANOch", "searchScope": "all",
  "searchFields": ["channel"],
}) == "utanoch"
assert module._exact_vtuber_handle_query({
  "view": "vtubers", "q": "/@kanaruhanon", "searchScope": "channel",
  "searchFields": None,
}) == "kanaruhanon"
for malformed in (
    "UTANOch", "@@UTANOch", "@UTANOch @extra",
    "@UTANOch https://youtube.com/@extra", "/channel/UTANOch",
):
    assert module._exact_vtuber_handle_query({
      "view": "vtubers", "q": malformed, "searchScope": "all",
      "searchFields": ["channel"],
    }) is None

calls = []
def rows(_connection, sql, params):
    calls.append((sql, params))
    assert "LIMIT %s" in sql and params[-1] == 3, (sql, params)
    assert "runtime_identity_rows AS MATERIALIZED" in sql
    assert params[2:5] == [module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1] * 3
    assert "channel_url" not in sql.lower(), sql
    handle = params[0]
    if handle == "utanoch":
        return [{"channel_id": "UCNskpCCH661BeRJkN8n8d-A"}]
    if handle == "kanaruhanon":
        return [{"channel_id": "UCay6Y3oEoiC6ZEE2G0UZu_A"}]
    if handle == "ambiguous":
        return [{"channel_id": "UCONE"}, {"channel_id": "UCTWO"}]
    return []
module._rows = rows

utano = module._resolve_exact_vtuber_channel_scope(
  object(), "parent", ["overlay-a"], {
    "view": "vtubers", "range": "all", "metric": "count",
    "q": "@UTANOch", "searchScope": "all", "searchFields": ["channel"],
  },
)
hanon = module._resolve_exact_vtuber_channel_scope(
  object(), "parent", ["overlay-a"], {
    "view": "vtubers", "range": "all", "metric": "count",
    "q": "@kanaruhanon", "searchScope": "all", "searchFields": ["channel"],
  },
)
missing = module._resolve_exact_vtuber_channel_scope(
  object(), "parent", ["overlay-a"], {
    "view": "vtubers", "range": "all", "metric": "count",
    "q": "@missing", "searchScope": "all", "searchFields": ["channel"],
  },
)
assert utano == ("UCNskpCCH661BeRJkN8n8d-A",), utano
assert hanon == ("UCay6Y3oEoiC6ZEE2G0UZu_A",), hanon
assert missing == (), missing
try:
    module._resolve_exact_vtuber_channel_scope(
      object(), "parent", ["overlay-a"], {
        "view": "vtubers", "range": "all", "metric": "count",
        "q": "@ambiguous", "searchScope": "all", "searchFields": ["channel"],
      },
    )
except module.PostgresAdapterError as error:
    assert str(error) == "exact VTuber handle resolved to multiple channel identities"
else:
    raise AssertionError("ambiguous exact handle did not fail closed")
assert len(calls) == 4
print("OK")
`);
  assert.equal(output, "OK");
});

test("exact handle filtering keeps SQL aggregation scoped and preserves one same-source preview tuple", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self): return object()

def candidate(video_id, occurrence_id, channel_id, handle, title, seconds):
    thumbnail = "https://i.ytimg.com/vi/" + video_id + "/hqdefault.jpg"
    return {
      "revision_id": "accepted", "video_id": video_id,
      "occurrence_id": occurrence_id, "position": 0, "range_id": "all",
      "song_key": title.lower(), "title": title, "artist": "Artist",
      "seconds": seconds, "channel_id": channel_id, "channel_name": handle,
      "channel_handle": handle, "channel_url": "https://www.youtube.com/" + handle,
      "video_tombstone": False,
      "video_payload_json": {
        "videoId": video_id, "title": "Video " + title,
        "channelId": channel_id, "channelName": handle,
        "channelHandle": handle,
        "channelUrl": "https://www.youtube.com/" + handle,
        "thumbnailUrl": thumbnail,
      },
      "occurrence_payload_json": {
        "videoId": video_id, "occurrenceId": occurrence_id,
        "position": 0, "rangeId": "all", "songKey": title.lower(),
        "seconds": seconds, "title": title, "artist": "Artist",
      },
    }

utano_id = "UCNskpCCH661BeRJkN8n8d-A"
hanon_id = "UCay6Y3oEoiC6ZEE2G0UZu_A"
utano = candidate("utano-video", "utano-occ", utano_id, "@UTANOch", "Utano Song", 17)
hanon = candidate("hanon-video", "hanon-occ", hanon_id, "@kanaruhanon", "Hanon Song", 23)
wrong = candidate("wrong-video", "wrong-occ", "UCWRONG", "@shin", "Wrong Song", 29)
# URL text is deliberately contaminated; immutable handle/id must still win.
wrong["channel_url"] = "https://www.youtube.com/@UTANOch"
wrong["video_payload_json"]["channelUrl"] = "https://www.youtube.com/@UTANOch"

seen = []
expected_scope = utano_id
def rows(_connection, sql, params):
    if "FROM runtime_videos" in sql and "affected_parent_videos" not in sql:
        raise AssertionError("exact handle fell back to legacy parent payload fetch")
    if "bounded_parent_occurrences" in sql:
        seen.append((sql, params))
        assert params[0] == [expected_scope], params[0]
        assert params[4] == ["all", ""], params[4]
        assert set(zip(params[2], params[3])) == set()
        assert "ORDER BY v.video_id" in sql and "ORDER BY o.video_id, o.occurrence_id" in sql
        assert params[8] == params[10] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        return [
          {
            "channel_id": "", "row_count": 0, "video_count": 0,
            "song_count": 0, "residual_match": False,
            "parent_video_count": 0, "parent_occurrence_count": 0,
          },
          {
            "channel_id": expected_scope, "row_count": 1, "video_count": 1,
            "song_count": 1, "residual_match": True,
            "parent_video_count": 0, "parent_occurrence_count": 0,
          },
        ]
    raise AssertionError(sql)
module._rows = rows
module._VTUBER_REPLACEMENT_CACHE.clear()

base = {
  utano_id: {"payload_json": {
    "type": "vtuber", "key": utano_id, "channelId": utano_id,
    "channelHandle": "@UTANOch", "channelName": "UTANO",
    "count": 1, "songCount": 1, "videoCount": 1,
    "timestampCount": 1, "occurrences": [],
  }},
}
exact = module._overlay_vtuber_replacement_rows(
  Connection(), "active-utano", "parent", [utano, hanon, wrong],
  {"range": "all", "q": "@utanoch", "searchScope": "all",
   "searchFields": ["channel"], "metric": "count"},
  base, (), (), (), {}, True, (utano_id,),
)
assert set(exact) == {utano_id}, exact
card = exact[utano_id]["payload_json"]
assert (card["count"], card["songCount"], card["videoCount"], card["timestampCount"]) == (1, 1, 1, 1)
assert len(card["occurrences"]) == 1
preview = card["occurrences"][0]
assert preview["videoId"] == preview["item"]["videoId"] == preview["video"]["videoId"] == "utano-video"
assert preview["item"]["channelId"] == preview["video"]["channelId"] == card["channelId"] == utano_id
assert preview["item"]["channelHandle"].casefold() == preview["video"]["channelHandle"].casefold() == "@utanoch"
assert "utano-video" in preview["item"]["thumbnailUrl"]
assert (preview["song"]["title"], preview["song"]["artist"], preview["song"]["seconds"]) == (
  "Utano Song", "Artist", 17,
)
module._canonicalize_vtuber_card_preview(card, utano_id)
assert len(seen) == 1

expected_scope = hanon_id
hanon_base = {
  hanon_id: {"payload_json": {
    "type": "vtuber", "key": hanon_id, "channelId": hanon_id,
    "channelHandle": "@kanaruhanon", "channelName": "Hanon",
    "count": 1, "songCount": 1, "videoCount": 1,
    "timestampCount": 1, "occurrences": [],
  }},
}
exact_hanon = module._overlay_vtuber_replacement_rows(
  Connection(), "active-hanon", "parent", [utano, hanon, wrong],
  {"range": "all", "q": "@kanaruhanon", "searchScope": "all",
   "searchFields": ["channel"], "metric": "count"},
  hanon_base, (), (), (), {}, True, (hanon_id,),
)
assert set(exact_hanon) == {hanon_id}, exact_hanon
hanon_card = exact_hanon[hanon_id]["payload_json"]
hanon_preview = hanon_card["occurrences"][0]
assert (hanon_card["count"], hanon_card["songCount"], hanon_card["videoCount"],
        hanon_card["timestampCount"]) == (1, 1, 1, 1)
assert hanon_preview["videoId"] == hanon_preview["item"]["videoId"] == "hanon-video"
assert hanon_preview["item"]["channelId"] == hanon_preview["video"]["channelId"] == hanon_id
assert "hanon-video" in hanon_preview["item"]["thumbnailUrl"]
assert (hanon_preview["song"]["title"], hanon_preview["song"]["artist"],
        hanon_preview["song"]["seconds"]) == ("Hanon Song", "Artist", 23)
module._canonicalize_vtuber_card_preview(hanon_card, hanon_id)
assert len(seen) == 2
print("OK")
`);
  assert.equal(output, "OK");
});

test("E v21 mixed VTuber handle extraction is strict and preserves residual search semantics", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

mixed = module._vtuber_handle_query_parts({
  "view": "vtubers", "q": "@ShinGames7857 全力キング",
  "searchScope": "all", "searchFields": ["title", "channel"],
})
assert mixed is not None
assert mixed["handle"] == "shingames7857"
assert mixed["residualTokens"] == ("全力キング",)
assert mixed["searchFields"] == ("title", "channel")
assert module._exact_vtuber_handle_query({
  "view": "vtubers", "q": "@ShinGames7857 全力キング",
  "searchScope": "all", "searchFields": ["title", "channel"],
}) == "shingames7857"

pure = module._vtuber_handle_query_parts({
  "view": "vtubers", "q": "/@UTANOch",
  "searchScope": "channel", "searchFields": None,
})
assert pure["handle"] == "utanoch" and pure["residualTokens"] == ()
all_fields = module._vtuber_handle_query_parts({
  "view": "vtubers", "q": "@UTANOch Song",
  "searchScope": "all", "searchFields": ["all"],
})
assert all_fields["handle"] == "utanoch"
assert all_fields["residualTokens"] == ("song",)

# Ordinary text, the real songs API view, title-only fields, malformed handles,
# a second handle, and embedded URLs retain ordinary semantics or fail closed.
for query in (
  {"view": "vtubers", "q": "全力キング", "searchScope": "all",
   "searchFields": ["title", "channel"]},
  {"view": "songs", "q": "@ShinGames7857 全力キング", "searchScope": "all",
   "searchFields": ["title", "channel"]},
  {"view": "vtubers", "q": "@ShinGames7857 全力キング", "searchScope": "all",
   "searchFields": ["title"]},
  {"view": "vtubers", "q": "@@ShinGames7857 全力キング", "searchScope": "all",
   "searchFields": ["title", "channel"]},
  {"view": "vtubers", "q": "@ShinGames7857 @other", "searchScope": "all",
   "searchFields": ["title", "channel"]},
  {"view": "vtubers", "q": "@ShinGames7857 ＠other", "searchScope": "all",
   "searchFields": ["title", "channel"]},
  {"view": "vtubers", "q": "@ShinGames7857 https://youtube.com/watch?v=x",
   "searchScope": "all", "searchFields": ["title", "channel"]},
):
    assert module._vtuber_handle_query_parts(query) is None, query

calls = []
def rows(_connection, sql, params):
    calls.append((sql, params))
    assert "channel_url" not in sql.lower()
    assert "ORDER BY channel_id" in sql and "LIMIT %s" in sql
    if params[0] == "shingames7857":
        return [{"channel_id": "UC-SHIN"}]
    if params[0] == "missing":
        return []
    if params[0] == "ambiguous":
        return [{"channel_id": "UC-A"}, {"channel_id": "UC-B"}]
    raise AssertionError(params)

module._rows = rows
assert module._resolve_exact_vtuber_channel_scope(
  object(), "parent", ["accepted"], {
    "view": "vtubers", "range": "all", "metric": "count",
    "q": "@ShinGames7857 全力キング", "searchScope": "all",
    "searchFields": ["title", "channel"],
  },
) == ("UC-SHIN",)
assert module._resolve_exact_vtuber_channel_scope(
  object(), "parent", ["accepted"], {
    "view": "vtubers", "range": "all", "metric": "count",
    "q": "@missing Wrong", "searchScope": "all",
    "searchFields": ["title", "channel"],
  },
) == ()
try:
    module._resolve_exact_vtuber_channel_scope(
      object(), "parent", ["accepted"], {
        "view": "vtubers", "range": "all", "metric": "count",
        "q": "@ambiguous Song", "searchScope": "all",
        "searchFields": ["title", "channel"],
      },
    )
    raise AssertionError("ambiguous mixed handle did not fail closed")
except module.PostgresAdapterError:
    pass
assert len(calls) == 3

# Handle-shaped malformed input is a distinct fail-closed state: it must not
# reach even lineage discovery, much less the legacy multi-channel rebuild.
module._overlay_revision_ids = lambda *_: (_ for _ in ()).throw(
  AssertionError("malformed handle reached overlay lineage SQL")
)
for malformed_q in (
  "@@ShinGames7857 е…ЁеЉ›г‚­гѓіг‚°",
  "@ShinGames7857 @other",
  "@ShinGames7857 ＠other",
  "@ShinGames7857 https://youtube.com/watch?v=x",
):
    malformed_options = module._query_options({
      "range": "all", "view": "vtubers", "metric": "count",
      "q": malformed_q, "searchFields": "title,channel",
    })
    prepared = module._prepare_generic_overlay_rankings(
      object(), "active", ("parent", {}), malformed_options,
    )
    assert prepared["filtered"] == ()

# Residual title text retains the ordinary query normalization contract; only
# the leading handle identity is NFKC-normalized.
fullwidth_title = module._vtuber_handle_query_parts({
  "view": "vtubers", "q": "＠UTANOch Ｓｏｎｇ",
  "searchScope": "all", "searchFields": ["title", "channel"],
})
assert fullwidth_title["handle"] == "utanoch"
assert fullwidth_title["residualTokens"] == ("ｓｏｎｇ",)
assert module._sql_like_literal(r"50%_done\\x") == r"50\\%\\_done\\\\x"
print("OK")
`);
  assert.equal(output, "OK");
});

test("E v21 channel move keeps a coherent old handle only while old tuples remain", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self): return object()

old_id = "UC-OLD"
new_id = "UC-NEW"
runtime_tombstone_loader = module._runtime_tombstones
runtime_replacement_builder = module._runtime_replacement_candidate_rows
channel_resolver = module._resolve_exact_vtuber_channel_scope
base = {
  old_id: {
    "detail_key": old_id,
    "payload_json": {
      "type": "vtuber", "key": old_id, "channelId": old_id,
      "channelHandle": "@old_handle", "channelName": "Old Channel",
      "count": 2, "songCount": 2, "videoCount": 2,
      "timestampCount": 2, "occurrences": [],
    },
  },
}
move = {
  "entityType": "videos", "videoId": "moved-video", "channel_id": old_id,
  "channel_handle": "@old_handle",
  "videoPayload": {
    "videoId": "moved-video", "channelId": old_id,
    "channelHandle": "@old_handle", "channelName": "Old Channel",
  },
}

summary_count = 1
def rows(_connection, sql, params):
    assert "FROM runtime_videos" not in sql or "affected_parent_videos" in sql
    assert "FROM runtime_occurrences" not in sql or "parent_occurrences" in sql or "fast_parent_occurrences" in sql
    if "bounded_parent_occurrences" in sql:
        return [
          {
            "channel_id": "", "row_count": 0, "video_count": 0,
            "song_count": 0, "residual_match": False,
            "parent_video_count": 2,
            "parent_occurrence_count": summary_count,
          },
          {
            "channel_id": old_id, "row_count": summary_count,
            "video_count": summary_count, "song_count": summary_count,
            "residual_match": True,
            "parent_video_count": 2,
            "parent_occurrence_count": summary_count,
          },
        ]
    raise AssertionError(sql)

module._rows = rows
module._VTUBER_REPLACEMENT_CACHE.clear()
positive = module._overlay_vtuber_replacement_rows(
  Connection(), "active-old-positive", "parent", [],
  {"range": "all", "view": "vtubers", "q": "@old_handle",
   "searchScope": "all", "searchFields": ["channel"], "metric": "count"},
  base, [move], (), (), {"moved-video": {"channel_id": "UC-NEW"}},
  True, (old_id,),
)
assert positive[old_id]["row_count"] == 1
assert positive[old_id]["payload_json"]["channelHandle"] == "@old_handle"
assert "@old_handle" in positive[old_id]["channel_search_text"]

summary_count = 0
module._VTUBER_REPLACEMENT_CACHE.clear()
zero = module._overlay_vtuber_replacement_rows(
  Connection(), "active-old-zero", "parent", [],
  {"range": "all", "view": "vtubers", "q": "@old_handle",
   "searchScope": "all", "searchFields": ["channel"], "metric": "count"},
  base, [move], (), (), {"moved-video": {"channel_id": "UC-NEW"}},
  True, (old_id,),
)
assert zero[old_id]["row_count"] == 0

bad_base = {
  old_id: {
    "detail_key": old_id,
    "payload_json": {
      "channelId": "UC-OTHER", "channelHandle": "@old_handle",
      "channelName": "Wrong Channel", "occurrences": [],
    },
  },
}
summary_count = 1
module._VTUBER_REPLACEMENT_CACHE.clear()
try:
    module._overlay_vtuber_replacement_rows(
      Connection(), "active-old-conflict", "parent", [],
      {"range": "all", "view": "vtubers", "q": "@old_handle",
       "searchScope": "all", "searchFields": ["channel"], "metric": "count"},
      bad_base, [move], (), (), {"moved-video": {"channel_id": "UC-NEW"}},
      True, (old_id,),
    )
    raise AssertionError("cross-channel base metadata was backfilled")
except module.PostgresAdapterError:
    pass

# Exercise the real prepare caller.  The base mock returns only columns named
# by the SELECT, so this fails if the single-channel branch forgets to request
# payload_json before rebuilding the old side of a channel move.
module._overlay_revision_ids = lambda *_: ["accepted"]
module._overlay_candidate_rows = lambda *_: []
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: [dict(move)]
module._runtime_tombstones = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: (_ for _ in ()).throw(
  AssertionError("VTuber exact path reached generic original-group SQL")
)
module._runtime_replacement_candidate_rows = lambda *_: []
module._channel_metadata_rows = lambda *_: []
module._resolve_exact_vtuber_channel_scope = lambda *_: (old_id,)

def prepare_rows(_connection, sql, params):
    if "SELECT video_id" in sql and "FROM runtime_videos" in sql:
        assert "channel_id = ANY(%s)" in sql
        assert "ORDER BY video_id" in sql and "LIMIT %s" in sql
        return [{"video_id": "moved-video"}, {"video_id": "remaining-video"}]
    if "FROM runtime_ranking_rows" in sql:
        assert "payload_json" in sql and "detail_key = ANY(%s)" in sql
        return [dict(base[old_id])]
    if "bounded_parent_occurrences" in sql:
        return [
          {
            "channel_id": "", "row_count": 0, "video_count": 0,
            "song_count": 0, "residual_match": False,
            "parent_video_count": 2, "parent_occurrence_count": summary_count,
          },
          {
            "channel_id": old_id, "row_count": summary_count,
            "video_count": summary_count, "song_count": summary_count,
            "residual_match": True,
            "parent_video_count": 2, "parent_occurrence_count": summary_count,
          },
        ]
    raise AssertionError(sql)

module._rows = prepare_rows
summary_count = 1
module._VTUBER_REPLACEMENT_CACHE.clear()
prepared_positive = module._prepare_generic_overlay_rankings(
  Connection(), "active-prepare-old-positive", ("parent", {}),
  module._query_options({
    "range": "all", "view": "vtubers", "metric": "count",
    "q": "@old_handle", "searchFields": "channel",
  }),
)
assert len(prepared_positive["filtered"]) == 1
prepared_old = prepared_positive["filtered"][0]
assert prepared_old["detail_key"] == old_id
assert prepared_old["payload_json"]["channelHandle"] == "@old_handle"
assert "@old_handle" in prepared_old["channel_search_text"]

summary_count = 0
module._VTUBER_REPLACEMENT_CACHE.clear()
prepared_zero = module._prepare_generic_overlay_rankings(
  Connection(), "active-prepare-old-zero", ("parent", {}),
  module._query_options({
    "range": "all", "view": "vtubers", "metric": "count",
    "q": "@old_handle", "searchFields": "channel",
  }),
)
assert prepared_zero["filtered"] == ()

# A raw runtime channel move is selected by immutable channelId on both sides.
# The old-side change keeps its own identity; the new-side replacement exposes
# only the new channel/video tuple.
raw_move = {
  "revision_id": "curation", "entity_type": "runtime_occurrences",
  "entity_key": "move-occ", "source_system": "curation",
  "range_id": "all", "source_id": "move", "occurrence_id": "move-occ",
  "tombstone": False,
  "payload_json": {
    "videoId": "new-video", "occurrenceId": "move-occ",
    "rangeId": "all", "title": "Moved Song", "artist": "Moved Artist",
    "seconds": 42, "channelId": new_id, "channelHandle": "@new_handle",
    "channelName": "New Channel",
    "originalIdentity": {
      "videoId": "old-video", "occurrenceId": "move-occ",
      "rangeId": "all", "title": "Old Song", "artist": "Moved Artist",
      "seconds": 42, "channelId": old_id, "channelHandle": "@old_handle",
      "channelName": "Old Channel",
    },
  },
}

def runtime_resolver_rows(_connection, sql, params):
    assert "runtime_handle_seed_rows AS MATERIALIZED" in sql
    assert "runtime_identity_rows AS MATERIALIZED" in sql
    assert "runtime_identities AS MATERIALIZED" in sql
    assert "replacementPayload" in sql and "replacementVideoPayload" in sql
    assert "originalIdentity" in sql and "channel_url" not in sql.lower()
    assert params[1] == ["curation"]
    assert params[2:5] == [module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1] * 3
    if params[0] == "new_handle":
        return [
          {"channel_id": "", "runtime_row_count": 1},
          {"channel_id": new_id, "runtime_row_count": 1},
        ]
    if params[0] == "conflict_handle":
        return [
          {"channel_id": "", "runtime_row_count": 2},
          {"channel_id": "UC-A", "runtime_row_count": 2},
          {"channel_id": "UC-B", "runtime_row_count": 2},
        ]
    if params[0] == "missing_handle":
        return [{"channel_id": "", "runtime_row_count": 1}]
    raise AssertionError(params[0])

module._rows = runtime_resolver_rows
resolved_new = channel_resolver(
  object(), "parent", ["curation"],
  {"range": "all", "view": "vtubers", "metric": "count",
   "q": "@new_handle Moved Song", "searchScope": "all",
   "searchFields": ["title", "channel"]},
)
assert resolved_new == (new_id,)
assert channel_resolver(
  object(), "parent", ["curation"],
  {"range": "all", "view": "vtubers", "metric": "count",
   "q": "@missing_handle Moved Song", "searchScope": "all",
   "searchFields": ["title", "channel"]},
) == ()
try:
    channel_resolver(
      object(), "parent", ["curation"],
      {"range": "all", "view": "vtubers", "metric": "count",
       "q": "@conflict_handle Moved Song", "searchScope": "all",
       "searchFields": ["title", "channel"]},
    )
    raise AssertionError("runtime handle identity conflict did not fail closed")
except module.PostgresAdapterError:
    pass

def raw_move_rows(_connection, sql, params):
    assert "FROM migration_runtime_rows" in sql
    assert "originalIdentity" in sql and "replacementPayload" in sql
    assert "channel_url" not in sql.lower()
    return [dict(raw_move)]

module._rows = raw_move_rows
old_changes = runtime_tombstone_loader(
  object(), ["curation"], [], [], True, "parent", (old_id,),
  ("old-video",),
)
new_changes = runtime_tombstone_loader(
  object(), ["curation"], [], [], True, "parent", (new_id,),
  (),
)
assert len(old_changes) == len(new_changes) == 1
assert old_changes[0]["channelId"] == old_id
new_replacements = runtime_replacement_builder(new_changes, True)
assert len(new_replacements) == 1
new_replacement = new_replacements[0]
assert (
  new_replacement["video_id"], new_replacement["channel_id"],
  new_replacement["title"], new_replacement["artist"],
  new_replacement["seconds"], new_replacement["channel_handle"],
) == (
  "new-video", new_id, "Moved Song", "Moved Artist", 42, "@new_handle",
)

def new_side_rows(_connection, sql, params):
    assert "bounded_parent_occurrences" in sql
    return [
      {
        "channel_id": "", "row_count": 0, "video_count": 0,
        "song_count": 0, "residual_match": False,
        "parent_video_count": 0, "parent_occurrence_count": 0,
      },
      {
        "channel_id": new_id, "row_count": 1, "video_count": 1,
        "song_count": 1, "residual_match": True,
        "parent_video_count": 0, "parent_occurrence_count": 0,
      },
    ]

module._rows = new_side_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
new_side = module._overlay_vtuber_replacement_rows(
  Connection(), "active-new-side", "parent", [],
  {"range": "all", "view": "vtubers", "q": "@new_handle Moved Song",
   "searchScope": "all", "searchFields": ["title", "channel"],
   "metric": "count"},
  {}, (), new_changes, new_replacements, {}, True, resolved_new,
)
new_card = new_side[new_id]["payload_json"]
assert new_card["channelHandle"] == "@new_handle"
new_occurrence = new_card["occurrences"][0]
assert (
  new_occurrence["item"]["videoId"], new_occurrence["item"]["channelId"],
  new_occurrence["song"]["title"], new_occurrence["song"]["artist"],
  new_occurrence["song"]["seconds"],
) == ("new-video", new_id, "Moved Song", "Moved Artist", 42)
print("OK")
`);
  assert.equal(output, "OK");
});

test("E v23 resolver seeds handle before cap and follows newest runtime video lineage", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

cap = module._MAX_AFFECTED_RUNTIME_OCCURRENCES
observed = {}
runtime_rows = []

def identity_slots(payload):
    nested = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    return [
      payload,
      nested,
      payload.get("originalIdentity") or {},
      nested.get("originalIdentity") or {},
      payload.get("replacementPayload") or {},
      nested.get("replacementPayload") or {},
      payload.get("replacementVideoPayload") or {},
      nested.get("replacementVideoPayload") or {},
    ]

def normalized_handle(value):
    return str(value or "").lower().lstrip("/@")

def entity_kind(row):
    return (
      "videos"
      if row["entity_type"] in {"videos", "runtime_videos"}
      else "occurrences"
    )

def video_ids(row):
    values = {
      str(slot.get("videoId") or "")
      for slot in identity_slots(row["payload"])
      if slot.get("videoId")
    }
    if row["entity_type"] in {"videos", "runtime_videos"}:
        values.add(row["entity_key"])
    return {value for value in values if value}

def effective_identity(row):
    payload = row["payload"]
    nested = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    candidates = [
      payload.get("replacementVideoPayload") or {},
      nested.get("replacementVideoPayload") or {},
      payload.get("replacementPayload") or {},
      nested.get("replacementPayload") or {},
      payload,
      nested,
    ]
    for candidate in candidates:
        if all(candidate.get(name) for name in ("videoId", "channelId", "channelHandle")):
            return candidate
    return {}

def evaluate(rows, lineage, handle):
    order = {revision_id: index for index, revision_id in enumerate(lineage)}
    seeds = [
      row for row in rows
      if any(
        slot.get("channelId")
        and normalized_handle(slot.get("channelHandle")) == handle
        for slot in identity_slots(row["payload"])
      )
    ]
    seeds.sort(key=lambda row: (
      order[row["revision_id"]], row["entity_type"], row["entity_key"],
    ))
    seeds = seeds[:cap + 1]
    seed_keys = {(row["entity_type"], row["entity_key"]) for row in seeds}
    seed_videos = set().union(*(video_ids(row) for row in seeds)) if seeds else set()
    candidate_video_count = min(len(seed_videos), cap + 1)
    chain = [
      row for row in rows
      if (row["entity_type"], row["entity_key"]) in seed_keys
      or bool(video_ids(row).intersection(seed_videos))
    ]
    chain.sort(key=lambda row: (
      order[row["revision_id"]], row["entity_type"], row["entity_key"],
    ))
    chain = chain[:cap + 1]
    guard = max(len(seeds), candidate_video_count, len(chain))
    observed[handle] = {
      "global": len(rows), "seed": len(seeds), "chain": len(chain), "guard": guard,
    }
    if guard > cap:
        return [], guard
    newest_entity_order = {}
    for row in chain:
        key = (entity_kind(row), row["entity_key"])
        newest_entity_order[key] = min(
          newest_entity_order.get(key, cap + 1),
          order[row["revision_id"]],
        )
    latest = [
      row for row in chain
      if order[row["revision_id"]]
      == newest_entity_order[(entity_kind(row), row["entity_key"])]
    ]
    video_events = [
      (order[row["revision_id"]], video_id)
      for row in latest
      if entity_kind(row) == "videos"
      for video_id in video_ids(row)
    ]
    channels = set()
    for row in latest:
        identity = effective_identity(row)
        row_order = order[row["revision_id"]]
        suppressed = any(
          video_id == identity.get("videoId")
          and (
            video_order < row_order
            or (video_order == row_order and entity_kind(row) != "videos")
          )
          for video_order, video_id in video_events
        )
        if (
          not row["tombstone"]
          and not suppressed
          and normalized_handle(identity.get("channelHandle")) == handle
        ):
            channels.add(identity["channelId"])
    return sorted(channels), guard

def rows(_connection, sql, params):
    requested = sql.index("requested AS MATERIALIZED")
    lineage = sql.index("overlay_lineage AS MATERIALIZED")
    seed = sql.index("runtime_handle_seed_rows AS MATERIALIZED")
    chain = sql.index("runtime_identity_rows AS MATERIALIZED")
    latest = sql.index("runtime_latest_entity_order AS MATERIALIZED")
    final_identity = sql.index("runtime_identities AS MATERIALIZED")
    assert requested < lineage < seed < chain < latest < final_identity
    seed_sql = sql[seed:sql.index("runtime_handle_seed_guard AS MATERIALIZED")]
    assert seed_sql.index("requested.normalized_handle") < seed_sql.rindex("LIMIT %s")
    chain_sql = sql[chain:sql.index("runtime_identity_guard AS MATERIALIZED")]
    assert "runtime_candidate_entity_keys" in chain_sql
    assert "runtime_candidate_video_ids" in chain_sql
    assert "requested.normalized_handle" not in chain_sql
    assert "WITH ORDINALITY" in sql
    assert "min(lineage_order)" in sql
    assert "ORDER BY lineage.lineage_order, runtime.entity_type, runtime.entity_key" in sql
    assert params[1] == ["new", "old"]
    assert params[2:5] == [cap + 1, cap + 1, cap + 1]
    channels, guard = evaluate(runtime_rows, params[1], params[0])
    return (
      [{"channel_id": "", "runtime_row_count": guard}]
      + [
        {"channel_id": channel_id, "runtime_row_count": guard}
        for channel_id in channels
      ]
    )

def resolve(handle):
    return module._resolve_exact_vtuber_channel_scope(
      object(), "parent", ["new", "old"],
      {
        "range": "all", "view": "vtubers", "metric": "count",
        "q": "@" + handle, "searchScope": "all",
        "searchFields": ["channel"],
      },
    )

module._rows = rows

# 50,001 unrelated rows do not enter the target seed or its complete chain.
runtime_rows = [
  {
    "revision_id": "old", "entity_type": "runtime_occurrences",
    "entity_key": "unrelated-" + str(index), "tombstone": False,
    "payload": {
      "videoId": "unrelated-video-" + str(index),
      "channelId": "UC-UNRELATED-" + str(index),
      "channelHandle": "@unrelated_" + str(index),
    },
  }
  for index in range(cap + 1)
]
runtime_rows.append({
  "revision_id": "old", "entity_type": "runtime_videos",
  "entity_key": "target-video", "tombstone": False,
  "payload": {
    "videoId": "target-video", "channelId": "UC-TARGET",
    "channelHandle": "@target_handle",
  },
})
assert resolve("target_handle") == ("UC-TARGET",)
assert observed["target_handle"] == {
  "global": cap + 2, "seed": 1, "chain": 1, "guard": 1,
}

# A newer row for the same video/entity moves away from the target handle.
runtime_rows = [
  {
    "revision_id": "old", "entity_type": "runtime_videos",
    "entity_key": "moved-video", "tombstone": False,
    "payload": {
      "videoId": "moved-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
  {
    "revision_id": "new", "entity_type": "runtime_videos",
    "entity_key": "moved-video", "tombstone": False,
    "payload": {
      "videoId": "moved-video", "channelId": "UC-OTHER",
      "channelHandle": "@other_handle",
      "originalIdentity": {
        "videoId": "moved-video", "channelId": "UC-TARGET",
        "channelHandle": "@target_handle",
      },
    },
  },
]
assert resolve("target_handle") == ()
assert observed["target_handle"]["seed"] == 2
assert observed["target_handle"]["chain"] == 2

# An occurrence move removes only that chain.  A sibling occurrence keeps the
# runtime-only old handle, while the moved chain exposes its new handle.
runtime_rows = [
  {
    "revision_id": "old", "entity_type": "runtime_occurrences",
    "entity_key": "sibling-occ", "tombstone": False,
    "payload": {
      "videoId": "shared-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
  {
    "revision_id": "old", "entity_type": "runtime_occurrences",
    "entity_key": "moved-occ", "tombstone": False,
    "payload": {
      "videoId": "shared-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
  {
    "revision_id": "new", "entity_type": "runtime_occurrences",
    "entity_key": "moved-occ", "tombstone": False,
    "payload": {
      "videoId": "new-video", "channelId": "UC-OTHER",
      "channelHandle": "@other_handle",
      "originalIdentity": {
        "videoId": "shared-video", "channelId": "UC-TARGET",
        "channelHandle": "@target_handle",
      },
    },
  },
]
assert resolve("target_handle") == ("UC-TARGET",)
assert resolve("other_handle") == ("UC-OTHER",)

# An occurrence tombstone cannot erase a live sibling on the same video.
runtime_rows = [
  {
    "revision_id": "old", "entity_type": "runtime_occurrences",
    "entity_key": "live-sibling", "tombstone": False,
    "payload": {
      "videoId": "tombstone-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
  {
    "revision_id": "new", "entity_type": "runtime_occurrences",
    "entity_key": "deleted-occ", "tombstone": True,
    "payload": {
      "videoId": "tombstone-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
]
assert resolve("target_handle") == ("UC-TARGET",)

# A video-level tombstone does suppress every older occurrence identity.
runtime_rows.append({
  "revision_id": "new", "entity_type": "runtime_videos",
  "entity_key": "tombstone-video", "tombstone": True,
  "payload": {
    "originalIdentity": {
      "videoId": "tombstone-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
})
assert resolve("target_handle") == ()

# One target seed whose own video chain exceeds the cap remains fail-closed.
runtime_rows = [
  {
    "revision_id": "new", "entity_type": "runtime_videos",
    "entity_key": "large-target-video", "tombstone": False,
    "payload": {
      "videoId": "large-target-video", "channelId": "UC-TARGET",
      "channelHandle": "@target_handle",
    },
  },
] + [
  {
    "revision_id": "old", "entity_type": "runtime_occurrences",
    "entity_key": "large-chain-" + str(index), "tombstone": False,
    "payload": {
      "videoId": "large-target-video", "channelId": "UC-TARGET",
      "channelHandle": "@other_handle",
    },
  }
  for index in range(cap)
]
try:
    resolve("target_handle")
    raise AssertionError("target runtime chain over cap did not fail closed")
except module.PostgresAdapterError as error:
    assert str(error) == "exact VTuber runtime identity lookup exceeded bounded cap"
assert observed["target_handle"]["seed"] == 1
assert observed["target_handle"]["chain"] == cap + 1

# The requested handle's own candidate seed is independently capped.
runtime_rows = [
  {
    "revision_id": "new", "entity_type": "runtime_videos",
    "entity_key": "target-seed-" + str(index), "tombstone": False,
    "payload": {
      "videoId": "target-seed-" + str(index),
      "channelId": "UC-TARGET", "channelHandle": "@target_handle",
    },
  }
  for index in range(cap + 1)
]
try:
    resolve("target_handle")
    raise AssertionError("target runtime handle seed over cap did not fail closed")
except module.PostgresAdapterError as error:
    assert str(error) == "exact VTuber runtime identity lookup exceeded bounded cap"
assert observed["target_handle"]["seed"] == cap + 1

# Two newest immutable channel IDs for the same handle remain ambiguous.
runtime_rows = [
  {
    "revision_id": "new", "entity_type": "runtime_videos",
    "entity_key": "ambiguous-a", "tombstone": False,
    "payload": {
      "videoId": "ambiguous-a", "channelId": "UC-A",
      "channelHandle": "@target_handle",
    },
  },
  {
    "revision_id": "new", "entity_type": "runtime_videos",
    "entity_key": "ambiguous-b", "tombstone": False,
    "payload": {
      "videoId": "ambiguous-b", "channelId": "UC-B",
      "channelHandle": "@target_handle",
    },
  },
]
try:
    resolve("target_handle")
    raise AssertionError("ambiguous immutable runtime channels did not fail closed")
except module.PostgresAdapterError as error:
    assert str(error) == "exact VTuber handle resolved to multiple channel identities"

print("OK")
`);
  assert.equal(output, "OK");
});

test("E v21 real songRank click maps to songs and preserves the canonical occurrence tuple", () => {
  const appSource = fs.readFileSync(path.join(SUPPORT_ROOT, "assets", "app.js"), "utf8");
  const frontendUtilsSource = fs.readFileSync(
    path.join(SUPPORT_ROOT, "assets", "frontend-utils.js"),
    "utf8",
  );
  assert.match(
    appSource,
    /function apiViewForRequestView\(view\)[\s\S]*return "songs";/u,
  );
  assert.match(
    appSource,
    /function buildSearchUrlForSongGroup\(group\)[\s\S]*params\.set\("view", "songRank"\)[\s\S]*params\.set\("searchFields", query\.searchFields\.join\(","\)\)/u,
  );
  assert.match(
    frontendUtilsSource,
    /q: cleanText\(`\$\{handle\} \$\{title\}`\)[\s\S]*searchFields: \["title", "channel"\][\s\S]*identity: "handle"/u,
  );

  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

video = {
  "videoId": "canonical-video", "channelId": "UC-CANONICAL",
  "channelName": "Canonical Channel", "channelHandle": "@realhandle",
  "title": "Canonical Stream",
}
occurrence = {
  "videoId": "canonical-video", "occurrenceId": "canonical-occurrence",
  "title": "Real Song", "artist": "Real Artist", "seconds": 137,
  "item": dict(video), "video": dict(video),
}
vtuber_payload = {
  "type": "vtuber", "key": "UC-CANONICAL", "channelId": "UC-CANONICAL",
  "channelName": "Canonical Channel", "channelHandle": "@realhandle",
  "count": 1, "songCount": 1, "videoCount": 1,
  "timestampCount": 1, "occurrences": [dict(occurrence)],
}
song_payload = {
  "type": "song", "key": "real-song", "title": "Real Song",
  "displayArtist": "Real Artist", "count": 1, "songCount": 1,
  "videoCount": 1, "timestampCount": 1,
  "occurrences": [dict(occurrence)],
}

def rows(_connection, sql, params):
    assert "FROM runtime_ranking_rows" in sql
    view = params[2]
    payload = vtuber_payload if view == "vtubers" else song_payload
    return [{
      "rank": 1, "row_count": 1, "song_count": 1,
      "video_count": 1, "timestamp_count": 1,
      "payload_json": dict(payload),
      "search_text": "real song real artist canonical stream",
      "channel_search_text": "UC-CANONICAL @realhandle Canonical Channel",
    }]

module._rows = rows
module._channel_metadata_rows = lambda *_: []
card_response = module._runtime_rankings_payload(
  object(), "runtime",
  {"range": "all", "view": "vtubers", "metric": "count",
   "q": "@realhandle", "searchFields": "channel"},
)
assert len(card_response["records"]) == 1
card_occurrence = card_response["records"][0]["occurrences"][0]
card_video = card_occurrence["item"]
click_q = card_video["channelHandle"] + " " + card_occurrence["title"]
assert module._vtuber_handle_query_parts(module._query_options({
  "range": "all", "view": "songs", "q": click_q,
  "searchFields": "title,channel",
})) is None

songs_response = module._runtime_rankings_payload(
  object(), "runtime",
  {"range": "all", "view": "songs", "metric": "count",
   "q": click_q, "searchFields": "title,channel"},
)
assert songs_response["view"] == "songs"
assert len(songs_response["records"]) == 1
song_occurrence = songs_response["records"][0]["occurrences"][0]
song_video = song_occurrence["item"]
assert (
  song_video["videoId"], song_video["channelId"],
  song_occurrence["title"], song_occurrence["artist"],
  song_occurrence["seconds"],
) == (
  card_video["videoId"], card_video["channelId"],
  card_occurrence["title"], card_occurrence["artist"],
  card_occurrence["seconds"],
)

wrong_response = module._runtime_rankings_payload(
  object(), "runtime",
  {"range": "all", "view": "songs", "metric": "count",
   "q": "@shingames7857 全力キング",
   "searchFields": "title,channel"},
)
assert wrong_response["totalCount"] == 0
assert wrong_response["records"] == []
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic clicked song results retain only the resolved channel tuple", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def occurrence(video_id, channel_id):
    video = {
        "videoId": video_id,
        "channelId": channel_id,
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }
    return {
        "videoId": video_id,
        "occurrenceId": "occ-" + video_id,
        "title": "Shared Song",
        "artist": "Artist",
        "item": dict(video),
        "video": dict(video),
    }

def row(index):
    return {
        "detail_key": f"shared-{index}::artist",
        "title": f"Shared Song {index}",
        "artist": "Artist",
        "row_count": 2,
        "song_count": 1,
        "video_count": 2,
        "timestamp_count": 2,
        "payload_json": {
            "type": "song",
            "key": f"shared-{index}::artist",
            "title": f"Shared Song {index}",
            "displayArtist": "Artist",
            "occurrences": [
                occurrence(f"target-video-{index}", "UC-TARGET"),
                occurrence(f"wrong-video-{index}", "UC-WRONG"),
            ],
        },
    }

prepared = {
    "filtered": (row(1), row(2)),
    "metadata": (),
    "candidateRows": (),
    "parentRevisionId": "parent",
    "songChannelIds": ("UC-TARGET",),
}
module._hydrate_overlay_page_previews = lambda *_: None
def page(number):
    return module._render_generic_overlay_rankings(
      object(),
      prepared,
      {
        "range": "all",
        "view": "songs",
        "metric": "occurrences",
        "page": str(number),
        "pageSize": "1",
        "q": "@target Shared Song",
        "searchFields": "title,channel",
      },
    )

page_one = page(1)
page_two = page(2)
for payload in (page_one, page_two):
    assert payload["totalCount"] == 2
    assert payload["pageCount"] == 2
    assert payload["totalOccurrenceCount"] == 2
    assert payload["totalVideoCount"] == 2
    record = payload["records"][0]
    assert (record["count"], record["videoCount"], record["songCount"]) == (1, 1, 1)
    assert len(record["occurrences"]) == 1
    assert record["occurrences"][0]["item"]["channelId"] == "UC-TARGET"
    assert record["occurrences"][0]["item"] == record["occurrences"][0]["video"]
assert page_one["records"][0]["key"] != page_two["records"][0]["key"]

# Ranking payloads retain at most 20 global previews.  The resolved channel
# can be absent from all of them even though the full canonical group has more
# than 20 matching target tuples.  Count from one bounded scalar tuple query,
# then retain only 20 target previews in the public card.
large_row = {
    "detail_key": "large::artist",
    "title": "Large",
    "artist": "Artist",
    "row_count": 41,
    "song_count": 1,
    "video_count": 41,
    "timestamp_count": 41,
    "payload_json": {
        "type": "song",
        "key": "large::artist",
        "title": "Large",
        "displayArtist": "Artist",
        "occurrences": [
            occurrence(f"wrong-first-{index}", "UC-WRONG")
            for index in range(20)
        ],
    },
}
target_rows = [
    {
        "detail_key": "large::artist",
        "video_id": f"target-full-{index}",
        "occurrence_id": f"target-occ-{index}",
        "range_id": "all",
        "song_key": "large",
        "seconds": index,
        "title": "Large",
        "artist": "Artist",
        "source_id": f"source-{index}",
        "source_system": "test",
        "video_title": f"Target {index}",
        "channel_name": "Target",
        "channel_id": "UC-TARGET",
        "channel_handle": "/@target",
        "channel_url": "https://www.youtube.com/@target",
        "published_timestamp": "2026-01-01T00:00:00Z",
        "thumbnail_url": f"https://i.ytimg.com/vi/target-full-{index}/hqdefault.jpg",
    }
    for index in range(21)
]
queries = []
module._rows = lambda _connection, sql, params: queries.append((sql, params)) or target_rows
large_scope = module._bounded_clicked_song_scopes(
    object(),
    "parent",
    (large_row,),
    ("UC-TARGET",),
    "all",
    (),
    (),
    {},
    (),
)
assert len(queries) == 1
assert "requested_groups(detail_key, title, artist)" in queries[0][0]
assert "unnest(%s::text[], %s::text[], %s::text[])" in queries[0][0]
assert "payload_json" not in queries[0][0]
assert queries[0][1][0:4] == [
    ["large::artist"], ["large"], ["artist"], ["UC-TARGET"],
]
large = module._render_generic_overlay_rankings(
    object(),
    {
        "filtered": (large_row,),
        "metadata": (),
        "candidateRows": (),
        "parentRevisionId": "parent",
        "songChannelIds": ("UC-TARGET",),
        "clickedSongScopes": large_scope,
    },
    {
        "range": "all",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "20",
        "q": "@target Large",
        "searchFields": "title,channel",
    },
)
assert large["totalCount"] == 1
assert large["totalOccurrenceCount"] == 21
assert large["totalVideoCount"] == 21
record = large["records"][0]
assert (record["count"], record["timestampCount"], record["videoCount"]) == (21, 21, 21)
assert len(record["occurrences"]) == 20
assert all(
    item["item"]["channelId"] == "UC-TARGET"
    and item["item"] == item["video"]
    for item in record["occurrences"]
)
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic clicked song residual filters card titles before channel scoping", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

SHIN = "UC5zO6IFsWSUHMYgJMv81XKg"
MEDA = "UC0HX1e5jJnhN5Xn0epV2wzA"

def rank(key, title, artist):
    return {
        "rank": 1,
        "detail_key": key,
        "title": title,
        "artist": artist,
        "name": title,
        "row_count": 1,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 1,
        # Reproduce the production undefined-card boundary: scalar ranking
        # identity exists while the stored public payload carries a non-empty
        # but stale identity from another song.
        "payload_json": {
            "type": "song",
            "key": "polluted::wrong",
            "title": "Polluted Song",
            "displayArtist": "Polluted Artist",
            "occurrences": [],
        },
        "search_text": (
            f"{title} {artist} from y to y @shingames7857 "
            "@MEDAzcd"
        ),
        "channel_search_text": "@shingames7857 @MEDAzcd",
    }

catalog = [
    rank("unchanged::artist", "Unchanged", "Artist"),
    rank("defying::artist", "Defying Gravity", "from Wicked"),
    # Production-shaped boundary: the persisted ranking key uses the legacy
    # compact normalization while exact occurrences recompute a spaced key.
    rank("fromytoy::artist", "from Y to Y", "Artist"),
    rank(
        "athousandmiles::vanessacarlton",
        "A Thousand Miles",
        "Vanessa Carlton",
    ),
    rank("king::artist", "全力キング", "Artist"),
    rank("染脳::unknown", "染脳", "unknown"),
]

def scalar(key, title, artist, channel_id, index=1):
    return {
        "detail_key": key,
        "video_id": f"video-{channel_id}-{index}",
        "occurrence_id": f"occ-{channel_id}-{index}",
        "range_id": "all",
        "song_key": key,
        "seconds": index,
        "title": title,
        "artist": artist,
        "source_id": "source",
        "source_system": "test",
        "video_title": "Stream",
        "channel_name": "Channel",
        "channel_id": channel_id,
        "channel_handle": (
            "/@shingames7857" if channel_id == SHIN else "/@MEDAzcd"
        ),
        "channel_url": "https://www.youtube.com/channel/" + channel_id,
        "published_timestamp": "2026-01-01T00:00:00Z",
        "thumbnail_url": (
            "https://i.ytimg.com/vi/"
            f"video-{channel_id}-{index}/hqdefault.jpg"
        ),
    }

scalars = {
    ("fromytoy::artist", SHIN): [
        scalar("fromytoy::artist", "from Y to Y", "Artist", SHIN),
    ],
    ("athousandmiles::vanessacarlton", SHIN): [
        scalar(
            "athousandmiles::vanessacarlton",
            "A Thousand Miles",
            "Vanessa Carlton",
            SHIN,
        ),
    ],
    ("染脳::unknown", MEDA): [
        scalar("染脳::unknown", "染脳", "unknown", MEDA),
    ],
    # 全力キング is a real global song, but not a SHIN occurrence.
    ("king::artist", SHIN): [],
}
base_probes = []

def rows(_connection, sql, params):
    if "FROM runtime_ranking_rows" in sql:
        assert "title ILIKE %s" in sql
        assert all("@shingames7857" not in str(value) for value in params)
        assert all("@medazcd" not in str(value).casefold() for value in params)
        needle = str(params[-1]).strip("%").casefold()
        base_probes.append(needle)
        return [
            dict(item)
            for item in catalog
            if needle in item["title"].casefold()
        ]
    if "bounded complete clicked-song scalar tuples" in sql:
        result = []
        for key in params[0]:
            for channel_id in params[3]:
                result.extend(scalars.get((key, channel_id), ()))
        return result
    return []

module._rows = rows
module._overlay_revision_ids = lambda *_: []
module._resolve_exact_vtuber_channel_scope = (
    lambda _connection, _parent, _overlay, options:
      (
        (SHIN,)
        if options["view"] == "vtubers"
        and options["q"].startswith("@shingames7857 ")
        else (MEDA,)
        if options["view"] == "vtubers"
        and options["q"].startswith("@medazcd ")
        else None
      )
)
module._overlay_candidate_rows = lambda *_args, **_kwargs: []
module._accepted_video_resets = lambda *_args, **_kwargs: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_args, **_kwargs: []
module._channel_metadata_rows = lambda *_: []
module._enrich_runtime_original_group_counts = lambda *_: None
module._overlay_vtuber_replacement_rows = lambda *_: {}

def query(q):
    options = module._query_options({
        "range": "all",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "20",
        "q": q,
        "searchFields": "title,channel",
    })
    prepared = module._prepare_generic_overlay_rankings(
        object(), "active", ("parent", {"revision_id": "parent"}), options,
    )
    return module._render_generic_overlay_rankings(
        object(), prepared, {
            "range": "all",
            "view": "songs",
            "metric": "occurrences",
            "page": "1",
            "pageSize": "20",
            "q": q,
            "searchFields": "title,channel",
        },
    )

shin = query("@shingames7857 from Y to Y")
assert shin["totalCount"] == 1, shin
assert [record["title"] for record in shin["records"]] == ["from Y to Y"]
assert shin["records"][0]["key"] == "fromytoy::artist"
assert shin["records"][0]["displayArtist"] == "Artist"
assert all(
    occurrence["item"]["channelId"] == SHIN
    for occurrence in shin["records"][0]["occurrences"]
)

thousand = query("@shingames7857 A Thousand Miles")
assert thousand["totalCount"] == 1
assert [record["title"] for record in thousand["records"]] == [
    "A Thousand Miles",
]
assert thousand["records"][0]["key"] == "athousandmiles::vanessacarlton"
assert thousand["records"][0]["displayArtist"] == "Vanessa Carlton"
assert thousand["records"][0]["artists"] == [{
    "key": "vanessa carlton",
    "name": "Vanessa Carlton",
    "count": 1,
}]
assert thousand["records"][0]["channels"] == [{
    "key": "channel",
    "name": "Channel",
    "count": 1,
}]
assert all(
    occurrence["item"]["channelId"] == SHIN
    for occurrence in thousand["records"][0]["occurrences"]
)

negative = query("@shingames7857 全力キング")
assert negative["totalCount"] == 0
assert negative["records"] == []

meda = query("@MEDAzcd 染脳")
assert meda["totalCount"] == 1
assert [record["title"] for record in meda["records"]] == ["染脳"]
assert all(
    occurrence["item"]["channelId"] == MEDA
    for occurrence in meda["records"][0]["occurrences"]
)

# Two legacy keys cannot claim the same exact title/artist identity.  Reject
# that malformed request before querying or hydrating any occurrence.
try:
    module._bounded_clicked_song_scopes(
        object(),
        "parent",
        (
            rank("legacy-one", "Same Song", "Same Artist"),
            rank("legacy-two", "Same Song", "Same Artist"),
        ),
        (SHIN,),
        "all",
        (),
        (),
        {},
        (),
    )
except module.PostgresAdapterError as error:
    assert "request identity is ambiguous" in str(error)
else:
    raise AssertionError("ambiguous clicked-song identity was accepted")

# Overlay-only candidate and runtime-replacement rows retain the exact handle
# and residual title in the same scalar search text used by prepare(), so the
# existing options.searchTokens filter cannot discard the clicked target.
candidate_options = module._query_options({
    "range": "all",
    "view": "songs",
    "q": "@shingames7857 Candidate Song",
    "searchFields": "title,channel",
})
candidate = {
    "video_id": "candidate-video",
    "occurrence_id": "candidate-occurrence",
    "title": "Candidate Song",
    "artist": "Artist",
    "channel_id": SHIN,
    "channel_handle": "/@shingames7857",
}
assert module._matches_search_tokens(
    module._overlay_candidate_search_text(candidate),
    candidate_options["searchTokens"],
)
replacement = module._runtime_replacement_candidate_rows([{
    "revisionId": "runtime",
    "replacement": True,
    "replacementPayload": {
        "videoId": "replacement-video",
        "occurrenceId": "replacement-occurrence",
        "title": "Replacement Song",
        "artist": "Artist",
        "channelId": SHIN,
    },
    "replacementVideoPayload": {
        "videoId": "replacement-video",
        "channelId": SHIN,
        "channelHandle": "/@shingames7857",
    },
}])[0]
replacement_options = module._query_options({
    "range": "all",
    "view": "songs",
    "q": "@shingames7857 Replacement Song",
    "searchFields": "title,channel",
})
assert module._matches_search_tokens(
    module._overlay_candidate_search_text(replacement),
    replacement_options["searchTokens"],
)
assert base_probes == [
    "from y to y", "a thousand miles", "全力キング", "染脳",
]
print("OK")
`);
  assert.equal(output, "OK");
});

test("scoped clicked song rebuilds public count maps from exact occurrences", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

CHANNEL = "UC5zO6IFsWSUHMYgJMv81XKg"

def occurrence(index, outer_artist="Vanessa Carlton", song_artist="Vanessa Carlton"):
    video = {
        "videoId": f"video-{index}",
        "channelId": CHANNEL,
        "channelName": "shin",
        "channelHandle": "/@shingames7857",
    }
    return {
        "videoId": video["videoId"],
        "occurrenceId": f"occ-{index}",
        "artist": outer_artist,
        "song": {
            "title": "A Thousand Miles",
            "artist": song_artist,
        },
        "item": video,
        "video": dict(video),
    }

result = module._scoped_clicked_song_payload(
    {
        "type": "song",
        "title": "A Thousand Miles",
        "displayArtist": "Vanessa Carlton",
        # These values reproduce the stale/null public-card boundary.  The
        # scoped result must never preserve either value.
        "artists": None,
        "channels": [{"key": "polluted", "name": "Polluted", "count": 999}],
        "occurrences": [occurrence(1), occurrence(2)],
    },
    {CHANNEL},
    39,
)
assert result["count"] == 39
assert result["timestampCount"] == 39
assert result["artists"] == [{
    "key": "vanessa carlton",
    "name": "Vanessa Carlton",
    "count": 39,
}]
assert result["channels"] == [{
    "key": "shin",
    "name": "shin",
    "count": 39,
}]

try:
    module._scoped_clicked_song_payload(
        {
            "displayArtist": "Vanessa Carlton",
            "occurrences": [
                occurrence(1, song_artist="Different Artist"),
            ],
        },
        {CHANNEL},
        1,
    )
except module.PostgresAdapterError as error:
    assert "inconsistent artist identity" in str(error)
else:
    raise AssertionError("conflicting occurrence artist was accepted")

try:
    conflicting_channel = occurrence(2)
    conflicting_channel["item"]["channelName"] = "Polluted"
    module._scoped_clicked_song_payload(
        {
            "displayArtist": "Vanessa Carlton",
            "occurrences": [conflicting_channel],
        },
        {CHANNEL},
        1,
    )
except module.PostgresAdapterError as error:
    assert "inconsistent channel identity" in str(error)
else:
    raise AssertionError("conflicting item/video channel was accepted")

print("OK")
`);
  assert.equal(output, "OK");
});

test("E v21 mixed VTuber search uses bounded full effective tuples beyond previews", () => {
  const output = runPython(`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
candidate_loader = module._overlay_candidate_rows
reset_loader = module._accepted_video_resets
runtime_loader = module._overlay_runtime_rows
metadata_loader = module._channel_metadata_rows

class Connection:
    def cursor(self): return object()

target_id = "UC-TARGET"
wrong_id = "UC-WRONG"
candidate = {
  "revision_id": "accepted", "video_id": "overlay-unrelated",
  "occurrence_id": "overlay-occ", "position": 0, "range_id": "all",
  "song_key": "overlay-unrelated", "title": "Overlay Unrelated",
  "artist": "Artist", "seconds": 9, "channel_id": target_id,
  "channel_name": "Target Channel", "channel_handle": "@targethandle",
  "channel_url": "https://www.youtube.com/@targethandle",
  "video_tombstone": False,
  "video_payload_json": {
    "videoId": "overlay-unrelated", "channelId": target_id,
    "channelName": "Target Channel", "channelHandle": "@targethandle",
    "thumbnailUrl": "https://i.ytimg.com/vi/overlay-unrelated/hqdefault.jpg",
  },
  "occurrence_payload_json": {
    "videoId": "overlay-unrelated", "occurrenceId": "overlay-occ",
    "rangeId": "all", "songKey": "overlay-unrelated",
    "title": "Overlay Unrelated", "artist": "Artist", "seconds": 9,
  },
}
unrelated_runtime_change = {
  "entityType": "runtime_occurrences",
  "videoId": "other-video", "occurrenceId": "other-occurrence",
  "channel_id": "UC-UNRELATED", "channel_handle": "@unrelated",
  "title": "Unrelated Runtime Song", "artist": "Other Artist",
}
base_previews = [
  {
    "videoId": "preview-" + str(index), "occurrenceId": "preview-occ-" + str(index),
    "title": "Unrelated " + str(index), "artist": "Artist", "seconds": index,
    "item": {
      "videoId": "preview-" + str(index), "channelId": target_id,
      "channelName": "Target Channel", "channelHandle": "@targethandle",
      "thumbnailUrl": "https://i.ytimg.com/vi/preview-" + str(index) + "/hqdefault.jpg",
    },
  }
  for index in range(20)
]
base_row = {
  "rank": 1, "detail_key": target_id, "title": "", "artist": "",
  "name": "Target Channel", "row_count": 21, "song_count": 21,
  "video_count": 21, "timestamp_count": 21,
  "search_text": "deep target song", "channel_search_text": "@targethandle",
  "payload_json": {
    "type": "vtuber", "key": target_id, "channelId": target_id,
    "channelName": "Target Channel", "channelHandle": "@targethandle",
    "count": 21, "songCount": 21, "videoCount": 21,
    "timestampCount": 21, "occurrences": base_previews,
  },
}

module._overlay_revision_ids = lambda *_: ["accepted"]
module._overlay_candidate_rows = lambda *_: [dict(candidate)]
module._accepted_video_resets = lambda *_: {}
module._accepted_video_reset_changes = lambda *_: []
module._runtime_tombstones = lambda *_: [dict(unrelated_runtime_change)]
module._enrich_runtime_original_group_counts = lambda *_: None
module._runtime_replacement_candidate_rows = lambda *_: []
module._channel_metadata_rows = lambda *_: []

resolved_scope = (target_id,)
sql_residual_match = True
expected_residual_tokens = ["deep", "target", "song"]
sql_calls = []
module._resolve_exact_vtuber_channel_scope = lambda *_: resolved_scope

def rows(_connection, sql, params):
    sql_calls.append((sql, params))
    if "SELECT video_id" in sql and "FROM runtime_videos" in sql:
        assert "channel_id = ANY(%s)" in sql
        assert "FROM runtime_occurrences AS occurrence" in sql
        assert "ORDER BY video_id" in sql and "LIMIT %s" in sql
        assert params[3] == params[4] == "all"
        return []
    if "FROM runtime_ranking_rows" in sql:
        assert "detail_key = ANY(%s)" in sql
        assert params[4] == list(resolved_scope)
        return [dict(base_row)] if resolved_scope == (target_id,) else []
    if "bounded_parent_occurrences" in sql:
        assert "ESCAPE E" in sql
        assert params[0] == [target_id]
        assert params[4] == ["all", ""]
        assert params[8] == params[10] == module._MAX_AFFECTED_RUNTIME_OCCURRENCES + 1
        assert params[11] == params[12] == expected_residual_tokens
        assert params[13] is True and params[15] is True
        overlay = json.loads(params[5])
        assert len(overlay) == 1 and overlay[0]["residual_match"] is False
        return [
          {
            "channel_id": "", "row_count": 0, "video_count": 0,
            "song_count": 0, "residual_match": False,
            "parent_video_count": 21, "parent_occurrence_count": 21,
          },
          {
            "channel_id": target_id, "row_count": 22,
            "video_count": 22, "song_count": 22,
            "residual_match": sql_residual_match,
            "parent_video_count": 21, "parent_occurrence_count": 21,
          },
        ]
    if "FROM runtime_videos" in sql or "FROM runtime_occurrences" in sql:
        raise AssertionError("mixed query reached legacy parent payload rebuild")
    raise AssertionError(sql)

module._rows = rows
options = {
  "range": "all", "view": "vtubers", "metric": "count",
  "q": "@targethandle deep target song",
  "searchTokens": ["@targethandle", "deep", "target", "song"],
  "searchScope": "all", "searchFields": ["title", "channel"],
  "minCount": 1, "nicheOnly": False, "hideUnknownArtist": False,
}
positive = module._prepare_generic_overlay_rankings(
  Connection(), "active-positive", ("parent", {"revision_id": "parent"}),
  options,
)
assert [row["detail_key"] for row in positive["filtered"]] == [target_id]
card = positive["filtered"][0]["payload_json"]
assert (card["count"], card["songCount"], card["videoCount"]) == (22, 22, 22)
assert all(
  "deep target song" not in str(occurrence).casefold()
  for occurrence in card["occurrences"]
), "positive match was accidentally proved only by the first 20 previews"

sql_residual_match = False
expected_residual_tokens = ["wrong", "song"]
sql_calls.clear()
negative = module._prepare_generic_overlay_rankings(
  Connection(), "active-negative", ("parent", {"revision_id": "parent"}),
  {**options, "q": "@targethandle wrong song",
   "searchTokens": ["@targethandle", "wrong", "song"]},
)
assert negative["filtered"] == ()

resolved_scope = (wrong_id,)
sql_calls.clear()
wrong_channel = module._prepare_generic_overlay_rankings(
  Connection(), "active-wrong-channel", ("parent", {"revision_id": "parent"}),
  {**options, "q": "@wronghandle deep target song",
   "searchTokens": ["@wronghandle", "deep", "target", "song"]},
)
assert wrong_channel["filtered"] == ()
assert not any("bounded_parent_occurrences" in sql for sql, _ in sql_calls)

# The resolved immutable channel scope is present in SQL before candidate,
# accepted-reset, or runtime rows are materialized.
scoped_calls = []
def scoped_rows(_connection, sql, params):
    scoped_calls.append((sql, params))
    if "FROM runtime_channel_metadata" in sql:
        assert "channel_id = ANY(%s)" in sql
        assert "ORDER BY revision_id, channel_key" in sql and "LIMIT %s" in sql
        return []
    if (
      "FROM migration_runtime_rows" in sql
      and "channel_metadata" in sql
    ):
        assert "entity_key = ANY(%s)" in sql
        assert "ORDER BY revision_id, entity_key" in sql and "LIMIT %s" in sql
        return []
    if "SELECT DISTINCT video_id" in sql:
        assert "channel_id = ANY(%s)" in sql and "video_id = ANY(%s)" in sql
        assert params[1] == [target_id]
        assert params[2] == ["parent-video"]
        return [{"video_id": "scoped-video"}]
    if "FROM migration_video_rows" in sql and "video_tombstone" in sql:
        assert "video_id = ANY(%s)" in sql
        assert params[1] == ["scoped-video"]
        return [{
          "revision_id": "accepted", "video_id": "scoped-video",
          "video_title": "Scoped", "channel_name": "Target Channel",
          "channel_id": target_id, "channel_handle": "@targethandle",
          "channel_url": "", "published_at": None,
          "video_payload_json": None, "video_tombstone": False,
        }]
    if "FROM migration_occurrence_rows" in sql:
        assert "o.video_id = ANY(%s)" in sql
        assert params[1] == ["scoped-video"]
        assert params[2] == params[3] == "all"
        return [{
          "revision_id": "accepted", "video_id": "scoped-video",
          "occurrence_id": "scoped-occ", "position": 0, "range_id": "all",
          "song_key": "scoped-song", "seconds": 1, "title": "Scoped Song",
          "artist": "Artist", "source_id": "", "raw_hash": "",
          "source_system": "", "occurrence_payload_json": None,
        }]
    if "FROM migration_video_rows" in sql:
        assert "channel_id = ANY(%s)" in sql and "video_id = ANY(%s)" in sql
        assert params[1] == [target_id]
        assert params[2] == ["parent-video"]
        return []
    if "FROM migration_runtime_rows" in sql:
        assert "replacementPayload" in sql and "originalIdentity" in sql
        assert "channel_url" not in sql.lower()
        assert "ORDER BY revision_id, entity_type, entity_key" in sql
        assert "LIMIT %s" in sql
        return []
    raise AssertionError(sql)

module._rows = scoped_rows
loaded = candidate_loader(
  object(), ["accepted"], False, (target_id,), ("parent-video",), "all",
)
assert len(loaded) == 1 and loaded[0]["channel_id"] == target_id

move_video_id = "moved-overlay-video"
def move_candidate_rows(_connection, sql, params):
    if "SELECT DISTINCT video_id" in sql:
        return [{"video_id": move_video_id}]
    if "FROM migration_video_rows" in sql:
        return [
          {
            "revision_id": "old-rev", "video_id": move_video_id,
            "video_title": "Old", "channel_name": "Old Channel",
            "channel_id": "UC-OLD", "channel_handle": "@old_handle",
            "channel_url": "", "published_at": None,
            "video_payload_json": None, "video_tombstone": False,
          },
          {
            "revision_id": "new-rev", "video_id": move_video_id,
            "video_title": "New", "channel_name": "New Channel",
            "channel_id": "UC-NEW", "channel_handle": "@new_handle",
            "channel_url": "", "published_at": None,
            "video_payload_json": None, "video_tombstone": False,
          },
        ]
    if "FROM migration_occurrence_rows" in sql:
        return [{
          "revision_id": "new-rev", "video_id": move_video_id,
          "occurrence_id": "new-occ", "position": 0, "range_id": "all",
          "song_key": "new-song", "seconds": 42, "title": "New Song",
          "artist": "New Artist", "source_id": "", "raw_hash": "",
          "source_system": "", "occurrence_payload_json": None,
        }]
    raise AssertionError(sql)

module._rows = move_candidate_rows
old_move_candidates = candidate_loader(
  object(), ["new-rev", "old-rev"], False, ("UC-OLD",),
  (move_video_id,), "all",
)
new_move_candidates = candidate_loader(
  object(), ["new-rev", "old-rev"], False, ("UC-NEW",),
  (), "all",
)
assert old_move_candidates == []
assert len(new_move_candidates) == 1
assert (
  new_move_candidates[0]["video_id"],
  new_move_candidates[0]["occurrence_id"],
  new_move_candidates[0]["channel_id"],
  new_move_candidates[0]["channel_handle"],
  new_move_candidates[0]["title"],
) == (move_video_id, "new-occ", "UC-NEW", "@new_handle", "New Song")

module._rows = scoped_rows
assert reset_loader(
  object(), ["accepted"], False, True, "parent", (target_id,),
  ("parent-video",),
) == {}
assert runtime_loader(
  object(), ["accepted"], "parent", (target_id,), ("parent-video",),
) == []
assert metadata_loader(
  object(), ["active", "accepted", "parent"], (target_id,),
) == []

# A normal unfiltered VTuber overlay retains v19's database-side aggregate:
# 224k parent tuples are summarized, not rejected by the mixed-query 50k cap
# and not materialized as payload rows in Python.
def unfiltered_rows(_connection, sql, params):
    assert "fast_parent_occurrences AS" in sql
    assert "bounded_parent_occurrences" not in sql
    assert "LIMIT" not in sql
    return [{
      "channel_id": target_id, "row_count": 224193,
      "video_count": 15152, "song_count": 123456,
    }]

module._rows = unfiltered_rows
module._VTUBER_REPLACEMENT_CACHE.clear()
unfiltered = module._overlay_vtuber_replacement_rows(
  Connection(), "active-unfiltered", "parent", [dict(candidate)],
  {"range": "all", "view": "vtubers", "q": "",
   "searchScope": "all", "searchFields": [], "metric": "count",
   "nicheOnly": False, "hideUnknownArtist": False},
  {target_id: dict(base_row)}, (), (), (), {}, True, None,
)
assert unfiltered[target_id]["row_count"] == 224193
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic 7d curation repairs public identity from its accepted occurrence", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

# Exact shape of the sole 7d runtime replacement in artifact 8748655198:
# it is a valid song/occurrence tuple and carries the reviewed handle, but the
# legacy full-runtime ancestor has no immutable channel_id for VTuber repair.
change = {
    "entityType": "occurrences",
    "revisionId": "accepted_30528693014_1",
    "videoId": "MhemBDB0yJo",
    "occurrenceId": "position:4",
    "rangeId": "7d",
    "title": "逆光(ウタ from ONE PIECE FILM RED)",
    "artist": "Ado",
    "channelHandle": "/@ShibireiAmoru88",
    "replacement": True,
    "replacementSameArtist": True,
    "replacementSameVideo": True,
    "replacementPayload": {
        "videoId": "MhemBDB0yJo",
        "occurrenceId": "position:4",
        "position": 5,
        "rangeId": "7d",
        "title": "逆光",
        "artist": "Ado",
        "channelHandle": "/@ShibireiAmoru88",
    },
}
accepted = {
    "revision_id": "accepted_30402041297_1",
    "video_id": "MhemBDB0yJo",
    "occurrence_id": "position:4",
    "position": 5,
    "range_id": "7d",
    "song_key": "de3ab6da570b6beb9ca42cc3",
    "seconds": 1747,
    "title": "\u9006\u5149(\u30a6\u30bf from ONE PIECE FILM RED)",
    "artist": "Ado",
    "source_id": "UgxRfG2vHGbBQEP3JTZ4AaABAg",
    "source_system": "youtube_channel_discovery",
    "video_title": "accepted source video",
    "channel_name": "\u7d2b\u8587\u4ee4\u3042\u3082\u308b / Shibirei Amoru",
    "channel_id": "UCpKdAmIYIkpySO7tsTN0oJA",
    "channel_handle": "/@ShibireiAmoru88",
    # A polluted historical URL is derived metadata, not identity evidence.
    "channel_url": "https://www.youtube.com/@urameshi_conta",
    "video_payload_json": {
        "videoId": "MhemBDB0yJo",
        "title": "accepted source video",
        "channelName": "\u7d2b\u8587\u4ee4\u3042\u3082\u308b / Shibirei Amoru",
        "channelId": "UCpKdAmIYIkpySO7tsTN0oJA",
        "channelHandle": "/@ShibireiAmoru88",
        "channelUrl": "https://www.youtube.com/@urameshi_conta",
    },
    "occurrence_payload_json": {
        "videoId": "MhemBDB0yJo",
        "occurrenceId": "position:4",
        "position": 5,
        "rangeId": "7d",
        "songKey": "de3ab6da570b6beb9ca42cc3",
        "seconds": 1747,
        "title": "\u9006\u5149(\u30a6\u30bf from ONE PIECE FILM RED)",
        "artist": "Ado",
    },
}
assert module._validated_overlay_change_identity(
    change, validate_urls=False,
) == ("MhemBDB0yJo", "")

original_key = module._runtime_change_group_key(change, "songs")
base = {
    "rank": 1, "detail_key": original_key,
    "title": change["title"], "artist": "Ado", "name": change["title"],
    "row_count": 1, "song_count": 1, "video_count": 1,
    "timestamp_count": 1,
    "payload_json": {
        "type": "song", "key": original_key, "title": change["title"],
        "displayArtist": "Ado", "count": 1, "songCount": 1,
        "videoCount": 1, "timestampCount": 1, "occurrences": [],
    },
    "search_text": "", "channel_search_text": "",
}
parent_identity_queries = 0
def rows(_connection, sql, _params):
    global parent_identity_queries
    if "FROM runtime_videos" in sql:
        parent_identity_queries += 1
        return []
    if "bounded unaffected parent ranking prefix" in sql:
        # The only persisted parent group is the affected group below, so the
        # exact unaffected prefix is empty after detail_key <> ALL(...).
        return []
    if "FROM runtime_ranking_rows" in sql:
        return [dict(base)]
    raise AssertionError(sql)

module._rows = rows
module._one = lambda *_args: {
    "total_count": 1, "total_occurrence_count": 1,
    "total_song_count": 1, "total_video_count": 1,
}
module._overlay_revision_ids = lambda *_args: ["accepted_30528693014_1"]
module._resolve_exact_vtuber_channel_scope = lambda *_args: None
module._overlay_candidate_rows = lambda *_args: [dict(accepted)]
module._accepted_video_resets = lambda *_args: {}
module._accepted_video_reset_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args: [dict(change)]
module._enrich_runtime_original_group_counts = lambda *_args: None
module._channel_metadata_rows = lambda *_args: []
module._overlay_vtuber_replacement_rows = lambda *_args, **_kwargs: {}

prepared = module._prepare_generic_overlay_rankings(
    object(), "accepted_30528693014_1",
    ("full-runtime-parent", {"revision_id": "full-runtime-parent"}),
    {
        "range": "7d", "view": "songs", "metric": "occurrences",
        "q": "", "searchTokens": [], "searchScope": "all",
        "searchFields": [], "page": 1, "pageSize": 1, "minCount": 1,
        "nicheOnly": False, "hideUnknownArtist": False,
    },
)
assert parent_identity_queries == 0, (
    parent_identity_queries,
    [(row["title"], row["artist"]) for row in prepared["filtered"]],
)
replacement_rows = [
    row for row in prepared["filtered"]
    if row["title"] == "\u9006\u5149" and row["artist"] == "Ado"
]
assert len(replacement_rows) == 1
occurrences = replacement_rows[0]["payload_json"]["occurrences"]
assert len(occurrences) == 1
rendered = occurrences[0]
assert rendered["videoId"] == "MhemBDB0yJo"
assert rendered["item"] == rendered["video"]
assert rendered["item"]["videoId"] == "MhemBDB0yJo"
assert rendered["item"]["channelId"] == "UCpKdAmIYIkpySO7tsTN0oJA"
assert module._normalized_channel_handle(
    rendered["item"]["channelHandle"]
) == module._normalized_channel_handle("/@ShibireiAmoru88")
assert rendered["item"]["channelUrl"] == (
    "https://www.youtube.com/@shibireiamoru88"
)
module._overlay_candidate_rows = lambda *_args: [
    dict(accepted), dict(accepted),
]
try:
    module._prepare_generic_overlay_rankings(
        object(), "accepted_30528693014_1",
        ("full-runtime-parent", {"revision_id": "full-runtime-parent"}),
        {
            "range": "7d", "view": "songs", "metric": "occurrences",
            "q": "", "searchTokens": [], "searchScope": "all",
            "searchFields": [], "page": 1, "pageSize": 1, "minCount": 1,
            "nicheOnly": False, "hideUnknownArtist": False,
        },
    )
except module.PostgresAdapterError as error:
    assert str(error) == (
        "accepted overlay identity repair returned a duplicate occurrence"
    )
else:
    raise AssertionError("duplicate accepted identity did not fail closed")
print("OK")
`);
  assert.equal(output, "OK");
});

test("direct unfiltered VTuber curation repairs Mhem from one accepted tuple", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Connection:
    def cursor(self):
        return object()

channel_id = "UCpKdAmIYIkpySO7tsTN0oJA"
handle = "/@ShibireiAmoru88"
change = {
    "entityType": "occurrences",
    "revisionId": "accepted_30528693014_1",
    "videoId": "MhemBDB0yJo",
    "occurrenceId": "position:4",
    "rangeId": "7d",
    "title": "\u9006\u5149(\u30a6\u30bf from ONE PIECE FILM RED)",
    "artist": "Ado",
    "channelHandle": handle,
    "replacement": True,
    "replacementSameArtist": True,
    "replacementSameVideo": True,
    "replacementPayload": {
        "videoId": "MhemBDB0yJo",
        "occurrenceId": "position:4",
        "position": 5,
        "rangeId": "7d",
        "songKey": "canonical-gyakko",
        "seconds": 1747,
        "title": "\u9006\u5149",
        "artist": "Ado",
        "channelHandle": handle,
    },
}
selected_reset = {
    "revision_id": "accepted_30402041297_1",
    "video_id": "MhemBDB0yJo",
    "video_title": "accepted source video",
    "channel_name": "\u7d2b\u8587\u4ee4\u3042\u3082\u308b / Shibirei Amoru",
    "channel_id": channel_id,
    "channel_handle": handle,
    # Derived historical metadata is polluted and must be canonicalised.
    "channel_url": "https://www.youtube.com/@urameshi_conta",
    "published_at": None,
    "tombstone": False,
    "payload_json": {
        "videoId": "MhemBDB0yJo",
        "title": "accepted source video",
        "channelName": "\u7d2b\u8587\u4ee4\u3042\u3082\u308b / Shibirei Amoru",
        "channelId": channel_id,
        "channelHandle": handle,
        "channelUrl": "https://www.youtube.com/@urameshi_conta",
        "thumbnailUrl": "https://i.ytimg.com/vi/MhemBDB0yJo/hqdefault.jpg",
    },
}
direct_rows = [{
    "revision_id": "accepted_30402041297_1",
    "video_id": "MhemBDB0yJo",
    "occurrence_id": "position:4",
}]
calls = {"identity": 0, "parent": 0, "summary": 0}

def rows(_connection, sql, params):
    if "bounded direct accepted occurrence identity repair" in sql:
        calls["identity"] += 1
        assert "unnest(%s::text[], %s::text[])" in sql
        assert "DISTINCT ON (o.video_id, o.occurrence_id)" in sql
        assert "array_position(%s::text[], o.revision_id)" in sql
        assert params == [
            ["MhemBDB0yJo"], ["position:4"],
            ["accepted_30528693014_1", "accepted_30402041297_1"],
            ["accepted_30528693014_1", "accepted_30402041297_1"],
            2,
        ]
        return [dict(row) for row in direct_rows]
    if "direct unfiltered VTuber overlay summary" in sql:
        calls["summary"] += 1
        return [{
            "channel_id": channel_id,
            "row_count": 1,
            "video_count": 1,
            "song_count": 1,
        }]
    if "FROM runtime_videos" in sql:
        calls["parent"] += 1
        return []
    if "FROM runtime_ranking_rows" in sql:
        return []
    raise AssertionError(sql)

module._rows = rows
module._one = lambda *_args: {
    "total_count": 0,
    "total_occurrence_count": 0,
    "total_song_count": 0,
    "total_video_count": 0,
}
module._overlay_revision_ids = lambda *_args: [
    "accepted_30528693014_1", "accepted_30402041297_1",
]
module._resolve_exact_vtuber_channel_scope = lambda *_args: None
module._overlay_candidate_rows = lambda *_args: (_ for _ in ()).throw(
    AssertionError("direct path materialized accepted candidates")
)
module._accepted_video_resets = lambda *_args: {
    "MhemBDB0yJo": dict(selected_reset),
}
module._accepted_video_reset_identity_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args: [dict(change)]
module._channel_metadata_rows = lambda *_args: []
module._VTUBER_REPLACEMENT_CACHE.clear()

options = {
    "range": "7d", "view": "vtubers", "metric": "occurrences",
    "q": "", "searchTokens": [], "searchScope": "all",
    "searchFields": [], "page": 1, "pageSize": 20, "minCount": 1,
    "nicheOnly": False, "hideUnknownArtist": False,
}
prepared = module._prepare_generic_overlay_rankings(
    Connection(), "accepted_30528693014_1",
    ("full-runtime-parent", {"revision_id": "full-runtime-parent"}),
    options,
)
assert calls == {"identity": 1, "parent": 0, "summary": 1}, calls
assert len(prepared["filtered"]) == 1
record = prepared["filtered"][0]
assert record["detail_key"] == channel_id
rendered = record["payload_json"]["occurrences"][0]
assert rendered["videoId"] == "MhemBDB0yJo"
assert rendered["item"] == rendered["video"]
assert rendered["item"]["videoId"] == "MhemBDB0yJo"
assert rendered["item"]["channelId"] == channel_id
assert module._normalized_channel_handle(
    rendered["item"]["channelHandle"]
) == module._normalized_channel_handle(handle)
assert rendered["item"]["channelUrl"] == (
    "https://www.youtube.com/@shibireiamoru88"
)

# The SQL is expected to return one effective row per requested tuple.  A
# duplicate result is never tie-broken in Python.
direct_rows[:] = [
    {
        "revision_id": "accepted_30402041297_1",
        "video_id": "MhemBDB0yJo",
        "occurrence_id": "position:4",
    },
    {
        "revision_id": "accepted_30402041297_1",
        "video_id": "MhemBDB0yJo",
        "occurrence_id": "position:4",
    },
]
try:
    module._prepare_generic_overlay_rankings(
        Connection(), "accepted_30528693014_1",
        ("full-runtime-parent", {"revision_id": "full-runtime-parent"}),
        options,
    )
except module.PostgresAdapterError as error:
    assert str(error) == (
        "direct accepted identity repair returned a duplicate occurrence"
    )
else:
    raise AssertionError("duplicate direct accepted identity did not fail closed")
print("OK")
`);
  assert.equal(output, "OK");
});

test("production KMNZ card trusts its same-channel preview handle", () => {
  const output = runPython(`
import copy
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

channel_id = "UCwuS0uY-Z2Gr_5OV2oFybFA"
video_id = "7MfKPn39Jp8"
preview_handle = "/@KMNZOFFICIAL_TINAS"
preview_url = "https://www.youtube.com/@kmnzofficial_tinas"
thumbnail = "https://i.ytimg.com/vi/7MfKPn39Jp8/hqdefault.jpg"
preview_video = {
    "videoId": video_id,
    "channelId": channel_id,
    "channelHandle": preview_handle,
    "channelUrl": preview_url,
    "thumbnailUrl": thumbnail,
}
payload = {
    "type": "vtuber",
    "key": channel_id,
    "channelId": channel_id,
    # These aggregate fields are stale historical metadata.
    "channelHandle": "/@KMNZOFFICIAL",
    "channelUrl": preview_url,
    "count": 1,
    "timestampCount": 1,
    "occurrences": [{
        "videoId": video_id,
        "occurrenceId": "kmnz-preview",
        "position": 1,
        "title": "Song",
        "artist": "Artist",
        "seconds": 42,
        "song": {
            "title": "Song",
            "artist": "Artist",
            "seconds": 42,
        },
        "item": dict(preview_video),
        "video": dict(preview_video),
    }],
}
module._canonicalize_vtuber_card_preview(payload, channel_id)
assert payload["channelId"] == channel_id
assert payload["channelHandle"] == preview_handle
assert payload["channelUrl"] == preview_url
rendered = payload["occurrences"][0]
assert rendered["videoId"] == video_id
assert rendered["item"] == rendered["video"]
assert rendered["item"]["channelId"] == channel_id
assert rendered["item"]["channelHandle"] == preview_handle
assert rendered["item"]["channelUrl"] == preview_url

conflict = copy.deepcopy(payload)
conflict["count"] = 2
second = copy.deepcopy(conflict["occurrences"][0])
second["occurrenceId"] = "kmnz-conflict"
second["item"]["channelHandle"] = "/@KMNZOFFICIAL_LITA"
second["item"]["channelUrl"] = "https://www.youtube.com/@kmnzofficial_lita"
second["video"] = dict(second["item"])
conflict["occurrences"].append(second)
try:
    module._canonicalize_vtuber_card_preview(conflict, channel_id)
except module.PostgresAdapterError as error:
    assert str(error) == "VTuber ranking preview identity is invalid"
else:
    raise AssertionError("conflicting preview handles did not fail closed")
print("OK")
`);
  assert.equal(output, "OK");
});

test("bounded ordinary ranking reads an exact unaffected prefix beyond 4097 deletions", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

deleted = [
    {
        "entityType": "occurrences",
        "rangeId": "7d",
        "videoId": f"deleted-video-{index}",
        "occurrenceId": f"deleted-occurrence-{index}",
        "title": f"Deleted Song {index}",
        "artist": "Ado",
        "channel_id": "UC-AFFECTED",
        "channel_handle": "/@affected",
    }
    for index in range(module._GENERIC_NO_SEARCH_AFFECTED_CUSHION + 1)
]
low_candidate = {
    "range_id": "7d",
    "video_id": "low-video",
    "occurrence_id": "low-occurrence",
    "title": "ZZZ Low Affected",
    "artist": "Ado",
}

def ranking_row(rank, key, title, count):
    return {
        "rank": rank,
        "detail_key": key,
        "title": title,
        "artist": "Ado",
        "name": title,
        "row_count": count,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": count,
        "payload_json": None,
        "search_text": "",
        "channel_search_text": "",
    }

deleted_parent = [
    ranking_row(
        index + 1,
        f"deleted song {index}::ado",
        f"Deleted Song {index}",
        1,
    )
    for index in range(len(deleted))
]
unaffected = [
    ranking_row(4098 + index, f"tie-{index}::ado", f"Tie {index}", 10)
    for index in range(6)
]
# This is exactly the unsafe old prefix: 4097 deleted groups plus only four
# unaffected rows. A low affected group loaded from outside that prefix could
# make len(filtered) look sufficient while rank 4102 was never read.
initial_prefix = [*deleted_parent, *unaffected[:4]]
unaffected_query_rows = [dict(row) for row in unaffected[:5]]
query_shapes = []

def rows(_connection, sql, params):
    if "bounded unaffected parent ranking prefix" in sql:
        query_shapes.append("unaffected")
        assert "WITH affected_keys(detail_key) AS MATERIALIZED" in sql
        assert "NOT EXISTS" in sql
        assert "detail_key <> ALL(%s)" not in sql
        assert "row_count >= %s" in sql
        assert "ORDER BY parent_row.rank" in sql
        assert params[5] == 1
        assert len(params[0]) == len(deleted) + 1
        assert params[6] == module._GENERIC_NO_SEARCH_PAGE_BUCKET
        return [dict(row) for row in unaffected_query_rows]
    if "detail_key = ANY(%s)" in sql:
        query_shapes.append("affected")
        assert len(params[4]) == len(deleted) + 1
        return [dict(row) for row in deleted_parent]
    if "FROM runtime_ranking_rows" in sql:
        query_shapes.append("initial")
        assert params[-1] == (
            module._GENERIC_NO_SEARCH_PAGE_BUCKET
            + module._GENERIC_NO_SEARCH_AFFECTED_CUSHION
        )
        return [dict(row) for row in initial_prefix]
    raise AssertionError(sql)

module._rows = rows
module._one = lambda *_args: {
    "total_count": len(deleted_parent) + len(unaffected),
    "total_occurrence_count": len(deleted_parent) + 60,
    "total_song_count": len(deleted_parent) + len(unaffected),
    "total_video_count": len(deleted_parent) + len(unaffected),
}
module._overlay_revision_ids = lambda *_args: ["accepted"]
module._resolve_exact_vtuber_channel_scope = lambda *_args: None
module._overlay_candidate_rows = lambda *_args, **_kwargs: [
    dict(low_candidate)
]
module._accepted_video_resets = lambda *_args, **_kwargs: {}
module._accepted_video_reset_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args, **_kwargs: [
    dict(change) for change in deleted
]
module._validated_overlay_change_identity = (
    lambda change, *_args, **_kwargs: (
        str(change.get("videoId") or change.get("video_id")),
        "UC-AFFECTED",
    )
)
module._runtime_replacement_candidate_rows = lambda *_args: []
module._enrich_runtime_original_group_counts = lambda *_args: None
module._apply_runtime_change_previews = lambda *_args: None
module._overlay_candidate_groups = lambda *_args: {
    "zzz low affected::ado": {
        "key": "zzz low affected::ado",
        "title": "ZZZ Low Affected",
        "artist": "Ado",
        "name": "ZZZ Low Affected",
        "occurrences": [],
        "occurrenceCount": 1,
        "videoIds": {"low-video"},
        "songKeys": {"low-song"},
        "search": "",
    }
}
module._channel_metadata_rows = lambda *_args: []

options = module._query_options({
    "range": "7d",
    "view": "songs",
    "metric": "occurrences",
    "page": "1",
    "pageSize": "1",
})
prepared = module._prepare_generic_overlay_rankings(
    object(), "active", ("parent", {"revision_id": "parent"}), options,
)
keys = [row["detail_key"] for row in prepared["filtered"]]
assert keys[:5] == [f"tie-{index}::ado" for index in range(5)], keys
assert keys[5:] == ["zzz low affected::ado"], keys
assert "tie-5::ado" not in keys
assert query_shapes == ["initial", "affected", "unaffected"], query_shapes

# All five returned unaffected rows tie on the metric. Persisted rank supplies
# the complete parent tie order; the unseen rank 4103 cannot precede rank 4102.
assert [row["row_count"] for row in prepared["filtered"][:5]] == [10] * 5
assert [row["title"] for row in prepared["filtered"][:5]] == [
    f"Tie {index}" for index in range(5)
]

unaffected_query_rows.pop()
try:
    module._prepare_generic_overlay_rankings(
        object(), "active-incomplete", ("parent", {"revision_id": "parent"}),
        options,
    )
except module.PostgresAdapterError as error:
    assert str(error) == (
        "bounded unaffected parent ranking prefix is incomplete"
    )
else:
    raise AssertionError("incomplete unaffected prefix returned a partial page")
print("OK")
`);
  assert.equal(output, "OK");
});

test("7d pageSize1 hydrates a top affected song card before publishing counts", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

detail_key = "hot song::artist"
row = {
    "rank": 1,
    "detail_key": detail_key,
    "title": "Hot Song",
    "artist": "Artist",
    "name": "Hot Song",
    "row_count": 3,
    "song_count": 1,
    "video_count": 2,
    "timestamp_count": 3,
    # This is the bounded affected-row shape in production: the preparation
    # query deliberately omits the large persisted payload.
    "payload_json": None,
    "search_text": "",
    "channel_search_text": "",
}
change = {
    "entityType": "occurrences",
    "rangeId": "7d",
    "videoId": "deleted-video",
    "occurrenceId": "deleted-occurrence",
    "title": "Hot Song",
    "artist": "Artist",
}

module._apply_runtime_tombstone_groups(
    {detail_key: row},
    [change],
    "songs",
    "_deferred_reset_preview_changes",
)
assert row["row_count"] == 2
assert not module._json_object(row.get("payload_json"))
assert len(row["_deferred_reset_preview_changes"]) == 1

def occurrence(video_id, occurrence_id, channel_id):
    video = {
        "videoId": video_id,
        "title": f"Video {video_id}",
        "channelName": f"Channel {channel_id}",
        "channelId": channel_id,
        "channelHandle": f"/@{channel_id.lower()}",
        "channelUrl": f"https://www.youtube.com/channel/{channel_id}",
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "rangeId": "7d",
    }
    return {
        "videoId": video_id,
        "occurrenceId": occurrence_id,
        "position": 1,
        "rangeId": "7d",
        "title": "Hot Song",
        "artist": "Artist",
        "song": {
            "title": "Hot Song",
            "artist": "Artist",
            "rangeId": "7d",
        },
        "item": dict(video),
        "video": dict(video),
    }

parent_payload = {
    "type": "song",
    "key": detail_key,
    "title": "Hot Song",
    "displayArtist": "Artist",
    "name": "Hot Song",
    "count": 3,
    "songCount": 1,
    "videoCount": 2,
    "timestampCount": 3,
    "occurrences": [
        occurrence(
            "deleted-video",
            "deleted-occurrence",
            "UC-DELETED",
        ),
        occurrence(
            "kept-video",
            "kept-occurrence",
            "UC-KEPT",
        ),
    ],
}
accepted_preview = occurrence(
    "accepted-video",
    "accepted-occurrence",
    "UC-ACCEPTED",
)
# This mirrors the existing-parent delta branch: the candidate aggregate raises
# scalar counts, while only its bounded preview tuple is retained until render.
row["row_count"] += 1
row["timestamp_count"] += 1
row["video_count"] += 1
row["_deferred_candidate_previews"] = [accepted_preview]
accepted_candidate = {
    "revision_id": "accepted",
    "video_id": "accepted-video",
    "occurrence_id": "accepted-occurrence",
    "position": 1,
    "range_id": "7d",
    "title": "Hot Song",
    "artist": "Artist",
    "video_payload_json": dict(accepted_preview["item"]),
    "occurrence_payload_json": {
        key: value
        for key, value in accepted_preview.items()
        if key not in {"item", "video", "song"}
    },
}
payload_queries = []
def one(_connection, sql, params):
    assert "exact returned generic ranking payload hydration" in sql
    payload_queries.append(tuple(params))
    return {"payload_json": parent_payload}

module._one = one
prepared = {
    "filtered": (dict(row),),
    "metadata": (),
    "candidateRows": (accepted_candidate,),
    "parentRevisionId": "parent",
    "aggregateTotals": {
        "totalCount": 1,
        "totalOccurrenceCount": 3,
        "totalSongCount": 1,
        "totalVideoCount": 3,
    },
}
rendered = module._render_generic_overlay_rankings(
    object(),
    prepared,
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "1",
    },
)
assert len(rendered["records"]) == 1
record = rendered["records"][0]
assert record["rank"] == 1
assert record["key"] == detail_key
assert record["title"] == "Hot Song"
assert record["displayArtist"] == "Artist"
assert record["count"] == 3
assert record["songCount"] == 1
assert record["videoCount"] == 3
assert isinstance(record["occurrences"], list)
assert len(record["occurrences"]) == 2
by_video = {
    occurrence["videoId"]: occurrence
    for occurrence in record["occurrences"]
}
assert "deleted-video" not in by_video
kept = by_video["kept-video"]
assert kept["videoId"] == "kept-video"
assert kept["occurrenceId"] == "kept-occurrence"
assert kept["item"] == kept["video"]
assert kept["item"]["channelId"] == "UC-KEPT"
accepted = by_video["accepted-video"]
assert accepted["occurrenceId"] == "accepted-occurrence"
assert accepted["item"] == accepted["video"]
assert accepted["item"]["channelId"] == "UC-ACCEPTED"
assert payload_queries == [(
    "parent", "7d", "songs", "count", detail_key,
)]

later_runtime_change = {
    "entityType": "occurrences",
    "rangeId": "7d",
    "videoId": "accepted-video",
    "occurrenceId": "accepted-occurrence",
    "title": "Hot Song",
    "artist": "Artist",
    "originalGroupVideoOccurrenceCount": 1,
}
module._apply_runtime_tombstone_groups(
    {detail_key: row},
    [later_runtime_change],
    "songs",
)
assert row["row_count"] == 2
assert row["video_count"] == 2
assert len(row["_deferred_runtime_preview_changes"]) == 1
after_runtime = module._render_generic_overlay_rankings(
    object(),
    {
        **prepared,
        "filtered": (dict(row),),
        "aggregateTotals": {
            "totalCount": 1,
            "totalOccurrenceCount": 2,
            "totalSongCount": 1,
            "totalVideoCount": 2,
        },
    },
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "1",
    },
)
after_runtime_record = after_runtime["records"][0]
assert after_runtime_record["count"] == 2
assert after_runtime_record["videoCount"] == 2
assert {
    item["videoId"]
    for item in after_runtime_record["occurrences"]
} == {"kept-video"}
assert payload_queries == [
    ("parent", "7d", "songs", "count", detail_key),
    ("parent", "7d", "songs", "count", detail_key),
]

module._one = lambda *_args: {}
try:
    module._render_generic_overlay_rankings(
        object(),
        {
            **prepared,
            "filtered": (dict(row),),
        },
        {
            "range": "7d",
            "view": "songs",
            "metric": "occurrences",
            "page": "1",
            "pageSize": "1",
        },
    )
except module.PostgresAdapterError as error:
    assert str(error) == "generic ranking payload hydration is incomplete"
else:
    raise AssertionError("counts-only affected card did not fail closed")

unknown_key = "unknown song::"
unknown_parent_preview = occurrence(
    "unknown-parent-video",
    "unknown-parent-occurrence",
    "UC-UNKNOWN-PARENT",
)
unknown_parent_preview["title"] = "Unknown Song"
unknown_parent_preview["artist"] = ""
unknown_parent_preview["song"].update({
    "title": "Unknown Song",
    "artist": "",
})
unknown_candidate_preview = occurrence(
    "unknown-candidate-video",
    "unknown-candidate-occurrence",
    "UC-UNKNOWN-CANDIDATE",
)
unknown_candidate_preview["title"] = "Unknown Song"
unknown_candidate_preview["artist"] = ""
unknown_candidate_preview["song"].update({
    "title": "Unknown Song",
    "artist": "",
})
unknown_row = {
    "rank": 1,
    "detail_key": unknown_key,
    "title": "Unknown Song",
    "artist": "",
    "name": "Unknown Song",
    "row_count": 2,
    "song_count": 1,
    "video_count": 2,
    "timestamp_count": 2,
    "payload_json": None,
    "_deferred_candidate_previews": [unknown_candidate_preview],
}
unknown_parent_payload = {
    "type": "song",
    "key": unknown_key,
    "title": "Unknown Song",
    "displayArtist": "\u672a\u8a18\u8f09",
    "name": "Unknown Song",
    "count": 1,
    "songCount": 1,
    "videoCount": 1,
    "timestampCount": 1,
    "occurrences": [unknown_parent_preview],
}
module._one = lambda *_args: {
    "payload_json": unknown_parent_payload,
}
unknown_rendered = module._render_generic_overlay_rankings(
    object(),
    {
        "filtered": (unknown_row,),
        "metadata": (),
        "candidateRows": (),
        "parentRevisionId": "parent",
    },
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "1",
    },
)
unknown_record = unknown_rendered["records"][0]
assert unknown_record["key"] == unknown_key
assert unknown_record["title"] == "Unknown Song"
assert unknown_record["displayArtist"] == "\u672a\u8a18\u8f09"
assert {
    item["videoId"] for item in unknown_record["occurrences"]
} == {"unknown-parent-video", "unknown-candidate-video"}
print("OK")
`);
  assert.equal(output, "OK");
});

test("unused accepted and runtime replacement preview identity does not block page 1", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def scalar(revision_id, runtime_replacement=False):
    video_payload = {
        "videoId": "MhemBDB0yJo",
        "title": "Shibirei video",
        "channelName": "Shibirei Amoru",
        "channelId": "UCpKdAmIYIkpySO7tsTN0oJA",
        "channelHandle": "/@ShibireiAmoru88",
        "channelUrl": "https://www.youtube.com/@shibireiamoru88",
    }
    return {
        "revision_id": revision_id,
        "video_id": "MhemBDB0yJo",
        "occurrence_id": "position:4",
        "position": 5,
        "range_id": "7d",
        "title": (
            "\u9006\u5149"
            if runtime_replacement
            else "\u9006\u5149(\u30a6\u30bf from ONE PIECE FILM RED)"
        ),
        "artist": "Ado",
        "video_payload_json": video_payload if runtime_replacement else None,
        "occurrence_payload_json": (
            {
                "videoId": "MhemBDB0yJo",
                "occurrenceId": "position:4",
                "position": 5,
                "rangeId": "7d",
                "title": "\u9006\u5149",
                "artist": "Ado",
            }
            if runtime_replacement
            else None
        ),
        "runtime_replacement": runtime_replacement,
    }

top_preview = {
    "videoId": "top-video",
    "occurrenceId": "top-occurrence",
    "position": 1,
    "rangeId": "7d",
    "title": "Top Song",
    "artist": "Top Artist",
    "song": {
        "title": "Top Song",
        "artist": "Top Artist",
        "rangeId": "7d",
    },
    "item": {
        "videoId": "top-video",
        "channelId": "UC-TOP",
        "channelHandle": "/@top",
    },
    "video": {
        "videoId": "top-video",
        "channelId": "UC-TOP",
        "channelHandle": "/@top",
    },
}
top_payload = {
    "type": "song",
    "key": "top song::top artist",
    "title": "Top Song",
    "displayArtist": "Top Artist",
    "count": 68,
    "songCount": 1,
    "videoCount": 68,
    "timestampCount": 68,
    "occurrences": [top_preview],
}
top_row = {
    "rank": 1,
    "detail_key": top_payload["key"],
    "title": top_payload["title"],
    "artist": top_payload["displayArtist"],
    "name": top_payload["title"],
    "row_count": 68,
    "song_count": 1,
    "video_count": 68,
    "timestamp_count": 68,
    "payload_json": top_payload,
}

module._rows = lambda *_args: (_ for _ in ()).throw(
    AssertionError("unused D preview identity must not query hydration")
)
prepared = {
    "filtered": (top_row,),
    "metadata": (),
    "candidateRows": (
        scalar("accepted_30347149376_1"),
        scalar("accepted_30538117062_1", True),
    ),
    "parentRevisionId": "full-parent",
    "aggregateTotals": {
        "totalCount": 9269,
        "totalOccurrenceCount": 19112,
        "totalSongCount": 9269,
        "totalVideoCount": 19000,
    },
}
rendered = module._render_generic_overlay_rankings(
    object(),
    prepared,
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "1",
    },
)
record = rendered["records"][0]
assert record["key"] == "top song::top artist"
assert record["title"] == "Top Song"
assert record["displayArtist"] == "Top Artist"
assert record["count"] == 68
assert record["occurrences"] == [top_preview]

# Reversed input order must still prefer the one explicit runtime replacement.
prepared["candidateRows"] = tuple(reversed(prepared["candidateRows"]))
rendered = module._render_generic_overlay_rankings(
    object(),
    prepared,
    {
        "range": "7d",
        "view": "songs",
        "metric": "occurrences",
        "page": "1",
        "pageSize": "1",
    },
)
assert rendered["records"][0]["key"] == "top song::top artist"

# Two ordinary candidates or two replacements remain ambiguous and fail closed.
for duplicate in (False, True):
    prepared["candidateRows"] = (
        scalar("revision-a", duplicate),
        scalar("revision-b", duplicate),
    )
    try:
        module._render_generic_overlay_rankings(
            object(),
            prepared,
            {
                "range": "7d",
                "view": "songs",
                "metric": "occurrences",
                "page": "1",
                "pageSize": "1",
            },
        )
    except module.PostgresAdapterError as error:
        assert str(error) == (
            "overlay preview hydration has ambiguous candidate preview identity"
        )
    else:
        raise AssertionError("same-kind duplicate preview identity did not fail")

print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta uses nearest full runtime parent through incremental chain", () => {
  assert.equal(
    path.resolve(ADAPTER),
    path.resolve(ROOT, "server", "pg_adapter.py"),
  );
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter_meta_parent_regression", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

revisions = {
    "active-overlay": {
        "revision_id": "active-overlay",
        "parent_revision_id": "intermediate-overlay",
        "status": "active",
        "manifest_json": {
            "runtimeProjection": True,
            "incrementalOverlay": True,
            "parent_revision_id": "candidate-manifest-spoof",
        },
        "source_manifest_sha256": "candidate-source",
        "content_sha256": "candidate-content",
        "activated_at": "candidate-time",
    },
    "intermediate-overlay": {
        "revision_id": "intermediate-overlay",
        "parent_revision_id": "full-runtime",
        "status": "active",
        "manifest_json": {
            "runtimeProjection": True,
            "incrementalOverlay": True,
            "parent_revision_id": "intermediate-manifest-spoof",
        },
    },
    "full-runtime": {
        "revision_id": "full-runtime",
        "parent_revision_id": "historical-full",
        "status": "active",
        "manifest_json": {
            "runtimeProjection": True,
            "incrementalOverlay": False,
            "parent_revision_id": "full-manifest-spoof",
        },
    },
}

revision_calls = []

def one(_connection, sql, params=None):
    values = tuple(params or ())
    if "FROM migration_state" in sql:
        return {"state_value": "active-overlay"}
    if "FROM migration_revisions" in sql:
        revision_id = values[0]
        revision_calls.append(revision_id)
        return revisions.get(revision_id)
    raise AssertionError(sql)

def rows(_connection, sql, params=None):
    if "information_schema.tables" in sql:
        return []
    if "FROM runtime_meta" in sql:
        assert tuple(params) == ("full-runtime",)
        return [{"key": "latest_songs", "value": 12}]
    raise AssertionError(sql)

module._one = one
module._rows = rows
module._overlay_revision_ids = lambda *_args: []
module._apply_generic_overlay_meta_counts = (
    lambda _connection, _parent_revision_id, _overlay_revision_ids, counts, *_args: dict(counts)
)
module._generic_public_all_range_baseline = lambda *_args: (585076, 1755228)

payload = module.meta_payload(object())
assert revision_calls == [
    "active-overlay",
    "intermediate-overlay",
    "full-runtime",
], revision_calls
assert payload["meta"]["active_revision_id"] == "active-overlay"
assert payload["meta"]["parent_revision_id"] == "full-runtime"
assert payload["meta"]["parent_revision_id"] not in {
    "candidate-manifest-spoof",
    "intermediate-manifest-spoof",
    "full-manifest-spoof",
}
assert payload["counts"]["songs"] == 12
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta authoritative 7d plus alias counts are not double counted", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_META_COUNTS_CACHE.clear()
module._GENERIC_META_COUNTS_FLIGHTS.clear()
module._runtime_projection_revision = lambda _c: None
module._generic_runtime_projection_revision = lambda _c: (
    "auth-plus-alias",
    {"status": "active", "manifest_json": {"acceptedOccurrenceCount": 1566}},
)
module._generic_parent_runtime_revision = lambda _c, _r, _rev: (
    "parent", {"manifest_json": {}}
)
module._overlay_revision_ids = lambda *_args: ["authoritative-7d", "alias"]
module._rows = lambda _c, sql, _params: (
    [{"key": "latest_occurrences", "value": 585076},
     {"key": "source_occurrences_rows", "value": 1755228}]
    if "runtime_meta" in sql else []
)
module._generic_public_all_range_baseline = lambda *_args: (585076, 1755228)
module._apply_generic_overlay_meta_counts = lambda _c, _p, _o, counts, *_args: {
    **counts, "occurrences": 586642, "source_occurrences": 1759926,
}
module._authoritative_7d_overlay_ids = lambda *_args: ("authoritative-7d",)
def authoritative_records(_c, ids):
    if tuple(ids) != ("authoritative-7d", "alias"):
        return ()
    return ({
        "video": {
            "videoId": "authoritative-video",
            "channelId": "authoritative-channel",
            "channelName": "Authoritative Channel",
        },
        "occurrences": [{
            "videoId": "authoritative-video",
            "occurrenceId": f"authoritative-{index}",
            "rangeId": "7d",
            "songKey": f"authoritative-song-{index}",
            "title": f"Authoritative Song {index}",
            "artist": "Authoritative Artist",
        } for index in range(1566)],
    },)
module._authoritative_7d_records = authoritative_records
module._generic_overlay_rankings_payload = lambda *_args, **_kwargs: (
    (_ for _ in ()).throw(AssertionError("meta entered full rankings payload"))
)
payload = module.meta_payload(object())
assert payload["counts"]["occurrences"] == 586642, payload
assert payload["counts"]["source_occurrences"] == 1759926, payload
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta excludes the 7d boundary from both generic helpers", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_META_COUNTS_CACHE.clear()
module._GENERIC_META_COUNTS_FLIGHTS.clear()
module._runtime_projection_revision = lambda _c: None
module._generic_runtime_projection_revision = lambda _c: (
    "new-active",
    {"status": "active", "manifest_json": {"acceptedOccurrenceCount": 2}},
)
module._generic_parent_runtime_revision = lambda _c, _r, _rev: (
    "parent", {"manifest_json": {}}
)
module._overlay_revision_ids = lambda *_args: [
    "newer-alias", "authoritative-boundary", "older-curation",
]
module._authoritative_7d_overlay_ids = lambda _c, ids: (
    ("newer-alias", "authoritative-boundary")
    if "authoritative-boundary" in ids else ()
)
baseline_calls = []
module._generic_public_all_range_baseline = (
    lambda _c, parent, overlays: (
        baseline_calls.append((parent, tuple(overlays))) or (100, 300)
    )
)
apply_calls = []
def apply(_c, parent, overlays, counts, public_overlays):
    apply_calls.append((parent, tuple(overlays), tuple(public_overlays)))
    return {
        **counts,
        "videos": 11,
        "songs": 22,
        "ranking_rows": 33,
        "_public_occurrence_delta": 4,
        "_public_source_occurrence_delta": 12,
    }
module._apply_generic_overlay_meta_counts = apply
module._authoritative_7d_records = lambda *_args: (
    {"occurrences": [{"rangeId": "7d"}, {"rangeId": "7d"}]},
)
module._authoritative_7d_meta_deltas = lambda *_args: {
    "videos": 0, "songs": 0, "occurrences": 2,
    "ranking_rows": 0, "source_occurrences": 6,
}
module._generic_overlay_rankings_payload = lambda *_args, **_kwargs: (
    (_ for _ in ()).throw(AssertionError("meta entered full rankings payload"))
)
module._rows = lambda _c, sql, _params: (
    [{"key": "latest_videos", "value": 10},
     {"key": "latest_songs", "value": 20},
     {"key": "latest_occurrences", "value": 999},
     {"key": "latest_ranking_rows", "value": 30},
     {"key": "source_occurrences_rows", "value": 999}]
)

payload = module.meta_payload(object())
assert baseline_calls == [("parent", ())], baseline_calls
assert apply_calls == [
    (
        "parent",
        ("newer-alias", "older-curation"),
        ("newer-alias", "older-curation"),
    ),
], apply_calls
assert payload["counts"] == {
    "videos": 11,
    "songs": 22,
    "occurrences": 106,
    "ranking_rows": 33,
    "source_occurrences": 318,
    "channel_metadata": 0,
    "external_songs": 0,
    "external_videos": 0,
    "external_occurrences": 0,
}, payload
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta replaces the previous authoritative 7d aggregate", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_META_COUNTS_CACHE.clear()
module._GENERIC_META_COUNTS_FLIGHTS.clear()
module._runtime_projection_revision = lambda _c: None
module._generic_runtime_projection_revision = lambda _c: (
    "new-active",
    {"status": "active", "manifest_json": {"acceptedOccurrenceCount": 2}},
)
module._generic_parent_runtime_revision = lambda _c, _r, _rev: (
    "full-parent", {"manifest_json": {}}
)
lineage = ["new-boundary", "previous-alias-newer", "previous-boundary"] + [
    f"previous-old-{index}" for index in range(35)
]
module._overlay_revision_ids = lambda *_args: list(lineage)
authoritative_id_calls = []
def authoritative_ids(_c, ids):
    ids = tuple(ids)
    authoritative_id_calls.append(ids)
    if "new-boundary" in ids:
        return ("new-boundary",)
    if "previous-boundary" in ids:
        return ("previous-alias-newer", "previous-boundary")
    return ()
module._authoritative_7d_overlay_ids = authoritative_ids

def record(video_id, occurrence_values, channel_id):
    return {
        "video": {
            "videoId": video_id,
            "channelId": channel_id,
            "channelName": channel_id,
        },
        "occurrences": tuple({
            "videoId": video_id,
            "occurrenceId": occurrence_id,
            "rangeId": "7d",
            "songKey": song_key,
            "title": title,
            "artist": "Artist",
            "sourceSystem": "core",
        } for occurrence_id, song_key, title in occurrence_values),
    }

new_records = (
    record("new-video", (("new-a", "song-a", "Song A"),
                          ("new-b", "song-b", "Song B")), "channel-new"),
)
old_records = (
    record("old-video", (("old-a", "song-a", "Song A"),), "channel-old"),
)
def authoritative_records(_c, ids):
    return new_records if tuple(ids) == tuple(lineage) else old_records
module._authoritative_7d_records = authoritative_records

baseline_calls = []
def baseline(_c, parent, overlays):
    baseline_calls.append((parent, tuple(overlays)))
    return (100, 300)
module._generic_public_all_range_baseline = baseline
apply_calls = []
def apply(_c, parent, overlays, counts, public_overlays):
    apply_calls.append((parent, tuple(overlays), tuple(public_overlays)))
    return {**counts, "videos": counts["videos"] + 1,
            "songs": counts["songs"] + 1,
            "ranking_rows": counts["ranking_rows"] + 1,
            "_public_occurrence_delta": 4,
            "_public_source_occurrence_delta": 12}
module._apply_generic_overlay_meta_counts = apply
module._rows = lambda _c, sql, _params: (
    [{"key": "latest_videos", "value": 10},
     {"key": "latest_songs", "value": 20},
     {"key": "latest_occurrences", "value": 999},
     {"key": "latest_ranking_rows", "value": 30},
     {"key": "source_occurrences_rows", "value": 999}]
    if "runtime_meta" in sql else []
)
module._generic_overlay_rankings_payload = lambda *_args, **_kwargs: (
    (_ for _ in ()).throw(AssertionError("meta entered full rankings payload"))
)
module.rankings_payload_from_records = lambda *_args, **_kwargs: (
    (_ for _ in ()).throw(AssertionError("meta rendered rankings payload"))
)

payload = module.meta_payload(object())
assert authoritative_id_calls == [
    tuple(lineage), tuple(lineage[1:]),
], authoritative_id_calls
assert baseline_calls == [
    ("full-parent", tuple(lineage[3:])),
], baseline_calls
assert apply_calls == [
    ("full-parent", tuple(lineage[1:]), ("previous-alias-newer",)),
], apply_calls
assert payload["counts"] == {
    "videos": 11,
    "songs": 22,
    "occurrences": 106,
    "ranking_rows": 35,
    "source_occurrences": 318,
    "channel_metadata": 0,
    "external_songs": 0,
    "external_videos": 0,
    "external_occurrences": 0,
}, payload
print("OK")
`);
  assert.equal(output, "OK");
});

test("generic meta does not duplicate overlay ids without a 7d boundary", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

module._GENERIC_META_COUNTS_CACHE.clear()
module._GENERIC_META_COUNTS_FLIGHTS.clear()
module._runtime_projection_revision = lambda _c: None
module._generic_runtime_projection_revision = lambda _c: (
    "active", {"status": "active", "manifest_json": {}}
)
module._generic_parent_runtime_revision = lambda _c, _r, _rev: (
    "parent", {"manifest_json": {}}
)
old_lineage = [f"old-layer-{index}" for index in range(37)]
module._overlay_revision_ids = lambda *_args: list(old_lineage)
module._authoritative_7d_overlay_ids = lambda *_args: ()
baseline_calls = []
module._generic_public_all_range_baseline = (
    lambda _c, parent, overlays: (
        baseline_calls.append((parent, tuple(overlays))) or (100, 300)
    )
)
apply_calls = []
def apply(_c, parent, overlays, counts, public_overlays):
    apply_calls.append((parent, tuple(overlays), tuple(public_overlays)))
    return {**counts, "_public_occurrence_delta": 0,
            "_public_source_occurrence_delta": 0}
module._apply_generic_overlay_meta_counts = apply
module._rows = lambda _c, _sql, _params: [
    {"key": "latest_videos", "value": 10},
    {"key": "latest_songs", "value": 20},
    {"key": "latest_occurrences", "value": 999},
    {"key": "latest_ranking_rows", "value": 30},
    {"key": "source_occurrences_rows", "value": 999},
]

payload = module.meta_payload(object())
assert baseline_calls == [("parent", ())], baseline_calls
assert apply_calls == [
    ("parent", tuple(old_lineage), tuple(old_lineage)),
], apply_calls
assert payload["counts"]["occurrences"] == 100, payload
assert payload["counts"]["source_occurrences"] == 300, payload
print("OK")
`);
  assert.equal(output, "OK");
});

test("empty songs identity does not mutate an empty-key group", () => {
  const output = runPython(`
import copy
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

groups = {
    "::": {
        "detail_key": "::", "title": "", "artist": "", "name": "",
        "row_count": 2, "timestamp_count": 2, "video_count": 1,
        "payload_json": None, "search_text": "", "channel_search_text": "",
    }
}
before = copy.deepcopy(groups)
module._apply_runtime_tombstone_groups(
    groups,
    [{"entityType": "occurrences", "title": "", "artist": "", "videoId": "empty-video"}],
    "songs",
)
assert groups == before, groups
print("OK")
`);
  assert.equal(output, "OK");
});

test("song replacement selection decrements one physical group only", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

groups = {
    "canonical": {
        "detail_key": "canonical", "title": "逆光", "artist": "Ado",
        "row_count": 10, "timestamp_count": 10, "video_count": 4,
        "payload_json": None,
    },
    "punctuation-variant": {
        "detail_key": "punctuation-variant", "title": "逆光!", "artist": "Ado",
        "row_count": 8, "timestamp_count": 8, "video_count": 3,
        "payload_json": None,
    },
}
module._apply_runtime_tombstone_groups(
    groups,
    [{
        "entityType": "occurrences", "title": "逆光", "artist": "Ado",
        "videoId": "video", "occurrenceId": "occurrence", "replacement": True,
        "replacementPayload": {"title": "逆光", "artist": "Ado", "videoId": "video"},
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "songs",
)
assert groups["canonical"]["row_count"] == 9, groups
assert groups["punctuation-variant"]["row_count"] == 8, groups
print("OK")
`);
  assert.equal(output, "OK");
});

test("song replacement fallback selects an existing alias group without guessing unrelated groups", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

groups = {
    "canonical": {
        "detail_key": "canonical", "title": "逆光", "artist": "Ado",
        "row_count": 12, "timestamp_count": 12, "video_count": 5,
        "payload_json": None,
    },
    "new-artist": {
        "detail_key": "new-artist", "title": "Glassy Sky", "artist": "Donna Burke",
        "row_count": 7, "timestamp_count": 7, "video_count": 4,
        "payload_json": None,
    },
}
module._apply_runtime_tombstone_groups(
    groups,
    [
        {
            "entityType": "occurrences", "title": "逆光 (ウタ from ONE PIECE FILM RED)",
            "artist": "Ado", "videoId": "ado-video", "occurrenceId": "ado-occurrence",
            "replacement": True,
            "replacementPayload": {"title": "逆光", "artist": "Ado", "videoId": "ado-video"},
            "originalGroupVideoOccurrenceCount": 1,
        },
        {
            "entityType": "occurrences", "title": "Glassy Sky", "artist": "未記載",
            "videoId": "glass-video", "occurrenceId": "glass-occurrence", "replacement": True,
            "replacementPayload": {"title": "Glassy Sky", "artist": "Donna Burke", "videoId": "glass-video"},
            "originalGroupVideoOccurrenceCount": 1,
        },
    ],
    "songs",
)
assert groups["canonical"]["row_count"] == 11, groups
assert groups["new-artist"]["row_count"] == 7, groups
print("OK")
`);
  assert.equal(output, "OK");
});

test("authoritative 7d resolver uses only the newest boundary group", () => {
  const output = runPython(`
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

calls = []
candidate = {
    "video_id": "boundary-video", "occurrence_id": "boundary-occurrence",
    "range_id": "7d", "title": "Boundary", "artist": "Artist",
}
module._authoritative_7d_overlay_ids = lambda *_args: ("top-alias", "boundary")
module._overlay_candidate_rows = lambda _connection, revision_ids: (
    calls.append(tuple(revision_ids)) or [dict(candidate)]
)
module._overlay_rows_for_range = lambda rows, _range: tuple(rows)
module._accepted_video_resets = lambda *_args: {}
module._runtime_tombstones = lambda *_args: []
module._overlay_source_record = lambda row: {
    "video": {"videoId": row["video_id"], "channelId": "channel"},
    "occurrences": [{
        "videoId": row["video_id"], "occurrenceId": row["occurrence_id"],
        "title": row["title"], "artist": row["artist"], "rangeId": "7d",
    }],
}
module._runtime_replacement_candidate_rows = lambda *_args: []
records = module._authoritative_7d_records(object(), ("top-alias", "boundary"))
assert calls == [("boundary",)], calls
assert sum(len(record["occurrences"]) for record in records) == 1, records
print("OK")
`);
  assert.equal(output, "OK");
});

test("artist-scoped replacement merges one canonical card and preserves safe boundaries", () => {
  const output = runPython(`
import copy
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def preview(video_id, occurrence_id, title, artist):
    return {
        "videoId": video_id, "occurrenceId": occurrence_id,
        "position": 1, "rangeId": "all", "title": title, "artist": artist,
        "song": {"title": title, "artist": artist},
        "item": {"videoId": video_id, "title": "Video " + video_id},
        "video": {"videoId": video_id, "title": "Video " + video_id},
    }

def row(detail_key, title, artist, count=1, video_count=1, source_key="source"):
    payload = {
        "type": "song", "key": detail_key, "title": title,
        "displayArtist": artist, "count": count, "songCount": 1,
        "videoCount": video_count, "timestampCount": count,
        "artists": [artist] if artist else [],
        "variantLabels": [title] if title else [],
        "sourceDetailKey": source_key,
        "sourceDetailPath": "/api/sources/" + source_key,
        "occurrences": [preview(detail_key + "-p" + str(i), "old-" + str(i), title, artist) for i in range(3)],
    }
    return {
        "detail_key": detail_key, "title": title, "artist": artist,
        "name": title, "row_count": count, "song_count": 1,
        "video_count": video_count, "timestamp_count": count,
        "payload_json": payload, "search_text": title + " " + artist,
        "channel_search_text": "",
    }

def delta_item(title, artist, detail_key, count=1, video_count=1):
    return {
        "title": title, "artist": artist, "name": title,
        "occurrenceCount": count,
        "videoIds": {detail_key + "-video-" + str(i) for i in range(video_count)},
        "songKeys": {detail_key + "-song"},
        "occurrences": [preview(detail_key + "-video-" + str(i), "new-" + str(i), title, artist) for i in range(min(3, video_count))],
        "search": title + " " + artist,
    }

# The failed eill revision exposed these exact two cards.  The persisted row
# retains the canonical scalar title while its detail key is the old source
# identity; the replacement delta has the canonical scalar key.
eill_detail = "フィナーレ::eill"
eill_source = "8e481c877d45649e"
groups = {
    eill_detail: row(eill_detail, "フィナーレ。", "eill", 448, 447, eill_source),
}
eill_delta = delta_item("フィナーレ。", "eill", "フィナーレ。::eill", 2063, 2058)
persisted = {key: copy.deepcopy(value) for key, value in groups.items()}
module._apply_overlay_delta_groups(
    groups, persisted, {"フィナーレ。::eill": eill_delta}, "songs", "all",
)
assert list(groups) == [eill_detail], groups
eill = groups[eill_detail]
assert eill["detail_key"] == eill_detail
assert eill["row_count"] == 2511, eill
assert eill["video_count"] == 2505, eill
assert eill["payload_json"]["key"] == eill_detail
assert eill["payload_json"]["sourceDetailKey"] == eill_source
assert eill["payload_json"]["sourceDetailPath"] == "/api/sources/" + eill_source
assert eill["payload_json"]["artists"] == ["eill"]
assert eill["payload_json"]["variantLabels"] == ["フィナーレ。"]
assert eill["payload_json"]["title"] == "フィナーレ。"
assert eill["payload_json"]["displayArtist"] == "eill"
assert len(eill["payload_json"]["occurrences"]) == 6
preview_ids = {
    item["videoId"] for item in eill["payload_json"]["occurrences"]
}
assert {
    "フィナーレ。::eill-video-0",
    "フィナーレ。::eill-video-1",
    "フィナーレ。::eill-video-2",
}.issubset(preview_ids)
assert all(
    item["item"]["videoId"] == item["videoId"]
    and item["video"]["videoId"] == item["videoId"]
    for item in eill["payload_json"]["occurrences"]
)

# The same scalar-only lookup covers reviewed artist-scoped variants whose
# persisted detail key still names the older alias group.
variant_cases = [
    ("すずめ feat.十明::RADWIMPS", "すずめ", "RADWIMPS"),
    ("晩餐歌 Piano Ver::tuki", "晩餐歌", "tuki"),
    ("トウキョウ・シャンディ・ランデヴ feat. 花譜,ツミキ::MAISONdes", "トウキョウ・シャンディ・ランデヴ", "MAISONdes"),
]
variant_delta = {}
for detail_key, title, artist in variant_cases:
    groups[detail_key] = row(detail_key, title, artist)
    variant_delta[title + "::" + artist] = delta_item(title, artist, title + "::" + artist)
variant_persisted = {key: copy.deepcopy(groups[key]) for key, _, _ in variant_cases}
module._apply_overlay_delta_groups(
    groups, variant_persisted, variant_delta, "songs", "all",
)
for detail_key, title, _artist in variant_cases:
    assert detail_key in groups
    assert groups[detail_key]["row_count"] == 2, groups
    assert title + "::" + _artist not in groups or title + "::" + _artist == detail_key

# A non-equivalent canonical scalar and a cross-artist replacement remain new
# cards.  Empty artist identity is also never used for an alias merge.
sunny_detail = "晴る::ヨルシカ"
protected_detail = "Protected::Artist A"
unknown_detail = "Unknown::"
groups.update({
    sunny_detail: row(sunny_detail, "晴る", "ヨルシカ"),
    protected_detail: row(protected_detail, "Protected", "Artist A"),
    unknown_detail: row(unknown_detail, "Unknown", ""),
})
safe_persisted = {
    key: copy.deepcopy(groups[key])
    for key in (sunny_detail, protected_detail, unknown_detail)
}
safe_delta = {
    "晴る [Sunny]::ヨルシカ": delta_item("晴る [Sunny]", "ヨルシカ", "晴る [Sunny]::ヨルシカ"),
    "Protected::Artist B": delta_item("Protected", "Artist B", "Protected::Artist B"),
    "Unknown alt::": delta_item("Unknown alt", "", "Unknown alt::"),
}
module._apply_overlay_delta_groups(groups, safe_persisted, safe_delta, "songs", "all")
assert groups[sunny_detail]["row_count"] == 1
assert "晴る [Sunny]::ヨルシカ" in groups
assert groups[protected_detail]["row_count"] == 1
assert "Protected::Artist B" in groups
assert groups[unknown_detail]["row_count"] == 1
assert "Unknown alt::" in groups
print("OK")
`);
  assert.equal(output, "OK");
});

test("canonical-title search keeps replacement on the filtered persisted card", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

canonical_detail = "フィナーレ::eill"
source_key = "8e481c877d45649e"
parent_payload = {
    "type": "song", "key": canonical_detail, "title": "フィナーレ。",
    "displayArtist": "eill", "count": 448, "songCount": 1,
    "videoCount": 447, "timestampCount": 448,
    "sourceDetailKey": source_key,
    "occurrences": [],
}
base = {
    "rank": 1, "detail_key": canonical_detail,
    "title": "フィナーレ。", "artist": "eill", "name": "フィナーレ。",
    "row_count": 448, "song_count": 1, "video_count": 447,
    "timestamp_count": 448, "payload_json": parent_payload,
    "search_text": "フィナーレ。 eill", "channel_search_text": "",
}
replacement = {
    "revision_id": "overlay", "video_id": "new-eill-video",
    "occurrence_id": "new-eill-occurrence", "position": 1,
    "range_id": "all", "song_key": "eill-song", "title": "フィナーレ。",
    "artist": "eill", "source_id": "", "raw_hash": "",
    "source_system": "latest_json", "channel_id": "channel",
    "channel_handle": "@channel", "channel_name": "Channel",
    "channel_url": "https://www.youtube.com/channel/channel",
    "video_payload_json": {"videoId": "new-eill-video", "channelId": "channel"},
    "occurrence_payload_json": {
        "videoId": "new-eill-video", "occurrenceId": "new-eill-occurrence",
        "position": 1, "rangeId": "all", "songKey": "eill-song",
        "title": "フィナーレ。", "artist": "eill",
    },
    "runtime_replacement": True, "replacement_same_artist": True,
    "replacement_same_video": True,
}

class Connection:
    def cursor(self):
        return object()

module._overlay_revision_ids = lambda *_args: ["overlay"]
module._resolve_exact_vtuber_channel_scope = lambda *_args: None
module._overlay_candidate_rows = lambda *_args: []
module._accepted_video_resets = lambda *_args: {}
module._accepted_video_reset_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args: []
module._runtime_replacement_candidate_rows = lambda *_args: [dict(replacement)]
module._channel_metadata_rows = lambda *_args: []
module._enrich_runtime_original_group_counts = lambda *_args: None
module._overlay_vtuber_replacement_rows = lambda *_args: {}
module._rows = lambda _connection, sql, _params: (
    [dict(base)] if "FROM runtime_ranking_rows" in sql else []
)
options = module._query_options({
    "range": "all", "view": "songs", "metric": "occurrences",
    "q": "フィナーレ。", "searchFields": "title",
    "page": "1", "pageSize": "20",
})
prepared = module._prepare_generic_overlay_rankings(
    Connection(), "active", ("parent", {"revision_id": "parent"}), options,
)
assert [item["detail_key"] for item in prepared["filtered"]] == [canonical_detail]
assert prepared["filtered"][0]["row_count"] == 449
payload = prepared["filtered"][0]["payload_json"]
assert payload["key"] == canonical_detail
assert payload["sourceDetailKey"] == source_key
assert "フィナーレ。::eill" not in [item["detail_key"] for item in prepared["filtered"]]
print("OK")
`);
  assert.equal(output, "OK");
});

test("no-search affected SQL loads legacy and replacement keys before scalar merge", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

old_key = "フィナーレ::eill"
new_key = "フィナーレ。::eill"
change = {
    "entityType": "occurrences", "rangeId": "all",
    "videoId": "old-eill-video", "occurrenceId": "old-eill-occurrence",
    "title": "フィナーレ", "artist": "eill", "replacement": True,
    "channel_id": "channel", "channel_handle": "@channel",
    "channel_url": "https://www.youtube.com/channel/channel",
    "replacementPayload": {
        "videoId": "new-eill-video", "occurrenceId": "new-eill-occurrence",
        "title": "フィナーレ。", "artist": "eill", "rangeId": "all",
        "songKey": "eill-song",
    },
}
replacement = {
    "revision_id": "overlay", "video_id": "new-eill-video",
    "occurrence_id": "new-eill-occurrence", "position": 1,
    "range_id": "all", "song_key": "eill-song", "title": "フィナーレ。",
    "artist": "eill", "video_id": "new-eill-video",
    "occurrence_payload_json": {
        "videoId": "new-eill-video", "occurrenceId": "new-eill-occurrence",
        "position": 1, "rangeId": "all", "songKey": "eill-song",
        "title": "フィナーレ。", "artist": "eill",
    },
    "video_payload_json": {"videoId": "new-eill-video"},
    "runtime_replacement": True,
    "runtime_original_group_key": old_key,
    "replacement_same_artist": True, "replacement_same_video": False,
}
base = {
    "rank": 1, "detail_key": old_key, "title": "フィナーレ。",
    "artist": "eill", "name": "フィナーレ。", "row_count": 448,
    "song_count": 1, "video_count": 447, "timestamp_count": 448,
    "payload_json": None, "search_text": "", "channel_search_text": "",
}
affected_queries = []

def rows(_connection, sql, params):
    if "detail_key = ANY(%s)" in sql:
        affected_queries.append(tuple(params[4]))
        return [dict(base)]
    if "bounded unaffected parent ranking prefix" in sql:
        return []
    if "FROM runtime_ranking_rows" in sql:
        return [dict(base)]
    raise AssertionError(sql)

class Connection:
    def cursor(self):
        return object()

module._rows = rows
module._one = lambda *_args: {
    "total_count": 1, "total_occurrence_count": 448,
    "total_song_count": 1, "total_video_count": 447,
}
module._overlay_revision_ids = lambda *_args: ["overlay"]
module._resolve_exact_vtuber_channel_scope = lambda *_args: None
module._overlay_candidate_rows = lambda *_args: []
module._accepted_video_resets = lambda *_args: {}
module._accepted_video_reset_changes = lambda *_args: []
module._runtime_tombstones = lambda *_args: [dict(change)]
module._runtime_replacement_candidate_rows = lambda *_args: [dict(replacement)]
module._enrich_runtime_original_group_counts = lambda *_args: None
module._channel_metadata_rows = lambda *_args: []
module._overlay_vtuber_replacement_rows = lambda *_args: {}

options = {
    "range": "all", "view": "songs", "metric": "occurrences",
    "q": "", "searchTokens": [], "searchScope": "all",
    "searchFields": [], "page": 1, "pageSize": 20, "minCount": 1,
    "nicheOnly": False, "hideUnknownArtist": False,
}
prepared = module._prepare_generic_overlay_rankings(
    Connection(), "active", ("parent", {"revision_id": "parent"}), options,
)
assert len(affected_queries) == 1, affected_queries
assert old_key in affected_queries[0], affected_queries
assert new_key in affected_queries[0], affected_queries
assert [row["detail_key"] for row in prepared["filtered"]] == [old_key]
assert prepared["filtered"][0]["row_count"] == 448
print("OK")
`);
  assert.equal(output, "OK");
});

test("real failed-revision fixture records the required card and aggregate markers", () => {
  // Keep the product test self-contained.  The remote readback JSON belongs
  // to support evidence and is intentionally not part of the test runtime.
  const fixture = {
    revision_id: "accepted_30743329276_1",
    all: {
      totalCount: 32209,
      totalOccurrenceCount: 585076,
      totalVideoCount: 570391,
    },
    "7d": {
      totalOccurrenceCount: 1445,
      totalVideoCount: 99,
    },
    meta: {
      occurrences: 586521,
      source_occurrences: 1759563,
    },
    eill_cards: [{
      key: "\u30d5\u30a3\u30ca\u30fc\u30ec::eill",
      detailKey: "\u30d5\u30a3\u30ca\u30fc\u30ec::eill",
      sourceDetailKey: "8e481c877d45649e",
      count: 2511,
      videoCount: 2505,
    }],
  };
  assert.equal(fixture.revision_id, "accepted_30743329276_1");
  assert.deepEqual(fixture.all, {
    totalCount: 32209,
    totalOccurrenceCount: 585076,
    totalVideoCount: 570391,
  });
  assert.equal(fixture["7d"].totalOccurrenceCount, 1445);
  assert.equal(fixture["7d"].totalVideoCount, 99);
  assert.equal(fixture.meta.occurrences, 586521);
  assert.equal(fixture.meta.source_occurrences, 1759563);
  assert.deepEqual(
    fixture.eill_cards.map((card) => [
      card.key, card.detailKey, card.sourceDetailKey,
      card.count, card.videoCount,
    ]),
    [[
      "\u30d5\u30a3\u30ca\u30fc\u30ec::eill", "\u30d5\u30a3\u30ca\u30fc\u30ec::eill", "8e481c877d45649e",
      2511, 2505,
    ]],
  );
});

test("focused before shape gets canonical videoId and metadata overlay", () => {
  const result = projectRuntimeVideo({
    view: "videos",
    detail_key: "1b9E79L7PmQ",
    payload_json: {
      type: "video",
      key: "1b9E79L7PmQ",
      title: "Opening",
      count: 88,
      occurrences: [{ videoId: "1b9E79L7PmQ", position: 0 }],
    },
    video_payload_json: {
      payload: {
        videoId: "1b9E79L7PmQ",
        title: "Jul22 stream",
        channelId: "UC1JuhRTsFgZvi2ie2dTUxbg",
        channelName: "Jul22 channel",
        publishedAt: "2026-07-22T16:18:31Z",
      },
    },
  });
  assert.equal(result.videoId, "1b9E79L7PmQ");
  assert.equal(result.channelId, "UC1JuhRTsFgZvi2ie2dTUxbg");
  assert.equal(result.channelName, "Jul22 channel");
  assert.equal(result.publishedAt, "2026-07-22T16:18:31Z");
  assert.equal(result.count, 88);
  assert.equal(result.occurrences[0].videoId, "1b9E79L7PmQ");
});

test("focused songs and artists remain untouched", () => {
  const payload = { key: "song-key", title: "Opening", count: 88 };
  assert.deepEqual(
    projectRuntimeVideo({
      view: "songs",
      detail_key: "1b9E79L7PmQ",
      payload_json: payload,
      video_payload_json: { channelName: "must not leak" },
    }),
    payload,
  );
  assert.deepEqual(
    projectRuntimeVideo({
      view: "artists",
      detail_key: "1b9E79L7PmQ",
      payload_json: payload,
      video_payload_json: { channelName: "must not leak" },
    }),
    payload,
  );
});

test("focused valid video payload is unchanged", () => {
  const payload = {
    type: "video",
    key: "1b9E79L7PmQ",
    videoId: "1b9E79L7PmQ",
    title: "Opening",
    channelName: "existing",
    count: 88,
    occurrences: [{ videoId: "1b9E79L7PmQ", position: 0 }],
  };
  assert.deepEqual(
    projectRuntimeVideo({
      view: "videos",
      detail_key: "1b9E79L7PmQ",
      payload_json: payload,
    }),
    payload,
  );
});

test("focused conflicting explicit ID fails closed", () => {
  const error = runtimeVideoProjectionError({
    view: "videos",
    detail_key: "1b9E79L7PmQ",
    payload_json: { key: "1b9E79L7PmQ", videoId: "K3UF2497gTA" },
  });
  assert.match(error, /payload\.videoId/);
  assert.match(error, /1b9E79L7PmQ/);
});

test("focused empty and non-video keys do not fabricate an ID", () => {
  for (const detail_key of ["", "not-a-video-key", "all:1b9E79L7PmQ"]) {
    const result = projectRuntimeVideo({
      view: "videos",
      detail_key,
      payload_json: { key: detail_key, title: "Opening" },
    });
    assert.equal(result, null, detail_key);
  }
});
