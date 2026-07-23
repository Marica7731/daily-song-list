# Batch85 Dia Duplicate Evidence

Status: `skipped_duplicate`

Reason: `duplicate_concrete_accepted_artifact_exists`

Target source: `https://www.youtube.com/@Dia-%E3%83%87%E3%82%A3%E3%82%A2`

## Evidence Sources

- `artifacts/channel-discovery/2026-07-22-source-backfill-batch8/accepted/2026-07-22-source-backfill-batch8.accepted.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch8/accepted/2026-07-22-source-backfill-batch8.raw-export.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch8/manifest.json`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch8/report.md`
- `artifacts/channel-discovery/2026-07-22-source-backfill-batch8/dirty-audit.json`

## Duplicate Accepted Evidence

Batch8 accepted JSON was parsed directly. Matching rule:

`video.channelHandle == "/@Dia-%E3%83%87%E3%82%A3%E3%82%A2"` or `video.channelUrl == "https://www.youtube.com/@Dia-%E3%83%87%E3%82%A3%E3%82%A2"`.

| Field | Value | Source |
| --- | ---: | --- |
| Existing accepted videos | 18 | batch8 accepted JSON |
| Existing accepted occurrences | 339 | batch8 accepted JSON |
| Existing unique songs | 251 | batch8 accepted JSON |
| Published timestamp coverage | 18/18 | batch8 accepted JSON |
| Occurrence time coverage | 339/339 | batch8 accepted JSON |
| Occurrence seconds coverage | 339/339 | batch8 accepted JSON |
| Accepted thumbnail/cover field coverage | 0/18 | batch8 accepted JSON |
| `acceptedFileHasThumbnailOrCoverFields` | false | batch8 accepted JSON |

The accepted file has no top-level thumbnail/cover fields on the matched Dia video objects. Discovery thumbnail coverage is therefore referenced from batch8 manifest/report instead: `18/18`.

Existing accepted video IDs:

`e4R5rXAMvu0`, `pLv2zLoXZUM`, `pByVvw95upU`, `pJqfpYaav4U`, `kOmAKXehvTU`, `0eqJqS88ngg`, `84eWdmrQD4E`, `88GMj3_Z7sM`, `MVTkvKsAia0`, `WV5oOHb2gT8`, `LuT0JJBfKys`, `3RLCvOZQfD4`, `YuYWbhbMf78`, `F-zryuM4NOc`, `pt9iUBdxwwY`, `2HI-7dPPu7A`, `wWvSzWxDo5E`, `F61u3_ZNlew`

## Discovery Cross-Check

| Field | Value | Source |
| --- | ---: | --- |
| candidateCount | 27 | batch8 manifest `discoveryCandidateCount`; report candidate probe line |
| inspectedCount | 27 | batch8 manifest `discoveryInspectedCount` |
| usableVideoCount | 20 | batch8 manifest `discoveryUsableVideoCount`; report imported line `20/370` |
| discoveryOccurrenceCount | 370 | batch8 manifest `discoveryOccurrenceCount`; report imported line `20/370` |
| reachedEnd | true | batch8 manifest and report |
| elapsedSeconds | 346 | batch8 manifest and report |
| discovery thumbnail coverage | 18/18 | batch8 manifest and report |

No unknown fields were needed for these requested statistics; all were present in batch8 manifest/report and cross-checked where possible.

## Dirty Audit

Batch8 dirty-audit reports:

- Dropped: 0 videos / 0 occurrences.
- Suspicious: 0 videos; term hits `{}`.

Because batch8 dirty-audit has empty `dropped` and `suspicious` arrays, this batch records 0/0 and no Dia-specific dropped/suspicious entries.

## Batch85 Output

This batch intentionally emits no duplicate videos or candidate rows:

- `accepted-increment.json`: `videos: []`, `videoCount: 0`, `occurrenceCount: 0`, with duplicate evidence.
- `candidate-increment-unfiltered.json`: `candidates: []`, `candidateCount: 0`, with duplicate evidence.

## Constraints

- No Mac used.
- No VPS used.
- No remote temporary directory created.
- No YouTube fetch started.
- No `data/external` files changed.
- No commit created.
- No push performed.
- No deploy performed.
- Temporary script created for local JSON parsing: `G:/codex-temp/batch85_dia_duplicate_stats_20260723.ps1`; deleted before final handoff.
