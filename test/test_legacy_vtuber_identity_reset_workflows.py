from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

import yaml

from test_legacy_vtuber_identity_reset import full_accepted_payload


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = (
    ROOT / ".github" / "workflows" / "discover-legacy-vtuber-identity-reset.yml",
    ROOT / ".github" / "workflows" / "deploy-pg-accepted-increment.yml",
    ROOT / ".github" / "workflows" / "deploy-pg-incremental.yml",
)


def run_blocks(source: str) -> list[str]:
    lines = source.splitlines()
    blocks: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)run:\s*\|\s*$", lines[index])
        if not match:
            index += 1
            continue
        indent = len(match.group(1)) + 2
        body: list[str] = []
        index += 1
        while index < len(lines):
            line = lines[index]
            if line.strip() and len(line) - len(line.lstrip()) < indent:
                break
            body.append(line[min(indent, len(line)):])
            index += 1
        blocks.append("\n".join(body))
    return blocks


def accepted_contract_filter(workflow: Path) -> str:
    source = workflow.read_text(encoding="utf-8")
    marker_offset = source.index("as $legacy_marked")
    filter_start = source.rfind("jq -e '\n", 0, marker_offset)
    if filter_start < 0:
        raise AssertionError(f"accepted jq filter is missing: {workflow.name}")
    filter_start += len("jq -e '\n")
    filter_end = re.search(
        r"\n\s*' \"\$destination\"",
        source[marker_offset:],
    )
    if filter_end is None:
        raise AssertionError(
            f"accepted jq filter terminator is missing: {workflow.name}",
        )
    filter_end_offset = marker_offset + filter_end.start()
    return textwrap.dedent(source[filter_start:filter_end_offset])


class WorkflowContractTests(unittest.TestCase):
    def test_candidate_manifest_matches_frozen_files(self):
        candidate_root = ROOT.parent
        manifest = json.loads(
            (candidate_root / "candidate-manifest.json").read_text(
                encoding="utf-8",
            ),
        )
        for relative_path, expected in manifest["producer"].items():
            actual = hashlib.sha256(
                (ROOT / relative_path).read_bytes(),
            ).hexdigest()
            self.assertEqual(actual, expected, relative_path)
        for relative_path, expected in manifest["supportingDocuments"].items():
            actual = hashlib.sha256(
                (candidate_root / relative_path).read_bytes(),
            ).hexdigest()
            self.assertEqual(actual, expected, relative_path)

    def test_python_candidates_compile_without_runtime_imports(self):
        for path in (
            ROOT / "scripts" / "migration" / "legacy_vtuber_identity_reset.py",
            ROOT / "scripts" / "migration" / "accepted-files-to-patch.py",
            ROOT / "scripts" / "migration" / "import-pg-incremental.py",
        ):
            compile(path.read_text(encoding="utf-8"), str(path), "exec")

    def test_workflows_parse_and_all_run_blocks_are_bash_syntax(self):
        checked = 0
        with tempfile.TemporaryDirectory() as temporary:
            task_root = Path(temporary)
            for workflow in WORKFLOWS:
                source = workflow.read_text(encoding="utf-8")
                parsed = yaml.safe_load(source)
                self.assertIsInstance(parsed, dict)
                for index, block in enumerate(run_blocks(source)):
                    checked += 1
                    sanitized = re.sub(r"\$\{\{.*?\}\}", "CI_EXPR", block)
                    script = task_root / f"{workflow.stem}-{index}.sh"
                    script.write_text(sanitized, encoding="utf-8")
                    result = subprocess.run(
                        ["bash", "-n", str(script)],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    self.assertEqual(
                        result.returncode,
                        0,
                        f"{workflow.name} run block {index}: {result.stderr}",
                    )
        self.assertGreater(checked, 0)

    def test_discovery_workflow_is_bounded_and_non_activating(self):
        source = WORKFLOWS[0].read_text(encoding="utf-8")
        for required in (
            "daily-song-list-mac",
            "timeout-minutes: 30",
            "ulimit -v 2097152",
            "export-parent",
            "cleanupExpectedAfterBytes",
            "VPS2_HOST: ${{ vars.VPS2_HOST }}",
            "VPS2_KNOWN_HOSTS: ${{ secrets.VPS2_KNOWN_HOSTS }}",
            "StrictHostKeyChecking=yes",
            "UserKnownHostsFile=",
            "checkpoint-manifest-sha-mismatch",
            "parent-file-bytes-mismatch",
            "parent-file-sha-mismatch",
            "remote_delete_status=0",
            "remote_absent_status=0",
            "test ! -e '$REMOTE_ROOT'",
        ):
            self.assertIn(required, source)
        for forbidden in (
            "activate-pg-revision",
            "--fresh",
            "StrictHostKeyChecking=no",
        ):
            self.assertNotIn(forbidden, source)
        self.assertNotRegex(source, r"VPS2_HOST:\s*[\"']?\d{1,3}\.")

    def test_remote_cleanup_runs_delete_and_absent_check_for_all_outcomes(self):
        source = WORKFLOWS[0].read_text(encoding="utf-8")
        match = re.search(
            r"(?ms)^          remote_cleanup\(\) \{\n.*?^          \}",
            source,
        )
        self.assertIsNotNone(match)
        cleanup_function = textwrap.dedent(match.group(0))
        script = r"""
set -u
delete_calls=0
absent_calls=0
mock_ssh() {
  last="${!#}"
  if [[ "$last" == case\ * ]]; then
    delete_calls=$((delete_calls + 1))
    return "$DELETE_RC"
  fi
  absent_calls=$((absent_calls + 1))
  return "$ABSENT_RC"
}
SSH=(mock_ssh)
VPS2_USER=test
VPS2_HOST=example.invalid
REMOTE_ROOT=/tmp/daily-song-legacy-identity-reset-test
""" + cleanup_function + r"""
set +e
remote_cleanup
status=$?
set -e
printf '%s %s %s\n' "$status" "$delete_calls" "$absent_calls"
"""
        for delete_rc, absent_rc, expected_status in (
            (0, 0, 0),
            (0, 1, 78),
            (1, 0, 78),
            (1, 1, 78),
        ):
            env = {
                **os.environ,
                "DELETE_RC": str(delete_rc),
                "ABSENT_RC": str(absent_rc),
            }
            result = subprocess.run(
                ["bash", "-c", script],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                env=env,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                result.stdout.strip(),
                f"{expected_status} 1 1",
                f"delete={delete_rc} absent={absent_rc}",
            )

    def test_accepted_workflows_bind_legacy_markers_to_reset_manifest(self):
        for workflow in WORKFLOWS[1:]:
            source = workflow.read_text(encoding="utf-8")
            for marker in (
                "$legacy_marked",
                '"legacy-vtuber-full-identity-reset"',
                'has("identityResetEvidence")',
                'has("identityReset")',
                ".identityResets | type == \"array\" and length > 0",
            ):
                self.assertIn(marker, source, workflow.name)
            jq_filter = accepted_contract_filter(workflow)
            ordinary = {
                "kind": "youtube-channel-discovery-increment",
                "schemaVersion": 1,
                "videoCount": 1,
                "occurrenceCount": 1,
                "videos": [{
                    "videoId": "ordinary001",
                    "channelId": "UC1234567890123456789012",
                    "songs": [{"title": "Song"}],
                }],
            }
            for state in ("missing", "null", "empty"):
                compatible = json.loads(json.dumps(ordinary))
                if state == "null":
                    compatible["identityResets"] = None
                elif state == "empty":
                    compatible["identityResets"] = []
                ordinary_result = subprocess.run(
                    ["jq", "-e", jq_filter],
                    input=json.dumps(compatible),
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(
                    ordinary_result.returncode,
                    0,
                    f"{workflow.name} ordinary state={state}: "
                    f"{ordinary_result.stderr}",
                )
            for state in ("missing", "null", "empty"):
                marked = json.loads(json.dumps(ordinary))
                marked["videos"][0]["curationReason"] = (
                    "legacy-vtuber-full-identity-reset"
                )
                if state == "null":
                    marked["identityResets"] = None
                elif state == "empty":
                    marked["identityResets"] = []
                marked_result = subprocess.run(
                    ["jq", "-e", jq_filter],
                    input=json.dumps(marked),
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(
                    marked_result.returncode,
                    0,
                    f"{workflow.name} state={state}",
                )

    def test_accepted_handoff_executes_full_nonempty_reset_validation(self):
        complete = full_accepted_payload()
        workflow = WORKFLOWS[1]
        jq_filter = accepted_contract_filter(workflow)
        valid_result = subprocess.run(
            ["jq", "-e", jq_filter],
            input=json.dumps(complete),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(
            valid_result.returncode,
            0,
            f"{workflow.name}: {valid_result.stderr}",
        )
        invalid = json.loads(json.dumps(complete))
        invalid["identityResets"][0]["parentOccurrenceCount"] -= 1
        invalid_result = subprocess.run(
            ["jq", "-e", jq_filter],
            input=json.dumps(invalid),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertNotEqual(
            invalid_result.returncode,
            0,
            workflow.name,
        )
        incremental_source = WORKFLOWS[2].read_text(encoding="utf-8")
        self.assertIn(
            'python3 "$INPUT_ROOT/accepted-files-to-patch.py"',
            incremental_source,
        )

    def test_target_config_has_four_unique_exact_groups(self):
        payload = json.loads(
            (
                ROOT / "config" / "legacy-vtuber-identity-reset-targets.json"
            ).read_text(encoding="utf-8"),
        )
        targets = payload["targets"]
        self.assertEqual(len(targets), 4)
        self.assertEqual(
            len({item["legacyDetailKey"] for item in targets}),
            4,
        )
        self.assertEqual(
            len({item["targetChannelId"] for item in targets}),
            4,
        )
        self.assertEqual(
            sum(item["expectedParentVideoCount"] for item in targets),
            415,
        )
        self.assertEqual(
            sum(item["expectedParentOccurrenceCount"] for item in targets),
            5613,
        )

    def test_vps_workflows_use_controlled_host_and_pinned_host_keys(self):
        for workflow in WORKFLOWS:
            source = workflow.read_text(encoding="utf-8")
            self.assertNotIn("StrictHostKeyChecking=no", source)
            self.assertNotRegex(source, r"VPS2_HOST:\s*[\"']?\d{1,3}\.")
        incremental = WORKFLOWS[2].read_text(encoding="utf-8")
        self.assertIn("VPS2_HOST: ${{ vars.VPS2_HOST }}", incremental)
        self.assertIn(
            "VPS2_KNOWN_HOSTS: ${{ secrets.VPS2_KNOWN_HOSTS }}",
            incremental,
        )
        self.assertIn("UserKnownHostsFile=", incremental)


if __name__ == "__main__":
    unittest.main()
