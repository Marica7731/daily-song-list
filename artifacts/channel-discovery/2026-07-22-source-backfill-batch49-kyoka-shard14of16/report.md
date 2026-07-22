# Kyoka_0609 shard 14/16 source-backfill partial

- Status: success
- Channel: https://www.youtube.com/@Kyoka_0609
- Shard: 14/16
- Generated at: 2026-07-22T22:02:16.126Z
- Discovery candidates: 245
- Inspected latest run: 15
- Discovery usable videos / occurrences: 12 / 134
- Unfiltered increment videos / occurrences: 12 / 134
- Accepted videos / occurrences / songs: 9 / 127 / 127
- Imported / skipped / failed: 9 / 3 / 0
- Reached end: true
- Coverage published/time/seconds/thumbnail: 9/9, 127/127, 127/127, 0/9
- Discovery detail thumbnail coverage: 9/9
- Dirty dropped / suspicious: 0 / 3

## Accepted Videos

- U5a71drecUI | 🏮 実写 #歌枠 ｜VもRealも欲張りお祭り女、歌いますっ♪ #shorts #Vtuber ∞ 響架 | songs=21
- 1R4RM_EcrSE | 【 #世界で1番かわいい歌枠リレー 】あたしなりの“可愛い”をお届けしますっ【 響架 】 | songs=6
- 99B2bfMsgmI | 🏮【 #塩かずのこ家歌枠リレー /振り返り歌枠!! 】楽しかったぁあ!!愛してるよ世界で一番最高の家族💜本編PONしたのでワンモア【響架】 | songs=25
- L3xC5S5xqJM | 🏮【 コラボ歌枠 】ハロウィンの夜をロックで染める!!トリック オア ロック？🍭【 花野彩晴/響架 】 | songs=16
- XXgS1D6wNBQ | 🏮【 夏休み/実写歌枠 】お昼ですが、キミたちどう過ごしてますか？一緒に過ごしませんか？ #shorts #Vtuber 【 響架 】 | songs=21
- zlKsLy4kz8I | 🏮【 歌雑談枠 】#ひなうか100曲耐久 の振り返りしながらゆるっと過ごしつつときたま歌う！ #shorts #Vtuber 【 最響ライブ 👹 】 | songs=1
- fh9VsBBCNrg | 🏮【 実写歌枠 】へい.ᐟそこのキミ.ᐟ深夜だけど一緒に楽しく過ごしちゃわない？♪ #shorts #Vtuber 【 #最響ライブ 👹 】 | songs=11
- ZVgKpALaw-s | 🏮【 実写歌枠 】深夜はあたしの時間！存分に楽しもう #shorts #Vtuber 【 響架 】 | songs=22
- R6bXul9XXz0 | 🏮【 収益化記念 / 歌枠 】ちょうどデビュー2ヶ月で収益化っ.ᐟ 本当にありがとう.ᐟ.ᐟ😭【 #最響ライブ 👹 】 | songs=4

## Dropped Or Suspicious

- Sil7GfO0t1Q | suspicious | 🌟【 新曲お披露目!!/年越し 】遂に新曲発表.ᐟ新しい一年を一緒に迎えてお祭り騒ぎだ.ᐟ【 #最響ライブ 👹 】 | live_without_explicit_singing_signal
- eJzE-bLlxZw | suspicious | 🎮【 Minecraft 】ステージ建築本格的にやっていく.ᐟかっちょいいステージにするんだ.ᐟ【 #最響ライブ 👹 】 | live_without_explicit_singing_signal
- F0hfJbGxsjs | suspicious | 📢【 #塩かずのこ家マリパ会 】運も筋肉も素直さも塩かずのこ家NO.1というところを証明します【 #最響ライブ 👹 】 | live_without_explicit_singing_signal

## Dirty Audit Rules

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious only when the title lacks explicit singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.

## Raw Evidence

- Raw discovery files were used to build this partial but are intentionally not part of the final local five-file artifact.
- Remote stage tail: 2026-07-22T21:49:57Z stage=discovery_start host=bedeMacBook-Air.local | 2026-07-22T21:49:57Z stage=heartbeat discovery elapsed=0s | 2026-07-22T21:50:57Z stage=heartbeat discovery elapsed=60s | 2026-07-22T21:51:57Z stage=heartbeat discovery elapsed=120s | 2026-07-22T21:52:57Z stage=heartbeat discovery elapsed=180s | 2026-07-22T21:53:57Z stage=heartbeat discovery elapsed=240s | 2026-07-22T21:54:57Z stage=heartbeat discovery elapsed=300s | 2026-07-22T21:55:57Z stage=heartbeat discovery elapsed=360s | 2026-07-22T21:56:57Z stage=heartbeat discovery elapsed=420s | 2026-07-22T21:57:57Z stage=heartbeat discovery elapsed=480s | 2026-07-22T21:58:57Z stage=heartbeat discovery elapsed=540s | 2026-07-22T21:59:57Z stage=discovery_done exit=0 | stdout_tail: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=245 inspected=15 videos=12 occurrences=134 elapsedSeconds=555 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch49-kyoka-shard14of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch49-kyoka-shard14of16-discovery" | 2026-07-22T22:00:18Z stage=export_start | stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=134 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch49-kyoka-shard14of16/final/candidate-increment-unfiltered.json" | 2026-07-22T22:00:18Z stage=export_done exit=0 | 2026-07-22T22:00:18Z stage=postprocess_start
- Discovery completion marker: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=245 inspected=15 videos=12 occurrences=134 elapsedSeconds=555 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch49-kyoka-shard14of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch49-kyoka-shard14of16-discovery"
- Export completion marker: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=12 usableVideos=12 acceptedVideos=12 skippedRegressions=0 occurrences=134 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch49-kyoka-shard14of16/final/candidate-increment-unfiltered.json"

## Remote Cleanup

- Preferred host: `Mac`; used host: `Mac`.
- Remote directory: `/Users/be/codex-temp/daily-song-list-source-backfill-batch49-kyoka-shard14of16/repo`.
- Cleanup: removed.

- Post-cleanup `df -h /Users`: /dev/disk3s5   926Gi   135Gi   752Gi    16%    561k  7.9G    0%   /System/Volumes/Data.

## Local Temp Cleanup

- Temp directory: `G:\codex-temp\daily-song-list-source-backfill-batch49-kyoka-shard14of16`.
- Cleanup: removed; cleanup command removed G: temp directory and `Test-Path` returned false.

## Storage Audit

- Windows D: contains only the final five small artifact files for this shard.
- Windows C: was not used for temp files.
