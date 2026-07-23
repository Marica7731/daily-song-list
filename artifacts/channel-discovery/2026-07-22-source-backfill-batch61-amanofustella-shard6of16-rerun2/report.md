# AmanofuStella shard 6/16 source-backfill rerun2

- Status: interrupted
- Failure reason: Interrupted by main session while the Windows to Mac source archive transfer was still in progress. Remote setup was not executed, discovery/export/postprocess never started, and no candidate checkpoint could exist because discovery never launched.
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Shard: 6/16
- Imported / skipped / failed: 0 / 0 / 1
- Discovery candidates / inspected / usable: 0 (not_started_source_archive_transfer_interrupted_before_remote_setup) / 0 / 0
- Partial occurrences: 0
- Accepted videos / occurrences / songs: 0 / 0 / 0
- Reached end: false (not_reached_discovery_not_started)
- Published timestamp coverage: detail 0/0; accepted 0/0
- Occurrence time/seconds coverage: discovery 0/0, 0/0; accepted 0/0, 0/0
- Cover coverage: discovery videoDetails 0/0; accepted increment thumbnail fields 0/0
- Source-filter precheck: local-only CODEX_SOURCE_FILTER_LOCAL_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a; remote precheck not reached because setup did not run.
- Discovery marker: none; discovery never started.
- Export marker: none; export never started.
- Postprocess marker: none; success postprocess never ran.
- Status marker: CODEX_BATCH61_STATUS_ONLY_INTERRUPTED

## Files

- `candidate-increment-unfiltered.json` is status-only with zero videos because discovery never started.
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

- Host: Windows orchestration targeting Mac SSH 192.168.1.13.
- Source commit: db432af6.
- Local source archive size before cleanup: 10882242560 bytes.
- Remote partial archive size observed before cleanup: 10719461376 bytes.
- Remote temp directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch61-amanofustella-shard6of16-rerun2.
- Discovery directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch61-amanofustella-shard6of16-rerun2/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch61-amanofustella-shard6of16-rerun2-discovery.
- Command timeout plan: install/export/postprocess watchdog 600s; discovery watchdog 3600s.
- Last stage: status-only artifact write after interrupt during source archive transfer.

## Cleanup

- Remote cleanupStatus: removed; remoteTempExistsAfterCleanup=false.
- Remote /tmp transfer fragments after cleanup: false.
- Remote cleanup marker: CODEX_REMOTE_BATCH61_CLEANUP_OK.
- Post-cleanup df -h /Users: /dev/disk3s5   926Gi   146Gi   741Gi    17%    565k  7.8G    0%   /System/Volumes/Data.
- Windows G cleanupStatus: removed; localTempExistsAfterCleanup=false.

## Storage Audit

- Windows D: final status artifact total is recorded in manifest storageAudit.
- Windows C: was not used for temp/cache/package files.
- `data/external` was not modified.
- No commit, push, deploy, restart, package, or install was performed.

## Stage Log Tail

```text
2026-07-23T02:40:00Z stage=windows_precheck repo=D:\Projects\daily_song_list_worker_source_backfill_20260720 branch=codex/source-backfill-20260720-v2 head=db432af6 targetDirAbsent=true
2026-07-23T02:40:00Z stage=local_source_filter_precheck CODEX_SOURCE_FILTER_LOCAL_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
2026-07-23T02:46:27Z stage=scp_source_archive_start localBytes=10882242560 remoteTmp=/tmp/codex-batch61-amanofustella-shard6of16-rerun2-source.tar
2026-07-23T02:51:31Z stage=scp_source_archive_timeout firstAttemptRemoteBytes=7379320832 timeout=300s
2026-07-23T02:52:03Z stage=scp_source_archive_retry_start localBytes=10882242560
2026-07-23T02:56:14Z stage=main_session_interrupt_stop_requested remotePartialBytesBeforeCleanup=10719461376
2026-07-23T02:56:45Z stage=stop_local_long_processes scpStopped=true sshStopped=true
2026-07-23T02:56:50Z stage=remote_cleanup CODEX_REMOTE_BATCH61_CLEANUP_OK remoteTempExistsAfterCleanup=false remoteTmpTransferFragmentsAfterCleanup=false
2026-07-23T02:56:57Z stage=status_only_artifact_write accepted=0 discoveryStarted=false
```

## Remote Cleanup Raw

```text
cleanupStatus=removed target=/Users/be/codex-temp/daily-song-list-source-backfill-batch61-amanofustella-shard6of16-rerun2
remoteTempExistsAfterCleanup=false
remoteTmpTransferFragmentsAfterCleanup=false
/dev/disk3s5   926Gi   146Gi   741Gi    17%    565k  7.8G    0%   /System/Volumes/Data
CODEX_REMOTE_BATCH61_CLEANUP_OK
```
