# 2026-07-23 source backfill batch87 inori_hw8 duplicate evidence

Status: `skipped_duplicate`.

Reason: `duplicate_concrete_accepted_artifact_exists`.

Source: `https://www.youtube.com/@inori_hw8` (`/@inori_hw8`).

## Duplicate Evidence

- Duplicate accepted artifact: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/accepted/2026-07-22-source-backfill-batch6.accepted.json`.
- Existing accepted videos / occurrences / unique songs: 26 / 313 / 184 by direct accepted JSON normalized title+artist count.
- Unique song key: normalized title+artist. Batch6 manifest/report recorded 185, so this artifact records the one-song discrepancy instead of hiding it.
- Published timestamp coverage: 26/26.
- Occurrence time coverage: 313/313.
- Occurrence seconds coverage: 313/313.
- Accepted thumbnail/cover field coverage: 0/26; acceptedFileHasThumbnailOrCoverFields=false.
- Discovery thumbnail coverage from batch6 manifest/report: 26/26.

## Batch6 Source Entry

- candidateCount=30.
- inspectedCount=30.
- usableVideoCount=26.
- discoveryOccurrenceCount=313.
- reachedEnd=true.
- elapsedSeconds=365.

## Dirty Audit

- Literal dirty dropped for /@inori_hw8: 0 videos / 0 occurrences.
- Suspicious for /@inori_hw8: 6 videos / 80 occurrences.
- Hits: live_ja=6.

| Video | Occurrences | Hits | Short title |
| --- | ---: | --- | --- |
| `vg8jrhEbBJ0` | 20 | `live_ja` | 〖 #歌枠 ✧ #カラオケ 〗ライブに向けてアチチになるぞ～❕🔥〖 幸世いのり 〗 |
| `-Dc1dErJARc` | 12 | `live_ja` | 〖 #歌枠 ✧ #カラオケ 〗明日は大阪でライブ‼一緒に盛り上がってくれますか❔🔥〖 幸世いのり 〗 |
| `csH8tscp_CQ` | 18 | `live_ja` | 〖 #歌枠 ✧ #カラオケ 〗明日のライブに向けて‼〖 幸世いのり 〗 |
| `rTjTZ2IRPlQ` | 16 | `live_ja` | 〖 #歌枠 ✧ #カラオケ 〗週末はライブ‼一緒に楽しみましょう🌸〖 幸世いのり 〗 |
| `CMr4SI1fjT8` | 13 | `live_ja` | 〖 #歌枠 ✧ #カラオケ 〗ライブ前日！！明日に向けて盛り上がりましょう🎶〖幸世いのり 〗 |
| `KfGIOe_on2s` | 1 | `live_ja` | 〖 #振り返り ✧ #雑談 〗楽しかったライブの振り返りをさせてください✨〖 幸世いのり 〗 |

## Remote Cleanup Evidence From Batch6

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Batch87 Controls

- Used existing batch6 artifact files only.
- Did not use Mac or VPS.
- Did not create a remote temporary directory.
- Temporary script `G:\codex-temp\generate_batch87_inori_duplicate_evidence.ps1` was deleted after generation.
- Did not start YouTube fetching.
- Did not modify `data/external`.
- Did not push or deploy.
- Candidate and accepted increment files intentionally emit no candidate/video rows; they only carry duplicateEvidence.
