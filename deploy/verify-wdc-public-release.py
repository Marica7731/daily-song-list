#!/usr/bin/env python3
"""Fail-closed public acceptance for one immutable WDC release."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import statistics
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


EXPECTED_VIEWS = {"songs", "artists", "vtubers", "videos"}
EXPECTED_METRICS = {"occurrences", "songs", "videos"}
EXPECTED_SCOPES = {"all", "niche", "visible", "visibleNiche"}


@dataclass
class Response:
    status: int
    headers: Any
    body: bytes
    elapsed_ms: float


class Verifier:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.latencies: dict[str, list[float]] = {}

    def raw(
        self,
        path: str,
        *,
        accept: str = "application/json",
        encoding: str = "",
    ) -> Response:
        headers = {
            "Accept": accept,
            "User-Agent": "daily-song-list-wdc-bounded-release-gate/4",
        }
        if encoding:
            headers["Accept-Encoding"] = encoding
        started = time.monotonic()
        with urlopen(
            Request(self.args.base.rstrip("/") + path, headers=headers),
            timeout=self.args.timeout,
        ) as response:
            body = response.read()
            elapsed_ms = (time.monotonic() - started) * 1000
            response_headers = response.headers
            if response_headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return Response(response.status, response_headers, body, elapsed_ms)

    def fetch(
        self,
        path: str,
        *,
        source: str | None = None,
        gzip_required: bool = False,
        latency_group: str = "api",
    ) -> dict[str, Any]:
        response = self.raw(path, encoding="gzip" if gzip_required else "")
        if response.status != 200:
            raise AssertionError((path, response.status))
        if response.headers.get("X-Release-Sha") != self.args.release_sha:
            raise AssertionError((path, response.headers.get("X-Release-Sha")))
        if response.headers.get("X-Server-Commit") != self.args.server_commit:
            raise AssertionError((path, response.headers.get("X-Server-Commit")))
        if source is not None and response.headers.get("X-Data-Source") != source:
            raise AssertionError((path, response.headers.get("X-Data-Source")))
        if gzip_required and response.headers.get("Content-Encoding") != "gzip":
            raise AssertionError((path, response.headers))
        self.latencies.setdefault(latency_group, []).append(response.elapsed_ms)
        return json.loads(response.body)

    def source(
        self,
        range_id: str,
        source_key: str,
        *,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        query = urlencode(
            {
                "v": self.args.release_sha,
                "range": range_id,
                "page": page,
                "pageSize": page_size,
            }
        )
        return self.fetch(
            "/api/sources/" + quote(source_key, safe="") + "?" + query,
            source="local-serving-sqlite",
            latency_group="source",
        )

    def benchmark_protocol(self) -> dict[str, Any]:
        ranking = {
            "v": self.args.release_sha,
            "range": "all",
            "view": "songs",
            "metric": "occurrences",
            "page": 1,
            "pageSize": 30,
        }
        endpoints = {
            "health": "/healthz",
            "meta": "/api/meta",
            "rankingAll": "/api/rankings?" + urlencode(ranking),
            "rankingNiche": "/api/rankings?"
            + urlencode({**ranking, "nicheOnly": 1}),
            "rankingVisible": "/api/rankings?"
            + urlencode({**ranking, "hideUnknownArtist": 1}),
            "sourcePage": "/api/sources/0007036316d9dffa?"
            + urlencode(
                {
                    "v": self.args.release_sha,
                    "range": "all",
                    "page": 1,
                    "pageSize": 17,
                }
            ),
        }
        samples: dict[str, list[float]] = {name: [] for name in endpoints}
        for _ in range(3):
            for name, path in endpoints.items():
                response = self.raw(path, encoding="gzip")
                assert response.status == 200, (name, response.status)
                release_header = response.headers.get("X-Release-Sha")
                if release_header is not None:
                    assert release_header == self.args.release_sha, (
                        name,
                        release_header,
                        self.args.release_sha,
                    )
                if name == "health":
                    health = json.loads(response.body)
                    actual_release = str(
                        health.get("releaseContentSha")
                        or health.get("currentRelease")
                        or ""
                    )
                    assert actual_release == self.args.release_sha, (
                        actual_release,
                        self.args.release_sha,
                    )
                samples[name].append(response.elapsed_ms)
        return {
            "releaseSha": self.args.release_sha,
            "capturedAt": int(time.time()),
            "protocol": {
                name: {
                    "count": len(values),
                    "medianMs": round(statistics.median(values), 2),
                    "maxMs": round(max(values), 2),
                }
                for name, values in sorted(samples.items())
            },
        }

    def verify_identity(self) -> None:
        health = self.fetch("/healthz", latency_group="health")
        assert health.get("status") == "ok", health
        assert health.get("releaseContentSha") == self.args.release_sha, health
        assert health.get("buildLogicSha") == self.args.build_logic_sha, health
        assert health.get("activeRevision") == self.args.active_revision, health
        assert health.get("sourceCommit") == self.args.source_commit, health
        assert health.get("oldOriginDependency") is False, health
        assert health.get("sourceFallbackEnabled") is False, health
        assert set(health.get("views") or []) == EXPECTED_VIEWS, health
        assert set(health.get("metrics") or []) == EXPECTED_METRICS, health
        assert set(health.get("rankingScopes") or []) == EXPECTED_SCOPES, health

        meta = self.fetch("/api/meta", source="local-release", latency_group="meta")
        identity = meta.get("meta") or {}
        capabilities = meta.get("capabilities") or {}
        assert identity.get("active_revision_id") == self.args.active_revision, meta
        assert identity.get("source_commit_sha") == self.args.source_commit, meta
        assert capabilities.get("localSources") is True, meta
        assert capabilities.get("localSearch") is True, meta
        assert capabilities.get("oldOriginDependency") is False, meta
        assert capabilities.get("sourceFallbackEnabled") is False, meta
        assert set(capabilities.get("views") or []) == EXPECTED_VIEWS, meta
        assert set(capabilities.get("metrics") or []) == EXPECTED_METRICS, meta
        assert set(capabilities.get("rankingScopes") or []) == EXPECTED_SCOPES, meta
        assert {"7d", "all"}.issubset(set(capabilities.get("ranges") or [])), meta

    def verify_rankings_search_filters(self) -> None:
        all_songs: list[dict[str, Any]] = []
        for range_id in ("7d", "all"):
            for view in sorted(EXPECTED_VIEWS):
                for metric in sorted(EXPECTED_METRICS):
                    query = urlencode(
                        {
                            "v": self.args.release_sha,
                            "range": range_id,
                            "view": view,
                            "metric": metric,
                            "page": 1,
                            "pageSize": 30,
                        }
                    )
                    payload = self.fetch(
                        "/api/rankings?" + query,
                        source="local-release-chunk",
                        gzip_required=True,
                        latency_group="ranking",
                    )
                    records = payload.get("records") or []
                    assert records, (range_id, view, metric, payload)
                    keys = [str(record.get("key") or "") for record in records]
                    assert all(keys) and len(keys) == len(set(keys)), keys
                    if view == "artists":
                        for record in records:
                            assert int(record.get("songCount") or 0) >= len(
                                record.get("songs") or []
                            ), record
                            assert len(record.get("songs") or []) <= 3, record
                    if range_id == "all" and view == "songs" and metric == "occurrences":
                        all_songs = records

        base_query = {
            "v": self.args.release_sha,
            "range": "all",
            "view": "songs",
            "metric": "occurrences",
            "page": 1,
            "pageSize": 30,
        }
        base = self.fetch(
            "/api/rankings?" + urlencode(base_query),
            source="local-release-chunk",
            latency_group="ranking",
        )
        totals = {"all": int(base.get("totalCount") or 0)}
        for scope, flags in {
            "niche": {"nicheOnly": 1},
            "visible": {"hideUnknownArtist": 1},
            "visibleNiche": {"nicheOnly": 1, "hideUnknownArtist": 1},
        }.items():
            scoped = self.fetch(
                "/api/rankings?" + urlencode({**base_query, **flags}),
                source="local-serving-sqlite",
                latency_group="filter",
            )
            assert scoped.get("scopeKey") == scope, scoped
            totals[scope] = int(scoped.get("totalCount") or 0)
        assert totals["niche"] != totals["all"], totals
        assert totals["visible"] != totals["all"], totals

        record = next(
            (
                item
                for item in all_songs
                if item.get("title")
                and (item.get("artist") or item.get("displayArtist"))
            ),
            None,
        )
        assert record is not None, all_songs
        for field, value in (
            ("title", record["title"]),
            ("artist", record.get("artist") or record.get("displayArtist")),
        ):
            searched = self.fetch(
                "/api/rankings?"
                + urlencode(
                    {
                        **base_query,
                        "q": str(value),
                        "searchFields": field,
                        "pageSize": 12,
                    }
                ),
                source="local-serving-sqlite",
                latency_group="search",
            )
            records = searched.get("records") or []
            assert records, (field, value, searched)
            keys = [str(item.get("key") or "") for item in records]
            assert len(keys) == len(set(keys)), keys

    def verify_exact_sources(self) -> None:
        for range_id, source_key, expected in (
            ("all", "0007036316d9dffa", (771, 1, 737)),
            ("all", "000c1914748382f4", (7, 1, 7)),
        ):
            detail = self.source(range_id, source_key, page=1, page_size=200)
            songs = (detail.get("record") or {}).get("songs") or []
            actual = (
                int(detail.get("totalOccurrenceCount") or 0),
                int(detail.get("totalSongCount") or len(songs)),
                int(detail.get("totalVideoCount") or 0),
            )
            assert detail.get("found") is True, detail
            assert actual == expected, (source_key, actual, expected)
            assert len(songs) == 1, (source_key, songs)

        width = self.source("7d", "9d99a4a482ed24b2536f0058", page=1, page_size=200)
        songs = (width.get("record") or {}).get("songs") or []
        owners = [
            song
            for song in songs
            if str(song.get("key") or "") == "e3bf8d66f08c946857927c15"
        ]
        assert len(owners) == 1, songs
        assert unicodedata.normalize("NFKC", str(owners[0].get("name") or "")) == "サインはB", owners

    def verify_cross_page_source(self) -> None:
        source_key = self.args.probe_source_key
        page_size = 17
        first = self.source("all", source_key, page=1, page_size=page_size)
        total_videos = int(first.get("totalVideoCount") or 0)
        total_occurrences = int(first.get("totalOccurrenceCount") or 0)
        page_count = int(first.get("pageCount") or 0)
        assert total_videos == 31, first
        assert total_occurrences > total_videos, first
        assert page_count == math.ceil(total_videos / page_size) == 2, first
        occurrences: list[dict[str, Any]] = []
        for page in range(1, page_count + 1):
            detail = first if page == 1 else self.source(
                "all", source_key, page=page, page_size=page_size
            )
            assert int(detail.get("page") or 0) == page, detail
            assert int(detail.get("totalVideoCount") or 0) == total_videos, detail
            assert int(detail.get("totalOccurrenceCount") or 0) == total_occurrences, detail
            occurrences.extend((detail.get("record") or {}).get("occurrences") or [])
        video_ids = {
            str(item.get("videoId") or (item.get("item") or {}).get("videoId") or "")
            for item in occurrences
        }
        video_ids.discard("")
        assert len(video_ids) == total_videos, (len(video_ids), total_videos)
        assert len(occurrences) == total_occurrences, (
            len(occurrences),
            total_occurrences,
        )

        invalid = (
            "/api/sources/"
            + quote(source_key, safe="")
            + "?"
            + urlencode({"v": self.args.release_sha, "range": "all", "page": 0})
        )
        try:
            self.raw(invalid)
        except HTTPError as error:
            body = json.loads(error.read())
            assert error.code == 400 and body.get("error") == "invalid_pagination", (
                error.code,
                body,
            )
        else:
            raise AssertionError("invalid source page unexpectedly succeeded")

    def verify_assets(self) -> None:
        response = self.raw("/", accept="text/html", encoding="gzip")
        assert response.status == 200, response.status
        assert "max-age=60" in str(response.headers.get("Cache-Control") or ""), response.headers
        text = response.body.decode("utf-8")
        app = re.search(r"assets/app-h[0-9a-f]{12}\.js", text)
        css = re.search(r"assets/styles-h[0-9a-f]{12}\.css", text)
        assert app and css, text[:1000]
        for asset in (app.group(0), css.group(0)):
            result = self.raw("/" + asset, accept="*/*", encoding="gzip")
            assert result.status == 200, (asset, result.status)
            assert result.headers.get("Content-Encoding") == "gzip", result.headers
            assert "immutable" in str(result.headers.get("Cache-Control") or ""), result.headers
            assert len(result.body) > 1000, (asset, len(result.body))
            self.latencies.setdefault("asset", []).append(result.elapsed_ms)

    def result(
        self,
        *,
        protocol_after: dict[str, Any],
        protocol_before: dict[str, Any],
    ) -> dict[str, Any]:
        before = protocol_before.get("protocol") or {}
        after = protocol_after.get("protocol") or {}
        assert set(before) == set(after) and before, (before, after)
        comparison = {}
        for name in sorted(after):
            before_median = float(before[name]["medianMs"])
            after_median = float(after[name]["medianMs"])
            comparison[name] = {
                "beforeMedianMs": before_median,
                "afterMedianMs": after_median,
                "deltaMs": round(after_median - before_median, 2),
                "ratio": round(after_median / before_median, 3)
                if before_median > 0
                else None,
            }
        return {
            "releaseSha": self.args.release_sha,
            "activeRevision": self.args.active_revision,
            "sourceCommit": self.args.source_commit,
            "probeSourceKey": self.args.probe_source_key,
            "sameProtocolBeforeRelease": protocol_before.get("releaseSha"),
            "sameProtocolLatency": comparison,
            "latencyMs": {
                key: {
                    "count": len(values),
                    "median": round(statistics.median(values), 2),
                    "max": round(max(values), 2),
                }
                for key, values in sorted(self.latencies.items())
                if values
            },
        }


def write_new_json(path: Path, payload: dict[str, Any]) -> None:
    if not path.is_absolute() or path.is_symlink() or not path.parent.is_dir():
        raise AssertionError(f"unsafe latency output path: {path}")
    if path.exists():
        raise AssertionError(f"latency output already exists: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(
            descriptor,
            (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8"),
        )
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="https://next.ytb-song-rank.culua.com")
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--build-logic-sha", default="")
    parser.add_argument("--server-commit", default="")
    parser.add_argument("--active-revision", default="")
    parser.add_argument("--source-commit", default="")
    parser.add_argument("--probe-source-key", default="")
    parser.add_argument("--capture-latency-output", type=Path)
    parser.add_argument("--compare-latency-baseline", type=Path)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    for name in ("release_sha",):
        if re.fullmatch(r"[0-9a-f]{64}", getattr(args, name)) is None:
            parser.error(f"--{name.replace('_', '-')} must be 64 lowercase hex")
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be in [1, 60]")
    if args.capture_latency_output is not None:
        if args.compare_latency_baseline is not None:
            parser.error("capture and compare modes are mutually exclusive")
        return args
    if args.compare_latency_baseline is None:
        parser.error("--compare-latency-baseline is required for full acceptance")
    if (
        not args.compare_latency_baseline.is_absolute()
        or args.compare_latency_baseline.is_symlink()
        or not args.compare_latency_baseline.is_file()
        or args.compare_latency_baseline.stat().st_size > 1_000_000
    ):
        parser.error("--compare-latency-baseline is unsafe")
    if re.fullmatch(r"[0-9a-f]{64}", args.build_logic_sha) is None:
        parser.error("--build-logic-sha must be 64 lowercase hex")
    for name in ("server_commit", "source_commit"):
        if re.fullmatch(r"[0-9a-f]{40}", getattr(args, name)) is None:
            parser.error(f"--{name.replace('_', '-')} must be 40 lowercase hex")
    if re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", args.active_revision) is None:
        parser.error("--active-revision is unsafe")
    if re.fullmatch(r"[0-9a-f]{16,64}", args.probe_source_key) is None:
        parser.error("--probe-source-key is unsafe")
    return args


def main() -> int:
    args = parse_args()
    verifier = Verifier(args)
    if args.capture_latency_output is not None:
        baseline = verifier.benchmark_protocol()
        write_new_json(args.capture_latency_output, baseline)
        print("WDC_PUBLIC_LATENCY_BASELINE", json.dumps(baseline, sort_keys=True))
        return 0
    verifier.verify_identity()
    verifier.verify_rankings_search_filters()
    verifier.verify_exact_sources()
    verifier.verify_cross_page_source()
    verifier.verify_assets()
    protocol_after = verifier.benchmark_protocol()
    protocol_before = json.loads(
        args.compare_latency_baseline.read_text(encoding="utf-8")
    )
    print(
        "WDC_PUBLIC_RELEASE_VERIFIED",
        json.dumps(
            verifier.result(
                protocol_after=protocol_after,
                protocol_before=protocol_before,
            ),
            sort_keys=True,
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
