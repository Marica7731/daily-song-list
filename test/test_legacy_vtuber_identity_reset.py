from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


producer = load_module(
    "legacy_vtuber_identity_reset",
    ROOT / "scripts" / "migration" / "legacy_vtuber_identity_reset.py",
)
converter = load_module(
    "accepted_files_to_patch",
    ROOT / "scripts" / "migration" / "accepted-files-to-patch.py",
)
sys.modules.setdefault("psycopg", types.ModuleType("psycopg"))
importer = load_module(
    "import_pg_incremental",
    ROOT / "scripts" / "migration" / "import-pg-incremental.py",
)


TARGET = producer.validate_target({
    "legacyDetailKey": "legacy key",
    "targetChannelId": "UC1234567890123456789012",
    "targetChannelHandle": "@reviewed",
    "expectedParentVideoCount": 2,
    "expectedParentOccurrenceCount": 3,
})


def occurrence(position: int, video_id: str, occurrence_id: str):
    return {
        "position": position,
        "video_id": video_id,
        "source_title": f"Song {position}",
        "seconds": position * 10,
        "occurrence_payload_json": {
            "occurrenceId": occurrence_id,
            "position": position,
            "title": f"Song {position}",
            "artist": "Artist",
            "seconds": position * 10,
        },
        "video_title": f"Video {video_id}",
        "channel_name": "Legacy Display",
        "channel_id": "",
        "channel_handle": "",
        "channel_url": "",
        "published_timestamp": 1,
        "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "video_payload_json": {
            "videoId": video_id,
            "title": f"Video {video_id}",
            "channelName": "Legacy Display",
        },
    }


class FakeTransaction:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeCursor:
    def __init__(self, connection, name=None):
        self.connection = connection
        self.name = name
        self.rows = []
        self.offset = 0
        self.description = None
        self.itersize = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=()):
        self.connection.queries.append((sql, tuple(params)))
        if "SET TRANSACTION" in sql:
            self.rows = []
        elif "FROM migration_state" in sql:
            self.rows = [{"state_value": self.connection.active}]
        elif "FROM migration_revisions" in sql:
            revision = params[0]
            if revision == self.connection.active:
                self.rows = [{
                    "revision_id": revision,
                    "parent_revision_id": "full-parent",
                    "manifest_json": {
                        "runtimeProjection": True,
                        "incrementalOverlay": True,
                    },
                }]
            elif revision == "full-parent":
                self.rows = [{
                    "revision_id": revision,
                    "parent_revision_id": "",
                    "manifest_json": {
                        "runtimeProjection": True,
                        "incrementalOverlay": False,
                    },
                }]
            else:
                self.rows = []
        elif "FROM runtime_ranking_rows" in sql:
            self.rows = [{
                "detail_key": "legacy key",
                "name": "Legacy Display",
                "row_count": self.connection.ranking_occurrences,
                "video_count": self.connection.ranking_videos,
                "payload_json": {},
            }]
        elif "FROM runtime_source_details" in sql:
            self.rows = [{
                "source_key": "source-exact",
                "entity_key": "legacy key",
                "payload_json": {},
            }]
        elif "FROM runtime_source_occurrences" in sql:
            self.rows = copy.deepcopy(self.connection.occurrences)
        else:
            raise AssertionError(f"unexpected SQL: {sql}")
        self.offset = 0
        return self

    def fetchmany(self, size):
        batch = self.rows[self.offset:self.offset + size]
        self.offset += len(batch)
        return batch


class FakeConnection:
    def __init__(self):
        self.active = "active-d"
        self.ranking_videos = 2
        self.ranking_occurrences = 3
        self.occurrences = [
            occurrence(0, "aaaaaaaaaaa", "occ-a"),
            occurrence(1, "aaaaaaaaaaa", "occ-b"),
            occurrence(2, "bbbbbbbbbbb", "occ-c"),
        ]
        self.queries = []

    def cursor(self, name=None):
        return FakeCursor(self, name)

    def transaction(self):
        return FakeTransaction()


def completed_reset(group):
    return {
        **group,
        "parentRevisionId": "active-d",
        "sourceReachedEnd": True,
        "complete": True,
        "unresolvedParentVideoIds": [],
        "unexpectedResetVideoIds": [],
        "identityEvidenceSha256": "a" * 64,
    }


def evidence(video_id, unavailable=False, target=TARGET):
    nested = {
        "videoId": video_id,
        "status": (
            "unavailable-reviewed-reconciliation"
            if unavailable else "channel-page-reviewed"
        ),
        "sourceUrl": f"https://www.youtube.com/watch?v={video_id}",
        "channelId": target["targetChannelId"],
        "channelHandle": target["targetChannelHandle"],
    }
    status = "channel-page-reviewed"
    if unavailable:
        status = "unavailable-reviewed-reconciliation"
        nested["reconciliationSha256"] = "d" * 64
    else:
        nested["rawSha256"] = "c" * 64
    return {
        "videoId": video_id,
        "status": status,
        "reviewedBy": "reviewer",
        "reviewedAt": "2026-07-30T00:00:00+00:00",
        "reason": "archived immutable owner evidence" if unavailable else "",
        "preserveParentOccurrences": unavailable,
        "evidence": nested,
        "evidenceSha256": producer.canonical_sha256(nested),
    }


FULL_GROUP_SPECS = (
    ("utaha mairo", 117, 1240, "UC_oOXyu0rYB8rqW_rc9_jJA", "@Mairo0504"),
    ("horobi", 103, 2569, "UCujhOjvSoET9Sjj4TjHfz6A", "@horobi_m_o"),
    (
        "takanashi kobato", 100, 1006,
        "UCbA0mV8uL5-aTb2SeZ-X_cg", "@TakanashiKobato",
    ),
    (
        "akatsuki clara", 95, 798,
        "UCn4XvlTXjGSvDynpxpOYZPQ", "@akatsukiclara",
    ),
)


def full_accepted_payload():
    videos = []
    resets = []
    next_video = 0
    for group_index, (
        detail_key,
        video_count,
        occurrence_count,
        channel_id,
        channel_handle,
    ) in enumerate(FULL_GROUP_SPECS):
        target = producer.validate_target({
            "legacyDetailKey": detail_key,
            "targetChannelId": channel_id,
            "targetChannelHandle": channel_handle,
            "expectedParentVideoCount": video_count,
            "expectedParentOccurrenceCount": occurrence_count,
        })
        video_ids = [
            f"v{next_video + offset:010d}" for offset in range(video_count)
        ]
        next_video += video_count
        by_id = {
            video_id: {
                "videoId": video_id,
                "channelId": target["targetChannelId"],
                "channelHandle": target["targetChannelHandle"],
                "channelUrl": target["targetChannelUrl"],
                "reason": "legacy-vtuber-full-identity-reset",
                "identityResetEvidence": evidence(video_id, target=target),
                "songs": [],
            }
            for video_id in video_ids
        }
        identities = []
        for position in range(occurrence_count):
            video_id = video_ids[position % video_count]
            song = {
                "videoId": video_id,
                "occurrenceId": f"group-{group_index}-occ-{position}",
                "sourcePosition": position,
                "position": position,
                "seconds": position,
                "title": f"Song {group_index}-{position}",
                "artist": "Artist",
            }
            by_id[video_id]["songs"].append(song)
            identities.append(
                producer.canonical_accepted_occurrence(by_id[video_id], song),
            )
        evidence_manifest = [
            by_id[video_id]["identityResetEvidence"] for video_id in video_ids
        ]
        resets.append({
            "schemaVersion": 1,
            "kind": producer.CONTRACT_KIND,
            "rangeId": "all",
            "parentRevisionId": "active-d",
            "parentRuntimeRevisionId": "full-parent",
            "legacyDetailKey": detail_key,
            "legacyDisplayName": detail_key,
            "sourceKey": f"source-{group_index}",
            "parentVideoCount": video_count,
            "parentOccurrenceCount": occurrence_count,
            "parentVideoIds": video_ids,
            "parentVideoIdsSha256": producer.canonical_sha256(video_ids),
            "parentOccurrenceIdentitiesSha256": producer.canonical_sha256(
                identities,
            ),
            "targetChannelId": target["targetChannelId"],
            "targetChannelHandle": target["targetChannelHandle"],
            "targetChannelUrl": target["targetChannelUrl"],
            "sourceReachedEnd": True,
            "complete": True,
            "unresolvedParentVideoIds": [],
            "unexpectedResetVideoIds": [],
            "identityEvidenceSha256": producer.canonical_sha256(
                evidence_manifest,
            ),
        })
        videos.extend(by_id[video_id] for video_id in video_ids)
    return {
        "schemaVersion": 1,
        "kind": producer.ACCEPTED_KIND,
        "videoCount": 415,
        "occurrenceCount": 5613,
        "identityResets": resets,
        "videos": videos,
    }


class IdentityResetTests(unittest.TestCase):
    def test_snapshot_uses_exact_source_relation_and_server_cursor(self):
        connection = FakeConnection()
        group, videos = producer.snapshot_group(
            connection, "full-parent", TARGET,
        )
        self.assertEqual(group["parentVideoIds"], ["aaaaaaaaaaa", "bbbbbbbbbbb"])
        self.assertEqual(group["parentVideoCount"], 2)
        self.assertEqual(group["parentOccurrenceCount"], 3)
        self.assertEqual(sum(len(video["songs"]) for video in videos), 3)
        source_queries = [
            sql for sql, _ in connection.queries
            if "FROM runtime_source_occurrences" in sql
        ]
        self.assertEqual(len(source_queries), 1)
        self.assertIn("s.source_key=%s", source_queries[0])

    def test_snapshot_rejects_partial_parent_set(self):
        connection = FakeConnection()
        connection.ranking_videos = 3
        with self.assertRaisesRegex(
            producer.ContractError, "parent video set/count mismatch",
        ):
            producer.snapshot_group(connection, "full-parent", TARGET)

    def test_snapshot_rejects_reviewed_occurrence_count_drift(self):
        connection = FakeConnection()
        drifted = {**TARGET, "expectedParentOccurrenceCount": 4}
        with self.assertRaisesRegex(
            producer.ContractError, "expected occurrence count drift",
        ):
            producer.snapshot_group(connection, "full-parent", drifted)

    def test_database_cas_recomputes_complete_parent_contract(self):
        connection = FakeConnection()
        group, _ = producer.snapshot_group(connection, "full-parent", TARGET)
        reset = completed_reset(group)
        result = producer.verify_reset_manifests_against_db(
            connection, [reset], "active-d",
        )
        self.assertEqual(result["verifiedLegacyDetailKeys"], ["legacy key"])
        self.assertEqual(
            sorted(result["expectedVideos"]),
            ["aaaaaaaaaaa", "bbbbbbbbbbb"],
        )
        tampered = {**reset, "parentVideoCount": 1}
        with self.assertRaisesRegex(
            producer.ContractError, "database contract mismatch",
        ):
            producer.verify_reset_manifests_against_db(
                FakeConnection(), [tampered], "active-d",
            )
        with self.assertRaisesRegex(producer.ContractError, "active revision CAS"):
            producer.verify_reset_manifests_against_db(
                FakeConnection(), [reset], "wrong-active",
            )

    def test_finalize_preserves_unavailable_parent_occurrences(self):
        connection = FakeConnection()
        group, videos = producer.snapshot_group(
            connection, "full-parent", TARGET,
        )
        group["parentRevisionId"] = "active-d"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            video_path = root / "videos.ndjson"
            producer.write_ndjson(video_path, videos)
            group["parentVideosPath"] = video_path.name
            group["parentVideosSha256"] = producer.file_sha256(video_path)
            parent = {
                "kind": producer.SOURCE_KIND,
                "complete": False,
                "sourceReachedEnd": False,
                "groups": [group],
            }
            parent_path = root / "parent.json"
            parent_path.write_text(json.dumps(parent), encoding="utf-8")
            ledger = {
                "groups": [{
                    "legacyDetailKey": "legacy key",
                    "videos": [
                        evidence("aaaaaaaaaaa"),
                        evidence("bbbbbbbbbbb", unavailable=True),
                    ],
                }],
            }
            ledger_path = root / "ledger.json"
            ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
            output = root / "accepted.json"
            payload = producer.finalize_accepted(
                parent_path, ledger_path, output,
            )
            self.assertEqual(payload["videoCount"], 2)
            self.assertEqual(payload["occurrenceCount"], 3)
            self.assertEqual(payload["identityResets"][0]["complete"], True)
            unavailable = next(
                video for video in payload["videos"]
                if video["videoId"] == "bbbbbbbbbbb"
            )
            self.assertEqual(len(unavailable["songs"]), 1)
            self.assertTrue(
                unavailable["identityResetEvidence"][
                    "preserveParentOccurrences"
                ],
            )
            totals = producer.validate_accepted_identity_resets(
                payload["identityResets"], payload["videos"],
            )
            self.assertEqual(totals["occurrenceCount"], 3)
            partial = copy.deepcopy(ledger)
            partial["groups"][0]["videos"].pop()
            ledger_path.write_text(json.dumps(partial), encoding="utf-8")
            with self.assertRaisesRegex(
                producer.ContractError, "partial or contains extras",
            ):
                producer.finalize_accepted(parent_path, ledger_path, output)

    def test_converter_rejects_parent_set_hash_drift(self):
        payload = full_accepted_payload()
        converter.validate_identity_resets(payload, Path("fixture.json"))
        payload["identityResets"][0]["parentVideoIdsSha256"] = "0" * 64
        with self.assertRaisesRegex(
            ValueError, "parent video set mismatch",
        ):
            converter.validate_identity_resets(payload, Path("fixture.json"))

    def test_converter_rejects_removed_song_even_when_counts_are_rewritten(self):
        payload = full_accepted_payload()
        payload["videos"][0]["songs"].pop()
        payload["occurrenceCount"] -= 1
        with self.assertRaisesRegex(
            ValueError, "accepted occurrence count or digest mismatch",
        ):
            converter.validate_identity_resets(payload, Path("fixture.json"))

    def test_missing_top_level_resets_fail_closed_in_all_three_stages(self):
        for state in ("missing", "null", "empty"):
            with self.subTest(state=state):
                payload = full_accepted_payload()
                self.assertEqual(len(payload["videos"]), 415)
                if state == "missing":
                    del payload["identityResets"]
                elif state == "null":
                    payload["identityResets"] = None
                else:
                    payload["identityResets"] = []
                with self.assertRaisesRegex(
                    producer.ContractError, "require non-empty identityResets",
                ):
                    producer.verify_contract_against_db(
                        FakeConnection(), payload, "active-d",
                    )
                with self.assertRaisesRegex(
                    ValueError, "require non-empty identityResets",
                ):
                    converter.validate_identity_resets(
                        payload, Path("fixture.json"),
                    )
                with self.assertRaisesRegex(
                    ValueError, "requires non-empty identityResets",
                ):
                    for record in payload["videos"]:
                        importer.require_identity_reset_expectations(record, {})

    def test_ordinary_non_reset_accepted_payload_remains_compatible(self):
        for state in ("missing", "null", "empty"):
            with self.subTest(state=state):
                payload = {
                    "videos": [{
                        "videoId": "ordinary001",
                        "channelId": "UC1234567890123456789012",
                        "songs": [],
                    }],
                }
                if state == "null":
                    payload["identityResets"] = None
                elif state == "empty":
                    payload["identityResets"] = []
                self.assertEqual(
                    producer.validate_identity_reset_manifest_presence(payload),
                    [],
                )
                self.assertEqual(
                    converter.validate_identity_resets(
                        payload, Path("ordinary.json"),
                    ),
                    [],
                )
                importer.require_identity_reset_expectations(
                    payload["videos"][0], {},
                )

    def test_copied_review_evidence_is_rejected_per_video(self):
        payload = full_accepted_payload()
        payload["videos"][1]["identityResetEvidence"] = copy.deepcopy(
            payload["videos"][0]["identityResetEvidence"],
        )
        with self.assertRaisesRegex(
            ValueError, "evidence video ID mismatch",
        ):
            converter.validate_identity_resets(payload, Path("fixture.json"))

    def test_importer_recomputes_complete_patch_contract(self):
        payload = full_accepted_payload()
        result = importer.verify_identity_reset_patch(
            {
                "identityResets": payload["identityResets"],
                "acceptedOccurrenceCount": payload["occurrenceCount"],
            },
            payload["videos"],
        )
        self.assertEqual(result["videoCount"], 415)
        self.assertEqual(result["occurrenceCount"], 5613)

    def test_importer_rejects_occurrence_and_evidence_tampering(self):
        payload = full_accepted_payload()
        payload["videos"][0]["songs"].pop()
        with self.assertRaisesRegex(
            ValueError, "accepted occurrence count or digest mismatch",
        ):
            importer.verify_identity_reset_patch(
                {"identityResets": payload["identityResets"]},
                payload["videos"],
            )
        payload = full_accepted_payload()
        payload["videos"][0]["identityResetEvidence"]["reviewedBy"] = "other"
        with self.assertRaisesRegex(
            ValueError, "evidence ledger digest mismatch",
        ):
            importer.verify_identity_reset_patch(
                {"identityResets": payload["identityResets"]},
                payload["videos"],
            )


if __name__ == "__main__":
    unittest.main()
