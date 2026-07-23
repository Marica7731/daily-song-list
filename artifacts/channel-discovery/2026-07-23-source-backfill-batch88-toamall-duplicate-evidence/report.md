# Batch88 toamall duplicate evidence

Status: skipped_duplicate

Reason: duplicate_concrete_accepted_artifact_exists

This small batch intentionally outputs no repeated videos or candidates. It records duplicate evidence that https://www.youtube.com/@toamall was already included by the batch2 concrete accepted increment.

## Source evidence

- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/accepted/2026-07-22-source-backfill-batch2.accepted.json
- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/accepted/2026-07-22-source-backfill-batch2.raw-export.json
- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/manifest.json
- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/report.md
- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/dirty-audit.json
- rtifacts/channel-discovery/2026-07-22-source-backfill-batch2/audit-summary.json

Only batch2 evidence is used. The invalid earlier batch88 based on batch6 is not referenced as accepted evidence.

## Duplicate evidence

- Source: https://www.youtube.com/@toamall
- Accepted match rule: channelHandle == /@toamall or channelUrl == https://www.youtube.com/@toamall
- Accepted videos: 9
- Accepted occurrences: 104
- Unique songs: 90
- Unique song key: normalized title + normalized artist
- Unique song note: Computed normalized title+artist unique song count matches batch2 manifest/report.

## Coverage

- Published timestamp coverage: 9/9
- Occurrence time coverage: 104/104
- Occurrence seconds coverage: 104/104
- Accepted thumbnail/cover top-level fields coverage: 0/9
- cceptedFileHasThumbnailOrCoverFields: false
- Batch2 discovery thumbnail coverage: 9/9

## Batch2 manifest source entry

- candidateCount: 44
- inspectedCount: 44
- usableVideoCount: 9
- discoveryOccurrenceCount: 104
- elapsedSeconds: 1401
- reachedEnd: null / unknown

## Dirty audit

- Dirty dropped: 0/0
- Suspicious: 0/0
- Note: Filtered by channelHandle/channelUrl; source dirty-audit has no toamall dropped or suspicious entries. Dirty counts are not inferred from candidate-to-usable difference.

No dirty dropped rows were inferred from the candidate-to-usable difference.

## Batch2 VPS cleanup evidence

- VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps3`: removed; `df -h /` => `/dev/sda1 99G 11G 89G 11% /`.
- VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch2-vps5`: removed; `df -h /` => `/dev/vda1 10G 2.6G 7.0G 27% /`.

## Scope

- This batch did not use Mac/VPS.
- This batch did not create any remote temporary directory.
- This batch did not start YouTube fetching.
- This batch did not modify data/external.
- This batch did not push, deploy, restart, package, or install anything.
- Temporary script path: $scriptPath
- Temporary script deleted and verified before manifest/report write: true
