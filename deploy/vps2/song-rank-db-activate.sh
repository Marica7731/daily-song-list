#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/culua/ytb-song-rank}"
STATE_DIR="${STATE_DIR:-/var/lib/culua/ytb-song-rank}"
DB_PATH="${DB_PATH:-${STATE_DIR}/song-rank.sqlite}"
CANDIDATE_DB="${CANDIDATE_DB:-${STATE_DIR}/song-rank.sqlite.next}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:8765/healthz}"
EXPECTED_SHA256="${EXPECTED_SHA256:-}"

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
python3 scripts/db/query-runtime-db.py --db "${CANDIDATE_DB}" --range all --view songs --q "少女レイ" --page-size 5 --summary-only

mkdir -p "${STATE_DIR}"
previous_db="${DB_PATH}.previous"
rm -f "${previous_db}"
if [[ -f "${DB_PATH}" ]]; then
  mv -f "${DB_PATH}" "${previous_db}"
fi
if ! mv -f "${CANDIDATE_DB}" "${DB_PATH}"; then
  if [[ -f "${previous_db}" && ! -f "${DB_PATH}" ]]; then
    mv -f "${previous_db}" "${DB_PATH}"
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
  exit 1
fi

commit_sha="$(git rev-parse HEAD)"
db_size="$(stat -c%s "${DB_PATH}")"
echo "CODEX_RUNTIME_DB_ACTIVATE_OK commit=${commit_sha} db=${DB_PATH} bytes=${db_size}"
