# batch76 rayray_429 skipped duplicate report

- status: skipped_duplicate
- source: https://www.youtube.com/@rayray_429
- imported: 0
- skipped: 1
- failed: 0
- current accepted videos: 0
- current accepted occurrences: 0
- current uniqueSongs: 0
- duplicate existing videos: 9
- duplicate existing occurrences: 155
- duplicate existing uniqueSongs: 154
- existing publishedTimestamp coverage: 9/9
- existing occurrence time/seconds coverage: 155/155; 155/155
- existing accepted thumbnailUrl coverage: 0/9
- existing discovery thumbnail coverage: 9/9
- existing candidate/inspected/usable: 31/31/9
- existing reachedEnd: True
- failureReason:

## Duplicate Evidence

- duplicateOf: artifacts/channel-discovery/2026-07-22-source-backfill-batch5/accepted/2026-07-22-source-backfill-batch5.accepted.json
- source type: youtube-channel-discovery accepted increment artifact (self-crawled/manual backfill), not moment-only and not queue-only manifest evidence
- marker: CODEX_BATCH5_RAY_ACCEPTED_OK videos=9 occurrences=155 uniqueSongs=154 videoCount=13 occurrenceCount=170
- videoIds: fyE0O1-VOrE, 0Wj4jrV2Kdk, _Ieb3LINrSA, XkVhVREdUhU, X0gLxVt9sDg, W3PKtuD2UOg, 3kG4a7Oazsk, _A45Ew8leWU, q2CaDCmosWM

## Dirty Audit Policy

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live/ライブ rule: suspicious/drop only without singing signal; singing signals are 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- duplicate audit droppedOccurrenceHits: 0
- duplicate audit suspiciousVideoHits: 0

## Stage Log

- Windows repo/root verified at D:\Projects\daily_song_list_worker_source_backfill_20260720; branch codex/source-backfill-20260720-v2; HEAD 465bf42f4b4233ca46821b1a124dd420f39642b9
- Windows startup marker worker-started.marker.txt created before discovery/duplicate checks
- Mac preflight retried with safe single-quoted ssh command after one untrusted Windows-expanded attempt; verified repo /Users/be/daily-song-list, HEAD f1b0e8423e755b2c3b38a5288c98bca3e5d092cc, source-filter sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103, size 60415 bytes; CODEX_PREFLIGHT_OK
- Duplicate check found batch1-batch8 queue manifest mentions, but these were not used as skip evidence by themselves
- Verified concrete duplicate artifact: artifacts/channel-discovery/2026-07-22-source-backfill-batch5/accepted/2026-07-22-source-backfill-batch5.accepted.json contains rayray_429 accepted videos and occurrences; CODEX_BATCH5_RAY_ACCEPTED_OK
- Skipped rerun for batch76 because same channel already has an accepted youtube-channel-discovery increment from batch5; no data/external, runner/tool code, commit, push, deploy, or other artifact was modified
- Mac temp directory /Users/be/codex-temp/daily-song-list-source-backfill-batch76-rayray429-mac-readonly removed; CODEX_REMOTE_BATCH76_CLEANUP_OK
- G:\codex-temp was not used for this run; no G temp artifact to remove
- Final skipped/duplicate five-file artifact written on Windows; worker-started.marker.txt removed

## Cleanup Evidence

- Mac temp: /Users/be/codex-temp/daily-song-list-source-backfill-batch76-rayray429-mac-readonly
- Mac cleanup marker: CODEX_REMOTE_BATCH76_CLEANUP_OK
- Mac path after cleanup: REMOVED
- Mac df before cleanup: /dev/disk3s5 926Gi Used 268Gi Avail 620Gi Capacity 31% /System/Volumes/Data
- Mac df after cleanup: /dev/disk3s5 926Gi Used 268Gi Avail 620Gi Capacity 31% /System/Volumes/Data
- G temp: not used; no batch76 temp directory created
- Windows drives after cleanup: C free 60.88 GiB; D free 9.22 GiB; G free 638.92 GiB

## Validation Markers

- CODEX_PREFLIGHT_OK
- CODEX_BATCH5_RAY_ACCEPTED_OK
- CODEX_REMOTE_BATCH76_CLEANUP_OK
- CODEX_BATCH76_ARTIFACT_OK files=5 status=skipped_duplicate
