# Source Backfill Batch109 Stop Summary

- Status: pending_partial
- completeForImport: false
- Remote root: /tmp/ytb-song-rank-source-backfill-20260720/batch109-asaxmayo-hazukihina
- Stop reason: main_session_timeout_interrupt_before_complete_discovery
- Export marker: not run
- Accepted increment: accepted/2026-07-23-source-backfill-batch109.accepted.json

## Channels

| Handle | Status | Checkpoint | Checkpoint bytes | Candidate count | Details | Occurrences in checkpoint | Manifest | OK marker | Accepted videos | completeForImport | Failure |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |
| asaxmayo | pending_partial | true | 925098 | 53 | 17 | 99 | false | false | 0 | false | main_session_timeout_interrupt_before_complete_discovery_marker |
| HazukiHina | failed | false | 0 |  | 0 | 0 | false | false | 0 | false | main_session_timeout_interrupt_before_complete_discovery_marker |

## Dirty Audit

- Not run because no channel reached complete discovery/export.
- Planned hard drops: フルート, 生演奏, クラリネット, exact phrase piano streaming, exact phrase ピアノ演奏.
- Planned broad suspicious only: live, ライブ.

## Delivery

- Commit: not run.
- Push: not run.
- Deploy/restart/package: not run.
- data/external: not written.
- Raw checkpoint/cache files: not copied.
