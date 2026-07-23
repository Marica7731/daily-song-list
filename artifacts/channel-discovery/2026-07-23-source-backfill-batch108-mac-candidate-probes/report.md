# Batch108 Mac Candidate Probes

Status: `probe_only`

This artifact records a bounded candidate-only probe for three pending source-backfill channels. It is not an accepted/importable discovery artifact. No rows were imported, no `data/external` files were written or overwritten, and the accepted increment is intentionally empty.

## Scope

- Host: `ssh be@192.168.1.13`
- Mac repo: `/Users/be/daily-song-list`
- Environment command: `source ~/.daily-song-list-build-env`
- Mac temp dir: `/tmp/ytb-song-rank-source-backfill-20260720/batch108-probes`
- Per-channel bounds: `--candidate-only --max-channel-pages 2 --max-candidates 120 --request-interval-ms 3000 --request-jitter-ms 1000`
- Per-channel timeout: `180000 ms`
- Local artifact dir: `artifacts/channel-discovery/2026-07-23-source-backfill-batch108-mac-candidate-probes/`

## Results

| Handle | Status | Candidates | Inspected | Detail count | Accepted videos | Accepted occurrences | Failure |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `asaxmayo` | `probe_only` | 7 | 0 | 0 | 0 | 0 |  |
| `HazukiHina` | `probe_only` | 5 | 0 | 0 | 0 | 0 |  |
| `Laz_Furuto` | `probe_only` | 47 | 0 | 0 | 0 | 0 |  |

Total candidates: 59.

Accepted videos / occurrences / songs: 0 / 0 / 0.

`completeForImport`: `false`.

## Probe Markers

- `asaxmayo`: `CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@asaxmayo/streams" candidates=7 inspected=0 videos=0 occurrences=0 elapsedSeconds=15 outputDir="/tmp/ytb-song-rank-source-backfill-20260720/batch108-probes/asaxmayo"`
- `HazukiHina`: `CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@HazukiHina/streams" candidates=5 inspected=0 videos=0 occurrences=0 elapsedSeconds=15 outputDir="/tmp/ytb-song-rank-source-backfill-20260720/batch108-probes/HazukiHina"`
- `Laz_Furuto`: `CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@Laz_Furuto/streams" candidates=47 inspected=0 videos=0 occurrences=0 elapsedSeconds=15 outputDir="/tmp/ytb-song-rank-source-backfill-20260720/batch108-probes/Laz_Furuto"`

## Cleanup

Cleanup marker:

```text
CODEX_CLEANUP_OK path=/tmp/ytb-song-rank-source-backfill-20260720/batch108-probes
```

`df -h /tmp /Users/be` after cleanup:

```text
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   335Gi   553Gi    38%    710k  5.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   335Gi   553Gi    38%    710k  5.8G    0%   /System/Volumes/Data
```

## Outputs

Generated required small files:

- `manifest.json`
- `accepted-increment.json`
- `report.md`

No raw/cache/checkpoint files were copied into the local artifact directory. A small `worker-summary.json` is also present in the target directory; it is not raw/cache/checkpoint data.
