"""Verify sliced pagination reports the true series totalCount/pageCount.

A 34313-record series is frozen as 172 chunks of 200; a user pageSize of 20
must report totalCount=34313 and pageCount=1716 (not 200/10), and pages 1,
172, and the deep 1700s must slice the correct window of records.
"""
from __future__ import annotations

import gzip
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server" / "release_serving_server.py"

TOTAL = 34313
CHUNKS = 172


def _load():
    spec = importlib.util.spec_from_file_location("rss", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules["rss"] = module
    spec.loader.exec_module(module)
    return module


def _build_release(root: Path) -> None:
    sha = "a" * 64
    d = root / sha / "rankings" / "all" / "songs" / "occurrences"
    d.mkdir(parents=True)
    # 172 chunks, each 200 records; record payload keys are distinct.
    rec_no = 0
    for chunk in range(1, CHUNKS + 1):
        n = 200 if chunk < CHUNKS else TOTAL - (CHUNKS - 1) * 200
        records = []
        for _ in range(n):
            records.append({"key": f"k{rec_no:06d}", "count": rec_no})
            rec_no += 1
        payload = {
            "schemaVersion": 1, "rangeId": "all", "view": "songs",
            "metric": "occurrences", "page": chunk, "pageSize": 200,
            "totalCount": TOTAL, "pageCount": CHUNKS, "records": records,
        }
        raw = json.dumps(payload, separators=(",", ":")).encode()
        with gzip.open(d / f"page-{chunk:04d}.json.gz", "wt", encoding="utf-8") as f:
            f.write(raw.decode())
    (root / sha / "meta.json").write_text(
        json.dumps({"activeRevisionId": "r", "sourceCommitSha": "s",
                    "generatedAt": "g"}), encoding="utf-8")
    (root / sha / "manifest.json").write_text("{}", encoding="utf-8")
    (root / "meta").mkdir(parents=True)
    (root / "meta" / "current.json").write_text(
        json.dumps({"contentSha256": sha}), encoding="utf-8")


def main() -> int:
    m = _load()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _build_release(root)
        store = m.ReleaseStore(root)

        # page 1 @ 20
        p1 = store.rankings_page("all", "songs", "occurrences", 1, 20)
        assert p1["totalCount"] == TOTAL, p1["totalCount"]
        assert p1["pageCount"] == (TOTAL + 19) // 20, p1["pageCount"]
        assert len(p1["records"]) == 20
        assert p1["records"][0]["key"] == "k000000"

        # deep page (1700s of 1716)
        deep = store.rankings_page("all", "songs", "occurrences", 1716, 20)
        assert deep["records"], deep["records"]
        assert deep["records"][-1]["key"] == "k034312", deep["records"][-1]

        # chunk boundary crossing: user page 20 @ 20 = records 380..399 (chunk 2)
        cross = store.rankings_page("all", "songs", "occurrences", 20, 20)
        assert cross["records"][0]["key"] == "k000380", cross["records"][0]
        assert cross["records"][-1]["key"] == "k000399", cross["records"][-1]

        # last partial page
        last = store.rankings_page("all", "songs", "occurrences", 1716, 20)
        assert len(last["records"]) == TOTAL - 1715 * 20

        # pageSize 200 == native chunk page, pageCount must be CHUNKS
        p200 = store.rankings_page("all", "songs", "occurrences", 172, 200)
        assert p200["totalCount"] == TOTAL
        assert p200["pageCount"] == CHUNKS

    # Scenario: old API advertises totalCount=34313 but the frozen chunks only
    # hold 34132 records (last chunk 132).  The serving total must reflect the
    # real traversable count, not the inflated header.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sha = "b" * 64
        d = root / sha / "rankings" / "all" / "songs" / "occurrences"
        d.mkdir(parents=True)
        for chunk in range(1, CHUNKS + 1):
            n = 200 if chunk < CHUNKS else 132
            records = [{"key": f"v{chunk:03d}-{i:03d}"} for i in range(n)]
            payload = {"schemaVersion": 1, "rangeId": "all", "view": "songs",
                       "metric": "occurrences", "page": chunk, "pageSize": 200,
                       "totalCount": 34313, "pageCount": CHUNKS, "records": records}
            raw = json.dumps(payload, separators=(",", ":")).encode()
            with gzip.open(d / f"page-{chunk:04d}.json.gz", "wt", encoding="utf-8") as f:
                f.write(raw.decode())
        (root / sha / "meta.json").write_text('{"activeRevisionId":"r"}', encoding="utf-8")
        (root / sha / "manifest.json").write_text("{}", encoding="utf-8")
        (root / "meta").mkdir(parents=True)
        (root / "meta" / "current.json").write_text(json.dumps({"contentSha256": sha}), encoding="utf-8")
        store = m.ReleaseStore(root)
        p = store.rankings_page("all", "songs", "occurrences", 1707, 20)
        # real total = 171*200 + 132 = 34332? No: chunks 1..171 full (200 each) + chunk172=132
        real_total = 171 * 200 + 132
        assert p["totalCount"] == real_total, (p["totalCount"], real_total)
        assert p["pageCount"] == (real_total + 19) // 20, p["pageCount"]
        last_real = store.rankings_page("all", "songs", "occurrences",
                                        (real_total + 19) // 20, 20)
        assert len(last_real["records"]) == real_total % 20, len(last_real["records"])
    print("SLICED_PAGINATION_TOTALCOUNT_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
