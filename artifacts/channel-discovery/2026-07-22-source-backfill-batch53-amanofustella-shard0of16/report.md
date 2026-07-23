# AmanofuStella shard 0/16 source-backfill rerun

- Status: success
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Shard: 0/16
- Imported / skipped / failed: 0 / 0 / 0
- Discovery candidates / inspected / usable: 241 / 16 / 13
- Accepted videos / occurrences / songs: 13 / 91 / 87
- Reached end: true
- Elapsed: discovery 364s
- Published timestamp coverage: raw 241/241; detail 13/13; accepted 13/13
- Published timestamp range: {"min":1690156528751,"max":1784159737557}
- Occurrence time/seconds coverage: discovery 91/91, 91/91; accepted 91/91, 91/91
- Occurrence seconds range: {"min":0,"max":26170}
- Cover coverage: discovery videoDetails 13/13; accepted increment thumbnail fields 0/13
- Source-filter precheck: 2026-07-22T23:52:33Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Discovery marker: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=241 inspected=16 videos=13 occurrences=91 elapsedSeconds=364 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch53-amanofustella-shard0of16-discovery"
- Export marker: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=13 usableVideos=13 acceptedVideos=13 skippedRegressions=0 occurrences=91 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch53-amanofustella-shard0of16/candidate-increment-unfiltered.json"
- Postprocess marker: CODEX_BATCH53_POSTPROCESS_OK

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
- Source commit: 19044bc99634bf31ff6ed2449f7cf79f0411b8ae
- Remote temp directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16
- Discovery directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch53-amanofustella-shard0of16-discovery
- Command timeout: discovery watchdog 3600s; install/export watchdog 600s.
- Last stage before packaging: stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=13 usableVideos=13 acceptedVideos=13 skippedRegressions=0 occurrences=91 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch53-amanofustella-shard0of16/candidate-increment-unfiltered.json"

## Cleanup

- Remote cleanupStatus: removed; remoteTempExistsAfterCleanup=false.
- Remote cleanup marker: CODEX_REMOTE_BATCH53_CLEANUP_OK.
- Post-cleanup df -h /Users: /dev/disk3s5 926Gi 135Gi 753Gi 16% 562k 7.9G 0% /System/Volumes/Data.
- Windows G: cleanupStatus removed; localTempExistsAfterCleanup=false.

## Storage Audit

- Windows D: no large files added; final artifact total 148457 bytes.
- Windows C: not used.
- `data/external` was not modified.
- No commit, push, deploy, restart, package, or install was performed.

## Remote Cleanup Raw

```text
cleanupStatus=removed target=/Users/be/codex-temp/daily-song-list-source-backfill-batch53-amanofustella-shard0of16
remoteTempExistsAfterCleanup=false
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   135Gi   753Gi    16%    562k  7.9G    0%   /System/Volumes/Data
CODEX_REMOTE_BATCH53_CLEANUP_OK
```
