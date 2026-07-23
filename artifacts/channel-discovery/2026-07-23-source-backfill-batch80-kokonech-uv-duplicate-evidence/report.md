# Source Backfill Batch80 - KOKONEch_uv

- Status: skipped_duplicate
- Reason: duplicate_concrete_accepted_artifact_exists
- Source: https://www.youtube.com/@KOKONEch_uv/streams
- Branch confirmed read-only: codex/source-backfill-20260720-v2
- This worker did not run full-site discovery, did not start YouTube fetching, and did not write data/external.
- Mac not used / remote temp not created.

## Duplicate Evidence

- Accepted file: artifacts\channel-discovery\2026-07-22-source-backfill-batch8\accepted\2026-07-22-source-backfill-batch8.accepted.json
- Raw export: artifacts\channel-discovery\2026-07-22-source-backfill-batch8\accepted\2026-07-22-source-backfill-batch8.raw-export.json
- Manifest file: artifacts\channel-discovery\2026-07-22-source-backfill-batch8\manifest.json
- Report file: artifacts\channel-discovery\2026-07-22-source-backfill-batch8\report.md
- Dirty audit file: artifacts\channel-discovery\2026-07-22-source-backfill-batch8\dirty-audit.json
- Batch74 reviewed: artifacts\channel-discovery\2026-07-22-source-backfill-batch74-kokonech-uv-mac-readonly\manifest.json; status=interrupted; status-only interrupted, not accepted evidence.
- Evidence basis: concrete batch8 accepted JSON rows for channelHandle /@KOKONEch_uv and channelUrl https://www.youtube.com/@KOKONEch_uv/streams. Queue/pending files were not used.

## Counts

| Metric | Value |
| --- | ---: |
| candidate count | 30 |
| inspected count | 30 |
| accepted videos this batch | 0 |
| accepted occurrences this batch | 0 |
| accepted unique songs this batch | 0 |
| duplicate accepted videos | 9 |
| duplicate accepted occurrences | 72 |
| duplicate accepted unique songs | 66 |
| prior discovery usable videos | 11 |
| prior discovery occurrences | 130 |

## Coverage From Duplicate Accepted

- publishedTimestamp coverage: 9/9
- publishedTimestamp range: 2026-06-21T23:02:28.438Z to 2026-07-15T23:02:28.438Z
- occurrence time coverage: 72/72
- occurrence seconds coverage: 72/72
- thumbnail/cover coverage: 0/9
- discovery thumbnail coverage in batch8 manifest: 9/9
- reachedEnd: true
- duplicate discovery elapsed: 464s
- this duplicate-skip elapsed: 0s discovery time
- failure reason: none; skipped due to verified duplicate accepted artifact

## Dirty Audit Rules

- Hard exclude terms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is not a standalone hard exclude; it is only suspicious/drop when no singing signal exists.
- Prior batch8 dirty audit: dropped 0 videos / 0 occurrences; suspicious 0.

## Cleanup And Disk Scope

- Temporary script path: G:\codex-temp\batch80-kokonech-duplicate-artifact.js; removed after generation.
- Windows D/C/G: no large cache, checkout, runtime DB, or source export was created. Only these five small artifact files were written in this batch artifact directory.
- Mac not used.
- Remote temp not created.

## Git And Delivery

- Commit: not run, per worker instruction.
- Push: not run, per worker instruction.
- Deploy/restart/package: not applicable and not run.

VALIDATION_MARKER CODEX_BATCH80_KOKONECH_DUPLICATE_ARTIFACT_OK files=5 status=skipped_duplicate duplicateAccepted=9/72/66
