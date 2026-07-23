# AmanofuStella shard 6/16 source-backfill rerun

- Status: interrupted
- Failure reason: Interrupted after remote discovery/export completed but before successful local five-file postprocess; target directory was still missing during the main wait window, so accepted output is intentionally zero.
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Shard: 6/16
- Imported / skipped / failed: 0 / 0 / 1
- Discovery candidates / inspected / usable: 241 / 15 / 12
- Partial occurrences: 151
- Accepted videos / occurrences / songs: 0 / 0 / 0
- Reached end: true
- Published timestamp coverage: detail 12/12; accepted 0/0
- Occurrence time/seconds coverage: discovery 151/151, 151/151; accepted 0/0, 0/0
- Source-filter precheck: 2026-07-23T02:03:30Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Discovery marker: 2026-07-23T02:09:32Z stage=discovery_done exit=0 marker=CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK
- Export marker: stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=151 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch59-amanofustella-shard6of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch59-amanofustella-shard6of16/candidate-increment-unfiltered.json"
- Status marker: CODEX_BATCH59_STATUS_ONLY_INTERRUPTED

## Files

- `candidate-increment-unfiltered.json` contains the exported candidate increment from the completed remote export.
- `accepted-increment.json` is status-only with zero accepted videos because local five-file postprocess was interrupted before completion.
- `dirty-audit.json` records the requested audit policy and candidate audit counts, but no accepted output was finalized.
- `manifest.json` and `report.md` are status-only and must not be treated as a successful shard artifact.

## Dirty Audit

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious/drop only when the title lacks explicit singing signals such as 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- Candidate audit dropped 0 videos / 0 occurrences.
- Candidate audit suspicious 0 videos.

## Cleanup

- Remote cleanupStatus: removed; remoteTempExistsAfterCleanup=false.
- Remote cleanup marker: CODEX_REMOTE_BATCH59_CLEANUP_OK.
- Post-cleanup df -h /Users: /dev/disk3s5   926Gi   135Gi   752Gi    16%    565k  7.9G    0%   /System/Volumes/Data.
- Windows G cleanupStatus: removed; localTempExistsAfterCleanup=false.

## Storage Audit

- Windows D: final status artifact total 110862 bytes.
- Windows C: not used for temp/cache/package files.
- `data/external` was not modified.
- No commit, push, deploy, restart, package, or install was performed.

## Remote Cleanup Raw

```text
cleanupStatus=removed target=/Users/be/codex-temp/daily-song-list-source-backfill-batch59-amanofustella-shard6of16
remoteTempExistsAfterCleanup=false
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   135Gi   752Gi    16%    565k  7.9G    0%   /System/Volumes/Data
CODEX_REMOTE_BATCH59_CLEANUP_OK

```
