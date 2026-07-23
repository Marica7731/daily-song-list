# Batch94 rayray_429 duplicate evidence

Status: skipped_duplicate

Reason: duplicate_concrete_accepted_artifact_exists

This small duplicate-evidence batch intentionally writes no repeated accepted rows. `rayray_429` is already fully recorded in the batch5 concrete accepted artifact.

## Source evidence

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch5/accepted/2026-07-22-source-backfill-batch5.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch5/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch5/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch5/dirty-audit.json`

duplicateOfBatch: `2026-07-22-source-backfill-batch5`

## Duplicate evidence

- Source: `https://www.youtube.com/@rayray_429`
- Accepted videos in batch5 direct evidence: 9
- Accepted occurrences in batch5 direct evidence: 155
- Unique songs in batch5 direct evidence: 154
- Accepted increment emitted by this batch: 0 videos / 0 occurrences

## Coverage

- Published timestamp coverage: 9/9
- Occurrence time coverage: 155/155
- Occurrence seconds coverage: 155/155
- Discovery thumbnail coverage: 9/9
- Cover coverage: 9/9

## Batch5 manifest source entry

- discoveryCandidateCount: 31
- discoveryInspectedCount: 31
- discoveryUsableVideoCount: 9
- discoveryOccurrenceCount: 155
- elapsedSeconds: 373
- reachedEnd: true

The 31 candidates to 9 usable videos discovery difference is not dirty dropped.

## Dirty audit

- Filter: only `rayray_429`
- Batch5 dirty audit dropped: 0 videos / 0 occurrences
- Batch5 suspicious: 0 videos / 0 occurrences
- No dirty dropped rows were inferred from candidate-to-usable difference.

## Batch5 remote cleanup evidence

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch5-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch5-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Scope

- This batch did not rerun or start YouTube fetching.
- This batch did not use Mac/VPS.
- This batch did not create any remote temporary directory.
- This batch did not use C: or D: large temporary caches.
- This batch did not push, deploy, restart, package, install, or rebuild a production DB.
- This batch did not write `data/external`.
- This batch did not change runner tool code.
