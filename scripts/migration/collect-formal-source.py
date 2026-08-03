#!/usr/bin/env python3
"""Fetch pinned source bytes read-only and emit a fail-closed source closure."""
from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

REJECT = 78


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def fetch(item):
    url = item.get("sourceUrl") or item.get("url")
    path = item.get("sourcePath") or item.get("path")
    if isinstance(url, str) and url.startswith(("https://", "http://")):
        request = urllib.request.Request(url, headers={"Accept": "application/octet-stream", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    if isinstance(path, str) and path:
        return Path(path).read_bytes()
    raise ValueError("sourcePath/sourceUrl is missing")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--formal-source-candidate", required=True)
    parser.add_argument("--source-index", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args(argv)
    out = Path(args.output_dir)
    formal = read(args.formal_source_candidate)
    inputs = formal.get("minimalFormalCollectionPlan", {}).get("inputs", {})
    expected = list(inputs.get("expectedVideoIds") or formal.get("expectedVideoIds") or [])
    issues = []
    if formal.get("candidateOnly") is not True or not expected:
        issues.append({"code": "formal-source-candidate-invalid"})
    if inputs.get("mygitSourceCommit") != "36ee3a8b9f32e829fb52119852cadb68db445320":
        issues.append({"code": "mygit-source-commit-mismatch"})
    if inputs.get("formalRepoSourceCommit") != "1880eb412c20dadfb1ba2b843f24d10cfec6fd77":
        issues.append({"code": "formal-source-commit-mismatch"})
    try:
        doc = read(args.source_index)
        index = doc.get("sources", doc.get("rows", doc)) if isinstance(doc, dict) else doc
        if not isinstance(index, list):
            raise ValueError("source index must be an array or {sources:[]}")
    except Exception as exc:
        index = []
        issues.append({"code": "source-index-unreadable", "detail": str(exc)})
    by_id = {}
    for item in index:
        if not isinstance(item, dict) or not isinstance(item.get("videoId"), str):
            issues.append({"code": "source-index-row-invalid"})
            continue
        by_id.setdefault(item["videoId"], []).append(item)
    for video_id in expected:
        rows = by_id.get(video_id, [])
        if not rows:
            issues.append({"code": "source-missing", "videoId": video_id})
        elif len(rows) != 1:
            issues.append({"code": "source-duplicate-or-conflict", "videoId": video_id, "count": len(rows)})
    manifest, spine = [], []
    for video_id in expected:
        rows = by_id.get(video_id, [])
        if len(rows) != 1:
            continue
        item = rows[0]
        for field in ("sourceId", "sourceHash", "rawHash"):
            if not isinstance(item.get(field), str) or not item[field]:
                issues.append({"code": "source-field-missing", "videoId": video_id, "field": field})
        try:
            raw = fetch(item)
            digest = hashlib.sha256(raw).hexdigest()
            if digest != str(item.get("rawHash", "")).lower():
                issues.append({"code": "source-bytes-hash-conflict", "videoId": video_id})
            raw_dir = out / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            source_name = hashlib.sha256(item["sourceId"].encode("utf-8")).hexdigest() + ".raw"
            raw_path = raw_dir / source_name
            raw_path.write_bytes(raw)
            endings = "CRLF" if b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"") else "LF"
            manifest.append({"videoId": video_id, "sourceId": item["sourceId"], "sourceHash": item["sourceHash"], "rawHash": digest, "path": "raw/" + source_name, "byteCount": len(raw), "encoding": item.get("encoding", "utf-8"), "lineEndings": endings})
            seen_occurrences = set()
            for occurrence in item.get("occurrences", []):
                required = ("videoId", "sourceId", "sourceHash", "rawHash", "sourceLineOrdinal", "sourceOccurrenceOrdinal", "sourceStartOffsetUtf16", "occurrenceId")
                if any(occurrence.get(field) in (None, "") for field in required):
                    issues.append({"code": "occurrence-join-gap", "videoId": video_id})
                if any(occurrence.get(field) != item.get(field) for field in ("videoId", "sourceId", "sourceHash", "rawHash")):
                    issues.append({"code": "occurrence-source-conflict", "videoId": video_id})
                occurrence_key = (occurrence.get("videoId"), occurrence.get("sourceId"), occurrence.get("sourceHash"), occurrence.get("rawHash"), occurrence.get("sourceLineOrdinal"), occurrence.get("sourceOccurrenceOrdinal"), occurrence.get("occurrenceId"))
                if occurrence_key in seen_occurrences:
                    issues.append({"code": "occurrence-duplicate", "videoId": video_id})
                seen_occurrences.add(occurrence_key)
                spine.append(occurrence)
        except Exception as exc:
            issues.append({"code": "source-fetch-failed", "videoId": video_id, "detail": str(exc)})
    scope = formal.get("scope", {})
    real_expected = scope.get("realSongObjectCount")
    sentinel_expected = scope.get("detailNullSentinelCount")
    real = sum(1 for row in spine if row.get("detailNull") is not True and row.get("status") != "detail_null")
    sentinels = sum(1 for row in spine if row.get("detailNull") is True or row.get("status") == "detail_null")
    if real_expected is not None and real != int(real_expected):
        issues.append({"code": "real-row-count-mismatch", "expected": int(real_expected), "actual": real})
    if sentinel_expected is not None and sentinels != int(sentinel_expected):
        issues.append({"code": "detail-null-sentinel-count-mismatch", "expected": int(sentinel_expected), "actual": sentinels})
    out.mkdir(parents=True, exist_ok=True)
    spine_text = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for row in spine)
    spine_sha = hashlib.sha256(spine_text.encode("utf-8")).hexdigest()
    (out / "occurrence-spine.ndjson").write_text(spine_text, encoding="utf-8")
    write(out / "source-manifest.json", {"schemaVersion": "formal-source/v1", "provider": "youtube_channel_discovery", "sourceCommit": inputs.get("formalRepoSourceCommit"), "mygitSourceCommit": inputs.get("mygitSourceCommit"), "files": manifest, "spineSha256": spine_sha, "status": "CLOSED" if not issues else "REJECT"})
    write(out / "closure-report.json", {"schemaVersion": "formal-source/v1", "expectedVideoCount": len(expected), "realRowCount": real, "detailNullSentinelCount": sentinels, "spineSha256": spine_sha, "status": "CLOSED" if not issues else "REJECT", "issues": issues})
    return 0 if not issues else REJECT


if __name__ == "__main__":
    raise SystemExit(main())
