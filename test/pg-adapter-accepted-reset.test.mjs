import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(TEST_DIR, "..", "server", "pg_adapter.py");

test("accepted reset range scope is song-only and keeps full runtime identity input", () => {
  const source = readFileSync(ADAPTER, "utf8");
  assert.match(source, /all_candidate_rows = tuple\(candidate_rows\)/);
  assert.doesNotMatch(source, /all_candidate_rows = candidate_range_rows/);
  assert.match(
    source,
    /if options\["view"\] in \{"songs", "songIndex", "vsingerSongs"\}:\s+accepted_video_resets = \{/s,
  );
  assert.match(source, /candidate_rows = list\(candidate_range_rows\)/);
});

function runPython(script) {
  const python = process.env.PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-c", script], {
    cwd: path.resolve(TEST_DIR, ".."),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("accepted resets use canonical detail_key for aggregate-display song cards", () => {
  const output = runPython(`
import copy
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def candidate(video_id, seconds, position):
    return {
        "revision_id": "overlay",
        "video_id": video_id,
        "occurrence_id": f"{video_id}:0:{seconds}",
        "position": position,
        "range_id": "all",
        "song_key": "fe2a163733ca1fe68c9735ea",
        "seconds": seconds,
        "title": "晴る",
        "artist": "ヨルシカ",
        "source_id": f"source-{video_id}",
        "raw_hash": f"raw-{video_id}",
        "source_system": "fixture",
        "occurrence_payload_json": None,
        "video_payload_json": None,
        "video_title": f"video-{video_id}",
        "channel_name": "fixture channel",
        "channel_id": f"channel-{video_id}",
        "channel_handle": f"@{video_id}",
        "channel_url": f"https://example.test/{video_id}",
        "video_tombstone": False,
    }

candidate_rows = [
    candidate("-bzTqkx9nqI", 9404, 0),
    candidate("98knPPz-_D4", 4284, 1),
    candidate("NnpchszOUbs", 961, 2),
    candidate("9MuXbBmnNvw", 1587, 3),
]
candidate_groups = module._overlay_candidate_groups(candidate_rows, "songs")
assert candidate_groups["晴る::ヨルシカ"]["occurrenceCount"] == 4
assert len(candidate_groups["晴る::ヨルシカ"]["videoIds"]) == 4

reset_changes = [
    {
        "entityType": "occurrences",
        "title": "晴る",
        "artist": "ヨルシカ",
        "videoId": "9MuXbBmnNvw",
        "occurrenceId": "9MuXbBmnNvw:3:1587",
        "acceptedVideoReset": True,
        "originalGroupVideoOccurrenceCount": 1,
    },
    {
        "entityType": "occurrences",
        "title": "晴る",
        "artist": "ヨルシカ",
        "videoId": "Lwq-wrOSuQ8",
        "occurrenceId": "Lwq-wrOSuQ8:1:5853",
        "acceptedVideoReset": True,
        "originalGroupVideoOccurrenceCount": 1,
    },
]

def haru_group():
    return {
        "title": "晴る",
        "artist": "ヨルシカ (4692)、ヨルシカ（2024） (2)",
        "detail_key": "晴る::ヨルシカ",
        "row_count": 4697 + 4,
        "video_count": 4485 + 4,
        "timestamp_count": 4697 + 4,
        "payload_json": {
            "count": 4697 + 4,
            "videoCount": 4485 + 4,
            "timestampCount": 4697 + 4,
        },
    }

for view in ("songs", "songIndex", "vsingerSongs"):
    groups = {"晴る::ヨルシカ": haru_group()}
    module._apply_runtime_tombstone_groups(
        groups,
        reset_changes,
        view,
        allow_accepted_reset_detail_fallback=True,
    )
    row = groups["晴る::ヨルシカ"]
    assert (row["row_count"], row["timestamp_count"], row["video_count"]) == (4699, 4699, 4487)
    assert row["payload_json"]["count"] == 4699
    assert row["payload_json"]["videoCount"] == 4487
    assert row["payload_json"]["timestampCount"] == 4699

scalar = {
    "scalar-key": {
        "title": "Scalar",
        "artist": "Artist",
        "detail_key": "Scalar::Artist",
        "row_count": 10,
        "video_count": 2,
        "timestamp_count": 10,
        "payload_json": {"count": 10, "videoCount": 2, "timestampCount": 10},
    }
}
module._apply_runtime_tombstone_groups(
    scalar,
    [{
        "entityType": "occurrences",
        "title": "Scalar",
        "artist": "Artist",
        "videoId": "scalar-video",
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "songs",
)
assert scalar["scalar-key"]["row_count"] == 9
assert scalar["scalar-key"]["video_count"] == 1

alias = {
    "alias-key": {
        "title": "Alias",
        "artist": "Artist (2024)",
        "detail_key": "Alias::Artist",
        "row_count": 3,
        "video_count": 1,
        "timestamp_count": 3,
        "payload_json": {"count": 3, "videoCount": 1, "timestampCount": 3},
    }
}
module._apply_runtime_tombstone_groups(
    alias,
    [{
        "entityType": "occurrences",
        "title": "Alias",
        "artist": "Artist",
        "videoId": "alias-video",
        "acceptedVideoReset": True,
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "songIndex",
    allow_accepted_reset_detail_fallback=True,
)
assert alias["alias-key"]["row_count"] == 2
assert alias["alias-key"]["video_count"] == 0

runtime_only = {"晴る::ヨルシカ": haru_group()}
runtime_only["晴る::ヨルシカ"]["row_count"] = 10
runtime_only["晴る::ヨルシカ"]["video_count"] = 2
runtime_only["晴る::ヨルシカ"]["timestamp_count"] = 10
module._apply_runtime_tombstone_groups(
    runtime_only,
    [{
        "entityType": "occurrences",
        "title": "晴る",
        "artist": "ヨルシカ",
        "videoId": "runtime-only-video",
        "acceptedVideoReset": True,
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "songs",
)
assert runtime_only["晴る::ヨルシカ"]["row_count"] == 10
assert runtime_only["晴る::ヨルシカ"]["video_count"] == 2

normalized_collision = {"晴る::ヨルシカ": haru_group()}
module._apply_runtime_tombstone_groups(
    normalized_collision,
    [{
        "entityType": "occurrences",
        "title": "晴る",
        "artist": "ヨ ル シ カ",
        "videoId": "normalized-collision-video",
        "acceptedVideoReset": True,
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "songs",
    allow_accepted_reset_detail_fallback=True,
)
assert normalized_collision["晴る::ヨルシカ"]["row_count"] == 4701
assert normalized_collision["晴る::ヨルシカ"]["video_count"] == 4489

empty = {
    "empty-key": {
        "title": "",
        "artist": "",
        "detail_key": "",
        "row_count": 5,
        "video_count": 1,
        "timestamp_count": 5,
        "payload_json": {"count": 5, "videoCount": 1, "timestampCount": 5},
    }
}
module._apply_runtime_tombstone_groups(
    empty,
    [{
        "entityType": "occurrences",
        "title": "",
        "artist": "",
        "videoId": "empty-video",
        "originalGroupVideoOccurrenceCount": 1,
    }],
    "vsingerSongs",
)
assert empty["empty-key"]["row_count"] == 5
assert empty["empty-key"]["video_count"] == 1
print("OK")
`);
  assert.equal(output, "OK");
});
