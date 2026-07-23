# batch78 Kamisatoniina source-backfill

status: skipped_duplicate

This worker did not crawl Mac because a concrete accepted increment already exists for this channel. The evidence is not a queue manifest: it is an accepted JSON containing Kamisatoniina videos and song occurrences.

## Source

- channel: https://www.youtube.com/@Kamisatoniina
- handle: Kamisatoniina
- channelId: UC1nBh6p6w53rAOhN5gwF3iQ
- batch: batch78

## Duplicate Evidence

- source type: self-crawled concrete accepted increment
- moment-only: false
- evidence file: artifacts/channel-discovery/2026-07-22-source-backfill-batch4/accepted/2026-07-22-source-backfill-batch4.accepted.json
- raw export evidence: artifacts/channel-discovery/2026-07-22-source-backfill-batch4/accepted/2026-07-22-source-backfill-batch4.raw-export.json
- existing accepted videos: 22
- existing accepted occurrences: 327
- existing accepted songs: 327
- existing unique songs: 179
- existing publishedTimestamp coverage: 22/22
- existing occurrence time coverage: 327/327
- existing occurrence seconds coverage: 327/327
- existing accepted thumbnail coverage (thumbnailUrl): 0/22
- existing discovery thumbnail coverage: 0/22

## Batch78 Output Stats

- imported: 0
- skipped: 22
- failed: 0
- candidateCount: 0
- inspectedCount: 0
- usableVideoCount: 0
- accepted videos: 0
- accepted occurrences: 0
- accepted songs: 0
- uniqueSongs: 0
- publishedTimestamp coverage: 0/0
- occurrence time coverage: 0/0
- occurrence seconds coverage: 0/0
- accepted thumbnail coverage (thumbnailUrl): 0/0
- discovery thumbnail coverage: 0/0
- reachedEnd: n/a, duplicate skip before discovery
- elapsedMs: 0
- failureReason: empty

## Dirty Audit Policy

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live/ライブ: suspicious/drop only when singing signal is missing
- singing signals: 歌枠, 歌, 弾き語り, karaoke, 歌ってみた

## Cleanup

- Windows D/C/G usage recorded in manifest cleanup.windows.drivesBeforeFinalArtifact.
- G temp cleanup status: ok; no G files were created by this worker.
- C workspace temporary artifact path was removed after accidental patch placement; see manifest cleanup.windows.cWorkspaceTempArtifactCleanup.
- C temp usage: none by this worker.
- Mac temp dir: /Users/be/codex-temp/daily-song-list-source-backfill-batch78-kamisatoniina-mac-readonly
- Mac cleanup marker/df -h: CODEX_MAC_CLEANUP_OK, cleanup=not_present, df-h=/dev/disk3s5 926Gi used 270Gi avail 618Gi capacity 31% mounted /System/Volumes/Data.

## Stage Log

- 2026-07-23T06:42:52.846Z startup-marker: ok
- 2026-07-23T06:42:52.846Z repo-check: ok
- 2026-07-23T06:42:52.846Z duplicate-discovery: ok
- 2026-07-23T06:42:52.846Z mac-crawl: skipped (duplicate concrete accepted increment already exists for this channel)
- 2026-07-23T06:42:52.846Z mac-cleanup: not-needed (no Mac temp dir created by this worker)
