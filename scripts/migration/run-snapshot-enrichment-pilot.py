#!/usr/bin/env python3
"""Run one frozen sample through the controlled enrichment binding.

This runner has three distinct outcomes:

* 2 (or another non-zero infrastructure code): input, binding, contract, or
  I/O failure.  The wrapper must stop and preserve the partial artifact.
* 78: the program completed and produced a valid non-release artifact with
  field gaps or needs_review records.  The wrapper continues to the next day.
* 0: the program completed without review records; it is still not release
  eligible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
NEEDS_REVIEW_EXIT = 78
PROVIDER_TIMEOUT_SECONDS = 13_200
HELPER_TIMEOUT_SECONDS = 120
PRODUCT_PATHS = [
    "scripts/update-songlist.js#fetchVideoSongList",
    "scripts/youtube-channel-discovery-core.js#enrichDetail",
    "scripts/youtube-channel-discovery-core.js#occurrenceRecordsFromDetail",
]


class RunnerError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RunnerError(f"cannot read JSON {path}: {exc}") from exc


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def sample_values(payload: Any) -> tuple[list[dict[str, Any]], str | None]:
    if isinstance(payload, list):
        values = payload
        trial_route = None
    elif isinstance(payload, dict) and isinstance(payload.get("videos"), list):
        values = payload["videos"]
        trial_route = payload.get("trialRoute")
    else:
        raise RunnerError("sample has no supported video array")
    if not all(isinstance(value, dict) for value in values):
        raise RunnerError("sample contains a non-object video")
    return [dict(value) for value in values], trial_route if isinstance(trial_route, str) else None


def validate_sample(sample_path: Path, catalog_path: Path, sample_id: str) -> tuple[dict[str, Any], list[str]]:
    catalog = read_json(catalog_path.resolve(strict=True))
    entry = catalog.get("samples", {}).get(sample_id) if isinstance(catalog, dict) else None
    if not isinstance(entry, dict):
        raise RunnerError(f"unknown sample id: {sample_id}")
    try:
        raw = sample_path.read_bytes()
    except OSError as exc:
        raise RunnerError(f"cannot read materialized sample: {sample_path}: {exc}") from exc
    actual_sha = hashlib.sha256(raw).hexdigest()
    if actual_sha != entry["sampleSha256"]:
        raise RunnerError(f"sample SHA-256 mismatch: expected {entry['sampleSha256']}, got {actual_sha}")
    if len(raw) != int(entry["sampleBytes"]):
        raise RunnerError(f"sample byte count mismatch: expected {entry['sampleBytes']}, got {len(raw)}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RunnerError(f"materialized sample is not UTF-8 JSON: {exc}") from exc
    values, trial_route = sample_values(payload)
    if len(values) != int(entry["count"]):
        raise RunnerError(f"sample count mismatch: expected {entry['count']}, got {len(values)}")
    ids: list[str] = []
    route_counts: dict[str, int] = {}
    seen: set[str] = set()
    for index, value in enumerate(values):
        video_id = value.get("videoId")
        if not isinstance(video_id, str) or not video_id:
            raise RunnerError(f"sample row {index} has no videoId")
        if video_id in seen:
            raise RunnerError(f"sample contains duplicate videoId: {video_id}")
        seen.add(video_id)
        route = value.get("route")
        if route is None:
            route = trial_route
        if not isinstance(route, str) or not route:
            raise RunnerError(f"sample row {index} has no route")
        route_counts[route] = route_counts.get(route, 0) + 1
        ids.append(video_id)
    expected_route_counts = {str(key): int(value) for key, value in entry["routeCounts"].items()}
    if route_counts != expected_route_counts:
        raise RunnerError(f"route closure mismatch: expected {expected_route_counts}, got {route_counts}")
    signature = ",".join(f"{key}={value}" for key, value in route_counts.items())
    if signature != entry["routeSignature"]:
        raise RunnerError(f"route signature mismatch: expected {entry['routeSignature']}, got {signature}")
    return entry, ids


def resolve_bound_file(path_value: Any, workspace: Path, label: str) -> Path:
    if not isinstance(path_value, str) or not path_value:
        raise RunnerError(f"binding {label} path is not bound")
    candidate = Path(path_value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise RunnerError(f"binding {label} path must be a safe relative path")
    path = (workspace / candidate).resolve()
    if not inside(path, workspace) or path.is_symlink() or not path.is_file():
        raise RunnerError(f"binding {label} is not a regular workspace file: {path}")
    return path


def load_binding(binding_path: Path, workspace: Path, allow_test_provider: bool) -> dict[str, Any]:
    binding = read_json(binding_path.resolve(strict=True))
    if not isinstance(binding, dict):
        raise RunnerError("binding manifest must be an object")
    if allow_test_provider:
        if binding.get("status") != "BOUND_FOR_TEST_ONLY" or binding.get("testOnly") is not True:
            raise RunnerError("test harness requires an explicit BOUND_FOR_TEST_ONLY binding")
        provider_config = binding.get("providerV4") or binding.get("provider")
        adapter_config = binding.get("adapterV4") or binding.get("adapter")
    else:
        if binding.get("status") != "BOUND_V4":
            raise RunnerError(f"provider binding is not BOUND_V4: {binding.get('status')}")
        provider_config = binding.get("providerV4")
        adapter_config = binding.get("adapterV4")
    if not isinstance(provider_config, dict) or not isinstance(adapter_config, dict):
        raise RunnerError("provider and adapter v4 binding entries are required")
    provider_path_value = provider_config.get("path")
    provider_version = provider_config.get("version")
    provider_sha = provider_config.get("sha256")
    adapter_path_value = adapter_config.get("path")
    adapter_version = adapter_config.get("version")
    adapter_sha = adapter_config.get("sha256")
    if not isinstance(provider_version, str) or not provider_version:
        raise RunnerError("provider v4 version is not bound")
    if not isinstance(provider_sha, str) or not HEX64.fullmatch(provider_sha.lower()):
        raise RunnerError("provider v4 SHA-256 is not bound")
    if not isinstance(adapter_version, str) or not adapter_version:
        raise RunnerError("adapter v4 version is not bound")
    if not isinstance(adapter_sha, str) or not HEX64.fullmatch(adapter_sha.lower()):
        raise RunnerError("adapter v4 SHA-256 is not bound")
    provider_path = resolve_bound_file(provider_path_value, workspace, "provider")
    adapter_path = resolve_bound_file(adapter_path_value, workspace, "adapter")
    if not allow_test_provider:
        if provider_path_value != "scripts/migration/snapshot-enrichment-provider.mjs":
            raise RunnerError("provider binding path is outside the fixed product allowlist")
        if adapter_path_value != "scripts/migration/snapshot-enrichment-adapter.py":
            raise RunnerError("adapter binding path is outside the fixed product allowlist")
        if provider_config.get("contract") != "luna-max-mac-enrichment/v4-candidate":
            raise RunnerError("provider v4 contract is not bound")
    expected_provider_sha = provider_sha.lower()
    actual_provider_sha = sha256_file(provider_path)
    if actual_provider_sha != expected_provider_sha:
        raise RunnerError(f"provider SHA-256 mismatch: expected {expected_provider_sha}, got {actual_provider_sha}")
    expected_adapter_sha = adapter_sha.lower()
    actual_adapter_sha = sha256_file(adapter_path)
    if actual_adapter_sha != expected_adapter_sha:
        raise RunnerError(f"adapter SHA-256 mismatch: expected {expected_adapter_sha}, got {actual_adapter_sha}")
    evidence_manifest_path = None
    evidence_manifest_sha = None
    if not allow_test_provider:
        evidence = binding.get("v4EvidenceManifest")
        if not isinstance(evidence, dict):
            raise RunnerError("v4 evidence manifest binding is missing")
        evidence_manifest_path = resolve_bound_file(evidence.get("path"), workspace, "v4 evidence manifest")
        evidence_manifest_sha = str(evidence.get("sha256", "")).lower()
        if not HEX64.fullmatch(evidence_manifest_sha):
            raise RunnerError("v4 evidence manifest SHA-256 is not bound")
        actual_evidence_sha = sha256_file(evidence_manifest_path)
        if actual_evidence_sha != evidence_manifest_sha:
            raise RunnerError(f"v4 evidence manifest SHA-256 mismatch: expected {evidence_manifest_sha}, got {actual_evidence_sha}")
    return {
        "manifest": binding,
        "provider": provider_path,
        "providerPath": provider_path_value,
        "providerVersion": provider_version,
        "providerSha256": expected_provider_sha,
        "providerContract": provider_config.get("contract", "luna-max-mac-enrichment/v4-candidate"),
        "adapter": adapter_path,
        "adapterPath": adapter_path_value,
        "adapterVersion": adapter_version,
        "adapterSha256": expected_adapter_sha,
        "evidenceManifestPath": str(evidence_manifest_path) if evidence_manifest_path else None,
        "evidenceManifestSha256": evidence_manifest_sha,
    }


def check_source_commit(workspace: Path, expected: str, skip: bool) -> str:
    if not HEX40.fullmatch(expected):
        raise RunnerError("source_commit must be exactly 40 lowercase hexadecimal characters")
    if skip:
        return "SKIPPED_TEST_HARNESS"
    try:
        result = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RunnerError(f"cannot verify checked-out source commit: {exc}") from exc
    actual = result.stdout.strip()
    if actual != expected:
        raise RunnerError(f"source commit mismatch: expected {expected}, got {actual}")
    return actual


def command_for_provider(path: Path) -> list[str]:
    if path.suffix == ".py":
        return [sys.executable, str(path)]
    if path.suffix in {".mjs", ".js"}:
        return ["node", str(path)]
    return [str(path)]


def run_process(command: list[str], timeout_seconds: int, process_record: Path) -> int:
    started = time.monotonic()
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        completed = subprocess.CompletedProcess(command, 124, exc.stdout or "", exc.stderr or "")
        timed_out = True
    elapsed = time.monotonic() - started
    process_record.write_text(
        json.dumps(
            {
                "command": command,
                "returnCode": completed.returncode,
                "timedOut": timed_out,
                "elapsedSeconds": round(elapsed, 3),
                "startupTiming": "observed_only",
                "stdoutPreview": str(completed.stdout or "")[:8192],
                "stderrPreview": str(completed.stderr or "")[:8192],
                "previewTruncated": len(str(completed.stdout or "")) > 8192 or len(str(completed.stderr or "")) > 8192,
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return completed.returncode


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise RunnerError(f"cannot read NDJSON {path}: {exc}") from exc
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RunnerError(f"invalid NDJSON at {path}:{line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise RunnerError(f"NDJSON object required at {path}:{line_number}")
        records.append(value)
    return records


def validate_provider_header(
    provider_output: Path,
    entry: dict[str, Any],
    sample_id: str,
    expected_ids: list[str],
    source_commit: str,
    binding: dict[str, Any],
) -> list[dict[str, Any]]:
    values = read_ndjson(provider_output)
    if not values:
        raise RunnerError("provider output is empty")
    header = values[0]
    records = values[1:]
    header_provider = header.get("provider", header.get("providerVersion"))
    if header_provider != binding["providerVersion"]:
        raise RunnerError("provider header version does not match controlled binding")
    if header.get("providerVersion") is not None and header.get("providerVersion") != binding["providerVersion"]:
        raise RunnerError("provider header providerVersion does not match controlled binding")
    if header.get("providerSha256") is not None and header.get("providerSha256") != binding["providerSha256"]:
        raise RunnerError("provider header SHA does not match controlled binding")
    if header.get("contract") != binding["providerContract"]:
        raise RunnerError("provider header contract does not match controlled binding")
    if header.get("sampleId") is not None and header.get("sampleId") != sample_id:
        raise RunnerError("provider header sampleId mismatch")
    if header.get("sampleSha256") != entry["sampleSha256"]:
        raise RunnerError("provider header sample SHA mismatch")
    if header.get("sampleCount") != int(entry["count"]):
        raise RunnerError("provider header sample count mismatch")
    if header.get("expectedIds") != expected_ids:
        raise RunnerError("provider header expectedIds closure mismatch")
    if header.get("recordCount") != len(records) or len(records) != len(expected_ids):
        raise RunnerError("provider record cardinality mismatch")
    product = header.get("product")
    if product is not None:
        if not isinstance(product, dict) or product.get("sourceCommit") != source_commit:
            raise RunnerError("provider product sourceCommit closure mismatch")
        if product.get("paths") != PRODUCT_PATHS:
            raise RunnerError("provider product path closure mismatch")
    if header.get("releaseReady") is not False:
        raise RunnerError("provider releaseReady must be false")
    return records


def valid_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_record_contract(records: list[dict[str, Any]], expected_ids: list[str]) -> dict[str, Any]:
    actual_ids = [record.get("videoId") for record in records]
    if actual_ids != expected_ids or len(set(actual_ids)) != len(actual_ids):
        raise RunnerError("adapter output ID closure mismatch")
    needs_review = 0
    detail_null = 0
    empty_songs = 0
    audit_present = 0
    for index, record in enumerate(records):
        if record.get("status") not in {"ok", "needs_review"}:
            raise RunnerError(f"record[{index}] has invalid status")
        if "audit" not in record:
            raise RunnerError(f"record[{index}] is missing audit; absent is not null")
        if record["audit"] is not None and not isinstance(record["audit"], dict):
            raise RunnerError(f"record[{index}].audit must be an object or null")
        if record["audit"] is not None:
            audit_present += 1
        if record["status"] == "needs_review":
            needs_review += 1
            if not isinstance(record.get("diagnostic"), dict):
                raise RunnerError(f"needs_review record[{index}] has no diagnostic")
        songs = record.get("songs")
        if not isinstance(songs, list):
            raise RunnerError(f"record[{index}].songs must be an array")
        if not songs:
            empty_songs += 1
        if record.get("detailPresent") is False or (record.get("diagnostic") or {}).get("code") == "detail_null":
            detail_null += 1
        if record["status"] == "ok":
            required_top = ("eventTime", "channelId", "channelTitle")
            if any(not valid_nonempty_string(record.get(field)) for field in required_top):
                raise RunnerError(f"status ok record[{index}] has missing required top-level value")
            if not songs:
                raise RunnerError(f"status ok record[{index}] has empty songs")
            for song_index, song in enumerate(songs):
                if not isinstance(song, dict):
                    raise RunnerError(f"status ok record[{index}].songs[{song_index}] is not an object")
                if not valid_nonempty_string(song.get("title")) or not valid_nonempty_string(song.get("artist")):
                    raise RunnerError(f"status ok record[{index}].songs[{song_index}] has invalid title/artist")
                source = song.get("source")
                if not isinstance(source, dict) or not source.get("provenance"):
                    raise RunnerError(f"status ok record[{index}].songs[{song_index}] has empty provenance")
    return {
        "recordCount": len(records),
        "needsReviewCount": needs_review,
        "detailNullCount": detail_null,
        "emptySongsCount": empty_songs,
        "auditPresentCount": audit_present,
    }


def write_not_for_release(path: Path) -> None:
    path.write_text(
        "NOT_FOR_RELEASE\n"
        "Candidate artifact only; no product data, PG, commit, push, dispatch, or activation.\n"
        "detail:null, empty songs, empty provenance, and field gaps are never publishable.\n",
        encoding="utf-8",
    )


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    workspace = Path(args.workspace or os.environ.get("GITHUB_WORKSPACE", Path.cwd())).resolve(strict=True)
    output_root = Path(args.output_root).resolve()
    if not args.allow_test_provider:
        runner_temp = os.environ.get("RUNNER_TEMP")
        if not runner_temp or not inside(output_root, Path(runner_temp)):
            raise RunnerError("production output must be a child of RUNNER_TEMP")
    entry, expected_ids = validate_sample(Path(args.sample).resolve(strict=True), Path(args.catalog), args.sample_id)
    actual_commit = check_source_commit(workspace, args.source_commit, args.skip_git_check)
    binding = load_binding(Path(args.binding_manifest), workspace, args.allow_test_provider)

    artifact = output_root / "artifact"
    artifact.mkdir(parents=True, exist_ok=True)
    raw_input = Path(args.sample).resolve(strict=True)
    shutil.copy2(raw_input, artifact / "raw-input.json")
    input_manifest = output_root / "input-manifest.json"
    if input_manifest.is_file():
        shutil.copy2(input_manifest, artifact / "input-manifest.json")

    provider_output = artifact / "provider.raw.ndjson"
    provider_command = command_for_provider(binding["provider"]) + [
        "--sample", str(raw_input),
        "--expected-sha", entry["sampleSha256"],
        "--expected-count", str(entry["count"]),
        "--source-commit", args.source_commit,
        "--provider-version", binding["providerVersion"],
        "--provider-sha256", binding["providerSha256"],
        "--out", str(provider_output),
    ]
    provider_rc = run_process(provider_command, args.provider_timeout_seconds, artifact / "provider-process.json")
    if provider_rc != 0:
        raise RunnerError(f"provider exited with {provider_rc}")
    provider_records = validate_provider_header(provider_output, entry, args.sample_id, expected_ids, args.source_commit, binding)
    del provider_records

    enriched_output = artifact / "enriched-output.ndjson"
    adapter_command = [
        sys.executable,
        str(binding["adapter"]),
        "--provider", str(provider_output),
        "--out", str(enriched_output),
    ]
    adapter_rc = run_process(adapter_command, args.adapter_timeout_seconds, artifact / "adapter-process.json")
    if adapter_rc != 0:
        raise RunnerError(f"adapter exited with {adapter_rc}")
    records = read_ndjson(enriched_output)
    counts = validate_record_contract(records, expected_ids)
    adapter_report = {
        "reportType": "snapshot-enrichment-adapter-report",
        "schemaVersion": 1,
        "sampleId": args.sample_id,
        "adapterPath": binding["adapterPath"],
        "adapterVersion": binding["adapterVersion"],
        "adapterSha256": binding["adapterSha256"],
        "counts": counts,
        "releaseEligible": False,
        "NOT_FOR_RELEASE": True,
    }
    adapter_report_path = artifact / "adapter-report.json"
    adapter_report_path.write_text(json.dumps(adapter_report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    field_matrix = artifact / "field-matrix.json"
    field_path = Path(args.field_matrix_path) if args.field_matrix_path else Path(__file__).with_name("snapshot-pilot-field-matrix.py")
    field_rc = run_process(
        [sys.executable, str(field_path), "--input", str(enriched_output), "--sample-id", args.sample_id, "--out", str(field_matrix)],
        args.helper_timeout_seconds,
        artifact / "field-matrix-process.json",
    )
    if field_rc != 0:
        raise RunnerError(f"field matrix exited with {field_rc}")

    route_preview = artifact / "event-time-routing-preview.json"
    preview_path = Path(args.event_preview_path) if args.event_preview_path else Path(__file__).with_name("snapshot-pilot-event-preview.py")
    preview_rc = run_process(
        [sys.executable, str(preview_path), "--sample", str(raw_input), "--enriched", str(enriched_output), "--sample-id", args.sample_id, "--sample-date", entry["sampleDate"], "--out", str(route_preview)],
        args.helper_timeout_seconds,
        artifact / "event-preview-process.json",
    )
    if preview_rc != 0:
        raise RunnerError(f"event preview exited with {preview_rc}")

    matrix = read_json(field_matrix)
    input_manifest_data = read_json(input_manifest) if input_manifest.is_file() else {}
    status = "NEEDS_REVIEW" if counts["needsReviewCount"] else "CANDIDATE_COMPLETE"
    files: dict[str, Any] = {}
    for path in sorted(artifact.iterdir()):
        if path.is_file() and path.name not in {"artifact-manifest.json", "NOT_FOR_RELEASE.txt"}:
            files[path.name] = {"path": str(path), "sha256": sha256_file(path), "bytes": path.stat().st_size}
    manifest = {
        "manifestType": "luna-max-snapshot-pilot-artifact",
        "schemaVersion": "luna-max-enrichment/v4-candidate",
        "status": status,
        "releaseEligible": False,
        "activated": False,
        "NOT_FOR_RELEASE": True,
        "sourceCommit": args.source_commit,
        "verifiedCheckoutHead": actual_commit,
        "bindingStatus": binding["manifest"].get("status"),
        "sample": {
            "id": args.sample_id,
            "path": str(raw_input),
            "fixturePath": input_manifest_data.get("fixture", {}).get("path"),
            "sha256": entry["sampleSha256"],
            "count": entry["count"],
            "sampleDate": entry["sampleDate"],
            "routeSignature": entry["routeSignature"],
            "expectedIds": expected_ids,
        },
        "provider": {
            "path": binding["providerPath"],
            "version": binding["providerVersion"],
            "sha256": binding["providerSha256"],
            "contract": binding["providerContract"],
            "wrapper": "{detail,audit}; shape violations batch-fatal",
        },
        "adapter": {
            "path": binding["adapterPath"],
            "version": binding["adapterVersion"],
            "sha256": binding["adapterSha256"],
        },
        "routeSemantics": {
            "trialRouteField": "trialRoute",
            "releaseRouteField": "releaseRoute",
            "releaseRouteStatus": "not_computed",
            "eventTimeRule": "explicit provider/source field only",
        },
        "counts": counts,
        "fieldMatrixSummary": {
            "needsReviewCount": matrix.get("needsReviewCount"),
            "detailNullCount": matrix.get("detailNullCount"),
            "emptySongsCount": matrix.get("emptySongsCount"),
        },
        "artifacts": files,
    }
    (artifact / "artifact-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    write_not_for_release(artifact / "NOT_FOR_RELEASE.txt")
    (output_root / "job-summary.json").write_text(
        json.dumps(
            {
                "status": status,
                "runnerExit": NEEDS_REVIEW_EXIT if status == "NEEDS_REVIEW" else 0,
                "jobExitAfterWrapper": 0,
                "needsReviewCount": counts["needsReviewCount"],
                "releaseEligible": False,
                "NOT_FOR_RELEASE": True,
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return (NEEDS_REVIEW_EXIT if status == "NEEDS_REVIEW" else 0), manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--sample", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--binding-manifest", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--workspace")
    parser.add_argument("--field-matrix-path")
    parser.add_argument("--event-preview-path")
    parser.add_argument("--provider-timeout-seconds", type=int, default=PROVIDER_TIMEOUT_SECONDS)
    parser.add_argument("--adapter-timeout-seconds", type=int, default=HELPER_TIMEOUT_SECONDS)
    parser.add_argument("--helper-timeout-seconds", type=int, default=HELPER_TIMEOUT_SECONDS)
    parser.add_argument("--allow-test-provider", action="store_true")
    parser.add_argument("--skip-git-check", action="store_true")
    args = parser.parse_args(argv)
    try:
        code, manifest = run(args)
    except (RunnerError, OSError, ValueError) as exc:
        print(json.dumps({"status": "program_or_io_error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "status": manifest["status"], "sampleId": args.sample_id, "needsReview": manifest["counts"]["needsReviewCount"]}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
