import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(ROOT, "server", "pg_api_server.py");
const APP_SOURCE = process.env.APP_SOURCE_PATH || path.join(ROOT, "assets", "app.js");
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
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
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
        return response.status, response.getheader("X-Request-Id"), body, response.getheader("Cache-Control"), response.getheader("Content-Type")
    health = get("/healthz")
    assert health[0] == 200 and health[3] == "public, max-age=30" and health[4].startswith("application/json")
    meta = get("/api/meta")
    assert meta[0] == 200 and meta[2]["schemaVersion"] == 1 and meta[3] == "public, max-age=30"
    rankings = get("/api/rankings?range=all&view=songs")
    assert rankings[0] == 200 and rankings[2]["rangeId"] == "all" and rankings[3] == "public, max-age=30"
    assert get("/api/sources/example%2Fsource")[2]["sourceKey"] == "example/source"
    status, rid, body, _, _ = get("/api/rankings?range=bad")
    assert status == 400 and body["error"] == "bad_request"
    assert rid == "contract-test"
    status, rid, body, _, _ = get("/missing")
    assert status == 404 and body["error"] == "not_found" and rid == "contract-test"
finally:
    server.shutdown()
    server.server_close()
print("OK")
`);
  assert.equal(output, "OK");
});

test("PG HTTP adapter enforces source/search and thumbnail route contracts", () => {
  const output = runPython(`
import importlib.util
import json
import socket
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("pg_api_server", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.socket.timeout is socket.timeout
calls = {"ranking": [], "source": [], "thumbnail": []}

module.health_payload = lambda connection: {"status": "ok", "counts": {"videos": 1}}
module.meta_payload = lambda connection: {"schemaVersion": 1, "meta": {}, "counts": {"videos": 1}}
def ranking(connection, query):
    calls["ranking"].append(query)
    return {
        "schemaVersion": 1, "rangeId": "all", "view": "songs",
        "metric": "occurrences", "searchScope": "all", "records": [],
    }
def source(connection, key, query):
    calls["source"].append(key)
    if key == "timeout":
        raise TimeoutError("bounded source query timed out")
    if key == "postgres-error":
        raise module.PostgresAdapterError("postgresql://operator:TOP_SECRET@db.internal/runtime")
    if key == "internal-error":
        raise RuntimeError("INTERNAL_TOP_SECRET")
    return {"schemaVersion": 1, "found": True, "sourceKey": key, "record": {"occurrences": []}}
module.rankings_payload = ranking
module.source_payload = source

def thumbnail(video_id, quality, method, headers):
    calls["thumbnail"].append((video_id, quality, method, headers))
    if video_id == "aA3cD4eF5gH":
        raise module.ThumbnailRelayError("thumbnail_upstream", "THUMBNAIL_TOP_SECRET", 200)
    if video_id == "bB3cD4eF5gH":
        raise socket.timeout("THUMBNAIL_TIMEOUT_SECRET")
    if video_id == "cC3cD4eF5gH":
        raise RuntimeError("THUMBNAIL_INTERNAL_SECRET")
    if headers.get("If-None-Match") == '"etag-1"':
        return module.ThumbnailResult(status=304, etag='"etag-1"', last_modified="Wed, 01 Jan 2025 00:00:00 GMT")
    body = b"real-image-bytes"
    return module.ThumbnailResult(
        status=200, content_type="image/jpeg", body=body,
        content_length=len(body), etag='"etag-1"',
        last_modified="Wed, 01 Jan 2025 00:00:00 GMT",
    )

server = ThreadingHTTPServer(("127.0.0.1", 0), module.make_handler(lambda: object(), thumbnail))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    def request(method, path, headers=None):
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        client.request(method, path, headers=headers or {"X-Request-Id": "contract-test"})
        response = client.getresponse()
        body = response.read()
        return response.status, response.getheaders(), body

    def header(headers, name):
        return dict((key.lower(), value) for key, value in headers).get(name.lower(), "")

    status, headers, body = request("GET", "/api/sources/")
    assert status == 400 and json.loads(body)["error"] == "bad_request"
    assert "no-store" in header(headers, "Cache-Control")
    assert calls["source"] == []

    status, headers, body = request(
        "GET",
        "/api/rankings?range=all&view=songs&q=%E6%99%B4%E3%82%8B&searchFields=title,artist",
    )
    payload = json.loads(body)
    assert status == 200 and payload["searchScope"] == "song"
    assert calls["ranking"][0]["searchScope"] == ["song"]
    assert "max-age=30" in header(headers, "Cache-Control")

    status, _, body = request("GET", "/api/sources/found")
    assert status == 200 and json.loads(body)["found"] is True
    status, headers, body = request("GET", "/api/sources/timeout")
    timeout_payload = json.loads(body)
    assert status == 504 and timeout_payload["error"] == "source_timeout"
    assert timeout_payload["message"] == "source detail query timed out" and "bounded" not in body.decode()
    assert "no-store" in header(headers, "Cache-Control")

    status, headers, body = request("GET", "/api/sources/postgres-error")
    postgres_payload = json.loads(body)
    assert status == 503 and postgres_payload["error"] == "postgres_unavailable"
    assert postgres_payload["message"] == "PostgreSQL adapter is unavailable" and "TOP_SECRET" not in body.decode()
    assert "no-store" in header(headers, "Cache-Control")

    status, headers, body = request("GET", "/api/sources/internal-error")
    internal_payload = json.loads(body)
    assert status == 500 and internal_payload["error"] == "internal_error"
    assert internal_payload["message"] == "request failed" and "TOP_SECRET" not in body.decode()
    assert "no-store" in header(headers, "Cache-Control")

    valid = "/api/thumbnails/dQw4w9WgXcQ/hqdefault.jpg"
    status, headers, body = request("GET", valid)
    assert status == 200 and body == b"real-image-bytes"
    assert header(headers, "Content-Type") == "image/jpeg"
    assert "max-age=86400" in header(headers, "Cache-Control")
    assert header(headers, "ETag") == '"etag-1"'
    assert header(headers, "Last-Modified") == "Wed, 01 Jan 2025 00:00:00 GMT"

    status, headers, body = request("HEAD", valid)
    assert status == 200 and body == b""
    assert header(headers, "Content-Length") == str(len(b"real-image-bytes"))
    assert header(headers, "ETag") == '"etag-1"'

    status, _, body = request("GET", valid, {"If-None-Match": '"etag-1"'})
    assert status == 304 and body == b""

    invalid_paths = [
        "/api/thumbnails/dQw4w9WgXcQ/hqdefault.jpg?url=http://127.0.0.1/",
        "/api/thumbnails/dQw4w9WgXcQ/hqdefault%2Ejpg",
        "/api/thumbnails/dQw4w9WgXcQ/not-allowlisted.jpg",
        "/api/thumbnails/dQw4w9WgXC!/hqdefault.jpg",
        "/api/thumbnails/dQw4w9WgXcQ/../../etc.jpg",
    ]
    for path in invalid_paths:
        status, headers, body = request("GET", path)
        assert status == 400 and json.loads(body)["error"] == "bad_request"
        assert "no-store" in header(headers, "Cache-Control")

    relay_errors = [
        ("aA3cD4eF5gH", 502, "thumbnail_upstream"),
        ("bB3cD4eF5gH", 504, "thumbnail_timeout"),
        ("cC3cD4eF5gH", 502, "thumbnail_upstream"),
    ]
    for video_id, expected_status, expected_code in relay_errors:
        status, headers, body = request("GET", f"/api/thumbnails/{video_id}/hqdefault.jpg")
        payload = json.loads(body)
        assert status == expected_status and payload["error"] == expected_code, (video_id, status, payload)
        assert "SECRET" not in body.decode() and "no-store" in header(headers, "Cache-Control")
    assert len(calls["thumbnail"]) == 6
finally:
    server.shutdown()
    server.server_close()
print("OK")
`);
  assert.equal(output, "OK");
});

test("thumbnail relay fixes the upstream origin and fails closed on redirect, type, and size", () => {
  const output = runPython(`
import importlib.util
import socket

spec = importlib.util.spec_from_file_location("pg_api_server", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

assert module.thumbnail_upstream_url("dQw4w9WgXcQ", "hqdefault") == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
for video_id, quality in [
    ("https://127.0.0.1/", "hqdefault"),
    ("dQw4w9WgXc%2Q", "hqdefault"),
    ("dQw4w9WgXcQ", "hqdefault/../../etc"),
]:
    try:
        module.thumbnail_upstream_url(video_id, quality)
        raise AssertionError("untrusted thumbnail input was accepted")
    except ValueError:
        pass

class Response:
    def __init__(self, status, content_type, body=b"", headers=None):
        self.status = status
        self._content_type = content_type
        self._body = body
        self._headers = {"Content-Type": content_type, **(headers or {})}
    def getheader(self, name):
        return self._headers.get(name)
    def read(self, limit=-1):
        assert limit == module.THUMBNAIL_MAX_BYTES + 1
        return self._body

class Connection:
    def __init__(self, response):
        self.response = response
        self.calls = []
        self.closed = False
    def request(self, method, path, headers):
        self.calls.append((method, path, headers))
    def getresponse(self):
        return self.response
    def close(self):
        self.closed = True

def run(response):
    connection = Connection(response)
    module._open_thumbnail_connection = lambda: connection
    try:
        module.fetch_thumbnail("dQw4w9WgXcQ", "hqdefault")
        raise AssertionError("invalid upstream response was accepted")
    except module.ThumbnailRelayError as error:
        return error, connection

error, connection = run(Response(302, "text/html", headers={"Location": "http://127.0.0.1/"}))
assert error.code == "thumbnail_upstream" and len(connection.calls) == 1
assert connection.calls[0][1] == "/vi/dQw4w9WgXcQ/hqdefault.jpg"

error, _ = run(Response(200, "text/html", b"not-an-image"))
assert error.code == "thumbnail_content_type"

error, _ = run(Response(200, "image/jpeg", b"x", {"Content-Length": str(module.THUMBNAIL_MAX_BYTES + 1)}))
assert error.code == "thumbnail_too_large"
error, _ = run(Response(200, "image/jpeg", b"x" * (module.THUMBNAIL_MAX_BYTES + 1)))
assert error.code == "thumbnail_too_large"
error, _ = run(Response(200, "image/jpeg", b"xy", {"Content-Length": "1"}))
assert error.code == "thumbnail_length_mismatch"
error, _ = run(Response(200, "image/jpeg", b"x", {"Content-Length": "invalid"}))
assert error.code == "thumbnail_invalid_length"

def timeout_connection():
    raise socket.timeout("connect timeout")
module._open_thumbnail_connection = timeout_connection
try:
    module.fetch_thumbnail("tB3cD4eF5gJ", "hqdefault")
    raise AssertionError("thumbnail timeout was accepted")
except module.ThumbnailRelayError as error:
    assert error.code == "thumbnail_timeout" and error.status == 504

module._THUMBNAIL_MEMORY_CACHE.clear()
cached_id = "aB3cD4eF5gH"
cached_response = Response(
    200, "image/jpeg", b"cache", {
        "Content-Length": "5", "ETag": '"cache-etag"',
        "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    },
)
cached_connection = Connection(cached_response)
module._open_thumbnail_connection = lambda: cached_connection
first = module.fetch_thumbnail(cached_id, "hqdefault")
assert first.status == 200 and first.body == b"cache"
head = module.fetch_thumbnail(cached_id, "hqdefault", method="HEAD")
assert head.status == 200 and head.body == b"" and head.content_length == 5
conditional = module.fetch_thumbnail(
    cached_id, "hqdefault", request_headers={"If-None-Match": '"cache-etag"'},
)
assert conditional.status == 304 and conditional.content_length == 0
precedence = module.fetch_thumbnail(
    cached_id,
    "hqdefault",
    request_headers={
        "If-None-Match": '"not-cache-etag"',
        "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
    },
)
assert precedence.status == 200 and precedence.body == b"cache"
weak_list = module.fetch_thumbnail(
    cached_id,
    "hqdefault",
    request_headers={"If-None-Match": '"other", W/"cache-etag"'},
)
assert weak_list.status == 304 and weak_list.content_length == 0
assert len(cached_connection.calls) == 1
module._THUMBNAIL_MEMORY_CACHE.clear()

bounded_cache = module._ThumbnailMemoryCache()
for index in range(module.THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES + 1):
    bounded_cache.put(
        f"video-{index}",
        "hqdefault",
        module.ThumbnailResult(status=200, content_type="image/jpeg", body=b"x", content_length=1),
    )
assert len(bounded_cache._entries) == module.THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES
assert bounded_cache._bytes == module.THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES
bounded_cache.put(
    "too-large-for-cache",
    "hqdefault",
    module.ThumbnailResult(
        status=200,
        content_type="image/jpeg",
        body=b"x" * (module.THUMBNAIL_MEMORY_CACHE_MAX_BYTES + 1),
        content_length=module.THUMBNAIL_MEMORY_CACHE_MAX_BYTES + 1,
    ),
)
assert len(bounded_cache._entries) == module.THUMBNAIL_MEMORY_CACHE_MAX_ENTRIES
assert bounded_cache._bytes <= module.THUMBNAIL_MEMORY_CACHE_MAX_BYTES
print("OK")
`);
  assert.equal(output, "OK");
});

test(
    "frontend thumbnail helper constructs only the same-origin allowlisted URL and keeps real fallback candidates",
    () => {
      const source = readFileSync(APP_SOURCE, "utf8");
      const start = source.indexOf("function sameOriginThumbnailUrl");
      assert(start >= 0, "same-origin thumbnail helper is missing");
      const end = source.indexOf("\n}\n", start);
      assert(end > start, "same-origin thumbnail helper body is missing");
      const helperSource = source.slice(start, end + 2);
      const helper = vm.runInNewContext(`(${helperSource})`, {
        cleanText: (value) => String(value ?? "").trim(),
      });
      assert.equal(helper("dQw4w9WgXcQ"), "/api/thumbnails/dQw4w9WgXcQ/hqdefault.jpg");
      assert.equal(helper("dQw4w9WgXcQ", "mqdefault"), "/api/thumbnails/dQw4w9WgXcQ/mqdefault.jpg");
      assert.equal(helper("dQw4w9WgXcQ", "default"), "");
      assert.equal(helper("dQw4w9WgXcQ", "sddefault"), "");
      assert.equal(helper("dQw4w9WgXcQ", "maxresdefault"), "");
      assert.equal(helper("short-id"), "");
      assert.equal(helper("dQw4w9WgXcQ", "../../etc"), "");
      assert.match(source, /const sameOrigin = sameOriginThumbnailUrl\(videoId, relayQuality\)/u);
      assert.match(source, /item\.thumbnailUrl/u);
      assert.doesNotMatch(source, /maxresdefault/u);
    },
);
