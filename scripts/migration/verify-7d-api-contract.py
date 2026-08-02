#!/usr/bin/env python3
"""Fail-closed, exhaustive API verifier for an authoritative PG 7D release."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import sys
import time
from typing import Any, Mapping
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


VIDEO_FIELDS = (
    "videoId", "title", "channelId", "channelName", "channelHandle",
    "channelUrl", "thumbnailUrl", "publishedAt", "publishedTimestamp",
    "videoThumbnailUrl", "avatarUrl", "sourceUrl", "sourceSystem", "rangeId",
)
SONG_FIELDS = (
    "videoId", "occurrenceId", "position", "rangeId", "songKey", "seconds",
    "title", "artist", "sourceId", "sourceHash", "rawHash", "sourceSystem",
    "isNiche", "isUnknownArtist",
)


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise AssertionError(f"{label} is boolean")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise AssertionError(f"{label} is not an integer") from exc
    if result < 0:
        raise AssertionError(f"{label} is negative")
    return result


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalized(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def derived_song_key(title: Any, artist: Any) -> str:
    return hashlib.sha256(
        f"song\0{normalized(title)}\0{normalized(artist)}".encode("utf-8")
    ).hexdigest()[:24]


class Client:
    def __init__(
        self,
        base_url: str,
        timeout: int,
        cache_token: str,
        require_fresh_cache: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.cache_token = cache_token
        self.require_fresh_cache = require_fresh_cache
        self.counter = 0
        self.cache_ages: list[int] = []

    def fetch(self, path: str) -> tuple[dict[str, Any], bytes]:
        self.counter += 1
        separator = "&" if "?" in path else "?"
        cache_value = quote(f"{self.cache_token}-{self.counter}", safe="")
        request_path = f"{path}{separator}releaseProbe={cache_value}"
        request = Request(
            self.base_url + request_path,
            headers={
                "Accept": "application/json",
                "User-Agent": "pg-7d-contract-v2",
                "Cache-Control": "no-cache, no-store, max-age=0",
                "Pragma": "no-cache",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise AssertionError(f"HTTP {response.status}: {path}")
                raw = response.read()
                headers = {key.casefold(): value for key, value in response.headers.items()}
        except (HTTPError, URLError, TimeoutError) as exc:
            raise AssertionError(f"request failed: {path}: {exc}") from exc
        if self.require_fresh_cache:
            age = integer(headers.get("age", "0"), f"cache Age for {path}")
            if age > 5:
                raise AssertionError(f"stale public cache Age={age}: {path}")
            date_value = text(headers.get("date"))
            if not date_value:
                raise AssertionError(f"public response Date header missing: {path}")
            try:
                response_time = parsedate_to_datetime(date_value).astimezone(timezone.utc)
            except (TypeError, ValueError) as exc:
                raise AssertionError(f"public response Date is invalid: {path}") from exc
            skew = abs((datetime.now(timezone.utc) - response_time).total_seconds())
            if skew > 300:
                raise AssertionError(f"public response Date is stale by {int(skew)}s: {path}")
            self.cache_ages.append(age)
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AssertionError(f"non-JSON response: {path}") from exc
        if not isinstance(value, dict):
            raise AssertionError(f"JSON root is not object: {path}")
        return value, raw


def rankings_path(range_id: str, page: int, page_size: int) -> str:
    return "/api/rankings?" + urlencode(
        {
            "range": range_id,
            "view": "songs",
            "metric": "occurrences",
            "page": page,
            "pageSize": page_size,
        }
    )


def collect_rankings(
    client: Client, range_id: str, max_pages: int, page_size: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    page = 1
    page_count: int | None = None
    payloads: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = []
    while page_count is None or page <= page_count:
        if page > max_pages:
            raise AssertionError(f"{range_id} rankings exceeded max-pages")
        path = rankings_path(range_id, page, page_size)
        payload, raw = client.fetch(path)
        if payload.get("rangeId") != range_id:
            raise AssertionError(f"{range_id} rankings returned wrong range")
        if integer(payload.get("page"), f"{range_id} page") != page:
            raise AssertionError(f"{range_id} rankings page mismatch")
        current_pages = integer(payload.get("pageCount"), f"{range_id} pageCount")
        if current_pages < 1 or current_pages > max_pages:
            raise AssertionError(f"{range_id} pageCount outside bound")
        if page_count is None:
            page_count = current_pages
        elif page_count != current_pages:
            raise AssertionError(f"{range_id} pageCount changed during scan")
        records = payload.get("records")
        if not isinstance(records, list) or not all(isinstance(row, dict) for row in records):
            raise AssertionError(f"{range_id} rankings records missing")
        payloads.append(payload)
        entries.append({"path": path, "bytes": len(raw), "sha256": sha256(raw)})
        page += 1
    return payloads, entries


def capture_baseline(args: argparse.Namespace, client: Client) -> dict[str, Any]:
    ranges: dict[str, Any] = {}
    for range_id in ("all", "7d"):
        payloads, entries = collect_rankings(
            client, range_id, args.max_pages, args.page_size
        )
        ranges[range_id] = {
            "entries": entries,
            "pageCount": len(entries),
            "totalCount": integer(payloads[0].get("totalCount"), "baseline totalCount"),
            "totalOccurrenceCount": integer(
                payloads[0].get("totalOccurrenceCount"),
                "baseline totalOccurrenceCount",
            ),
        }
    result = {
        "schemaVersion": 1,
        "kind": "pg-7d-exact-byte-baseline",
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "ranges": ranges,
    }
    result["baselineSha256"] = sha256(canonical_bytes(ranges))
    args.capture_baseline.parent.mkdir(parents=True, exist_ok=True)
    args.capture_baseline.write_text(
        json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


def verify_baseline(
    args: argparse.Namespace, client: Client, range_ids: tuple[str, ...]
) -> dict[str, str]:
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    ranges = baseline.get("ranges") if isinstance(baseline, dict) else None
    if not isinstance(ranges, dict):
        raise AssertionError("exact byte baseline ranges missing")
    if sha256(canonical_bytes(ranges)) != baseline.get("baselineSha256"):
        raise AssertionError("exact byte baseline self-hash mismatch")
    results: dict[str, str] = {}
    for range_id in range_ids:
        expected = ranges.get(range_id)
        if not isinstance(expected, dict) or not isinstance(expected.get("entries"), list):
            raise AssertionError(f"baseline range missing: {range_id}")
        _payloads, actual = collect_rankings(
            client, range_id, args.max_pages, args.page_size
        )
        if actual != expected["entries"]:
            raise AssertionError(f"{range_id} ranking bytes changed")
        results[range_id] = sha256(canonical_bytes(actual))
    return results


def published_at(video: Mapping[str, Any]) -> Any:
    direct = video.get("publishedAt")
    if isinstance(direct, str) and direct.strip():
        return direct
    value = video.get("publishedTimestamp")
    if isinstance(value, bool):
        raise AssertionError("publishedTimestamp cannot be boolean")
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 100_000_000_000:
            seconds /= 1000
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    return direct


def expected_semantics(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = path.read_bytes()
    try:
        root = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"expected 7d snapshot is malformed: {exc}") from exc
    if not isinstance(root, dict) or root.get("id") != "7d":
        raise AssertionError("expected 7d snapshot id mismatch")
    items = root.get("items")
    if not isinstance(items, list) or not items:
        raise AssertionError("expected 7d snapshot items missing")
    values: list[dict[str, Any]] = []
    seen_videos: set[str] = set()
    for raw_video in items:
        if not isinstance(raw_video, dict):
            raise AssertionError("expected 7d video is not an object")
        video_id = text(raw_video.get("videoId"))
        if not video_id or video_id in seen_videos:
            raise AssertionError(f"expected 7d duplicate/missing videoId: {video_id}")
        seen_videos.add(video_id)
        source_video = dict(raw_video)
        source_video["publishedAt"] = published_at(raw_video)
        source_video["rangeId"] = "7d"
        video = {
            key: source_video[key]
            for key in VIDEO_FIELDS
            if key in source_video
            and source_video[key] is not None
            and source_video[key] != ""
        }
        songs = raw_video.get("songs")
        if not isinstance(songs, list) or not songs:
            raise AssertionError(f"expected 7d video has no songs: {video_id}")
        per_video: set[str] = set()
        for position, raw_song in enumerate(songs):
            if not isinstance(raw_song, dict):
                raise AssertionError("expected 7d song is not an object")
            song = dict(raw_song)
            occurrence_id = text(
                song.get("occurrenceId") or song.get("occurrence_id")
            ) or f"position:{position}"
            if occurrence_id in per_video:
                raise AssertionError(f"expected duplicate tuple: {video_id}/{occurrence_id}")
            per_video.add(occurrence_id)
            song.update(
                {
                    "videoId": video_id,
                    "occurrenceId": occurrence_id,
                    "position": song.get("position", song.get("index", position)),
                    "rangeId": "7d",
                    "songKey": text(song.get("songKey"))
                    or derived_song_key(song.get("title"), song.get("artist")),
                    "sourceSystem": text(song.get("sourceSystem")) or "core-7d",
                }
            )
            public_song = {
                key: song[key]
                for key in SONG_FIELDS
                if key in song and song[key] is not None
            }
            values.append(
                {
                    "videoId": video_id,
                    "occurrenceId": occurrence_id,
                    "video": video,
                    "song": public_song,
                }
            )
    values.sort(key=lambda value: (value["videoId"], value["occurrenceId"]))
    return {"rawSha256": sha256(raw), "generatedAt": root.get("generatedAt")}, values


def api_semantic(occurrence: Mapping[str, Any]) -> dict[str, Any]:
    item = occurrence.get("item")
    if not isinstance(item, Mapping):
        item = occurrence.get("video")
    song = occurrence.get("song")
    if not isinstance(item, Mapping) or not isinstance(song, Mapping):
        raise AssertionError("source occurrence misses item/song")
    video_id = text(
        occurrence.get("videoId") or song.get("videoId") or item.get("videoId")
    )
    occurrence_id = text(song.get("occurrenceId") or occurrence.get("occurrenceId"))
    if not video_id or not occurrence_id:
        raise AssertionError("source occurrence misses immutable tuple identity")
    video = {
        key: item[key]
        for key in VIDEO_FIELDS
        if key in item and item[key] is not None and item[key] != ""
    }
    public_song = {
        key: song[key]
        for key in SONG_FIELDS
        if key in song and song[key] is not None
    }
    return {
        "videoId": video_id,
        "occurrenceId": occurrence_id,
        "video": video,
        "song": public_song,
    }


def verify_meta(args: argparse.Namespace, client: Client) -> dict[str, Any]:
    meta, _raw = client.fetch("/api/meta")
    meta_root = meta.get("meta") if isinstance(meta.get("meta"), dict) else meta
    if text(meta_root.get("active_revision_id") or meta_root.get("activeRevisionId")) != args.revision:
        raise AssertionError("active revision mismatch")
    if text(meta_root.get("migration_status") or meta_root.get("migrationStatus")) != args.status:
        raise AssertionError("migration status mismatch")
    if args.compatibility:
        return meta
    checks = {
        "acceptedVideoCount": args.videos,
        "acceptedOccurrenceCount": args.occurrences,
        "rangeResetTombstoneCount": args.tombstones,
    }
    for key, expected in checks.items():
        if integer(meta_root.get(key), f"meta {key}") != expected:
            raise AssertionError(f"meta {key} mismatch")
    if text(meta_root.get("source_commit_sha")) != args.source_commit:
        raise AssertionError("meta source_commit_sha mismatch")
    if text(meta_root.get("sourceBlobSha") or meta_root.get("source_blob_sha")) != args.source_blob:
        raise AssertionError("meta source blob SHA mismatch")
    if text(meta_root.get("source_manifest_sha256")) != args.source_manifest_sha256:
        raise AssertionError("meta source manifest SHA-256 mismatch")
    if text(meta_root.get("generatedAt")) != args.generated_at:
        raise AssertionError("meta generatedAt mismatch")
    return meta


def verify_full(args: argparse.Namespace, client: Client) -> dict[str, Any]:
    snapshot_meta, expected_rows = expected_semantics(args.expected_7d)
    if snapshot_meta["rawSha256"] != args.source_artifact_sha256:
        raise AssertionError("expected 7d snapshot SHA-256 mismatch")
    if text(snapshot_meta["generatedAt"]) != args.generated_at:
        raise AssertionError("expected 7d generatedAt mismatch")
    if len(expected_rows) != args.occurrences:
        raise AssertionError("expected 7d occurrence count mismatch")
    if len({row["videoId"] for row in expected_rows}) != args.videos:
        raise AssertionError("expected 7d video count mismatch")
    expected_semantics_sha = sha256(canonical_bytes(expected_rows))
    if expected_semantics_sha != args.source_semantics_sha256:
        raise AssertionError("expected 7d semantic SHA-256 mismatch")

    meta = verify_meta(args, client)
    baseline_hashes = verify_baseline(args, client, ("all",))
    payloads, _entries = collect_rankings(
        client, "7d", args.max_pages, args.page_size
    )
    first = payloads[0]
    if integer(first.get("totalOccurrenceCount"), "7d totalOccurrenceCount") != args.occurrences:
        raise AssertionError("7d ranking occurrence total mismatch")
    if integer(first.get("totalVideoCount"), "7d totalVideoCount") != args.videos:
        raise AssertionError("7d ranking video total mismatch")
    cards = [record for payload in payloads for record in payload["records"]]
    card_keys: set[str] = set()
    source_keys: set[str] = set()
    card_counts: dict[str, int] = {}
    for card in cards:
        card_key = text(card.get("key"))
        source_key = text(card.get("sourceDetailKey"))
        if not card_key or card_key in card_keys:
            raise AssertionError("7d ranking card key missing/duplicate")
        if not source_key or source_key in source_keys:
            raise AssertionError("7d source detail key missing/duplicate")
        card_keys.add(card_key)
        source_keys.add(source_key)
        card_counts[source_key] = integer(
            card.get("count") if card.get("count") is not None else card.get("occurrenceCount"),
            "7d card count",
        )
    if sum(card_counts.values()) != args.occurrences:
        raise AssertionError("7d ranking card counts do not sum to occurrence total")
    expected_group_keys = {text(row["song"].get("songKey")) for row in expected_rows}
    if card_keys != expected_group_keys:
        raise AssertionError("7d ranking song group identities mismatch")

    actual_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    source_page_count = 0
    for source_key in sorted(source_keys):
        page = 1
        page_count: int | None = None
        source_occurrences: list[dict[str, Any]] = []
        while page_count is None or page <= page_count:
            if page > args.max_pages:
                raise AssertionError(f"7d source pages exceeded bound: {source_key}")
            path = f"/api/sources/{quote(source_key, safe='')}?" + urlencode(
                {"range": "7d", "page": page, "pageSize": args.page_size}
            )
            payload, _raw = client.fetch(path)
            source_page_count += 1
            if payload.get("found") is not True or text(payload.get("sourceKey")) != source_key:
                raise AssertionError(f"7d source detail not found: {source_key}")
            if integer(payload.get("page"), "source page") != page:
                raise AssertionError(f"7d source page mismatch: {source_key}")
            current_pages = integer(payload.get("pageCount"), "source pageCount")
            if current_pages < 1 or current_pages > args.max_pages:
                raise AssertionError(f"7d source pageCount outside bound: {source_key}")
            if page_count is None:
                page_count = current_pages
            elif page_count != current_pages:
                raise AssertionError(f"7d source pageCount changed: {source_key}")
            if integer(payload.get("totalOccurrenceCount"), "source totalOccurrenceCount") != card_counts[source_key]:
                raise AssertionError(f"7d source/card count mismatch: {source_key}")
            record = payload.get("record")
            occurrences = record.get("occurrences") if isinstance(record, dict) else None
            if not isinstance(occurrences, list) or not all(isinstance(row, dict) for row in occurrences):
                raise AssertionError(f"7d source occurrences missing: {source_key}")
            source_occurrences.extend(occurrences)
            page += 1
        if len(source_occurrences) != card_counts[source_key]:
            raise AssertionError(f"7d source pagination count mismatch: {source_key}")
        for occurrence in source_occurrences:
            semantic = api_semantic(occurrence)
            identity = (semantic["videoId"], semantic["occurrenceId"])
            if identity in actual_by_identity:
                raise AssertionError(
                    f"7d source tuple repeated: {identity[0]}/{identity[1]}"
                )
            actual_by_identity[identity] = semantic
    actual_rows = sorted(
        actual_by_identity.values(),
        key=lambda value: (value["videoId"], value["occurrenceId"]),
    )
    if len(actual_rows) != args.occurrences:
        raise AssertionError("7d exhaustive source tuple count mismatch")
    if len({row["videoId"] for row in actual_rows}) != args.videos:
        raise AssertionError("7d exhaustive source video count mismatch")
    actual_semantics_sha = sha256(canonical_bytes(actual_rows))
    if actual_semantics_sha != expected_semantics_sha or actual_rows != expected_rows:
        raise AssertionError("7d exhaustive source tuple semantics mismatch")

    meta_counts = meta.get("counts")
    if not isinstance(meta_counts, dict):
        raise AssertionError("meta counts missing")
    all_occurrences = json.loads(args.baseline.read_text(encoding="utf-8"))[
        "ranges"
    ]["all"]["totalOccurrenceCount"]
    expected_physical = integer(all_occurrences, "baseline all occurrences") + args.occurrences
    if integer(meta_counts.get("occurrences"), "meta counts.occurrences") != expected_physical:
        raise AssertionError("meta physical occurrence count mismatch")
    if integer(meta_counts.get("source_occurrences"), "meta counts.source_occurrences") != 3 * expected_physical:
        raise AssertionError("meta physical source occurrence count mismatch")
    return {
        "phase": args.phase,
        "revision": args.revision,
        "status": args.status,
        "videos": args.videos,
        "occurrences": args.occurrences,
        "rankingGroups": len(card_keys),
        "sourcePages": source_page_count,
        "allByteEntriesSha256": baseline_hashes["all"],
        "sourceSemanticsSha256": actual_semantics_sha,
        "sourceManifestSha256": args.source_manifest_sha256,
        "generatedAt": args.generated_at,
        "maxCacheAge": max(client.cache_ages) if client.cache_ages else 0,
    }


def compatibility(args: argparse.Namespace, client: Client) -> dict[str, Any]:
    verify_meta(args, client)
    byte_hashes = verify_baseline(args, client, ("all", "7d"))
    return {
        "phase": args.phase,
        "revision": args.revision,
        "status": args.status,
        "allByteEntriesSha256": byte_hashes["all"],
        "sevenDByteEntriesSha256": byte_hashes["7d"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--capture-baseline", type=Path)
    parser.add_argument("--compatibility", action="store_true")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--revision")
    parser.add_argument("--status", choices=("ready", "active"))
    parser.add_argument("--source-commit")
    parser.add_argument("--source-blob")
    parser.add_argument("--source-artifact-sha256")
    parser.add_argument("--source-manifest-sha256")
    parser.add_argument("--source-semantics-sha256")
    parser.add_argument("--generated-at")
    parser.add_argument("--expected-7d", type=Path)
    parser.add_argument("--videos", type=int)
    parser.add_argument("--occurrences", type=int)
    parser.add_argument("--tombstones", type=int)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--max-pages", type=int, default=1000)
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--cache-token", default=f"probe-{time.time_ns()}")
    parser.add_argument("--require-fresh-cache", action="store_true")
    args = parser.parse_args()
    client = Client(
        args.base_url,
        args.timeout,
        args.cache_token,
        args.require_fresh_cache,
    )
    try:
        if args.capture_baseline:
            result = capture_baseline(args, client)
            marker = "PG_7D_BASELINE_CAPTURE_OK"
        elif args.compatibility:
            required = (args.baseline, args.revision, args.status)
            if not all(required):
                parser.error("compatibility verification requires baseline/revision/status")
            result = compatibility(args, client)
            marker = "PG_7D_ADAPTER_COMPATIBILITY_OK"
        else:
            required = (
                args.baseline, args.revision, args.status, args.source_commit,
                args.source_blob, args.source_artifact_sha256,
                args.source_manifest_sha256, args.source_semantics_sha256,
                args.generated_at, args.expected_7d,
            )
            if not all(required) or args.videos is None or args.occurrences is None or args.tombstones is None:
                parser.error("full verification arguments are incomplete")
            result = verify_full(args, client)
            marker = f"PG_7D_API_CONTRACT_OK phase={args.phase}"
    except (AssertionError, OSError, ValueError, KeyError) as exc:
        print(
            f"PG_7D_API_CONTRACT_FAILED phase={args.phase} error={exc}",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    print(marker)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
