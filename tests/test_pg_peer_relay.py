from __future__ import annotations

import importlib.util
import json
import os
import signal
import sqlite3
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RELAY_PATH = ROOT / "scripts" / "migration" / "pg-peer-relay.py"
SPEC = importlib.util.spec_from_file_location("pg_peer_relay", RELAY_PATH)
assert SPEC and SPEC.loader
RELAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELAY)
DATA_VERIFY_PATH = ROOT / "deploy" / "verify-wdc-release-data.py"
DATA_VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_wdc_release_data", DATA_VERIFY_PATH
)
assert DATA_VERIFY_SPEC and DATA_VERIFY_SPEC.loader
DATA_VERIFY = importlib.util.module_from_spec(DATA_VERIFY_SPEC)
DATA_VERIFY_SPEC.loader.exec_module(DATA_VERIFY)
STORAGE_PATH = ROOT / "deploy" / "check-wdc-build-storage.py"
STORAGE_SPEC = importlib.util.spec_from_file_location(
    "check_wdc_build_storage", STORAGE_PATH
)
assert STORAGE_SPEC and STORAGE_SPEC.loader
STORAGE = importlib.util.module_from_spec(STORAGE_SPEC)
STORAGE_SPEC.loader.exec_module(STORAGE)
PUBLIC_VERIFY_PATH = ROOT / "deploy" / "verify-wdc-public-release.py"
PUBLIC_VERIFY_SPEC = importlib.util.spec_from_file_location(
    "verify_wdc_public_release", PUBLIC_VERIFY_PATH
)
assert PUBLIC_VERIFY_SPEC and PUBLIC_VERIFY_SPEC.loader
PUBLIC_VERIFY = importlib.util.module_from_spec(PUBLIC_VERIFY_SPEC)
sys.modules[PUBLIC_VERIFY_SPEC.name] = PUBLIC_VERIFY
PUBLIC_VERIFY_SPEC.loader.exec_module(PUBLIC_VERIFY)


class RelayTests(unittest.TestCase):
    def test_rejects_non_loopback_listener(self) -> None:
        with self.assertRaises(SystemExit):
            RELAY.parse_args(["--listen-host", "0.0.0.0", "--listen-port", "1"])

    def test_rejects_unbounded_connection_limit(self) -> None:
        with self.assertRaises(SystemExit):
            RELAY.parse_args(["--listen-port", "1", "--max-connections", "65"])

    def test_rejects_unbounded_byte_limit(self) -> None:
        with self.assertRaises(SystemExit):
            RELAY.parse_args(
                ["--listen-port", "1", "--max-bytes", "16000000001"]
            )

    def test_cumulative_byte_budget_is_shared_and_fail_closed(self) -> None:
        state = RELAY.RelayState(max_connections=2, max_bytes=8)
        self.assertTrue(state.account(4))
        self.assertTrue(state.account(4))
        self.assertFalse(state.account(1))
        self.assertEqual(state.bytes_forwarded, 8)
        self.assertTrue(state.byte_limit_exceeded)
        self.assertTrue(state.stop.is_set())

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix sockets required")
    def test_relays_bytes_and_writes_ready_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            unix_path = root / "postgres.sock"
            ready_path = root / "ready.json"
            stats_path = root / "stats.json"
            unix_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            unix_server.bind(str(unix_path))
            unix_server.listen(1)

            def echo_once() -> None:
                connection, _ = unix_server.accept()
                with connection:
                    data = connection.recv(4096)
                    connection.sendall(data[::-1])

            echo_thread = threading.Thread(target=echo_once, daemon=True)
            echo_thread.start()
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    str(RELAY_PATH),
                    "--listen-port",
                    "0",
                    "--socket",
                    str(unix_path),
                    "--ready-file",
                    str(ready_path),
                    "--stats-file",
                    str(stats_path),
                    "--max-connections",
                    "2",
                    "--max-bytes",
                    "1024",
                ],
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            try:
                deadline = time.monotonic() + 5
                while not ready_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                marker = json.loads(ready_path.read_text(encoding="utf-8"))
                self.assertEqual(marker["host"], "127.0.0.1")
                self.assertEqual(marker["maxBytes"], 1024)
                self.assertEqual(marker["maxConnections"], 2)
                self.assertEqual(marker["statsFile"], str(stats_path))
                with socket.create_connection((marker["host"], marker["port"]), timeout=2) as client:
                    client.sendall(b"postgres")
                    self.assertEqual(client.recv(4096), b"sergtsop")
            finally:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=5)
                unix_server.close()
            self.assertEqual(process.returncode, 0)
            stats = json.loads(stats_path.read_text(encoding="utf-8"))
            self.assertEqual(stats["bytesForwarded"], 16)
            self.assertEqual(stats["connectionsAccepted"], 1)
            self.assertFalse(stats["byteLimitExceeded"])
            self.assertEqual(stats["maxBytes"], 1024)


class ReleaseDataVerificationTests(unittest.TestCase):
    def test_exact_sources_width_owner_and_31_video_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "serving.sqlite"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE serving_meta(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE source_details(
                  range_id TEXT,source_key TEXT,entity_type TEXT,entity_key TEXT,
                  payload_json TEXT,total_occurrence_count INTEGER,total_video_count INTEGER,
                  PRIMARY KEY(range_id,source_key)
                );
                CREATE TABLE source_occurrences(
                  range_id TEXT,source_key TEXT,position INTEGER,video_id TEXT,
                  canonical_song_key TEXT,canonical_song_name TEXT
                );
                CREATE TABLE source_videos(
                  range_id TEXT,source_key TEXT,video_order INTEGER,video_id TEXT
                );
                CREATE TABLE ranking_rows(id INTEGER PRIMARY KEY);
                """
            )

            def add_source(
                range_id: str,
                source_key: str,
                occurrences: int,
                videos: int,
                song_key: str,
                song_name: str,
            ) -> None:
                payload = json.dumps(
                    {
                        "songs": [
                            {"key": song_key, "name": song_name, "count": occurrences}
                        ]
                    },
                    ensure_ascii=False,
                )
                connection.execute(
                    "INSERT INTO source_details VALUES(?,?,?,?,?,?,?)",
                    (
                        range_id,
                        source_key,
                        "song",
                        "entity",
                        payload,
                        occurrences,
                        videos,
                    ),
                )
                connection.executemany(
                    "INSERT INTO source_occurrences VALUES(?,?,?,?,?,?)",
                    (
                        (
                            range_id,
                            source_key,
                            position,
                            f"video-{source_key}-{position % videos:04d}",
                            song_key,
                            song_name,
                        )
                        for position in range(occurrences)
                    ),
                )

            add_source("all", "0007036316d9dffa", 771, 737, "song-owner", "Song")
            add_source("all", "000c1914748382f4", 7, 7, "artist-owner", "Honeycomb Summer")
            add_source(
                "7d",
                "9d99a4a482ed24b2536f0058",
                3,
                3,
                "e3bf8d66f08c946857927c15",
                "サインはB",
            )
            add_source("all", "1234567890abcdef", 32, 31, "probe-song", "Probe")
            connection.commit()
            connection.close()

            result = DATA_VERIFY.verify(database.resolve())
            self.assertEqual(
                result["exactSources"]["all/0007036316d9dffa"],
                {"occurrences": 771, "songs": 1, "videos": 737},
            )
            self.assertEqual(result["crossPageProbe"]["videos"], 31)
            self.assertEqual(result["widthOwner"]["name"], "サインはB")


class StorageCheckerTests(unittest.TestCase):
    def test_allocated_bytes_deduplicate_hardlinks_and_skip_mount_view(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            payload.write_bytes(b"x" * 4096)
            os.link(payload, root / "hardlink")
            skipped = root / "volume"
            skipped.mkdir()
            (skipped / "inside").write_bytes(b"y" * 4096)
            expected = root.lstat().st_blocks * 512 + payload.lstat().st_blocks * 512
            actual = STORAGE._allocated_tree_bytes(root, skip=skipped)
            self.assertEqual(actual, expected)

    def test_logical_bytes_deduplicate_hardlinks_without_following_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            payload.write_bytes(b"x" * 4096)
            os.link(payload, root / "hardlink")
            (root / "link").symlink_to(payload)
            expected = (
                root.lstat().st_size
                + payload.lstat().st_size
                + (root / "link").lstat().st_size
            )
            self.assertEqual(STORAGE._logical_tree_bytes(root), expected)

    def test_release_size_rejects_symlink_and_exact_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            payload.write_bytes(b"1234567890")
            with mock.patch.object(STORAGE, "RELEASE_MAX_BYTES", 10):
                with self.assertRaisesRegex(RuntimeError, "WDC_RELEASE_LIMIT_EXCEEDED"):
                    STORAGE._release_logical_bytes(root)
            payload.unlink()
            target = root / "target"
            target.write_bytes(b"ok")
            (root / "link").symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "WDC_RELEASE_SYMLINK_REJECTED"):
                STORAGE._release_logical_bytes(root)


class PublicLatencyTests(unittest.TestCase):
    def test_same_protocol_latency_uses_three_samples_and_legacy_health_identity(self) -> None:
        release = "a" * 64
        args = types.SimpleNamespace(
            base="https://invalid.example",
            timeout=20,
            release_sha=release,
            active_revision="accepted-test",
            source_commit="b" * 40,
            probe_source_key="c" * 16,
        )
        verifier = PUBLIC_VERIFY.Verifier(args)
        elapsed = iter(range(1, 100))

        def fake_raw(path: str, **_kwargs: object) -> object:
            body = (
                json.dumps({"status": "ok", "releaseContentSha": release}).encode()
                if path == "/healthz"
                else b"{}"
            )
            return PUBLIC_VERIFY.Response(200, {}, body, float(next(elapsed)))

        with mock.patch.object(verifier, "raw", side_effect=fake_raw):
            baseline = verifier.benchmark_protocol()
        self.assertEqual(set(baseline["protocol"]), {
            "health", "meta", "rankingAll", "rankingNiche",
            "rankingVisible", "sourcePage",
        })
        self.assertTrue(
            all(item["count"] == 3 for item in baseline["protocol"].values())
        )
        result = verifier.result(
            protocol_after=baseline,
            protocol_before=baseline,
        )
        self.assertTrue(
            all(item["ratio"] == 1 for item in result["sameProtocolLatency"].values())
        )

    def test_latency_output_is_new_atomic_and_bounded_to_absolute_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "baseline.json"
            PUBLIC_VERIFY.write_new_json(path, {"releaseSha": "a" * 64})
            self.assertEqual(json.loads(path.read_text())["releaseSha"], "a" * 64)
            with self.assertRaisesRegex(AssertionError, "already exists"):
                PUBLIC_VERIFY.write_new_json(path, {})


class WorkflowContractTests(unittest.TestCase):
    def test_server_side_release_contract_is_fail_closed(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "sync-wdc-release.yml"
        ).read_text(encoding="utf-8")
        controller = (
            ROOT / "deploy" / "orchestrate-wdc-bounded-release.sh"
        ).read_text(encoding="utf-8")
        build = (ROOT / "deploy" / "run-wdc-bounded-build.sh").read_text(
            encoding="utf-8"
        )
        checker = (ROOT / "deploy" / "check-wdc-build-storage.py").read_text(
            encoding="utf-8"
        )
        cleanup = (
            ROOT / "deploy" / "cleanup-wdc-bounded-build.sh"
        ).read_text(encoding="utf-8")
        data_verifier = (
            ROOT / "deploy" / "verify-wdc-release-data.py"
        ).read_text(encoding="utf-8")
        public_verifier = (
            ROOT / "deploy" / "verify-wdc-public-release.py"
        ).read_text(encoding="utf-8")
        combined = "\n".join(
            (workflow, controller, build, checker, cleanup, data_verifier, public_verifier)
        )
        for required in (
            'cron: "17 5 * * *"',
            "runs-on: ubuntu-latest",
            'WDC_PROJECT_MAX_BYTES: "40000000000"',
            'WDC_HOST_RESERVE_BYTES: "20000000000"',
            'WDC_TEMP_VOLUME_BYTES: "32000000000"',
            'WDC_RELEASE_MAX_BYTES: "16000000000"',
            'WDC_MEMORY_MAX_BYTES: "2684354560"',
            'WDC_SWAP_MAX_BYTES: "1073741824"',
            'VPS2_RELAY_MAX_BYTES: "16000000000"',
            'VPS2_RELAY_MAX_CONNECTIONS: "2"',
            "requirements-wdc-linux.txt",
            "orchestrate-wdc-bounded-release.sh",
            "check-wdc-build-storage.py",
            "cleanup-wdc-bounded-build.sh",
            "run-wdc-bounded-build.sh",
            "verify-wdc-release-data.py",
            "verify-wdc-public-release.py",
            "WDC_HASHED_SPARSE_SOURCE_OK",
            "--max-connections 2",
            "--max-bytes 16000000000",
            "MemoryMax=2684354560",
            "MemorySwapMax=1073741824",
            "CPUQuota=300%",
            "TasksMax=96",
            "RuntimeMaxSec=32400",
            'TEMP_VOLUME_BYTES="32000000000"',
            'RELEASE_MAX_BYTES="16000000000"',
            "truncate --size \"$TEMP_VOLUME_BYTES\"",
            "mkfs.ext4",
            "mount -t ext4 -o nosuid,nodev",
            "WDC_CGROUP_LIMITS_OK",
            "WDC_RELEASE_DATA_VERIFIED",
            "WDC_LATEST_HEAD_CONFIRMED",
            "WDC_STALE_HEAD_NO_WRITE",
            "WDC_STALE_HEAD_BEFORE_ACTIVATE",
            "WDC_LATEST_HEAD_STABLE_BEFORE_ACTIVATE",
            "SOURCE_TRIPLET_STABLE_BEFORE_ACTIVATE",
            "SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE",
            "WDC_PUBLIC_RELEASE_VERIFIED",
            "WDC_PUBLIC_LATENCY_BASELINE",
            "sameProtocolLatency",
            "for sample in $(seq 0 10)",
            "sleep 60",
            "WDC_FINAL_RESIDUE_OK",
            "WDC_CLEANUP_INCOMING_REMOVED",
            "WDC_CLEANUP_INCOMING_OWNER_MISSING",
            'CURRENT_SHA" == "$RELEASE_SHA',
            'ROLLBACK_STATE="$RELEASES_ROOT/.rollback-$RELEASE_SHA"',
            '/var/tmp/dsl-wdc-volume-${RUN_ID}-${RUN_ATTEMPT}',
            '"projectLogicalBytes"',
        ):
            self.assertIn(required, combined)
        self.assertEqual(workflow.count("runs-on: ubuntu-latest"), 2)
        self.assertNotIn('"$FORCE" == "false"', controller)
        self.assertLess(
            build.index("verify-wdc-release-data.py"),
            build.index('cp -a --no-preserve=ownership -- "$RELEASE_IN_VOLUME/."'),
        )
        self.assertLess(
            build.index('cp -a --no-preserve=ownership -- "$RELEASE_IN_VOLUME/."'),
            build.index('mv -T -- "$INCOMING_RELEASE" "$FINAL_RELEASE"'),
        )
        self.assertLess(
            controller.index("WDC_LATEST_HEAD_CONFIRMED"),
            controller.index("VPS2_RELAY_READY"),
        )
        self.assertLess(
            controller.index("WDC_LATEST_HEAD_STABLE_BEFORE_ACTIVATE"),
            controller.index("--action activate"),
        )
        self.assertLess(
            controller.index("SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE"),
            controller.index(
                "python3 -B deploy/verify-wdc-public-release.py",
                controller.index("SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE"),
            ),
        )
        for forbidden in (
            "self-hosted",
            "macOS",
            "daily-song-list-mac",
            "/Users/",
            "requirements-wdc-mac.txt",
            "release.tar",
            "actions/upload-artifact",
            "actions/download-artifact",
            "StrictHostKeyChecking=no",
            "git clone",
            "fetch-depth: 0",
            'cron: "*/20',
            "pip install --user",
        ):
            self.assertNotIn(forbidden, workflow + "\n" + controller)

    def test_linux_dependencies_are_exactly_hash_locked(self) -> None:
        requirements = (
            ROOT / "scripts" / "migration" / "requirements-wdc-linux.txt"
        ).read_text(encoding="utf-8")
        for required in (
            "psycopg==3.3.4",
            "sha256:b6bbc25ccf05c8fad3b061d9db2ef0909a555171b84b07f29458a447253d679a",
            "psycopg-binary==3.3.4",
            "sha256:e7510c37550f91a187e3660a8cc50d4b760f8c3b8b2f89ebc5698cd2c7f2c85d",
            "typing-extensions==4.16.0",
            "sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
        ):
            self.assertIn(required, requirements)
        self.assertEqual(requirements.count("=="), 3)
        self.assertEqual(requirements.count("--hash=sha256:"), 3)


if __name__ == "__main__":
    unittest.main()
