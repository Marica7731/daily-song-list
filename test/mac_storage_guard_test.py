import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mac_storage_guard", ROOT / "scripts/ci/mac_storage_guard.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class MacStorageGuardTests(unittest.TestCase):
    def test_tree_bytes_counts_files_without_following_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data.bin").write_bytes(b"12345")
            (root / "nested").mkdir()
            (root / "nested" / "more.bin").write_bytes(b"1234567")
            (root / "link").symlink_to(root / "data.bin")
            self.assertEqual(MODULE.tree_bytes(root), 12)

    def test_run_root_must_be_under_runner_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            old = os.environ.get("RUNNER_TEMP")
            os.environ["RUNNER_TEMP"] = temp
            try:
                self.assertTrue(str(MODULE.safe_run_root(Path(temp) / "run-1")).endswith("run-1"))
                with self.assertRaises(ValueError):
                    MODULE.safe_run_root(Path(temp).parent / "outside")
            finally:
                if old is None:
                    os.environ.pop("RUNNER_TEMP", None)
                else:
                    os.environ["RUNNER_TEMP"] = old

    def test_cleanup_only_allows_dedicated_cache(self):
        with self.assertRaises(ValueError):
            MODULE.safe_cache_root(Path("/tmp/not-the-runtime-cache"))


if __name__ == "__main__":
    unittest.main()
