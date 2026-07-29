#!/usr/bin/env python3
"""Bounded public/candidate API audit for VTuber ranking source identities."""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
import hashlib
import json
import math
import time
from typing import Any, Mapping
import unicodedata
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import Request, urlopen


SOURCE_PAGE_SIZE = 20


def text(value: Any) -> str:
    return str(value or "").strip()


def normalized_handle(value: Any) -> str:
    """Normalize one public handle prefix without accepting malformed aliases."""

    handle = unicodedata.normalize("NFKC", str(value or "")).strip()
    if handle.startswith("/"):
        handle = handle[1:]
    if handle.startswith("@"):
        handle = handle[1:]
    if not handle or handle.startswith(("/", "@")):
        return ""
    return handle.casefold()


def channel_url_matches(value: Any, channel_id: str, handle: str) -> bool:
    """Match a public YouTube channel URL by host and exact decoded path only."""

    expected_handle = normalized_handle(handle)
    expected_channel_id = text(channel_id)
    if not expected_handle or not expected_channel_id:
        return False
    try:
        parsed = urlsplit(text(value))
        host = (parsed.hostname or "").casefold()
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if host != "youtube.com" and not host.endswith(".youtube.com"):
        return False
    path = unquote(parsed.path)
    if path.endswith("/"):
        path = path[:-1]
    if path.startswith("/@"):
        return normalized_handle(path[1:]) == expected_handle
    if path.startswith("/channel/"):
        return path[len("/channel/"):] == expected_channel_id
    return False


def identity_thumbnails(identity: Mapping[str, Any]) -> tuple[str, ...]:
    """Return unique public thumbnail aliases in their stable preference order."""

    values: list[str] = []
    for field in ("thumbnailUrl", "videoThumbnailUrl"):
        thumbnail = text(identity.get(field))
        if thumbnail and thumbnail not in values:
            values.append(thumbnail)
    return tuple(values)


def thumbnail_matches_video(thumbnail: str, video_id: str) -> bool:
    """Accept only public YouTube image-CDN paths bound to this exact video."""

    try:
        parsed = urlsplit(thumbnail)
        host = (parsed.hostname or "").casefold()
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if host != "img.youtube.com" and not host.endswith(".ytimg.com"):
        return False
    path = unquote(parsed.path)
    if not path.startswith("/") or path.startswith("//"):
        return False
    segments = path.split("/")
    return (
        len(segments) >= 3
        and segments[1] in {"vi", "vi_webp", "an_webp"}
        and segments[2] == video_id
    )


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


def fetch_json(
    base_url: str,
    path: str,
    timeout: float,
    request_context: str = "phase=unspecified",
) -> tuple[int, int, dict[str, Any]]:
    started = time.monotonic()
    url = f"{base_url.rstrip('/')}{path}"
    print(
        f"AUDIT_REQUEST_START {request_context} url={url} timeoutSeconds={timeout:g}",
        flush=True,
    )
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "daily-song-list-identity-audit/1"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read()
            status = int(response.status)
        if status != 200:
            raise RuntimeError(f"HTTP {status}: {path}")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise RuntimeError(f"non-object JSON: {path}")
    except TimeoutError:
        print(
            f"AUDIT_REQUEST_TIMEOUT {request_context} url={url} timeoutSeconds={timeout:g} "
            f"elapsedSeconds={time.monotonic() - started:.3f} error=TimeoutError",
            flush=True,
        )
        raise
    except Exception as error:
        print(
            f"AUDIT_REQUEST_ERROR {request_context} url={url} "
            f"elapsedSeconds={time.monotonic() - started:.3f} "
            f"errorType={type(error).__name__} error={error}",
            flush=True,
        )
        raise
    print(
        f"AUDIT_REQUEST_OK {request_context} url={url} status={status} bodyBytes={len(body)} "
        f"elapsedSeconds={time.monotonic() - started:.3f}",
        flush=True,
    )
    return status, len(body), payload


def parse_source_probe(value: str) -> tuple[str, str, int, int]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("source probe must be key,channelId,occurrences,videos")
    return parts[0], parts[1], int(parts[2]), int(parts[3])


def parse_concurrency(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("concurrency must be an integer from 1 to 4") from error
    if not 1 <= parsed <= 4:
        raise argparse.ArgumentTypeError("concurrency must be from 1 to 4")
    return parsed


def parse_bounded_int(value: str, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{name} must be an integer from {minimum} to {maximum}") from error
    if not minimum <= parsed <= maximum:
        raise argparse.ArgumentTypeError(f"{name} must be from {minimum} to {maximum}")
    return parsed


def parse_page_size(value: str) -> int:
    return parse_bounded_int(value, "page-size", 1, 20)


def parse_max_pages(value: str) -> int:
    return parse_bounded_int(value, "max-pages", 1, 200)


def parse_timeout(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("timeout must be greater than 0 and at most 60") from error
    if not 0 < parsed <= 60:
        raise argparse.ArgumentTypeError("timeout must be greater than 0 and at most 60")
    return parsed


def ranking_path(range_id: str, metric: str, page: int, page_size: int) -> str:
    return "/api/rankings?" + urlencode({
        "range": range_id,
        "view": "vtubers",
        "metric": metric,
        "page": page,
        "pageSize": page_size,
    })


def fetch_ranking_page(
    base_url: str,
    range_id: str,
    metric: str,
    page: int,
    page_size: int,
    timeout: float,
) -> tuple[int, int, dict[str, Any]]:
    return (
        page,
        *fetch_json(
            base_url,
            ranking_path(range_id, metric, page, page_size),
            timeout,
            f"range={range_id} metric={metric} page={page}",
        )[1:],
    )


def source_path(key: str, page: int, page_size: int = SOURCE_PAGE_SIZE) -> str:
    return f"/api/sources/{key}?" + urlencode({"page": page, "pageSize": page_size})


def fetch_source_page(
    base_url: str,
    key: str,
    page: int,
    timeout: float,
) -> tuple[int, int, dict[str, Any]]:
    return (
        page,
        *fetch_json(
            base_url,
            source_path(key, page),
            timeout,
            f"phase=source-probe key={key} page={page}",
        )[1:],
    )


def required_int(payload: Mapping[str, Any], field: str, context: str) -> int:
    value = payload.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"invalid {field}: {context} actual={value!r}")
    if value < 0:
        raise RuntimeError(f"negative {field}: {context} actual={value}")
    return value


def source_page_metadata(
    payload: Mapping[str, Any],
    key: str,
    requested_page: int,
    expected_page_count: int | None = None,
    expected_videos: int | None = None,
    expected_occurrences: int | None = None,
) -> tuple[int, int, int]:
    """Validate the video-paged source response's immutable page metadata."""

    context = f"source={key} page={requested_page}"
    if not payload.get("found"):
        raise RuntimeError(f"source not found: {context}")
    if text(payload.get("sourceKey")) != key:
        raise RuntimeError(f"source key mismatch: {context} actual={payload.get('sourceKey')!r}")
    actual_page = required_int(payload, "page", context)
    actual_page_size = required_int(payload, "pageSize", context)
    page_count = required_int(payload, "pageCount", context)
    total_count = required_int(payload, "totalCount", context)
    total_videos = required_int(payload, "totalVideoCount", context)
    total_occurrences = required_int(payload, "totalOccurrenceCount", context)
    if actual_page != requested_page:
        raise RuntimeError(f"source page mismatch: {context} actual={actual_page}")
    if actual_page_size != SOURCE_PAGE_SIZE:
        raise RuntimeError(
            f"source pageSize mismatch: {context} expected={SOURCE_PAGE_SIZE} actual={actual_page_size}"
        )
    expected_from_total = max(1, math.ceil(total_count / SOURCE_PAGE_SIZE))
    if page_count != expected_from_total:
        raise RuntimeError(
            f"source pageCount inconsistent: {context} total={total_count} "
            f"pageSize={SOURCE_PAGE_SIZE} expected={expected_from_total} actual={page_count}"
        )
    if total_count != total_videos:
        raise RuntimeError(
            f"source total/video mismatch: {context} totalCount={total_count} totalVideoCount={total_videos}"
        )
    if expected_page_count is not None and page_count != expected_page_count:
        raise RuntimeError(
            f"source pageCount changed during audit: {context} "
            f"expected={expected_page_count} actual={page_count}"
        )
    if expected_videos is not None and total_videos != expected_videos:
        raise RuntimeError(
            f"source video total changed during audit: {context} "
            f"expected={expected_videos} actual={total_videos}"
        )
    if expected_occurrences is not None and total_occurrences != expected_occurrences:
        raise RuntimeError(
            f"source occurrence total changed during audit: {context} "
            f"expected={expected_occurrences} actual={total_occurrences}"
        )
    return page_count, total_videos, total_occurrences


def page_metadata(
    payload: Mapping[str, Any],
    range_id: str,
    metric: str,
    requested_page: int,
    page_size: int,
    expected_page_count: int | None = None,
    expected_total: int | None = None,
) -> tuple[int, int]:
    actual_page = int(payload.get("page") or 0)
    page_count = int(payload.get("pageCount") or 0)
    total = int(payload.get("totalCount") or 0)
    if actual_page != requested_page:
        raise RuntimeError(
            f"ranking page mismatch: range={range_id} metric={metric} "
            f"expected={requested_page} actual={actual_page}"
        )
    if page_count < 1:
        raise RuntimeError(f"invalid pageCount: range={range_id} metric={metric} actual={page_count}")
    if expected_total is not None and total != expected_total:
        raise RuntimeError(
            f"ranking total changed during audit: range={range_id} metric={metric} "
            f"expected={expected_total} actual={total} page={requested_page}"
        )
    expected_from_total = max(1, math.ceil(total / page_size))
    if page_count != expected_from_total:
        raise RuntimeError(
            f"ranking pageCount inconsistent: range={range_id} metric={metric} "
            f"total={total} pageSize={page_size} expected={expected_from_total} actual={page_count}"
        )
    if expected_page_count is not None and page_count != expected_page_count:
        raise RuntimeError(
            f"ranking pageCount changed during audit: range={range_id} metric={metric} "
            f"expected={expected_page_count} actual={page_count} page={requested_page}"
        )
    return page_count, total


def vtuber_entity_key(record: Mapping[str, Any]) -> str:
    """Return the stable card identity; source-detail aliases are not entities."""

    key = text(record.get("key"))
    if not key:
        raise RuntimeError("ranking record missing stable key")
    channel_id = text(record.get("channelId"))
    if key.startswith("UC") and channel_id and channel_id != key:
        raise RuntimeError(
            f"ranking key/channelId mismatch: key={key} channelId={channel_id}"
        )
    return key


def audit_record(record: Mapping[str, Any]) -> set[str]:
    problems: set[str] = set()
    top_id = text(record.get("channelId"))
    if not top_id and text(record.get("key")).startswith("UC"):
        top_id = text(record.get("key"))
    top_handle = normalized_handle(record.get("channelHandle"))
    if not top_id:
        problems.add("missing_card_channel_id")
    if not top_handle:
        problems.add("missing_card_channel_handle")
    if not text(record.get("sourceDetailKey")):
        problems.add("missing_source_detail_key")
    channel_url = text(record.get("channelUrl"))
    if not channel_url:
        problems.add("missing_card_channel_url")
    elif not channel_url_matches(channel_url, top_id, top_handle):
        problems.add("card_channel_url_mismatch")

    occurrences = record.get("occurrences")
    if occurrences is None or occurrences == []:
        problems.add("missing_card_occurrences")
        return problems
    if not isinstance(occurrences, list):
        problems.add("invalid_card_occurrences")
        return problems
    for occurrence in occurrences:
        if not isinstance(occurrence, Mapping):
            problems.add("invalid_occurrence")
            continue
        raw_item = occurrence.get("item")
        raw_video = occurrence.get("video")
        if "item" in occurrence and not isinstance(raw_item, Mapping):
            problems.add("invalid_occurrence_item_schema")
        if "video" in occurrence and not isinstance(raw_video, Mapping):
            problems.add("invalid_occurrence_video_schema")
        item = raw_item if isinstance(raw_item, Mapping) else {}
        legacy_video = raw_video if isinstance(raw_video, Mapping) else {}
        if not item and not legacy_video:
            problems.add("missing_occurrence_video_identity")
            continue
        if item and legacy_video:
            for field in ("videoId", "channelId", "channelHandle", "thumbnailUrl"):
                if text(item.get(field)) != text(legacy_video.get(field)):
                    problems.add("item_video_identity_mismatch")
        video = occurrence_video(occurrence)
        video_id = text(video.get("videoId") or occurrence.get("videoId"))
        inner_id = text(video.get("channelId"))
        inner_handle = normalized_handle(video.get("channelHandle"))
        if not video_id:
            problems.add("missing_occurrence_video_id")
        if not inner_id:
            problems.add("missing_occurrence_channel_id")
        if not inner_handle:
            problems.add("missing_occurrence_channel_handle")
        if top_id and inner_id and top_id != inner_id:
            problems.add("card_occurrence_channel_id_mismatch")
        if top_handle and inner_handle and top_handle != inner_handle:
            problems.add("card_occurrence_handle_mismatch")
        thumbnail_candidates = [
            occurrence.get("thumbnailUrl"),
            occurrence.get("videoThumbnailUrl"),
        ]
        for identity in (item, legacy_video):
            if identity:
                thumbnail_candidates.extend((
                    identity.get("thumbnailUrl"),
                    identity.get("videoThumbnailUrl"),
                ))
        thumbnails = [text(candidate) for candidate in thumbnail_candidates if text(candidate)]
        if not thumbnails:
            problems.add("missing_occurrence_thumbnail")
        for thumbnail in thumbnails:
            if video_id and not thumbnail_matches_video(thumbnail, video_id):
                problems.add("thumbnail_video_id_mismatch")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--range", dest="ranges", action="append", default=[])
    parser.add_argument("--metric", dest="metrics", action="append", default=[])
    parser.add_argument("--page-size", type=parse_page_size, default=20)
    parser.add_argument("--timeout", type=parse_timeout, default=20.0)
    parser.add_argument("--max-pages", type=parse_max_pages, default=100)
    parser.add_argument("--concurrency", type=parse_concurrency, default=4)
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
    ranking_coverage: dict[str, dict[str, int]] = {}
    source_probe_coverage: dict[str, dict[str, int]] = {}
    peak_in_flight = 0
    expected_handles: dict[str, str] = {}

    channel_probes: list[tuple[str, str]] = []
    for probe in args.channel_probe:
        handle, separator, expected_id = probe.partition("=")
        expected_handle = normalized_handle(handle)
        if not separator or not expected_handle or not expected_id:
            raise RuntimeError(f"invalid channel probe: {probe}")
        previous_handle = expected_handles.setdefault(expected_id, expected_handle)
        if previous_handle != expected_handle:
            raise RuntimeError(
                f"ambiguous expected handle for channel: channelId={expected_id} "
                f"first={previous_handle} next={expected_handle}"
            )
        channel_probes.append((handle, expected_id))

    _, body_bytes, health = fetch_json(args.base_url, "/healthz", args.timeout, "phase=health")
    total_bytes += body_bytes
    if text(health.get("status")) != "ok":
        raise RuntimeError(f"unhealthy target: {health.get('status')!r}")
    _, body_bytes, meta = fetch_json(args.base_url, "/api/meta", args.timeout, "phase=meta")
    total_bytes += body_bytes
    active = active_revision(meta)
    if args.expected_active and active != args.expected_active:
        raise RuntimeError(f"active CAS mismatch: expected={args.expected_active} actual={active}")

    if not args.skip_rankings:
        ranking_series: list[dict[str, Any]] = []

        def sample_sort_key(sample: Mapping[str, Any]) -> tuple[str, str, int, str]:
            try:
                rank = int(sample.get("rank") or 0)
            except (TypeError, ValueError):
                rank = 0
            return (text(sample.get("range")), text(sample.get("metric")), rank, text(sample.get("key")))

        def process_ranking_page(
            series: dict[str, Any],
            requested_page: int,
            body_bytes: int,
            payload: Mapping[str, Any],
        ) -> None:
            nonlocal total_bytes, pages_scanned, records_scanned
            range_id = str(series["range"])
            metric = str(series["metric"])
            page_count, total = page_metadata(
                payload,
                range_id,
                metric,
                requested_page,
                args.page_size,
                series.get("pageCount"),
                series.get("totalCount"),
            )
            if page_count > args.max_pages:
                raise RuntimeError(f"pageCount {page_count} exceeds cap {args.max_pages}")
            if requested_page in series["pagesSeen"]:
                raise RuntimeError(
                    f"duplicate ranking page during audit: range={range_id} metric={metric} page={requested_page}"
                )
            records = payload.get("records")
            if not isinstance(records, list):
                raise RuntimeError(f"records is not a list: range={range_id} metric={metric} page={requested_page}")
            expected_records = min(
                args.page_size,
                max(total - (requested_page - 1) * args.page_size, 0),
            )
            if len(records) != expected_records:
                raise RuntimeError(
                    f"ranking page size mismatch: range={range_id} metric={metric} "
                    f"page={requested_page} expected={expected_records} actual={len(records)}"
                )
            series["pagesSeen"].add(requested_page)
            total_bytes += body_bytes
            for record in records:
                if not isinstance(record, Mapping):
                    raise RuntimeError("ranking record is not an object")
                records_scanned += 1
                entity_key = vtuber_entity_key(record)
                if entity_key in series["recordKeys"]:
                    raise RuntimeError(
                        f"duplicate ranking record during audit: range={range_id} "
                        f"metric={metric} page={requested_page} key={entity_key}"
                    )
                rank = record.get("rank")
                if isinstance(rank, bool) or not isinstance(rank, int):
                    raise RuntimeError(
                        f"invalid ranking rank: range={range_id} metric={metric} "
                        f"page={requested_page} key={entity_key} rank={rank!r}"
                    )
                if not 1 <= rank <= total:
                    raise RuntimeError(
                        f"ranking rank out of bounds: range={range_id} metric={metric} "
                        f"page={requested_page} key={entity_key} rank={rank} total={total}"
                    )
                if rank in series["ranks"]:
                    raise RuntimeError(
                        f"duplicate ranking rank: range={range_id} metric={metric} "
                        f"page={requested_page} rank={rank}"
                    )
                series["recordKeys"].add(entity_key)
                series["ranks"].add(rank)
                series["recordsScanned"] += 1
                unique_records.add(f"{range_id}|{entity_key}")
                record_channel_id = text(record.get("channelId"))
                if range_id == "all" and record_channel_id:
                    ranking_channel_tuples.setdefault(record_channel_id, set()).add((
                        int(record.get("count") or record.get("timestampCount") or 0),
                        int(record.get("videoCount") or 0),
                    ))
                problems = audit_record(record)
                if problems:
                    affected_records.add(f"{range_id}|{metric}|{entity_key}")
                    problem_counts.update(problems)
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
                    samples.sort(key=sample_sort_key)
                    del samples[50:]
            pages_scanned += 1
            print(
                f"AUDIT_PAGE range={range_id} metric={metric} page={requested_page}/{page_count} "
                f"records={len(records)} affected={len(affected_records)}",
                flush=True,
            )

        # Each metric's first page is intentionally synchronous: it validates
        # the cap and warms the candidate adapter before concurrent paging.
        for range_id in ranges:
            for metric in metrics:
                page, body_bytes, payload = fetch_ranking_page(
                    args.base_url, range_id, metric, 1, args.page_size, args.timeout,
                )
                page_count, expected_total = page_metadata(payload, range_id, metric, page, args.page_size)
                if page_count > args.max_pages:
                    raise RuntimeError(f"pageCount {page_count} exceeds cap {args.max_pages}")
                series = {
                    "range": range_id,
                    "metric": metric,
                    "pageCount": page_count,
                    "totalCount": expected_total,
                    "pagesSeen": set(),
                    "recordKeys": set(),
                    "ranks": set(),
                    "recordsScanned": 0,
                }
                process_ranking_page(series, page, body_bytes, payload)
                del payload
                ranking_series.append(series)

        page_specs = [
            (series, page)
            for series in ranking_series
            for page in range(2, int(series["pageCount"]) + 1)
        ]
        next_spec = 0
        futures: dict[Future[tuple[int, int, dict[str, Any]]], tuple[dict[str, Any], int]] = {}
        executor = ThreadPoolExecutor(max_workers=args.concurrency, thread_name_prefix="identity-audit")
        try:
            while next_spec < len(page_specs) or futures:
                while next_spec < len(page_specs) and len(futures) < args.concurrency:
                    series, page = page_specs[next_spec]
                    next_spec += 1
                    future = executor.submit(
                        fetch_ranking_page,
                        args.base_url,
                        str(series["range"]),
                        str(series["metric"]),
                        page,
                        args.page_size,
                        args.timeout,
                    )
                    futures[future] = (series, page)
                    peak_in_flight = max(peak_in_flight, len(futures))
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in completed:
                    series, expected_page = futures.pop(future)
                    try:
                        page, body_bytes, payload = future.result()
                        if page != expected_page:
                            raise RuntimeError(
                                f"ranking future page mismatch: range={series['range']} "
                                f"metric={series['metric']} expected={expected_page} actual={page}"
                            )
                        process_ranking_page(series, page, body_bytes, payload)
                        del payload
                    except Exception as error:
                        print(
                            f"AUDIT_PAGE_ERROR range={series['range']} metric={series['metric']} "
                            f"page={expected_page} errorType={type(error).__name__} error={error}",
                            flush=True,
                        )
                        for pending in futures:
                            pending.cancel()
                        raise
        finally:
            executor.shutdown(wait=True, cancel_futures=True)

        for series in ranking_series:
            range_id = str(series["range"])
            metric = str(series["metric"])
            page_count = int(series["pageCount"])
            expected_total = int(series["totalCount"])
            expected_pages = set(range(1, page_count + 1))
            if series["pagesSeen"] != expected_pages:
                raise RuntimeError(
                    f"incomplete ranking page coverage: range={range_id} metric={metric} "
                    f"expected={sorted(expected_pages)} actual={sorted(series['pagesSeen'])}"
                )
            if series["recordsScanned"] != expected_total or len(series["recordKeys"]) != expected_total:
                raise RuntimeError(
                    f"incomplete ranking coverage: range={range_id} metric={metric} "
                    f"expected={expected_total} scanned={series['recordsScanned']} "
                    f"unique={len(series['recordKeys'])}"
                )
            expected_ranks = set(range(1, expected_total + 1))
            if series["ranks"] != expected_ranks:
                raise RuntimeError(
                    f"incomplete ranking rank coverage: range={range_id} metric={metric} "
                    f"expected={sorted(expected_ranks)} actual={sorted(series['ranks'])}"
                )
            ranking_coverage[f"{range_id}|{metric}"] = {
                "expected": expected_total,
                "scanned": int(series["recordsScanned"]),
                "unique": len(series["recordKeys"]),
                "ranks": len(series["ranks"]),
            }
        samples.sort(key=sample_sort_key)

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
        _, body_bytes, negative = fetch_json(args.base_url, f"/api/rankings?{query}", args.timeout, "phase=negative-query")
        total_bytes += body_bytes
        if int(negative.get("totalCount") or 0) != 0:
            gate_errors.append(f"negative query returned records: {args.negative_query!r}")

    for handle, expected_id in channel_probes:
        probe = f"{handle}={expected_id}"
        query = urlencode({
            "range": "all",
            "view": "vtubers",
            "metric": "videos",
            "page": 1,
            "pageSize": 20,
            "q": handle,
            "searchFields": "channel",
        })
        _, body_bytes, payload = fetch_json(args.base_url, f"/api/rankings?{query}", args.timeout, f"phase=channel-probe handle={handle}")
        total_bytes += body_bytes
        records = payload.get("records")
        total = payload.get("totalCount")
        if isinstance(total, bool) or not isinstance(total, int) or total != 1:
            raise RuntimeError(f"channel probe total must uniquely match: {probe} actual={total!r}")
        if not isinstance(records, list) or len(records) != 1:
            raise RuntimeError(
                f"channel probe records must uniquely match: {probe} "
                f"actual={len(records) if isinstance(records, list) else type(records).__name__}"
            )
        record = records[0]
        if not isinstance(record, Mapping) or text(record.get("channelId")) != expected_id:
            raise RuntimeError(f"channel probe identity failed: {probe}")
        if normalized_handle(record.get("channelHandle")) != expected_handles[expected_id]:
            raise RuntimeError(f"channel probe handle failed: {probe}")
        problems = audit_record(record)
        if problems:
            gate_errors.append(f"channel probe failed: {probe} problems={','.join(sorted(problems))}")

    for key, expected_id, expected_occurrences, expected_videos in args.source_probe:
        expected_handle = expected_handles.get(expected_id)
        if not expected_handle:
            raise RuntimeError(
                f"source probe missing expected channel handle: source={key} channelId={expected_id}"
            )
        if not args.skip_rankings:
            actual_ranking_tuples = sorted(ranking_channel_tuples.get(expected_id, set()))
            expected_ranking_tuple = [(expected_occurrences, expected_videos)]
            if actual_ranking_tuples != expected_ranking_tuple:
                gate_errors.append(
                    f"ranking/source count mismatch: {key} "
                    f"expected={expected_ranking_tuple} actual={actual_ranking_tuples}"
                )

        state: dict[str, Any] = {
            "key": key,
            "expectedId": expected_id,
            "expectedHandle": expected_handle,
            "pageCount": None,
            "totalVideos": None,
            "totalOccurrences": None,
            "pagesSeen": set(),
            "videoPages": {},
            "occurrenceKeys": set(),
            "occurrenceRows": 0,
        }

        def process_source_page(
            requested_page: int,
            body_bytes: int,
            payload: Mapping[str, Any],
        ) -> None:
            nonlocal total_bytes, pages_scanned
            page_count, total_videos, total_occurrences = source_page_metadata(
                payload,
                key,
                requested_page,
                state["pageCount"],
                state["totalVideos"],
                state["totalOccurrences"],
            )
            if page_count > args.max_pages:
                raise RuntimeError(f"source pageCount {page_count} exceeds cap {args.max_pages}: source={key}")
            record = payload.get("record")
            if not isinstance(record, Mapping):
                raise RuntimeError(f"source record is not an object: source={key} page={requested_page}")
            if text(record.get("sourceDetailKey")) != key:
                raise RuntimeError(f"source record key mismatch: source={key} page={requested_page}")
            if text(record.get("channelId")) != expected_id:
                raise RuntimeError(f"source record channel mismatch: source={key} page={requested_page}")
            record_handle = normalized_handle(record.get("channelHandle"))
            if not record_handle or record_handle != expected_handle:
                raise RuntimeError(f"source record handle mismatch: source={key} page={requested_page}")
            if not channel_url_matches(record.get("channelUrl"), expected_id, expected_handle):
                raise RuntimeError(f"source record channelUrl mismatch: source={key} page={requested_page}")
            if requested_page in state["pagesSeen"]:
                raise RuntimeError(f"duplicate source page during audit: source={key} page={requested_page}")
            occurrences = record.get("occurrences")
            if not isinstance(occurrences, list):
                raise RuntimeError(f"source occurrences is not a list: source={key} page={requested_page}")
            page_videos: set[str] = set()
            for occurrence in occurrences:
                if not isinstance(occurrence, Mapping):
                    raise RuntimeError(f"invalid source occurrence: source={key} page={requested_page}")
                if "item" not in occurrence:
                    raise RuntimeError(f"source occurrence missing item: source={key} page={requested_page}")
                item = occurrence.get("item")
                if not isinstance(item, Mapping):
                    raise RuntimeError(f"source occurrence invalid item schema: source={key} page={requested_page}")
                video_id = text(item.get("videoId"))
                if not video_id:
                    raise RuntimeError(f"source occurrence missing item.videoId: source={key} page={requested_page}")
                if text(item.get("channelId")) != expected_id:
                    raise RuntimeError(f"source occurrence item channel mismatch: source={key} page={requested_page}")
                if normalized_handle(item.get("channelHandle")) != expected_handle:
                    raise RuntimeError(f"source occurrence item handle mismatch: source={key} page={requested_page}")
                item_thumbnails = identity_thumbnails(item)
                if not item_thumbnails:
                    raise RuntimeError(f"source occurrence missing item thumbnail: source={key} page={requested_page}")
                for thumbnail in item_thumbnails:
                    if not thumbnail_matches_video(thumbnail, video_id):
                        raise RuntimeError(
                            f"source occurrence item thumbnail videoId mismatch: "
                            f"source={key} page={requested_page}"
                        )
                if "video" in occurrence and not isinstance(occurrence.get("video"), Mapping):
                    raise RuntimeError(f"source occurrence invalid video schema: source={key} page={requested_page}")
                legacy_video = occurrence.get("video")
                if isinstance(legacy_video, Mapping):
                    if text(legacy_video.get("videoId")) != video_id:
                        raise RuntimeError(f"source occurrence item/video videoId mismatch: source={key} page={requested_page}")
                    if text(legacy_video.get("channelId")) != expected_id:
                        raise RuntimeError(f"source occurrence video channel mismatch: source={key} page={requested_page}")
                    if normalized_handle(legacy_video.get("channelHandle")) != expected_handle:
                        raise RuntimeError(f"source occurrence video handle mismatch: source={key} page={requested_page}")
                    video_thumbnails = identity_thumbnails(legacy_video)
                    if not video_thumbnails:
                        raise RuntimeError(f"source occurrence missing video thumbnail: source={key} page={requested_page}")
                    for thumbnail in video_thumbnails:
                        if not thumbnail_matches_video(thumbnail, video_id):
                            raise RuntimeError(
                                f"source occurrence video thumbnail videoId mismatch: "
                                f"source={key} page={requested_page}"
                            )
                    if item_thumbnails[0] not in video_thumbnails:
                        raise RuntimeError(f"source occurrence item/video thumbnail mismatch: source={key} page={requested_page}")
                top_video_id = text(occurrence.get("videoId"))
                if top_video_id and top_video_id != video_id:
                    raise RuntimeError(f"source occurrence videoId mismatch: source={key} page={requested_page}")
                song = occurrence.get("song")
                if not isinstance(song, Mapping):
                    raise RuntimeError(f"source occurrence missing song: source={key} page={requested_page}")
                occurrence_id = text(song.get("occurrenceId"))
                if not occurrence_id:
                    raise RuntimeError(f"source occurrence missing stable key: source={key} page={requested_page}")
                occurrence_key = f"{video_id}|{occurrence_id}"
                if occurrence_key in state["occurrenceKeys"]:
                    raise RuntimeError(
                        f"duplicate source occurrence during audit: source={key} "
                        f"page={requested_page} key={occurrence_key}"
                    )
                prior_video_page = state["videoPages"].get(video_id)
                if prior_video_page is not None and prior_video_page != requested_page:
                    raise RuntimeError(
                        f"duplicate source video during audit: source={key} video={video_id} "
                        f"pages={prior_video_page},{requested_page}"
                    )
                state["videoPages"][video_id] = requested_page
                state["occurrenceKeys"].add(occurrence_key)
                state["occurrenceRows"] += 1
                page_videos.add(video_id)
            expected_page_videos = min(
                SOURCE_PAGE_SIZE,
                max(total_videos - (requested_page - 1) * SOURCE_PAGE_SIZE, 0),
            )
            if len(page_videos) != expected_page_videos:
                raise RuntimeError(
                    f"source video page coverage mismatch: source={key} page={requested_page} "
                    f"expected={expected_page_videos} actual={len(page_videos)}"
                )
            state["pageCount"] = page_count
            state["totalVideos"] = total_videos
            state["totalOccurrences"] = total_occurrences
            state["pagesSeen"].add(requested_page)
            total_bytes += body_bytes
            pages_scanned += 1
            print(
                f"AUDIT_SOURCE_PAGE source={key} page={requested_page}/{page_count} "
                f"videos={len(page_videos)} occurrences={len(occurrences)}",
                flush=True,
            )

        page, body_bytes, payload = fetch_source_page(args.base_url, key, 1, args.timeout)
        process_source_page(page, body_bytes, payload)
        del payload
        futures: dict[Future[tuple[int, int, dict[str, Any]]], int] = {}
        next_page = 2
        executor = ThreadPoolExecutor(max_workers=args.concurrency, thread_name_prefix="source-identity-audit")
        try:
            while next_page <= int(state["pageCount"]) or futures:
                while next_page <= int(state["pageCount"]) and len(futures) < args.concurrency:
                    future = executor.submit(fetch_source_page, args.base_url, key, next_page, args.timeout)
                    futures[future] = next_page
                    peak_in_flight = max(peak_in_flight, len(futures))
                    next_page += 1
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in completed:
                    expected_page = futures.pop(future)
                    try:
                        page, body_bytes, payload = future.result()
                        if page != expected_page:
                            raise RuntimeError(
                                f"source future page mismatch: source={key} "
                                f"expected={expected_page} actual={page}"
                            )
                        process_source_page(page, body_bytes, payload)
                        del payload
                    except Exception as error:
                        print(
                            f"AUDIT_SOURCE_PAGE_ERROR source={key} page={expected_page} "
                            f"errorType={type(error).__name__} error={error}",
                            flush=True,
                        )
                        for pending in futures:
                            pending.cancel()
                        raise
        finally:
            executor.shutdown(wait=True, cancel_futures=True)
        expected_pages = set(range(1, int(state["pageCount"]) + 1))
        if state["pagesSeen"] != expected_pages:
            raise RuntimeError(
                f"incomplete source page coverage: source={key} "
                f"expected={sorted(expected_pages)} actual={sorted(state['pagesSeen'])}"
            )
        if len(state["videoPages"]) != expected_videos:
            raise RuntimeError(
                f"incomplete source video coverage: source={key} "
                f"expected={expected_videos} actual={len(state['videoPages'])}"
            )
        if state["occurrenceRows"] != expected_occurrences or len(state["occurrenceKeys"]) != expected_occurrences:
            raise RuntimeError(
                f"incomplete source occurrence coverage: source={key} expected={expected_occurrences} "
                f"rows={state['occurrenceRows']} unique={len(state['occurrenceKeys'])}"
            )
        source_probe_coverage[key] = {
            "pages": int(state["pageCount"]),
            "videos": len(state["videoPages"]),
            "occurrences": int(state["occurrenceRows"]),
        }

    digest = hashlib.sha256("\n".join(sorted(affected_records)).encode()).hexdigest()
    summary = {
        "activeRevision": active,
        "ranges": ranges,
        "metrics": metrics,
        "concurrency": args.concurrency,
        "maxInFlight": peak_in_flight,
        "pagesScanned": pages_scanned,
        "recordsScanned": records_scanned,
        "uniqueRankingRecords": len(unique_records),
        "affectedRecords": len(affected_records),
        "problemCounts": dict(sorted(problem_counts.items())),
        "sourceProbeRankingTuples": {
            expected_id: sorted(ranking_channel_tuples.get(expected_id, set()))
            for _, expected_id, _, _ in args.source_probe
        },
        "rankingCoverage": ranking_coverage,
        "sourceProbeCoverage": dict(sorted(source_probe_coverage.items())),
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
