# 2026-07-22-source-backfill-batch64-amanofustella-shard8of16-mac-readonly

- status: interrupted
- marker: CODEX_BATCH64_SOURCE_BACKFILL_INTERRUPTED
- channel: https://www.youtube.com/@AmanofuStella
- shard: 8/16
- imported/skipped/failed: 0/0/1
- accepted videos/occurrences/songs: 0/0/0
- accepted uniqueSongs: 0
- candidateCount: 0
- inspectedCount: 0
- usableVideoCount: 0
- reachedEnd: false
- failureReason: 10-minute no checkpoint/progress after start marker

## Stage Log

- windows-start-marker: ok
- mac-precheck: ok; source-filter.js sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103, size 60415
- discovery: interrupted; no successful result used for artifact
- export: not_started
- dirty-audit: status_only; dropped videos/occurrences 0/0; suspicious 0
- mac-cleanup: ok; CODEX_MAC_CLEANUP_OK removed=true
- windows-cleanup: ok; CODEX_WINDOWS_DISK_STATUS_OK

## Dirty Audit Policy

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live rule: live/ライブ is suspicious/drop only when the title lacks singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた

## Cleanup

- Mac temp dir: /Users/be/codex-temp/daily-song-list-source-backfill-batch64-amanofustella-shard8of16-mac-readonly removed=true
- Mac df -h: /dev/disk3s5 926Gi size, 136Gi used, 751Gi avail, 16% capacity
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Windows C: usedBytes=255946297344 freeBytes=65192681472 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470180589568 freeBytes=9904685056 artifactWritten=true
- Windows G: usedBytes=1352690348032 freeBytes=695384432640 tempUsed=false tempCleaned=true

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
