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
if [[ -f "${DB_PATH}" ]]; then
  cp -f "${DB_PATH}" "${DB_PATH}.previous"
fi
mv -f "${CANDIDATE_DB}" "${DB_PATH}"
chown www-data:www-data "${DB_PATH}"
if [[ -f "${DB_PATH}.previous" ]]; then
  chown www-data:www-data "${DB_PATH}.previous"
fi
if [[ -f "${CANDIDATE_DB}.manifest.json" ]]; then
  mv -f "${CANDIDATE_DB}.manifest.json" "${DB_PATH}.manifest.json"
  chown www-data:www-data "${DB_PATH}.manifest.json"
fi

systemctl restart song-rank-api
curl -fsS "${API_HEALTH_URL}" >/dev/null

commit_sha="$(git rev-parse HEAD)"
db_size="$(stat -c%s "${DB_PATH}")"
echo "CODEX_RUNTIME_DB_ACTIVATE_OK commit=${commit_sha} db=${DB_PATH} bytes=${db_size}"
