# 2026-07-23-source-backfill-batch82-sacluhay-duplicate-evidence

Status: `skipped_duplicate`.

Scope: only `https://www.youtube.com/@saclayui/streams`. This batch did not run the full 1000+ channel queue and did not start YouTube discovery.

## Duplicate Evidence

- Evidence source: `artifacts/channel-discovery/2026-07-22-source-backfill-batch12/accepted/2026-07-22-source-backfill-batch12.accepted.json`.
- Supporting batch files: `artifacts/channel-discovery/2026-07-22-source-backfill-batch12/manifest.json`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch12/report.md`, `artifacts/channel-discovery/2026-07-22-source-backfill-batch12/remote-download/vps5/remote/saclayui/manifest.json`.
- The batch12 accepted file contains the saclayui accepted result: video `2mFMDi9gf_k`, 2 occurrences, 2 unique songs.
- batch12 `omaru_piano` is failed and is not counted as success evidence for this batch.
- Queue/pending evidence was not used.

## Stats

| Metric | Value |
| --- | ---: |
| Candidate count | 179 |
| Inspected count | 179 |
| Raw videos | 20 |
| Raw occurrences | 124 |
| Accepted videos | 1 |
| Accepted occurrences | 2 |
| Accepted unique songs | 2 |
| publishedTimestamp coverage | 1/1 |
| publishedTimestamp range | 1782094358262 to 1782094358262 |
| occurrence time coverage | 2/2 |
| occurrence seconds coverage | 2/2 |
| occurrence seconds range | 580 to 1051 |
| thumbnail coverage | 1/1 |
| cover coverage | 1/1 |
| reachedEnd | true |

## Dirty Audit

Hard exclude terms recorded for this batch: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone.

Exact phrase excludes recorded for this batch: `piano streaming`, `piano performance`, `ピアノ演奏`.

`live` / `ライブ` is not an independent hard exclude; it is suspicious/drop only when there is no singing signal.

batch12 dirty audit summary for saclayui:

- Raw: 20 videos / 124 occurrences.
- Kept after audit: clear `#歌枠` only, 1 video / 2 occurrences / 2 songs.
- Dropped: 19 videos / 122 occurrences, mainly instrumental clarinet/live-performance or manual non-song-frame streams.
- Suspicious: 1 video, the kept `2mFMDi9gf_k`, because it had a broad `live` signal but also clear `#歌枠`.

## Execution And Cleanup

- YouTube discovery: not started.
- Mac: not used.
- Remote temp: not created.
- Local temp: not created by this batch.
- `G:\codex-temp`: not used by this batch, so no new cleanup was required.
- D/C/G large-file note: this batch created only the five small files in the specified artifact directory and did not create a checkout, runtime DB, source export, or large cache.
- Elapsed time recorded for batch work: 0 seconds for discovery; this was duplicate evidence review only.
- Failure reason: none; status is skipped because duplicate accepted evidence already exists.
