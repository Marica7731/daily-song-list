from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELAY_PATH = ROOT / "scripts" / "migration" / "pg-peer-relay.py"
SPEC = importlib.util.spec_from_file_location("pg_peer_relay", RELAY_PATH)
assert SPEC and SPEC.loader
RELAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELAY)


class RelayTests(unittest.TestCase):
    def test_rejects_non_loopback_listener(self) -> None:
        with self.assertRaises(SystemExit):
            RELAY.parse_args(["--listen-host", "0.0.0.0", "--listen-port", "1"])

    def test_rejects_unbounded_connection_limit(self) -> None:
        with self.assertRaises(SystemExit):
            RELAY.parse_args(["--listen-port", "1", "--max-connections", "65"])

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix sockets required")
    def test_relays_bytes_and_writes_ready_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            unix_path = root / "postgres.sock"
            ready_path = root / "ready.json"
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
                ],
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            try:
                deadline = time.monotonic() + 5
                while not ready_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                marker = json.loads(ready_path.read_text(encoding="utf-8"))
                self.assertEqual(marker["host"], "127.0.0.1")
                with socket.create_connection((marker["host"], marker["port"]), timeout=2) as client:
                    client.sendall(b"postgres")
                    self.assertEqual(client.recv(4096), b"sergtsop")
            finally:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=5)
                unix_server.close()
            self.assertEqual(process.returncode, 0)


class WorkflowContractTests(unittest.TestCase):
    def test_mac_first_release_contract_is_fail_closed(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "sync-wdc-release.yml").read_text(encoding="utf-8")
        for required in (
            "ubuntu_gate:",
            "runs-on: [self-hosted, macOS, ARM64, daily-song-list-mac]",
            "/Users/be/codex-temp/dsl-wdc-sync-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            "--require-user www-data",
            "SOURCE_TRIPLET_STABLE_AFTER_BUILD",
            "SOURCE_TRIPLET_STABLE_BEFORE_WDC_WRITE",
            "SOURCE_TRIPLET_STABLE_BEFORE_ACTIVATE",
            "SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE",
            "release.tar.gz.part",
            "WDC_PROJECT_MAX_BYTES: \"40000000000\"",
            "WDC_FILESYSTEM_RESERVE_BYTES: \"5000000000\"",
            "MAC_RUN_MAX_BYTES: \"32000000000\"",
            "MAC_FILESYSTEM_RESERVE_BYTES: \"15000000000\"",
            "WDC_CONTROL_BACKUP_MAX_BYTES: \"134217728\"",
            "MAC_PYTHON: \"/Users/be/.local/bin/python3\"",
            "MAC_NODE: \"/Users/be/.local/codex-toolchains/node/bin/node\"",
            'test -x "$MAC_NODE"',
            '"$MAC_NODE" --check assets/app.js',
            '"$MAC_NODE" --check "$FRONTEND_ROOT/$APP_PATH"',
            'PYTHON_DEPS_ROOT="$MAC_RUN_ROOT/python-deps"',
            '--target "$PYTHON_DEPS_ROOT"',
            "--only-binary=:all:",
            "--require-hashes",
            "--no-deps",
            "--no-cache-dir",
            "--no-compile",
            "--timeout 30",
            "--retries 2",
            'PYTHONPATH="$PYTHON_DEPS_ROOT:$GITHUB_WORKSPACE/server:$GITHUB_WORKSPACE"',
            '"$MAC_PYTHON" scripts/migration/materialize-pg-release-snapshot.py --help >/dev/null',
            "shutil.disk_usage(root).free",
            "MAC_RUN_SYMLINK_REJECTED",
            "MAC_RUN_NON_REGULAR_REJECTED",
            "MAC_STORAGE_PREFLIGHT_OK",
            "MAC_STORAGE_BUNDLE_OK",
            "incoming_bytes=$((archive_upper + release_bytes + control_backup_max))",
            "projected_bytes=$((current_bytes + release_bytes + control_backup_max))",
            "WDC_CONTROL_TARGET_COUNT_INVALID",
            "WDC_SAME_FS_MV_NO_DB_COPY",
            "COPYFILE_DISABLE=1 tar",
            "CLEANUP_JOB_STATUS: ${{ job.status }}",
            'rollback_state="$releases_root/.rollback-$sha"',
            "WDC_PREACTIVATION_ORPHAN_REMOVED",
            "WDC_ORPHAN_PRESERVED_ACTIVE",
            "WDC_ORPHAN_PRESERVED_ROLLBACK",
            "scripts/migration/requirements-wdc-mac.txt",
        ):
            self.assertIn(required, workflow)
        self.assertEqual(workflow.count('node --check assets/app.js'), 1)
        self.assertEqual(workflow.count('"$MAC_NODE" --check'), 2)
        self.assertEqual(workflow.count('if len(targets)!=6'), 2)
        orphan_guards = (
            'elif [[ "$current_sha" == "$sha" ]]',
            'elif [[ -e "$rollback_state" || -L "$rollback_state" ]]',
            'release_real="$(realpath -- "$release_dir")"',
            '"${release_real%/*}" != "$releases_root"',
            'rm -rf -- "$release_dir"',
        )
        for guard in orphan_guards:
            self.assertIn(guard, workflow)
        self.assertLess(
            workflow.index('elif [[ "$current_sha" == "$sha" ]]'),
            workflow.index('rm -rf -- "$release_dir"'),
        )
        self.assertLess(
            workflow.index('elif [[ -e "$rollback_state" || -L "$rollback_state" ]]'),
            workflow.index('rm -rf -- "$release_dir"'),
        )
        for forbidden in (
            "Legacy VPS2",
            "REMOTE_ROOT",
            "/tmp/ssh",
            "StrictHostKeyChecking=no",
            "actions/upload-artifact",
            "actions/download-artifact",
            "-mindepth",
            "ionice",
            "stat -c",
            "df -B1",
            "VPS2_FILESYSTEM",
            "/tmp/dsl-wdc-",
            "archive_upper + release_bytes + release_bytes",
            "current_bytes + release_bytes + release_bytes",
            "pip install --user",
        ):
            self.assertNotIn(forbidden, workflow)

    def test_mac_dependencies_are_exactly_hash_locked(self) -> None:
        requirements = (
            ROOT / "scripts" / "migration" / "requirements-wdc-mac.txt"
        ).read_text(encoding="utf-8")
        for required in (
            "psycopg==3.3.4",
            "sha256:b6bbc25ccf05c8fad3b061d9db2ef0909a555171b84b07f29458a447253d679a",
            "psycopg-binary==3.3.4",
            "sha256:6402a9d8146cf4b3974ded3fd28a971e83dc6a0333eb7822524a3aa20b546578",
            "typing-extensions==4.16.0",
            "sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
        ):
            self.assertIn(required, requirements)
        self.assertEqual(requirements.count("=="), 3)
        self.assertEqual(requirements.count("--hash=sha256:"), 3)


if __name__ == "__main__":
    unittest.main()
