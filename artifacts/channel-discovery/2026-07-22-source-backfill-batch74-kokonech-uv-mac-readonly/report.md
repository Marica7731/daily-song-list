# batch74 KOKONEch_uv status-only artifact

- Status: interrupted
- Source: https://www.youtube.com/@KOKONEch_uv/streams
- accepted/imported/skipped/failed: 0/0/0/1
- candidateCount: 0
- inspectedCount: 0
- usableVideoCount: 0
- accepted videos/occurrences/songs: 0/0/0
- uniqueSongs: 0
- publishedTimestamp coverage: 0/0
- occurrence time/seconds coverage: 0/0 / 0/0
- accepted thumbnailUrl coverage: 0/0
- discovery thumbnail coverage: 0/0
- reachedEnd: false
- elapsedSeconds: 0
- failureReason: 12-minute no checkpoint/progress after start marker

## Stage Log
- windows_start_marker_written: worker-started.marker was created before interruption
- mac_precheck_completed: repo=/Users/be/daily-song-list, source-filter.js size=60415, sha256=bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103
- remote_cleanup_completed: /Users/be/codex-temp/daily-song-list-source-backfill-batch74-kokonech-uv-mac-readonly exists=no at 2026-07-23T13:55:56+08:00
- g_cleanup_completed: G:\codex-temp\daily-song-list-batch74 exists=False at 2026-07-23T13:55:55.5948342+08:00
- artifact_status_written: status-only interrupted artifact; discovery/export output intentionally not used after interruption

## Cleanup Evidence
- Mac: REMOTE_CLEANUP_MARKER 2026-07-23T13:55:56+08:00 root=/Users/be/codex-temp/daily-song-list-source-backfill-batch74-kokonech-uv-mac-readonly exists=no
- Mac df: /dev/disk3s5 926Gi 248Gi 639Gi 29% /System/Volumes/Data
- Windows C: Free=65371996160 Used=255766982656 Root=C:\
- Windows D: Free=9901510656 Used=470183763968 Root=D:\
- Windows G: Free=686044594176 Used=1362030186496 Root=G:\
- G cleanup: G_CLEANUP_MARKER exists=False path=G:\codex-temp\daily-song-list-batch74 time=2026-07-23T13:55:55.5948342+08:00

VALIDATION_MARKER BATCH74_STATUS_ONLY_INTERRUPTED_OK files=5 accepted=0 imported=0 skipped=0 failed=1 cleanup=ok
