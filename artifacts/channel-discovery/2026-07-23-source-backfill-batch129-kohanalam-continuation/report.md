# 2026-07-23-source-backfill-batch129-kohanalam-continuation

Continuation run for `https://www.youtube.com/@KohanaLam/streams`. This is a partial artifact only; it was not imported into `data/external`.

## Status

| Source | Status | Candidates | Inspected audits | Checkpoint details | New accepted videos | New occurrences | Unique songs | Dropped videos | Suspicious videos | reachedEnd |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `https://www.youtube.com/@KohanaLam/streams` | pending_partial | 225 | 116 | 31 | 28 | 261 | 134 | 0 | 0 | false |

## Accepted Increment

- Path: `artifacts/channel-discovery/2026-07-23-source-backfill-batch129-kohanalam-continuation/accepted-increment.json`.
- Batch32 accepted videoIds excluded: `1_scZU0bCgQ`, `X9gtw7q1rQM`.
- Seed checkpoint details excluded before export: `1_scZU0bCgQ`, `H5aQ0sId9CA`, `X9gtw7q1rQM`.
- Time coverage: publishedTimestamp 28/28; occurrence time 261/261; occurrence seconds 261/261.
- Cover coverage: accepted increment thumbnail fields 0/28.

## Dirty Audit

- Dropped 0 videos / 0 occurrences.
- Suspicious retained videos: 0 / occurrences 0.
- Hard exclusion terms: `フルート`, `生演奏`, `クラリネット`, `サックス`, `吹奏楽`, exact phrases `piano streaming`, `ピアノ演奏`.
- `live` and `ライブ` were retained as suspicious-only markers.

## Partial Reason

- Remote runner stopped by timeout before final discovery manifest was written.
- `reachedEnd=false` because only checkpoint progress is proven; this artifact is reviewable but not a full/imported source completion.

## Remote Cleanup

- Mac temp cleanup and final `df -h /tmp /Users/be` are recorded in `cleanup-df.txt`.
