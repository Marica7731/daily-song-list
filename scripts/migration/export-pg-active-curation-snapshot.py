#!/usr/bin/env python3
"""Export, capture, and attest a bounded active-PG curation snapshot.

The ``export`` command runs beside PostgreSQL and writes only NDJSON to stdout.
It resolves the active full projection plus incremental overlays through the
production PG adapter and never writes a snapshot on the database host.

The ``capture`` command runs on the Mac producer.  It enforces byte/row caps,
hashes the exact stream, and writes an atomic progress/final checkpoint.

The ``finalize`` command binds the converter output to the active revision and
the independently verified stream without requiring a consumer workflow change.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable, Mapping


EXPORT_OK_PREFIX = "PG_ACTIVE_CURATION_EXPORT_OK "
CAPTURE_OK_PREFIX = "PG_ACTIVE_CURATION_CAPTURE_OK "
FINALIZE_OK_PREFIX = "PG_ACTIVE_CURATION_FINALIZE_OK "
REQUIRED_SNAPSHOT_FIELDS = (
    "videoId",
    "occurrenceId",
    "position",
    "seconds",
    "title",
    "artist",
    "sourceId",
    "sourceHash",
    "rawHash",
    "rangeId",
    "sourceSystem",
    "channelHandle",
)


class GateError(RuntimeError):
    """A bounded producer gate failed and should return exit status 78."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise GateError(f"JSON root must be an object: {path}")
    return value


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def load_adapter(path: Path):
    spec = importlib.util.spec_from_file_location("curation_pg_adapter", path)
    if spec is None or spec.loader is None:
        raise GateError(f"cannot load PG adapter: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("connect_from_env", "_one", "_load_snapshot"):
        if not hasattr(module, name):
            raise GateError(f"PG adapter missing required function: {name}")
    return module


def snapshot_rows(snapshot: Any) -> Iterable[dict[str, Any]]:
    records = getattr(snapshot, "records", None)
    if records is None:
        raise GateError("PG adapter snapshot has no records")
    for record in records:
        if not isinstance(record, Mapping):
            raise GateError("PG adapter snapshot record is not an object")
        video = record.get("video")
        occurrences = record.get("occurrences")
        if not isinstance(video, Mapping) or not isinstance(occurrences, Iterable):
            raise GateError("PG adapter snapshot record is missing video/occurrences")
        video_id = text(video.get("videoId"))
        channel_handle = text(video.get("channelHandle"))
        if not video_id:
            raise GateError("resolved PG video is missing videoId")
        ordered = sorted(
            occurrences,
            key=lambda item: (
                int(item.get("position") or 0) if isinstance(item, Mapping) else 0,
                text(item.get("occurrenceId")) if isinstance(item, Mapping) else "",
            ),
        )
        for occurrence in ordered:
            if not isinstance(occurrence, Mapping):
                raise GateError(f"resolved PG occurrence is not an object: {video_id}")
            occurrence_id = text(occurrence.get("occurrenceId"))
            if not occurrence_id:
                raise GateError(f"resolved PG occurrence is missing occurrenceId: {video_id}")
            yield {
                "videoId": video_id,
                "occurrenceId": occurrence_id,
                "position": occurrence.get("position"),
                "seconds": occurrence.get("seconds"),
                "title": occurrence.get("title"),
                "artist": occurrence.get("artist"),
                "sourceId": occurrence.get("sourceId"),
                "sourceHash": occurrence.get("sourceHash"),
                "rawHash": occurrence.get("rawHash"),
                "rangeId": occurrence.get("rangeId"),
                "sourceSystem": occurrence.get("sourceSystem"),
                "channelHandle": occurrence.get("channelHandle", channel_handle),
            }


def export_snapshot(args: argparse.Namespace) -> int:
    adapter = load_adapter(args.adapter)
    os.environ.pop("DAILY_SONG_PG_CANDIDATE_REVISION", None)
    connection = adapter.connect_from_env()
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    try:
        with connection.cursor() as cursor:
            cursor.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor.execute("SET LOCAL statement_timeout = '20min'")
            cursor.execute("SET LOCAL idle_in_transaction_session_timeout = '25min'")
        state = adapter._one(
            connection,
            "SELECT state_value FROM migration_state WHERE state_key = 'active_revision_id'",
        )
        active_revision = text(state.get("state_value")) if state else ""
        if not active_revision:
            raise GateError("PostgreSQL has no active revision")
        if args.expected_active_revision and active_revision != args.expected_active_revision:
            raise GateError(
                f"active revision mismatch expected={args.expected_active_revision} actual={active_revision}"
            )
        snapshot = adapter._load_snapshot(connection)
        resolved_revision = text(getattr(snapshot, "revision_id", ""))
        if resolved_revision != active_revision:
            raise GateError(
                f"resolved snapshot mismatch active={active_revision} resolved={resolved_revision}"
            )
        for row in snapshot_rows(snapshot):
            encoded = json_bytes(row)
            sys.stdout.buffer.write(encoded)
            digest.update(encoded)
            byte_count += len(encoded)
            row_count += 1
            if row_count % args.progress_every == 0:
                sys.stdout.buffer.flush()
                print(
                    f"PG_ACTIVE_CURATION_EXPORT_PROGRESS rows={row_count} bytes={byte_count}",
                    file=sys.stderr,
                    flush=True,
                )
        sys.stdout.buffer.flush()
        summary = {
            "status": "ok",
            "activeRevisionId": active_revision,
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
            "completedAt": utc_now(),
        }
        print(EXPORT_OK_PREFIX + json.dumps(summary, separators=(",", ":")), file=sys.stderr, flush=True)
        connection.rollback()
        return 0
    finally:
        try:
            connection.rollback()
        except Exception:
            pass
        connection.close()


def validate_snapshot_row(value: Any, row_number: int) -> None:
    if not isinstance(value, dict):
        raise GateError(f"snapshot row {row_number} is not an object")
    missing = [field for field in REQUIRED_SNAPSHOT_FIELDS if field not in value]
    if missing:
        raise GateError(f"snapshot row {row_number} missing fields: {','.join(missing)}")
    if not text(value.get("videoId")) or not text(value.get("occurrenceId")):
        raise GateError(f"snapshot row {row_number} has empty identity")


def capture_checkpoint(
    path: Path,
    output: Path,
    row_count: int,
    byte_count: int,
    digest: hashlib._Hash,
    complete: bool,
) -> None:
    atomic_json(
        path,
        {
            "schemaVersion": 1,
            "kind": "pg-active-curation-snapshot-checkpoint",
            "complete": complete,
            "resumable": False,
            "snapshotPath": output.name,
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
            "updatedAt": utc_now(),
        },
    )


def capture_snapshot(args: argparse.Namespace) -> int:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    try:
        with args.output.open("wb") as output:
            for raw in sys.stdin.buffer:
                if not raw.strip():
                    raise GateError(f"blank snapshot line at row {row_count + 1}")
                next_bytes = byte_count + len(raw)
                next_rows = row_count + 1
                if next_bytes > args.max_bytes:
                    raise GateError(
                        f"snapshot byte cap exceeded bytes={next_bytes} cap={args.max_bytes}"
                    )
                if next_rows > args.max_rows:
                    raise GateError(
                        f"snapshot row cap exceeded rows={next_rows} cap={args.max_rows}"
                    )
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    raise GateError(f"invalid snapshot JSON at row {next_rows}: {error}") from error
                validate_snapshot_row(value, next_rows)
                output.write(raw)
                digest.update(raw)
                byte_count = next_bytes
                row_count = next_rows
                if row_count % args.progress_every == 0:
                    output.flush()
                    os.fsync(output.fileno())
                    capture_checkpoint(
                        args.checkpoint_output,
                        args.output,
                        row_count,
                        byte_count,
                        digest,
                        False,
                    )
            output.flush()
            os.fsync(output.fileno())
        if row_count == 0:
            raise GateError("active snapshot stream is empty")
        capture_checkpoint(
            args.checkpoint_output,
            args.output,
            row_count,
            byte_count,
            digest,
            True,
        )
        summary = {
            "status": "ok",
            "rows": row_count,
            "bytes": byte_count,
            "sha256": digest.hexdigest(),
        }
        print(CAPTURE_OK_PREFIX + json.dumps(summary, separators=(",", ":")))
        return 0
    except Exception:
        args.output.unlink(missing_ok=True)
        capture_checkpoint(
            args.checkpoint_output,
            args.output,
            row_count,
            byte_count,
            digest,
            False,
        )
        raise


def remote_export_summary(path: Path) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith(EXPORT_OK_PREFIX):
            value = json.loads(line[len(EXPORT_OK_PREFIX):])
            if isinstance(value, dict):
                matches.append(value)
    if len(matches) != 1:
        raise GateError(f"expected one remote export summary, found {len(matches)}")
    return matches[0]


def assert_int(value: Any, expected: int, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value != expected:
        raise GateError(f"{label} mismatch expected={expected} actual={value}")


def finalize_artifact(args: argparse.Namespace) -> int:
    converter_manifest = read_json(args.converter_manifest)
    review = read_json(args.review)
    capture = read_json(args.snapshot_checkpoint)
    rules = read_json(args.rules_manifest)
    remote = remote_export_summary(args.remote_log)

    if converter_manifest.get("kind") != "curation-accepted-increment":
        raise GateError("converter manifest kind is not curation-accepted-increment")
    if converter_manifest.get("status") != "ready":
        raise GateError("converter manifest is not ready")
    if capture.get("complete") is not True or capture.get("resumable") is not False:
        raise GateError("snapshot checkpoint is not complete/non-resumable")
    for field in ("rows", "bytes", "sha256"):
        if capture.get(field) != remote.get(field):
            raise GateError(
                f"remote/Mac snapshot {field} mismatch remote={remote.get(field)} mac={capture.get(field)}"
            )
    if converter_manifest.get("snapshotSha256") != capture.get("sha256"):
        raise GateError("converter snapshot SHA does not match capture checkpoint")

    assert_int(
        converter_manifest.get("selectorMutationCount"),
        args.expected_selector_mutations,
        "selectorMutationCount",
    )
    assert_int(
        converter_manifest.get("aliasMutationCount"),
        args.expected_alias_mutations,
        "aliasMutationCount",
    )
    assert_int(
        converter_manifest.get("curationMutationCount"),
        args.expected_selector_mutations + args.expected_alias_mutations,
        "curationMutationCount",
    )
    candidate_rows = sum(1 for line in args.candidate.read_bytes().splitlines() if line.strip())
    assert_int(
        candidate_rows,
        args.expected_selector_mutations + args.expected_alias_mutations,
        "candidate row count",
    )
    failures = {
        "unmatched",
        "ambiguous",
        "invalid",
        "count_mismatch",
        "alias_count_mismatch",
        "safety_violation",
    }
    summary = review.get("summary")
    results = review.get("results")
    if not isinstance(summary, dict) or not isinstance(results, list):
        raise GateError("review audit is missing summary/results")
    if any(int(summary.get(status) or 0) for status in failures):
        raise GateError(f"review audit contains failure status: {summary}")

    safety_results = {
        text(item.get("assertionId")): item
        for item in results
        if isinstance(item, dict) and item.get("kind") == "safety_assertion"
    }
    assertions = rules.get("safetyAssertions", [])
    if not isinstance(assertions, list):
        raise GateError("rules safetyAssertions is not a list")
    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise GateError("rules safety assertion is not an object")
        assertion_id = text(assertion.get("assertionId"))
        result = safety_results.get(assertion_id)
        if not result or result.get("status") != "accepted":
            raise GateError(f"safety assertion not accepted: {assertion_id}")
        expected = assertion.get("expectedMutationCount")
        if result.get("mutationCount") != expected:
            raise GateError(
                f"safety mutation mismatch assertion={assertion_id} expected={expected} actual={result.get('mutationCount')}"
            )

    rules_sha = sha256_file(args.rules_manifest)
    if converter_manifest.get("rulesManifestSha256") != rules_sha:
        raise GateError("converter rules manifest SHA mismatch")
    if text(remote.get("activeRevisionId")) != args.expected_active_revision:
        raise GateError(
            f"final active revision mismatch expected={args.expected_active_revision} actual={remote.get('activeRevisionId')}"
        )

    candidate_sha = sha256_file(args.candidate)
    candidate_bytes = args.candidate.stat().st_size
    finalized = dict(converter_manifest)
    finalized.update(
        {
            "activeSnapshotRevisionId": remote["activeRevisionId"],
            "snapshotSha256": capture["sha256"],
            "snapshotBytes": capture["bytes"],
            "snapshotRowCount": capture["rows"],
            "snapshotArtifactIncluded": False,
            "snapshotCheckpointComplete": True,
            "snapshotCheckpointResumable": False,
            "rulesManifestSha256": rules_sha,
            "producerCommitSha": args.producer_commit,
            "producerRunId": args.producer_run_id,
            "producerRunAttempt": args.producer_run_attempt,
            "producerFinalizedAt": utc_now(),
            "patch_sha256": candidate_sha,
            "patch_bytes": candidate_bytes,
        }
    )
    atomic_json(args.output_manifest, finalized)

    outputs = {}
    for name, path in (
        ("candidate", args.candidate),
        ("manifest", args.output_manifest),
        ("review", args.review),
    ):
        outputs[name] = {
            "file": path.name,
            "bytes": path.stat().st_size,
            "sha256": candidate_sha if name == "candidate" else sha256_file(path),
        }
    checkpoint = {
        "schemaVersion": 1,
        "kind": "curation-pg-producer-checkpoint",
        "complete": True,
        "resumable": False,
        "producerCommitSha": args.producer_commit,
        "producerRunId": args.producer_run_id,
        "producerRunAttempt": args.producer_run_attempt,
        "activeSnapshotRevisionId": remote["activeRevisionId"],
        "rulesManifestSha256": rules_sha,
        "snapshot": {
            "rows": capture["rows"],
            "bytes": capture["bytes"],
            "sha256": capture["sha256"],
            "artifactIncluded": False,
        },
        "outputs": outputs,
        "completedAt": utc_now(),
    }
    atomic_json(args.output_checkpoint, checkpoint)
    print(
        FINALIZE_OK_PREFIX
        + json.dumps(
            {
                "status": "ok",
                "activeRevisionId": remote["activeRevisionId"],
                "mutations": finalized["curationMutationCount"],
                "snapshotBytes": capture["bytes"],
            },
            separators=(",", ":"),
        )
    )
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export")
    export.add_argument("--adapter", type=Path, required=True)
    export.add_argument("--expected-active-revision", required=True)
    export.add_argument("--progress-every", type=int, default=10000)
    export.set_defaults(handler=export_snapshot)

    capture = commands.add_parser("capture")
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--checkpoint-output", type=Path, required=True)
    capture.add_argument("--max-bytes", type=int, required=True)
    capture.add_argument("--max-rows", type=int, default=1000000)
    capture.add_argument("--progress-every", type=int, default=10000)
    capture.set_defaults(handler=capture_snapshot)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--converter-manifest", type=Path, required=True)
    finalize.add_argument("--review", type=Path, required=True)
    finalize.add_argument("--candidate", type=Path, required=True)
    finalize.add_argument("--snapshot-checkpoint", type=Path, required=True)
    finalize.add_argument("--remote-log", type=Path, required=True)
    finalize.add_argument("--rules-manifest", type=Path, required=True)
    finalize.add_argument("--output-manifest", type=Path, required=True)
    finalize.add_argument("--output-checkpoint", type=Path, required=True)
    finalize.add_argument("--expected-active-revision", required=True)
    finalize.add_argument("--expected-selector-mutations", type=int, default=1)
    finalize.add_argument("--expected-alias-mutations", type=int, default=10)
    finalize.add_argument("--producer-commit", required=True)
    finalize.add_argument("--producer-run-id", required=True)
    finalize.add_argument("--producer-run-attempt", required=True)
    finalize.set_defaults(handler=finalize_artifact)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except GateError as error:
        print(f"PG_ACTIVE_CURATION_BLOCKED {error}", file=sys.stderr)
        return 78
    except Exception as error:
        print(
            f"PG_ACTIVE_CURATION_ERROR {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
