# 2026-07-22 source backfill batch37 AmanofuStella

Status: `interrupted`.

This artifact is status-only. It does not contain an accepted increment because the remote discovery had not produced a final `manifest.json` when the controller requested interruption.

## Source

- URL: `https://www.youtube.com/@AmanofuStella`
- Singer name: `天ノ譜ステラ`
- Existing accepted evidence: 0 accepted files matched under `data/external/youtube-channel-discovery/accepted`.
- Existing artifact mentions: 10 manifest mentions, all non-accepted/pending status evidence for this channel.

## Remote Run

- Host: `vps-jp` (`VM-c8189ce8-42c5-4763-bfb1-d000d087dbb5`)
- Remote dir: `/opt/ytb-song-rank-source-backfill-20260723-batch37-amanofustella-vps-jp-r1`
- Setup: sparse clone from `https://github.com/Marica7731/daily-song-list.git`, source commit `f1b0e8423e755b2c3b38a5288c98bca3e5d092cc`; no tar/source archive upload.
- Discovery command: `timeout 3600s npm run youtube:discover-channel -- --channel-url https://www.youtube.com/@AmanofuStella --singer-name 天ノ譜ステラ --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3500 --request-jitter-ms 1500`
- Last stage: `2026-07-22T17:16:13Z stage=discovery_done exit=143`

## Partial Checkpoint

- Candidate count: 235
- Inspected count: 80
- Usable video count: 70
- Partial occurrences: 617
- Accepted videos / occurrences / songs: 0 / 0 / 0
- Published timestamp coverage: `70/70` in partial checkpoint only
- Occurrence time / seconds coverage: `617/617` / `617/617` in partial checkpoint only
- Thumbnail coverage: videos `70/70`; occurrence rows `0/617` in partial checkpoint only
- Dirty dropped / suspicious: not audited because no complete discovery manifest was produced.

## Cleanup

- Remote cleanup status: `removed`
- Post-cleanup `df -h /`: `/dev/sda1 99G 11G 88G 11% /`

## Validation Commands

- `Get-Content artifacts/channel-discovery/2026-07-22-source-backfill-batch37-amanofustella/manifest.json`
- `Get-Content artifacts/channel-discovery/2026-07-22-source-backfill-batch37-amanofustella/checkpoint-summary.json`
- `ssh vps-jp test ! -e /opt/ytb-song-rank-source-backfill-20260723-batch37-amanofustella-vps-jp-r1`
- `ssh vps-jp df -h /`
