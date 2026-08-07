"""Build an immutable versioned release bundle from compact ranking pages.

Prototype for the activation-time serving read model.  Input is a directory
of compact ranking JSON files (one per range/view/metric page, produced by
the Mac release generator after a PostgreSQL activation) plus a release meta
file.  Output is an immutable directory:

    releases/<content_sha256>/
      manifest.json
      meta.json
      rankings/<range>/<view>/<metric>/page-0001.json.gz

Determinism rules:
- page JSON is serialized with sorted keys and fixed separators;
- gzip always uses mtime=0 (deterministic bytes);
- manifest.json and meta.json are written last so the content SHA covers
  every file in the bundle.

The bundle never contains full occurrence lists: cards carry at most three
distinct-video previews (enforced by the compact API contract), and the full
source detail stays on the detail API.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

RELEASE_SCHEMA_VERSION = 1
MAX_PREVIEWS_PER_CARD = 3


def canonical_json(value: Any) -> bytes:
    """Deterministic JSON bytes: sorted keys, compact separators, UTF-8."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")


def stable_gzip(data: bytes, level: int = 6) -> bytes:
    """Deterministic gzip: fixed mtime=0 so the same input yields same bytes."""
    return gzip.compress(data, compresslevel=level, mtime=0)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def discover_pages(input_root: Path) -> list[tuple[Path, str]]:
    """Return (json_path, relative_compressed_page_path) pairs."""
    pages: list[tuple[Path, str]] = []
    if not input_root.is_dir():
        return pages
    for ranking_dir in sorted((input_root / "rankings").iterdir()):
        if not ranking_dir.is_dir():
            continue
        for view_dir in sorted(ranking_dir.iterdir()):
            if not view_dir.is_dir():
                continue
            for metric_dir in sorted(view_dir.iterdir()):
                if not metric_dir.is_dir():
                    continue
                for page in sorted(metric_dir.glob("page-*.json")):
                    rel_gz = Path("rankings") / ranking_dir.name / view_dir.name / metric_dir.name / (page.name + ".gz")
                    pages.append((page, rel_gz.as_posix()))
    return pages


def build_bundle(
    input_root: Path,
    output_root: Path,
    *,
    release_meta: dict[str, Any],
) -> tuple[str, Path]:
    """Build one immutable release bundle; returns (content_sha256, bundle_dir)."""
    page_files = discover_pages(input_root)
    if not page_files:
        raise ValueError("no ranking pages found under input rankings/ tree")

    # 1. materialize all page files first so the content SHA covers them.
    page_entries: list[dict[str, Any]] = []
    for json_path, rel in page_files:
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        records = payload.get("records")
        if isinstance(records, list):
            for record in records:
                previews = record.get("occurrences")
                if isinstance(previews, list) and len(previews) > MAX_PREVIEWS_PER_CARD:
                    raise ValueError(
                        f"{rel} card {record.get('key')} has {len(previews)} previews "
                        f"(max {MAX_PREVIEWS_PER_CARD})"
                    )
        page_json = canonical_json(payload)
        page_gz = stable_gzip(page_json)
        page_entries.append({
            "path": rel,
            "bytes": len(page_gz),
            "sha256": sha256_bytes(page_gz),
            "contentType": "application/gzip",
            "jsonSha256": sha256_bytes(page_json),
        })

    # 2. build the meta + manifest payloads (deterministic, sorted keys).
    meta_payload = {
        "schemaVersion": RELEASE_SCHEMA_VERSION,
        "activeRevisionId": release_meta.get("activeRevisionId", ""),
        "expectedParentRevisionId": release_meta.get("expectedParentRevisionId", ""),
        "sourceCommitSha": release_meta.get("sourceCommitSha", ""),
        "generatedAt": release_meta.get("generatedAt", ""),
        "latestEventTime": release_meta.get("latestEventTime", ""),
    }
    manifest_payload = {
        "schemaVersion": RELEASE_SCHEMA_VERSION,
        "sourceCommitSha": meta_payload["sourceCommitSha"],
        "expectedParentRevisionId": meta_payload["expectedParentRevisionId"],
        "candidateRevisionId": meta_payload["activeRevisionId"],
        "generatedAt": meta_payload["generatedAt"],
        "latestEventTime": meta_payload["latestEventTime"],
        "pages": sorted(page_entries, key=lambda entry: entry["path"]),
    }

    meta_bytes = canonical_json(meta_payload)
    meta_sha = sha256_bytes(meta_bytes)
    manifest_bytes = canonical_json(manifest_payload)
    manifest_sha = sha256_bytes(manifest_bytes)

    content_sha = sha256_bytes(
        b"".join(
            [meta_bytes, manifest_bytes]
            + [entry["sha256"].encode("ascii") for entry in page_entries]
        )
    )

    bundle_dir = output_root / content_sha
    if bundle_dir.exists():
        raise ValueError(f"release bundle already exists: {bundle_dir}")

    bundle_dir.mkdir(parents=True)
    (bundle_dir / "meta.json").write_bytes(meta_bytes)
    (bundle_dir / "manifest.json").write_bytes(manifest_bytes)
    for entry, (json_path, rel) in zip(page_entries, page_files):
        assert entry["path"] == rel
        target = bundle_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(stable_gzip(canonical_json(json.loads(json_path.read_text(encoding="utf-8")))))
    return content_sha, bundle_dir


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="dir with rankings/<range>/<view>/<metric>/page-*.json")
    parser.add_argument("--output", required=True, type=Path, help="release root (releases/<sha> is created under it)")
    parser.add_argument("--active-revision-id", required=True)
    parser.add_argument("--expected-parent-revision-id", required=True)
    parser.add_argument("--source-commit-sha", required=True)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--latest-event-time", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    release_meta = {
        "activeRevisionId": args.active_revision_id,
        "expectedParentRevisionId": args.expected_parent_revision_id,
        "sourceCommitSha": args.source_commit_sha,
        "generatedAt": args.generated_at,
        "latestEventTime": args.latest_event_time,
    }
    content_sha, bundle_dir = build_bundle(args.input, args.output, release_meta=release_meta)
    print(f"RELEASE_BUNDLE_OK contentSha256={content_sha} dir={bundle_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
