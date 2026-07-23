# 2026-07-22-source-backfill-batch68-amanofustella-shard12of16-mac-readonly

- status: success
- marker: CODEX_BATCH68_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 12/16
- imported/skipped/failed: 13/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 13
- discovery occurrences: 167
- accepted videos/occurrences/songs: 13/166/166
- accepted uniqueSongs: 147
- publishedTimestamp coverage: 13/13
- occurrence time coverage: 166/166
- occurrence seconds coverage: 166/166
- accepted thumbnail coverage: 13/13
- discovery thumbnail coverage: 225/225
- reachedEnd: true
- discovery elapsedSeconds: 300
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

- 2026-07-23T04:22:59Z stage=mac-precheck status=ok repo=/Users/be/daily-song-list
- 2026-07-23T04:22:59Z stage=discovery status=started start=2026-07-23T04:22:59Z
- 2026-07-23T04:24:59Z stage=discovery status=checkpoint checkpointMtime=1784780695
- 2026-07-23T04:25:29Z stage=discovery status=checkpoint checkpointMtime=1784780723
- 2026-07-23T04:25:59Z stage=discovery status=checkpoint checkpointMtime=1784780755
- 2026-07-23T04:26:29Z stage=discovery status=checkpoint checkpointMtime=1784780781
- 2026-07-23T04:26:59Z stage=discovery status=checkpoint checkpointMtime=1784780802
- 2026-07-23T04:27:29Z stage=discovery status=checkpoint checkpointMtime=1784780845
- 2026-07-23T04:27:59Z stage=discovery status=ok CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=225 inspected=14 videos=13 occurrences=167 elapsedSeconds=277 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch68-amanofustella-shard12of16-mac-readonly/discovery"
- 2026-07-23T04:27:59Z stage=export status=started start=2026-07-23T04:27:59Z
- 2026-07-23T04:28:00Z stage=export status=ok CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=13 usableVideos=13 acceptedVideos=13 skippedRegressions=0 occurrences=166 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch68-amanofustella-shard12of16-mac-readonly/candidate-increment-unfiltered.json"

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch68-amanofustella-shard12of16-mac-readonly removed=true
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Mac df -h:
```
CODEX_MAC_CLEANUP_OK removed=true
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   196Gi   691Gi    23%    613k  7.2G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   196Gi   691Gi    23%    613k  7.2G    0%   /System/Volumes/Data
```
- Windows C: usedBytes=255727706112 freeBytes=65411272704 tempUsed=true accidentalTempCleaned=true
- Windows D: usedBytes=470181728256 freeBytes=9903546368 artifactWritten=true
- Windows G: usedBytes=1362022121472 freeBytes=686052659200 tempUsed=true tempCleaned=true
## Delivery

- commit: false
- push: false
- deploy: false
- data/external modified: false
