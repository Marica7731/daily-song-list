# Source backfill 2026-07-23 batch91 MonicaMelodia duplicate evidence

This is a small duplicate-evidence artifact only. It does not refresh YouTube, does not use Mac or VPS runners, does not create remote temp directories, does not modify runner tool code, and does not write to `data/external`.

## Duplicate decision

- Source: `https://www.youtube.com/@MonicaMelodia`
- Status: `skipped_duplicate`
- Reason: `duplicate_concrete_accepted_artifact_exists`
- Duplicate of batch: `2026-07-22-source-backfill-batch1`
- Direct concrete accepted evidence: `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/accepted/2026-07-22-source-backfill-batch1.accepted.json`
- Supporting batch1 files: `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/manifest.json`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch1/report.md`
- Later status continuation only: `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/manifest.json`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/report.md`

Batch2 accepted evidence is not used for this duplicate decision. The concrete accepted artifact for MonicaMelodia is batch1.

## Accepted increment

`accepted-increment.json` is intentionally empty: 0 videos and 0 occurrences. MonicaMelodia was already fully collected in batch1, so this batch does not duplicate accepted rows.

Batch1 direct evidence for MonicaMelodia:

| Metric | Value |
| --- | ---: |
| Accepted videos | 4 |
| Accepted occurrences | 36 |
| Unique songs | 35 |
| publishedTimestamp coverage | 4/4 |
| Occurrence time coverage | 36/36 |
| Occurrence seconds coverage | 36/36 |
| Discovery thumbnail coverage | 4/4 |
| Cover coverage | 4/4 |

Batch1 manifest source fields:

| Field | Value |
| --- | ---: |
| discoveryCandidateCount | 6 |
| discoveryInspectedCount | 6 |
| discoveryUsableVideoCount | 4 |
| discoveryOccurrenceCount | 36 |
| elapsedSeconds | 212 |
| reachedEnd | true |

## Dirty audit

The dirty audit in this artifact is filtered only to MonicaMelodia. Batch1 dirty-audit dropped entries belong only to ShirazunaIwo, so MonicaMelodia has:

- Dropped videos: 0
- Dropped occurrences: 0
- Suspicious videos: 0
- Suspicious occurrences: 0

The batch1 candidate 6 to usable 4 difference is discovery usability filtering, not dirty-audit dropped evidence.

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
