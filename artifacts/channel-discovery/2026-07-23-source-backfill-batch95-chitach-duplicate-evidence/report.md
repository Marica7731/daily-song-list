# Batch95 ChitaCh duplicate evidence

Status: skipped_duplicate

Reason: duplicate_concrete_accepted_artifact_exists

This small duplicate-evidence batch intentionally writes no repeated accepted rows. `ChitaCh` is already fully recorded in the batch3 concrete accepted artifact.

## Source evidence

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/accepted/2026-07-22-source-backfill-batch3.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch3/dirty-audit.json`

duplicateOfBatch: `2026-07-22-source-backfill-batch3`

## Duplicate evidence

- Source: `https://www.youtube.com/@ChitaCh.%E5%A0%95%E5%A4%A9%E3%81%A1%E3%81%9F`
- Accepted videos in batch3 direct evidence: 16
- Accepted occurrences in batch3 direct evidence: 181
- Unique songs in batch3 direct evidence: 156
- Accepted increment emitted by this batch: 0 videos / 0 occurrences

## Coverage

- Published timestamp coverage: 16/16
- Occurrence time coverage: 181/181
- Occurrence seconds coverage: 181/181
- Discovery thumbnail coverage: 16/16
- Cover coverage: 16/16

## Batch3 manifest source entry

- discoveryCandidateCount: 24
- discoveryInspectedCount: 24
- discoveryUsableVideoCount: 16
- discoveryOccurrenceCount: 181
- elapsedSeconds: 437
- reachedEnd: null

The 24 candidates to 16 usable videos discovery difference is not dirty dropped.

## Dirty audit

- Filter: only `ChitaCh`
- Batch3 dirty audit dropped: 0 videos / 0 occurrences
- Batch3 total suspicious: 11 broad live hits retained after manual audit across the whole batch
- ChitaCh suspicious within those retained hits: 1 video / 1 occurrence (`jyd9_Y0jUpM`)
- Suspicious hits are not dirty dropped.
- No dirty dropped rows were inferred from candidate-to-usable difference.

## Batch3 remote cleanup evidence

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch3-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch3-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Scope

- This batch did not rerun or start YouTube fetching.
- This batch did not use Mac/VPS.
- This batch did not create any remote temporary directory.
- This batch did not use C: or D: large temporary caches.
- This batch did not push, deploy, restart, package, install, or rebuild a production DB.
- This batch did not write `data/external`.
- This batch did not change runner tool code.
