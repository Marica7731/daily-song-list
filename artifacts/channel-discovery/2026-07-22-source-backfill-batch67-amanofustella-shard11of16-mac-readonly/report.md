# 2026-07-22-source-backfill-batch67-amanofustella-shard11of16-mac-readonly

- status: success
- marker: CODEX_BATCH67_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 11/16
- imported/skipped/failed: 12/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 12
- discovery occurrences: 104
- accepted videos/occurrences/songs: 12/104/104
- accepted uniqueSongs: 100
- publishedTimestamp coverage: 12/12
- occurrence time coverage: 104/104
- occurrence seconds coverage: 104/104
- accepted thumbnail coverage: 12/12
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
- discovery: started
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=225 inspected=14 videos=12 occurrences=104 elapsedSeconds=277 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch67-amanofustella-shard11of16-mac-readonly/discovery"
- export: started
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=104 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch67-amanofustella-shard11of16-mac-readonly/candidate-increment-unfiltered.json"
- dirty-audit: ok
- mac-cleanup: ok; CODEX_MAC_CLEANUP_OK removed=true
- windows-cleanup: ok; CODEX_WINDOWS_DISK_STATUS_OK

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch67-amanofustella-shard11of16-mac-readonly removed=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Mac df -h:
```
CODEX_MAC_CLEANUP_OK removed=true
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   171Gi   716Gi    20%    594k  7.5G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   171Gi   716Gi    20%    594k  7.5G    0%   /System/Volumes/Data
```
- Windows C: usedBytes=255751356416 freeBytes=65387622400 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470181146624 freeBytes=9904128000 artifactWritten=true
- Windows G: usedBytes=1362015576064 freeBytes=686059204608 tempUsed=true tempCleaned=true

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
