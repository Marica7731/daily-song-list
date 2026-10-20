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

test("overlay candidate rows collapse repeated lineage in PostgreSQL before the effective cap", () => {
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
    if "FROM migration_video_rows" in sql:
        return [
            {"revision_id": "new", "video_id": "video-a", "video_title": "New", "channel_id": "UC1", "video_payload_json": None, "video_tombstone": False},
            {"revision_id": "old", "video_id": "video-a", "video_title": "Old", "channel_id": "UC1", "video_payload_json": None, "video_tombstone": False},
        ]
    if "FROM ranked_occurrences" in sql:
        assert "revision_priority(revision_id, overlay_priority) AS MATERIALIZED" in sql
        assert "selected_videos(video_id, selected_priority) AS MATERIALIZED" in sql
        assert "ROW_NUMBER() OVER" in sql and "WHERE identity_rank = 1" in sql
        assert "priority.overlay_priority <= selected.selected_priority" in sql
        assert params[:3] == [["new", "old"], ["video-a"], [0]], params
        return [
            {"revision_id": "new", "video_id": "video-a", "occurrence_id": "occ-1", "position": 0, "title": "Song", "artist": "Artist", "occurrence_payload_json": None},
            {"revision_id": "new", "video_id": "video-a", "occurrence_id": "occ-2", "position": 1, "title": "Other", "artist": "Artist", "occurrence_payload_json": None},
        ]
    raise AssertionError(sql)

module._rows = rows
module._MAX_UNSCOPED_OVERLAY_OCCURRENCES = 2
resolved = module._overlay_candidate_rows(object(), ["new", "old"], False)
assert [row["occurrence_id"] for row in resolved] == ["occ-1", "occ-2"]
assert len(queries) == 2
print("OK")
`);
  assert.equal(output, "OK");
});
