"""Integration test: build serving.sqlite from a synthetic bundle and verify
the serving server answers /api/sources/* and FTS search from it locally.

Covers: schema build, sources pagination, FTS5 search, capabilities flag.
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
BUILDER = ROOT / "scripts" / "migration" / "build-serving-sqlite.py"


def _load(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _build_synthetic_bundle(root: Path) -> Path:
    """Create a tiny bundle: 2 ranges x 2 views, each 1 page, 3 cards."""
    pages = {
        "rankings/7d/songs/occurrences/page-0001.json": {
            "schemaVersion": 1, "range": "7d", "view": "songs",
            "metric": "occurrences", "page": 1, "pageCount": 1, "totalCount": 3,
            "records": [
                {"type": "song", "key": "song-1", "title": "Fake Love",
                 "sourceDetailKey": "source-song:1", "timestampCount": 120,
                 "artists": [{"name": "BTS", "count": 120}],
                 "occurrences": [
                     {"videoId": "v1", "title": "Fake Love (Live)", "item": {"videoId": "v1"}},
                     {"videoId": "v2", "title": "Fake Love (MV)", "item": {"videoId": "v2"}},
                     {"videoId": "v3", "title": "Fake Love (Cover)", "item": {"videoId": "v3"}},
                 ]},
                {"type": "song", "key": "song-2", "title": "Spring Day",
                 "sourceDetailKey": "source-song:2", "timestampCount": 90,
                 "artists": [{"name": "BTS", "count": 90}],
                 "occurrences": [{"videoId": "v4", "title": "Spring Day", "item": {"videoId": "v4"}}]},
                {"type": "song", "key": "song-3", "title": "アイドル",
                 "sourceDetailKey": "source-song:3", "timestampCount": 200,
                 "artists": [{"name": "YOASOBI", "count": 200}],
                 "occurrences": [{"videoId": "v5", "title": "アイドル", "item": {"videoId": "v5"}}]},
            ],
        },
        "rankings/7d/vtubers/occurrences/page-0001.json": {
            "schemaVersion": 1, "range": "7d", "view": "vtubers",
            "metric": "occurrences", "page": 1, "pageCount": 1, "totalCount": 1,
            "records": [
                {"type": "vtuber", "key": "vtuber-1", "name": "星街すいせい",
                 "sourceDetailKey": "source-vtuber:1", "channel": "Suisei Channel",
                 "timestampCount": 50, "songs": [{"name": "Stellar Stellar", "count": 50}],
                 "occurrences": [{"videoId": "v6", "title": "Stellar Stellar", "item": {"videoId": "v6"}}]},
            ],
        },
    }
    for rel, payload in pages.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        with gzip.open(path.with_suffix(".json.gz"), "wt", encoding="utf-8") as stream:
            stream.write(raw.decode())
    # meta + manifest so ReleaseStore.current_sha() works
    meta = {"schemaVersion": 1, "activeRevisionId": "rev-1",
            "expectedParentRevisionId": "parent-1", "sourceCommitSha": "deadbeef",
            "generatedAt": "2026-08-07T00:00:00Z", "latestEventTime": "2026-08-07T00:00:00Z"}
    (root / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    (root / "manifest.json").write_text("{}", encoding="utf-8")
    return root


def main() -> int:
    serving = _load(SERVER)
    builder = _load(BUILDER)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        release_root = tmp_path / "releases"
        content_sha = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        final_bundle = release_root / content_sha
        _build_synthetic_bundle(final_bundle)
        # activate via releases/meta/current.json pointer (avoids symlink perms)
        (release_root / "meta").mkdir(parents=True, exist_ok=True)
        (release_root / "meta" / "current.json").write_text(
            json.dumps({"contentSha256": content_sha}), encoding="utf-8")

        # build sqlite
        builder._build_sqlite(final_bundle, final_bundle / "serving.sqlite")
        sqlite_path = final_bundle / "serving.sqlite"
        assert sqlite_path.exists(), "serving.sqlite not created"

        # quick schema sanity + FTS availability
        import sqlite3
        conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
        try:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','virtual')")}
            assert {"occurrences", "source_members", "source_summary", "search_fts"} <= tables, tables
            n = conn.execute("SELECT count(*) FROM source_summary").fetchone()[0]
            assert n == 4, f"summary rows={n}"
            hit = conn.execute(
                "SELECT entity_key FROM search_fts WHERE search_fts MATCH ?",
                ('"BTS"*',)).fetchall()
            assert len(hit) >= 1, f"fts BTS hits={hit}"
        finally:
            conn.close()

        # boot the serving server against the release root
        store = serving.ReleaseStore(release_root)
        handler = serving.make_handler(store)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        try:
            conn = HTTPConnection("127.0.0.1", port, timeout=10)
            # capabilities flag
            conn.request("GET", "/api/meta")
            meta = json.loads(conn.getresponse().read())
            caps = meta.get("capabilities", {})
            assert caps.get("localSources") is True, caps
            assert caps.get("localSearch") is True, caps
            # sources from local sqlite
            conn.request("GET", "/api/sources/source-song:1?range=7d&pageSize=20")
            resp = conn.getresponse()
            payload = json.loads(resp.read())
            assert payload.get("found") is True, payload
            assert payload.get("totalCount") == 3, payload.get("totalCount")
            record = payload.get("record") or {}
            occ = record.get("occurrences") or []
            assert len(occ) == 3, occ
            assert occ[0]["videoId"] in {"v1", "v2", "v3"}
            # FTS search
            conn.request("GET", "/api/rankings?range=7d&view=songs&metric=occurrences&q=YOASOBI")
            resp = conn.getresponse()
            search = json.loads(resp.read())
            assert search.get("records"), search
            assert any("アイドル" in (r.get("title") or "") for r in search["records"]), search
            conn.close()
        finally:
            server.shutdown()
    print("SERVING_SQLITE_INTEGRATION_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
