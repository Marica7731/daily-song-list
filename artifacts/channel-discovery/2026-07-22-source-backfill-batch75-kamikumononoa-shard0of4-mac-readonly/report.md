# batch75 KAMIKUMONONOA shard0/4 status-only report

- status: interrupted
- source: https://www.youtube.com/@KAMIKUMONONOA
- shard: 0/4
- imported: 0
- skipped: 0
- failed: 1
- accepted videos: 0
- accepted occurrences: 0
- accepted songs: 0
- uniqueSongs: 0
- candidateCount: 0
- inspectedCount: 0
- usableVideoCount: 0
- reachedEnd: false
- failureReason: 12-minute no checkpoint/progress after start marker on shard0of4

## Stage Log

- Windows repo/root verified at D:\Projects\daily_song_list_worker_source_backfill_20260720; branch codex/source-backfill-20260720-v2; HEAD 3e92e9b3b9049e247e6ee89230d9891eb62228a0
- Windows startup marker worker-started.marker.txt created at 2026-07-23T14:03:23+08:00
- Local duplicate check found old batch73 KAMIKUMONONOA artifact only; its manifest status was interrupted, so it was not a complete duplicate
- Mac preflight completed at 2026-07-23T14:04:05+08:00; repo /Users/be/daily-song-list; HEAD f1b0e8423e755b2c3b38a5288c98bca3e5d092cc; source-filter sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103; size 60415 bytes; CODEX_PREFLIGHT_OK
- Discovery was started for https://www.youtube.com/@KAMIKUMONONOA with --inspect-shard-index 0 --inspect-shard-count 4, but no Windows-visible discovery/export/checkpoint artifact appeared before the 12-minute bound
- User requested immediate stop; no discovery/export was allowed to continue after interruption request
- Remote stop/cleanup executed at 2026-07-23T14:15:27+08:00; target temp removed; CODEX_REMOTE_STOP_CLEANUP_OK
- Remote residual check at 2026-07-23T14:15:35+08:00 found no pgrep matches for temp path or KAMIKUMONONOA; path_check REMOVED; CODEX_REMOTE_RESIDUAL_CHECK_OK
- G:\codex-temp matching batch75 directory was not found and is therefore clean; CODEX_G_CLEANUP_OK
- Final status-only five-file artifact written on Windows; worker-started.marker.txt removed

## Tool Evidence

- discovery script: scripts/youtube-channel-discovery.js
- export script: scripts/export-channel-discovery-increment.js
- source-filter sha256: bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103
- source-filter size: 60415 bytes

## Cleanup Evidence

- Mac temp: /Users/be/codex-temp/daily-song-list-source-backfill-batch75-kamikumononoa-shard0of4-mac-readonly
- Mac cleanup markers: CODEX_REMOTE_STOP_CLEANUP_OK; CODEX_REMOTE_RESIDUAL_CHECK_OK
- Mac residual process check: no pgrep matches for temp path or KAMIKUMONONOA at 2026-07-23T14:15:35+08:00
- Mac path check: REMOVED
- Mac df before cleanup: /dev/disk3s5 926Gi Used 260Gi Avail 627Gi Capacity 30% /System/Volumes/Data
- Mac df after cleanup: /dev/disk3s5 926Gi Used 260Gi Avail 627Gi Capacity 30% /System/Volumes/Data
- G temp: G:\codex-temp\daily-song-list-source-backfill-batch75-kamikumononoa-shard0of4-mac-readonly absent
- Windows drives after cleanup: C free 60.88 GiB; D free 9.22 GiB; G free 638.92 GiB

## Validation Markers

- CODEX_PREFLIGHT_OK
- CODEX_REMOTE_STOP_CLEANUP_OK
- CODEX_REMOTE_RESIDUAL_CHECK_OK
- CODEX_G_CLEANUP_OK
