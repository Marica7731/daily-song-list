#!/usr/bin/env bash
# Finalize one healthy release, retain current+previous, and prove disk headroom.
set -Eeuo pipefail

usage() {
  echo "usage: finalize-wdc-bounded-release.sh <release-sha> <previous-sha> <active-revision> <source-commit>" >&2
  exit 2
}

SHA="${1:-}"
PREVIOUS="${2:-}"
ACTIVE="${3:-}"
SOURCE_COMMIT="${4:-}"
[[ "$SHA" =~ ^[0-9a-f]{64}$ && "$PREVIOUS" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$ACTIVE" =~ ^[A-Za-z0-9._:-]{1,200}$ ]] || usage
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || usage

PROJECT_ROOT="/opt/culua/ytb-song-rank"
RELEASES_ROOT="$PROJECT_ROOT/releases"
INSTALLER="$PROJECT_ROOT/.build/dsl-wdc-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}/source/deploy/install-wdc-release.sh"
PROJECT_MAX="40000000000"
HOST_RESERVE="20000000000"
CURRENT_LINK="$RELEASES_ROOT/current"

[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ -x "$INSTALLER" && ! -L "$INSTALLER" ]]
[[ -d "$RELEASES_ROOT/$SHA" && ! -L "$RELEASES_ROOT/$SHA" ]]
[[ -d "$RELEASES_ROOT/$PREVIOUS" && ! -L "$RELEASES_ROOT/$PREVIOUS" ]]
[[ -L "$CURRENT_LINK" ]]
CURRENT_TARGET="$(readlink "$CURRENT_LINK")"
[[ "${CURRENT_TARGET##*/}" == "$SHA" ]]

systemctl is-active --quiet daily-song-list-api
systemctl is-active --quiet nginx
HEALTH="$(curl --silent --show-error --fail --max-time 10 http://127.0.0.1:18777/healthz)"
HEALTH_JSON="$HEALTH" python3 - "$SHA" "$ACTIVE" "$SOURCE_COMMIT" <<'PY'
import json,os,sys
data=json.loads(os.environ["HEALTH_JSON"])
expected=tuple(sys.argv[1:4])
actual=(
    str(data.get("releaseContentSha") or data.get("currentRelease") or ""),
    str(data.get("activeRevision") or ""),
    str(data.get("sourceCommit") or ""),
)
if data.get("status")!="ok" or actual!=expected:
    raise SystemExit(f"WDC_FINALIZE_HEALTH_MISMATCH actual={actual} expected={expected}")
print("WDC_FINALIZE_HEALTH_OK",*actual)
PY

python3 - "$RELEASES_ROOT" "$SHA" "$PREVIOUS" <<'PY'
import re,shutil,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
if root != Path("/opt/culua/ytb-song-rank/releases"):
    raise SystemExit(f"WDC_RETENTION_ROOT_UNSAFE root={root}")
keep={sys.argv[2],sys.argv[3]}
removed=[]
for candidate in root.iterdir():
    if not re.fullmatch(r"[0-9a-f]{64}",candidate.name) or candidate.name in keep:
        continue
    if candidate.is_symlink() or not candidate.is_dir():
        raise SystemExit(f"WDC_RETENTION_CANDIDATE_UNSAFE path={candidate}")
    resolved=candidate.resolve()
    if resolved.parent != root or resolved.name != candidate.name:
        raise SystemExit(f"WDC_RETENTION_REALPATH_UNSAFE path={candidate} real={resolved}")
    shutil.rmtree(candidate)
    removed.append(candidate.name)
print("WDC_RELEASE_RETENTION_OK",sorted(keep),sorted(removed))
PY

PROJECT_BYTES="$(du -sb -- "$PROJECT_ROOT" | awk '{print $1}')"
AVAILABLE_BYTES="$(python3 - "$PROJECT_ROOT" <<'PY'
import os,sys
stats=os.statvfs(sys.argv[1])
print(stats.f_bavail*stats.f_frsize)
PY
)"
[[ "$PROJECT_BYTES" =~ ^[0-9]+$ && "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]
((PROJECT_BYTES < PROJECT_MAX)) || {
  echo "WDC_FINAL_PROJECT_LIMIT_EXCEEDED bytes=$PROJECT_BYTES max=$PROJECT_MAX" >&2
  exit 74
}
((AVAILABLE_BYTES >= HOST_RESERVE)) || {
  echo "WDC_FINAL_HOST_RESERVE_VIOLATION available=$AVAILABLE_BYTES reserve=$HOST_RESERVE" >&2
  exit 75
}
echo "WDC_FINAL_STORAGE_OK project=$PROJECT_BYTES max=$PROJECT_MAX available=$AVAILABLE_BYTES reserve=$HOST_RESERVE"

# The rollback record is removed only after health, retention, and capacity all
# pass.  Any earlier failure therefore still has a complete rollback path.
"$INSTALLER" \
  --action finalize \
  --sha "$SHA" \
  --releases-root "$RELEASES_ROOT" \
  --server-path "$PROJECT_ROOT/server/release_serving_server.py" \
  --static-root "$PROJECT_ROOT/static" \
  --service-unit-path /etc/systemd/system/daily-song-list-api.service \
  --nginx-available-path /etc/nginx/sites-available/next.ytb-song-rank.culua.com.conf \
  --nginx-enabled-path /etc/nginx/sites-enabled/next.ytb-song-rank.culua.com.conf \
  --service daily-song-list-api
