#!/bin/sh
# Read one run-scoped password file without exposing its contents in argv/logs.
set -eu
: "${VPS2_PASSWORD_FILE:?VPS2_PASSWORD_FILE is required}"
case "$VPS2_PASSWORD_FILE" in
  /run/dsl-wdc-[0-9]*-[0-9]*/vps2-password) ;;
  *) echo "WDC_VPS2_PASSWORD_PATH_UNSAFE" >&2; exit 64 ;;
esac
[ -f "$VPS2_PASSWORD_FILE" ] && [ ! -L "$VPS2_PASSWORD_FILE" ]
exec cat -- "$VPS2_PASSWORD_FILE"
