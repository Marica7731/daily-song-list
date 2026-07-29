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


def derived_song_key(title: Any, artist: Any) -> str:
    return hashlib.sha256(f"song\0{norm(title)}\0{norm(artist)}".encode("utf-8")).hexdigest()[:24]


def public_song_group_key(title: Any, artist: Any) -> str:
    return f"{norm(title)}::{norm(artist)}"


def production_source_detail_key(range_id: str, prefix: str, group_key: str) -> str:
    """Byte-for-byte request key used by export-runtime-rankings.js."""

    return hashlib.sha256(
        f"{range_id}:{prefix}:all:{group_key}".encode("utf-8")
    ).hexdigest()[:16]


IDENTITY_FIELDS = (
    "rangeId",
    "videoId",
    "occurrenceId",
    "seconds",
    "sourceId",
    "storedRangeId",
    "originalGroupKey",
    "originalSourceDetailKey",
    "replacementGroupKey",
    "replacementSourceDetailKey",
    "originalTitle",
    "originalArtist",
    "replacementTitle",
    "replacementArtist",
)


def canonical_json_bytes(value: Any) -> bytes:
    """Match ``jq -cS``: sorted keys, compact JSON, UTF-8, trailing newline."""

    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def identity_sort_key(identity: dict[str, Any]) -> tuple[Any, ...]:
    return (
        {"all": 0, "7d": 1}.get(text(identity.get("rangeId")), 2),
        text(identity.get("originalGroupKey")),
        text(identity.get("originalSourceDetailKey")),
        text(identity.get("replacementGroupKey")),
        text(identity.get("replacementSourceDetailKey")),
        text(identity.get("videoId")),
        text(identity.get("occurrenceId")),
    )


def alias_selected_identities(current: dict[str, Any], replacement: dict[str, Any]) -> list[dict[str, Any]]:
    """Create deterministic range/source audit rows for an accepted alias."""

    stored_range = text(current.get("rangeId"))
    if stored_range and stored_range not in {"all", "7d"}:
        raise ValueError(f"alias occurrence has unsupported rangeId: {stored_range}")
    ranges = (stored_range,) if stored_range else ("all", "7d")
    original_key = public_song_group_key(current.get("title"), current.get("artist"))
    replacement_key = public_song_group_key(replacement.get("title"), replacement.get("artist"))
    result = []
    for range_id in ranges:
        result.append({
            "videoId": text(current.get("videoId")),
            "occurrenceId": text(current.get("occurrenceId")),
            "rangeId": range_id,
            "seconds": current.get("seconds"),
            "sourceId": text(current.get("sourceId")),
            "storedRangeId": stored_range,
            "originalTitle": text(current.get("title")),
            "originalArtist": text(current.get("artist")),
            "originalGroupKey": original_key,
            "originalSourceDetailKey": production_source_detail_key(range_id, "song", original_key),
            "replacementTitle": text(replacement.get("title")),
            "replacementArtist": text(replacement.get("artist")),
            "replacementGroupKey": replacement_key,
            "replacementSourceDetailKey": production_source_detail_key(range_id, "song", replacement_key),
        })
    return result


def validated_alias_source_review(identities: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return the canonical identity ledger and its exact source-group rollup.

    This is intentionally stricter than the producer's mutation accounting:
    a legacy row produces two reviewed range projections but remains one physical
    alias mutation.  The deploy gate verifies the same tuple key and canonical
    bytes before it issues any source-detail request.
    """

    if len(identities) > 50000:
        raise ValueError("alias source review exceeds selected identity cap (50000)")
    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    physical: dict[tuple[str, str, str], tuple[Any, ...]] = {}
    physical_ranges: dict[tuple[str, str, str], set[str]] = {}
    physical_projection_counts: dict[tuple[str, str, str], int] = {}
    for raw in identities:
        if not isinstance(raw, dict):
            raise ValueError("alias source review identity must be an object")
        if set(raw) != set(IDENTITY_FIELDS):
            raise ValueError("alias source review identity has missing or unexpected fields")
        identity = {field: text(raw.get(field)) for field in IDENTITY_FIELDS if field != "seconds"}
        seconds = raw.get("seconds")
        if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 0:
            raise ValueError("alias source review identity has invalid seconds")
        identity["seconds"] = seconds
        if identity["rangeId"] not in {"all", "7d"}:
            raise ValueError("alias source review identity has invalid rangeId")
        required_text = set(IDENTITY_FIELDS) - {"seconds", "sourceId", "storedRangeId"}
        if any(not identity[field] for field in required_text):
            raise ValueError("alias source review identity has blank required field")
        if identity["storedRangeId"] not in {"", "all", "7d"}:
            raise ValueError("alias source review identity has invalid storedRangeId")
        if identity["storedRangeId"] and identity["storedRangeId"] != identity["rangeId"]:
            raise ValueError("alias source review identity range projection conflicts with storedRangeId")
        for field in ("originalSourceDetailKey", "replacementSourceDetailKey"):
            if len(identity[field]) != 16 or any(char not in "0123456789abcdef" for char in identity[field]):
                raise ValueError(f"alias source review identity has invalid {field}")
        if identity["originalSourceDetailKey"] == identity["replacementSourceDetailKey"]:
            raise ValueError("alias source review identity has identical source detail keys")
        tuple_key = (
            identity["rangeId"], identity["originalSourceDetailKey"], identity["replacementSourceDetailKey"],
            identity["videoId"], identity["occurrenceId"],
        )
        if tuple_key in seen:
            raise ValueError("alias source review has duplicate identity tuple")
        seen.add(tuple_key)
        physical_key = (identity["videoId"], identity["occurrenceId"], identity["storedRangeId"])
        physical_value = (
            identity["sourceId"], identity["seconds"],
            identity["originalTitle"], identity["originalArtist"],
            identity["replacementTitle"], identity["replacementArtist"],
            identity["originalGroupKey"], identity["replacementGroupKey"],
        )
        if physical_key in physical and physical[physical_key] != physical_value:
            raise ValueError("alias source review has conflicting identity projection")
        physical[physical_key] = physical_value
        physical_ranges.setdefault(physical_key, set()).add(identity["rangeId"])
        physical_projection_counts[physical_key] = physical_projection_counts.get(physical_key, 0) + 1
        selected.append(identity)
    for physical_key, ranges in physical_ranges.items():
        stored_range = physical_key[2]
        expected_ranges = {stored_range} if stored_range else {"all", "7d"}
        expected_count = 1 if stored_range else 2
        if ranges != expected_ranges or physical_projection_counts[physical_key] != expected_count:
            raise ValueError("alias source review has incomplete or duplicate legacy physical projections")
    selected.sort(key=identity_sort_key)

    group_counts: dict[tuple[str, str, str, str, str], int] = {}
    for identity in selected:
        group_key = (
            identity["rangeId"], identity["originalGroupKey"], identity["originalSourceDetailKey"],
            identity["replacementGroupKey"], identity["replacementSourceDetailKey"],
        )
        group_counts[group_key] = group_counts.get(group_key, 0) + 1
    groups = [
        {
            "rangeId": range_id,
            "originalGroupKey": original_group_key,
            "originalSourceDetailKey": original_source_key,
            "replacementGroupKey": replacement_group_key,
            "replacementSourceDetailKey": replacement_source_key,
            "count": count,
        }
        for (range_id, original_group_key, original_source_key, replacement_group_key, replacement_source_key), count
        in sorted(group_counts.items())
    ]
    if len(groups) > 64:
        raise ValueError("alias source review exceeds source group cap (64)")
    if sum(group["count"] for group in groups) != len(selected):
        raise ValueError("alias source review group aggregate is invalid")
    return selected, groups


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
    if expected_raw:
        candidates = [row for row in candidates if text(row.get("rawHash")) == expected_raw]

    expected_source_hash = text(override.get("sourceHash"))
    if expected_source_hash:
        candidates = [row for row in candidates if text(row.get("sourceHash")) == expected_source_hash]

    expected_source = text(override.get("sourceId"))
    if expected_source:
        candidates = [row for row in candidates if text(row.get("sourceId")) == expected_source]

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
        payload["songKey"] = derived_song_key(payload.get("title"), payload.get("artist"))
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
    def scope_norm(key: str, value: Any) -> str:
        result = norm(value)
        return result.lstrip("/") if key == "channelHandle" else result

    return (
        all(scope_norm(key, row.get(key)) == scope_norm(key, value) for key, value in exact.items())
        and all(scope_norm(key, row.get(key)).startswith(scope_norm(key, value)) for key, value in prefixes.items())
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
    alias_identities: list[dict[str, Any]] = []

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
        rule_identities: list[dict[str, Any]] = []
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
            selected = alias_selected_identities(current, replacement)
            rule_identities.extend(selected)
            alias_identities.extend(selected)
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
            "selectedIdentities": sorted(
                rule_identities,
                key=lambda item: (item["rangeId"], item["originalGroupKey"], item["videoId"], item["occurrenceId"]),
            ),
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
            expected_scope = expected_count(assertion, "expectedScopeCount")
            scope_count = sum(1 for row in snapshot_rows if scope_matches(assertion, row))
            mutation_count = sum(1 for row in mutated_identities if scope_matches(assertion, row))
        except ValueError as exc:
            audit.append({"index": index, "kind": "safety_assertion", "assertionId": assertion.get("assertionId"), "status": "invalid", "error": str(exc)})
            continue
        if expected_scope is not None and scope_count != expected_scope:
            status = "scope_count_mismatch"
        elif expected is not None and mutation_count != expected:
            status = "safety_violation"
        else:
            status = "accepted"
        audit.append({
            "index": index,
            "kind": "safety_assertion",
            "assertionId": assertion.get("assertionId"),
            "status": status,
            "scopeRowCount": scope_count,
            "expectedScopeCount": expected_scope,
            "mutationCount": mutation_count,
            "expectedMutationCount": expected,
            "auditedLegacyRuleCount": assertion.get("auditedLegacyRuleCount"),
        })

    counts: dict[str, int] = {}
    for item in audit:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    selected_identities, alias_source_groups = validated_alias_source_review(alias_identities)
    selected_physical_identities = {
        (identity["videoId"], identity["occurrenceId"], identity["storedRangeId"])
        for identity in selected_identities
    }
    if alias_mutations != len(selected_physical_identities):
        raise ValueError("alias mutation count does not equal reviewed physical identity count")
    alias_source_groups_bytes = canonical_json_bytes(alias_source_groups)
    selected_identities_bytes = canonical_json_bytes(selected_identities)
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
            "scope_count_mismatch",
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
    if selected_identities:
        # This review ledger deliberately remains in the producer artifact and
        # never enters a public API payload.  It records range projections, not
        # database mutations, so a legacy all+7d row still has one mutation.
        manifest.update({
            "aliasSourceGroups": alias_source_groups,
            "aliasSourceGroupCount": len(alias_source_groups),
            "aliasSourceGroupsSha256": sha256_bytes(alias_source_groups_bytes),
            "aliasSourceReview": {
                "schemaVersion": 1,
                "selectedIdentityCount": len(selected_identities),
                "selectedIdentitiesSha256": sha256_bytes(selected_identities_bytes),
                "selectedIdentities": selected_identities,
            },
        })
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
