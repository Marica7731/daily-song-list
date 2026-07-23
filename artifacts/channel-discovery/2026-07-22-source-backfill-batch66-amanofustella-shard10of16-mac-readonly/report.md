# 2026-07-22-source-backfill-batch66-amanofustella-shard10of16-mac-readonly

- status: success
- marker: CODEX_BATCH66_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 10/16
- imported/skipped/failed: 2/0/0
- candidateCount: 49
- inspectedCount: 3
- usableVideoCount: 2
- discovery occurrences: 5
- accepted videos/occurrences/songs: 2/5/5
- accepted uniqueSongs: 5
- publishedTimestamp coverage: 2/2
- occurrence time coverage: 5/5
- occurrence seconds coverage: 5/5
- accepted thumbnail coverage: 2/2
- discovery thumbnail coverage: 49/49
- reachedEnd: false
- discovery elapsedSeconds: 43
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
- discovery: started
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=49 inspected=3 videos=2 occurrences=5 elapsedSeconds=43 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch66-amanofustella-shard10of16-mac-readonly/discovery"
- export: started
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=2 usableVideos=2 acceptedVideos=2 skippedRegressions=0 occurrences=5 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch66-amanofustella-shard10of16-mac-readonly/candidate-increment-unfiltered.json"
- dirty-audit: ok
- mac-cleanup: ok; CODEX_MAC_CLEANUP_OK removed=true
- windows-cleanup: ok; CODEX_WINDOWS_DISK_STATUS_OK

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch66-amanofustella-shard10of16-mac-readonly removed=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Mac df -h:
```
CODEX_MAC_CLEANUP_OK removed=true
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   164Gi   716Gi    19%    584k  7.5G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   164Gi   716Gi    19%    584k  7.5G    0%   /System/Volumes/Data
```
- Windows C: usedBytes=255941410816 freeBytes=65197568000 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470180843520 freeBytes=9904431104 artifactWritten=true
- Windows G: usedBytes=1362010427392 freeBytes=686064353280 tempUsed=true tempCleaned=true

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
