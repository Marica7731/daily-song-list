#!/usr/bin/env python3
"""Create one hashed frontend script and an index that references it."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Sequence

APP_REFERENCE_RE = re.compile(r"assets/app-h[0-9a-f]{12,64}\.js")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare(app: Path, index: Path, output: Path) -> dict[str, str | int]:
    if not app.is_file():
        raise FileNotFoundError(app)
    if not index.is_file():
        raise FileNotFoundError(index)
    app_sha = sha256_file(app)
    app_relative = f"assets/app-h{app_sha[:12]}.js"
    index_text = index.read_text(encoding="utf-8")
    references = APP_REFERENCE_RE.findall(index_text)
    if len(references) != 1:
        raise ValueError(f"expected exactly one hashed app reference, found {len(references)}")
    patched_index = APP_REFERENCE_RE.sub(app_relative, index_text, count=1)

    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    (output / "assets").mkdir(parents=True)
    (output / app_relative).write_bytes(app.read_bytes())
    (output / "index.html").write_text(patched_index, encoding="utf-8")
    manifest: dict[str, str | int] = {
        "schemaVersion": 1,
        "appPath": app_relative,
        "appSha256": app_sha,
        "appBytes": app.stat().st_size,
        "indexSha256": sha256_file(output / "index.html"),
        "previousAppPath": references[0],
    }
    (output / "frontend-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    if app_relative not in (output / "index.html").read_text(encoding="utf-8"):
        raise RuntimeError("patched index does not reference the hashed app")
    return manifest


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--index", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        manifest = prepare(args.app, args.index, args.output)
    except Exception as exc:
        print(f"FRONTEND_PREPARE_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(
        "FRONTEND_PREPARE_OK "
        f"app={manifest['appPath']} bytes={manifest['appBytes']} sha256={manifest['appSha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
