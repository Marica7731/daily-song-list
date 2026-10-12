#!/usr/bin/env bash
# Remove only one exact WDC build root and a provably inactive candidate.
set -Eeuo pipefail

usage() {
  echo "usage: cleanup-wdc-bounded-build.sh <run-id> <attempt> <job-status> [release-sha]" >&2
  exit 2
}

RUN_ID="${1:-}"
RUN_ATTEMPT="${2:-}"
JOB_STATUS="${3:-}"
RELEASE_SHA="${4:-}"
[[ "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || usage
[[ "$JOB_STATUS" =~ ^(success|failure|cancelled|skipped)$ ]] || usage
[[ -z "$RELEASE_SHA" || "$RELEASE_SHA" =~ ^[0-9a-f]{64}$ ]] || usage

PROJECT_ROOT="/opt/culua/ytb-song-rank"
RELEASES_ROOT="$PROJECT_ROOT/releases"
CONTROL_ROOT="$PROJECT_ROOT/.build/dsl-wdc-${RUN_ID}-${RUN_ATTEMPT}"
SECRET_ROOT="/run/dsl-wdc-${RUN_ID}-${RUN_ATTEMPT}"
VOLUME_CONTROL_ROOT="/var/tmp/dsl-wdc-volume-${RUN_ID}-${RUN_ATTEMPT}"
VOLUME_ROOT="$VOLUME_CONTROL_ROOT/volume"
VOLUME_IMAGE="$VOLUME_CONTROL_ROOT/build-volume.ext4"
LOOP_MARKER="$VOLUME_CONTROL_ROOT/.loop-device"
BUILD_UNIT="dsl-wdc-build-${RUN_ID}-${RUN_ATTEMPT}.service"
GUARD_UNIT="dsl-wdc-storage-guard-${RUN_ID}-${RUN_ATTEMPT}.service"
TUNNEL_UNIT="dsl-wdc-pg-tunnel-${RUN_ID}-${RUN_ATTEMPT}.service"
EXPECTED_OWNER="${RUN_ID}:${RUN_ATTEMPT}"

# Recover the exact release identity even if the controller disconnected after
# the cross-filesystem copy but before it could read build-result.json.  The
# owner sidecar is created before the incoming directory and is never copied
# into the immutable release.
if [[ -z "$RELEASE_SHA" ]]; then
  shopt -s nullglob
  INCOMING_OWNER_CANDIDATES=(
    "$RELEASES_ROOT"/.incoming-*."${RUN_ID}-${RUN_ATTEMPT}".owner
  )
  shopt -u nullglob
  ((${#INCOMING_OWNER_CANDIDATES[@]} <= 1))
  if ((${#INCOMING_OWNER_CANDIDATES[@]} == 1)); then
    OWNER_CANDIDATE="${INCOMING_OWNER_CANDIDATES[0]}"
    [[ -f "$OWNER_CANDIDATE" && ! -L "$OWNER_CANDIDATE" ]]
    [[ "${OWNER_CANDIDATE%/*}" == "$RELEASES_ROOT" ]]
    [[ "$(cat "$OWNER_CANDIDATE")" == "$EXPECTED_OWNER" ]]
    OWNER_BASENAME="${OWNER_CANDIDATE##*/}"
    [[ "$OWNER_BASENAME" =~ ^\.incoming-([0-9a-f]{64})\.${RUN_ID}-${RUN_ATTEMPT}\.owner$ ]]
    RELEASE_SHA="${BASH_REMATCH[1]}"
  fi
fi

if [[ -n "$RELEASE_SHA" ]]; then
  INCOMING_RELEASE="$RELEASES_ROOT/.incoming-${RELEASE_SHA}.${RUN_ID}-${RUN_ATTEMPT}"
  INCOMING_OWNER="$INCOMING_RELEASE.owner"
  if [[ -e "$INCOMING_OWNER" || -L "$INCOMING_OWNER" ]]; then
    [[ -f "$INCOMING_OWNER" && ! -L "$INCOMING_OWNER" ]]
    [[ "$(cat "$INCOMING_OWNER")" == "$EXPECTED_OWNER" ]]
    if [[ -e "$INCOMING_RELEASE" || -L "$INCOMING_RELEASE" ]]; then
      [[ -d "$INCOMING_RELEASE" && ! -L "$INCOMING_RELEASE" ]]
      INCOMING_REAL="$(readlink -f "$INCOMING_RELEASE")"
      [[ "${INCOMING_REAL%/*}" == "$RELEASES_ROOT" ]]
      rm -rf -- "$INCOMING_RELEASE"
    fi
    rm -f -- "$INCOMING_OWNER"
    echo "WDC_CLEANUP_INCOMING_REMOVED sha=$RELEASE_SHA"
  elif [[ -e "$INCOMING_RELEASE" || -L "$INCOMING_RELEASE" ]]; then
    echo "WDC_CLEANUP_INCOMING_OWNER_MISSING path=$INCOMING_RELEASE" >&2
    exit 76
  fi
fi

for unit in "$GUARD_UNIT" "$BUILD_UNIT" "$TUNNEL_UNIT"; do
  systemctl stop "$unit" >/dev/null 2>&1 || true
  if systemctl is-active --quiet "$unit"; then
    echo "WDC_CLEANUP_UNIT_STILL_ACTIVE unit=$unit" >&2
    exit 76
  fi
done

CONTROL_OWNER_OK=0
if [[ -e "$CONTROL_ROOT" || -L "$CONTROL_ROOT" ]]; then
  [[ -d "$CONTROL_ROOT" && ! -L "$CONTROL_ROOT" ]]
  [[ "$(readlink -f "$CONTROL_ROOT")" == "$CONTROL_ROOT" ]]
  if [[ -f "$CONTROL_ROOT/.codex-owned-run" && ! -L "$CONTROL_ROOT/.codex-owned-run" ]] &&
     [[ "$(cat "$CONTROL_ROOT/.codex-owned-run")" == "$EXPECTED_OWNER" ]]; then
    CONTROL_OWNER_OK=1
  fi
fi

if [[ -e "$VOLUME_CONTROL_ROOT" || -L "$VOLUME_CONTROL_ROOT" ]]; then
  [[ -d "$VOLUME_CONTROL_ROOT" && ! -L "$VOLUME_CONTROL_ROOT" ]]
  [[ "$(readlink -f "$VOLUME_CONTROL_ROOT")" == "$VOLUME_CONTROL_ROOT" ]]
  if [[ -f "$VOLUME_CONTROL_ROOT/.codex-owned-run" &&
        ! -L "$VOLUME_CONTROL_ROOT/.codex-owned-run" ]]; then
    [[ "$(cat "$VOLUME_CONTROL_ROOT/.codex-owned-run")" == "$EXPECTED_OWNER" ]]
  else
    # A cancelled transient unit can unlink its sparse image and owner marker
    # before the controller's always() cleanup reaches the still-mounted loop.
    # Recover only when the independently owned control root proves this run,
    # the volume root contains no unexpected entry, and any live mount points
    # at this exact run path to the now-deleted exact backing image.
    ((CONTROL_OWNER_OK == 1))
    [[ ! -e "$VOLUME_IMAGE" && ! -L "$VOLUME_IMAGE" ]]
    [[ ! -e "$LOOP_MARKER" && ! -L "$LOOP_MARKER" ]]
    while IFS= read -r top_entry; do
      [[ "$top_entry" == "volume" ]] || {
        echo "WDC_CLEANUP_VOLUME_OWNER_RECOVERY_REJECTED entry=$top_entry" >&2
        exit 76
      }
    done < <(find "$VOLUME_CONTROL_ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n')
    if mountpoint -q "$VOLUME_ROOT"; then
      RECOVERY_LOOP="$(findmnt -n -o SOURCE --target "$VOLUME_ROOT")"
      [[ "$RECOVERY_LOOP" =~ ^/dev/loop[0-9]+$ ]]
      RECOVERY_BACKING="$(losetup -n -O BACK-FILE "$RECOVERY_LOOP")"
      [[ "$RECOVERY_BACKING" == "$VOLUME_IMAGE" ||
         "$RECOVERY_BACKING" == "$VOLUME_IMAGE (deleted)" ]]
    else
      [[ -d "$VOLUME_ROOT" && ! -L "$VOLUME_ROOT" ]]
      [[ -z "$(find "$VOLUME_ROOT" -mindepth 1 -print -quit)" ]]
    fi
    echo "WDC_CLEANUP_VOLUME_OWNER_RECOVERED owner=$EXPECTED_OWNER"
  fi
  if mountpoint -q "$VOLUME_ROOT"; then
    umount "$VOLUME_ROOT"
  fi
  if [[ -s "$LOOP_MARKER" ]]; then
    LOOP_DEVICE="$(cat "$LOOP_MARKER")"
    [[ "$LOOP_DEVICE" =~ ^/dev/loop[0-9]+$ ]]
    if losetup "$LOOP_DEVICE" >/dev/null 2>&1; then
      BACKING_FILE="$(losetup -n -O BACK-FILE "$LOOP_DEVICE")"
      [[ "$BACKING_FILE" == "$VOLUME_IMAGE" ]]
      losetup -d "$LOOP_DEVICE"
    fi
  elif [[ -e "$VOLUME_IMAGE" ]]; then
    mapfile -t LOOP_DEVICES < <(losetup -j "$VOLUME_IMAGE" | cut -d: -f1)
    ((${#LOOP_DEVICES[@]} <= 1))
    if ((${#LOOP_DEVICES[@]} == 1)); then
      [[ "${LOOP_DEVICES[0]}" =~ ^/dev/loop[0-9]+$ ]]
      losetup -d "${LOOP_DEVICES[0]}"
    fi
  fi
  mountpoint -q "$VOLUME_ROOT" && { echo "WDC_CLEANUP_VOLUME_STILL_MOUNTED" >&2; exit 76; }
  if [[ -e "$VOLUME_IMAGE" ]]; then
    [[ -f "$VOLUME_IMAGE" && ! -L "$VOLUME_IMAGE" ]]
  fi
  rm -rf -- "$VOLUME_CONTROL_ROOT"
fi

if [[ -e "$CONTROL_ROOT" || -L "$CONTROL_ROOT" ]]; then
  [[ -d "$CONTROL_ROOT" && ! -L "$CONTROL_ROOT" ]]
  [[ "$(readlink -f "$CONTROL_ROOT")" == "$CONTROL_ROOT" ]]
  [[ "$(cat "$CONTROL_ROOT/.codex-owned-run")" == "$EXPECTED_OWNER" ]]
  rm -rf -- "$CONTROL_ROOT"
fi

if [[ -e "$SECRET_ROOT" || -L "$SECRET_ROOT" ]]; then
  [[ -d "$SECRET_ROOT" && ! -L "$SECRET_ROOT" ]]
  [[ "$(readlink -f "$SECRET_ROOT")" == "$SECRET_ROOT" ]]
  [[ "$(cat "$SECRET_ROOT/.codex-owned-run")" == "$EXPECTED_OWNER" ]]
  rm -rf -- "$SECRET_ROOT"
fi

if [[ -n "$RELEASE_SHA" && "$JOB_STATUS" != "success" ]]; then
  RELEASE_DIR="$RELEASES_ROOT/$RELEASE_SHA"
  ROLLBACK_STATE="$RELEASES_ROOT/.rollback-$RELEASE_SHA"
  CURRENT_SHA=""
  if [[ -L "$RELEASES_ROOT/current" ]]; then
    CURRENT_TARGET="$(readlink "$RELEASES_ROOT/current")"
    CURRENT_SHA="${CURRENT_TARGET##*/}"
    [[ "$CURRENT_SHA" =~ ^[0-9a-f]{64}$ ]]
  elif [[ -e "$RELEASES_ROOT/current" ]]; then
    echo "WDC_CLEANUP_CURRENT_NOT_SYMLINK" >&2
    exit 76
  fi
  if [[ "$CURRENT_SHA" == "$RELEASE_SHA" ]]; then
    echo "WDC_CLEANUP_ACTIVE_RELEASE_PRESERVED sha=$RELEASE_SHA"
  elif [[ -e "$ROLLBACK_STATE" || -L "$ROLLBACK_STATE" ]]; then
    echo "WDC_CLEANUP_ROLLBACK_RELEASE_PRESERVED sha=$RELEASE_SHA"
  elif [[ -e "$RELEASE_DIR" || -L "$RELEASE_DIR" ]]; then
    [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]]
    RELEASE_REAL="$(readlink -f "$RELEASE_DIR")"
    [[ "${RELEASE_REAL%/*}" == "$RELEASES_ROOT" && "${RELEASE_REAL##*/}" == "$RELEASE_SHA" ]]
    rm -rf -- "$RELEASE_DIR"
    echo "WDC_CLEANUP_INACTIVE_CANDIDATE_REMOVED sha=$RELEASE_SHA"
  fi
fi

echo "WDC_BOUNDED_CLEANUP_OK run=$RUN_ID attempt=$RUN_ATTEMPT status=$JOB_STATUS"
