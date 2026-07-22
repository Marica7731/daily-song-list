# 2026-07-22 source backfill batch14

This is a skip-evidence batch. It does not contain an accepted increment and does not modify `data/external`.

## Status

| Source | Status | Existing videos | Existing occurrences | Existing songs | Time coverage | Thumbnail coverage | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| `https://www.youtube.com/@HazukiHina/streams` | skipped | 7 | 51 | 45 | `published 7/7`, `time 51/51`, `seconds 51/51` | accepted JSON `0/7`, discovery `7/7` | already self-crawled in `data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave1.json` |

## Evidence

- Accepted file: `data/external/youtube-channel-discovery/accepted/2026-07-20-source-backfill-wave1.json`.
- Discovery input directory: `artifacts/channel-discovery/2026-07-20-source-backfill/HazukiHina`.
- Discovery manifest: `candidateCount=12`, `inspectedInLatestRun=11`, `usableVideoCount=7`, `occurrenceCount=51`.
- Discovery video details have thumbnail coverage `7/7` and published coverage `7/7`.
- The accepted increment exporter used by this project does not retain thumbnail fields in accepted JSON; this matches earlier batch notes, so accepted JSON thumbnail coverage is recorded separately as `0/7`.

## Pending Large Sources

The following requested sources remain pending and should be run as sharded discovery batches rather than one unbounded runner:

| Source | Candidate probe | Current status | Next action |
| --- | ---: | --- | --- |
| `https://www.youtube.com/@asaxmayo/streams` | 363 | pending | shard discovery |
| `https://www.youtube.com/@Laz_Furuto/streams` | 312 | pending | shard discovery |
| `https://www.youtube.com/@UtenHiyori` | 428 | pending | shard discovery |

## Remote Cleanup

No VPS was used for this skip-evidence batch, so no remote temporary directory was created.
