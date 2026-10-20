#!/usr/bin/env python3
"""Create a non-release eventTime/route preview without recomputing release route."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def sample_videos(payload: Any) -> list[dict[str, Any]]:
    values = payload if isinstance(payload, list) else payload.get("videos") if isinstance(payload, dict) else None
    if not isinstance(values, list) or not all(isinstance(value, dict) for value in values):
        raise ValueError("sample has no supported video list")
    return [dict(value) for value in values]


def sample_route(video: dict[str, Any], payload: Any) -> str | None:
    route = video.get("route")
    if route is None and isinstance(payload, dict):
        route = payload.get("trialRoute")
    return route if isinstance(route, str) else None


def sample_event_time(video: dict[str, Any]) -> tuple[str | None, str | None]:
    if isinstance(video.get("eventTime"), str):
        return video["eventTime"], "sample.eventTime"
    occurrences = video.get("occurrences")
    if isinstance(occurrences, list):
        for occurrence in occurrences:
            if not isinstance(occurrence, dict):
                continue
            for key in ("eventTime", "publishedAtIso", "publishedAt"):
                if isinstance(occurrence.get(key), str):
                    return occurrence[key], f"sample.occurrences[].{key}"
            evidence = occurrence.get("dateEvidence")
            if isinstance(evidence, dict):
                for key in ("eventTime", "publishedAtIso", "publishedAt"):
                    if isinstance(evidence.get(key), str):
                        return evidence[key], f"sample.occurrences[].dateEvidence.{key}"
    return None, None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", required=True, type=Path)
    parser.add_argument("--enriched", required=True, type=Path)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--sample-date", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    payload = json.loads(args.sample.read_text(encoding="utf-8"))
    by_id: dict[str, dict[str, Any]] = {}
    for line in args.enriched.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = json.loads(line)
            by_id[value["videoId"]] = value
    rows = []
    for video in sample_videos(payload):
        video_id = video.get("videoId")
        evidence, evidence_source = sample_event_time(video)
        enriched = by_id.get(video_id, {})
        rows.append(
            {
                "videoId": video_id,
                "sampleDate": args.sample_date,
                "sampleEventTime": evidence,
                "sampleEventTimeSource": evidence_source,
                "trialRoute": sample_route(video, payload),
                "providerEventTime": enriched.get("eventTime"),
                "providerStatus": enriched.get("status", "missing"),
                "releaseRoute": None,
                "releaseRouteStatus": "not_computed",
                "routeDecision": "trial_only" if enriched.get("status") == "ok" else "needs_review",
                "auditResult": (enriched.get("audit") or {}).get("result"),
            }
        )
    result = {
        "previewType": "eventTime-routing-preview",
        "schemaVersion": 1,
        "sampleId": args.sample_id,
        "recordCount": len(rows),
        "releaseRouteStatus": "not_computed",
        "rows": rows,
        "releaseEligible": False,
        "NOT_FOR_RELEASE": True,
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "recordCount": len(rows), "releaseRouteStatus": "not_computed"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
