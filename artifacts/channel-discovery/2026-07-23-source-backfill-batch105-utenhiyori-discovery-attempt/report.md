# Batch105 UtenHiyori Failed Discovery Attempt

Status: `failed`

Reason: `youtube_streams_fetch_failed_after_two_bounded_attempts`

## Scope

This artifact records a failed bounded discovery attempt. It did not rerun an unbounded command, did not use Mac or VPS execution, did not create a remote temporary directory, did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

No discovery marker was produced, and no `manifest.json`, `video-details.json`, or `occurrences.json` came from the discovery script. This source is not complete for import.

## Attempts

| Attempt | Timeout | Exit | Timed out | Marker | Result |
| --- | ---: | ---: | --- | --- | --- |
| worker full small cap | 600000ms | 1 | false | none | fetch failed on streams page |
| main candidate-only retry | 180000ms | 1 | false | none | same fetch failed on streams page |

Failure summary:

- `VsingerHttpError: Request failed for https://www.youtube.com/@UtenHiyori/streams?hl=ja&persist_hl=1: fetch failed`

## Accepted Increment

The accepted increment is intentionally empty: 0 videos / 0 occurrences / 0 songs. Time coverage remains 0/0 because no video rows were produced.

## Outputs

Generated exactly these 6 small files in `artifacts/channel-discovery/2026-07-23-source-backfill-batch105-utenhiyori-discovery-attempt/`:

- `run-summary.json`
- `retry2-summary.json`
- `candidate-increment-unfiltered.json`
- `accepted-increment.json`
- `manifest.json`
- `report.md`
