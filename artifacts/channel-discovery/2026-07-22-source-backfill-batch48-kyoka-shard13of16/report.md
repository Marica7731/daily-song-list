# Kyoka_0609 shard 13/16 source-backfill partial

- Status: success
- Channel: https://www.youtube.com/@Kyoka_0609
- Shard: 13/16
- Generated at: 2026-07-22T21:38:13.564Z
- Discovery candidates: 245
- Inspected latest run: 15
- Discovery usable videos / occurrences: 11 / 157
- Unfiltered increment videos / occurrences: 11 / 157
- Accepted videos / occurrences / songs: 10 / 156 / 156
- Imported / skipped / failed: 10 / 1 / 0
- Reached end: true
- Coverage published/time/seconds/thumbnail: 10/10, 156/156, 156/156, 0/10
- Discovery detail thumbnail coverage: 10/10
- Dirty dropped / suspicious: 0 / 1

## Accepted Videos

- 7DjYId2eVxs | 🎮｜ #スト6 #歌枠｜大会前日の夜。歌いながら、インパクト返し対空コンボ練対戦起き攻めします #魔竜祭 ∞ 響架 | songs=18
- htI443d-Fwc | 【 #StarLink歌枠リレー 振り返り&延長戦 】人生ってのは何が起こるか本当にわかりませんね!!【 響架 】 | songs=10
- pXEuxLLbXeM | 🏮【 #塩かずのこ家歌枠リレー 】声出す準備はOK？最高潮の楽しさを届けちゃうんだから!!【響架】 | songs=6
- 72lNgVuqXLE | 🏮【 3万人耐久/実写歌枠 】400人の方に出会う!!あたしの頑張り見てってほしいｶﾓ #shorts #Vtuber 【 響架 】 | songs=1
- L0qIntPI2rs | 🏮【 夏休み/実写歌枠 】T.M.Revolution歌枠🎶日曜お昼ですがキミたちどう過ごしてますか？ #shorts #Vtuber 【 響架 】 | songs=23
- 1W4MfEJiXwU | ⚡💜【 歌枠雑談コラボ 】突然の謎コラボ！？とりあえず二人の歌声響かせとくか🤟【 羽汐なゆた / 響架 】 | songs=10
- H4CabMsrjRk | 🏮【 コラボ歌枠 】圧倒的なVo.力でキミたちの心をアツくしちゃう!!【 木乃芽もん太/響架 】 | songs=16
- edH8z1I2TpI | 🏮【 実写歌枠 】デビュー半年記念前夜祭.ᐟ歌おう♪ #shorts #Vtuber 【 #最響ライブ 👹 】 | songs=18
- dZUo4gYRW04 | 🏮【 実写歌枠 】深夜ですが歌いたい気分です。未来の推しより。 #shorts #Vtuber 【 響架 】 | songs=44
- aZwqlJwTlF4 | 🏮【 実写雑談歌枠 】今日はブレスが多い日なのでまったり歌おう♡#shorts #Vtuber 【 #最響ライブ 👹 】 | songs=10

## Dropped Or Suspicious

- A6Qz3CqpVTA | suspicious | 🎮【 BE忍者 】過去のあたし!!聞こえるか!!忍術使いたいって練習してたよな。その努力、報われるってよ!!!【 #最響ライブ 】 | live_without_explicit_singing_signal

## Dirty Audit Rules

- Hard exclude: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is suspicious only when the title lacks explicit singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.

## Raw Evidence

- Raw discovery files were used to build this partial but are intentionally not part of the final local five-file artifact.
- Remote stage tail: stderr_tail:     at Module.load (node:internal/modules/cjs/loader:1266:32) | stderr_tail:     at Module._load (node:internal/modules/cjs/loader:1091:12) | stderr_tail:     at Module.require (node:internal/modules/cjs/loader:1289:19) | 2026-07-22T21:25:13Z stage=resume_start host=bedeMacBook-Air.local | 2026-07-22T21:25:13Z stage=df_resume /dev/disk3s5   926Gi   146Gi   742Gi    17%    583k  7.8G    0%   /System/Volumes/Data | 2026-07-22T21:25:13Z stage=discovery_start | 2026-07-22T21:25:13Z stage=heartbeat discovery elapsed=0s | 2026-07-22T21:26:13Z stage=heartbeat discovery elapsed=60s | 2026-07-22T21:27:13Z stage=heartbeat discovery elapsed=120s | 2026-07-22T21:28:13Z stage=heartbeat discovery elapsed=180s | 2026-07-22T21:29:13Z stage=heartbeat discovery elapsed=240s | 2026-07-22T21:30:13Z stage=heartbeat discovery elapsed=300s | 2026-07-22T21:31:13Z stage=heartbeat discovery elapsed=360s | 2026-07-22T21:32:13Z stage=heartbeat discovery elapsed=420s | 2026-07-22T21:33:13Z stage=heartbeat discovery elapsed=480s | 2026-07-22T21:34:13Z stage=heartbeat discovery elapsed=540s | 2026-07-22T21:35:13Z stage=heartbeat discovery elapsed=600s | 2026-07-22T21:36:13Z stage=heartbeat discovery elapsed=660s | 2026-07-22T21:37:13Z stage=discovery_done exit=0 | stdout_tail:  | stdout_tail: > daily-song-list@1.0.0 youtube:discover-channel | stdout_tail: > node scripts/youtube-channel-discovery.js --channel-url https://www.youtube.com/@Kyoka_0609 --singer-name Kyoka_0609 --output-dir /Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch48-kyoka-shard13of16-discovery --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --inspect-shard-count 16 --inspect-shard-index 13 --request-interval-ms 3500 --request-jitter-ms 1500 --keyword フルート --keyword 生演奏 --keyword クラリネット --keyword サックス --keyword サクソフォン --keyword sax --keyword saxophone --keyword piano streaming --keyword piano performance --keyword ピアノ演奏 --keyword live --keyword ライブ --keyword 歌 --keyword 歌枠 --keyword 弾き語り --keyword karaoke --keyword 歌ってみた --keyword 3D Live | stdout_tail:  | stdout_tail: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=245 inspected=15 videos=11 occurrences=157 elapsedSeconds=664 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch48-kyoka-shard13of16-discovery" | 2026-07-22T21:37:13Z stage=export_start | 2026-07-22T21:37:13Z stage=heartbeat export elapsed=0s | 2026-07-22T21:38:13Z stage=export_done exit=0 | stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=157 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/final/candidate-increment-unfiltered.json" | 2026-07-22T21:38:13Z stage=postprocess_start | 2026-07-22T21:38:13Z stage=heartbeat postprocess elapsed=0s
- Discovery completion marker: stdout_tail: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Kyoka_0609" candidates=245 inspected=15 videos=11 occurrences=157 elapsedSeconds=664 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/repo/artifacts/channel-discovery/2026-07-22-source-backfill-batch48-kyoka-shard13of16-discovery"
- Export completion marker: stdout_tail: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=157 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/final/candidate-increment-unfiltered.json"

## Remote Cleanup

- Preferred host: `Mac`; used host: `Mac`.
- Remote directory: `/Users/be/codex-temp/daily-song-list-source-backfill-batch48-kyoka-shard13of16/repo`.
- Cleanup: removed.

- Post-cleanup `df -h /Users`: /dev/disk3s5   926Gi   134Gi   753Gi    16%    561k  7.9G    0%   /System/Volumes/Data.

## Local Temp Cleanup

- Temp directory: `G:\codex-temp\daily-song-list-source-backfill-batch48-kyoka-shard13of16`.
- Cleanup: removed; cleanup command removed G: temp directory and `Test-Path` returned false.

## Storage Audit

- Windows D: contains only the final five small artifact files for this shard.
- Windows C: was not used for temp files.
