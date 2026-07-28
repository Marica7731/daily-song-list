#!/usr/bin/env python3
"""Convert audited curation overrides into occurrence-scoped PG overlay rows.

The curation rules identify source evidence (often a comment ``sourceId``),
while the PostgreSQL runtime uses its own immutable ``occurrence_id`` as the
overlay key.  This converter joins the two using a bounded snapshot of the
currently active rows.  It never guesses across videos or duplicate timecodes:
ambiguous and unmatched rules are written to the review audit and make the
manifest non-ready.

Input snapshot is NDJSON.  Occurrence lines contain the flattened runtime
fields; optional ``kind=video`` lines prove that a whole-video tombstone is
already absent or can be applied.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import unicodedata
from typing import Any, Iterable


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def norm(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise ValueError("curation rules must be an object with a records list")
    alias_rules = payload.get("artistScopedAliases", [])
    safety_assertions = payload.get("safetyAssertions", [])
    if not isinstance(alias_rules, list):
        raise ValueError("artistScopedAliases must be a list")
    if not isinstance(safety_assertions, list):
        raise ValueError("safetyAssertions must be a list")
    return payload


def read_snapshot(path: Path) -> tuple[dict[str, list[dict[str, Any]]], set[str], str]:
    by_video: dict[str, list[dict[str, Any]]] = {}
    video_ids: set[str] = set()
    digest = hashlib.sha256()
    stream = sys.stdin.buffer if str(path) == "-" else path.open("rb")
    try:
        for raw in stream:
            if not raw.strip():
                continue
            digest.update(raw)
            item = json.loads(raw)
            if not isinstance(item, dict):
                raise ValueError("snapshot line must be an object")
            kind = text(item.get("kind"))
            video_id = text(first(item, "videoId", "video_id"))
            if not video_id:
                raise ValueError("snapshot row missing videoId")
            video_ids.add(video_id)
            if kind in {"video", "videos"}:
                continue
            occurrence_id = text(first(item, "occurrenceId", "occurrence_id"))
            if not occurrence_id:
                raise ValueError(f"snapshot occurrence missing occurrenceId: {video_id}")
            row = dict(item)
            row["videoId"] = video_id
            row["occurrenceId"] = occurrence_id
            by_video.setdefault(video_id, []).append(row)
    finally:
        if stream is not sys.stdin.buffer:
            stream.close()
    for rows in by_video.values():
        rows.sort(key=lambda row: (int(row.get("position") or 0), text(row["occurrenceId"])))
    return by_video, video_ids, digest.hexdigest()


def candidate_rows(override: dict[str, Any], rows: Iterable[dict[str, Any]], action: str) -> list[dict[str, Any]]:
    seconds = override.get("seconds")
    candidates = [row for row in rows if row.get("seconds") == seconds]

    expected_raw = text(override.get("rawHash"))
    with_raw = [row for row in candidates if text(row.get("rawHash"))]
    if expected_raw and with_raw:
        candidates = [row for row in candidates if text(row.get("rawHash")) == expected_raw]

    expected_source_hash = text(override.get("sourceHash"))
    with_source_hash = [row for row in candidates if text(row.get("sourceHash"))]
    if expected_source_hash and with_source_hash:
        candidates = [row for row in candidates if text(row.get("sourceHash")) == expected_source_hash]

    expected_source = text(override.get("sourceId"))
    with_source = [row for row in candidates if text(row.get("sourceId"))]
    if expected_source and with_source:
        source_matches = [row for row in candidates if text(row.get("sourceId")) == expected_source]
        if source_matches:
            candidates = source_matches

    # drop_entry carries the original title and artist.  replace_entry does
    # not always carry them, so it must remain unique after the identity pass.
    if action == "drop_entry":
        if "title" in override:
            candidates = [row for row in candidates if norm(row.get("title")) == norm(override.get("title"))]
        if "artist" in override:
            candidates = [row for row in candidates if norm(row.get("artist")) == norm(override.get("artist"))]
    return candidates


def audit_result(index: int, override: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
    result = {
        "index": index,
        "ruleId": override.get("ruleId"),
        "action": text(override.get("action")),
        "videoId": text(override.get("videoId")),
        "sourceId": override.get("sourceId"),
        "seconds": override.get("seconds"),
        "status": status,
        "reason": text(override.get("reason")),
        "reviewedAt": override.get("reviewedAt"),
        "reviewedBy": override.get("reviewedBy"),
    }
    result.update(extra)
    return result


def original_identity(current: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "videoId",
        "occurrenceId",
        "position",
        "seconds",
        "title",
        "artist",
        "sourceId",
        "sourceHash",
        "rawHash",
        "sourceSystem",
        "rangeId",
        "channelHandle",
    )
    return {key: current.get(key) for key in keys if key in current}


def curation_provenance(override: dict[str, Any], current: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    evidence = override.get("evidenceUrls", override.get("evidence", []))
    if isinstance(evidence, str):
        evidence = [evidence]
    return {
        "ruleId": override.get("ruleId"),
        "batchTag": override.get("batchTag", context.get("batchTag")),
        "rulesManifestKind": context.get("kind"),
        "rulesSourceCommit": context.get("sourceCommit"),
        "reason": text(override.get("reason")),
        "reviewedAt": override.get("reviewedAt"),
        "reviewedBy": override.get("reviewedBy"),
        "evidenceUrls": evidence if isinstance(evidence, list) else [],
        "sourceId": current.get("sourceId", override.get("sourceId")),
        "sourceHash": current.get("sourceHash", override.get("sourceHash")),
        "rawHash": current.get("rawHash", override.get("rawHash")),
    }


def runtime_row(
    override: dict[str, Any],
    current: dict[str, Any],
    tombstone: bool,
    replacement: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    occurrence_id = text(current["occurrenceId"])
    context = context or {}
    payload = dict(current)
    payload.pop("kind", None)
    identity = original_identity(current)
    if replacement:
        payload.update(replacement)
    payload.update({
        "videoId": text(current["videoId"]),
        "occurrenceId": occurrence_id,
        "originalIdentity": identity,
        "curationAction": text(override.get("action")),
        "curationReason": text(override.get("reason")),
        "curationProvenance": curation_provenance(override, current, context),
        "reviewedAt": override.get("reviewedAt"),
        "reviewedBy": override.get("reviewedBy"),
        "note": text(override.get("note")),
    })
    return {
        "kind": "runtime",
        "entityType": "occurrences",
        "entityKey": occurrence_id,
        "sourceSystem": current.get("sourceSystem"),
        "rangeId": current.get("rangeId"),
        "sourceId": current.get("sourceId"),
        "sourceHash": current.get("sourceHash"),
        "rawHash": current.get("rawHash"),
        "occurrenceId": occurrence_id,
        "tombstone": tombstone,
        "payload": payload,
    }


def video_tombstone(override: dict[str, Any]) -> dict[str, Any]:
    video_id = text(override.get("videoId"))
    return {
        "kind": "runtime",
        "entityType": "videos",
        "entityKey": video_id,
        "tombstone": True,
        "payload": {
            "videoId": video_id,
            "curationAction": "drop_video",
            "curationReason": text(override.get("reason")),
            "reviewedAt": override.get("reviewedAt"),
            "reviewedBy": override.get("reviewedBy"),
            "note": text(override.get("note")),
        },
    }


def alias_candidates(rule: dict[str, Any], by_video: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    artist = norm(rule.get("artist"))
    canonical_title = norm(rule.get("canonicalTitle"))
    aliases = rule.get("aliases")
    if not artist or not canonical_title or not isinstance(aliases, list) or not aliases:
        raise ValueError("artist-scoped alias requires artist, canonicalTitle, and aliases")
    alias_titles = {norm(value) for value in aliases if norm(value)}
    candidates: list[dict[str, Any]] = []
    for rows in by_video.values():
        for row in rows:
            if norm(row.get("artist")) != artist or norm(row.get("title")) not in alias_titles:
                continue
            if norm(row.get("title")) == canonical_title:
                continue
            candidates.append(row)
    return sorted(candidates, key=lambda row: (text(row.get("videoId")), int(row.get("position") or 0), text(row.get("occurrenceId"))))


def scope_matches(assertion: dict[str, Any], row: dict[str, Any]) -> bool:
    exact = assertion.get("equals", {})
    prefixes = assertion.get("startsWith", {})
    if not isinstance(exact, dict) or not isinstance(prefixes, dict):
        raise ValueError("safety assertion equals/startsWith must be objects")
    return (
        all(norm(row.get(key)) == norm(value) for key, value in exact.items())
        and all(norm(row.get(key)).startswith(norm(value)) for key, value in prefixes.items())
    )


def expected_count(rule: dict[str, Any], field: str) -> int | None:
    value = rule.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def convert(rules_path: Path, snapshot_path: Path, output_path: Path, manifest_path: Path, review_path: Path) -> dict[str, Any]:
    rules_raw = rules_path.read_bytes()
    rules = read_json(rules_path)
    by_video, video_ids, snapshot_sha = read_snapshot(snapshot_path)
    snapshot_rows = [row for rows in by_video.values() for row in rows]
    generated_at = datetime.now(timezone.utc).isoformat()
    audit: list[dict[str, Any]] = []
    mutations: list[dict[str, Any]] = []
    context = {
        "kind": rules.get("kind"),
        "sourceCommit": rules.get("sourceCommit"),
        "batchTag": rules.get("batchTag"),
    }
    selector_mutations = 0
    alias_mutations = 0

    for index, raw_override in enumerate(rules["records"]):
        if not isinstance(raw_override, dict):
            audit.append({"index": index, "status": "invalid", "error": "override is not an object"})
            continue
        action = text(raw_override.get("action"))
        video_id = text(raw_override.get("videoId"))
        rows = by_video.get(video_id, [])
        if action == "drop_video":
            if video_id not in video_ids:
                audit.append(audit_result(index, raw_override, "already_applied_absent", evidence="active snapshot has no video"))
            else:
                mutations.append(video_tombstone(raw_override))
                audit.append(audit_result(index, raw_override, "accepted", evidence="active video present"))
            continue
        if action not in {"drop_entry", "replace_entry"}:
            audit.append(audit_result(index, raw_override, "invalid", error=f"unsupported action: {action}"))
            continue
        replacement = raw_override.get("replacement")
        if action == "replace_entry" and (
            not isinstance(replacement, dict)
            or not text(replacement.get("title")) and not text(replacement.get("artist"))
        ):
            audit.append(audit_result(index, raw_override, "invalid", error="replace_entry requires replacement.title or replacement.artist"))
            continue
        candidates = candidate_rows(raw_override, rows, action)
        same_seconds = [row for row in rows if row.get("seconds") == raw_override.get("seconds")]
        if not candidates and not same_seconds:
            # The exact video/time entry has disappeared from the active snapshot.
            # This is a safe no-op; provenance mismatches at an existing time stay
            # fail-closed below.
            audit.append(audit_result(index, raw_override, "already_applied_absent", evidence="active snapshot has no occurrence at audited video/time"))
            continue
        expected = expected_count(raw_override, "expectedMatchCount")
        if expected is not None and len(candidates) != expected:
            audit.append(audit_result(index, raw_override, "count_mismatch", matchCount=len(candidates), expectedMatchCount=expected))
            continue
        if len(candidates) == 0:
            # The desired post-curation state is already true when the exact
            # audited video/time row is absent from the active snapshot.  Keep
            # this explicit in the audit rather than silently dropping it.
            audit.append(audit_result(index, raw_override, "already_applied_absent", evidence="active snapshot has no occurrence at audited video/time"))
            continue
        if action == "replace_entry" and isinstance(replacement, dict):
            expected_title = norm(replacement.get("title"))
            expected_artist = norm(replacement.get("artist"))
            already = [
                row for row in candidates
                if (not expected_title or norm(row.get("title")) == expected_title)
                and (not expected_artist or norm(row.get("artist")) == expected_artist)
            ]
            if len(already) == 1:
                audit.append(audit_result(index, raw_override, "already_applied", occurrenceId=already[0]["occurrenceId"], evidence="active occurrence already equals replacement"))
                continue
        if len(candidates) > 1:
            audit.append(audit_result(index, raw_override, "ambiguous", occurrenceIds=[row["occurrenceId"] for row in candidates]))
            continue
        current = candidates[0]
        if action == "drop_entry":
            mutations.append(runtime_row(raw_override, current, True, context=context))
            selector_mutations += 1
            audit.append(audit_result(index, raw_override, "accepted", matchCount=1, occurrenceId=current["occurrenceId"], evidence="exact audited identity match"))
            continue
        expected_title = norm(replacement.get("title"))
        expected_artist = norm(replacement.get("artist"))
        if (not expected_title or norm(current.get("title")) == expected_title) and (not expected_artist or norm(current.get("artist")) == expected_artist):
            audit.append(audit_result(index, raw_override, "already_applied", occurrenceId=current["occurrenceId"], evidence="active occurrence already equals replacement"))
            continue
        mutations.append(runtime_row(raw_override, current, False, replacement, context))
        selector_mutations += 1
        audit.append(audit_result(index, raw_override, "accepted", occurrenceId=current["occurrenceId"], evidence="video+seconds unique match"))

    for index, raw_rule in enumerate(rules.get("artistScopedAliases", [])):
        if not isinstance(raw_rule, dict):
            audit.append({"index": index, "kind": "artist_scoped_alias", "status": "invalid", "error": "alias rule is not an object"})
            continue
        try:
            candidates = alias_candidates(raw_rule, by_video)
            expected = expected_count(raw_rule, "expectedMatchCount")
        except ValueError as exc:
            audit.append({"index": index, "kind": "artist_scoped_alias", "ruleId": raw_rule.get("ruleId"), "status": "invalid", "error": str(exc)})
            continue
        if expected is not None and len(candidates) != expected:
            audit.append({
                "index": index,
                "kind": "artist_scoped_alias",
                "ruleId": raw_rule.get("ruleId"),
                "artist": raw_rule.get("artist"),
                "canonicalTitle": raw_rule.get("canonicalTitle"),
                "status": "alias_count_mismatch",
                "matchCount": len(candidates),
                "expectedMatchCount": expected,
                "occurrenceIds": [row["occurrenceId"] for row in candidates],
            })
            continue
        replacement = {"title": text(raw_rule.get("canonicalTitle")), "artist": text(raw_rule.get("artist"))}
        for current in candidates:
            override = {
                **raw_rule,
                "action": "replace_entry",
                "videoId": current.get("videoId"),
                "seconds": current.get("seconds"),
                "sourceId": current.get("sourceId"),
                "sourceHash": current.get("sourceHash"),
                "rawHash": current.get("rawHash"),
                "replacement": replacement,
            }
            mutations.append(runtime_row(override, current, False, replacement, context))
            alias_mutations += 1
        audit.append({
            "index": index,
            "kind": "artist_scoped_alias",
            "ruleId": raw_rule.get("ruleId"),
            "artist": raw_rule.get("artist"),
            "canonicalTitle": raw_rule.get("canonicalTitle"),
            "status": "accepted",
            "matchCount": len(candidates),
            "expectedMatchCount": expected,
            "occurrenceIds": [row["occurrenceId"] for row in candidates],
            "reason": text(raw_rule.get("reason")),
        })

    mutated_identities = [
        mutation.get("payload", {}).get("originalIdentity", {})
        for mutation in mutations
        if isinstance(mutation.get("payload"), dict)
    ]
    for index, assertion in enumerate(rules.get("safetyAssertions", [])):
        if not isinstance(assertion, dict):
            audit.append({"index": index, "kind": "safety_assertion", "status": "invalid", "error": "assertion is not an object"})
            continue
        try:
            expected = expected_count(assertion, "expectedMutationCount")
            scope_count = sum(1 for row in snapshot_rows if scope_matches(assertion, row))
            mutation_count = sum(1 for row in mutated_identities if scope_matches(assertion, row))
        except ValueError as exc:
            audit.append({"index": index, "kind": "safety_assertion", "assertionId": assertion.get("assertionId"), "status": "invalid", "error": str(exc)})
            continue
        status = "accepted" if expected is None or mutation_count == expected else "safety_violation"
        audit.append({
            "index": index,
            "kind": "safety_assertion",
            "assertionId": assertion.get("assertionId"),
            "status": status,
            "scopeRowCount": scope_count,
            "mutationCount": mutation_count,
            "expectedMutationCount": expected,
            "auditedLegacyRuleCount": assertion.get("auditedLegacyRuleCount"),
        })

    counts: dict[str, int] = {}
    for item in audit:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    review = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "summary": counts,
        "results": audit,
    }
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as stream:
        for mutation in mutations:
            stream.write(json.dumps(mutation, ensure_ascii=False, separators=(",", ":")) + "\n")
    manifest = {
        "schemaVersion": 1,
        "kind": "curation-accepted-increment",
        "status": "ready" if not any(counts.get(key, 0) for key in (
            "unmatched",
            "ambiguous",
            "invalid",
            "count_mismatch",
            "alias_count_mismatch",
            "safety_violation",
        )) else "needs_review",
        "generatedAt": generated_at,
        "rangeId": "all",
        "sourceReachedEnd": True,
        "mediaDownloaded": False,
        "statusAuditIncluded": True,
        "curationArtifactIncluded": True,
        "curationMutationCount": len(mutations),
        "selectorMutationCount": selector_mutations,
        "aliasMutationCount": alias_mutations,
        "overrideCount": len(rules["records"]),
        "artistScopedAliasRuleCount": len(rules.get("artistScopedAliases", [])),
        "safetyAssertionCount": len(rules.get("safetyAssertions", [])),
        "reviewAudit": counts,
        "overridesSha256": sha256_bytes(rules_raw),
        "rulesManifestSha256": sha256_bytes(rules_raw),
        "snapshotSha256": snapshot_sha,
        "reviewSha256": sha256_bytes(review_path.read_bytes()),
        "sourceManifestSha256": sha256_bytes((sha256_bytes(rules_raw) + snapshot_sha).encode("ascii")),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    rules_input = parser.add_mutually_exclusive_group(required=True)
    rules_input.add_argument("--overrides", type=Path, help="Legacy curation overrides JSON")
    rules_input.add_argument("--rules-manifest", type=Path, help="Curation rules manifest with exact selectors and artist-scoped aliases")
    parser.add_argument("--snapshot", type=Path, required=True, help="NDJSON active occurrence/video snapshot, or - for stdin")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-output", type=Path, required=True)
    parser.add_argument("--review-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        rules_path = args.rules_manifest or args.overrides
        manifest = convert(rules_path, args.snapshot, args.output, args.manifest_output, args.review_output)
        print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False))
        return 0 if manifest["status"] == "ready" else 78
    except Exception as exc:
        print(f"CURATION_PATCH_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
