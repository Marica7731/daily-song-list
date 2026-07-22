# Kyoka_0609 shard 15/16 source-backfill rerun

- Status: success
- Channel: https://www.youtube.com/@Kyoka_0609
- Shard: 15/16
- Generated at: 2026-07-22T22:59:22.725Z
- Discovery candidates: 165
- Inspected latest run: 10
- Discovery usable videos / occurrences: 10 / 218
- Unfiltered increment videos / occurrences: 10 / 218
- Accepted videos / occurrences / songs: 10 / 218 / 218
- Imported / skipped / failed: 10 / 0 / 0
- Reached end: true
- Coverage published/time/seconds/thumbnail: 10/10, 218/218, 218/218, 0/10
- Discovery detail thumbnail coverage: 10/10
- Dirty dropped / suspicious: 0 / 0
- Source-filter precheck: CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a
- Elapsed seconds: 601

## Accepted Videos

- 8qooRmisSIk | 🏮 実写 #歌枠 ｜今日を楽しく終えるため、明日も楽しく過ごせるために歌う！ #shorts #Vtuber ∞ 響架 | songs=20
- kDLj_ZRg26c | 🏮【 実写歌枠 】金曜深夜ですね？一緒に過ごしてくれますか？ #shorts #Vtuber 【 響架 】 | songs=30
- GfkZDdCMBd4 | 🏮【#歌枠/#KARAOKE】ド深夜はお歌の時間♪明日は待望の歌枠リレーなので声出しする♡【 響架 】 | songs=31
- C4i4ZrBDNQ8 | 🏮【 実写歌枠 】あたしの歌、よかったら聞いてって!!💗 #shorts #Vtuber 【 響架 】 | songs=13
- SzW541QBOwE | 🏮【 実写歌枠 】せっかくの夜だし、一緒に楽しい時間過ごしちゃおっか。 #shorts #Vtuber 【 響架 】 | songs=19
- _kNAHVcF1R8 | 【#ひなうか100曲耐久】２日目！最後の一瞬までぶちアガってこぉ！！🔥【歌枠】 #菜鳥ひなた #響架 | songs=49
- aisR0XADOUI | 🏮【 実写歌枠 】GW最終日.ᐟ最後の一瞬まで一緒に過ごそ🎵 #shorts #Vtuber 【 響架 】 | songs=15
- Nla25yneFLE | 🏮【 実写歌枠 】歌っていく〜.ᐟ深夜のお歌を一緒にたのしも🎵 #shorts #Vtuber 【 #最響ライブ 👹 】 | songs=17
- 1vdQDuNzvxE | 🏮【 実写歌枠 】日曜深夜はお歌の時間.ᐟアガる歌うたっていくぜっ #shorts #Vtuber 【 #最響ライブ 👹 】 | songs=16
- ZRUv2N2rHdM | 🏮【 縦型歌枠 】懐メロ中心に楽しく歌う～～‪.ᐟふんふん♪ #shorts #Vtuber 【 #最響ライブ 👹】 | songs=8

## Dropped Or Suspicious

- None

## Dirty Audit Rules

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious only when the title lacks explicit singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.

## Raw Evidence

- Raw discovery files were used to build this partial but are intentionally not part of the final local five-file artifact.
- Remote stage tail: 2026-07-22T22:49:22Z stage=setup_start host=bedeMacBook-Air.local | 2026-07-22T22:49:22Z stage=setup_done | 2026-07-22T22:49:22Z stage=precheck_source_filter CODEX_SOURCE_FILTER_PRECHECK_OK path=assets/source-filter.js bytes=20366 sha256=98658ef49b0577a202cf6f83fe7ec9898143cefd524004fcf4e8fb01ef09db2a | 2026-07-22T22:49:22Z stage=install_start host=bedeMacBook-Air.local | 2026-07-22T22:49:22Z stage=heartbeat install elapsed=0s | 2026-07-22T22:50:22Z stage=install_done exit=0 | stdout_tail:  | stdout_tail: up to date in 83ms | 2026-07-22T22:50:22Z stage=discovery_start host=bedeMacBook-Air.local | 2026-07-22T22:50:22Z stage=heartbeat discovery elapsed=0s | 2026-07-22T22:51:22Z stage=heartbeat discovery elapsed=60s | 2026-07-22T22:52:22Z stage=heartbeat discovery elapsed=120s | 2026-07-22T22:53:22Z stage=heartbeat discovery elapsed=180s | 2026-07-22T22:54:22Z stage=heartbeat discovery elapsed=240s | 2026-07-22T22:55:22Z stage=heartbeat discovery elapsed=300s | 2026-07-22T22:56:22Z stage=heartbeat discovery elapsed=360s | 2026-07-22T22:57:22Z stage=heartbeat discovery elapsed=420s | 2026-07-22T22:58:22Z stage=discovery_done exit=0 | stdout_tail: > node scripts/youtube-channel-discovery.js --channel-url https://www.youtube.com/@Kyoka_0609 --singer-name Kyoka_0609 --output-dir artifacts/channel-discovery/2026-07-22-source-backfill-batch51-kyoka-shard15of16-rerun-discovery --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --inspect-shard-count 16 --inspect-shard-index 15 --request-interval-ms 3500 --request-jitter-ms 1500 | stdout_tail:  | stdout_tail: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=165 inspected=10 videos=10 occurrences=218 elapsedSeconds=451 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch51-kyoka-shard15of16-rerun-discovery" | 2026-07-22T22:58:22Z stage=export_start host=bedeMacBook-Air.local | 2026-07-22T22:58:22Z stage=heartbeat export elapsed=0s | 2026-07-22T22:59:22Z stage=export_done exit=0 | stdout_tail: > node scripts/export-channel-discovery-increment.js --input-dir artifacts/channel-discovery/2026-07-22-source-backfill-batch51-kyoka-shard15of16-rerun-discovery --output /Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/final/candidate-increment-unfiltered.json | stdout_tail:  | stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=10 usableVideos=10 acceptedVideos=10 skippedRegressions=0 occurrences=218 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/final/candidate-increment-unfiltered.json" | 2026-07-22T22:59:22Z stage=postprocess_start
- Discovery completion marker: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=165 inspected=10 videos=10 occurrences=218 elapsedSeconds=451 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch51-kyoka-shard15of16-rerun-discovery"
- Export completion marker: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=10 usableVideos=10 acceptedVideos=10 skippedRegressions=0 occurrences=218 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/final/candidate-increment-unfiltered.json"
- Postprocess marker: CODEX_POSTPROCESS_OK acceptedVideos=10 acceptedOccurrences=218 dirtyDropped=0 suspicious=0 thumbnailCoverage=0/10 discoveryThumbnailCoverage=10/10

## Remote Cleanup

- Preferred host: `Mac`; used host: `Mac`.
- Remote directory: `/Users/be/codex-temp/daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun/repo`.
- Cleanup: removed.

- Post-cleanup `df -h /Users`: /dev/disk3s5   926Gi   135Gi   753Gi    16%    562k  7.9G    0%   /System/Volumes/Data.

## Local Temp Cleanup

- Temp directory: `G:\codex-temp\daily-song-list-source-backfill-batch51-kyoka-shard15of16-rerun`.
- Cleanup: removed; cleanup removed G: temp directory and `Test-Path` returned false.

## Storage Audit

- Windows D: contains only the final five small artifact files for this shard.
- Windows C: was not used for temp files.
