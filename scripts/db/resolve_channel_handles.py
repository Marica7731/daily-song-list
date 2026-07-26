#!/usr/bin/env python3
"""Resolve YouTube channel identity for pending playlist upsert operations.

The resolver uses yt-dlp's extracted channel metadata from each video URL.
It never treats a display name or a comment author as a verified handle.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


HANDLE_RE = re.compile(r"/@([A-Za-z0-9._-]+)")


def normalize(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def load_payload(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("operations"), list):
        raise ValueError("input must be normalized postgres_upsert JSON with operations")
    return payload


def resolve_one(url: str, yt_dlp: str, timeout: int) -> dict:
    if not url:
        return {"status": "no_video_url"}
    command = [
        yt_dlp,
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout",
        str(timeout),
        "--print",
        "%(channel_id)s\\t%(channel_handle)s\\t%(channel)s\\t%(channel_url)s",
        url,
    ]
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout + 10)
    except FileNotFoundError:
        return {"status": "yt_dlp_missing"}
    except subprocess.TimeoutExpired:
        return {"status": "timeout"}
    if completed.returncode != 0:
        return {"status": "lookup_failed", "exitCode": completed.returncode}
    line = next((line.strip() for line in completed.stdout.splitlines() if line.strip()), "")
    fields = line.split("\t")
    fields += [""] * (4 - len(fields))
    channel_id, handle, display_name, channel_url = [normalize(field) for field in fields[:4]]
    if not handle:
        match = HANDLE_RE.search(channel_url)
        if match:
            handle = "@" + match.group(1)
    status = "verified" if channel_id and handle and channel_url else "partial"
    return {
        "status": status,
        "channelId": channel_id,
        "handle": handle,
        "displayName": display_name,
        "channelUrl": channel_url,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--yt-dlp", default="yt-dlp")
    parser.add_argument("--timeout-seconds", type=int, default=20)
    args = parser.parse_args()
    try:
        payload = load_payload(args.input)
        cache: dict[str, dict] = {}
        counts: dict[str, int] = {}
        for operation in payload["operations"]:
            url = normalize(operation.get("videoUrl"))
            if url not in cache:
                cache[url] = resolve_one(url, args.yt_dlp, args.timeout_seconds)
            result = cache[url]
            channel = operation.setdefault("channel", {})
            if result.get("status") == "verified":
                for key in ("channelId", "handle", "displayName", "channelUrl"):
                    channel[key] = result.get(key, "")
                channel["resolutionStatus"] = "verified"
            else:
                channel["resolutionStatus"] = result.get("status", "unknown")
            counts[result.get("status", "unknown")] = counts.get(result.get("status", "unknown"), 0) + 1
        payload["channelResolution"] = {"videos": len(cache), "statuses": counts}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("CODEX_CHANNEL_HANDLE_RESOLVE_OK " + json.dumps(payload["channelResolution"], ensure_ascii=False))
    except Exception as exc:
        print(f"CODEX_CHANNEL_HANDLE_RESOLVE_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
