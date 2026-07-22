# AmanofuStella shard 0/4 source-backfill rerun

- Status: interrupted
- Reason: user requested immediate stop after prolonged wait; remote discovery was terminated before final manifest/export/dirty-audit.
- Channel: https://www.youtube.com/@AmanofuStella
- Singer: 天ノ譜ステラ
- Discovery candidates / inspected / usable: 241 / 45 / 45
- Partial occurrences: 414
- Accepted videos / occurrences / songs: 0 / 0 / 0
- Imported / skipped / failed: 0 / 0 / 1
- Reached end: false; final discovery manifest was not produced.
- Published timestamp coverage: 45/45 partial checkpoint only
- Occurrence time/seconds coverage: 414/414 partial checkpoint only, 414/414 partial checkpoint only
- Thumbnail coverage: videos 45/45 partial checkpoint only; occurrences 414/414 partial checkpoint only
- Source-filter precheck: 2026-07-22T23:20:50Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Discovery completion marker: not present
- Export completion marker: not present
- Dirty audit: not run; no accepted increment exported.

## Dirty Audit Rules Recorded

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious only when the title lacks explicit singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.

## Stage Evidence

- Last stage: 2026-07-22T23:36:51Z stage=heartbeat discovery elapsed=901s
- Stage log tail: 2026-07-22T23:20:50Z stage=setup_start host=bedeMacBook-Air.local | 2026-07-22T23:20:50Z stage=setup_done | 2026-07-22T23:20:50Z stage=env_sourced path=/Users/be/.daily-song-list-build-env | 2026-07-22T23:20:50Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a | 2026-07-22T23:20:50Z stage=install_start host=bedeMacBook-Air.local | 2026-07-22T23:20:50Z stage=heartbeat install elapsed=0s | 2026-07-22T23:21:50Z stage=install_done exit=0 | stdout_tail:  | stdout_tail: up to date in 83ms | 2026-07-22T23:21:50Z stage=discovery_start host=bedeMacBook-Air.local | 2026-07-22T23:21:50Z stage=heartbeat discovery elapsed=0s | 2026-07-22T23:22:50Z stage=heartbeat discovery elapsed=60s | 2026-07-22T23:23:50Z stage=heartbeat discovery elapsed=120s | 2026-07-22T23:24:50Z stage=heartbeat discovery elapsed=180s | 2026-07-22T23:25:50Z stage=heartbeat discovery elapsed=240s | 2026-07-22T23:26:50Z stage=heartbeat discovery elapsed=300s | 2026-07-22T23:27:50Z stage=heartbeat discovery elapsed=360s | 2026-07-22T23:28:50Z stage=heartbeat discovery elapsed=420s | 2026-07-22T23:29:50Z stage=heartbeat discovery elapsed=480s | 2026-07-22T23:30:50Z stage=heartbeat discovery elapsed=540s | 2026-07-22T23:31:50Z stage=heartbeat discovery elapsed=600s | 2026-07-22T23:32:50Z stage=heartbeat discovery elapsed=660s | 2026-07-22T23:33:51Z stage=heartbeat discovery elapsed=720s | 2026-07-22T23:34:51Z stage=heartbeat discovery elapsed=781s | 2026-07-22T23:35:51Z stage=heartbeat discovery elapsed=841s | 2026-07-22T23:36:51Z stage=heartbeat discovery elapsed=901s
- stdout tail: > daily-song-list@1.0.0 youtube:discover-channel | > node scripts/youtube-channel-discovery.js --channel-url https://www.youtube.com/@AmanofuStella --singer-name 天ノ譜ステラ --output-dir artifacts/channel-discovery/2026-07-22-source-backfill-batch52-amanofustella-shard0of4-discovery --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --inspect-shard-count 4 --inspect-shard-index 0 --request-interval-ms 3500 --request-jitter-ms 1500 --keyword フルート --keyword 生演奏 --keyword クラリネット --keyword サックス --keyword サクソフォン --keyword sax --keyword saxophone --keyword piano streaming --keyword piano performance --keyword ピアノ演奏 --keyword live --keyword ライブ --keyword 歌 --keyword 歌枠 --keyword 弾き語り --keyword karaoke --keyword 歌ってみた --keyword 3D Live
- stderr tail: (empty)

## Cleanup

- Remote host: Mac / bedeMacBook-Air.local.
- Remote temp directory: /Users/be/codex-temp/daily-song-list-source-backfill-batch52-amanofustella-shard0of4.
- Remote cleanupStatus: removed; `test ! -e` succeeded.
- Post-cleanup `df -h /Users`: /dev/disk3s5   926Gi   135Gi   753Gi    16%    562k  7.9G    0%   /System/Volumes/Data.
- Local G: cleanupStatus removed; Test-Path returned false after cleanup.

## Storage Audit

- Windows D: final output is status-only manifest/report; no final increment files were generated.
- Windows C: was not used for temp files.
- `data/external` was not modified.
