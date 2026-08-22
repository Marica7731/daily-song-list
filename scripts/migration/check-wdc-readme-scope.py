#!/usr/bin/env python3
"""Classify README changes that are confined to the bounded WDC release docs."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


START_MARKER = "## WDC server-side release workflow\n"
END_MARKER = "## UI Screenshots\n"
README_PATH = Path("README.md")


def _outside_bounded_wdc_docs(text: str) -> tuple[str, str] | None:
    if text.count(START_MARKER) != 1 or text.count(END_MARKER) != 1:
        return None
    prefix, remainder = text.split(START_MARKER, 1)
    if END_MARKER not in remainder:
        return None
    _, suffix = remainder.split(END_MARKER, 1)
    return prefix, suffix


def has_only_bounded_wdc_changes(base_text: str, head_text: str) -> bool:
    base_outside = _outside_bounded_wdc_docs(base_text)
    head_outside = _outside_bounded_wdc_docs(head_text)
    return (
        base_outside is not None
        and head_outside is not None
        and base_outside == head_outside
        and base_text != head_text
    )


def _read_base(base: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{base}:README.md"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.base) or args.base == "0" * 40:
        print("CODEX_README_WDC_SCOPE_ERROR reason=invalid-base", file=sys.stderr)
        return 2
    try:
        base_text = _read_base(args.base)
        head_text = README_PATH.read_text(encoding="utf-8")
    except (OSError, subprocess.CalledProcessError) as exc:
        print(
            f"CODEX_README_WDC_SCOPE_ERROR reason={type(exc).__name__}",
            file=sys.stderr,
        )
        return 2
    if has_only_bounded_wdc_changes(base_text, head_text):
        print("CODEX_README_WDC_SCOPE_OK")
        return 0
    print("CODEX_README_WDC_SCOPE_REJECTED", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
