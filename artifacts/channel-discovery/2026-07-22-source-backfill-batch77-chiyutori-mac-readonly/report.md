# 2026-07-22 source backfill batch77 Chiyutori

Status: skipped_duplicate

This worker did not run a new Chiyutori crawl because a more complete concrete accepted artifact already exists in batch7. Queue manifest mentions in batch1-8 were not used as skip evidence.

## Stats

| Metric | Batch77 increment | Existing batch7 evidence |
| --- | ---: | ---: |
| imported / skipped / failed | 0 / 1 / 0 | 1 imported channel |
| candidateCount | 0 | 29 |
| inspectedCount | 0 | 29 |
| usableVideoCount | 0 | 28 |
| accepted videos / occurrences / songs | 0 / 0 / 0 | 27 / 909 / 459 |
| uniqueSongs | 0 | 459 |
| publishedTimestamp coverage | 0/0 | 27/27 |
| occurrence time / seconds coverage | 0/0 / 0/0 | 909/909 / 909/909 |
| accepted thumbnailUrl coverage | 0/0 | 0/27 |
| discovery thumbnail coverage | 0/0 | 27/27 |
| reachedEnd | n/a | true |
| elapsed | 0s | 439s |
| failureReason | empty | empty |

## Duplicate Evidence

- Existing artifact: `artifacts/channel-discovery/2026-07-22-source-backfill-batch7`
- Existing accepted increment: `artifacts/channel-discovery/2026-07-22-source-backfill-batch7/accepted/2026-07-22-source-backfill-batch7.accepted.json`
- Existing source type: youtube_channel_discovery accepted increment
- Existing channel: https://www.youtube.com/@Chiyutori (/@Chiyutori)
- Existing report status: Chiyutori imported, reachedEnd=true, accepted export skipped regression `XMTT-zzGBqw`.

## Dirty Audit Policy

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live/ライブ policy: suspicious/drop only when singing signals are absent; singing signals are 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- Batch77 dropped 0 videos / 0 occurrences because no new crawl was run.
- Batch7 duplicate dirty audit evidence: dropped 0 videos / 0 occurrences; suspicious 3.

## Cleanup

- Mac temp dir: `/Users/be/codex-temp/daily-song-list-source-backfill-batch77-chiyutori-mac-readonly` removed; marker `CODEX_BATCH77_MAC_CLEANUP_OK`.
- Mac df: /dev/disk3s5 926Gi 270Gi 618Gi 31% /System/Volumes/Data
- Windows disk probe: C free 65395339264 bytes; D free 9901203456 bytes; G free 686037479424 bytes.
- G temp cleanup: removed after artifact generation; verified by G:\codex-temp probe.

## Validation

- JSON/five-file marker: `CODEX_BATCH77_ARTIFACT_VALIDATE_OK files=5 json=4 status=skipped_duplicate`
- Mac temp marker: `CODEX_BATCH77_MAC_TEMP_ABSENT`
- Mac df after cleanup: `/dev/disk3s5 926Gi 270Gi 618Gi 31% /System/Volumes/Data`

## Stage Log

- 2026-07-23T14:29:00+08:00 worker-started marker written.
- Duplicate scan found batch7 concrete accepted export for Chiyutori.
- Batch7 accepted/export/dirty/report/discovery manifest verified.
- Remote crawl skipped; no Mac repo changes, no Windows data/external changes.
- Mac temp cleanup marker recorded.
- Five required files parsed successfully and G temp scripts were removed.
