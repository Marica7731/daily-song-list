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
            if followup and age_days is not None and age_days <= 3:
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--details", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review-queue", type=Path, required=True)
    parser.add_argument("--now")
    parser.add_argument("--followup", action="store_true")
    args = parser.parse_args()
    try:
        details = json.loads(args.details.read_text(encoding="utf-8"))
        if not isinstance(details, list):
            raise ValueError("details must be an array")
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00")).astimezone(timezone.utc) if args.now else datetime.now(timezone.utc)
        result = audit(details, now, args.followup)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
