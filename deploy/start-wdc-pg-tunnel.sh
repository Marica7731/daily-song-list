#!/usr/bin/env bash
# Start one exact WDC -> VPS2 loopback tunnel under a transient systemd unit.
set -Eeuo pipefail

usage() {
  echo "usage: start-wdc-pg-tunnel.sh <run-id> <attempt> <vps2-user> <vps2-host> <relay-port> <local-port>" >&2
  exit 2
}

RUN_ID="${1:-}"
RUN_ATTEMPT="${2:-}"
VPS2_USER="${3:-}"
VPS2_HOST="${4:-}"
RELAY_PORT="${5:-}"
LOCAL_PORT="${6:-}"
[[ "$RUN_ID" =~ ^[0-9]+$ && "$RUN_ATTEMPT" =~ ^[0-9]+$ ]] || usage
[[ "$VPS2_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,31}$ ]] || usage
[[ "$VPS2_HOST" =~ ^[A-Za-z0-9._:-]{1,253}$ ]] || usage
[[ "$RELAY_PORT" =~ ^[0-9]+$ && "$LOCAL_PORT" =~ ^[0-9]+$ ]] || usage
((RELAY_PORT > 0 && RELAY_PORT <= 65535 && LOCAL_PORT > 0 && LOCAL_PORT <= 65535)) || usage

SECRET_ROOT="/run/dsl-wdc-${RUN_ID}-${RUN_ATTEMPT}"
EXPECTED_OWNER="${RUN_ID}:${RUN_ATTEMPT}"
[[ -d "$SECRET_ROOT" && ! -L "$SECRET_ROOT" && "$(readlink -f "$SECRET_ROOT")" == "$SECRET_ROOT" ]]
[[ "$(cat "$SECRET_ROOT/.codex-owned-run")" == "$EXPECTED_OWNER" ]]
for required in vps2-password vps2-knownhosts vps2-askpass.sh; do
  path="$SECRET_ROOT/$required"
  [[ -f "$path" && ! -L "$path" ]]
  [[ "$(stat -c %a "$path")" =~ ^(400|500|600|700)$ ]]
done

export VPS2_PASSWORD_FILE="$SECRET_ROOT/vps2-password"
export SSH_ASKPASS="$SECRET_ROOT/vps2-askpass.sh"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY=daily-song-list-wdc

exec ssh \
  -N -T \
  -o BatchMode=no \
  -o NumberOfPasswordPrompts=1 \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$SECRET_ROOT/vps2-knownhosts" \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o Compression=no \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${RELAY_PORT}" \
  "${VPS2_USER}@${VPS2_HOST}"
