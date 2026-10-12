#!/usr/bin/env bash
# Build one complete release on WDC inside a fixed loop filesystem and cgroup.
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run-wdc-bounded-build.sh --control-root <dir> --run-id <digits> \
  --run-attempt <digits> --active-revision <id> --expected-content <64hex> \
  --expected-source-commit <40hex> --server-commit <40hex> \
  --build-logic-sha <64hex> --pg-port <port> --build-unit <unit> \
  --guard-unit <unit>
EOF
  exit 2
}

CONTROL_ROOT=""
RUN_ID=""
RUN_ATTEMPT=""
ACTIVE_REVISION=""
EXPECTED_CONTENT=""
EXPECTED_SOURCE_COMMIT=""
SERVER_COMMIT=""
BUILD_LOGIC_SHA=""
PG_PORT=""
BUILD_UNIT=""
GUARD_UNIT=""

while (($#)); do
  case "$1" in
    --control-root) CONTROL_ROOT="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --run-attempt) RUN_ATTEMPT="${2:-}"; shift 2 ;;
    --active-revision) ACTIVE_REVISION="${2:-}"; shift 2 ;;
    --expected-content) EXPECTED_CONTENT="${2:-}"; shift 2 ;;
    --expected-source-commit) EXPECTED_SOURCE_COMMIT="${2:-}"; shift 2 ;;
    --server-commit) SERVER_COMMIT="${2:-}"; shift 2 ;;
    --build-logic-sha) BUILD_LOGIC_SHA="${2:-}"; shift 2 ;;
    --pg-port) PG_PORT="${2:-}"; shift 2 ;;
    --build-unit) BUILD_UNIT="${2:-}"; shift 2 ;;
    --guard-unit) GUARD_UNIT="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

PROJECT_ROOT="/opt/culua/ytb-song-rank"
RELEASES_ROOT="$PROJECT_ROOT/releases"
SOURCE_ROOT="$CONTROL_ROOT/source"
VOLUME_CONTROL_ROOT="/var/tmp/dsl-wdc-volume-${RUN_ID}-${RUN_ATTEMPT}"
VOLUME_ROOT="$VOLUME_CONTROL_ROOT/volume"
VOLUME_IMAGE="$VOLUME_CONTROL_ROOT/build-volume.ext4"
LOOP_MARKER="$VOLUME_CONTROL_ROOT/.loop-device"
OWNER_MARKER="$CONTROL_ROOT/.codex-owned-run"
RESULT_JSON="$CONTROL_ROOT/build-result.json"
MATERIALIZE_LOG="$CONTROL_ROOT/materialize.log"
DATA_VERIFICATION="$CONTROL_ROOT/release-data-verification.json"
PROJECT_MAX_BYTES="40000000000"
HOST_RESERVE_BYTES="20000000000"
TEMP_VOLUME_BYTES="32000000000"
RELEASE_MAX_BYTES="16000000000"
CONTROL_BACKUP_BYTES="134217728"
MEMORY_MAX_BYTES="2684354560"
SWAP_MAX_BYTES="1073741824"

[[ "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || usage
[[ "$CONTROL_ROOT" == "$PROJECT_ROOT/.build/dsl-wdc-${RUN_ID}-${RUN_ATTEMPT}" ]] || usage
[[ "$ACTIVE_REVISION" =~ ^[A-Za-z0-9._:-]{1,200}$ ]] || usage
[[ "$EXPECTED_CONTENT" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$EXPECTED_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$SERVER_COMMIT" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$BUILD_LOGIC_SHA" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$PG_PORT" =~ ^[0-9]+$ ]] && ((PG_PORT > 0 && PG_PORT <= 65535)) || usage
[[ "$BUILD_UNIT" == "dsl-wdc-build-${RUN_ID}-${RUN_ATTEMPT}.service" ]] || usage
[[ "$GUARD_UNIT" == "dsl-wdc-storage-guard-${RUN_ID}-${RUN_ATTEMPT}" ]] || usage
[[ -d "$CONTROL_ROOT" && ! -L "$CONTROL_ROOT" && "$(readlink -f "$CONTROL_ROOT")" == "$CONTROL_ROOT" ]]
[[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]]
[[ "$(cat "$OWNER_MARKER")" == "${RUN_ID}:${RUN_ATTEMPT}" ]]
[[ ! -e "$VOLUME_CONTROL_ROOT" && ! -L "$VOLUME_CONTROL_ROOT" ]]
test ! -e "$VOLUME_IMAGE"
test ! -e "$RESULT_JSON"
install -d -m 0750 "$RELEASES_ROOT"

CHECKER="$SOURCE_ROOT/deploy/check-wdc-build-storage.py"
test -x "$CHECKER"
storage_check() {
  local phase="$1"
  shift
  python3 -B "$CHECKER" \
    --project-root "$PROJECT_ROOT" \
    --control-root "$CONTROL_ROOT" \
    --mount-root "$VOLUME_ROOT" \
    --image "$VOLUME_IMAGE" \
    --phase "$phase" \
    --project-max "$PROJECT_MAX_BYTES" \
    --host-reserve "$HOST_RESERVE_BYTES" \
    --temp-volume-bytes "$TEMP_VOLUME_BYTES" \
    --release-max "$RELEASE_MAX_BYTES" \
    --control-backup "$CONTROL_BACKUP_BYTES" \
    "$@"
}

storage_check preflight

CGROUP_RELATIVE="$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)"
[[ "$CGROUP_RELATIVE" == /* ]]
CGROUP_ROOT="/sys/fs/cgroup$CGROUP_RELATIVE"
ACTUAL_MEMORY_MAX="$(cat "$CGROUP_ROOT/memory.max")"
ACTUAL_SWAP_MAX="$(cat "$CGROUP_ROOT/memory.swap.max")"
read -r CPU_QUOTA CPU_PERIOD < "$CGROUP_ROOT/cpu.max"
[[ "$ACTUAL_MEMORY_MAX" == "$MEMORY_MAX_BYTES" ]]
[[ "$ACTUAL_SWAP_MAX" == "$SWAP_MAX_BYTES" ]]
[[ "$CPU_QUOTA" =~ ^[0-9]+$ && "$CPU_PERIOD" =~ ^[0-9]+$ ]]
((CPU_QUOTA * 1 == CPU_PERIOD * 3))
echo "WDC_CGROUP_LIMITS_OK memory=$ACTUAL_MEMORY_MAX swap=$ACTUAL_SWAP_MAX cpu=$CPU_QUOTA/$CPU_PERIOD"

LOOP_DEVICE=""
cleanup_volume() {
  local cleanup_rc=0
  systemctl stop "$GUARD_UNIT.service" >/dev/null 2>&1 || true
  if mountpoint -q "$VOLUME_ROOT"; then
    sync -f "$VOLUME_ROOT" || cleanup_rc=1
    umount "$VOLUME_ROOT" || cleanup_rc=1
  fi
  if [[ -n "$LOOP_DEVICE" && "$LOOP_DEVICE" =~ ^/dev/loop[0-9]+$ ]]; then
    if losetup "$LOOP_DEVICE" >/dev/null 2>&1; then
      losetup -d "$LOOP_DEVICE" || cleanup_rc=1
    fi
  fi
  if [[ -e "$VOLUME_IMAGE" ]]; then
    [[ -f "$VOLUME_IMAGE" && ! -L "$VOLUME_IMAGE" ]]
    rm -f -- "$VOLUME_IMAGE" || cleanup_rc=1
  fi
  rm -f -- "$LOOP_MARKER"
  if [[ -e "$VOLUME_CONTROL_ROOT" || -L "$VOLUME_CONTROL_ROOT" ]]; then
    [[ -d "$VOLUME_CONTROL_ROOT" && ! -L "$VOLUME_CONTROL_ROOT" ]]
    [[ "$(readlink -f "$VOLUME_CONTROL_ROOT")" == "$VOLUME_CONTROL_ROOT" ]]
    [[ "$(cat "$VOLUME_CONTROL_ROOT/.codex-owned-run")" == "${RUN_ID}:${RUN_ATTEMPT}" ]]
    rm -rf -- "$VOLUME_CONTROL_ROOT" || cleanup_rc=1
  fi
  return "$cleanup_rc"
}
finish() {
  local rc=$?
  trap - EXIT
  if ! cleanup_volume; then
    echo "WDC_VOLUME_CLEANUP_FAILED" >&2
    ((rc != 0)) || rc=76
  fi
  exit "$rc"
}
trap finish EXIT

install -d -m 0700 "$VOLUME_CONTROL_ROOT" "$VOLUME_ROOT"
printf '%s\n' "${RUN_ID}:${RUN_ATTEMPT}" > "$VOLUME_CONTROL_ROOT/.codex-owned-run"
chmod 0600 "$VOLUME_CONTROL_ROOT/.codex-owned-run"

truncate --size "$TEMP_VOLUME_BYTES" "$VOLUME_IMAGE"
chmod 0600 "$VOLUME_IMAGE"
[[ "$(stat -c %s "$VOLUME_IMAGE")" == "$TEMP_VOLUME_BYTES" ]]
LOOP_DEVICE="$(losetup --find --show --nooverlap --direct-io=on "$VOLUME_IMAGE")"
[[ "$LOOP_DEVICE" =~ ^/dev/loop[0-9]+$ ]]
LOOP_DIRECT_IO="$(losetup --list --noheadings --raw --output DIO "$LOOP_DEVICE")"
[[ "$LOOP_DIRECT_IO" == "1" ]]
echo "WDC_LOOP_DIRECT_IO_OK device=$LOOP_DEVICE dio=$LOOP_DIRECT_IO"
printf '%s\n' "$LOOP_DEVICE" > "$LOOP_MARKER"
chmod 0600 "$LOOP_MARKER"
mkfs.ext4 -q -F -m 0 -E lazy_itable_init=1,lazy_journal_init=1 "$LOOP_DEVICE"
mount -t ext4 -o nosuid,nodev "$LOOP_DEVICE" "$VOLUME_ROOT"
chmod 0700 "$VOLUME_ROOT"
printf '%s\n' "${RUN_ID}:${RUN_ATTEMPT}" > "$VOLUME_ROOT/.codex-owned-volume"
storage_check runtime

systemd-run --quiet --collect --unit="$GUARD_UNIT" \
  --property=NoNewPrivileges=yes \
  --property=MemoryMax=128M \
  --property=MemorySwapMax=64M \
  --property=TasksMax=16 \
  --property=RuntimeMaxSec=32400 \
  python3 -B "$CHECKER" \
    --project-root "$PROJECT_ROOT" \
    --control-root "$CONTROL_ROOT" \
    --mount-root "$VOLUME_ROOT" \
    --image "$VOLUME_IMAGE" \
    --phase runtime \
    --project-max "$PROJECT_MAX_BYTES" \
    --host-reserve "$HOST_RESERVE_BYTES" \
    --temp-volume-bytes "$TEMP_VOLUME_BYTES" \
    --release-max "$RELEASE_MAX_BYTES" \
    --control-backup "$CONTROL_BACKUP_BYTES" \
    --watch-unit "$BUILD_UNIT" \
    --interval 30

DEPS_ROOT="$VOLUME_ROOT/python-deps"
BUILD_ROOT="$VOLUME_ROOT/build"
PAGES_ROOT="$BUILD_ROOT/pages"
BUNDLES_ROOT="$BUILD_ROOT/bundles"
SERVING_DB="$BUILD_ROOT/serving.sqlite"
CANONICAL_SNAPSHOT="$BUILD_ROOT/canonical-runtime.sqlite"
META_FILE="$BUILD_ROOT/source-meta.json"
FRONTEND_ROOT="$BUILD_ROOT/frontend"
install -d -m 0700 "$DEPS_ROOT" "$BUILD_ROOT"

python3 -m pip install \
  --target "$DEPS_ROOT" \
  --only-binary=:all: \
  --require-hashes \
  --no-deps \
  --no-cache-dir \
  --no-compile \
  --timeout 30 \
  --retries 2 \
  -r "$SOURCE_ROOT/scripts/migration/requirements-wdc-linux.txt"
PYTHONPATH="$DEPS_ROOT:$SOURCE_ROOT/server:$SOURCE_ROOT" python3 -B - <<'PY'
import psycopg
if psycopg.__version__ != "3.3.4" or psycopg.pq.__impl__ != "binary":
    raise SystemExit("WDC run-local psycopg 3.3.4 binary driver required")
print("WDC_PG_DRIVER_OK", psycopg.__version__, psycopg.pq.__impl__)
PY
node --check "$SOURCE_ROOT/assets/app.js"
python3 -B "$SOURCE_ROOT/scripts/migration/prepare-wdc-frontend.py" \
  --app "$SOURCE_ROOT/assets/app.js" \
  --index "$SOURCE_ROOT/index.html" \
  --output "$FRONTEND_ROOT"
APP_RELATIVE="$(python3 - "$FRONTEND_ROOT/frontend-manifest.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8"))["appPath"])
PY
)"
[[ "$APP_RELATIVE" =~ ^assets/app-h[0-9a-f]{12}\.js$ ]]
node --check "$FRONTEND_ROOT/$APP_RELATIVE"
storage_check runtime

unset PGPASSWORD DAILY_SONG_POSTGRES_DSN
env \
  PYTHONUNBUFFERED=1 \
  PGHOST=127.0.0.1 \
  PGPORT="$PG_PORT" \
  PGDATABASE=song_rank \
  PGUSER=www-data \
  PGAPPNAME="dsl-wdc-snapshot-${RUN_ID}-${RUN_ATTEMPT}" \
  PYTHONPATH="$DEPS_ROOT:$SOURCE_ROOT/server:$SOURCE_ROOT" \
  python3 -B "$SOURCE_ROOT/scripts/migration/materialize-pg-release-snapshot.py" \
    --output "$PAGES_ROOT" \
    --meta-output "$META_FILE" \
    --snapshot-output "$CANONICAL_SNAPSHOT" \
    --expected-revision "$ACTIVE_REVISION" \
    2>&1 | tee "$MATERIALIZE_LOG"
test -s "$META_FILE"
test -s "$CANONICAL_SNAPSHOT"
python3 - "$META_FILE" "$ACTIVE_REVISION" "$EXPECTED_CONTENT" "$EXPECTED_SOURCE_COMMIT" <<'PY'
import json,sys
marker=json.load(open(sys.argv[1],encoding="utf-8"))
expected=tuple(sys.argv[2:5])
actual=(
    str(marker.get("active_revision_id") or ""),
    str(marker.get("content_sha256") or ""),
    str(marker.get("source_commit_sha") or ""),
)
if actual != expected:
    raise SystemExit(f"WDC_SOURCE_TRIPLET_MISMATCH actual={actual} expected={expected}")
if int(marker.get("ranking_rows") or 0) <= 0 or int(marker.get("source_occurrences") or 0) <= 0:
    raise SystemExit("WDC_SOURCE_COUNTS_INVALID")
print("WDC_PG_CANONICAL_SNAPSHOT_OK", *actual)
PY
cp -- "$META_FILE" "$CONTROL_ROOT/source-meta.json"
chmod 0600 "$CONTROL_ROOT/source-meta.json"
storage_check runtime

BUILT_AT="$(python3 - "$META_FILE" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8")).get("built_at") or "")
PY
)"
PARENT_REVISION="$(python3 - "$META_FILE" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8")).get("parent_revision_id") or "")
PY
)"
LATEST_EVENT_TIME="$(python3 - "$META_FILE" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8")).get("latest_generated_at") or "")
PY
)"
python3 -B "$SOURCE_ROOT/scripts/migration/build-serving-store.py" \
  --source-db "$CANONICAL_SNAPSHOT" \
  --ranking-root "$PAGES_ROOT" \
  --output "$SERVING_DB" \
  --active-revision-id "$ACTIVE_REVISION" \
  --required-ranges "7d,all" \
  --built-at "$BUILT_AT" \
  --consume-source-db
test -s "$SERVING_DB"
test ! -e "$CANONICAL_SNAPSHOT"
storage_check runtime

python3 -B "$SOURCE_ROOT/scripts/migration/build-release-bundle.py" \
  --input "$PAGES_ROOT" \
  --output "$BUNDLES_ROOT" \
  --serving-sqlite "$SERVING_DB" \
  --server-artifact "$SOURCE_ROOT/server/release_serving_server.py" \
  --frontend-root "$FRONTEND_ROOT" \
  --nginx-artifact "$SOURCE_ROOT/deploy/nginx-next-api.conf" \
  --systemd-artifact "$SOURCE_ROOT/deploy/daily-song-list-api.service" \
  --link-serving-sqlite \
  --active-revision-id "$ACTIVE_REVISION" \
  --expected-parent-revision-id "$PARENT_REVISION" \
  --source-commit-sha "$EXPECTED_SOURCE_COMMIT" \
  --server-commit-sha "$SERVER_COMMIT" \
  --build-logic-sha "$BUILD_LOGIC_SHA" \
  --generated-at "$BUILT_AT" \
  --latest-event-time "$LATEST_EVENT_TIME"

read -r RELEASE_SHA RELEASE_SIZE_BYTES < <(python3 - "$BUNDLES_ROOT" <<'PY'
import os,re,stat,sys
from pathlib import Path
root=Path(sys.argv[1]);children=list(root.iterdir())
if len(children)!=1 or children[0].is_symlink() or not children[0].is_dir():
    raise SystemExit("WDC_BUNDLE_ROOT_INVALID")
release=children[0]
if not re.fullmatch(r"[0-9a-f]{64}",release.name):
    raise SystemExit("WDC_BUNDLE_SHA_INVALID")
total=0
for directory,dirnames,filenames in os.walk(release,followlinks=False):
    for name in dirnames:
        if (Path(directory)/name).is_symlink():raise SystemExit("WDC_BUNDLE_SYMLINK")
    for name in filenames:
        path=Path(directory)/name;entry=path.lstat()
        if not stat.S_ISREG(entry.st_mode):raise SystemExit("WDC_BUNDLE_NON_REGULAR")
        total+=entry.st_size
print(release.name,total)
PY
)
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{64}$ ]]
[[ "$RELEASE_SIZE_BYTES" =~ ^[0-9]+$ ]] && ((RELEASE_SIZE_BYTES > 0 && RELEASE_SIZE_BYTES < RELEASE_MAX_BYTES))
RELEASE_IN_VOLUME="$BUNDLES_ROOT/$RELEASE_SHA"
python3 -B "$SOURCE_ROOT/deploy/verify-wdc-release-data.py" \
  --database "$RELEASE_IN_VOLUME/serving.sqlite" \
  --output "$DATA_VERIFICATION"
test -s "$DATA_VERIFICATION"
storage_check runtime

# Keep only the immutable release before the cross-filesystem copy.  The source
# SQLite remains alive through its hard link in the release directory.
for disposable in "$PAGES_ROOT" "$FRONTEND_ROOT" "$DEPS_ROOT"; do
  [[ "$disposable" == "$VOLUME_ROOT/"* && "$(readlink -m "$disposable")" == "$disposable" ]]
  rm -rf -- "$disposable"
done
rm -f -- "$SERVING_DB"
storage_check pre-copy --release-root "$RELEASE_IN_VOLUME"

FINAL_RELEASE="$RELEASES_ROOT/$RELEASE_SHA"
INCOMING_RELEASE="$RELEASES_ROOT/.incoming-${RELEASE_SHA}.${RUN_ID}-${RUN_ATTEMPT}"
INCOMING_OWNER="$INCOMING_RELEASE.owner"
[[ ! -e "$FINAL_RELEASE" && ! -L "$FINAL_RELEASE" ]]
[[ ! -e "$INCOMING_RELEASE" && ! -L "$INCOMING_RELEASE" ]]
[[ ! -e "$INCOMING_OWNER" && ! -L "$INCOMING_OWNER" ]]
printf '%s\n' "${RUN_ID}:${RUN_ATTEMPT}" > "$INCOMING_OWNER"
chmod 0600 "$INCOMING_OWNER"
install -d -m 0750 "$INCOMING_RELEASE"
cp -a --no-preserve=ownership -- "$RELEASE_IN_VOLUME/." "$INCOMING_RELEASE/"
sync -f "$INCOMING_RELEASE"
storage_check post-copy --release-root "$INCOMING_RELEASE"
mv -T -- "$INCOMING_RELEASE" "$FINAL_RELEASE"
chown -R daily-song-list:daily-song-list "$FINAL_RELEASE"
storage_check post-copy --release-root "$FINAL_RELEASE"

python3 - "$RESULT_JSON" "$RELEASE_SHA" "$RELEASE_SIZE_BYTES" "$APP_RELATIVE" \
  "$ACTIVE_REVISION" "$EXPECTED_CONTENT" "$EXPECTED_SOURCE_COMMIT" \
  "$SERVER_COMMIT" "$BUILD_LOGIC_SHA" "$DATA_VERIFICATION" <<'PY'
import json,os,sys,time
path=sys.argv[1]
verification=json.load(open(sys.argv[10],encoding="utf-8"))
payload={
    "releaseSha":sys.argv[2],
    "releaseSizeBytes":int(sys.argv[3]),
    "appRelative":sys.argv[4],
    "activeRevisionId":sys.argv[5],
    "contentSha256":sys.argv[6],
    "sourceCommitSha":sys.argv[7],
    "serverCommitSha":sys.argv[8],
    "buildLogicSha":sys.argv[9],
    "dataVerification":verification,
    "completedAt":int(time.time()),
}
temporary=f"{path}.{os.getpid()}.tmp"
descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
    os.write(descriptor,(json.dumps(payload,sort_keys=True)+"\n").encode())
    os.fsync(descriptor)
finally:os.close(descriptor)
os.replace(temporary,path)
print("WDC_SERVER_RELEASE_READY",payload["releaseSha"],payload["releaseSizeBytes"])
PY

systemctl stop "$GUARD_UNIT.service" >/dev/null 2>&1 || true
if [[ -s "$CONTROL_ROOT/storage-guard.failed.json" ]]; then
  echo "WDC_STORAGE_GUARD_REPORTED_FAILURE" >&2
  exit 75
fi
echo "WDC_BOUNDED_BUILD_OK sha=$RELEASE_SHA bytes=$RELEASE_SIZE_BYTES"
