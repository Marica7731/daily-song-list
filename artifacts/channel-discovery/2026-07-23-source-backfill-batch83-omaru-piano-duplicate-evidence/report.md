# 2026-07-23-source-backfill-batch83-omaru-piano-duplicate-evidence

## Status

- status: skipped_duplicate
- reason: batch22_imported_artifact_ready_already_exists
- source: https://www.youtube.com/@omaru_piano/streams
- YouTube discovery: not started
- Mac not used / remote temp not created

## Batch22 Evidence

Batch22 already consolidated the completed omaru_piano shard artifacts and marked the source imported_artifact_ready with acceptedIncrementReadyForReview=true.

- accepted increment: artifacts/channel-discovery/2026-07-22-source-backfill-batch22/accepted-increment.json
- manifest: artifacts/channel-discovery/2026-07-22-source-backfill-batch22/manifest.json
- dirty audit summary: artifacts/channel-discovery/2026-07-22-source-backfill-batch22/dirty-audit-summary.json
- report: artifacts/channel-discovery/2026-07-22-source-backfill-batch22/report.md

Earlier omaru_piano failures in batch12/batch17 are treated as resolved by shard batches 18/19/20/21 and batch22 consolidation. The batch18 shard0 YouTube 429 gap was resolved by batch21.

## Candidate / Inspected Scope

- candidatesAcrossShardRuns: 444
- inspectedAcrossShardRuns: 111
- scope note: candidate count is shard-run repeated count, not unique channel candidates
- reachedEnd/completed shard status: shards 0/1/2/3 completed, no failed shards, no pending shards

## Accepted Increment Stats

- accepted videos: 18
- accepted occurrences: 64
- unique songs: 55
- publishedTimestamp coverage: 18/18
- publishedTimestamp range: 1721630304044 to 1779520570780
- occurrence time coverage: 64/64
- occurrence seconds coverage: 64/64
- occurrence seconds range: 70 to 6105
- thumbnail/cover coverage: accepted increment thumbnail fields 0/18; discovery thumbnail coverage 18/18

## Dirty Audit Policy

- hard exclude terms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exact phrase drops: piano streaming, piano performance, ピアノ演奏
- live/ライブ is not a standalone hard exclusion; it is suspicious/drop only when there is no singing signal
- contextual drops from batch22 summary: Session, セッション, 合奏, 雑談, ピアノ演奏リレー
- dropped: 20 videos / 64 occurrences
- suspicious dropped: 4 videos

## Runtime / Cleanup

- duration: local evidence-only artifact generation; no YouTube discovery runtime
- failure reason: none; skipped because duplicate/import-ready evidence exists
- temp cleanup: no retained temp working files; no Mac or remote temp created
- Windows disk policy: no new large files intentionally created on C:, D:, or G:; only the five small final artifacts in this directory
- repository policy: no data/external writes, no commit, no push, no deploy
