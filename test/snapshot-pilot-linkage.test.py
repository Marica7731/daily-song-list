#!/usr/bin/env python3
"""Two focused fixtures: Jul22 spine/enrichment and route boundaries."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "migration" / "snapshot-pilot-linkage.py"


def write(path, value, ndjson=False):
    if ndjson:
        path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in value), encoding="utf-8")
    else:
        path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def run(root, sample, raw, provider, bindings, cutoff="2026-07-29T00:00:00Z"):
    write(root / "raw.json", raw)
    write(root / "provider.ndjson", provider, True)
    write(root / "bindings.json", bindings)
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--raw-input", str(root / "raw.json"), "--provider-ndjson", str(root / "provider.ndjson"), "--artist-bindings", str(root / "bindings.json"), "--release-cutoff-utc", cutoff, "--sample-id", sample, "--output-dir", str(root / "out")],
        capture_output=True, text=True, timeout=20, check=False,
    )


def read(root, name):
    return json.loads((root / "out" / name).read_text(encoding="utf-8"))


def test_jul22(root):
    rows = [
        {"videoId": "v-a", "position": 0, "seconds": 12, "eventTime": "2026-07-22T00:00:00Z"},
        {"videoId": "v-b", "position": 1, "seconds": 34, "eventTime": "2026-07-22T00:00:01Z"},
    ]
    providers = [{**{key: row[key] for key in ("videoId", "position", "seconds")}, "rank": i} for i, row in enumerate(rows)]
    result = run(root, "jul22-raw456", {"asOf": "2026-07-29T00:00:00Z", "rows": rows}, providers, [])
    assert result.returncode == 0, (result.returncode, result.stderr)
    linked = [json.loads(line) for line in (root / "out" / "linked-output.ndjson").read_text().splitlines()]
    assert [row["videoId"] for row in linked] == ["v-a", "v-b"]
    assert [row["position"] for row in linked] == [0, 1]
    assert [row["providerEnrichment"]["rank"] for row in linked] == [0, 1]
    assert read(root, "occurrence-closure.json")["status"] == "CLOSED"


def test_route_fixture(root):
    rows = []
    events = ["2026-07-29T00:00:00Z", "2026-07-22T00:00:00Z", "2026-07-20T00:00:00Z", "2026-07-30T00:00:00Z"]
    for index, event in enumerate(events):
        source = f"source-{index}"
        rows.append({
            "occurrenceId": f"occ-{index}", "videoId": f"v-{index}", "position": index, "seconds": index + 1,
            "title": f"Song {index}", "artist": f"Artist {index}", "sourceId": f"s-{index}",
            "sourceHash": f"source-hash-{index}", "rawHash": hashlib.sha256(source.encode()).hexdigest(),
            "sourceText": source, "eventTime": event,
        })
    providers = [{"occurrenceId": row["occurrenceId"], "providerRank": i} for i, row in enumerate(rows)]
    bindings = [
        {"decision": "accepted", "pass": 1, "exactTuple": [rows[0][key] for key in ("videoId", "position", "seconds", "title", "artist")]},
        {"decision": "review11", "exactTuple": ["review"]},
        {"decision": "sentinel16", "exactTuple": ["sentinel"]},
    ]
    result = run(root, "jul29-sample25", {"routeAsOf": "2026-07-29T00:00:00Z", "rows": rows}, providers, bindings, "2026-07-22T00:00:00Z")
    assert result.returncode == 78, (result.returncode, result.stderr)
    route = read(root, "release-route-report.json")
    assert route["counts"] == {"all": 1, "authoritative-7d": 2, "needsReview": 1}, route
    assert any(item["code"] == "future-event-time" for item in route["issues"])
    artist = read(root, "artist-binding-report.json")
    assert artist["acceptedCount"] == 1 and artist["reviewExcludedCount"] == 1 and artist["sentinelExcludedCount"] == 1


def main():
    with tempfile.TemporaryDirectory(prefix="linkage-core-", dir=ROOT) as temp:
        root = Path(temp)
        for name, test in (("jul22", test_jul22), ("route", test_route_fixture)):
            case = root / name
            case.mkdir()
            test(case)
            print("PASS", name)
    print("FOCUSED_TESTS_COMPLETE")


if __name__ == "__main__":
    main()
