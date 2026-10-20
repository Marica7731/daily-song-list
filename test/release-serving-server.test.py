"""Focused tests for the thin release-serving API.

The shadow host API must serve only immutable release files, report the
active content SHA, keep page payloads bounded, and fail cleanly when the
release pointer is not ready.  Tests run against a local ReleaseStore with
a synthetic bundle; no network or database is required.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import sys
import tempfile
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "release_serving_server.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("release_serving_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MODULE = _load_module()


def _write_bundle(root: Path, sha: str) -> None:
    bundle = root / sha
    vtuber = bundle / "rankings" / "all" / "vtubers" / "occurrences"
    vtuber.mkdir(parents=True)
    page = {
        "schemaVersion": 1, "rangeId": "all", "view": "vtubers",
        "metric": "occurrences", "page": 1, "pageSize": 10,
        "totalCount": 1, "pageCount": 1, "compact": True,
        "records": [{
            "type": "vtuber", "key": "UC1", "name": "A",
            "channelName": "A", "channelId": "UC1", "count": 3,
            "songCount": 2, "videoCount": 2, "timestampCount": 3,
            "sourceDetailKey": "source-vtuber:all:UC1",
            "sourcePreviewCount": 2, "occurrencePreviewLimited": True,
            "rank": 1, "occurrences": [
                {"videoId": "v1", "sourceId": "s1", "title": "t1"},
                {"videoId": "v2", "sourceId": "s2", "title": "t2"},
            ],
        }],
    }
    (vtuber / "page-0001.json.gz").write_bytes(gzip.compress(json.dumps(page, ensure_ascii=False).encode(), mtime=0))
    meta = {
        "schemaVersion": 1,
        "activeRevisionId": "accepted_test_1",
        "expectedParentRevisionId": "full_runtime_test_1",
        "sourceCommitSha": "110f49915b26777fb39c79aa36a07552a75d42f5",
        "generatedAt": "2026-08-07T00:00:00+00:00",
        "latestEventTime": "2026-07-26T19:33:42.681Z",
    }
    manifest = {
        "schemaVersion": 1,
        "sourceCommitSha": meta["sourceCommitSha"],
        "expectedParentRevisionId": meta["expectedParentRevisionId"],
        "candidateRevisionId": meta["activeRevisionId"],
        "generatedAt": meta["generatedAt"],
        "pages": [{
            "path": "rankings/all/vtubers/occurrences/page-0001.json.gz",
            "bytes": (vtuber / "page-0001.json.gz").stat().st_size,
            "sha256": "test",
            "contentType": "application/gzip",
        }],
    }
    (bundle / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    (bundle / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (root / "current").symlink_to(bundle, target_is_directory=True)


def _start_server(store):
    server = ThreadingHTTPServer(("127.0.0.1", 0), MODULE.make_handler(store))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _get(server, path, headers=None):
    client = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    client.request("GET", path, headers=headers or {"X-Request-Id": "release-test"})
    response = client.getresponse()
    body = response.read()
    return response.status, dict((k.lower(), v) for k, v in response.getheaders()), body


def test_health_meta_and_page_serve_from_release() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sha = "abc123" * 4
        _write_bundle(root, sha)
        server = _start_server(MODULE.ReleaseStore(root))
        try:
            status, headers, body = _get(server, "/healthz")
            assert status == 200 and json.loads(body)["status"] == "ok"
            assert json.loads(body)["currentRelease"] == sha

            status, headers, body = _get(server, "/api/meta")
            payload = json.loads(body)
            assert status == 200
            assert payload["meta"]["content_sha256"] == sha
            assert payload["meta"]["active_revision_id"] == "accepted_test_1"
            assert payload["release"]["pages"] == 1
            assert headers["cache-control"].startswith("public, max-age=300")

            status, _, body = _get(server, "/api/rankings?range=all&view=vtubers&metric=occurrences&page=1")
            payload = json.loads(body)
            assert status == 200 and payload["totalCount"] == 1
            card = payload["records"][0]
            assert len(card["occurrences"]) <= 3
        finally:
            server.shutdown()
            server.server_close()


def test_missing_release_fails_cleanly() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = _start_server(MODULE.ReleaseStore(root))
        try:
            status, _, body = _get(server, "/healthz")
            assert status == 503 and json.loads(body)["status"] == "degraded"
            status, _, body = _get(server, "/api/meta")
            assert status == 200 and json.loads(body)["error"] == "no_current_release"
            status, _, body = _get(server, "/api/rankings?range=all&view=vtubers&metric=occurrences")
            assert status == 404 and json.loads(body)["error"] == "release_page_missing"
        finally:
            server.shutdown()
            server.server_close()


def test_validation_bounds() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write_bundle(root, "abc123" * 4)
        server = _start_server(MODULE.ReleaseStore(root))
        try:
            status, _, body = _get(server, "/api/rankings?range=bad&view=vtubers&metric=occurrences")
            assert status == 400 and json.loads(body)["error"] == "bad_request"
            status, _, body = _get(server, "/api/rankings?range=all&view=vtubers&metric=nope")
            assert status == 400
            status, _, body = _get(server, "/api/rankings?range=all&view=vtubers&metric=occurrences&pageSize=9999")
            assert status == 400
            status, _, body = _get(server, "/missing")
            assert status == 404 and json.loads(body)["error"] == "not_found"
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    tests = [
        test_health_meta_and_page_serve_from_release,
        test_missing_release_fails_cleanly,
        test_validation_bounds,
    ]
    for test in tests:
        test()
    print("RELEASE_SERVING_TESTS_OK")
