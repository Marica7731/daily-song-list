#!/usr/bin/env bash
# Activate, roll back, or finalize one complete immutable WDC release.
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-wdc-release.sh --action <activate|rollback|finalize> \
  --sha <64hex> --releases-root <dir> --server-path <file> \
  --static-root <dir> --service-unit-path <file> \
  --nginx-available-path <file> --nginx-enabled-path <file> \
  --service <systemd-unit> [--expected-server-commit <git-sha>] \
  [--expected-build-logic-sha <64hex>] \
  [--previous-release-sha <64hex>] [--port 18777]
EOF
  exit 2
}

ACTION="activate"
SHA=""
RELEASES_ROOT=""
SERVER_PATH=""
STATIC_ROOT=""
SERVICE_UNIT_PATH=""
NGINX_AVAILABLE_PATH=""
NGINX_ENABLED_PATH=""
SERVICE=""
EXPECTED_SERVER_COMMIT=""
EXPECTED_BUILD_LOGIC_SHA=""
PREVIOUS_RELEASE_SHA=""
PORT="18777"

while (($#)); do
  case "$1" in
    --action) ACTION="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --releases-root) RELEASES_ROOT="${2:-}"; shift 2 ;;
    --server-path) SERVER_PATH="${2:-}"; shift 2 ;;
    --static-root) STATIC_ROOT="${2:-}"; shift 2 ;;
    --service-unit-path) SERVICE_UNIT_PATH="${2:-}"; shift 2 ;;
    --nginx-available-path) NGINX_AVAILABLE_PATH="${2:-}"; shift 2 ;;
    --nginx-enabled-path) NGINX_ENABLED_PATH="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --expected-server-commit) EXPECTED_SERVER_COMMIT="${2:-}"; shift 2 ;;
    --expected-build-logic-sha) EXPECTED_BUILD_LOGIC_SHA="${2:-}"; shift 2 ;;
    --previous-release-sha) PREVIOUS_RELEASE_SHA="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$ACTION" =~ ^(activate|rollback|finalize)$ ]] || usage
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -n "$RELEASES_ROOT" && -n "$SERVER_PATH" && -n "$STATIC_ROOT" ]] || usage
[[ -n "$SERVICE_UNIT_PATH" && -n "$NGINX_AVAILABLE_PATH" && -n "$NGINX_ENABLED_PATH" ]] || usage
[[ "$SERVICE" =~ ^[A-Za-z0-9@_.-]+$ ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage
if [[ "$ACTION" == "activate" ]]; then
  [[ "$EXPECTED_SERVER_COMMIT" =~ ^[0-9a-f]{40}$ ]] || usage
  [[ "$EXPECTED_BUILD_LOGIC_SHA" =~ ^[0-9a-f]{64}$ ]] || usage
  [[ "$PREVIOUS_RELEASE_SHA" =~ ^[0-9a-f]{64}$ ]] || usage
fi

RELEASES_ROOT="$(readlink -m "$RELEASES_ROOT")"
SERVER_PATH="$(readlink -m "$SERVER_PATH")"
STATIC_ROOT="$(readlink -m "$STATIC_ROOT")"
SERVICE_UNIT_PATH="$(readlink -m "$SERVICE_UNIT_PATH")"
NGINX_AVAILABLE_PATH="$(readlink -m "$NGINX_AVAILABLE_PATH")"
NGINX_ENABLED_PATH="$(readlink -m "$NGINX_ENABLED_PATH")"
[[ "$RELEASES_ROOT" != "/" && "$STATIC_ROOT" != "/" ]] || { echo "DEPLOY_ERROR unsafe root target" >&2; exit 1; }

RELEASE_DIR="$RELEASES_ROOT/$SHA"
CURRENT_LINK="$RELEASES_ROOT/current"
STATE_DIR="$RELEASES_ROOT/.rollback-$SHA"
BACKUP_DIR="$STATE_DIR"
SERVER_ARTIFACT="$RELEASE_DIR/artifacts/release_serving_server.py"
FRONTEND_ROOT="$RELEASE_DIR/artifacts/frontend"
FRONTEND_MANIFEST="$FRONTEND_ROOT/frontend-manifest.json"
INDEX_ARTIFACT="$FRONTEND_ROOT/index.html"
NGINX_ARTIFACT="$RELEASE_DIR/artifacts/deploy/next.ytb-song-rank.culua.com.conf"
UNIT_ARTIFACT="$RELEASE_DIR/artifacts/deploy/daily-song-list-api.service"

backup_file() {
  local label="$1" target="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    printf '1\n' >"$BACKUP_DIR/$label.exists"
    cp -a -- "$target" "$BACKUP_DIR/$label.backup"
  else
    printf '0\n' >"$BACKUP_DIR/$label.exists"
  fi
}

restore_file() {
  local label="$1" target="$2" existed
  existed="$(cat "$STATE_DIR/$label.exists")" || return 1
  if [[ "$existed" == "1" ]]; then
    [[ -e "$STATE_DIR/$label.backup" || -L "$STATE_DIR/$label.backup" ]] || return 1
    mkdir -p "$(dirname "$target")"
    rm -f -- "$target"
    cp -a -- "$STATE_DIR/$label.backup" "$target"
  elif [[ "$existed" == "0" ]]; then
    rm -f -- "$target"
  else
    echo "DEPLOY_ROLLBACK_ERROR invalid backup marker: $label" >&2
    return 1
  fi
}

rollback_from_state() {
  [[ -d "$STATE_DIR" ]] || { echo "DEPLOY_ROLLBACK_ERROR missing state: $STATE_DIR" >&2; return 1; }
  [[ -f "$STATE_DIR/backups-complete" ]] || { echo "DEPLOY_ROLLBACK_ERROR incomplete backup state: $STATE_DIR" >&2; return 1; }
  local app_target previous_target rc=0
  app_target="$(cat "$STATE_DIR/app-target")"
  previous_target="$(cat "$STATE_DIR/previous-target")"
  [[ "$app_target" == "$STATIC_ROOT/assets/"* ]] || { echo "DEPLOY_ROLLBACK_ERROR unsafe app target" >&2; return 1; }
  set +e
  if [[ -n "$previous_target" ]]; then
    ln -s "$previous_target" "$RELEASES_ROOT/.current.rollback.$$" && \
      mv -Tf "$RELEASES_ROOT/.current.rollback.$$" "$CURRENT_LINK" || rc=1
  else
    rm -f -- "$CURRENT_LINK" || rc=1
  fi
  restore_file server "$SERVER_PATH" || rc=1
  restore_file index "$STATIC_ROOT/index.html" || rc=1
  restore_file app "$app_target" || rc=1
  restore_file unit "$SERVICE_UNIT_PATH" || rc=1
  restore_file nginx-available "$NGINX_AVAILABLE_PATH" || rc=1
  restore_file nginx-enabled "$NGINX_ENABLED_PATH" || rc=1
  systemctl daemon-reload || rc=1
  systemctl restart "$SERVICE" || rc=1
  nginx -t || rc=1
  systemctl reload nginx || rc=1
  set -e
  if ((rc)); then
    echo "DEPLOY_ROLLBACK_ERROR incomplete; state preserved at $STATE_DIR" >&2
    return 1
  fi
  rm -rf -- "$STATE_DIR"
  echo "DEPLOY_ROLLBACK complete sha=$SHA"
}

if [[ "$ACTION" == "rollback" ]]; then
  rollback_from_state
  exit 0
fi

if [[ "$ACTION" == "finalize" ]]; then
  [[ -d "$STATE_DIR" ]] || { echo "DEPLOY_FINALIZE_ERROR missing state: $STATE_DIR" >&2; exit 1; }
  [[ -f "$STATE_DIR/backups-complete" ]] || { echo "DEPLOY_FINALIZE_ERROR incomplete backup state: $STATE_DIR" >&2; exit 1; }
  rm -rf -- "$STATE_DIR"
  echo "DEPLOY_FINALIZED sha=$SHA"
  exit 0
fi

[[ -d "$RELEASE_DIR" ]] || { echo "DEPLOY_ERROR release directory missing: $RELEASE_DIR" >&2; exit 1; }
for required in "$SERVER_ARTIFACT" "$RELEASE_DIR/serving.sqlite" "$RELEASE_DIR/.complete" \
  "$FRONTEND_MANIFEST" "$INDEX_ARTIFACT" "$NGINX_ARTIFACT" "$UNIT_ARTIFACT"; do
  [[ -f "$required" ]] || { echo "DEPLOY_ERROR release artifact missing: $required" >&2; exit 1; }
done
[[ ! -e "$STATE_DIR" ]] || { echo "DEPLOY_ERROR rollback state already exists: $STATE_DIR" >&2; exit 1; }

PREVIOUS_RELEASE_DIR="$RELEASES_ROOT/$PREVIOUS_RELEASE_SHA"
[[ -d "$PREVIOUS_RELEASE_DIR" && ! -L "$PREVIOUS_RELEASE_DIR" ]] || {
  echo "DEPLOY_ERROR previous release directory missing: $PREVIOUS_RELEASE_DIR" >&2
  exit 1
}
for required in "$PREVIOUS_RELEASE_DIR/manifest.json" "$PREVIOUS_RELEASE_DIR/meta.json" \
  "$PREVIOUS_RELEASE_DIR/serving.sqlite"; do
  [[ -f "$required" ]] || {
    echo "DEPLOY_ERROR previous release artifact missing: $required" >&2
    exit 1
  }
done
if [[ -L "$CURRENT_LINK" ]]; then
  current_target="$(readlink "$CURRENT_LINK")"
  [[ "${current_target##*/}" == "$PREVIOUS_RELEASE_SHA" ]] || {
    echo "DEPLOY_ERROR current link disagrees with previous release" >&2
    exit 1
  }
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "DEPLOY_ERROR current path is not a symlink: $CURRENT_LINK" >&2
  exit 1
else
  PREVIOUS_HEALTH_FILE="$(mktemp)"
  trap 'rm -f -- "${PREVIOUS_HEALTH_FILE:-}"' EXIT
  curl --silent --show-error --fail --max-time 5 \
    "http://127.0.0.1:$PORT/healthz" >"$PREVIOUS_HEALTH_FILE"
  python3 - "$PREVIOUS_HEALTH_FILE" "$PREVIOUS_RELEASE_SHA" <<'PY'
import json,sys
data=json.load(open(sys.argv[1],encoding="utf-8"));expected=sys.argv[2]
actual=str(data.get("releaseContentSha") or data.get("currentRelease") or "")
if data.get("status")!="ok" or actual!=expected:
    raise SystemExit(f"previous release health mismatch: status={data.get('status')} release={actual}")
print("PREVIOUS_RELEASE_HEALTH_OK",actual)
PY
  rm -f -- "$PREVIOUS_HEALTH_FILE"
  PREVIOUS_HEALTH_FILE=""
  trap - EXIT
fi

read -r APP_RELATIVE APP_SHA < <(python3 - "$RELEASE_DIR" "$SHA" "$EXPECTED_SERVER_COMMIT" "$EXPECTED_BUILD_LOGIC_SHA" <<'PY'
from __future__ import annotations
import hashlib, json, re, sys
from pathlib import Path

root=Path(sys.argv[1]).resolve();expected_sha,expected_commit,expected_logic=sys.argv[2:]
manifest=json.loads((root/"manifest.json").read_text(encoding="utf-8"))
meta=json.loads((root/"meta.json").read_text(encoding="utf-8"))
if manifest.get("contentSha256")!=expected_sha or meta.get("contentSha256")!=expected_sha:
    raise SystemExit("manifest/meta contentSha256 mismatch")
if str(meta.get("serverCommitSha") or "")!=expected_commit:
    raise SystemExit("server commit mismatch")
if str(meta.get("buildLogicSha") or "")!=expected_logic:
    raise SystemExit("build logic mismatch")
if (root/".complete").read_text(encoding="ascii").strip()!=expected_sha:
    raise SystemExit(".complete marker mismatch")
meta_identity=dict(meta);manifest_identity=dict(manifest)
meta_identity.pop("contentSha256",None);manifest_identity.pop("contentSha256",None)
identity=json.dumps({"meta":meta_identity,"manifest":manifest_identity},ensure_ascii=False,sort_keys=True,separators=(",",":"),default=str).encode()
if hashlib.sha256(identity).hexdigest()!=expected_sha:
    raise SystemExit("computed release content hash mismatch")
def digest(path:Path)->str:
    h=hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda:stream.read(1024*1024),b""):h.update(block)
    return h.hexdigest()
items=[*(manifest.get("pages") or []),*(manifest.get("artifacts") or [])]
for item in items:
    relative=str(item.get("path") or "");target=(root/relative).resolve()
    if root not in target.parents or not target.is_file() or digest(target)!=str(item.get("sha256") or ""):
        raise SystemExit(f"manifest object mismatch: {relative}")
frontend=json.loads((root/"artifacts/frontend/frontend-manifest.json").read_text(encoding="utf-8"))
app_relative=str(frontend.get("appPath") or "")
if not re.fullmatch(r"assets/app-h[0-9a-f]{12}\.js",app_relative):
    raise SystemExit("invalid frontend app path")
app=root/"artifacts/frontend"/app_relative
if digest(app)!=str(frontend.get("appSha256") or ""):
    raise SystemExit("frontend app digest mismatch")
index=root/"artifacts/frontend/index.html"
if app_relative not in index.read_text(encoding="utf-8"):
    raise SystemExit("frontend index/app reference mismatch")
print(app_relative,frontend["appSha256"])
PY
)
[[ "$APP_RELATIVE" =~ ^assets/app-h[0-9a-f]{12}\.js$ && "$APP_SHA" =~ ^[0-9a-f]{64}$ ]] || {
  echo "DEPLOY_ERROR invalid frontend manifest result" >&2; exit 1;
}
APP_ARTIFACT="$FRONTEND_ROOT/$APP_RELATIVE"
APP_TARGET="$STATIC_ROOT/$APP_RELATIVE"

node --check "$APP_ARTIFACT"
python3 -B - "$SERVER_ARTIFACT" <<'PY'
import sys
from pathlib import Path
path=Path(sys.argv[1])
compile(path.read_text(encoding="utf-8"),str(path),"exec")
print("PYTHON_SYNTAX_OK",path)
PY
systemd-analyze verify "$UNIT_ARTIFACT"
NGINX_TEST_CONF="$(mktemp)"
cat >"$NGINX_TEST_CONF" <<EOF
pid /tmp/dsl-nginx-test-$SHA.pid;
error_log stderr notice;
events {}
http {
    include /etc/nginx/mime.types;
    include $NGINX_ARTIFACT;
}
EOF
nginx -t -q -c "$NGINX_TEST_CONF" -p /
rm -f -- "$NGINX_TEST_CONF"

mkdir -p "$RELEASES_ROOT" "$(dirname "$SERVER_PATH")" "$STATIC_ROOT/assets" \
  "$(dirname "$SERVICE_UNIT_PATH")" "$(dirname "$NGINX_AVAILABLE_PATH")" "$(dirname "$NGINX_ENABLED_PATH")"
PREP_STATE_DIR="$(mktemp -d "$RELEASES_ROOT/.rollback-$SHA.preparing.XXXXXX")"
cleanup_preparing_state() {
  if [[ -n "${PREP_STATE_DIR:-}" && -d "$PREP_STATE_DIR" && "$PREP_STATE_DIR" == "$RELEASES_ROOT/.rollback-$SHA.preparing."* ]]; then
    rm -rf -- "$PREP_STATE_DIR"
  fi
}
trap cleanup_preparing_state EXIT
chmod 0700 "$PREP_STATE_DIR"
BACKUP_DIR="$PREP_STATE_DIR"
if [[ -L "$CURRENT_LINK" ]]; then readlink "$CURRENT_LINK" >"$PREP_STATE_DIR/previous-target"; else : >"$PREP_STATE_DIR/previous-target"; fi
printf '%s\n' "$PREVIOUS_RELEASE_SHA" >"$PREP_STATE_DIR/previous-release-sha"
printf '%s\n' "$APP_TARGET" >"$PREP_STATE_DIR/app-target"
backup_file server "$SERVER_PATH"
backup_file index "$STATIC_ROOT/index.html"
backup_file app "$APP_TARGET"
backup_file unit "$SERVICE_UNIT_PATH"
backup_file nginx-available "$NGINX_AVAILABLE_PATH"
backup_file nginx-enabled "$NGINX_ENABLED_PATH"
printf 'ok\n' >"$PREP_STATE_DIR/backups-complete"
mv -T -- "$PREP_STATE_DIR" "$STATE_DIR"
PREP_STATE_DIR=""
BACKUP_DIR="$STATE_DIR"

LIVE_MUTATION_STARTED=0
rollback_on_error() {
  local rc=$?
  trap - ERR INT TERM
  if ((LIVE_MUTATION_STARTED)); then
    echo "DEPLOY_ROLLBACK begin rc=$rc" >&2
    rollback_from_state || true
  fi
  exit "$rc"
}
trap rollback_on_error ERR INT TERM

atomic_install() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(mktemp "$(dirname "$target")/.$(basename "$target").new.XXXXXX")"
  install -m "$mode" "$source" "$temporary"
  mv -f -- "$temporary" "$target"
}

LIVE_MUTATION_STARTED=1
atomic_install "$SERVER_ARTIFACT" "$SERVER_PATH" 0755
atomic_install "$APP_ARTIFACT" "$APP_TARGET" 0644
atomic_install "$INDEX_ARTIFACT" "$STATIC_ROOT/index.html" 0644
atomic_install "$UNIT_ARTIFACT" "$SERVICE_UNIT_PATH" 0644
atomic_install "$NGINX_ARTIFACT" "$NGINX_AVAILABLE_PATH" 0644
atomic_install "$NGINX_ARTIFACT" "$NGINX_ENABLED_PATH" 0644
ln -s "$SHA" "$RELEASES_ROOT/.current.$SHA.$$"
mv -Tf "$RELEASES_ROOT/.current.$SHA.$$" "$CURRENT_LINK"

systemctl daemon-reload
nginx -t
systemctl restart "$SERVICE"
systemctl reload nginx

HEALTH_FILE="$(mktemp)"
for _ in $(seq 1 40); do
  if curl --silent --show-error --fail --max-time 3 "http://127.0.0.1:$PORT/healthz" >"$HEALTH_FILE"; then break; fi
  sleep 0.5
done
python3 - "$HEALTH_FILE" "$SHA" "$EXPECTED_SERVER_COMMIT" "$EXPECTED_BUILD_LOGIC_SHA" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);expected_sha,expected_commit,expected_logic=sys.argv[2:]
if not p.is_file() or not p.read_text(encoding="utf-8").strip():raise SystemExit("health endpoint never became ready")
data=json.loads(p.read_text(encoding="utf-8"))
checks={
 "status":data.get("status")=="ok",
 "release":data.get("releaseContentSha")==expected_sha,
 "serverCommit":data.get("serverCommit")==expected_commit,
 "buildLogic":data.get("buildLogicSha")==expected_logic,
 "artists":"artists" in set(data.get("views") or []),
 "metrics":{"occurrences","songs","videos"}.issubset(set(data.get("metrics") or [])),
 "scopes":{"all","niche","visible","visibleNiche"}==set(data.get("rankingScopes") or []),
 "localSearch":data.get("localSearchReady") is True,
 "noOrigin":data.get("oldOriginDependency") is False and data.get("sourceFallbackEnabled") is False,
}
failed=[key for key,value in checks.items() if not value]
if failed:raise SystemExit("health contract failed: "+", ".join(failed)+" "+json.dumps(data,ensure_ascii=False))
print("HEALTH_CONTRACT_OK",expected_sha)
PY
rm -f -- "$HEALTH_FILE"

for metric in occurrences songs videos; do
  curl --silent --show-error --fail --max-time 10 \
    "http://127.0.0.1:$PORT/api/rankings?v=$SHA&range=all&view=artists&metric=$metric&page=1&pageSize=30" \
    >"$STATE_DIR/artist-$metric.json"
  python3 - "$metric" "$STATE_DIR/artist-$metric.json" <<'PY'
import json,sys
payload=json.load(open(sys.argv[2],encoding="utf-8"))
if not payload.get("records") or int(payload.get("pageSize") or 0)!=30:
    raise SystemExit(f"artist ranking smoke failed for {sys.argv[1]}: {payload}")
print("ARTIST_RANKING_OK",sys.argv[1],payload.get("totalCount"))
PY
  rm -f -- "$STATE_DIR/artist-$metric.json"
done

trap - ERR INT TERM
echo "DEPLOY_ACTIVATED_PENDING_PUBLIC sha=$SHA app=$APP_RELATIVE previous=$PREVIOUS_RELEASE_SHA"
