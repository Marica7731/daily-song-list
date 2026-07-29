#!/usr/bin/env python3
"""Bounded public/candidate API audit for VTuber ranking source identities."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import time
from typing import Any, Mapping
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def text(value: Any) -> str:
    return str(value or "").strip()


def normalized_handle(value: Any) -> str:
    return text(value).lstrip("/@").casefold()


def active_revision(payload: Mapping[str, Any]) -> str:
    """Read the revision from either adapter output or the HTTP envelope."""

    current: Mapping[str, Any] = payload
    for _ in range(3):
        revision = text(current.get("active_revision_id"))
        if revision:
            return revision
        nested = current.get("meta")
        if not isinstance(nested, Mapping):
            break
        current = nested
    return ""


def occurrence_video(occurrence: Mapping[str, Any]) -> Mapping[str, Any]:
    item = occurrence.get("item")
    if isinstance(item, Mapping):
        return item
    video = occurrence.get("video")
    if isinstance(video, Mapping):
        return video
    return occurrence


def fetch_json(base_url: str, path: str, timeout: float) -> tuple[int, int, dict[str, Any]]:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        headers={"Accept": "application/json", "User-Agent": "daily-song-list-identity-audit/1"},
    )
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
        status = int(response.status)
    if status != 200:
        raise RuntimeError(f"HTTP {status}: {path}")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise RuntimeError(f"non-object JSON: {path}")
    return status, len(body), payload


def parse_source_probe(value: str) -> tuple[str, str, int, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("source probe must be key,channelId,occurrences,videos")
    return parts[0], parts[1], int(parts[2]), int(parts[3])


def audit_record(record: Mapping[str, Any]) -> set[str]:
    problems: set[str] = set()
    top_id = text(record.get("channelId"))
    if not top_id and text(record.get("key")).startswith("UC"):
        top_id = text(record.get("key"))
    top_handle = normalized_handle(record.get("channelHandle"))
    if not top_id:
        problems.add("missing_card_channel_id")
    if not text(record.get("sourceDetailKey")):
        problems.add("missing_source_detail_key")
    channel_url = text(record.get("channelUrl")).casefold()
    if channel_url and not (
        (top_id and top_id.casefold() in channel_url)
        or (top_handle and top_handle in channel_url)
    ):
        problems.add("card_channel_url_mismatch")

    for occurrence in record.get("occurrences") or ():
        if not isinstance(occurrence, Mapping):
            problems.add("invalid_occurrence")
            continue
        item = occurrence.get("item") if isinstance(occurrence.get("item"), Mapping) else {}
        legacy_video = occurrence.get("video") if isinstance(occurrence.get("video"), Mapping) else {}
        if item and legacy_video:
            for field in ("videoId", "channelId", "channelHandle", "thumbnailUrl"):
                if text(item.get(field)) != text(legacy_video.get(field)):
                    problems.add("item_video_identity_mismatch")
        video = occurrence_video(occurrence)
        inner_id = text(video.get("channelId"))
        inner_handle = normalized_handle(video.get("channelHandle"))
        if top_id and inner_id and top_id != inner_id:
            problems.add("card_occurrence_channel_id_mismatch")
        if top_handle and inner_handle and top_handle != inner_handle:
            problems.add("card_occurrence_handle_mismatch")
        video_id = text(video.get("videoId") or occurrence.get("videoId"))
        for candidate in (
            video.get("thumbnailUrl"),
            video.get("videoThumbnailUrl"),
            occurrence.get("thumbnailUrl"),
            occurrence.get("videoThumbnailUrl"),
        ):
            thumbnail = text(candidate)
            if thumbnail and "/vi/" in thumbnail and video_id and f"/vi/{video_id}/" not in thumbnail:
                problems.add("thumbnail_video_id_mismatch")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--range", dest="ranges", action="append", default=[])
    parser.add_argument("--metric", dest="metrics", action="append", default=[])
    parser.add_argument("--page-size", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--max-pages", type=int, default=100)
    parser.add_argument("--skip-rankings", action="store_true")
    parser.add_argument("--expected-active", default="")
    parser.add_argument("--negative-query", default="@shingames7857 全力キング")
    parser.add_argument("--channel-probe", action="append", default=[])
    parser.add_argument("--source-probe", action="append", type=parse_source_probe, default=[])
    args = parser.parse_args()

    ranges = args.ranges or ["all"]
    metrics = args.metrics or ["videos"]
    started = time.monotonic()
    total_bytes = 0
    pages_scanned = 0
    records_scanned = 0
    unique_records: set[str] = set()
    affected_records: set[str] = set()
    problem_counts: Counter[str] = Counter()
    samples: list[dict[str, Any]] = []
    gate_errors: list[str] = []
    ranking_channel_tuples: dict[str, set[tuple[int, int]]] = {}

    _, body_bytes, health = fetch_json(args.base_url, "/healthz", args.timeout)
    total_bytes += body_bytes
    if text(health.get("status")) != "ok":
        raise RuntimeError(f"unhealthy target: {health.get('status')!r}")
    _, body_bytes, meta = fetch_json(args.base_url, "/api/meta", args.timeout)
    total_bytes += body_bytes
    active = active_revision(meta)
    if args.expected_active and active != args.expected_active:
        raise RuntimeError(f"active CAS mismatch: expected={args.expected_active} actual={active}")

    if not args.skip_rankings:
        for range_id in ranges:
            for metric in metrics:
                page = 1
                while True:
                    query = urlencode({
                        "range": range_id,
                        "view": "vtubers",
                        "metric": metric,
                        "page": page,
                        "pageSize": args.page_size,
                    })
                    _, body_bytes, payload = fetch_json(args.base_url, f"/api/rankings?{query}", args.timeout)
                    total_bytes += body_bytes
                    page_count = int(payload.get("pageCount") or 1)
                    if page_count > args.max_pages:
                        raise RuntimeError(f"pageCount {page_count} exceeds cap {args.max_pages}")
                    records = payload.get("records")
                    if not isinstance(records, list):
                        raise RuntimeError(f"records is not a list: range={range_id} metric={metric} page={page}")
                    for record in records:
                        if not isinstance(record, Mapping):
                            raise RuntimeError("ranking record is not an object")
                        records_scanned += 1
                        record_key = f"{range_id}|{metric}|{text(record.get('key'))}|{text(record.get('sourceDetailKey'))}"
                        unique_records.add(f"{range_id}|{text(record.get('key'))}")
                        record_channel_id = text(record.get("channelId"))
                        if range_id == "all" and record_channel_id:
                            ranking_channel_tuples.setdefault(record_channel_id, set()).add((
                                int(record.get("count") or record.get("timestampCount") or 0),
                                int(record.get("videoCount") or 0),
                            ))
                        problems = audit_record(record)
                        if problems:
                            affected_records.add(record_key)
                            problem_counts.update(problems)
                            if len(samples) < 50:
                                first_occurrence = (record.get("occurrences") or [{}])[0]
                                first = occurrence_video(first_occurrence) if isinstance(first_occurrence, Mapping) else {}
                                samples.append({
                                    "range": range_id,
                                    "metric": metric,
                                    "rank": record.get("rank"),
                                    "key": record.get("key"),
                                    "channelId": record.get("channelId"),
                                    "channelHandle": record.get("channelHandle"),
                                    "sourceDetailKey": record.get("sourceDetailKey"),
                                    "occurrenceChannelId": first.get("channelId"),
                                    "occurrenceChannelHandle": first.get("channelHandle"),
                                    "problems": sorted(problems),
                                })
                    pages_scanned += 1
                    print(
                        f"AUDIT_PAGE range={range_id} metric={metric} page={page}/{page_count} "
                        f"records={len(records)} affected={len(affected_records)}",
                        flush=True,
                    )
                    if page >= page_count:
                        break
                    page += 1

    if args.negative_query:
        query = urlencode({
            "range": "all",
            "view": "songs",
            "metric": "occurrences",
            "page": 1,
            "pageSize": 20,
            "q": args.negative_query,
            "searchFields": "title,channel",
        })
        _, body_bytes, negative = fetch_json(args.base_url, f"/api/rankings?{query}", args.timeout)
        total_bytes += body_bytes
        if int(negative.get("totalCount") or 0) != 0:
            gate_errors.append(f"negative query returned records: {args.negative_query!r}")

    for probe in args.channel_probe:
        handle, separator, expected_id = probe.partition("=")
        if not separator or not handle or not expected_id:
            raise RuntimeError(f"invalid channel probe: {probe}")
        query = urlencode({
            "range": "all",
            "view": "vtubers",
            "metric": "videos",
            "page": 1,
            "pageSize": 200,
            "q": handle,
            "searchFields": "channel",
        })
        _, body_bytes, payload = fetch_json(args.base_url, f"/api/rankings?{query}", args.timeout)
        total_bytes += body_bytes
        matches = [
            record for record in payload.get("records") or ()
            if isinstance(record, Mapping) and text(record.get("channelId")) == expected_id
        ]
        if len(matches) != 1 or audit_record(matches[0]):
            gate_errors.append(f"channel probe failed: {probe}")

    for key, expected_id, expected_occurrences, expected_videos in args.source_probe:
        if not args.skip_rankings:
            actual_ranking_tuples = sorted(ranking_channel_tuples.get(expected_id, set()))
            expected_ranking_tuple = [(expected_occurrences, expected_videos)]
            if actual_ranking_tuples != expected_ranking_tuple:
                gate_errors.append(
                    f"ranking/source count mismatch: {key} "
                    f"expected={expected_ranking_tuple} actual={actual_ranking_tuples}"
                )
        query = urlencode({"page": 1, "pageSize": 200})
        _, body_bytes, payload = fetch_json(args.base_url, f"/api/sources/{key}?{query}", args.timeout)
        total_bytes += body_bytes
        record = payload.get("record") if isinstance(payload.get("record"), Mapping) else {}
        if not payload.get("found") or text(record.get("channelId")) != expected_id:
            gate_errors.append(f"source identity probe failed: {key}")
        actual_occurrences = int(payload.get("totalOccurrenceCount") or record.get("occurrenceCount") or 0)
        actual_videos = int(record.get("videoCount") or 0)
        if actual_occurrences != expected_occurrences:
            gate_errors.append(
                f"source occurrence count mismatch: {key} expected={expected_occurrences} actual={actual_occurrences}"
            )
        if actual_videos != expected_videos:
            gate_errors.append(
                f"source video count mismatch: {key} expected={expected_videos} actual={actual_videos}"
            )
        for occurrence in record.get("occurrences") or ():
            if not isinstance(occurrence, Mapping):
                gate_errors.append(f"invalid source occurrence: {key}")
                continue
            inner_id = text(occurrence_video(occurrence).get("channelId"))
            if inner_id and inner_id != expected_id:
                gate_errors.append(f"source occurrence identity mismatch: {key}")

    digest = hashlib.sha256("\n".join(sorted(affected_records)).encode()).hexdigest()
    summary = {
        "activeRevision": active,
        "ranges": ranges,
        "metrics": metrics,
        "pagesScanned": pages_scanned,
        "recordsScanned": records_scanned,
        "uniqueRankingRecords": len(unique_records),
        "affectedRecords": len(affected_records),
        "problemCounts": dict(sorted(problem_counts.items())),
        "sourceProbeRankingTuples": {
            expected_id: sorted(ranking_channel_tuples.get(expected_id, set()))
            for _, expected_id, _, _ in args.source_probe
        },
        "affectedSha256": digest,
        "bytesRead": total_bytes,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "gateErrors": gate_errors,
        "samples": samples,
    }
    print("IDENTITY_AUDIT_SUMMARY " + json.dumps(summary, ensure_ascii=False, sort_keys=True))
    if affected_records or gate_errors:
        raise RuntimeError(
            f"identity audit failed: affected={len(affected_records)} gateErrors={len(gate_errors)}"
        )
    print("IDENTITY_AUDIT_COMPLETE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
