#!/usr/bin/env python3
"""Deterministic, fail-closed linkage core; candidate-only and file-only."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REJECT = 78


def load(path):
    """Load JSON, JSON row wrappers, or NDJSON without changing row order."""
    text = Path(path).read_text(encoding="utf-8")
    try:
        doc = json.loads(text)
        lines = None
    except json.JSONDecodeError:
        lines = [json.loads(line) for line in text.splitlines() if line.strip()]
        doc = lines
    if isinstance(doc, list):
        return [dict(row) for row in doc if isinstance(row, dict)], {}
    if isinstance(doc, dict):
        for key in ("rows", "records", "items", "data", "bindings"):
            if isinstance(doc.get(key), list):
                meta = {k: copy.deepcopy(v) for k, v in doc.items() if k != key}
                return [dict(row) for row in doc[key] if isinstance(row, dict)], meta
        return [dict(doc)], {}
    return [], {}


def _time(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def _iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _stable(value):
    return isinstance(value, str) and bool(value.strip()) and value.strip().lower() not in {
        "null", "missing", "unknown", "generated"
    } and not any(char.isspace() for char in value)


def _spine(row):
    if any(row.get(key) is None or str(row.get(key)).strip() == "" for key in ("videoId", "position", "seconds")):
        return None
    return ":".join(str(row[key]).strip() for key in ("videoId", "position", "seconds"))


def _key(row, mode):
    if mode == "jul22":
        return _spine(row)
    return "occurrence:" + row["occurrenceId"].strip() if _stable(row.get("occurrenceId")) else None


def _source_ok(row):
    missing = [key for key in ("sourceId", "sourceHash", "rawHash") if row.get(key) is None or str(row.get(key)).strip() == ""]
    if missing:
        return False, ["missing-" + key for key in missing]
    if row.get("sourceComplete") is True or row.get("sourceVerified") is True:
        return True, []
    source = row.get("sourceText")
    if isinstance(source, str) and hashlib.sha256(source.encode("utf-8")).hexdigest() == str(row["rawHash"]).lower():
        return True, []
    return False, ["source-completeness-unproven"]


def closure(raw, provider, mode):
    """Close one-to-one authoritative raw/provider identities."""
    issues, eligible, raw_map = [], [], {}
    rows = []
    for index, row in enumerate(raw):
        synthetic = row.get("isSynthetic") is True or str(row.get("rowType", "")).lower() in {"synthetic", "sentinel"}
        if synthetic:
            rows.append({"rowIndex": index, "status": "excluded", "reason": "synthetic"})
            continue
        if mode == "jul29":
            if not _stable(row.get("occurrenceId")):
                issues.append({"code": "occurrence-id-missing", "rowIndex": index})
                rows.append({"rowIndex": index, "status": "needsReview"})
                continue
            ok, reasons = _source_ok(row)
            if not ok:
                issues.extend({"code": reason, "rowIndex": index} for reason in reasons)
                rows.append({"rowIndex": index, "status": "needsReview", "reason": reasons[0]})
                continue
        key = _key(row, mode)
        eligible.append(index)
        rows.append({"rowIndex": index, "identity": key, "status": "pending"})
        if key is None:
            issues.append({"code": "identity-missing", "rowIndex": index})
        else:
            raw_map.setdefault(key, []).append(index)
    for key, indexes in raw_map.items():
        if len(indexes) != 1:
            issues.append({"code": "duplicate-raw", "identity": key, "rowIndexes": indexes})

    provider_map = {}
    for index, row in enumerate(provider):
        key = _key(row, mode)
        if key is None:
            issues.append({"code": "provider-identity-missing", "providerIndex": index})
        else:
            provider_map.setdefault(key, []).append(index)
    for key, indexes in provider_map.items():
        if len(indexes) != 1:
            issues.append({"code": "duplicate-provider", "identity": key, "providerIndexes": indexes})
        if key not in raw_map:
            issues.append({"code": "provider-unmatched", "identity": key, "providerIndexes": indexes})
    for key, indexes in raw_map.items():
        if key not in provider_map:
            issues.append({"code": "provider-missing", "identity": key, "rowIndex": indexes[0]})

    links = {}
    if not issues:
        links = {indexes[0]: provider[provider_map[key][0]] for key, indexes in raw_map.items()}
    report = {
        "eligibleCount": len(eligible),
        "providerCount": len(provider),
        "closedCount": len(links),
        "authoritativeOrder": [_key(raw[index], mode) for index in eligible],
        "status": "CLOSED" if not issues and len(links) == len(eligible) else "REJECT",
        "rows": rows,
        "issues": issues,
    }
    return links, report


def _tuple(row):
    if isinstance(row.get("exactTuple"), list):
        return row["exactTuple"]
    keys = ("day", "videoId", "position", "seconds", "title", "sourceId", "sourceHash", "rawHash")
    if all(row.get(key) is not None for key in keys):
        return [row[key] for key in keys]
    keys = ("videoId", "position", "seconds", "title", "artist")
    return [row.get(key) for key in keys] if all(row.get(key) is not None for key in keys) else None


def artist(rows, bindings, links):
    """Apply only exact accepted tuples; review/sentinel never bind."""
    target = {_json(_tuple(rows[index])): index for index in links if _tuple(rows[index]) is not None}
    applied, issues = {}, []
    counts = {"acceptedCount": 0, "reviewExcludedCount": 0, "sentinelExcludedCount": 0, "firstPassApplied": 0, "secondPassApplied": 0}
    seen = set()
    for index, binding in enumerate(bindings):
        status = str(binding.get("decision", binding.get("status", ""))).lower()
        if "review" in status:
            counts["reviewExcludedCount"] += 1
            continue
        if "sentinel" in status:
            counts["sentinelExcludedCount"] += 1
            continue
        if status not in {"accepted", "approved", "exact"}:
            issues.append({"code": "artist-status-unknown", "bindingIndex": index})
            continue
        counts["acceptedCount"] += 1
        tuple_value = _tuple(binding)
        key = _json(tuple_value)
        if tuple_value is None or key not in target or key in seen:
            issues.append({"code": "artist-tuple-ambiguous-or-wrong", "bindingIndex": index})
            continue
        seen.add(key)
        if int(binding.get("pass", binding.get("round", 1))) == 1:
            counts["firstPassApplied"] += 1
        else:
            counts["secondPassApplied"] += 1
            issues.append({"code": "artist-second-pass-not-allowed", "bindingIndex": index})
        applied[target[key]] = {"exactTuple": tuple_value}
    if counts["acceptedCount"] > 12:
        issues.append({"code": "artist-accepted-count-exceeds-12"})
    if issues:
        applied = {}
    return applied, {**counts, "appliedCount": len(applied), "status": "CLOSED" if not issues else "REJECT", "issues": issues}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def route(rows, indexes, cutoff_text, metadata):
    """Route only explicit eventTime; cutoff is inclusive and future is review."""
    cutoff = _time(cutoff_text)
    if cutoff is None:
        raise ValueError("release cutoff must be timezone-aware ISO-8601")
    asof = next((_time(metadata.get(key)) for key in ("routeAsOf", "routeAsOfUtc", "asOf") if _time(metadata.get(key))), cutoff)
    start = asof - timedelta(days=7)
    routed, issues, counts = {}, [], {"authoritative-7d": 0, "all": 0, "needsReview": 0}
    for index in indexes:
        row = rows[index]
        value = row.get("eventTime")
        if isinstance(value, list) or row.get("eventTimeConflict") is True or len(row.get("eventTimeCandidates", [])) > 1:
            issue = "event-time-conflict"
        else:
            event = _time(value)
            issue = "event-time-missing" if event is None else None
        if issue is None and event > asof:
            issue = "future-event-time"
        if issue:
            counts["needsReview"] += 1
            issues.append({"code": issue, "rowIndex": index})
            continue
        route_name = "all" if event < cutoff or event < start else "authoritative-7d"
        routed[index] = {"releaseRoute": route_name, "releaseCutoffUtc": _iso(cutoff)}
        counts[route_name] += 1
    return routed, {
        "releaseCutoffUtc": _iso(cutoff),
        "routeAsOfUtc": _iso(asof),
        "windowStartUtc": _iso(start),
        "counts": counts,
        "status": "CLOSED" if not issues else "REJECT",
        "issues": issues,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-input", required=True)
    parser.add_argument("--provider-ndjson", required=True)
    parser.add_argument("--artist-bindings", required=True)
    parser.add_argument("--release-cutoff-utc", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    mode = "jul22" if any(token in args.sample_id.lower() for token in ("jul22", "raw456")) else "jul29" if any(token in args.sample_id.lower() for token in ("jul29", "sample25")) else None
    if mode is None:
        print("ERROR: unsupported sample-id", file=sys.stderr)
        return 2
    raw, metadata = load(args.raw_input)
    provider, _ = load(args.provider_ndjson)
    bindings, binding_meta = load(args.artist_bindings)
    links, report = closure(raw, provider, mode)
    applied, artist_report = artist(raw, bindings, links)
    sidecar_counts = binding_meta.get("counts", {}) if isinstance(binding_meta, dict) else {}
    for key, sidecar_key in (("reviewExcludedCount", "needsReviewExcluded"), ("sentinelExcludedCount", "detailNullSentinelsExcluded")):
        if sidecar_key in sidecar_counts:
            artist_report[key] = int(sidecar_counts[sidecar_key])
    if report["issues"]:
        artist_report["status"] = "REJECT"
        artist_report.setdefault("issues", []).append({"code": "closure-rejected"})
        applied = {}
    routed, route_report = route(raw, links, args.release_cutoff_utc, metadata)
    linked = []
    for index in sorted(routed):
        row = copy.deepcopy(raw[index])
        row["providerEnrichment"] = {k: v for k, v in links[index].items() if k not in {"videoId", "position", "seconds", "occurrenceId"}}
        if index in applied:
            row["artistBinding"] = applied[index]
        row.update(routed[index])
        linked.append(row)
    ready = not report["issues"] and not artist_report.get("issues") and not route_report["issues"] and len(linked) == len(links)
    report.update({"schemaVersion": "snapshot-pilot-linkage/v2", "sampleId": args.sample_id, "status": "CLOSED" if ready else "REJECT"})
    route_report.update({"schemaVersion": "snapshot-pilot-linkage/v2", "sampleId": args.sample_id, "releaseReadiness": "READY" if ready else "REJECT", "candidateOnly": True, "activation": "NOT_ATTEMPTED"})
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "occurrence-closure.json").write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (output / "artist-binding-report.json").write_text(json.dumps(artist_report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (output / "release-route-report.json").write_text(json.dumps(route_report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (output / "linked-output.ndjson").write_text("".join(_json(row) + "\n" for row in linked), encoding="utf-8")
    return 0 if ready else REJECT


if __name__ == "__main__":
    raise SystemExit(main())
