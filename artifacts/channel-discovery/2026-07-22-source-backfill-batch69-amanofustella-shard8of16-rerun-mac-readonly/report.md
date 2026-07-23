# 2026-07-22-source-backfill-batch69-amanofustella-shard8of16-rerun-mac-readonly

- status: success
- marker: CODEX_BATCH69_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 8/16
- imported/skipped/failed: 14/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 14
- discovery occurrences: 134
- accepted videos/occurrences/songs: 14/134/134
- accepted uniqueSongs: 124
- publishedTimestamp coverage: 14/14
- occurrence time coverage: 134/134
- occurrence seconds coverage: 134/134
- accepted thumbnail coverage: 14/14
- discovery thumbnail coverage: 225/225
- reachedEnd: false
- discovery elapsedSeconds: 277
- failureReason:

## Dirty Audit

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live rule: live/ライブ is suspicious/drop only when the title lacks explicit singing signals such as 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- dropped videos/occurrences: 0/0
- suspicious kept videos: 0

## Precheck

- Mac repo: /Users/be/daily-song-list
- Mac repo HEAD: f1b0e8423e755b2c3b38a5288c98bca3e5d092cc
- source-filter.js: assets/source-filter.js, sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103, size 60415

## Stage Log

- windows-start-marker: ok
- mac-precheck: ok
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=225 inspected=14 videos=14 occurrences=134 elapsedSeconds=277 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch69-amanofustella-shard8of16-rerun-mac-readonly/discovery"
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=14 usableVideos=14 acceptedVideos=14 skippedRegressions=0 occurrences=134 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch69-amanofustella-shard8of16-rerun-mac-readonly/candidate-increment-unfiltered.json"
- dirty-audit: ok
- mac-cleanup: ok; CODEX_MAC_TEMP_REMOVED_OK
- windows-cleanup: ok; CODEX_WINDOWS_DISK_STATUS_OK

## Cleanup

- Mac cleanup marker: CODEX_MAC_TEMP_REMOVED_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch69-amanofustella-shard8of16-rerun-mac-readonly removed=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Mac df -h: /dev/disk3s5 926Gi size, 202Gi used, 685Gi avail, 23% capacity
- Windows C: usedBytes=255745347584 freeBytes=65393631232 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470182191104 freeBytes=9903083520 artifactWritten=true
- Windows G: usedBytes=1362022559744 freeBytes=686052220928 tempUsed=false tempCleaned=true

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
