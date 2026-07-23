# Source backfill 2026-07-23 batch92 ShirazunaIwo duplicate evidence

This is a small duplicate-evidence artifact only. It does not refresh YouTube, does not use Mac or VPS runners, does not create remote temp directories, does not modify runner tool code, and does not write to `data/external`.

## Duplicate decision

- Source: `https://www.youtube.com/@ShirazunaIwo`
- Status: `skipped_duplicate`
- Reason: `duplicate_concrete_accepted_artifact_exists`
- Duplicate of batch: `2026-07-22-source-backfill-batch1`
- Direct concrete accepted evidence: `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/accepted/2026-07-22-source-backfill-batch1.accepted.json`
- Supporting batch1 files: `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/manifest.json`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/report.md`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/dirty-audit.json`

ShirazunaIwo was already fully collected in the batch1 concrete accepted artifact, so this batch does not duplicate accepted rows.

## Accepted increment

`accepted-increment.json` is intentionally empty: 0 videos and 0 occurrences. The batch1 direct evidence for ShirazunaIwo is recorded here for audit only:

| Metric | Value |
| --- | ---: |
| Accepted videos | 45 |
| Accepted occurrences | 772 |
| Unique songs | 456 |
| publishedTimestamp coverage | 45/45 |
| Occurrence time coverage | 772/772 |
| Occurrence seconds coverage | 772/772 |
| Discovery thumbnail coverage | 47/47 |
| Cover coverage | 47/47 |

Batch1 manifest source fields:

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 54 |
| discoveryInspectedCount | 54 |
| discoveryUsableVideoCount | 47 |
| discoveryOccurrenceCount | 787 |
| elapsedSeconds | 1151 |
| reachedEnd | true |

## Dirty audit

The dirty audit in this artifact is filtered only to ShirazunaIwo. Batch1 dirty-audit dropped:

- Dropped videos: 1
- Dropped occurrences: 1
- Video: `Jm0UJ5tn4AQ`
- Reason: non-song/member-only concert talk
- Suspicious videos: 0
- Suspicious occurrences: 0

The source dirty-audit has no suspicious fields, so this artifact records suspicious as 0/0. The batch1 candidate 54 to usable 47 difference is discovery usability filtering, not dirty-audit dropped evidence.

## Remote cleanup reference

This batch did not use Mac/VPS and did not create remote temp directories. It only cites batch1 cleanup evidence already recorded in `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/report.md`:

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch1b-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch1b-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Scope verification

- No YouTube crawl was started.
- No Mac or VPS runner was used by this batch.
- No remote temp directory was produced by this batch.
- No runner tool code was modified.
- No `data/external` files were written.
- No push, deploy, service restart, or production DB rebuild was done.
- No commit was created; the main session should audit and commit if needed.
