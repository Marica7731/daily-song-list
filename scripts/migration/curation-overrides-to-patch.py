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


class CurationBlocked(ValueError):
    """A deliberate fail-closed gate, reported with the producer's exit 78."""


class AssertionGateError(ValueError):
    """A compact safety-assertion schema failure without protected tuple data."""

    def __init__(self, gate: str, observed: Any, expected: Any, message: str):
        super().__init__(message)
        self.gate = gate
        self.observed = observed
        self.expected = expected


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def norm(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", text(value)).casefold().split())


def normalize_channel_handle(value: Any) -> str | None:
    """Apply only generic handle normalization, never identity-specific logic."""

    result = unicodedata.normalize("NFKC", text(value)).casefold()
    if not result:
        return None
    if result.startswith("/"):
        result = result[1:]
    if result.startswith("@"):
        result = result[1:]
    if not result or result.startswith(("/", "@")):
        return None
    return result


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
    """Return the canonical identity ledger and its exact source-group rollup."""

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
            raw_video_id = first(item, "videoId", "video_id")
            if not isinstance(raw_video_id, str) or not raw_video_id.strip():
                raise CurationBlocked("snapshot row has invalid videoId")
            video_id = raw_video_id.strip()
            video_ids.add(video_id)
            if kind in {"video", "videos"}:
                continue
            raw_occurrence_id = first(item, "occurrenceId", "occurrence_id")
            if not isinstance(raw_occurrence_id, str) or not raw_occurrence_id.strip():
                raise CurationBlocked(f"snapshot occurrence has invalid occurrenceId: {video_id}")
            occurrence_id = raw_occurrence_id.strip()
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


SCOPE_NUMERIC_FIELDS = {"position", "seconds"}
SCOPE_STRING_FIELDS = {
    "videoId",
    "occurrenceId",
    "title",
    "artist",
    "sourceId",
    "sourceHash",
    "rawHash",
    "rangeId",
    "sourceSystem",
    "songKey",
    "channelHandle",
}
SCOPE_FIELDS = SCOPE_NUMERIC_FIELDS | SCOPE_STRING_FIELDS


def value_shape(value: Any) -> str:
    if value is None:
        return "missing"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return f"list[{len(value)}]"
    if isinstance(value, dict):
        return f"object[{len(value)}]"
    return type(value).__name__


def validate_scope_selectors(assertion: dict[str, Any]) -> None:
    exact = assertion.get("equals", {})
    prefixes = assertion.get("startsWith", {})
    for gate, selector in (("equals", exact), ("startsWith", prefixes)):
        if not isinstance(selector, dict):
            raise AssertionGateError(gate, value_shape(selector), "object", f"{gate} must be an object")
        unknown_count = len(set(selector) - SCOPE_FIELDS)
        if unknown_count:
            raise AssertionGateError(
                gate,
                {"unknownKeyCount": unknown_count},
                {"unknownKeyCount": 0},
                f"{gate} contains unsupported selector fields",
            )
    overlap = len(set(exact) & set(prefixes))
    if overlap:
        raise AssertionGateError(
            "selectors",
            {"overlapCount": overlap},
            {"overlapCount": 0},
            "equals and startsWith overlap",
        )
    for key, value in exact.items():
        if key in SCOPE_NUMERIC_FIELDS:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise AssertionGateError(
                    f"equals.{key}",
                    value if isinstance(value, (bool, int)) else value_shape(value),
                    "non-negative integer",
                    f"equals.{key} must be a non-negative integer",
                )
        elif not isinstance(value, str) or not (normalize_channel_handle(value) if key == "channelHandle" else norm(value)):
            raise AssertionGateError(
                f"equals.{key}",
                value_shape(value),
                "non-empty string",
                f"equals.{key} must be a non-empty string",
            )
    for key, value in prefixes.items():
        if key in SCOPE_NUMERIC_FIELDS:
            raise AssertionGateError(
                f"startsWith.{key}",
                value_shape(value),
                "string selector field",
                f"startsWith does not support numeric field {key}",
            )
        normalized = normalize_channel_handle(value) if key == "channelHandle" else norm(value)
        if not isinstance(value, str) or not normalized:
            raise AssertionGateError(
                f"startsWith.{key}",
                value_shape(value),
                "non-empty string",
                f"startsWith.{key} must be a non-empty string",
            )


def scope_value(key: str, value: Any) -> Any:
    if key in SCOPE_NUMERIC_FIELDS:
        return value
    if key == "channelHandle":
        return normalize_channel_handle(value)
    return norm(value)


def scope_matches(assertion: dict[str, Any], row: dict[str, Any]) -> bool:
    exact = assertion.get("equals", {})
    prefixes = assertion.get("startsWith", {})
    for key, value in exact.items():
        actual = scope_value(key, row.get(key))
        expected = scope_value(key, value)
        if actual is None or actual != expected:
            return False
    for key, value in prefixes.items():
        actual = scope_value(key, row.get(key))
        expected = scope_value(key, value)
        if not isinstance(actual, str) or not isinstance(expected, str) or not actual.startswith(expected):
            return False
    return True


def expected_count(rule: dict[str, Any], field: str) -> int | None:
    value = rule.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def assertion_count(rule: dict[str, Any], field: str, *, required: bool = False) -> int | None:
    if field not in rule:
        if required:
            raise AssertionGateError(field, "missing", "non-negative integer", f"{field} is required")
        return None
    value = rule.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        observed = value if isinstance(value, (bool, int)) else value_shape(value)
        raise AssertionGateError(
            field,
            observed,
            "non-negative integer",
            f"{field} must be a non-negative integer",
        )
    return value


def required_count(rule: dict[str, Any], field: str) -> int:
    if field not in rule:
        raise ValueError(f"{field} is required")
    value = expected_count(rule, field)
    if value is None:
        raise ValueError(f"{field} is required")
    return value


def selector_state_contract(override: dict[str, Any]) -> tuple[str, int] | None:
    """Validate the Naraetan current-active state binding when present."""

    is_naraetan = text(override.get("ruleId")).startswith("naraetan-")
    has_contract = "expectedCurrentState" in override or "expectedSelectorMutationCount" in override
    if not is_naraetan and not has_contract:
        return None
    state = text(override.get("expectedCurrentState"))
    if state not in {"present", "absent"}:
        raise ValueError("expectedCurrentState must be present or absent")
    expected_mutations = required_count(override, "expectedSelectorMutationCount")
    required_mutations = 1 if state == "present" else 0
    if expected_mutations != required_mutations:
        raise ValueError("expectedSelectorMutationCount conflicts with expectedCurrentState")
    return state, expected_mutations


KNOWN_TUPLE_FIELDS = (
    "videoId",
    "occurrenceId",
    "position",
    "seconds",
    "sourceId",
    "sourceHash",
    "rawHash",
    "rangeId",
)
KNOWN_TUPLE_STRING_FIELDS = tuple(field for field in KNOWN_TUPLE_FIELDS if field not in {"position", "seconds"})
PROTECTION_SOURCE_PROVENANCE_FIELDS = ("sourceId", "sourceHash", "rawHash")
PROTECTION_DERIVED_LINEAGE_FIELDS = (
    "videoId",
    "occurrenceId",
    "position",
    "seconds",
    "title",
    "artist",
    "sourceSystem",
    "rangeId",
    "channelHandle",
)
PROTECTION_DERIVED_REQUIRED_STRING_FIELDS = (
    "videoId",
    "occurrenceId",
    "title",
    "sourceSystem",
    "rangeId",
)
PROTECTION_DERIVED_OPTIONAL_STRING_FIELDS = ("artist", "channelHandle")
PROTECTION_DERIVED_SCHEMA = "derived-protection-v1"


def protection_tuple_from_row(assertion_id: str, row: dict[str, Any]) -> dict[str, Any]:
    """Project immutable protection evidence without mutating occurrence data.

    Historical ``latest_json`` rows predate comment-level source provenance and
    legitimately have all of ``sourceId``, ``sourceHash`` and ``rawHash`` empty.
    Such rows can still be bound to the exact active snapshot by deriving
    domain-separated evidence from their complete immutable row lineage.  The
    derived values exist only in the protection contract; they are never copied
    into candidate mutations or the source occurrence.

    Mixed real/empty source provenance is not historical absence and remains a
    hard failure.  Core physical identity fields must be non-empty.  ``artist``
    and ``channelHandle`` may be historically empty, but must remain strings so
    their exact empty value is still bound into the evidence digest.  Other
    incomplete lineage cannot be used to manufacture protection evidence.
    """

    result = {field: row.get(field) for field in KNOWN_TUPLE_FIELDS}
    source_states = {}
    for field in PROTECTION_SOURCE_PROVENANCE_FIELDS:
        value = row.get(field)
        if value is None or value == "":
            source_states[field] = "empty"
        elif isinstance(value, str) and value.strip():
            source_states[field] = "valid"
        else:
            source_states[field] = "invalid"
    if "invalid" in source_states.values():
        raise CurationBlocked(f"protected scope has invalid string provenance: {assertion_id}")
    if "valid" in source_states.values() and "empty" in source_states.values():
        raise CurationBlocked(f"protected scope has partial string provenance: {assertion_id}")

    if set(source_states.values()) == {"empty"}:
        lineage = {field: row.get(field) for field in PROTECTION_DERIVED_LINEAGE_FIELDS}
        if any(
            not isinstance(lineage[field], str) or not lineage[field].strip()
            for field in PROTECTION_DERIVED_REQUIRED_STRING_FIELDS
        ):
            raise CurationBlocked(f"protected scope has incomplete derived lineage: {assertion_id}")
        if any(
            not isinstance(lineage[field], str)
            for field in PROTECTION_DERIVED_OPTIONAL_STRING_FIELDS
        ):
            raise CurationBlocked(f"protected scope has incomplete derived lineage: {assertion_id}")
        if lineage["sourceSystem"].strip() != "latest_json":
            raise CurationBlocked(f"protected scope has unsupported derived lineage: {assertion_id}")
        if any(
            isinstance(lineage[field], bool)
            or not isinstance(lineage[field], int)
            or lineage[field] < 0
            for field in ("position", "seconds")
        ):
            raise CurationBlocked(f"protected scope has incomplete derived lineage: {assertion_id}")
        for field in PROTECTION_SOURCE_PROVENANCE_FIELDS:
            digest_input = {
                "field": field,
                "lineage": lineage,
                "schema": PROTECTION_DERIVED_SCHEMA,
            }
            digest = sha256_bytes(
                json.dumps(
                    digest_input,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            )
            result[field] = f"{PROTECTION_DERIVED_SCHEMA}:{field}:{digest}"

    if any(not isinstance(result[field], str) or not result[field].strip() for field in KNOWN_TUPLE_STRING_FIELDS):
        raise CurationBlocked(f"protected scope has incomplete string provenance: {assertion_id}")
    if any(
        isinstance(result[field], bool) or not isinstance(result[field], int) or result[field] < 0
        for field in ("position", "seconds")
    ):
        raise CurationBlocked(f"protected scope has incomplete numeric provenance: {assertion_id}")
    return result


def known_tuples(assertion: dict[str, Any]) -> list[dict[str, Any]] | None:
    if "knownTuplePresence" not in assertion:
        return None
    value = assertion.get("knownTuplePresence")
    if not isinstance(value, list) or not value:
        raise AssertionGateError(
            "knownTuplePresence",
            value_shape(value),
            "non-empty list",
            "knownTuplePresence must be a non-empty list",
        )
    tuples: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise AssertionGateError(
                "knownTuplePresence",
                {"index": index, "shape": value_shape(item)},
                {"tupleShape": "object"},
                f"knownTuplePresence[{index}] must be an object",
            )
        missing = [field for field in KNOWN_TUPLE_FIELDS if field not in item]
        if missing:
            raise AssertionGateError(
                "knownTuplePresence",
                {"index": index, "missingFieldCount": len(missing)},
                {"missingFieldCount": 0},
                f"knownTuplePresence[{index}] is incomplete",
            )
        unknown = sorted(set(item) - set(KNOWN_TUPLE_FIELDS))
        if unknown:
            raise AssertionGateError(
                "knownTuplePresence",
                {"index": index, "unknownFieldCount": len(unknown)},
                {"unknownFieldCount": 0},
                f"knownTuplePresence[{index}] has unknown fields",
            )
        if any(not isinstance(item[field], str) or not item[field].strip() for field in KNOWN_TUPLE_STRING_FIELDS):
            raise AssertionGateError(
                "knownTuplePresence",
                {"index": index, "invalidStringFieldCount": 1},
                {"invalidStringFieldCount": 0},
                f"knownTuplePresence[{index}] has invalid string field",
            )
        if any(isinstance(item[field], bool) or not isinstance(item[field], int) or item[field] < 0 for field in ("position", "seconds")):
            raise AssertionGateError(
                "knownTuplePresence",
                {"index": index, "invalidNumericFieldCount": 1},
                {"invalidNumericFieldCount": 0},
                f"knownTuplePresence[{index}] has invalid numeric field",
            )
        canonical = json.dumps({field: item[field] for field in KNOWN_TUPLE_FIELDS}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        if canonical in seen:
            raise AssertionGateError(
                "knownTuplePresence",
                {"duplicateDeclarationCount": 1},
                {"duplicateDeclarationCount": 0},
                "knownTuplePresence contains duplicate tuple",
            )
        seen.add(canonical)
        tuples.append({field: item[field] for field in KNOWN_TUPLE_FIELDS})
    return tuples


def known_tuple_matches(expected: dict[str, Any], row: dict[str, Any]) -> bool:
    # Avoid projecting unrelated rows.  Besides being bounded, this ensures a
    # partial-provenance row outside the declared immutable identity cannot
    # block an otherwise independent safety assertion.
    for field in ("videoId", "occurrenceId", "position", "seconds", "rangeId"):
        actual = row.get(field)
        wanted = expected.get(field)
        if field in {"position", "seconds"}:
            if actual != wanted:
                return False
        elif text(actual) != text(wanted):
            return False
    projected = protection_tuple_from_row("known-tuple-match", row)
    for field in PROTECTION_SOURCE_PROVENANCE_FIELDS:
        actual = projected.get(field)
        wanted = expected.get(field)
        if text(actual) != text(wanted):
            return False
    return True


def known_tuple_digest(tuples: Iterable[dict[str, Any]]) -> str:
    canonical = [
        {field: item[field] for field in KNOWN_TUPLE_FIELDS}
        for item in tuples
    ]
    canonical.sort(key=lambda item: json.dumps(item, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return sha256_bytes(json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def protection_contract_sha256(digests: dict[str, str]) -> str:
    return sha256_bytes(json.dumps(dict(sorted(digests.items())), separators=(",", ":"), sort_keys=True).encode("utf-8"))


def coarse_selector_rows(override: dict[str, Any], rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the minimum stable selector identity for idempotency checks."""

    seconds = override.get("seconds")
    source_id = text(override.get("sourceId"))
    result = [row for row in rows if row.get("seconds") == seconds]
    if source_id:
        result = [row for row in result if text(row.get("sourceId")) == source_id]
    return result


def bind_current_active_evidence(
    rules_path: Path,
    snapshot_path: Path,
    output_path: Path,
    evidence_path: Path,
    active_revision_id: str,
) -> dict[str, Any]:
    """Bind an untrusted template to one complete logical active snapshot.

    The bound rules file is run-scoped evidence. It is never written back to
    the repository and cannot become an accepted increment automatically.
    """

    rules = read_json(rules_path)
    if text(rules.get("status")) != "needs_current_active_evidence" or rules.get("ready") is not False:
        raise CurationBlocked("rules template is not awaiting current-active evidence")
    if not active_revision_id:
        raise CurationBlocked("active revision id is required for evidence binding")
    by_video, _, snapshot_sha = read_snapshot(snapshot_path)
    snapshot_rows = [row for rows in by_video.values() for row in rows]
    if not snapshot_rows:
        raise CurationBlocked("current-active snapshot is empty")

    records = rules.get("records")
    if not isinstance(records, list):
        raise CurationBlocked("records must be a list")
    total_selector_mutations = 0
    for record in records:
        if not isinstance(record, dict):
            raise CurationBlocked("record is not an object")
        action = text(record.get("action"))
        if action not in {"drop_entry", "replace_entry"}:
            raise CurationBlocked(f"unsupported record action: {action}")
        video_id = text(record.get("videoId"))
        if not video_id:
            raise CurationBlocked(f"record videoId is missing: ruleId={record.get('ruleId')}")
        exact = candidate_rows(record, by_video.get(video_id, []), action)
        coarse = coarse_selector_rows(record, by_video.get(video_id, []))
        expected = record.get("expectedMatchCount")
        if expected is not None and len(exact) != int(expected):
            raise CurationBlocked(
                f"record match count mismatch: ruleId={record.get('ruleId')} expected={expected} actual={len(exact)}"
            )
        if len(exact) >= 1:
            record["expectedCurrentState"] = "present"
            record["expectedSelectorMutationCount"] = len(exact)
            total_selector_mutations += len(exact)
        elif not exact and not coarse:
            record["expectedCurrentState"] = "absent"
            record["expectedSelectorMutationCount"] = 0
        else:
            raise CurationBlocked(
                f"record provenance ambiguous: ruleId={record.get('ruleId')} exact={len(exact)} coarse={len(coarse)}"
            )
    rules["expectedSelectorMutationCount"] = total_selector_mutations

    alias_rules = rules.get("artistScopedAliases")
    if not isinstance(alias_rules, list):
        alias_rules = []
    total_alias_mutations = 0
    for alias_rule in alias_rules:
        if not isinstance(alias_rule, dict):
            raise CurationBlocked("alias rule is not an object")
        alias_rows = alias_candidates(alias_rule, by_video)
        alias_expected = expected_count(alias_rule, "expectedMatchCount")
        if alias_expected is not None and len(alias_rows) != alias_expected:
            raise CurationBlocked(
                f"alias count mismatch: artist={alias_rule.get('artist')} canonicalTitle={alias_rule.get('canonicalTitle')} expected={alias_expected} actual={len(alias_rows)}"
            )
        total_alias_mutations += len(alias_rows)
    rules["expectedAliasMutationCount"] = total_alias_mutations

    assertions = rules.get("safetyAssertions")
    if not isinstance(assertions, list) or not assertions:
        raise CurationBlocked("template safety assertions are missing")
    assertion_evidence: list[dict[str, Any]] = []
    for assertion in assertions:
        if not isinstance(assertion, dict):
            raise CurationBlocked("template safety assertion is not an object")
        assertion_id = text(assertion.get("assertionId"))
        if not assertion_id:
            raise CurationBlocked("template safety assertion id is missing")
        validate_scope_selectors(assertion)
        matches = [row for row in snapshot_rows if scope_matches(assertion, row)]
        observed = len(matches)
        if observed <= 0:
            raise CurationBlocked(f"protected scope is empty: {assertion_id}")
        fixed = assertion.get("expectedScopeCount")
        if fixed is not None:
            fixed = assertion_count(assertion, "expectedScopeCount")
            if observed != fixed:
                raise CurationBlocked(
                    f"protected fixed scope drift: {assertion_id} expected={fixed} actual={observed}"
                )
        tuples = [protection_tuple_from_row(assertion_id, row) for row in matches]
        tuples.sort(
            key=lambda item: json.dumps(
                item, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            )
        )
        assertion["expectedScopeCount"] = observed
        assertion["minScopeCount"] = observed
        assertion["knownTuplePresence"] = tuples
        assertion["expectedMutationCount"] = 0
        assertion.pop("bindCurrentActiveEvidence", None)
        assertion_evidence.append({
            "assertionId": assertion_id,
            "scopeCount": observed,
            "knownTupleCount": len(tuples),
            "knownTupleDigest": known_tuple_digest(tuples),
        })

    template_sha = sha256_bytes(rules_path.read_bytes())
    rules.pop("pendingCurrentActiveEvidence", None)
    rules["status"] = "ready"
    rules["ready"] = True
    rules["currentActiveEvidence"] = {
        "activeRevisionId": active_revision_id,
        "snapshotSha256": snapshot_sha,
        "snapshotOccurrenceCount": len(snapshot_rows),
        "templateRulesManifestSha256": template_sha,
        "boundAt": datetime.now(timezone.utc).isoformat(),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    evidence = {
        "schemaVersion": 1,
        "kind": "curation-current-active-evidence-binding",
        "status": "ready",
        "activeRevisionId": active_revision_id,
        "snapshotSha256": snapshot_sha,
        "snapshotOccurrenceCount": len(snapshot_rows),
        "templateRulesManifestSha256": template_sha,
        "boundRulesManifestSha256": sha256_bytes(output_path.read_bytes()),
        "expectedSelectorMutationCount": total_selector_mutations,
        "expectedAliasMutationCount": total_alias_mutations,
        "assertions": assertion_evidence,
    }
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return evidence


def convert(rules_path: Path, snapshot_path: Path, output_path: Path, manifest_path: Path, review_path: Path) -> dict[str, Any]:
    rules_raw = rules_path.read_bytes()
    rules = read_json(rules_path)
    if text(rules.get("status") or "ready") != "ready":
        raise CurationBlocked("rules manifest is not ready for current-active conversion")
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
        try:
            state_contract = selector_state_contract(raw_override)
        except ValueError as exc:
            audit.append(audit_result(index, raw_override, "invalid", error=str(exc)))
            continue
        candidates = candidate_rows(raw_override, rows, action)
        coarse_rows = coarse_selector_rows(raw_override, rows)
        if not candidates:
            if not coarse_rows:
                # The video/time/source identity itself has disappeared.  This is
                # the only selector-drift case that is an idempotent no-op.
                if state_contract and state_contract[0] == "present":
                    audit.append(audit_result(index, raw_override, "current_state_mismatch", evidence="expected present selector is absent"))
                else:
                    audit.append(audit_result(
                        index,
                        raw_override,
                        "already_applied_absent",
                        evidence="active snapshot has no audited video/time/source identity",
                        selectorMutationCount=0,
                    ))
            else:
                # A coarse identity exists, so a source/raw provenance mismatch
                # must never be reclassified as an already-applied deletion.
                audit.append(audit_result(
                    index,
                    raw_override,
                    "provenance_mismatch",
                    coarseMatchCount=len(coarse_rows),
                    exactMatchCount=0,
                    occurrenceIds=[row["occurrenceId"] for row in coarse_rows],
                ))
            continue
        if state_contract and state_contract[0] == "absent":
            audit.append(audit_result(index, raw_override, "current_state_mismatch", evidence="expected absent selector is present"))
            continue
        expected = expected_count(raw_override, "expectedMatchCount")
        if expected is not None and len(candidates) != expected:
            audit.append(audit_result(index, raw_override, "count_mismatch", matchCount=len(candidates), expectedMatchCount=expected))
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
                status = "current_state_mismatch" if state_contract else "already_applied"
                audit.append(audit_result(index, raw_override, status, occurrenceId=already[0]["occurrenceId"], evidence="active occurrence already equals replacement"))
                continue
        if len(candidates) > 1:
            audit.append(audit_result(index, raw_override, "ambiguous", occurrenceIds=[row["occurrenceId"] for row in candidates]))
            continue
        current = candidates[0]
        if action == "drop_entry":
            mutations.append(runtime_row(raw_override, current, True, context=context))
            selector_mutations += 1
            audit.append(audit_result(index, raw_override, "accepted", matchCount=1, occurrenceId=current["occurrenceId"], evidence="exact audited identity match", selectorMutationCount=1))
            continue
        expected_title = norm(replacement.get("title"))
        expected_artist = norm(replacement.get("artist"))
        if (not expected_title or norm(current.get("title")) == expected_title) and (not expected_artist or norm(current.get("artist")) == expected_artist):
            status = "current_state_mismatch" if state_contract else "already_applied"
            audit.append(audit_result(index, raw_override, status, occurrenceId=current["occurrenceId"], evidence="active occurrence already equals replacement"))
            continue
        mutations.append(runtime_row(raw_override, current, False, replacement, context))
        selector_mutations += 1
        audit.append(audit_result(index, raw_override, "accepted", occurrenceId=current["occurrenceId"], evidence="video+seconds unique match", selectorMutationCount=1))

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
            "selectedIdentities": sorted(rule_identities, key=identity_sort_key),
            "reason": text(raw_rule.get("reason")),
        })

    mutated_identities = [
        mutation.get("payload", {}).get("originalIdentity", {})
        for mutation in mutations
        if isinstance(mutation.get("payload"), dict)
    ]
    for index, assertion in enumerate(rules.get("safetyAssertions", [])):
        if not isinstance(assertion, dict):
            audit.append({
                "index": index,
                "kind": "safety_assertion",
                "assertionId": None,
                "status": "invalid",
                "gate": "assertion",
                "observed": value_shape(assertion),
                "expected": "object",
                "error": "assertion is not an object",
            })
            continue
        try:
            validate_scope_selectors(assertion)
            expected = assertion_count(assertion, "expectedMutationCount", required=True)
            expected_scope = assertion_count(assertion, "expectedScopeCount")
            minimum_scope = assertion_count(assertion, "minScopeCount")
            required_tuples = known_tuples(assertion) or []
            scope_count = sum(1 for row in snapshot_rows if scope_matches(assertion, row))
            mutation_count = sum(1 for row in mutated_identities if scope_matches(assertion, row))
            present_tuples = []
            tuple_statuses = []
            for known_index, required in enumerate(required_tuples):
                matches = [row for row in snapshot_rows if known_tuple_matches(required, row)]
                if not matches:
                    tuple_status = "missing"
                elif len(matches) != 1:
                    tuple_status = "ambiguous"
                elif not scope_matches(assertion, matches[0]):
                    tuple_status = "outside_scope"
                else:
                    tuple_status = "present"
                    present_tuples.append(required)
                tuple_statuses.append({
                    "index": known_index,
                    "status": tuple_status,
                    "matchCount": len(matches),
                })
            expected_digest = known_tuple_digest(required_tuples)
            observed_digest = known_tuple_digest(present_tuples)
        except AssertionGateError as exc:
            audit.append({
                "index": index,
                "kind": "safety_assertion",
                "assertionId": assertion.get("assertionId"),
                "status": "invalid",
                "gate": exc.gate,
                "observed": exc.observed,
                "expected": exc.expected,
                "error": str(exc),
            })
            continue
        tuple_summary = {
            "present": sum(item["status"] == "present" for item in tuple_statuses),
            "missing": sum(item["status"] == "missing" for item in tuple_statuses),
            "ambiguous": sum(item["status"] == "ambiguous" for item in tuple_statuses),
            "outsideScope": sum(item["status"] == "outside_scope" for item in tuple_statuses),
        }
        if minimum_scope is not None and scope_count < minimum_scope:
            status = "scope_count_below_minimum"
            gate = "minScopeCount"
            observed: Any = scope_count
            gate_expected: Any = minimum_scope
        elif expected_scope is not None and scope_count != expected_scope:
            status = "scope_count_mismatch"
            gate = "expectedScopeCount"
            observed = scope_count
            gate_expected = expected_scope
        elif tuple_summary["missing"]:
            status = "known_tuple_missing"
            gate = "knownTuplePresence"
            observed = tuple_summary
            gate_expected = {"exactlyOnceInScope": len(required_tuples)}
        elif tuple_summary["ambiguous"]:
            status = "known_tuple_ambiguous"
            gate = "knownTuplePresence"
            observed = tuple_summary
            gate_expected = {"exactlyOnceInScope": len(required_tuples)}
        elif tuple_summary["outsideScope"]:
            status = "known_tuple_outside_scope"
            gate = "knownTuplePresence"
            observed = tuple_summary
            gate_expected = {"exactlyOnceInScope": len(required_tuples)}
        elif mutation_count != expected:
            status = "safety_violation"
            gate = "expectedMutationCount"
            observed = mutation_count
            gate_expected = expected
        else:
            status = "accepted"
            gate = "all"
            observed = {
                "scopeRowCount": scope_count,
                "mutationCount": mutation_count,
                "knownTupleCount": len(present_tuples),
            }
            gate_expected = {
                "expectedScopeCount": expected_scope,
                "minScopeCount": minimum_scope,
                "expectedMutationCount": expected,
                "exactlyOnceInScope": len(required_tuples),
            }
        audit.append({
            "index": index,
            "kind": "safety_assertion",
            "assertionId": assertion.get("assertionId"),
            "status": status,
            "gate": gate,
            "observed": observed,
            "expected": gate_expected,
            "scopeRowCount": scope_count,
            "expectedScopeCount": expected_scope,
            "minScopeCount": minimum_scope,
            "mutationCount": mutation_count,
            "expectedMutationCount": expected,
            "knownTupleCount": len(present_tuples),
            "expectedKnownTupleCount": len(required_tuples),
            "expectedKnownTupleDigest": expected_digest,
            "observedKnownTupleDigest": observed_digest,
            "knownTupleStatuses": tuple_statuses,
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
    protection_digests = {
        text(item.get("assertionId")): text(item.get("expectedKnownTupleDigest"))
        for item in audit
        if item.get("kind") == "safety_assertion" and text(item.get("assertionId")) and text(item.get("expectedKnownTupleDigest"))
    }
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
            "provenance_mismatch",
            "alias_count_mismatch",
            "safety_violation",
            "scope_count_mismatch",
            "scope_count_below_minimum",
            "known_tuple_missing",
            "known_tuple_ambiguous",
            "known_tuple_outside_scope",
            "current_state_mismatch",
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
        "protectionContractSha256": protection_contract_sha256(protection_digests),
        "reviewAudit": counts,
        "overridesSha256": sha256_bytes(rules_raw),
        "rulesManifestSha256": sha256_bytes(rules_raw),
        "snapshotSha256": snapshot_sha,
        "reviewSha256": sha256_bytes(review_path.read_bytes()),
        "sourceManifestSha256": sha256_bytes((sha256_bytes(rules_raw) + snapshot_sha).encode("ascii")),
    }
    if selected_identities:
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
    parser.add_argument("--manifest-output", type=Path)
    parser.add_argument("--review-output", type=Path)
    parser.add_argument("--bind-current-active-evidence", action="store_true")
    parser.add_argument("--binding-evidence-output", type=Path)
    parser.add_argument("--active-revision-id")
    args = parser.parse_args()
    try:
        rules_path = args.rules_manifest or args.overrides
        if args.bind_current_active_evidence:
            if args.overrides or not args.binding_evidence_output or not args.active_revision_id:
                raise ValueError(
                    "binding requires --rules-manifest, --binding-evidence-output, and --active-revision-id"
                )
            evidence = bind_current_active_evidence(
                rules_path,
                args.snapshot,
                args.output,
                args.binding_evidence_output,
                args.active_revision_id,
            )
            print(json.dumps({"status": "ok", **evidence}, ensure_ascii=False))
            return 0
        if not args.manifest_output or not args.review_output:
            raise ValueError("conversion requires --manifest-output and --review-output")
        manifest = convert(rules_path, args.snapshot, args.output, args.manifest_output, args.review_output)
        print(json.dumps({"status": "ok", **manifest}, ensure_ascii=False))
        return 0 if manifest["status"] == "ready" else 78
    except CurationBlocked as exc:
        print(f"CURATION_PATCH_BLOCKED {exc}", file=sys.stderr)
        return 78
    except Exception as exc:
        print(f"CURATION_PATCH_ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
