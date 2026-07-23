# Batch90 AmakusaAroma duplicate evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

This small duplicate-evidence batch intentionally does not repeat accepted rows. `AmakusaAroma` is already fully included in the batch2 concrete accepted artifact.

## Source evidence

Only the existing batch2 artifact files were used:

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/accepted/2026-07-22-source-backfill-batch2.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/dirty-audit.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch2/audit-summary.json`

No YouTube refetch was run for this batch.

## Duplicate evidence

- Source: `https://www.youtube.com/@AmakusaAroma`
- Duplicate of batch: `2026-07-22-source-backfill-batch2`
- Accepted increment for this batch: empty, 0 videos / 0 occurrences.
- Batch2 direct evidence: 2 videos / 14 occurrences / 14 unique songs.
- Published timestamp coverage: 2/2.
- Occurrence time coverage: 14/14.
- Occurrence seconds coverage: 14/14.
- Discovery thumbnail coverage: 2/2.

## Batch2 manifest source entry

- discoveryCandidateCount: 3
- discoveryInspectedCount: 3
- discoveryUsableVideoCount: 2
- discoveryOccurrenceCount: 14
- elapsedSeconds: 86
- reachedEnd: null

## Dirty audit

- Filter: `channelHandle == /@AmakusaAroma or channelUrl == https://www.youtube.com/@AmakusaAroma`
- Dropped: 0/0
- Suspicious: 0/0

Batch2 dirty-audit has no dropped or suspicious entries for `AmakusaAroma`. The batch2 candidate 3 to usable 2 difference is not treated as dirty dropped evidence.

## Batch2 remote cleanup evidence

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

This batch did not use Mac/VPS and did not create any remote temporary directory.

## Scope

- Did not modify runner tool code.
- Did not write or overwrite `data/external`.
- Did not start YouTube fetching.
- Did not use C drive or D drive large temporary cache.
- Did not push, deploy, restart, package, install, or rebuild a production DB.
- Did not commit; the main session can audit and commit later.
