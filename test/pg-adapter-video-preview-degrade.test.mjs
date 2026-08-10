import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const ADAPTER = path.join(ROOT, "server", "pg_adapter.py");

function runPython(script) {
  const result = spawnSync(process.env.PYTHON || "python3", ["-c", script], {
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

test("legacy scalar video cards retain exact accepted previews instead of failing the page", () => {
  const output = runPython(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

video_id = "AbCdEfGhI12"
accepted_preview = {
    "videoId": video_id,
    "occurrenceId": "accepted-occurrence",
    "position": 1,
    "title": "Accepted Song",
    "artist": "Accepted Artist",
}
row = {
    "detail_key": video_id,
    "row_count": 1,
    "payload_json": None,
    "_deferred_candidate_previews": [accepted_preview],
}
module._one = lambda *_args: {
    "payload_json": {
        "key": video_id,
        "title": "Legacy scalar video",
        "occurrences": {"legacy": "invalid scalar container"},
    },
}

payload = module._hydrated_generic_ranking_payload(
    object(),
    "parent",
    row,
    {"range": "all", "view": "videos"},
    "count",
)
assert payload["videoId"] == video_id
assert payload["occurrences"] == [accepted_preview]

module._one = lambda *_args: {
    "payload_json": {
        "videoId": "WrongVideo1",
        "title": "Wrong identity",
        "occurrences": None,
    },
}
try:
    module._hydrated_generic_ranking_payload(
        object(),
        "parent",
        row,
        {"range": "all", "view": "videos"},
        "count",
    )
except module.PostgresAdapterError as error:
    assert str(error) == "generic ranking parent previews are invalid"
else:
    raise AssertionError("mismatched legacy video identity did not fail closed")

print("OK")
`);
  assert.equal(output, "OK");
});
