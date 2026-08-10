#!/usr/bin/env bash
# Atomically activate one already-extracted immutable release on the WDC VPS.
# Any failed integrity/health/smoke check restores both the previous release
# symlink and the previous server program before returning non-zero.
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-wdc-release.sh \
  --sha <64hex> \
  --releases-root <dir> \
  --server-path <file> \
  --service <systemd-unit> \
  --expected-server-commit <git-sha> \
  --expected-build-logic-sha <64hex> \
  [--port 18777]
EOF
  exit 2
}

SHA=""
RELEASES_ROOT=""
SERVER_PATH=""
SERVICE=""
EXPECTED_SERVER_COMMIT=""
EXPECTED_BUILD_LOGIC_SHA=""
PORT="18777"

while (($#)); do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --releases-root) RELEASES_ROOT="${2:-}"; shift 2 ;;
    --server-path) SERVER_PATH="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --expected-server-commit) EXPECTED_SERVER_COMMIT="${2:-}"; shift 2 ;;
    --expected-build-logic-sha) EXPECTED_BUILD_LOGIC_SHA="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -n "$RELEASES_ROOT" && -n "$SERVER_PATH" && -n "$SERVICE" && -n "$EXPECTED_SERVER_COMMIT" ]] || usage
[[ "$EXPECTED_BUILD_LOGIC_SHA" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$PORT" =~ ^[0-9]+$ ]] || usage

RELEASES_ROOT="$(readlink -m "$RELEASES_ROOT")"
SERVER_PATH="$(readlink -m "$SERVER_PATH")"
RELEASE_DIR="$RELEASES_ROOT/$SHA"
CURRENT_LINK="$RELEASES_ROOT/current"
SERVER_ARTIFACT="$RELEASE_DIR/artifacts/release_serving_server.py"

[[ -d "$RELEASE_DIR" ]] || { echo "DEPLOY_ERROR release directory missing: $RELEASE_DIR" >&2; exit 1; }
[[ -f "$SERVER_ARTIFACT" ]] || { echo "DEPLOY_ERROR server artifact missing" >&2; exit 1; }
[[ -f "$RELEASE_DIR/serving.sqlite" ]] || { echo "DEPLOY_ERROR serving.sqlite missing" >&2; exit 1; }
[[ -f "$RELEASE_DIR/.complete" ]] || { echo "DEPLOY_ERROR .complete marker missing" >&2; exit 1; }

# Verify every manifest object before touching the live symlink or program.
python3 - "$RELEASE_DIR" "$SHA" "$EXPECTED_SERVER_COMMIT" "$EXPECTED_BUILD_LOGIC_SHA" <<'PY'
from __future__ import annotations
import hashlib, json, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
expected_sha = sys.argv[2]
expected_commit = sys.argv[3]
expected_build_logic = sys.argv[4]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
meta = json.loads((root / "meta.json").read_text(encoding="utf-8"))
if manifest.get("contentSha256") != expected_sha or meta.get("contentSha256") != expected_sha:
    raise SystemExit("manifest/meta contentSha256 mismatch")
if str(meta.get("serverCommitSha") or "") != expected_commit:
    raise SystemExit(f"server commit mismatch: {meta.get('serverCommitSha')!r} != {expected_commit!r}")
if str(meta.get("buildLogicSha") or "") != expected_build_logic:
    raise SystemExit(f"build logic mismatch: {meta.get('buildLogicSha')!r} != {expected_build_logic!r}")
if (root / ".complete").read_text(encoding="ascii").strip() != expected_sha:
    raise SystemExit(".complete marker mismatch")

meta_identity = dict(meta)
manifest_identity = dict(manifest)
meta_identity.pop("contentSha256", None)
manifest_identity.pop("contentSha256", None)
identity_bytes = json.dumps(
    {"meta": meta_identity, "manifest": manifest_identity},
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
    default=str,
).encode("utf-8")
if hashlib.sha256(identity_bytes).hexdigest() != expected_sha:
    raise SystemExit("computed release content hash mismatch")

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

items = [*(manifest.get("pages") or []), *(manifest.get("artifacts") or [])]
if not items:
    raise SystemExit("manifest has no files")
for item in items:
    rel = str(item.get("path") or "")
    target = (root / rel).resolve()
    if root not in target.parents:
        raise SystemExit(f"path traversal in manifest: {rel}")
    if not target.is_file():
        raise SystemExit(f"manifest file missing: {rel}")
    actual = digest(target)
    if actual != str(item.get("sha256") or ""):
        raise SystemExit(f"sha256 mismatch for {rel}")
print(f"RELEASE_INTEGRITY_OK files={len(items)}")
PY

# Refuse to restart a service that is wired to some other server file.  This is
# the exact bug that previously made GitHub commits appear deployed when they
# were not.
EXEC_START="$(systemctl show "$SERVICE" --property=ExecStart --value)"
if [[ "$EXEC_START" != *"$SERVER_PATH"* ]]; then
  echo "DEPLOY_ERROR $SERVICE ExecStart does not reference $SERVER_PATH" >&2
  echo "ExecStart=$EXEC_START" >&2
  exit 1
fi

mkdir -p "$RELEASES_ROOT" "$(dirname "$SERVER_PATH")"
PREVIOUS_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$CURRENT_LINK")"
fi
SERVER_BACKUP=""
if [[ -f "$SERVER_PATH" ]]; then
  SERVER_BACKUP="$(mktemp "$(dirname "$SERVER_PATH")/.release_serving_server.backup.XXXXXX")"
  cp -a "$SERVER_PATH" "$SERVER_BACKUP"
fi
SERVER_TEMP="$(mktemp "$(dirname "$SERVER_PATH")/.release_serving_server.new.XXXXXX")"
CURRENT_TEMP="$RELEASES_ROOT/.current.$SHA.$$"
LIVE_MUTATION_STARTED=0

rollback() {
  local rc=$?
  trap - ERR INT TERM
  if (( LIVE_MUTATION_STARTED )); then
    echo "DEPLOY_ROLLBACK begin rc=$rc" >&2
    if [[ -n "$PREVIOUS_TARGET" ]]; then
      ln -s "$PREVIOUS_TARGET" "$CURRENT_TEMP.rollback"
      mv -Tf "$CURRENT_TEMP.rollback" "$CURRENT_LINK"
    else
      rm -f "$CURRENT_LINK"
    fi
    if [[ -n "$SERVER_BACKUP" && -f "$SERVER_BACKUP" ]]; then
      install -m 0755 "$SERVER_BACKUP" "$SERVER_TEMP.rollback"
      mv -f "$SERVER_TEMP.rollback" "$SERVER_PATH"
    else
      rm -f "$SERVER_PATH"
    fi
    systemctl restart "$SERVICE" || true
    echo "DEPLOY_ROLLBACK complete" >&2
  fi
  rm -f "$SERVER_TEMP" "$CURRENT_TEMP" "$SERVER_BACKUP"
  exit "$rc"
}
trap rollback ERR INT TERM

install -m 0755 "$SERVER_ARTIFACT" "$SERVER_TEMP"
# Atomic rename keeps an already-running process unaffected until restart.
LIVE_MUTATION_STARTED=1
mv -f "$SERVER_TEMP" "$SERVER_PATH"
ln -s "$SHA" "$CURRENT_TEMP"
mv -Tf "$CURRENT_TEMP" "$CURRENT_LINK"

systemctl restart "$SERVICE"

HEALTH_FILE="$(mktemp)"
for _ in $(seq 1 40); do
  if curl --silent --show-error --fail --max-time 3 \
      "http://127.0.0.1:$PORT/healthz" >"$HEALTH_FILE"; then
    break
  fi
  sleep 0.5
done

python3 - "$HEALTH_FILE" "$SHA" "$EXPECTED_SERVER_COMMIT" "$EXPECTED_BUILD_LOGIC_SHA" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
if not p.is_file() or not p.read_text(encoding="utf-8").strip():
    raise SystemExit("health endpoint never became ready")
data = json.loads(p.read_text(encoding="utf-8"))
expected_sha, expected_commit, expected_build_logic = sys.argv[2], sys.argv[3], sys.argv[4]
checks = {
    "status": data.get("status") == "ok",
    "releaseContentSha": data.get("releaseContentSha") == expected_sha,
    "serverCommit": data.get("serverCommit") == expected_commit,
    "buildLogicSha": data.get("buildLogicSha") == expected_build_logic,
    "servingSchemaVersion": int(data.get("servingSchemaVersion") or 0) == 3,
    "localSearchReady": data.get("localSearchReady") is True,
    "oldOriginDependency": data.get("oldOriginDependency") is False,
    "sourceFallbackEnabled": data.get("sourceFallbackEnabled") is False,
    "ranges": {"7d", "all"}.issubset(set(data.get("localSourcesRanges") or [])),
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise SystemExit("health contract failed: " + ", ".join(failed) + " payload=" + json.dumps(data, ensure_ascii=False))
print("HEALTH_CONTRACT_OK")
PY
rm -f "$HEALTH_FILE"

# Page-size regression: request 30, receive no more than 30 and normally exactly
# 30 for the all-time song list.  It also verifies the versioned URL.
RANK_FILE="$(mktemp)"
RANK_HEADERS="$(mktemp)"
curl --silent --show-error --fail --max-time 10 \
  -D "$RANK_HEADERS" \
  "http://127.0.0.1:$PORT/api/rankings?v=$SHA&range=all&view=songs&metric=occurrences&page=1&pageSize=30" \
  >"$RANK_FILE"
python3 - "$RANK_FILE" <<'PY'
import json, sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
records=p.get("records") or []
if int(p.get("pageSize") or 0) != 30:
    raise SystemExit(f"pageSize contract failed: {p.get('pageSize')}")
if int(p.get("totalCount") or 0) >= 30 and len(records) != 30:
    raise SystemExit(f"expected 30 records, got {len(records)}")
if len(records) > 30:
    raise SystemExit(f"server over-returned {len(records)} records")
print(f"RANKING_SMOKE_OK records={len(records)} total={p.get('totalCount')}")
PY
grep -qi '^X-Data-Source: local-' "$RANK_HEADERS"
rm -f "$RANK_FILE" "$RANK_HEADERS"

# Pick a canonical key directly from the shipped SQLite file.  This proves the
# source endpoint is truly local rather than a successful hidden proxy.
read -r SOURCE_RANGE SOURCE_KEY < <(python3 - "$RELEASE_DIR/serving.sqlite" <<'PY'
import sqlite3, sys
con=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
row=con.execute("SELECT range_id,source_key FROM source_details WHERE total_occurrence_count>0 ORDER BY CASE range_id WHEN 'all' THEN 0 ELSE 1 END,source_key LIMIT 1").fetchone()
if not row: raise SystemExit("no non-empty source detail available for smoke test")
print(row[0],row[1])
PY
)
SOURCE_FILE="$(mktemp)"
SOURCE_HEADERS="$(mktemp)"
curl --silent --show-error --fail --max-time 10 \
  -D "$SOURCE_HEADERS" \
  "http://127.0.0.1:$PORT/api/sources/$SOURCE_KEY?v=$SHA&range=$SOURCE_RANGE&page=1&pageSize=20" \
  >"$SOURCE_FILE"
python3 - "$SOURCE_FILE" "$SOURCE_KEY" <<'PY'
import json, sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
if p.get("found") is not True or p.get("sourceKey") != sys.argv[2]:
    raise SystemExit("source smoke contract failed")
if int(p.get("totalOccurrenceCount") or 0) <= 0:
    raise SystemExit("source smoke returned no occurrences")
print(f"SOURCE_SMOKE_OK videos={p.get('totalVideoCount')} occurrences={p.get('totalOccurrenceCount')}")
PY
grep -qi '^X-Data-Source: local-serving-sqlite' "$SOURCE_HEADERS"
rm -f "$SOURCE_FILE" "$SOURCE_HEADERS"

# Search must also use the local ranking read model.
SEARCH_TERM="$(python3 - "$RELEASE_DIR/serving.sqlite" <<'PY'
import sqlite3,sys
con=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True)
row=con.execute("SELECT title FROM ranking_rows WHERE range_id='all' AND view='songs' AND length(title)>=2 ORDER BY rank LIMIT 1").fetchone()
print((row[0] if row else '').replace('\n',' ').strip())
PY
)"
if [[ -n "$SEARCH_TERM" ]]; then
  SEARCH_FILE="$(mktemp)"
  SEARCH_HEADERS="$(mktemp)"
  curl --silent --show-error --fail --get --max-time 10 \
    -D "$SEARCH_HEADERS" \
    --data-urlencode "v=$SHA" \
    --data-urlencode "range=all" \
    --data-urlencode "view=songs" \
    --data-urlencode "metric=occurrences" \
    --data-urlencode "q=$SEARCH_TERM" \
    --data-urlencode "page=1" \
    --data-urlencode "pageSize=12" \
    "http://127.0.0.1:$PORT/api/rankings" >"$SEARCH_FILE"
  python3 - "$SEARCH_FILE" <<'PY'
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
if int(p.get("totalCount") or 0) < 1 or not (p.get("records") or []):
    raise SystemExit("local search smoke returned no rows")
print(f"SEARCH_SMOKE_OK total={p.get('totalCount')}")
PY
  grep -qi '^X-Data-Source: local-serving-sqlite' "$SEARCH_HEADERS"
  rm -f "$SEARCH_FILE" "$SEARCH_HEADERS"
fi

# Successful activation disarms rollback.
LIVE_MUTATION_STARTED=0
trap - ERR INT TERM
rm -f "$SERVER_BACKUP"
echo "DEPLOY_OK sha=$SHA previous=${PREVIOUS_TARGET:-none} serverCommit=$EXPECTED_SERVER_COMMIT buildLogic=$EXPECTED_BUILD_LOGIC_SHA"
