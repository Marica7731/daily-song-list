# Batch89 UzakiLarme duplicate evidence

- Status: `skipped_duplicate`
- Reason: `duplicate_concrete_accepted_artifact_exists`
- Source: `https://www.youtube.com/@UzakiLarme/streams`
- Duplicate accepted artifact: `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/accepted/2026-07-22-source-backfill-batch2.accepted.json`

## Accepted evidence from batch2

- Matched accepted videos by channelHandle `/@UzakiLarme` or channelUrl `https://www.youtube.com/@UzakiLarme/streams`: 23
- Accepted occurrences: 238
- Unique songs: 212, computed by normalized title + artist key.
- Batch2 manifest/report unique songs: 213.
- Unique-song comparison note: computed normalized title+artist unique songs differs from batch2 manifest/report 213 by -1.
- Published timestamp coverage: 23/23
- Occurrence time coverage: 238/238
- Occurrence seconds coverage: 238/238
- Accepted file has thumbnail/cover top-level fields: false
- Accepted thumbnail/cover coverage from accepted file: 0/23
- Batch2 discovery thumbnail coverage: 25/25

## Batch2 source manifest entry

- candidateCount: 69
- inspectedCount: 69
- usableVideoCount: 25
- discoveryOccurrenceCount: 240
- elapsedSeconds: 1172
- reachedEnd: null / unknown, because batch2 manifest stores JSON null for this source.

## Dirty audit evidence

Dirty dropped is filtered directly from batch2 `dirty-audit.json` by channelHandle; it is not inferred from candidate-to-usable counts.

| Type | Video ID | Short title | Occurrences | Hits | Note |
| --- | --- | --- | ---: | --- | --- |
| dropped | `PmLtmUhaaRI` | 【まったり作業配信】Live2D！顔面整形する！ | 1 | live_en | only parsed occurrence is an unrelated Santo Rosário / Live Ao vivo description row, not a song timestamp |
| dropped | `dR4X1YyethI` | 【耐久歌枠】チャンネル登録者600人目指して歌います！！リターンズ【卯咲らるむ / #新人Vtu... | 1 | live_en | only parsed occurrence is an unrelated Santo Rosário / Live Ao vivo description row, not a song timestamp |
| suspicious | `N_OB0DZ7XT0` | 【誕生日】新衣装お披露目！Live2Dアップデート！オリ曲披露も？！ | 1 | live_en | manually audited broad live/live term hit retained in batch2 accepted evidence |
| suspicious | `UGwI0nAxxnE` | 【 #歌枠 】1周年記念ライブ！！ | 26 | live_ja | manually audited broad live/live term hit retained in batch2 accepted evidence |
| suspicious | `GuwgMywMoLU` | 【 #歌枠 】ホロライブしばり歌枠♪【卯咲らるむ / #新人Vtuber 】 | 20 | live_en, live_ja | manually audited broad live/live term hit retained in batch2 accepted evidence |

Summary:

- Dirty dropped: 2 videos / 2 occurrences.
- Suspicious: 3 videos.
- Batch2 report states the two dropped UzakiLarme rows were unrelated `Santo Rosário / Live Ao vivo` description text.

## Operational boundaries

- Batch2 VPS cleanup evidence quoted from report:
  - - VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
  - - VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.
- This batch did not use Mac or VPS.
- This batch did not create any remote temporary directory.
- This batch did not start YouTube fetching.
- This batch did not modify `data/external`.
- This batch did not commit, push, deploy, publish, restart services, or rebuild production data.
- Temporary scripts were created under `G:\codex-temp` and deleted after successful generation and verification.
