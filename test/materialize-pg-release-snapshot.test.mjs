import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const MATERIALIZER = path.join(
  ROOT,
  "scripts",
  "migration",
  "materialize-pg-release-snapshot.py",
);

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

test("WDC materializer binds every page to one repeatable-read revision", () => {
  const output = runPython(`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

events = []

class Cursor:
    def execute(self, sql):
        events.append(("sql", " ".join(sql.split())))
    def close(self):
        events.append(("cursor", "closed"))

class Connection:
    autocommit = True
    def cursor(self):
        return Cursor()
    def rollback(self):
        events.append(("connection", "rollback"))
    def close(self):
        events.append(("connection", "closed"))

fake = types.ModuleType("pg_adapter")
fake.connect_from_env = lambda: Connection()
fake.meta_payload = lambda _connection: {
    "meta": {
        "active_revision_id": "accepted-fixed",
        "content_sha256": "a" * 64,
        "parent_revision_id": "accepted-parent",
        "source_commit_sha": "b" * 40,
        "built_at": "2026-08-10T00:00:00Z",
        "latest_generated_at": "2026-08-09T23:59:59Z",
    },
}
def rankings(_connection, query):
    assert events[0] == (
        "sql",
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    )
    events.append(("page", query["range"], query["view"], query["metric"]))
    return {
        "schemaVersion": 1,
        "rangeId": query["range"],
        "view": query["view"],
        "metric": query["metric"],
        "page": int(query["page"]),
        "pageSize": int(query["pageSize"]),
        "totalCount": 1,
        "pageCount": 1,
        "records": [{"key": "record"}],
    }
fake.rankings_payload = rankings
sys.modules["pg_adapter"] = fake

spec = importlib.util.spec_from_file_location("materializer", ${JSON.stringify(MATERIALIZER)})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

priority_payload = fake.meta_payload(None)
priority_payload["meta"]["generatedAt"] = "2026-08-10T06:22:03.626Z"
assert module.canonical_meta(priority_payload)["latest_generated_at"] == (
    "2026-08-10T06:22:03.626Z"
)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    marker = module.materialize(
        root / "pages",
        root / "meta.json",
        "accepted-fixed",
    )
    pages = sorted((root / "pages").rglob("page-*.json"))
    assert len(pages) == 18
    assert marker["page_files"] == 18
    assert json.loads((root / "meta.json").read_text())["active_revision_id"] == "accepted-fixed"
    assert all(json.loads(page.read_text())["records"] for page in pages)

assert len([event for event in events if event[0] == "page"]) == 18
assert events[-2:] == [("connection", "rollback"), ("connection", "closed")]
print("OK")
`);
  assert.match(output, /PAGES_DONE files=18 revision=accepted-fixed/);
  assert.match(output, /OK$/);
});
