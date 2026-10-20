#!/usr/bin/env python3
"""Run the fresh two-day provider, source bridge, and existing linkage.

The normal path executes the checked-out Node provider and the checked-out
linkage script.  ``--provider-fixture-root`` exists only for deterministic
orchestration tests; it never reads provider output from the frozen artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REJECT = 78
EXPECTED_ORDER = ("jul29-25", "jul22-19")
EXPECTED = {
    "jul29-25": {
        "linkageSampleId": "jul29-sample25",
        "videoCount": 25,
        "realOccurrences": 90,
        "sentinelOccurrences": 16,
    },
    "jul22-19": {
        "linkageSampleId": "jul22-raw456",
        "videoCount": 19,
        "realOccurrences": 456,
        "sentinelOccurrences": 0,
    },
}
RAW_ROUTE_SAMPLE_ID = "jul22-19"
RAW_ROUTE_LINKAGE_SAMPLE_ID = "jul22-raw456"


class RejectError(ValueError):
    pass


def reject(message: str) -> None:
    raise RejectError(message)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        reject(f"json-read-failed:{path}:{exc}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_route(value: str) -> datetime:
    if not isinstance(value, str) or len(value) != 20 or not value.endswith("Z"):
        reject("route-as-of-must-be-strict-utc-iso")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        reject(f"route-as-of-invalid:{exc}")


def run_command(command: list[str], cwd: Path, log_root: Path, label: str, env: dict[str, str] | None = None) -> None:
    try:
        completed = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, check=False)
    except OSError as exc:
        reject(f"{label}-start-failed:{exc}")
    (log_root / f"{label}.stdout.log").write_text(completed.stdout, encoding="utf-8")
    (log_root / f"{label}.stderr.log").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        reject(f"{label}-failed:exit={completed.returncode}:first={detail[0] if detail else '<no stderr>'}")


def entry_path(explicit: Path | None, source_root: Path, relative: str) -> Path:
    if explicit:
        return explicit.resolve()
    candidate = source_root / relative
    if candidate.is_file():
        return candidate.resolve()
    local = Path(__file__).resolve().parent / Path(relative).name
    if local.is_file():
        return local.resolve()
    reject(f"required-entrypoint-missing:{relative}")


def load_materialized(root: Path, route: str) -> dict[str, Any]:
    manifest = read_json(root / "materialized-manifest.json")
    if not isinstance(manifest, dict):
        reject("materialized-manifest-not-object")
    if manifest.get("status") != "MATERIALIZED_ROUTE_VERIFIED" or manifest.get("releaseEligible") is not False:
        reject("materialized-manifest-release-gate-mismatch")
    if manifest.get("providerInput") is not False:
        reject("provider-output-was-materializer-input")
    if manifest.get("routeAsOfUtc") != route:
        reject("materialized-route-as-of-mismatch")
    if manifest.get("sampleIds") != list(EXPECTED_ORDER):
        reject("materialized-day-order-or-third-day-mismatch")
    if manifest.get("counts", {}).get("jul29VideoCount") != 25 or manifest.get("counts", {}).get("jul22VideoCount") != 19:
        reject("materialized-video-count-mismatch")
    if manifest.get("counts", {}).get("jul22RawSongCount") != 456:
        reject("materialized-jul22-song-count-mismatch")
    return manifest


def sample_input(materialized_root: Path, sample_id: str) -> tuple[Path, dict[str, Any], dict[str, Any], list[str]]:
    base = materialized_root / "input" / sample_id
    raw_path = base / "raw-input" / "sample.json"
    manifest = read_json(base / "input-manifest.json")
    expected_ids = read_json(base / "expected-ids.json")
    if not raw_path.is_file() or not isinstance(manifest, dict) or not isinstance(expected_ids, list):
        reject(f"materialized-input-layout-invalid:{sample_id}")
    if manifest.get("sampleId") != sample_id:
        reject(f"materialized-input-manifest-mismatch:{sample_id}")
    metadata = read_json(base / "metadata.json")
    if not isinstance(metadata, dict) or metadata.get("providerInput") is not False:
        reject(f"materialized-input-metadata-mismatch:{sample_id}")
    return raw_path, manifest, metadata, [item for item in expected_ids if isinstance(item, str)]


def validate_raw_route_input(
    raw_path: Path,
    input_manifest: dict[str, Any],
    metadata: dict[str, Any],
    expected_ids: list[str],
    args: argparse.Namespace,
    cutoff: str,
) -> dict[str, Any]:
    """Validate the authoritative raw all=19/456 spine before bypassing enrichment."""
    if metadata.get("sampleId") != RAW_ROUTE_SAMPLE_ID:
        reject("raw-route-sample-id-mismatch")
    if metadata.get("linkageSampleId") != RAW_ROUTE_LINKAGE_SAMPLE_ID:
        reject("raw-route-linkage-sample-id-mismatch")
    if metadata.get("providerInput") is not False:
        reject("raw-route-provider-input-must-be-false")
    if metadata.get("routeAsOfUtc") != args.route_as_of_utc:
        reject("raw-route-metadata-route-as-of-mismatch")
    if metadata.get("releaseCutoffUtc") != cutoff:
        reject("raw-route-metadata-cutoff-mismatch")

    raw = read_json(raw_path)
    if not isinstance(raw, dict) or raw.get("trialRoute") != "all":
        reject("raw-route-input-not-all-object")
    videos = raw.get("videos")
    if not isinstance(videos, list) or len(videos) != EXPECTED[RAW_ROUTE_SAMPLE_ID]["videoCount"]:
        reject("raw-route-video-count-mismatch")
    if raw.get("videoCount") != len(videos) or raw.get("occurrenceCount") != EXPECTED[RAW_ROUTE_SAMPLE_ID]["realOccurrences"]:
        reject("raw-route-top-level-count-mismatch")
    actual_ids: list[str] = []
    occurrence_ids: set[str] = set()
    occurrence_count = 0
    for video in videos:
        if not isinstance(video, dict) or not isinstance(video.get("videoId"), str):
            reject("raw-route-video-shape-invalid")
        video_id = video["videoId"]
        actual_ids.append(video_id)
        occurrences = video.get("occurrences")
        if not isinstance(occurrences, list) or video.get("occurrenceCount") != len(occurrences):
            reject(f"raw-route-occurrence-list-invalid:{video_id}")
        for occurrence in occurrences:
            if not isinstance(occurrence, dict):
                reject(f"raw-route-occurrence-shape-invalid:{video_id}")
            occurrence_id = occurrence.get("occurrenceId")
            if not isinstance(occurrence_id, str) or not occurrence_id:
                reject(f"raw-route-occurrence-id-invalid:{video_id}")
            if occurrence_id in occurrence_ids:
                reject(f"raw-route-duplicate-occurrence:{occurrence_id}")
            occurrence_ids.add(occurrence_id)
            if occurrence.get("videoId") != video_id:
                reject(f"raw-route-occurrence-video-mismatch:{occurrence_id}")
            occurrence_count += 1
    if actual_ids != expected_ids or len(set(actual_ids)) != len(actual_ids):
        reject("raw-route-video-id-spine-mismatch")
    if occurrence_count != EXPECTED[RAW_ROUTE_SAMPLE_ID]["realOccurrences"] or len(occurrence_ids) != occurrence_count:
        reject("raw-route-occurrence-count-or-spine-mismatch")
    raw_meta = input_manifest.get("rawInput")
    if not isinstance(raw_meta, dict) or raw_meta.get("count") != len(videos) or raw_meta.get("sha256") != sha256_file(raw_path):
        reject("raw-route-input-manifest-hash-or-count-mismatch")
    return {
        "status": "READY_FOR_PHASE2_ALL",
        "sampleId": RAW_ROUTE_SAMPLE_ID,
        "linkageSampleId": RAW_ROUTE_LINKAGE_SAMPLE_ID,
        "providerInput": False,
        "linkageSkipped": True,
        "providerSkipped": True,
        "bridgeSkipped": True,
        "videoCount": len(videos),
        "realOccurrenceCount": occurrence_count,
        "occurrenceIdCount": len(occurrence_ids),
        "inputSha256": sha256_file(raw_path),
        "inputBytes": raw_path.stat().st_size,
        "routeAsOfUtc": args.route_as_of_utc,
        "releaseCutoffUtc": cutoff,
        "sourceCommit": args.source_commit,
    }


def run_raw_route(
    args: argparse.Namespace,
    output: Path,
    raw_path: Path,
    input_manifest: dict[str, Any],
    metadata: dict[str, Any],
    expected_ids: list[str],
    cutoff: str,
) -> dict[str, Any]:
    raw_evidence = validate_raw_route_input(raw_path, input_manifest, metadata, expected_ids, args, cutoff)
    input_root = args.materialized_root / "input" / RAW_ROUTE_SAMPLE_ID
    (output / "raw-input").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(raw_path, output / "raw-input" / "sample.json")
    shutil.copyfile(input_root / "input-manifest.json", output / "input-manifest.json")
    shutil.copyfile(input_root / "expected-ids.json", output / "expected-ids.json")
    shutil.copyfile(input_root / "metadata.json", output / "metadata.json")
    raw_evidence["copiedRawInputSha256"] = sha256_file(output / "raw-input" / "sample.json")
    if raw_evidence["copiedRawInputSha256"] != raw_evidence["inputSha256"]:
        reject("raw-route-copied-input-hash-mismatch")
    write_json(output / "raw-route-report.json", raw_evidence)
    write_json(output / "closure-report.json", {
        "schemaVersion": "two-day-raw-route/v1",
        **raw_evidence,
    })
    return raw_evidence


def provider_fixture_paths(root: Path, sample_id: str) -> tuple[Path, Path, Path]:
    directory = root / sample_id
    provider = directory / "provider.ndjson"
    capture = directory / "source-capture.ndjson"
    if not provider.is_file() or not capture.is_file():
        reject(f"provider-fixture-layout-invalid:{sample_id}")
    return provider, capture, directory


def flatten_index(index: dict[str, Any]) -> list[dict[str, Any]]:
    rows = index.get("occurrences")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        reject("source-index-occurrences-invalid")
    return [dict(row) for row in rows]


def validate_linkage_reports(linkage_root: Path, route: str, cutoff: str) -> dict[str, Any]:
    reports: dict[str, Any] = {}
    for name in ("occurrence-closure.json", "artist-binding-report.json", "release-route-report.json"):
        path = linkage_root / name
        value = read_json(path)
        if not isinstance(value, dict) or value.get("status") != "CLOSED":
            reject(f"linkage-report-not-closed:{name}")
        if name == "release-route-report.json":
            if value.get("routeAsOfUtc") != route or value.get("releaseCutoffUtc") != cutoff:
                reject("linkage-route-metadata-mismatch")
        reports[name] = {"sha256": sha256_file(path), "status": value.get("status")}
    linked = linkage_root / "linked-output.ndjson"
    if not linked.is_file():
        reject("linkage-output-missing")
    reports["linked-output.ndjson"] = {"sha256": sha256_file(linked)}
    return reports


def run_one(args: argparse.Namespace, materialized: dict[str, Any], sample_id: str, output: Path, cutoff: str) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    spec = EXPECTED[sample_id]
    raw_path, input_manifest, metadata, expected_ids = sample_input(args.materialized_root, sample_id)
    if len(expected_ids) != spec["videoCount"]:
        reject(f"expected-id-count-mismatch:{sample_id}")
    raw_meta = input_manifest.get("rawInput")
    if not isinstance(raw_meta, dict) or raw_meta.get("count") != spec["videoCount"]:
        reject(f"raw-manifest-count-mismatch:{sample_id}")
    if (
        sample_id == RAW_ROUTE_SAMPLE_ID
        and metadata.get("providerInput") is False
        and metadata.get("linkageSampleId") == RAW_ROUTE_LINKAGE_SAMPLE_ID
        and not args.force_provider_for_raw_route
    ):
        return run_raw_route(args, output, raw_path, input_manifest, metadata, expected_ids, cutoff)
    provider_path = output / "provider.ndjson"
    capture_path = output / "source-capture.ndjson"
    provider_source_root = args.source_root
    if args.provider_fixture_root:
        fixture_provider, fixture_capture, fixture_root = provider_fixture_paths(args.provider_fixture_root.resolve(), sample_id)
        shutil.copyfile(fixture_provider, provider_path)
        shutil.copyfile(fixture_capture, capture_path)
        provider_source_root = fixture_root
    else:
        provider_command = [
            "node",
            str(args.provider_script),
            "--sample",
            str(raw_path),
            "--expected-sha",
            str(raw_meta.get("sha256")),
            "--expected-count",
            str(spec["videoCount"]),
            "--out",
            str(provider_path),
            "--repo-root",
            str(args.source_root),
        ]
        run_command(
            provider_command,
            args.source_root,
            output,
            "provider",
            env={**os.environ, "ROUTE_AS_OF_UTC": args.route_as_of_utc, "RELEASE_CUTOFF_UTC": cutoff},
        )
        # The provider's fresh output is the only capture input accepted here;
        # the bridge still requires local source bytes and will reject URLs.
        shutil.copyfile(provider_path, capture_path)

    bridge_output = output / "source-index.json"
    run_command(
        [
            sys.executable,
            str(args.bridge_script),
            "--provider-output",
            str(provider_path),
            "--source-capture",
            str(capture_path),
            "--source-root",
            str(provider_source_root),
            "--expected-ids",
            str(args.materialized_root / "input" / sample_id / "expected-ids.json"),
            "--expected-video-count",
            str(spec["videoCount"]),
            "--expected-real-occurrences",
            str(spec["realOccurrences"]),
            "--expected-sentinel-occurrences",
            str(spec["sentinelOccurrences"]),
            "--route-as-of-utc",
            args.route_as_of_utc,
            "--output",
            str(bridge_output),
        ],
        args.source_root,
        output,
        "bridge",
    )
    index = read_json(bridge_output)
    if not isinstance(index, dict) or index.get("status") != "CLOSED":
        reject(f"source-index-not-closed:{sample_id}")
    if (index.get("videoCount"), index.get("realOccurrenceCount"), index.get("sentinelOccurrenceCount")) != (
        spec["videoCount"], spec["realOccurrences"], spec["sentinelOccurrences"]
    ):
        reject(f"source-index-count-mismatch:{sample_id}")
    rows = flatten_index(index)
    raw_for_linkage = output / "linkage-raw.json"
    write_json(
        raw_for_linkage,
        {
            "rows": rows,
            "sampleId": sample_id,
            "routeAsOf": args.route_as_of_utc,
            "routeAsOfUtc": args.route_as_of_utc,
            "releaseCutoffUtc": cutoff,
        },
    )
    provider_for_linkage = output / "linkage-provider.ndjson"
    provider_for_linkage.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
    if sample_id == "jul29-25":
        if args.artist_bindings is None or not args.artist_bindings.is_file():
            reject("jul29-artist-binding-missing")
        artist_bindings = args.artist_bindings
    else:
        artist_bindings = output / "empty-artist-bindings.json"
        write_json(artist_bindings, {"bindings": []})
    linkage_root = output / "linkage"
    run_command(
        [
            sys.executable,
            str(args.linkage_script),
            "--raw-input",
            str(raw_for_linkage),
            "--provider-ndjson",
            str(provider_for_linkage),
            "--artist-bindings",
            str(artist_bindings),
            "--release-cutoff-utc",
            cutoff,
            "--sample-id",
            spec["linkageSampleId"],
            "--output-dir",
            str(linkage_root),
        ],
        args.source_root,
        output,
        "linkage",
    )
    reports = validate_linkage_reports(linkage_root, args.route_as_of_utc, cutoff)
    closure = {
        "schemaVersion": "two-day-source-closure/v1",
        "status": "CLOSED",
        "sampleId": sample_id,
        "providerOutputSha256": sha256_file(provider_path),
        "sourceIndexSha256": sha256_file(bridge_output),
        "videoCount": index["videoCount"],
        "realOccurrenceCount": index["realOccurrenceCount"],
        "sentinelOccurrenceCount": index["sentinelOccurrenceCount"],
        "routeAsOfUtc": args.route_as_of_utc,
        "releaseCutoffUtc": cutoff,
        "providerInput": False,
    }
    write_json(output / "closure-report.json", closure)
    return {"sampleId": sample_id, **closure, "linkageReports": reports}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--materialized-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--route-as-of-utc", required=True)
    parser.add_argument("--source-commit", required=False, default=None)
    parser.add_argument("--provider-script", type=Path)
    parser.add_argument("--bridge-script", type=Path)
    parser.add_argument("--linkage-script", type=Path)
    parser.add_argument("--artist-bindings", type=Path)
    parser.add_argument("--provider-fixture-root", type=Path)
    parser.add_argument(
        "--sample-id",
        dest="sample_ids",
        action="append",
        choices=EXPECTED_ORDER,
        help="Run only the selected materialized package; repeat to preserve an explicit order.",
    )
    parser.add_argument(
        "--force-provider-for-raw-route",
        action="store_true",
        help="Run the repository provider for jul22-19 instead of the legacy raw-route bypass.",
    )
    args = parser.parse_args(argv)
    output = args.output_root.resolve()
    if output.exists() and any(output.iterdir()):
        print(f"REJECT: output-root-must-be-empty:{output}", file=sys.stderr)
        return REJECT
    output.mkdir(parents=True, exist_ok=True)
    try:
        parse_route(args.route_as_of_utc)
        args.source_root = args.source_root.resolve()
        args.materialized_root = args.materialized_root.resolve()
        args.provider_script = entry_path(args.provider_script, args.source_root, "scripts/migration/snapshot-enrichment-provider.mjs")
        args.bridge_script = entry_path(args.bridge_script, args.source_root, "scripts/migration/provider-output-to-source-index.py")
        args.linkage_script = entry_path(args.linkage_script, args.source_root, "scripts/migration/snapshot-pilot-linkage.py")
        materialized = load_materialized(args.materialized_root, args.route_as_of_utc)
        cutoff = materialized.get("releaseCutoffUtc")
        if not isinstance(cutoff, str):
            reject("materialized-cutoff-missing")
        route = parse_route(args.route_as_of_utc)
        from datetime import timedelta

        expected_cutoff = route - timedelta(days=7)
        if cutoff != expected_cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"):
            reject("materialized-cutoff-mismatch")
        selected_samples = tuple(args.sample_ids or EXPECTED_ORDER)
        if len(set(selected_samples)) != len(selected_samples):
            reject("duplicate-selected-sample")
        results = []
        for sample_id in selected_samples:
            results.append(run_one(args, materialized, sample_id, output / sample_id, cutoff))
        summary = {
            "schemaVersion": "two-day-selfcontained-rerun/v2",
            "status": "READY_SELFCONTAINED_RERUN_CANDIDATE_ONLY",
            "NOT_FOR_RELEASE": True,
            "releaseEligible": False,
            "activation": False,
            "pg": False,
            "sourceCommit": args.source_commit,
            "routeAsOfUtc": args.route_as_of_utc,
            "releaseCutoffUtc": cutoff,
            "sequence": list(selected_samples),
            "samples": results,
            "providerInput": False,
            "rawRouteProviderMode": "provider" if args.force_provider_for_raw_route else "legacy-bypass",
            "externalPrerequisite": "formal Mac provider run must produce local source raw sidecars; provider URLs are rejected",
        }
        write_json(output / "pilot-summary.json", summary)
        (output / "NOT_FOR_RELEASE.txt").write_text("READY_SELFCONTAINED_RERUN_CANDIDATE_ONLY\n", encoding="utf-8")
        print("READY_SELFCONTAINED_RERUN_CANDIDATE_ONLY " + json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except RejectError as exc:
        manifest = {
            "schemaVersion": "two-day-selfcontained-rerun/v2",
            "status": "REJECT",
            "NOT_FOR_RELEASE": True,
            "releaseEligible": False,
            "activation": False,
            "pg": False,
            "routeAsOfUtc": args.route_as_of_utc,
            "sourceCommit": args.source_commit,
            "firstError": str(exc),
            "externalPrerequisite": "formal Mac provider run must produce local source raw sidecars",
        }
        write_json(output / "candidate-manifest.json", manifest)
        print(f"REJECT: {exc}", file=sys.stderr)
        return REJECT


if __name__ == "__main__":
    raise SystemExit(main())
