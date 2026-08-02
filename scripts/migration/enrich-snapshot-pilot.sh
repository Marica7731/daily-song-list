#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --workspace PATH --catalog PATH --binding-manifest PATH --sample-id both|jul29-25|jul22-19 --source-commit 40HEX --output-root DIR" >&2
}

workspace=''
catalog=''
binding_manifest=''
sample_id=''
source_commit=''
output_root=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --catalog) catalog="$2"; shift 2 ;;
    --binding-manifest) binding_manifest="$2"; shift 2 ;;
    --sample-id) sample_id="$2"; shift 2 ;;
    --source-commit) source_commit="$2"; shift 2 ;;
    --output-root) output_root="$2"; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

for value in "$workspace" "$catalog" "$binding_manifest" "$sample_id" "$source_commit" "$output_root"; do
  [[ -n "$value" ]] || { usage; exit 2; }
done

if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'source_commit must be exactly 40 lowercase hexadecimal characters' >&2
  exit 2
fi
if [[ "$sample_id" != both && "$sample_id" != jul29-25 && "$sample_id" != jul22-19 ]]; then
  echo "unsupported sample_id: $sample_id" >&2
  exit 2
fi

workspace="$(cd "$workspace" && pwd -P)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
expected_catalog="$workspace/test/fixtures/snapshot-pilot/catalog.json"
expected_binding="$workspace/scripts/migration/snapshot-enrichment-provider-binding.json"
if [[ "$catalog" != "$expected_catalog" || "$binding_manifest" != "$expected_binding" ]]; then
  echo 'catalog and binding paths must be the fixed product paths' >&2
  exit 2
fi
test -f "$catalog"
test -f "$binding_manifest"

mkdir -p "$output_root"
if [[ "$sample_id" == both ]]; then
  sample_ids=(jul29-25 jul22-19)
else
  sample_ids=("$sample_id")
fi

for current_sample_id in "${sample_ids[@]}"; do
  sample_root="$output_root/$current_sample_id"
  mkdir -p "$sample_root"
  python3 "$script_dir/materialize-snapshot-pilot.py" \
    --catalog "$catalog" \
    --workspace "$workspace" \
    --sample-id "$current_sample_id" \
    --source-commit "$source_commit" \
    --output-root "$sample_root"

  set +e
  python3 "$script_dir/run-snapshot-enrichment-pilot.py" \
    --workspace "$workspace" \
    --catalog "$catalog" \
    --binding-manifest "$binding_manifest" \
    --sample-id "$current_sample_id" \
    --source-commit "$source_commit" \
    --sample "$sample_root/raw-input/sample.json" \
    --output-root "$sample_root"
  runner_rc=$?
  set -e
  if [[ "$runner_rc" -eq 78 ]]; then
    echo "$current_sample_id completed with needs_review; preserving NOT_FOR_RELEASE artifact and continuing" >&2
    continue
  fi
  if [[ "$runner_rc" -ne 0 ]]; then
    echo "$current_sample_id failed with input/program/I-O exit $runner_rc" >&2
    exit "$runner_rc"
  fi
done

python3 - "$output_root" "${sample_ids[@]}" <<'PY'
import json
import sys
from pathlib import Path

output_root = Path(sys.argv[1])
sample_ids = sys.argv[2:]
summaries = []
for sample_id in sample_ids:
    path = output_root / sample_id / "job-summary.json"
    if path.is_file():
        summaries.append(json.loads(path.read_text(encoding="utf-8")))
    else:
        summaries.append({"sampleId": sample_id, "status": "NO_SUMMARY", "NOT_FOR_RELEASE": True})
(output_root / "pilot-summary.json").write_text(
    json.dumps(
        {
            "workflow": "enrich-snapshot-pilot",
            "sequence": sample_ids,
            "samples": summaries,
            "releaseEligible": False,
            "NOT_FOR_RELEASE": True,
        },
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY

echo 'pilot completed; field gaps are observations, all artifacts are NOT_FOR_RELEASE' >&2
exit 0
