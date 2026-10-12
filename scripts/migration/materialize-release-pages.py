"""Materialize compact ranking pages from the active public adapter API.

The public API is the authoritative serving path for the current active
revision.  This control-plane script reads it once per page (read-only,
rate-limited) and writes the exact compact JSON pages that
``build-release-bundle.py`` consumes, so the same active revision can be
frozen into an immutable versioned release bundle for the WDC shadow host.

It never writes to the database, never mutates the API, and never contacts
the new VPS.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

USER_AGENT = "daily-song-list-release-materializer/1"
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5

RANGES = ("all", "7d")
VIEWS = ("songs", "vtubers", "videos")
METRICS = ("occurrences", "songs", "videos")
PAGE_SIZE = 200


def fetch_json(base: str, path: str, params: dict[str, Any]) -> dict[str, Any]:
    url = base + path + "?" + urllib.parse.urlencode(params)
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(f"fetch failed for {url}: {last_error}")


def materialize(base: str, output_root: Path, delay_seconds: float) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    for range_id in RANGES:
        for view in VIEWS:
            for metric in METRICS:
                rel = Path("rankings") / range_id / view / metric
                target_dir = output_root / rel
                target_dir.mkdir(parents=True, exist_ok=True)
                first = fetch_json(
                    base,
                    "/api/rankings",
                    {
                        "range": range_id,
                        "view": view,
                        "metric": metric,
                        "page": 1,
                        "pageSize": PAGE_SIZE,
                        "compact": 1,
                    },
                )
                time.sleep(delay_seconds)
                total = int(first.get("totalCount") or 0)
                page_count = max(1, math.ceil(total / PAGE_SIZE))
                pages = [first]
                for page in range(2, page_count + 1):
                    pages.append(
                        fetch_json(
                            base,
                            "/api/rankings",
                            {
                                "range": range_id,
                                "view": view,
                                "metric": metric,
                                "page": page,
                                "pageSize": PAGE_SIZE,
                                "compact": 1,
                            },
                        )
                    )
                    time.sleep(delay_seconds)
                for index, payload in enumerate(pages, start=1):
                    target = target_dir / f"page-{index:04d}.json"
                    if target.exists():
                        skipped += 1
                        continue
                    target.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    written += 1
                print(
                    f"{rel}: total={total} pages={len(pages)} "
                    f"bytes={sum(p.stat().st_size for p in target_dir.glob('page-*.json'))}"
                )
    print(f"MATERIALIZED written={written} skipped={skipped} root={output_root}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="https://ytb-song-rank.culua.com")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--delay", type=float, default=0.3)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    materialize(args.base, args.output, args.delay)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
