# 2026-07-22-source-backfill-batch70-amanofustella-shard13of16-mac-readonly

- status: success
- marker: CODEX_BATCH70_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 13/16
- imported/skipped/failed: 12/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 12
- discovery occurrences: 114
- accepted videos/occurrences/songs: 12/114/114
- accepted uniqueSongs: 107
- publishedTimestamp coverage: 12/12
- occurrence time coverage: 114/114
- occurrence seconds coverage: 114/114
- accepted thumbnail coverage: 12/12
- discovery thumbnail coverage: 225/225
- reachedEnd: true
- discovery elapsedSeconds: 337
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

- 2026-07-23T04:51:28Z stage=mac-precheck status=started repo=/Users/be/daily-song-list
- 2026-07-23T04:51:29Z stage=mac-precheck status=ok repo=/Users/be/daily-song-list head=f1b0e8423e755b2c3b38a5288c98bca3e5d092cc branch=main sourceFilterSha256=bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103 sourceFilterSizeBytes=60415 node=v20.20.2 npm=10.8.2
- 2026-07-23T04:51:29Z stage=discovery status=started start=2026-07-23T04:51:29Z
- 2026-07-23T04:51:59Z stage=discovery status=waiting checkpoint=missing
- 2026-07-23T04:52:29Z stage=discovery status=waiting checkpoint=missing
- 2026-07-23T04:52:59Z stage=discovery status=waiting checkpoint=missing
- 2026-07-23T04:53:29Z stage=discovery status=checkpoint checkpointMtime=1784782407
- 2026-07-23T04:53:59Z stage=discovery status=checkpoint checkpointMtime=1784782417
- 2026-07-23T04:54:29Z stage=discovery status=checkpoint checkpointMtime=1784782466
- 2026-07-23T04:54:59Z stage=discovery status=checkpoint checkpointMtime=1784782480
- 2026-07-23T04:55:29Z stage=discovery status=checkpoint checkpointMtime=1784782525
- 2026-07-23T04:55:59Z stage=discovery status=checkpoint checkpointMtime=1784782550
- 2026-07-23T04:56:29Z stage=discovery status=checkpoint checkpointMtime=1784782587
- 2026-07-23T04:56:59Z stage=discovery status=checkpoint checkpointMtime=1784782605
- 2026-07-23T04:56:59Z stage=discovery status=ok CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=225 inspected=14 videos=12 occurrences=114 elapsedSeconds=317 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch70-amanofustella-shard13of16-mac-readonly/discovery"
- 2026-07-23T04:56:59Z stage=export status=started start=2026-07-23T04:56:59Z
- 2026-07-23T04:57:04Z stage=export status=ok CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=114 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch70-amanofustella-shard13of16-mac-readonly/candidate-increment-unfiltered.json"
- 2026-07-23T04:57:04Z stage=postprocess status=started

## Cleanup

- Candidate-only reachedEnd check: CODEX_REACHED_END_CHECK_OK candidateCount=225 reachedEnd=true pageSummaries=2
- Candidate-only reachedEnd cleanup: CODEX_REACHED_END_CHECK_CLEANUP_OK removed=true

- Mac cleanup marker: CODEX_MAC_ALL_TEMP_CLEANED_OK originalRemoved=true stagingRemoved=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK

## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false

- Mac final df -h:
```
CODEX_MAC_ALL_TEMP_CLEANED_OK originalRemoved=true stagingRemoved=true
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   202Gi   685Gi    23%    626k  7.2G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   202Gi   685Gi    23%    626k  7.2G    0%   /System/Volumes/Data
```
- Windows C: usedBytes=255745855488 freeBytes=65393123328 tempUsed=false accidentalTempCleaned=true
- Windows D: usedBytes=470182408192 freeBytes=9902866432 artifactWritten=true
- Windows G: usedBytes=1362023006208 freeBytes=686051774464 tempUsed=true tempCleaned=true
