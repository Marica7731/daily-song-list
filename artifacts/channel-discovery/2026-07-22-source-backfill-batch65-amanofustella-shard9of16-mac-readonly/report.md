# 2026-07-22-source-backfill-batch65-amanofustella-shard9of16-mac-readonly

- status: success
- marker: CODEX_BATCH65_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 9/16
- imported/skipped/failed: 2/0/0
- candidateCount: 49
- inspectedCount: 3
- usableVideoCount: 2
- discovery occurrences: 10
- accepted videos/occurrences/songs: 2/10/10
- accepted uniqueSongs: 10
- publishedTimestamp coverage: 2/2
- occurrence time coverage: 10/10
- occurrence seconds coverage: 10/10
- accepted thumbnail coverage: 2/2
- discovery thumbnail coverage: 49/49
- reachedEnd: false
- discovery elapsedSeconds: 42
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
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=49 inspected=3 videos=2 occurrences=10 elapsedSeconds=42 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch65-amanofustella-shard9of16-mac-readonly/discovery"
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=2 usableVideos=2 acceptedVideos=2 skippedRegressions=0 occurrences=10 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch65-amanofustella-shard9of16-mac-readonly/candidate-increment-unfiltered.json"
- dirty-audit: ok
- mac-cleanup: ok; CODEX_MAC_CLEANUP_OK removed=true
- windows-cleanup: ok; CODEX_WINDOWS_DISK_STATUS_OK

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch65-amanofustella-shard9of16-mac-readonly removed=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Mac df -h: /dev/disk3s5 926Gi size, 151Gi used, 736Gi avail, 18% capacity
- Windows C: usedBytes=255958552576 freeBytes=65180426240 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470180900864 freeBytes=9904373760 artifactWritten=true
- Windows G: usedBytes=1354955927552 freeBytes=693118853120 tempUsed=true tempCleaned=true

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
