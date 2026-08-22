#!/usr/bin/env bash
# Ubuntu controller for one bounded VPS2 -> WDC build and public release.
set -Eeuo pipefail

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || { echo "WDC_CONTROLLER_ENV_MISSING name=$name" >&2; exit 2; }
}
for name in GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_SHA RUNNER_TEMP SSH_ROOT \
  VPS2_HOST VPS2_USER WDC_HOST WDC_USER FORCE; do
  require_env "$name"
done
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$FORCE" =~ ^(true|false)$ ]]
[[ "$VPS2_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,31}$ ]]
[[ "$WDC_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,31}$ ]]
[[ "$VPS2_HOST" =~ ^[A-Za-z0-9._:-]{1,253}$ && "$WDC_HOST" =~ ^[A-Za-z0-9._:-]{1,253}$ ]]
[[ -d "$SSH_ROOT" && ! -L "$SSH_ROOT" ]]
[[ "$(cat "$SSH_ROOT/.codex-owned-run")" == "${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}" ]]
for required in vps2-password vps2-knownhosts vps2-askpass.sh wdc-key wdc-knownhosts; do
  [[ -f "$SSH_ROOT/$required" && ! -L "$SSH_ROOT/$required" ]]
done

export SSH_ASKPASS="$SSH_ROOT/vps2-askpass.sh"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY=daily-song-list-controller
VPS2_SSH=(
  -o BatchMode=no
  -o NumberOfPasswordPrompts=1
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$SSH_ROOT/vps2-knownhosts"
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
)
WDC_SSH=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$SSH_ROOT/wdc-knownhosts"
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -i "$SSH_ROOT/wdc-key"
)

vps2() {
  timeout 40s ssh "${VPS2_SSH[@]}" "$VPS2_USER@$VPS2_HOST" "$@"
}
vps2_source_meta() {
  local attempt output rc
  for attempt in 1 2; do
    if output="$(timeout 75s ssh "${VPS2_SSH[@]}" "$VPS2_USER@$VPS2_HOST" "$@")"; then
      printf '%s' "$output"
      return 0
    else
      rc=$?
    fi
    case "$rc" in
      28|124|255) ;;
      *) return "$rc" ;;
    esac
    if ((attempt == 1)); then
      echo "PG_SOURCE_META_RETRY attempt=$attempt status=$rc" >&2
      continue
    fi
    return "$rc"
  done
  return 70
}
wdc() {
  timeout 40s ssh "${WDC_SSH[@]}" "$WDC_USER@$WDC_HOST" "$@"
}

PROJECT_ROOT="/opt/culua/ytb-song-rank"
RELEASES_ROOT="$PROJECT_ROOT/releases"
CONTROL_ROOT="$PROJECT_ROOT/.build/dsl-wdc-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
SECRET_ROOT="/run/dsl-wdc-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
SOURCE_ROOT="$CONTROL_ROOT/source"
RELAY_ROOT="/tmp/dsl-pg-relay-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
RELAY_UNIT="dsl-wdc-pg-relay-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
TUNNEL_UNIT="dsl-wdc-pg-tunnel-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
BUILD_UNIT="dsl-wdc-build-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
GUARD_UNIT="dsl-wdc-storage-guard-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
APP_NAME="dsl-wdc-snapshot-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
OWNER="${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}"
LOCAL_STAGE="$SSH_ROOT/source-stage"
JOB_STATUS="failure"
RELAY_CREATED=0
CONTROL_CREATED=0
ACTIVATED=0
FINALIZED=0
CLEANUP_DONE=0
RELEASE_SHA=""
PREVIOUS_RELEASE=""

cleanup_resources() {
  local original_rc=$? cleanup_rc=0
  if ((CLEANUP_DONE)); then
    return "$original_rc"
  fi
  CLEANUP_DONE=1
  set +e

  if ((ACTIVATED)) && ((!FINALIZED)); then
    wdc env GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" \
      "$SOURCE_ROOT/deploy/install-wdc-release.sh" \
        --action rollback \
        --sha "$RELEASE_SHA" \
        --releases-root "$RELEASES_ROOT" \
        --server-path "$PROJECT_ROOT/server/release_serving_server.py" \
        --static-root "$PROJECT_ROOT/static" \
        --service-unit-path /etc/systemd/system/daily-song-list-api.service \
        --nginx-available-path /etc/nginx/sites-available/next.ytb-song-rank.culua.com.conf \
        --nginx-enabled-path /etc/nginx/sites-enabled/next.ytb-song-rank.culua.com.conf \
        --service daily-song-list-api || cleanup_rc=1
  fi

  if ((CONTROL_CREATED)); then
    if wdc test -x "$SOURCE_ROOT/deploy/cleanup-wdc-bounded-build.sh"; then
      wdc "$SOURCE_ROOT/deploy/cleanup-wdc-bounded-build.sh" \
        "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$JOB_STATUS" "$RELEASE_SHA" || cleanup_rc=1
    else
      wdc bash -s -- "$CONTROL_ROOT" "$SECRET_ROOT" "$OWNER" \
        "$BUILD_UNIT" "$GUARD_UNIT" "$TUNNEL_UNIT" <<'REMOTE' || cleanup_rc=1
set -Eeuo pipefail
control="$1";secret="$2";owner="$3";build="$4";guard="$5";tunnel="$6"
for unit in "$guard" "$build" "$tunnel"; do
  systemctl stop "$unit.service" >/dev/null 2>&1 || true
done
run="${owner%%:*}";attempt="${owner##*:}"
[[ "$run" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]]
volume_control="/var/tmp/dsl-wdc-volume-${run}-${attempt}"
if [[ -e "$volume_control" || -L "$volume_control" ]]; then
  [[ -d "$volume_control" && ! -L "$volume_control" && "$(readlink -f "$volume_control")" == "$volume_control" ]]
  [[ "$(cat "$volume_control/.codex-owned-run")" == "$owner" ]]
  volume="$volume_control/volume";image="$volume_control/build-volume.ext4"
  mountpoint -q "$volume" && umount "$volume"
  if [[ -e "$image" ]]; then
    mapfile -t loops < <(losetup -j "$image" | cut -d: -f1)
    ((${#loops[@]} <= 1))
    ((${#loops[@]} == 0)) || losetup -d "${loops[0]}"
  fi
  rm -rf -- "$volume_control"
fi
if [[ -d "$control" && ! -L "$control" && "$(cat "$control/.codex-owned-run")" == "$owner" ]]; then
  rm -rf -- "$control"
fi
if [[ -d "$secret" && ! -L "$secret" && "$(cat "$secret/.codex-owned-run")" == "$owner" ]]; then
  rm -rf -- "$secret"
fi
REMOTE
    fi
  fi

  if ((RELAY_CREATED)); then
    vps2 bash -s -- "$RELAY_ROOT" "$RELAY_UNIT" "$APP_NAME" "$OWNER" <<'REMOTE' || cleanup_rc=1
set -Eeuo pipefail
root="$1";unit="$2";app="$3";owner="$4"
systemctl stop "$unit.service" >/dev/null 2>&1 || true
systemctl is-active --quiet "$unit.service" && exit 76
runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$app' AND pid <> pg_backend_pid()" >/dev/null
remaining="$(runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$app'")"
[[ "$remaining" == "0" ]]
if [[ -e "$root" || -L "$root" ]]; then
  [[ -d "$root" && ! -L "$root" && "$(readlink -f "$root")" == "$root" ]]
  [[ "$(cat "$root/.codex-owned-run")" == "$owner" ]]
  rm -rf -- "$root"
fi
systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
echo "VPS2_BOUNDED_RELAY_CLEAN unit=$unit"
REMOTE
  fi
  set -e
  if ((cleanup_rc)); then
    echo "WDC_CONTROLLER_CLEANUP_INCOMPLETE" >&2
    if ((original_rc == 0)); then
      return 76
    fi
  fi
  return "$original_rc"
}
trap cleanup_resources EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A scheduled workflow can wait behind another writer long enough for main to
# advance.  Refuse every remote write unless this checkout is still the unique
# latest main head.  A stale run is a clean no-op, not a failed release that
# should be blindly retried.
LOCAL_HEAD="$(git rev-parse HEAD)"
LATEST_MAIN_SHA="$(timeout 30s git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[[ "$LOCAL_HEAD" =~ ^[0-9a-f]{40}$ && "$LATEST_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$LOCAL_HEAD" == "$GITHUB_SHA" ]] || {
  echo "WDC_CHECKOUT_HEAD_MISMATCH checkout=$LOCAL_HEAD event=$GITHUB_SHA" >&2
  exit 75
}
if [[ "$LATEST_MAIN_SHA" != "$GITHUB_SHA" ]]; then
  JOB_STATUS="success"
  echo "WDC_STALE_HEAD_NO_WRITE event=$GITHUB_SHA latest=$LATEST_MAIN_SHA"
  exit 0
fi
echo "WDC_LATEST_HEAD_CONFIRMED sha=$GITHUB_SHA"

SOURCE_FILES=(
  server/release_serving_server.py
  server/pg_adapter.py
  scripts/migration/7d-json-to-patch.py
  scripts/migration/materialize-pg-release-snapshot.py
  scripts/migration/materialize-ranking-pages.py
  scripts/migration/build-serving-store.py
  scripts/migration/build-release-bundle.py
  scripts/migration/prepare-wdc-frontend.py
  scripts/migration/patch-next-frontend.py
  scripts/migration/pg-peer-relay.py
  scripts/migration/requirements-wdc-linux.txt
  deploy/check-wdc-build-storage.py
  deploy/cleanup-wdc-bounded-build.sh
  deploy/daily-song-list-api.service
  deploy/finalize-wdc-bounded-release.sh
  deploy/install-wdc-release.sh
  deploy/nginx-next-api.conf
  deploy/run-wdc-bounded-build.sh
  deploy/start-wdc-pg-tunnel.sh
  deploy/verify-wdc-public-release.py
  deploy/verify-wdc-release-data.py
  deploy/wdc-vps2-askpass.sh
  assets/app.js
  index.html
  .github/workflows/sync-wdc-release.yml
)
for file in "${SOURCE_FILES[@]}"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "WDC_SOURCE_FILE_MISSING path=$file" >&2; exit 65; }
done
BUILD_LOGIC_SHA="$({
  for file in "${SOURCE_FILES[@]}"; do sha256sum -- "$file"; done
} | sha256sum | awk '{print $1}')"
[[ "$BUILD_LOGIC_SHA" =~ ^[0-9a-f]{64}$ ]]
echo "WDC_BUILD_LOGIC_SHA $BUILD_LOGIC_SHA"

META_JSON="$(vps2_source_meta "timeout 65 curl --silent --show-error --fail --max-time 60 http://127.0.0.1:8765/api/meta")"
mapfile -t META_FIELDS < <(META_JSON="$META_JSON" python3 - <<'PY'
import json,os
meta=(json.loads(os.environ["META_JSON"]).get("meta") or {})
print(meta.get("active_revision_id") or meta.get("activeRevisionId") or "")
print(meta.get("content_sha256") or meta.get("contentSha256") or "")
print(meta.get("source_commit_sha") or meta.get("sourceCommitSha") or "")
PY
)
ACTIVE="${META_FIELDS[0]:-}"
EXPECTED_CONTENT="${META_FIELDS[1]:-}"
EXPECTED_SOURCE_COMMIT="${META_FIELDS[2]:-}"
[[ "$ACTIVE" =~ ^[A-Za-z0-9._:-]{1,200}$ ]]
[[ "$EXPECTED_CONTENT" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]
echo "PG_SOURCE_IDENTITY active=$ACTIVE content=${EXPECTED_CONTENT:0:16} source=${EXPECTED_SOURCE_COMMIT:0:16}"

DEPLOYED_HEALTH="$(wdc "curl --silent --show-error --fail --max-time 10 http://127.0.0.1:18777/healthz")"
mapfile -t DEPLOYED_FIELDS < <(HEALTH_JSON="$DEPLOYED_HEALTH" python3 - <<'PY'
import json,os
data=json.loads(os.environ["HEALTH_JSON"])
print(data.get("status") or "")
print(data.get("releaseContentSha") or data.get("currentRelease") or "")
print(data.get("activeRevision") or "")
print(data.get("sourceCommit") or "")
print(data.get("buildLogicSha") or "")
PY
)
[[ "${DEPLOYED_FIELDS[0]:-}" == "ok" ]]
PREVIOUS_RELEASE="${DEPLOYED_FIELDS[1]:-}"
[[ "$PREVIOUS_RELEASE" =~ ^[0-9a-f]{64}$ ]]
if [[ "${DEPLOYED_FIELDS[2]:-}" == "$ACTIVE" \
   && "${DEPLOYED_FIELDS[3]:-}" == "$EXPECTED_SOURCE_COMMIT" \
   && "${DEPLOYED_FIELDS[4]:-}" == "$BUILD_LOGIC_SHA" ]]; then
  JOB_STATUS="success"
  echo "WDC_NO_CHANGE active=$ACTIVE release=$PREVIOUS_RELEASE logic=$BUILD_LOGIC_SHA"
  exit 0
fi

LATENCY_BASELINE="$SSH_ROOT/wdc-public-latency-before.json"
test ! -e "$LATENCY_BASELINE"
python3 -B deploy/verify-wdc-public-release.py \
  --release-sha "$PREVIOUS_RELEASE" \
  --capture-latency-output "$LATENCY_BASELINE"
test -s "$LATENCY_BASELINE"

vps2 bash -s -- "$RELAY_ROOT" "$RELAY_UNIT" "$OWNER" <<'REMOTE'
set -Eeuo pipefail
root="$1";unit="$2";owner="$3"
[[ "$root" =~ ^/tmp/dsl-pg-relay-[0-9]+-[0-9]+$ ]]
[[ "$unit" =~ ^dsl-wdc-pg-relay-[0-9]+-[0-9]+$ ]]
test ! -e "$root"
install -d -o www-data -g www-data -m 0750 "$root"
printf '%s\n' "$owner" > "$root/.codex-owned-run"
chown www-data:www-data "$root/.codex-owned-run"
chmod 0600 "$root/.codex-owned-run"
REMOTE
RELAY_CREATED=1
timeout 60s scp "${VPS2_SSH[@]}" scripts/migration/pg-peer-relay.py \
  "$VPS2_USER@$VPS2_HOST:$RELAY_ROOT/pg-peer-relay.py.part"
vps2 bash -s -- "$RELAY_ROOT" "$RELAY_UNIT" <<'REMOTE'
set -Eeuo pipefail
root="$1";unit="$2"
chown www-data:www-data "$root/pg-peer-relay.py.part"
chmod 0500 "$root/pg-peer-relay.py.part"
mv "$root/pg-peer-relay.py.part" "$root/pg-peer-relay.py"
systemd-run --quiet --unit="$unit" \
  --property=User=www-data \
  --property=Group=www-data \
  --property=MemoryMax=134217728 \
  --property=MemorySwapMax=0 \
  --property=CPUQuota=100% \
  --property=TasksMax=16 \
  --property=RuntimeMaxSec=32400 \
  python3 -B "$root/pg-peer-relay.py" \
    --listen-host 127.0.0.1 \
    --listen-port 0 \
    --socket /var/run/postgresql/.s.PGSQL.5432 \
    --require-user www-data \
    --max-connections 2 \
    --max-bytes 16000000000 \
    --ready-file "$root/ready.json" \
    --stats-file "$root/stats.json"
for _ in $(seq 1 30); do
  [[ -s "$root/ready.json" ]] && break
  systemctl is-failed --quiet "$unit.service" && exit 76
  sleep 2
done
test -s "$root/ready.json"
REMOTE
RELAY_READY="$(vps2 "cat '$RELAY_ROOT/ready.json'")"
RELAY_PORT="$(READY_JSON="$RELAY_READY" python3 - <<'PY'
import json,os
data=json.loads(os.environ["READY_JSON"])
assert data["host"]=="127.0.0.1"
assert data["maxConnections"]==2
assert data["maxBytes"]==16_000_000_000
port=int(data["port"]);assert 0<port<=65535
print(port)
PY
)"
echo "VPS2_RELAY_READY unit=$RELAY_UNIT port=$RELAY_PORT maxBytes=16000000000 maxConnections=2"

wdc bash -s -- "$PROJECT_ROOT" "$CONTROL_ROOT" "$SECRET_ROOT" "$OWNER" <<'REMOTE'
set -Eeuo pipefail
project="$1";control="$2";secret="$3";owner="$4"
[[ "$project" == "/opt/culua/ytb-song-rank" ]]
[[ "$control" =~ ^/opt/culua/ytb-song-rank/\.build/dsl-wdc-[0-9]+-[0-9]+$ ]]
[[ "$secret" =~ ^/run/dsl-wdc-[0-9]+-[0-9]+$ ]]
test ! -e "$control";test ! -e "$secret"
install -d -m 0700 "$project/.build" "$control" "$control/source" "$secret"
printf '%s\n' "$owner" > "$control/.codex-owned-run"
printf '%s\n' "$owner" > "$secret/.codex-owned-run"
chmod 0600 "$control/.codex-owned-run" "$secret/.codex-owned-run"
REMOTE
CONTROL_CREATED=1

test ! -e "$LOCAL_STAGE"
install -d -m 0700 "$LOCAL_STAGE"
for file in "${SOURCE_FILES[@]}"; do
  install -D -m 0600 "$file" "$LOCAL_STAGE/$file"
done
(
  cd "$LOCAL_STAGE"
  find . -type f ! -name source-manifest.sha256 -print0 \
    | sort -z \
    | xargs -0 sha256sum > source-manifest.sha256
)
STAGE_BYTES="$(du -sb -- "$LOCAL_STAGE" | awk '{print $1}')"
[[ "$STAGE_BYTES" =~ ^[0-9]+$ ]] && ((STAGE_BYTES > 0 && STAGE_BYTES < 100000000))
SOURCE_TREE_SHA="$(sha256sum "$LOCAL_STAGE/source-manifest.sha256" | awk '{print $1}')"
tar -C "$LOCAL_STAGE" -cf - . \
  | timeout 120s ssh "${WDC_SSH[@]}" "$WDC_USER@$WDC_HOST" \
      "tar -C '$SOURCE_ROOT' -xf -"
wdc bash -s -- "$SOURCE_ROOT" "$SOURCE_TREE_SHA" "$STAGE_BYTES" <<'REMOTE'
set -Eeuo pipefail
root="$1";expected="$2";expected_bytes="$3"
[[ "$root" =~ ^/opt/culua/ytb-song-rank/\.build/dsl-wdc-[0-9]+-[0-9]+/source$ ]]
test ! -e "$root/.git"
actual="$(sha256sum "$root/source-manifest.sha256" | awk '{print $1}')"
[[ "$actual" == "$expected" ]]
(cd "$root" && sha256sum -c source-manifest.sha256)
actual_bytes="$(du -sb -- "$root" | awk '{print $1}')"
((actual_bytes < 100000000 && expected_bytes < 100000000))
chmod 0500 "$root"/deploy/*.sh "$root"/deploy/*.py "$root/scripts/migration/pg-peer-relay.py"
echo "WDC_HASHED_SPARSE_SOURCE_OK sha=$actual bytes=$actual_bytes"
REMOTE

timeout 60s scp "${WDC_SSH[@]}" "$SSH_ROOT/vps2-password" \
  "$WDC_USER@$WDC_HOST:$SECRET_ROOT/vps2-password.part"
timeout 60s scp "${WDC_SSH[@]}" "$SSH_ROOT/vps2-knownhosts" \
  "$WDC_USER@$WDC_HOST:$SECRET_ROOT/vps2-knownhosts.part"
wdc bash -s -- "$SECRET_ROOT" "$OWNER" <<'REMOTE'
set -Eeuo pipefail
secret="$1";owner="$2"
[[ "$(cat "$secret/.codex-owned-run")" == "$owner" ]]
for name in vps2-password vps2-knownhosts; do
  [[ -f "$secret/$name.part" && ! -L "$secret/$name.part" ]]
  chmod 0600 "$secret/$name.part"
  mv "$secret/$name.part" "$secret/$name"
done
REMOTE

LOCAL_PORT="$((24000 + (GITHUB_RUN_ID % 10000)))"
wdc python3 - "$LOCAL_PORT" <<'PY'
import socket,sys
port=int(sys.argv[1])
with socket.socket() as server:
    server.bind(("127.0.0.1",port))
print("WDC_TUNNEL_PORT_AVAILABLE",port)
PY
wdc systemd-run --quiet --unit="$TUNNEL_UNIT" \
  --property=Restart=on-failure \
  --property=RestartSec=3 \
  --property=MemoryMax=134217728 \
  --property=MemorySwapMax=0 \
  --property=CPUQuota=50% \
  --property=TasksMax=16 \
  --property=RuntimeMaxSec=32400 \
  "$SOURCE_ROOT/deploy/start-wdc-pg-tunnel.sh" \
    "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$VPS2_USER" "$VPS2_HOST" \
    "$RELAY_PORT" "$LOCAL_PORT"
wdc python3 - "$LOCAL_PORT" "$TUNNEL_UNIT" <<'PY'
import socket,subprocess,sys,time
port=int(sys.argv[1]);unit=sys.argv[2]
for _ in range(30):
    if subprocess.run(["systemctl","is-failed","--quiet",unit+".service"]).returncode==0:
        raise SystemExit("WDC_PG_TUNNEL_FAILED")
    try:
        with socket.create_connection(("127.0.0.1",port),timeout=2):
            print("WDC_DIRECT_PG_TUNNEL_READY",port)
            break
    except OSError:
        time.sleep(2)
else:raise SystemExit("WDC_PG_TUNNEL_NOT_READY")
PY

wdc systemd-run --quiet --unit="$BUILD_UNIT" \
  --property=MemoryMax=2684354560 \
  --property=MemorySwapMax=1073741824 \
  --property=CPUQuota=300% \
  --property=IOWeight=100 \
  --property=TasksMax=96 \
  --property=RuntimeMaxSec=32400 \
  --property="StandardOutput=append:$CONTROL_ROOT/build.log" \
  --property="StandardError=append:$CONTROL_ROOT/build.log" \
  "$SOURCE_ROOT/deploy/run-wdc-bounded-build.sh" \
    --control-root "$CONTROL_ROOT" \
    --run-id "$GITHUB_RUN_ID" \
    --run-attempt "$GITHUB_RUN_ATTEMPT" \
    --active-revision "$ACTIVE" \
    --expected-content "$EXPECTED_CONTENT" \
    --expected-source-commit "$EXPECTED_SOURCE_COMMIT" \
    --server-commit "$GITHUB_SHA" \
    --build-logic-sha "$BUILD_LOGIC_SHA" \
    --pg-port "$LOCAL_PORT" \
    --build-unit "$BUILD_UNIT.service" \
    --guard-unit "$GUARD_UNIT"

BUILD_DEADLINE=$((SECONDS + 32400))
POLL_COUNT=0
while ((SECONDS < BUILD_DEADLINE)); do
  BUILD_STATE="$(wdc bash -s -- "$BUILD_UNIT" "$CONTROL_ROOT" <<'REMOTE'
set -Eeuo pipefail
unit="$1";root="$2"
if systemctl is-active --quiet "$unit.service"; then
  echo active
elif systemctl is-failed --quiet "$unit.service"; then
  status="$(systemctl show "$unit.service" -p ExecMainStatus --value)"
  echo "failed:$status"
elif [[ -s "$root/build-result.json" ]]; then
  echo complete
else
  echo missing
fi
REMOTE
)"
  case "$BUILD_STATE" in
    complete) break ;;
    failed:*)
      wdc "tail -n 120 '$CONTROL_ROOT/build.log' 2>/dev/null || true" || true
      wdc "journalctl -u '$BUILD_UNIT.service' -n 120 --no-pager 2>/dev/null || true" || true
      echo "WDC_BUILD_UNIT_FAILED state=$BUILD_STATE" >&2
      exit 75
      ;;
    active)
      if ((POLL_COUNT % 3 == 0)); then
        wdc "tail -n 8 '$CONTROL_ROOT/materialize.log' '$CONTROL_ROOT/build.log' 2>/dev/null || true" || true
        wdc "journalctl -u '$GUARD_UNIT.service' -n 1 --no-pager 2>/dev/null || true" || true
      fi
      ;;
    missing)
      if ((POLL_COUNT > 3)); then
        echo "WDC_BUILD_UNIT_DISAPPEARED_WITHOUT_RESULT" >&2
        exit 75
      fi
      ;;
    *) echo "WDC_BUILD_STATE_INVALID state=$BUILD_STATE" >&2; exit 75 ;;
  esac
  POLL_COUNT=$((POLL_COUNT + 1))
  sleep 20
done
[[ "$BUILD_STATE" == "complete" ]] || { echo "WDC_BUILD_DEADLINE_EXCEEDED" >&2; exit 75; }

BUILD_RESULT="$(wdc "cat '$CONTROL_ROOT/build-result.json'")"
mapfile -t RESULT_FIELDS < <(RESULT_JSON="$BUILD_RESULT" python3 - \
  "$ACTIVE" "$EXPECTED_CONTENT" "$EXPECTED_SOURCE_COMMIT" "$GITHUB_SHA" "$BUILD_LOGIC_SHA" <<'PY'
import json,os,re,sys
data=json.loads(os.environ["RESULT_JSON"])
expected=tuple(sys.argv[1:6])
actual=tuple(str(data.get(key) or "") for key in (
    "activeRevisionId","contentSha256","sourceCommitSha","serverCommitSha","buildLogicSha"
))
if actual!=expected:raise SystemExit(f"WDC_BUILD_RESULT_IDENTITY_MISMATCH actual={actual} expected={expected}")
sha=str(data.get("releaseSha") or "");size=int(data.get("releaseSizeBytes") or 0)
if not re.fullmatch(r"[0-9a-f]{64}",sha) or not 0<size<16_000_000_000:
    raise SystemExit("WDC_BUILD_RESULT_RELEASE_INVALID")
probe=((data.get("dataVerification") or {}).get("crossPageProbe") or {})
key=str(probe.get("sourceKey") or "")
if not re.fullmatch(r"[0-9a-f]{16,64}",key) or int(probe.get("videos") or 0)!=31:
    raise SystemExit("WDC_BUILD_RESULT_PROBE_INVALID")
print(sha);print(size);print(key)
PY
)
RELEASE_SHA="${RESULT_FIELDS[0]}"
RELEASE_SIZE="${RESULT_FIELDS[1]}"
PROBE_SOURCE_KEY="${RESULT_FIELDS[2]}"
echo "WDC_SERVER_BUILD_RESULT_OK sha=$RELEASE_SHA bytes=$RELEASE_SIZE probe=$PROBE_SOURCE_KEY"

RELAY_STATS="$(vps2 "cat '$RELAY_ROOT/stats.json'")"
STATS_JSON="$RELAY_STATS" python3 - <<'PY'
import json,os
data=json.loads(os.environ["STATS_JSON"])
assert data["maxBytes"]==16_000_000_000,data
assert data["bytesForwarded"]<=data["maxBytes"],data
assert data["byteLimitExceeded"] is False,data
assert data["maxConnections"]==2,data
print("VPS2_RELAY_BUDGET_OK",data["bytesForwarded"],data["maxBytes"],data["connectionsAccepted"])
PY

LATEST_META="$(vps2 "timeout 65 curl --silent --show-error --fail --max-time 60 http://127.0.0.1:8765/api/meta")"
META_JSON="$LATEST_META" python3 - "$ACTIVE" "$EXPECTED_CONTENT" "$EXPECTED_SOURCE_COMMIT" <<'PY'
import json,os,sys
meta=(json.loads(os.environ["META_JSON"]).get("meta") or {})
actual=(str(meta.get("active_revision_id") or ""),str(meta.get("content_sha256") or ""),str(meta.get("source_commit_sha") or ""))
expected=tuple(sys.argv[1:4])
if actual!=expected:raise SystemExit(f"SOURCE_TRIPLET_DRIFT_BEFORE_ACTIVATE actual={actual} expected={expected}")
print("SOURCE_TRIPLET_STABLE_BEFORE_ACTIVATE",*actual)
PY

LATEST_MAIN_BEFORE_ACTIVATE="$(timeout 30s git ls-remote --exit-code origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[[ "$LATEST_MAIN_BEFORE_ACTIVATE" =~ ^[0-9a-f]{40}$ ]]
if [[ "$LATEST_MAIN_BEFORE_ACTIVATE" != "$GITHUB_SHA" ]]; then
  JOB_STATUS="skipped"
  echo "WDC_STALE_HEAD_BEFORE_ACTIVATE event=$GITHUB_SHA latest=$LATEST_MAIN_BEFORE_ACTIVATE"
  exit 0
fi
echo "WDC_LATEST_HEAD_STABLE_BEFORE_ACTIVATE sha=$GITHUB_SHA"

wdc "$SOURCE_ROOT/deploy/install-wdc-release.sh" \
  --action activate \
  --sha "$RELEASE_SHA" \
  --releases-root "$RELEASES_ROOT" \
  --server-path "$PROJECT_ROOT/server/release_serving_server.py" \
  --static-root "$PROJECT_ROOT/static" \
  --service-unit-path /etc/systemd/system/daily-song-list-api.service \
  --nginx-available-path /etc/nginx/sites-available/next.ytb-song-rank.culua.com.conf \
  --nginx-enabled-path /etc/nginx/sites-enabled/next.ytb-song-rank.culua.com.conf \
  --service daily-song-list-api \
  --expected-server-commit "$GITHUB_SHA" \
  --expected-build-logic-sha "$BUILD_LOGIC_SHA" \
  --previous-release-sha "$PREVIOUS_RELEASE" \
  --port 18777
ACTIVATED=1

POST_ACTIVATE_META="$(vps2 "timeout 65 curl --silent --show-error --fail --max-time 60 http://127.0.0.1:8765/api/meta")"
META_JSON="$POST_ACTIVATE_META" python3 - "$ACTIVE" "$EXPECTED_CONTENT" "$EXPECTED_SOURCE_COMMIT" <<'PY'
import json,os,sys
meta=(json.loads(os.environ["META_JSON"]).get("meta") or {})
actual=(str(meta.get("active_revision_id") or ""),str(meta.get("content_sha256") or ""),str(meta.get("source_commit_sha") or ""))
expected=tuple(sys.argv[1:4])
if actual!=expected:raise SystemExit(f"SOURCE_TRIPLET_DRIFT_AFTER_ACTIVATE actual={actual} expected={expected}")
print("SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE",*actual)
PY

python3 -B deploy/verify-wdc-public-release.py \
  --release-sha "$RELEASE_SHA" \
  --build-logic-sha "$BUILD_LOGIC_SHA" \
  --server-commit "$GITHUB_SHA" \
  --active-revision "$ACTIVE" \
  --source-commit "$EXPECTED_SOURCE_COMMIT" \
  --probe-source-key "$PROBE_SOURCE_KEY" \
  --compare-latency-baseline "$LATENCY_BASELINE"

for sample in $(seq 0 10); do
  PUBLIC_HEALTH="$(curl --silent --show-error --fail --max-time 20 https://next.ytb-song-rank.culua.com/healthz)"
  HEALTH_JSON="$PUBLIC_HEALTH" python3 - "$RELEASE_SHA" "$ACTIVE" "$EXPECTED_SOURCE_COMMIT" "$sample" <<'PY'
import json,os,sys,time
data=json.loads(os.environ["HEALTH_JSON"]);expected=tuple(sys.argv[1:4])
actual=(str(data.get("releaseContentSha") or ""),str(data.get("activeRevision") or ""),str(data.get("sourceCommit") or ""))
if data.get("status")!="ok" or actual!=expected:
    raise SystemExit(f"WDC_OBSERVATION_HEALTH_MISMATCH actual={actual} expected={expected}")
print("WDC_PUBLIC_OBSERVATION_OK",sys.argv[4],int(time.time()),*actual)
PY
  wdc bash -s -- "$PROJECT_ROOT" "$RELEASE_SHA" <<'REMOTE'
set -Eeuo pipefail
project="$1";sha="$2"
systemctl is-active --quiet daily-song-list-api
systemctl is-active --quiet nginx
health="$(curl --silent --show-error --fail --max-time 10 http://127.0.0.1:18777/healthz)"
HEALTH_JSON="$health" python3 - "$sha" <<'PY'
import json,os,sys
data=json.loads(os.environ["HEALTH_JSON"])
assert data.get("status")=="ok" and data.get("releaseContentSha")==sys.argv[1],data
PY
project_bytes="$(du -sb -- "$project" | awk '{print $1}')"
available="$(python3 - "$project" <<'PY'
import os,sys
s=os.statvfs(sys.argv[1]);print(s.f_bavail*s.f_frsize)
PY
)"
((project_bytes < 40000000000 && available >= 20000000000))
echo "WDC_LOCAL_OBSERVATION_OK project=$project_bytes available=$available"
REMOTE
  ((sample == 10)) || sleep 60
done

wdc env GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" \
  "$SOURCE_ROOT/deploy/finalize-wdc-bounded-release.sh" \
  "$RELEASE_SHA" "$PREVIOUS_RELEASE" "$ACTIVE" "$EXPECTED_SOURCE_COMMIT"
FINALIZED=1
JOB_STATUS="success"
cleanup_resources

wdc bash -s -- "$PROJECT_ROOT" "$RELEASE_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" <<'REMOTE'
set -Eeuo pipefail
project="$1";sha="$2";run="$3";attempt="$4"
test ! -e "$project/.build/dsl-wdc-${run}-${attempt}"
test ! -e "/var/tmp/dsl-wdc-volume-${run}-${attempt}"
test ! -e "/run/dsl-wdc-${run}-${attempt}"
for unit in dsl-wdc-build dsl-wdc-storage-guard dsl-wdc-pg-tunnel; do
  ! systemctl is-active --quiet "${unit}-${run}-${attempt}.service"
done
[[ -L "$project/releases/current" && "$(basename "$(readlink "$project/releases/current")")" == "$sha" ]]
count="$(find "$project/releases" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{64}' | wc -l)"
[[ "$count" == "2" ]]
project_bytes="$(du -sb -- "$project" | awk '{print $1}')"
available="$(python3 - "$project" <<'PY'
import os,sys
s=os.statvfs(sys.argv[1]);print(s.f_bavail*s.f_frsize)
PY
)"
((project_bytes < 40000000000 && available >= 20000000000))
echo "WDC_FINAL_RESIDUE_OK release=$sha retained=$count project=$project_bytes available=$available"
REMOTE
vps2 "test ! -e '$RELAY_ROOT' && ! systemctl is-active --quiet '$RELAY_UNIT.service'"
echo "WDC_BOUNDED_RELEASE_COMPLETE run=$GITHUB_RUN_ID attempt=$GITHUB_RUN_ATTEMPT release=$RELEASE_SHA"
