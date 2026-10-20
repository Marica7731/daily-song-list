#!/usr/bin/env bash
# Bounded push helper for the shallow delivery clone.
#
# Builds a commit on top of the newest origin/main from the listed working-tree files,
# then pushes it, retrying while remote repair commits keep moving main. Restricted to
# the local clone; never fetches more than one commit of depth and never rewrites history.
#
# usage: scripts/static/push-bounded.sh "<message>" <path> [<path> ...]
set -Eeuo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <commit message> <path> [<path> ...]" >&2
  exit 64
fi

message="$1"
shift
paths=("$@")

cd "$(git rev-parse --show-toplevel)"

for path in "${paths[@]}"; do
  [[ -e "$path" ]] || { echo "push-bounded: missing path $path" >&2; exit 65; }
done

for attempt in 1 2 3 4 5 6; do
  git fetch --depth=1 origin main >/dev/null 2>&1 || { echo "push-bounded: fetch failed" >&2; exit 66; }
  base="$(git rev-parse origin/main)"
  index_file="$(mktemp -u "${TMPDIR:-/tmp}/push-index.XXXXXX")"
  export GIT_INDEX_FILE="$index_file"
  git read-tree "$base"
  for path in "${paths[@]}"; do
    blob="$(git hash-object -w "$path")"
    git update-index --add --cacheinfo "100644,$blob,$path"
  done
  tree="$(git write-tree)"
  commit="$(git commit-tree "$tree" -p "$base" -m "$message")"
  unset GIT_INDEX_FILE
  if git push origin "$commit:main" 2>&1 | sed 's/^/push-bounded: /'; then
    if git cat-file -e "$commit" 2>/dev/null; then
      echo "push-bounded: pushed $(git rev-parse --short "$commit") on attempt $attempt"
      exit 0
    fi
  fi
  echo "push-bounded: attempt $attempt rejected, retrying" >&2
  sleep 4
done

echo "push-bounded: exhausted retries" >&2
exit 67
