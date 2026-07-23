# Batch81 KAMIKUMONONOA Duplicate Evidence

- Status: skipped_duplicate
- Source: https://www.youtube.com/@KAMIKUMONONOA
- Candidate count: 36
- Inspected count: 36
- Accepted videos: 14
- Accepted occurrences: 176
- Unique songs: 172
- publishedTimestamp coverage: 14/14
- occurrence time coverage: 176/176
- occurrence seconds coverage: 176/176
- thumbnail/cover coverage: 14/14
- reachedEnd: True
- Elapsed seconds: 0.23
- Failure reason: none

## Evidence

Duplicate evidence is based only on imported accepted output from:

'artifacts/channel-discovery/2026-07-22-source-backfill-batch9/accepted/2026-07-22-source-backfill-batch9.accepted.json'

Batch9 manifest channel summary for @KAMIKUMONONOA reports 36 candidates, 36 inspected, 14 accepted videos, 176 accepted occurrences, 172 unique songs, 14/14 publishedTimestamp coverage, 176/176 occurrence time coverage, 176/176 occurrence seconds coverage, and 14/14 discovery thumbnail coverage. The accepted JSON was independently re-read for accepted counts and time coverage; thumbnail coverage is from the batch9 discovery manifest.

Reviewed but not used as success evidence:

- 'artifacts/channel-discovery/2026-07-22-source-backfill-batch73-kamikumononoa-mac-readonly/manifest.json': status interrupted, success False, interrupted/status-only.
- 'artifacts/channel-discovery/2026-07-22-source-backfill-batch75-kamikumononoa-shard0of4-mac-readonly/manifest.json': status interrupted, success False, interrupted/status-only.

## Dirty Audit Rules

Hard exclude terms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone.

Exact phrases: piano streaming, piano performance, ピアノ演奏.

live / ライブ are not standalone hard excludes; they are suspicious/drop only when no singing signal is present. Batch9 had a KAMIKUMONONOA live suspicious item that was manually retained, so this report records it as suspicious retained evidence and does not drop it.

Dirty audit result: dropped videos 0, dropped occurrences 0, suspicious retained videos 1.

## Runtime And Cleanup

No YouTube fetch was started for batch81. Mac not used. Remote temp not created.

Temporary work was limited to G:\codex-temp\batch81_kamikumononoa_duplicate_evidence.ps1, and that script was removed after generation. No C/D/G large cache, checkout, runtime DB, or source export was created. D drive writes were limited to the five small files in this artifact directory.
