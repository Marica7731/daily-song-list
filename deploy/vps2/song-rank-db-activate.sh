#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/culua/ytb-song-rank}"
STATE_DIR="${STATE_DIR:-/var/lib/culua/ytb-song-rank}"
DB_PATH="${DB_PATH:-${STATE_DIR}/song-rank.sqlite}"
CANDIDATE_DB="${CANDIDATE_DB:-${STATE_DIR}/song-rank.sqlite.next}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:8765/healthz}"
EXPECTED_SHA256="${EXPECTED_SHA256:-}"
DIRECT_ACTIVATE="${CODEX_RUNTIME_DB_DIRECT_ACTIVATE:-0}"

current_source_commit() {
  if git rev-parse HEAD >/dev/null 2>&1; then
    git rev-parse HEAD
  else
    printf '%s\n' "${SOURCE_COMMIT_SHA:-unknown}"
  fi
}

restart_and_check_api() {
  systemctl restart song-rank-api
  health_ok=0
  for attempt in {1..30}; do
    if curl -fsS "${API_HEALTH_URL}" >/dev/null; then
      health_ok=1
      break
    fi
    sleep 1
  done
  if [[ "${health_ok}" != "1" ]]; then
    systemctl status song-rank-api --no-pager -l || true
    journalctl -u song-rank-api -n 80 --no-pager || true
    echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR api-health-timeout url=${API_HEALTH_URL}"
    return 1
  fi
}

verify_sqlite_database() {
  local db_path="$1"
  python3 - "${db_path}" <<'PY'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
try:
    result = conn.execute("PRAGMA quick_check").fetchone()
    if not result or result[0] != "ok":
        detail = result[0] if result else "no-result"
        print(f"CODEX_RUNTIME_DB_ACTIVATE_ERROR sqlite-quick-check-failed detail={detail}", file=sys.stderr)
        sys.exit(1)
    conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
finally:
    conn.close()
print(f"CODEX_RUNTIME_DB_SQLITE_CHECK_OK db={db_path}")
PY
}

if [[ ! -f "${CANDIDATE_DB}" ]]; then
  echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR missing-candidate path=${CANDIDATE_DB}"
  exit 1
fi

if [[ -n "${EXPECTED_SHA256}" ]]; then
  actual_sha256="$(sha256sum "${CANDIDATE_DB}" | awk '{print $1}')"
  if [[ "${actual_sha256}" != "${EXPECTED_SHA256}" ]]; then
    echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR sha256-mismatch expected=${EXPECTED_SHA256} actual=${actual_sha256}"
    exit 1
  fi
fi

cd "${PROJECT_DIR}"
verify_sqlite_database "${CANDIDATE_DB}"
python3 scripts/db/query-runtime-db.py --db "${CANDIDATE_DB}" --range all --view songs --q "少女レイ" --page-size 5 --summary-only

mkdir -p "${STATE_DIR}"
if [[ "${DIRECT_ACTIVATE}" == "1" ]]; then
  if [[ "${CANDIDATE_DB}" != "${DB_PATH}" ]]; then
    echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR direct-candidate-mismatch db=${DB_PATH} candidate=${CANDIDATE_DB}"
    exit 1
  fi
  chown www-data:www-data "${DB_PATH}"
  if [[ -f "${DB_PATH}.manifest.json" ]]; then
    chown www-data:www-data "${DB_PATH}.manifest.json"
  fi
  restart_and_check_api
  commit_sha="$(current_source_commit)"
  db_size="$(stat -c%s "${DB_PATH}")"
  echo "CODEX_RUNTIME_DB_ACTIVATE_OK mode=direct commit=${commit_sha} db=${DB_PATH} bytes=${db_size}"
  exit 0
fi

previous_db="${DB_PATH}.previous"
previous_manifest="${DB_PATH}.manifest.json.previous"
rm -f "${previous_db}"
rm -f "${previous_manifest}"
if [[ -f "${DB_PATH}" ]]; then
  mv -f "${DB_PATH}" "${previous_db}"
fi
if [[ -f "${DB_PATH}.manifest.json" ]]; then
  mv -f "${DB_PATH}.manifest.json" "${previous_manifest}"
fi
if ! mv -f "${CANDIDATE_DB}" "${DB_PATH}"; then
  if [[ -f "${previous_db}" && ! -f "${DB_PATH}" ]]; then
    mv -f "${previous_db}" "${DB_PATH}"
  fi
  if [[ -f "${previous_manifest}" && ! -f "${DB_PATH}.manifest.json" ]]; then
    mv -f "${previous_manifest}" "${DB_PATH}.manifest.json"
  fi
  echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR replace-failed db=${DB_PATH} candidate=${CANDIDATE_DB}"
  exit 1
fi
chown www-data:www-data "${DB_PATH}"
if [[ -f "${previous_db}" ]]; then
  chown www-data:www-data "${previous_db}"
fi
if [[ -f "${CANDIDATE_DB}.manifest.json" ]]; then
  mv -f "${CANDIDATE_DB}.manifest.json" "${DB_PATH}.manifest.json"
  chown www-data:www-data "${DB_PATH}.manifest.json"
fi

if ! restart_and_check_api; then
  bad_db="${DB_PATH}.bad.$(date -u +%Y%m%dT%H%M%SZ)"
  mv -f "${DB_PATH}" "${bad_db}" || true
  if [[ -f "${previous_db}" ]]; then
    mv -f "${previous_db}" "${DB_PATH}"
    chown www-data:www-data "${DB_PATH}"
  fi
  if [[ -f "${previous_manifest}" ]]; then
    mv -f "${previous_manifest}" "${DB_PATH}.manifest.json"
    chown www-data:www-data "${DB_PATH}.manifest.json"
  else
    rm -f "${DB_PATH}.manifest.json"
  fi
  systemctl restart song-rank-api || true
  echo "CODEX_RUNTIME_DB_ACTIVATE_ERROR rollback-after-health-failure badDb=${bad_db} restoredPrevious=$([[ -f "${DB_PATH}" ]] && echo 1 || echo 0)"
  exit 1
fi
rm -f "${previous_manifest}"

commit_sha="$(current_source_commit)"
db_size="$(stat -c%s "${DB_PATH}")"
echo "CODEX_RUNTIME_DB_ACTIVATE_OK commit=${commit_sha} db=${DB_PATH} bytes=${db_size}"
