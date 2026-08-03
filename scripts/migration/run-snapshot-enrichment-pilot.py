#!/usr/bin/env python3
"""Candidate runner: source capture first, then linkage; never activates."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

REJECT = 78


def _pick(value, sample, kind):
    path = Path(value)
    if not path.is_dir():
        return str(path)
    names = {
        "raw": [sample + ".json", sample + ".raw.json"],
        "provider": [sample + ".ndjson", sample + ".provider.ndjson"],
        "artist": ["jul29-artist-binding.v2.json", sample + ".json"],
        "source": [sample + ".json", sample + ".source.json"],
    }[kind]
    for name in names:
        candidate = path / name
        if candidate.is_file():
            return str(candidate)
    raise FileNotFoundError(f"no {kind} input for {sample} under {path}")




def _sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_linked_marker(output, sample, source_commit):
    report_names = (
        "occurrence-closure.json",
        "artist-binding-report.json",
        "release-route-report.json",
    )
    linked = output / "linked-output.ndjson"
    reports = {}
    statuses = {}
    for name in report_names:
        path = output / name
        if not path.is_file():
            raise RuntimeError("linkage output missing " + name)
        value = json.loads(path.read_text(encoding="utf-8"))
        reports[name] = _sha256_file(path)
        statuses[name] = value.get("status", value.get("result", value.get("gate")))
    route = json.loads((output / "release-route-report.json").read_text(encoding="utf-8"))
    route_as_of = route.get("routeAsOfUtc", route.get("routeAsOf", route.get("route_as_of")))
    release_cutoff = route.get("releaseCutoffUtc", route.get("release_cutoff_utc"))
    if not isinstance(route_as_of, str) or not isinstance(release_cutoff, str):
        raise RuntimeError("release route report is missing routeAsOf/releaseCutoffUtc")
    marker = {
        "schemaVersion": "linkage-artifact-marker/v1",
        "kind": "linked-output",
        "status": "linked",
        "closed": True,
        "linkedOutputSha256": _sha256_file(linked),
        "reports": reports,
        "reportStatuses": statuses,
        "artifact": {
            "sampleId": sample,
            "sampleIds": [sample],
            "sourceCommit": source_commit,
            "routeAsOf": route_as_of,
            "releaseCutoffUtc": release_cutoff,
        },
    }
    (output / "linked-output.ndjson.marker").write_text(
        json.dumps(marker, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )

def _run_one(args, sample, output):
    output.mkdir(parents=True, exist_ok=True)
    source_out = output / "source-capture"
    collector = Path(__file__).resolve().parent / "collect-formal-source.py"
    if sample == "jul29-sample25":
        source_rc = subprocess.run([sys.executable, str(collector), "--formal-source-candidate", args.formal_source_candidate, "--source-index", _pick(args.source_index, sample, "source"), "--output-dir", str(source_out), "--source-commit", args.source_commit], check=False).returncode
    else:
        source_out.mkdir(parents=True, exist_ok=True)
        (source_out / "source-manifest.json").write_text(json.dumps({"schemaVersion": "formal-source/v1", "status": "NOT_APPLICABLE", "scope": "jul22-raw456-authoritative-spine"}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        (source_out / "closure-report.json").write_text(json.dumps({"schemaVersion": "formal-source/v1", "status": "NOT_APPLICABLE", "scope": "jul22-raw456-authoritative-spine"}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        source_rc = 0
    linkage = Path(__file__).resolve().parent / "snapshot-pilot-linkage.py"
    linkage_rc = subprocess.run([sys.executable, str(linkage), "--raw-input", _pick(args.raw_input, sample, "raw"), "--provider-ndjson", _pick(args.provider_ndjson, sample, "provider"), "--artist-bindings", _pick(args.artist_bindings, sample, "artist"), "--release-cutoff-utc", args.release_cutoff_utc, "--sample-id", sample, "--output-dir", str(output)], check=False).returncode
    status = "READY" if source_rc == 0 and linkage_rc == 0 else "REJECT"
    if linkage_rc == 0:
        _write_linked_marker(output, sample, args.source_commit)
    (output / "candidate-manifest.json").write_text(json.dumps({"schemaVersion": "linkage-v2-candidate", "sampleId": sample, "sourceCommit": args.source_commit, "sourceCaptureExit": source_rc, "linkageExit": linkage_rc, "releaseEligible": False, "NOT_FOR_RELEASE": True, "activation": 0, "status": status}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return source_rc, linkage_rc


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--raw-input", required=True)
    parser.add_argument("--provider-ndjson", required=True)
    parser.add_argument("--artist-bindings", required=True)
    parser.add_argument("--source-index", required=True)
    parser.add_argument("--formal-source-candidate", required=True)
    parser.add_argument("--release-cutoff-utc", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args(argv)
    if len(args.source_commit) != 40 or any(char not in "0123456789abcdef" for char in args.source_commit):
        print("source_commit must be exact lowercase 40-hex", file=sys.stderr)
        return 2
    if args.sample_id not in {"both", "jul29-sample25", "jul22-raw456"}:
        print("only Jul29 sample25 and Jul22 raw456 are allowed", file=sys.stderr)
        return 2
    output = Path(args.output_root)
    output.mkdir(parents=True, exist_ok=True)
    samples = ["jul29-sample25", "jul22-raw456"] if args.sample_id == "both" else [args.sample_id]
    results = []
    for sample in samples:
        source_rc, linkage_rc = _run_one(args, sample, output / sample if len(samples) > 1 else output)
        results.append({"sampleId": sample, "sourceCaptureExit": source_rc, "linkageExit": linkage_rc, "status": "READY" if source_rc == 0 and linkage_rc == 0 else "REJECT"})
    (output / "pilot-summary.json").write_text(json.dumps({"schemaVersion": "linkage-v2-candidate", "sequence": samples, "samples": results, "releaseEligible": False, "NOT_FOR_RELEASE": True}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return 0 if all(item["status"] == "READY" for item in results) else REJECT


if __name__ == "__main__":
    raise SystemExit(main())
