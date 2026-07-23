# Source backfill batch113 - SoraOtoha

- Generated: 2026-07-23T12:25:38.558595Z
- Channel: https://www.youtube.com/@SoraOtoha
- Handle/Singer: SoraOtoha
- Status: probe_only
- Candidates: 115
- Reached end all tabs: false
- Full discovery: skipped
- Accepted export: not exported; accepted JSON is empty
- Failure reason: probe_only: candidateCount=115 exceeds 25; reachedEndAllTabs=false; full discovery and export skipped by batch rule

## Probe page coverage
- https://www.youtube.com/@SoraOtoha/streams?hl=ja&persist_hl=1: status=200 pages=5 rawItems=149 candidates=112 reachedEnd=false
- https://www.youtube.com/@SoraOtoha/videos?hl=ja&persist_hl=1: status=200 pages=2 rawItems=10 candidates=3 reachedEnd=true

## Dirty audit
- Hard dropped: 0
- Suspicious live/ライブ only: 36
- Hard drop terms: フルート, 生演奏, クラリネット, piano streaming, ピアノ演奏
- live/ライブ was recorded as suspicious only and not dropped blindly.

## Required artifacts
- manifest.json
- worker-summary.json
- dirty-audit.json
- accepted/2026-07-23-source-backfill-batch113.accepted.json
- probe-summary.json
- probe.log

## Verification commands
- npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@SoraOtoha --singer-name SoraOtoha --output-dir /tmp/ytb-song-rank-source-backfill-20260720/batch113-soraotoha-probe-full/probe --candidate-only --max-channel-pages 5 --max-candidates 120 --request-interval-ms 3000 --request-jitter-ms 1000
- git -C D:\Projects\daily_song_list_worker_source_backfill_20260720 status --short

## Remote cleanup
- Status: ok
- Log: cleanup-and-df.log

```text
CODEX_CLEANUP_OK target=/tmp/ytb-song-rank-source-backfill-20260720/batch113-soraotoha-probe-full
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   335Gi   553Gi    38%    710k  5.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   335Gi   553Gi    38%    710k  5.8G    0%   /System/Volumes/Data
```
