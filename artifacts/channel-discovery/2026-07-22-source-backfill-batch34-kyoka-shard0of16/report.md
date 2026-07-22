# 2026-07-22-source-backfill-batch34-kyoka-shard0of16

Artifact-local partial for `https://www.youtube.com/@Kyoka_0609`, inspect shard `0/16`.

## Summary

| Status | Candidates | Inspected | Details | Candidate videos | Candidate occurrences | Accepted videos | Accepted occurrences | Dropped | Suspicious |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| complete | 239 | 15 | 11 | 11 | 185 | 10 | 182 | 1 | 0 |

## Coverage

- Published timestamp: 10/10
- Video thumbnail: 10/10
- Occurrence time: 182/182
- Occurrence seconds: 182/182
- Occurrence thumbnail via accepted video: 182/182

## Dirty Audit

- Hard exclude terms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase excludes: piano streaming, piano performance, ピアノ演奏
- Dropped videos: 1
- Suspicious accepted videos: 0

### Dropped

- GUQ6CgPqhsU 🎮【ドラゴンボールZ:KAKAROT】完全初見🌟悟飯最推し、ベジットと共にここでスベテに決着をつける！！！【 #最響ライブ 👹 】 (live_without_clear_song_signal:ライブ)

## Accepted Videos

- 8qooRmisSIk 🏮 実写 #歌枠 ｜今日を楽しく終えるため、明日も楽しく過ごせるために歌う！ #shorts #Vtuber ∞ 響架 (20 songs)
- kDLj_ZRg26c 🏮【 実写歌枠 】金曜深夜ですね？一緒に過ごしてくれますか？ #shorts #Vtuber 【 響架 】 (30 songs)
- GfkZDdCMBd4 🏮【#歌枠/#KARAOKE】ド深夜はお歌の時間♪明日は待望の歌枠リレーなので声出しする♡【 響架 】 (31 songs)
- C4i4ZrBDNQ8 🏮【 実写歌枠 】あたしの歌、よかったら聞いてって!!💗 #shorts #Vtuber 【 響架 】 (13 songs)
- SzW541QBOwE 🏮【 実写歌枠 】せっかくの夜だし、一緒に楽しい時間過ごしちゃおっか。 #shorts #Vtuber 【 響架 】 (19 songs)
- ptMegCVxePM 🎮【 MINECRAFT/歌枠 】作ったステージに観客連れてくる💜やぱフェスって観客いないと始まらないよね.ᐟ【 #最響ライブ 👹】 (13 songs)
- aisR0XADOUI 🏮【 実写歌枠 】GW最終日.ᐟ最後の一瞬まで一緒に過ごそ🎵 #shorts #Vtuber 【 響架 】 (15 songs)
- Nla25yneFLE 🏮【 実写歌枠 】歌っていく〜.ᐟ深夜のお歌を一緒にたのしも🎵 #shorts #Vtuber 【 #最響ライブ 👹 】 (17 songs)
- 1vdQDuNzvxE 🏮【 実写歌枠 】日曜深夜はお歌の時間.ᐟアガる歌うたっていくぜっ #shorts #Vtuber 【 #最響ライブ 👹 】 (16 songs)
- ZRUv2N2rHdM 🏮【 縦型歌枠 】懐メロ中心に楽しく歌う～～‪.ᐟふんふん♪ #shorts #Vtuber 【 #最響ライブ 👹】 (8 songs)

## Files

- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `dirty-audit.json`
- `manifest.json`
- `report.md`

## Remote Execution

- Preferred host: `vps5`.
- Used host: `vps-jp` (`VM-c8189ce8-42c5-4763-bfb1-d000d087dbb5`).
- Fallback reason: vps5 was not resolvable from local SSH config; culua and rainy-cloud hosts were not used.
- Remote directory: `/opt/ytb-song-rank-source-backfill-20260722-batch34-kyoka-shard0of16-vps-jp-retry3`.
- Setup used remote sparse clone; no local tarball was uploaded.
- Command: `timeout 3600s npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@Kyoka_0609 --singer-name Kyoka_0609 --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --inspect-shard-count 16 --inspect-shard-index 0 --request-interval-ms 3500 --request-jitter-ms 1500`.
- Exit code: 0; stale stopped: false.
- Finished at: 2026-07-22T15:52:01Z.
- Cleanup: removed.
- Post-cleanup df -h /: `/dev/sda1 99G 27G 73G 27% /`.
