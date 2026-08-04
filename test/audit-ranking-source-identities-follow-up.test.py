from __future__ import annotations

import importlib.util
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "scripts" / "migration" / "audit-ranking-source-identities.py"


def load_audit():
    spec = importlib.util.spec_from_file_location("candidate_identity_audit", AUDIT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CHANNEL_ID = "UC5zO6IFsWSUHMYgJMv81XKg"
CHANNEL_HANDLE = "@shingames7857"


def card(*, occurrences=None, degraded=None, diagnostic=None) -> dict:
    value = {
        "key": CHANNEL_ID,
        "channelId": CHANNEL_ID,
        "channelHandle": CHANNEL_HANDLE,
        "channelUrl": f"https://www.youtube.com/{CHANNEL_HANDLE}",
        "sourceDetailKey": "follow-up-source-key",
    }
    if occurrences is not None:
        value["occurrences"] = occurrences
    if degraded is not None:
        value["occurrencePreviewDegraded"] = degraded
    if diagnostic is not None:
        value["occurrencePreviewDiagnostic"] = diagnostic
    return value


def valid_occurrence() -> dict:
    video_id = "FollowUp01"
    identity = {
        "videoId": video_id,
        "channelId": CHANNEL_ID,
        "channelHandle": CHANNEL_HANDLE,
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }
    return {"item": dict(identity), "video": dict(identity)}


def test_explicit_preview_degradation_is_allowed() -> None:
    audit = load_audit()
    for diagnostic in (
        "thumbnail_unavailable",
        "preview_payload_invalid",
        "preview_unavailable",
    ):
        problems = audit.audit_record(
            card(occurrences=[], degraded=True, diagnostic=diagnostic)
        )
        assert "missing_card_occurrences" not in problems, (diagnostic, problems)


def test_missing_or_unknown_degradation_is_still_hard() -> None:
    audit = load_audit()
    cases = (
        card(occurrences=[]),
        card(occurrences=[], degraded=False, diagnostic="thumbnail_unavailable"),
        card(occurrences=[], degraded=True, diagnostic="unknown_preview_state"),
    )
    for value in cases:
        assert "missing_card_occurrences" in audit.audit_record(value)


def test_nonempty_occurrences_keep_identity_checks() -> None:
    audit = load_audit()
    value = card(occurrences=[valid_occurrence()])
    value["occurrences"][0]["video"]["channelId"] = "UC-other-channel"
    problems = audit.audit_record(value)
    assert problems.intersection({
        "item_video_identity_mismatch",
        "card_occurrence_channel_id_mismatch",
    })


def main() -> None:
    tests = [
        test_explicit_preview_degradation_is_allowed,
        test_missing_or_unknown_degradation_is_still_hard,
        test_nonempty_occurrences_keep_identity_checks,
    ]
    failures = []
    for test in tests:
        try:
            test()
        except Exception as exc:  # pragma: no cover - test runner boundary
            failures.append(f"{test.__name__}: {exc}")
    if failures:
        for failure in failures:
            print(failure)
        raise SystemExit(1)
    print(
        "AUDIT_RANKING_SOURCE_IDENTITIES_FOLLOWUP_OK "
        f"tests={len(tests)} passed={len(tests)} failed=0"
    )


if __name__ == "__main__":
    main()
