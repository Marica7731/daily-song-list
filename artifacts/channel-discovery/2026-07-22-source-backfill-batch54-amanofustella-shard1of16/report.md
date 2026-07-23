# AmanofuStella shard 1/16 source-backfill rerun

- Status: success
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Shard: 1/16
- Imported / skipped / failed: 0 / 0 / 0
- Discovery candidates / inspected / usable: 241 / 15 / 11
- Accepted videos / occurrences / songs: 11 / 127 / 127
- Reached end: true
- Elapsed: discovery 335s
- Published timestamp coverage: raw 0/241; detail 11/11; accepted 11/11
- Published timestamp range: {"min":1721693806027,"max":1766621806027}
- Occurrence time/seconds coverage: discovery 0/127, 127/127; accepted 127/127, 127/127
- Occurrence seconds range: {"min":98,"max":26997}
- Cover coverage: discovery videoDetails 11/11; accepted increment thumbnail fields 0/11
- Source-filter precheck: 2026-07-23T00:13:48Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Discovery marker: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=241 inspected=15 videos=11 occurrences=127 elapsedSeconds=335 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch54-amanofustella-shard1of16-discovery"
- Export marker: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=127 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch54-amanofustella-shard1of16/candidate-increment-unfiltered.json"
- Postprocess marker: CODEX_BATCH54_POSTPROCESS_OK

## Files

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`

## Dirty Audit

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious/drop only when the title lacks explicit singing signals such as 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- Dropped 0 videos / 0 occurrences.
- Suspicious 0 videos.

## Execution

- Host: Mac / bedeMacBook-Air.local
- Source commit: bf3e0e0f00213204a6c67a8b0034bd34775f5c02
- Remote temp directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16
- Discovery directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch54-amanofustella-shard1of16-discovery
- Command timeout: discovery watchdog 3600s; install/export watchdog 600s.
- Last stage before packaging: stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=127 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch54-amanofustella-shard1of16/candidate-increment-unfiltered.json"

## Cleanup

- Remote cleanupStatus: removed; remoteTempExistsAfterCleanup=false.
- Remote cleanup marker: CODEX_REMOTE_BATCH54_CLEANUP_OK.
- Post-cleanup df -h /Users: /dev/disk3s5 926Gi 135Gi 752Gi 16% 562k 7.9G 0% /System/Volumes/Data.
- Windows G: cleanupStatus removed; localTempExistsAfterCleanup=false.

## Storage Audit

- Windows D: no large files added; final artifact total 177926 bytes.
- Windows C: not used.
- `data/external` was not modified.
- No commit, push, deploy, restart, package, or install was performed.

## Remote Cleanup Raw

```text
cleanupStatus=removed target=/Users/be/codex-temp/daily-song-list-source-backfill-batch54-amanofustella-shard1of16
remoteTempExistsAfterCleanup=false
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   135Gi   752Gi    16%    562k  7.9G    0%   /System/Volumes/Data
CODEX_REMOTE_BATCH54_CLEANUP_OK
```
