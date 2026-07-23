# AmanofuStella shard 6/16 source-backfill rerun

- Status: interrupted
- Failure reason: Interrupted by main session before discovery completed. Remote discovery was stopped at heartbeat elapsed=120s; no discovery manifest/checkpoint/video-details were written, export and postprocess never started, and accepted output is intentionally zero.
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Shard: 6/16
- Imported / skipped / failed: 0 / 0 / 1
- Discovery candidates / inspected / usable: 0 (unknown_no_discovery_manifest_or_checkpoint_written) / 0 / 0
- Partial occurrences: 0
- Accepted videos / occurrences / songs: 0 / 0 / 0
- Reached end: false (not_reached_discovery_interrupted)
- Published timestamp coverage: detail 0/0; accepted 0/0
- Occurrence time/seconds coverage: discovery 0/0, 0/0; accepted 0/0, 0/0
- Cover coverage: discovery videoDetails 0/0; accepted increment thumbnail fields 0/0
- Source-filter precheck: 2026-07-23T02:30:01Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Discovery marker: none; discovery was interrupted before CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK.
- Export marker: none; export never started.
- Postprocess marker: none; success postprocess never ran.
- Status marker: CODEX_BATCH60_STATUS_ONLY_INTERRUPTED

## Files

- `candidate-increment-unfiltered.json` is status-only with zero videos because discovery wrote no checkpoint/manifest before interruption.
- `accepted-increment.json` is status-only with zero accepted videos.
- `dirty-audit.json` records the requested audit policy; no videos were evaluated.
- `manifest.json` and `report.md` are status-only and must not be treated as a successful shard artifact.

## Dirty Audit

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious/drop only when the title lacks explicit singing signals such as 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- Candidate audit dropped 0 videos / 0 occurrences.
- Candidate audit suspicious 0 videos / 0 occurrences.

## Execution

- Host: Mac / bedeMacBook-Air.local
- Source commit: 2a720f54ee497a67590f8225039260fd3f5740b1
- Remote temp directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch60-amanofustella-shard6of16-rerun
- Discovery directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch60-amanofustella-shard6of16-rerun/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch60-amanofustella-shard6of16-rerun-discovery
- Command timeout: install/export/postprocess watchdog 600s; discovery watchdog 3600s.
- Last remote stage: discovery heartbeat elapsed=120s.

## Cleanup

- Remote cleanupStatus: removed; remoteTempExistsAfterCleanup=false.
- Remote cleanup marker: CODEX_REMOTE_BATCH60_CLEANUP_OK.
- Post-cleanup df -h /Users: /dev/disk3s5   926Gi   136Gi   751Gi    16%    565k  7.9G    0%   /System/Volumes/Data.
- Windows G cleanupStatus: removed; localTempExistsAfterCleanup=false.

## Storage Audit

- Windows D: final status artifact total 16941 bytes.
- Windows C: C: was not used for temp/cache/package files.
- `data/external` was not modified.
- No commit, push, deploy, restart, package, or install was performed.

## Remote Cleanup Raw

```text
cleanupStatus=removed target=/Users/be/codex-temp/daily-song-list-source-backfill-batch60-amanofustella-shard6of16-rerun
remoteTempExistsAfterCleanup=false
/dev/disk3s5   926Gi   136Gi   751Gi    16%    565k  7.9G    0%   /System/Volumes/Data
CODEX_REMOTE_BATCH60_CLEANUP_OK
```
