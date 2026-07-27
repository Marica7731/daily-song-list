#!/usr/bin/env python3
"""Bounded protocol helpers for streaming 7D video details to the Mac coordinator.

This module deliberately does not fetch YouTube, write PostgreSQL, or store media.
Workers receive a deterministic candidate shard and send one compact JSON envelope
per video.  The coordinator acknowledges a record only after it has been fsynced;
the worker may then release its current-video buffer.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable


SCHEMA_VERSION = 1


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def json_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def candidate_id(item: dict[str, Any]) -> str | None:
    value = item.get("videoId", item.get("video_id"))
    value = str(value or "").strip()
    return value or None


def candidates_from(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        raise ValueError("candidate manifest must be an object or array")
    for key in ("candidates", "videos", "items", "records"):
        if isinstance(value.get(key), list):
            return [item for item in value[key] if isinstance(item, dict)]
    raise ValueError("candidate manifest has no candidates/videos/items/records array")


def shard_for(video_id: str, worker_count: int) -> int:
    if worker_count <= 0:
        raise ValueError("worker_count must be positive")
    digest = hashlib.sha256(video_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % worker_count


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(canonical_bytes(value))
    os.replace(temporary, path)


def partition(manifest_path: Path, output_dir: Path, worker_count: int, hard_cap_bytes: int) -> dict[str, Any]:
    candidates = candidates_from(read_json(manifest_path))
    seen: set[str] = set()
    shards: list[list[dict[str, Any]]] = [[] for _ in range(worker_count)]
    rejected: list[dict[str, Any]] = []
    for item in candidates:
        video_id = candidate_id(item)
        if not video_id:
            rejected.append({"reason": "missing_video_id", "candidate": item})
            continue
        if video_id in seen:
            rejected.append({"reason": "duplicate_video_id", "videoId": video_id})
            continue
        seen.add(video_id)
        shards[shard_for(video_id, worker_count)].append(item)

    output_dir.mkdir(parents=True, exist_ok=True)
    shard_reports: list[dict[str, Any]] = []
    total_bytes = 0
    for index, rows in enumerate(shards):
        rows.sort(key=lambda row: candidate_id(row) or "")
        shard_path = output_dir / f"candidate-shard-{index:02d}.ndjson"
        encoded = b"".join(canonical_bytes(row) for row in rows)
        total_bytes += len(encoded)
        if total_bytes > hard_cap_bytes:
            raise RuntimeError(f"STREAM_PARTITION_CAP_EXCEEDED bytes={total_bytes} cap={hard_cap_bytes}")
        shard_path.write_bytes(encoded)
        shard_reports.append({
            "shardId": index,
            "candidateCount": len(rows),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "path": shard_path.name,
            "mediaDownloaded": False,
        })

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "workerCount": worker_count,
        "candidateCount": len(seen),
        "rejectedCount": len(rejected),
        "rejected": rejected,
        "shards": shard_reports,
        "mediaDownloaded": False,
        "bytes": total_bytes,
    }
    write_json(output_dir / "partition-manifest.json", report)
    return report


def load_candidates(path: Path) -> set[str]:
    values: set[str] = set()
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict) or not candidate_id(value):
                raise ValueError(f"invalid candidate line {line_number}")
            values.add(candidate_id(value) or "")
    return values


def load_checkpoint(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    value = read_json(path)
    records = value.get("records", {}) if isinstance(value, dict) else {}
    if not isinstance(records, dict):
        raise ValueError("checkpoint records must be an object")
    return {str(key): str(record_hash) for key, record_hash in records.items()}


def persist_checkpoint(path: Path, records: dict[str, str], replay_count: int) -> None:
    write_json(path, {
        "schemaVersion": SCHEMA_VERSION,
        "records": records,
        "receivedCount": len(records),
        "replayCount": replay_count,
        "mediaDownloaded": False,
    })


def envelopes(stream: Iterable[str]) -> Iterable[dict[str, Any]]:
    for line_number, line in enumerate(stream, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid envelope line {line_number}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"envelope line {line_number} must be an object")
        yield value


def ingest(
    input_stream: Iterable[str],
    output_path: Path,
    checkpoint_path: Path,
    manifest_path: Path,
    run_id: str,
    shard_id: int,
    candidate_path: Path,
    hard_cap_bytes: int,
) -> dict[str, Any]:
    allowed_ids = load_candidates(candidate_path)
    records = load_checkpoint(checkpoint_path)
    replay_count = 0
    status_counts: Counter[str] = Counter()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    current_bytes = output_path.stat().st_size if output_path.exists() else 0
    with output_path.open("ab") as output:
        for envelope in envelopes(input_stream):
            if envelope.get("schemaVersion", SCHEMA_VERSION) != SCHEMA_VERSION:
                raise ValueError("unsupported envelope schemaVersion")
            if str(envelope.get("runId", "")) != run_id:
                raise ValueError("envelope runId does not match task")
            if int(envelope.get("shardId", -1)) != shard_id:
                raise ValueError("envelope shardId does not match task")
            video_id = str(envelope.get("videoId", "")).strip()
            if not video_id or video_id not in allowed_ids:
                raise ValueError(f"videoId is not in candidate shard: {video_id or '<missing>'}")
            detail = envelope.get("detail")
            if not isinstance(detail, dict):
                raise ValueError(f"detail missing for videoId={video_id}")
            detail_id = candidate_id(detail) or video_id
            if detail_id != video_id:
                raise ValueError(f"detail videoId mismatch for {video_id}")
            record_hash = str(envelope.get("recordHash") or json_hash(detail))
            if record_hash != json_hash(detail):
                raise ValueError(f"recordHash mismatch for videoId={video_id}")
            previous = records.get(video_id)
            if previous is not None:
                if previous != record_hash:
                    raise ValueError(f"conflicting replay for videoId={video_id}")
                replay_count += 1
                continue
            compact = dict(envelope)
            compact["recordHash"] = record_hash
            compact["mediaDownloaded"] = False
            encoded = canonical_bytes(compact)
            if current_bytes + len(encoded) > hard_cap_bytes:
                raise RuntimeError(f"STREAM_INGEST_CAP_EXCEEDED bytes={current_bytes + len(encoded)} cap={hard_cap_bytes}")
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
            current_bytes += len(encoded)
            records[video_id] = record_hash
            status = str(detail.get("terminalStatus") or detail.get("status") or "received")
            status_counts[status] += 1
            persist_checkpoint(checkpoint_path, records, replay_count)

    digest = hashlib.sha256(output_path.read_bytes()).hexdigest() if output_path.exists() else hashlib.sha256(b"").hexdigest()
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "shardId": shard_id,
        "candidateCount": len(allowed_ids),
        "receivedCount": len(records),
        "replayCount": replay_count,
        "statusCounts": dict(status_counts),
        "bytes": current_bytes,
        "sha256": digest,
        "mediaDownloaded": False,
        "ackAfterFsync": True,
    }
    write_json(manifest_path, report)
    persist_checkpoint(checkpoint_path, records, replay_count)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    split = subparsers.add_parser("partition")
    split.add_argument("--manifest", type=Path, required=True)
    split.add_argument("--output-dir", type=Path, required=True)
    split.add_argument("--worker-count", type=int, required=True)
    split.add_argument("--hard-cap-bytes", type=int, default=64 * 1024 * 1024)
    receive = subparsers.add_parser("ingest")
    receive.add_argument("--input", type=Path, default=Path("-"))
    receive.add_argument("--output", type=Path, required=True)
    receive.add_argument("--checkpoint", type=Path, required=True)
    receive.add_argument("--manifest-output", type=Path, required=True)
    receive.add_argument("--run-id", required=True)
    receive.add_argument("--shard-id", type=int, required=True)
    receive.add_argument("--candidate-shard", type=Path, required=True)
    receive.add_argument("--hard-cap-bytes", type=int, default=64 * 1024 * 1024)
    args = parser.parse_args()
    try:
        if args.command == "partition":
            print(json.dumps(partition(args.manifest, args.output_dir, args.worker_count, args.hard_cap_bytes), ensure_ascii=False, sort_keys=True))
            return 0
        stream = sys.stdin if str(args.input) == "-" else args.input.open(encoding="utf-8")
        try:
            print(json.dumps(ingest(stream, args.output, args.checkpoint, args.manifest_output, args.run_id, args.shard_id, args.candidate_shard, args.hard_cap_bytes), ensure_ascii=False, sort_keys=True))
        finally:
            if stream is not sys.stdin:
                stream.close()
        return 0
    except Exception as exc:
        print(f"SEVEN_DAY_STREAM_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 78 if isinstance(exc, RuntimeError) else 1


if __name__ == "__main__":
    raise SystemExit(main())
