#!/usr/bin/env python3
"""Apply the bounded 7D timestamp-status rules to detail evidence."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any


TIME_RE = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})$")
VALID_STATUSES = {
    "accepted_candidate",
    "ignored_no_timestamp",
    "pending_followup",
    "skipped_no_increment",
}


def parse_time(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else None
    match = TIME_RE.match(str(value or "").strip())
    if not match:
        return None
    hours = int(match.group(1) or 0)
    return hours * 3600 + int(match.group(2)) * 60 + int(match.group(3))


def parse_published(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        seconds = float(value) / (1000 if value > 100_000_000_000 else 1)
        return datetime.fromtimestamp(seconds, timezone.utc)
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def detail_has_timestamp(detail: dict[str, Any]) -> bool:
    values = detail.get("songs") if isinstance(detail.get("songs"), list) else detail.get("entries")
    if not isinstance(values, list):
        return False
    return any(parse_time(item.get("seconds", item.get("time"))) is not None for item in values if isinstance(item, dict))


def audit(details: list[dict[str, Any]], now: datetime, followup: bool) -> dict[str, Any]:
    counts = Counter()
    records = []
    for detail in details:
        if not isinstance(detail, dict):
            continue
        published_raw = next((detail[key] for key in ("publishedAt", "published_at", "publishedTimestamp", "published_timestamp") if key in detail), None)
        published = parse_published(published_raw)
        has_timestamp = detail_has_timestamp(detail)
        if has_timestamp:
            status = "accepted_candidate"
            reason = "usable_timestamp_present"
        else:
            age_days = (now - published).total_seconds() / 86400 if published else None
            if followup:
                status = "skipped_no_increment"
                reason = "followup_no_timestamp"
            elif age_days is not None and age_days > 3:
                status = "ignored_no_timestamp"
                reason = "published_over_3d_without_timestamp"
            else:
                status = "pending_followup"
                reason = "published_within_3d_without_timestamp" if published else "missing_or_unparseable_publishedAt"
        counts[status] += 1
        records.append({
            "videoId": detail.get("videoId") or detail.get("video_id"),
            "videoUrl": detail.get("videoUrl") or detail.get("url"),
            "publishedText": detail.get("publishedText"),
            "publishedAt": published.isoformat() if published else None,
            "publishedRaw": published_raw,
            "status": status,
            "terminalStatus": status if status in {"ignored_no_timestamp", "skipped_no_increment"} else None,
            "reason": reason,
            "evidence": {"hasTimestamp": has_timestamp, "source": "video-detail"},
        })
    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat(),
        "followup": followup,
        "summary": {
            "accepted_candidate": counts["accepted_candidate"],
            "ignored_no_timestamp": counts["ignored_no_timestamp"],
            "pending_followup": counts["pending_followup"],
            "skipped_no_increment": counts["skipped_no_increment"],
        },
        "records": records,
    }


def accepted_details(
    details: list[dict[str, Any]],
    result: dict[str, Any],
) -> list[dict[str, Any]]:
    records = result.get("records")
    if not isinstance(records, list):
        raise ValueError("status audit records must be an array")
    status_by_video_id: dict[str, str] = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("status audit records must contain objects")
        video_id = str(record.get("videoId") or "").strip()
        status = str(record.get("status") or "").strip()
        if not video_id:
            raise ValueError("status audit record missing videoId")
        if video_id in status_by_video_id:
            raise ValueError(f"status audit repeats videoId={video_id}")
        if status not in VALID_STATUSES:
            raise ValueError(f"status audit has invalid status={status}")
        status_by_video_id[video_id] = status

    detail_by_video_id: dict[str, dict[str, Any]] = {}
    ordered_video_ids: list[str] = []
    for detail in details:
        if not isinstance(detail, dict):
            raise ValueError("details must contain objects")
        video_id = str(detail.get("videoId") or detail.get("video_id") or "").strip()
        if not video_id:
            raise ValueError("detail missing videoId")
        if video_id in detail_by_video_id:
            raise ValueError(f"details repeat videoId={video_id}")
        detail_by_video_id[video_id] = detail
        ordered_video_ids.append(video_id)

    if set(status_by_video_id) != set(detail_by_video_id):
        raise ValueError("status audit/detail videoId lineage mismatch")
    return [
        detail_by_video_id[video_id]
        for video_id in ordered_video_ids
        if status_by_video_id[video_id] == "accepted_candidate"
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review-queue", type=Path, required=True)
    parser.add_argument("--accepted-details-output", type=Path)
    parser.add_argument("--now")
    parser.add_argument("--followup", action="store_true")
    args = parser.parse_args()
    try:
        details = json.loads(args.details.read_text(encoding="utf-8"))
        if not isinstance(details, list):
            raise ValueError("details must be an array")
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00")).astimezone(timezone.utc) if args.now else datetime.now(timezone.utc)
        result = audit(details, now, args.followup)
        filtered_details = accepted_details(details, result) if args.accepted_details_output else None
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if args.accepted_details_output:
            args.accepted_details_output.parent.mkdir(parents=True, exist_ok=True)
            args.accepted_details_output.write_text(
                json.dumps(filtered_details, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        with args.review_queue.open("w", encoding="utf-8") as stream:
            for record in result["records"]:
                if record["status"] != "accepted_candidate":
                    stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(json.dumps(result["summary"], ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"SEVEN_DAY_STATUS_AUDIT_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
