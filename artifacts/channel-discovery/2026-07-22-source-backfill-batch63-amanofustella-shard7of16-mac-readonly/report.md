# 2026-07-22-source-backfill-batch63-amanofustella-shard7of16-mac-readonly

- status: success
- marker: CODEX_BATCH63_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 7/16
- imported/skipped/failed: 12/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 12
- discovery occurrences: 116
- accepted videos/occurrences/songs: 12/116/116
- accepted uniqueSongs: 103
- publishedTimestamp coverage: 12/12
- occurrence time coverage: 116/116
- occurrence seconds coverage: 116/116
- accepted thumbnail coverage: 12/12
- discovery thumbnail coverage: 225/225
- reachedEnd: false
- discovery elapsedSeconds: 334
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
- source-filter.js: sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103, size 60415

## Stage Log

- windows-start-marker: ok
- mac-precheck: ok
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=225 inspected=14 videos=12 occurrences=116 elapsedSeconds=334 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch63-amanofustella-shard7of16-mac-readonly/discovery"
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=116 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch63-amanofustella-shard7of16-mac-readonly/candidate-increment-unfiltered.json"
- dirty-audit: ok

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch63-amanofustella-shard7of16-mac-readonly removed=true
- Mac df -h: /dev/disk3s5 926Gi size, 136Gi used, 751Gi avail, 16% capacity
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Windows C: usedBytes=255923273728 freeBytes=65215705088 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470180732928 freeBytes=9904541696 artifactWritten=true
- Windows G: usedBytes=1352687140864 freeBytes=695387639808 tempUsed=true tempCleaned=true
