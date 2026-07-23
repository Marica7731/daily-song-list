# batch73 KAMIKUMONONOA source-backfill status-only report

- status: interrupted
- source: https://www.youtube.com/@KAMIKUMONONOA
- accepted/imported/skipped/failed: 0/0/0/1
- failureReason: 12-minute no checkpoint/progress after start marker; user requested immediate interruption before full discovery/export completed
- candidate-only checkpoint: candidates=36, inspected=0, videos=0, occurrences=0, elapsedSeconds=14
- full discovery: started but stopped before completion; no export was produced
- Mac cleanup: CODEX_REMOTE_CLEANUP_OK; temp dir removed
- Mac df before cleanup: /dev/disk3s5 926Gi size, 232Gi used, 655Gi available, 27% capacity
- Mac df after cleanup: /dev/disk3s5 926Gi size, 232Gi used, 655Gi available, 27% capacity
- G cleanup: no matching G:\codex-temp batch73/kamikumononoa directory found

## Stage log
- preflight started on Mac at 2026-07-23T13:27:24+08:00; repo=/Users/be/daily-song-list; head=f1b0e8423e755b2c3b38a5288c98bca3e5d092cc; source-filter sha256=bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103 size=60415; CODEX_PREFLIGHT_OK
- candidate-only first attempt failed immediately because Mac lacks GNU timeout, rc=127
- candidate-only rerun completed at 2026-07-23T13:28:15+08:00; candidates=36 inspected=0 videos=0 occurrences=0 elapsedSeconds=14; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK
- full-discovery started at 2026-07-23T13:28:25+08:00 but was interrupted by user request before discovery/export completed; no accepted increment was generated
- remote process scan found zsh/npm/node full-discovery PIDs 31327/31329/31339; all were terminated before cleanup
- Mac temp directory /Users/be/codex-temp/daily-song-list-source-backfill-batch73-kamikumononoa-mac-readonly removed; G:\codex-temp had no matching batch73 directory

## Verification marker
CODEX_STATUS_ONLY_ARTIFACT_OK
