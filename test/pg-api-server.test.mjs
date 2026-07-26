import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(ROOT, "server", "pg_api_server.py");
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
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("PG HTTP adapter parses without creating pycache files", () => {
  const source = readFileSync(ADAPTER, "utf8");
  runPython(`compile(${JSON.stringify(source)}, ${JSON.stringify(ADAPTER)}, "exec")`);
});

test("PG HTTP adapter preserves route shapes and structured errors", () => {
  const output = runPython(`
import importlib.util
import json
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("pg_api_server", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.health_payload = lambda connection: {"status": "ok", "counts": {"videos": 1}}
module.meta_payload = lambda connection: {"schemaVersion": 1, "meta": {}, "counts": {"videos": 1}}
def ranking(connection, query):
    if query.get("range") == ["bad"]:
        raise ValueError("range must be 7d or all")
    return {"schemaVersion": 1, "rangeId": "all", "view": "songs", "metric": "occurrences", "totalCount": 1, "records": []}
module.rankings_payload = ranking
module.source_payload = lambda connection, key, query: {"schemaVersion": 1, "found": False, "sourceKey": key}

server = ThreadingHTTPServer(("127.0.0.1", 0), module.make_handler(lambda: object()))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    def get(path):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        client.request("GET", path, headers={"X-Request-Id": "contract-test"})
        response = client.getresponse()
        body = json.loads(response.read().decode())
        return response.status, response.getheader("X-Request-Id"), body
    assert get("/healthz")[0] == 200
    assert get("/api/meta")[2]["schemaVersion"] == 1
    assert get("/api/rankings?range=all&view=songs")[2]["rangeId"] == "all"
    assert get("/api/sources/example%2Fsource")[2]["sourceKey"] == "example/source"
    status, rid, body = get("/api/rankings?range=bad")
    assert status == 400 and body["error"] == "bad_request"
    assert rid == "contract-test"
    status, rid, body = get("/missing")
    assert status == 404 and body["error"] == "not_found" and rid == "contract-test"
finally:
    server.shutdown()
    server.server_close()
print("OK")
`);
  assert.equal(output, "OK");
});
