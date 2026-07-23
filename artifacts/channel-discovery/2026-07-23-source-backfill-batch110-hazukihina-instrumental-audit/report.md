# Source Backfill Batch110 HazukiHina Instrumental Audit

- Status: skipped
- completeForImport: false
- Source discovery: artifacts/channel-discovery/2026-07-20-source-backfill/HazukiHina
- Discovery evidence: candidates=12, inspected=11, usableVideos=7, occurrences=51, reachedEndAllTabs=True
- Accepted increment: accepted/2026-07-23-source-backfill-batch110.accepted.json
- Export marker: not run; accepted intentionally empty after dirty audit dropped all parsed videos

## Decision

HazukiHina is not imported in this batch. The existing complete discovery was audited with the current dirty-data filter requirements, and every parsed video matched hard instrumental/performance terms such as フルート or 生演奏.

## Channel Stats

| Handle | Status | Candidates | Inspected | Usable before audit | Occurrences before audit | Dropped videos | Dropped occurrences | Accepted videos | Accepted occurrences |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| HazukiHina | skipped | 12 | 11 | 7 | 51 | 7 | 51 | 0 | 0 |

## Time/Cover Coverage Before Drop

- Video publishedTimestamp: 7/7
- Occurrence publishedAt: 51/51
- Occurrence time: 51/51
- Occurrence seconds: 51/51
- Thumbnail/cover: 7/7

## Dirty Audit

- Hard drop terms: フルート, 生演奏, クラリネット
- Hard exact phrases: piano streaming, ピアノ演奏
- Broad suspicious only: live, ライブ
- Dropped videos: 7
- Dropped occurrences: 51
- Suspicious-only videos: 0

No remote/VPS directory was created for this audit-only batch. No data/external files were written.
