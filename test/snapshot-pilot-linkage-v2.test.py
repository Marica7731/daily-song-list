#!/usr/bin/env python3
"""Versioned integration check for source-capture -> linkage."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "scripts" / "migration" / "collect-formal-source.py"
RUNNER = ROOT / "scripts" / "migration" / "run-snapshot-enrichment-pilot.py"


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


def test_source_and_linkage(root):
    source = root / "source.txt"
    source.write_text("immutable source\n", encoding="utf-8")
    raw_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    formal = {"candidateOnly": True, "minimalFormalCollectionPlan": {"inputs": {"mygitSourceCommit": "36ee3a8b9f32e829fb52119852cadb68db445320", "formalRepoSourceCommit": "1880eb412c20dadfb1ba2b843f24d10cfec6fd77", "expectedVideoIds": ["v1"]}}, "scope": {"realSongObjectCount": 1, "detailNullSentinelCount": 0}}
    write(root / "formal.json", formal)
    write(root / "index.json", {"sources": [{"videoId": "v1", "sourceId": "s1", "sourceHash": "source-hash", "rawHash": raw_hash, "sourcePath": str(source), "occurrences": [{"videoId": "v1", "sourceId": "s1", "sourceHash": "source-hash", "rawHash": raw_hash, "sourceLineOrdinal": 1, "sourceOccurrenceOrdinal": 1, "sourceStartOffsetUtf16": 0, "occurrenceId": "occ-1", "title": "Song", "seconds": 1}]}]})
    result = subprocess.run([sys.executable, str(COLLECTOR), "--formal-source-candidate", str(root / "formal.json"), "--source-index", str(root / "index.json"), "--output-dir", str(root / "capture"), "--source-commit", "f09f905ce6f7835437edd4d85177fe0594d02d5f"], capture_output=True, text=True, check=False)
    closure_text = (root / "capture" / "closure-report.json").read_text(encoding="utf-8") if (root / "capture" / "closure-report.json").is_file() else "<missing closure>"
    assert result.returncode == 0, (result.returncode, result.stderr, closure_text)
    assert json.loads((root / "capture" / "closure-report.json").read_text())["status"] == "CLOSED"

    sidecar = json.loads((ROOT / "config" / "snapshot-recovery" / "jul29-artist-binding.v2.json").read_text(encoding="utf-8"))
    bindings = sidecar["bindings"]
    assert len(bindings) == 12
    assert sidecar["counts"] == {"accepted": 12, "needsReviewExcluded": 11, "detailNullSentinelsExcluded": 16}
    assert all(binding["status"] == "accepted" and int(binding["pass"]) == 1 for binding in bindings)
    rows = []
    for index, binding in enumerate(bindings):
        row = {key: binding[key] for key in ("day", "videoId", "position", "seconds", "title", "sourceId", "sourceHash", "rawHash")}
        row.update({"occurrenceId": "sidecar-occ-%d" % index, "sourceComplete": True, "eventTime": "2026-07-29T00:00:00Z"})
        rows.append(row)
    raw = {"rows": rows, "routeAsOf": "2026-07-29T00:00:00Z"}
    write(root / "raw.json", raw)
    (root / "provider.ndjson").write_text("".join(json.dumps({"occurrenceId": row["occurrenceId"], "rank": index}) + "\n" for index, row in enumerate(rows)), encoding="utf-8")
    run = subprocess.run([sys.executable, str(RUNNER), "--sample-id", "jul29-sample25", "--source-commit", "f09f905ce6f7835437edd4d85177fe0594d02d5f", "--raw-input", str(root / "raw.json"), "--provider-ndjson", str(root / "provider.ndjson"), "--artist-bindings", str(ROOT / "config" / "snapshot-recovery" / "jul29-artist-binding.v2.json"), "--source-index", str(root / "index.json"), "--formal-source-candidate", str(root / "formal.json"), "--release-cutoff-utc", "2026-07-22T00:00:00Z", "--output-root", str(root / "run")], capture_output=True, text=True, check=False)
    assert run.returncode == 0, (run.returncode, run.stderr)
    assert json.loads((root / "run" / "candidate-manifest.json").read_text())["activation"] == 0
    artist = json.loads((root / "run" / "artist-binding-report.json").read_text(encoding="utf-8"))
    assert artist["acceptedCount"] == 12 and artist["firstPassApplied"] == 12 and artist["secondPassApplied"] == 0
    assert artist["reviewExcludedCount"] == 11 and artist["sentinelExcludedCount"] == 16
    assert artist["status"] == "CLOSED" and artist["appliedCount"] == 12


def main():
    with tempfile.TemporaryDirectory(prefix="linkage-v2-", dir=ROOT) as temp:
        test_source_and_linkage(Path(temp))
    print("VERSIONED_LINKAGE_TEST_COMPLETE")


if __name__ == "__main__":
    main()
