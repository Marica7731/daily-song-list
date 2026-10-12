import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = process.env.PG_ADAPTER_UNDER_TEST
  ? path.resolve(process.env.PG_ADAPTER_UNDER_TEST)
  : path.join(ROOT, "server", "pg_adapter.py");

function runPython(script) {
  const result = spawnSync("python", ["-B", "-c", script], {
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

test("generic replacement overlay removes only the malformed scalar card", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

target_video = "aPsKoVWQs-E"
target_occurrence = "aPsKoVWQs-E:21:3293"
groups = {
    "malformed::": {
        "detail_key": "malformed::",
        "title": "malformed",
        "artist": "",
        "name": "malformed",
        "row_count": 1,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 1,
        "payload_json": {
            "key": "malformed::",
            "sourceDetailKey": "9606420c78936d3d",
            "title": "malformed",
            "displayArtist": "",
            "count": 1,
            "videoCount": 1,
            "occurrences": [],
        },
        "search_text": "malformed",
        "channel_search_text": "naraetanV",
    },
    "haru::ヨルシカ": {
        "detail_key": "haru::ヨルシカ",
        "title": "晴る",
        "artist": "ヨルシカ",
        "name": "晴る",
        "row_count": 4,
        "song_count": 1,
        "video_count": 2,
        "timestamp_count": 4,
        "payload_json": {"key": "haru::ヨルシカ", "count": 4, "occurrences": []},
    },
    "alias::artist": {
        "detail_key": "alias::artist",
        "title": "Alias",
        "artist": "Artist",
        "name": "Alias",
        "row_count": 2,
        "song_count": 1,
        "video_count": 1,
        "timestamp_count": 2,
        "payload_json": {"key": "alias::artist", "count": 2, "occurrences": []},
    },
}
change = {
    "entityType": "occurrences",
    "videoId": target_video,
    "occurrenceId": target_occurrence,
    "title": "malformed",
    "artist": "",
    "replacement": True,
    "replacementSameArtist": False,
    "replacementSameVideo": True,
    "originalGroupVideoOccurrenceCount": 1,
    "replacementPayload": {
        "videoId": target_video,
        "occurrenceId": target_occurrence,
        "position": 21,
        "seconds": 3293,
        "title": "Butter-Fly",
        "artist": "和田光司",
    },
}
occurrence = {
    "videoId": target_video,
    "occurrenceId": target_occurrence,
    "position": 21,
    "rangeId": "all",
    "seconds": 3293,
    "title": "Butter-Fly",
    "artist": "和田光司",
    "item": {"videoId": target_video, "channelId": "@naraetanV"},
    "video": {"videoId": target_video, "channelId": "@naraetanV"},
    "song": {"title": "Butter-Fly", "artist": "和田光司", "seconds": 3293},
}
delta = {
    "butter-fly::和田光司": {
        "title": "Butter-Fly",
        "artist": "和田光司",
        "name": "Butter-Fly",
        "occurrenceCount": 1,
        "videoIds": {target_video},
        "songKeys": {"butter-fly::和田光司"},
        "occurrences": [occurrence],
        "search": "Butter-Fly 和田光司",
    },
}

module._apply_runtime_tombstone_groups(groups, [change], "songs")
assert "malformed::" not in groups
module._apply_overlay_delta_groups(groups, {}, delta, "songs", "all")
canonical = groups["butter-fly::和田光司"]
assert canonical["row_count"] == 1
assert canonical["video_count"] == 1
assert canonical["payload_json"]["count"] == 1
assert canonical["payload_json"]["videoCount"] == 1
assert canonical["payload_json"]["sourceDetailKey"] == "5770a9510fc530b3"
assert canonical["payload_json"]["occurrences"][0]["occurrenceId"] == target_occurrence
assert groups["haru::ヨルシカ"]["row_count"] == 4
assert groups["alias::artist"]["row_count"] == 2
print("REPLACEMENT_CARD_OVERLAY_OK old=0 canonical=1 target=aPsKoVWQs-E:21:3293 unaffected=alias,7d,haru")
`);
  assert.equal(
    output,
    "REPLACEMENT_CARD_OVERLAY_OK old=0 canonical=1 target=aPsKoVWQs-E:21:3293 unaffected=alias,7d,haru",
  );
});
