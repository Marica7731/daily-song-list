#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/culua/ytb-song-rank}"
STATE_DIR="${STATE_DIR:-/var/lib/culua/ytb-song-rank}"
LOG_DIR="${LOG_DIR:-/var/log/culua/ytb-song-rank}"
BRANCH="${BRANCH:-main}"
DB_PATH="${DB_PATH:-${STATE_DIR}/song-rank.sqlite}"
LOCK_PATH="${LOCK_PATH:-/run/song-rank-runtime-update.lock}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:8765/healthz}"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
BUILD_DB_ON_VPS="${BUILD_DB_ON_VPS:-0}"

mkdir -p "${STATE_DIR}" "${LOG_DIR}"
exec 9>"${LOCK_PATH}"
if ! flock -n 9; then
  echo "CODEX_RUNTIME_UPDATE_SKIPPED reason=lock-held"
  exit 0
fi

cd "${PROJECT_DIR}"

if [[ -d .git ]]; then
  if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
    echo "CODEX_RUNTIME_UPDATE_ERROR dirty-worktree"
    git status --short
    exit 1
  fi

  git fetch origin "${BRANCH}" --prune
  current_branch="$(git branch --show-current)"
  if [[ "${current_branch}" != "${BRANCH}" ]]; then
    git checkout "${BRANCH}"
  fi
  git pull --ff-only origin "${BRANCH}"
else
  echo "CODEX_RUNTIME_UPDATE_GIT_SYNC_SKIPPED reason=runner-support-files"
fi

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install --no-package-lock
  fi
fi

tmp_db="$(mktemp "${STATE_DIR}/song-rank.sqlite.next.XXXXXX")"
rm -f "${tmp_db}"
cleanup() {
  rm -f "${tmp_db}"
}
trap cleanup EXIT

export NODE_OPTIONS
if [[ "${BUILD_DB_ON_VPS}" == "1" ]]; then
  python3 scripts/db/build-runtime-db.py --output "${tmp_db}"
  python3 scripts/db/query-runtime-db.py --db "${tmp_db}" --range all --view songs --q "少女レイ" --page-size 5 --summary-only

  if [[ -f "${DB_PATH}" ]]; then
    cp -f "${DB_PATH}" "${DB_PATH}.previous"
  fi
  mv -f "${tmp_db}" "${DB_PATH}"
  trap - EXIT
  chown www-data:www-data "${DB_PATH}"
  if [[ -f "${DB_PATH}.previous" ]]; then
    chown www-data:www-data "${DB_PATH}.previous"
  fi
else
  rm -f "${tmp_db}"
  trap - EXIT
  if [[ ! -f "${DB_PATH}" ]]; then
    echo "CODEX_RUNTIME_UPDATE_ERROR no-db build-db-on-vps=${BUILD_DB_ON_VPS}"
    exit 1
  fi
fi

systemctl restart song-rank-api
curl -fsS "${API_HEALTH_URL}" >/dev/null

if [[ -d .git ]] && git rev-parse HEAD >/dev/null 2>&1; then
  commit_sha="$(git rev-parse HEAD)"
else
  commit_sha="${SOURCE_COMMIT_SHA:-unknown}"
fi
db_size="$(stat -c%s "${DB_PATH}")"
echo "CODEX_RUNTIME_UPDATE_OK commit=${commit_sha} db=${DB_PATH} bytes=${db_size} buildDbOnVps=${BUILD_DB_ON_VPS}"
