# Source backfill batch84 duplicate evidence: NUROJUNK_OFFICIAL

- Status: `skipped_duplicate`
- Source: https://www.youtube.com/@NUROJUNK_OFFICIAL
- Branch confirmed: `codex/source-backfill-20260720-v2`
- YouTube fetch: not started
- Mac: Mac not used
- Remote temp: remote temp not created

## Duplicate evidence

Batch8 contains concrete imported accepted evidence for this channel:

- Accepted file: `artifacts\channel-discovery\2026-07-22-source-backfill-batch8\accepted\2026-07-22-source-backfill-batch8.accepted.json`
- Raw export: `artifacts\channel-discovery\2026-07-22-source-backfill-batch8\accepted\2026-07-22-source-backfill-batch8.raw-export.json`
- Manifest: `artifacts\channel-discovery\2026-07-22-source-backfill-batch8\manifest.json`
- Dirty audit: `artifacts\channel-discovery\2026-07-22-source-backfill-batch8\dirty-audit.json`
- Report: `artifacts\channel-discovery\2026-07-22-source-backfill-batch8\report.md`
- Evidence basis: direct parsing of the batch8 accepted JSON matched 7 NUROJUNK_OFFICIAL accepted video rows and 61 accepted song occurrences; queue/pending files were not used.

## Stats

- Candidate count: 10 from batch8 discovery manifest
- Inspected count: 10 from batch8 discovery manifest
- Accepted videos in this batch: 0
- Accepted occurrences in this batch: 0
- Accepted unique songs in this batch: 0
- Duplicate accepted videos: 7
- Duplicate accepted occurrences: 61
- Duplicate accepted unique songs: 60
- Direct accepted rows matched: 7
- Direct accepted occurrences matched: 61
- Direct accepted unique songs matched: 60
- reachedEnd: true
- Batch84 elapsed seconds: 0
- Batch8 discovery elapsed seconds: 124
- Failure reason: none; skipped because duplicate accepted evidence is verified

## Coverage

- publishedTimestamp coverage: 7/7
- publishedTimestamp range: 2026-06-21T23:02:03.252Z to 2026-07-21T13:02:03.252Z
- occurrence time coverage: 61/61
- occurrence seconds coverage: 61/61
- Accepted field thumbnail/cover coverage: 0/7
- Discovery thumbnail coverage: 7/7
- Thumbnail note: accepted JSON matched rows do not carry thumbnail/cover fields, so accepted field coverage and discovery thumbnail coverage are reported separately.

## Dirty audit

Rules recorded for this batch:

- Hard exclude terms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- Exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is not a standalone hard exclude; mark suspicious/drop only when no singing signal exists

Batch8 dirty audit result:

- dropped videos: 0
- dropped occurrences: 0
- suspicious: 0

## Cleanup and delivery boundary

- Temporary directory availability checked: `G:\codex-temp`
- Temporary script cleanup: completed; `generate-batch84-artifact.ps1` was removed after generating the five required files.
- Windows large file note: no large C/D/G cache, checkout, runtime DB, or source export was created.
- Commit: not created by request
- Push/deploy: not run by request
