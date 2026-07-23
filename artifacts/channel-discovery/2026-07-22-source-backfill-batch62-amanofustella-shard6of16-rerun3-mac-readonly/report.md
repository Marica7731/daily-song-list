# 2026-07-22-source-backfill-batch62-amanofustella-shard6of16-rerun3-mac-readonly

- status: success
- marker: CODEX_BATCH62_SOURCE_BACKFILL_SUCCESS
- channel: https://www.youtube.com/@AmanofuStella
- shard: 6/16
- imported/skipped/failed: 12/0/0
- candidateCount: 225
- inspectedCount: 14
- usableVideoCount: 12
- discovery occurrences: 97
- accepted videos/occurrences/songs: 12/97/97
- accepted uniqueSongs: 91
- publishedTimestamp coverage: 12/12
- occurrence time coverage: 97/97
- occurrence seconds coverage: 97/97
- accepted thumbnail coverage: 12/12
- discovery thumbnail coverage: 225/225
- reachedEnd: true
- failureReason:
- discovery elapsedSeconds: 335

## Dirty Audit

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live rule: live/ライブ is suspicious/drop only when the title lacks explicit singing signals such as 歌枠, 歌, 弾き語り, karaoke, 歌ってみた.
- dropped videos/occurrences: 0/0
- suspicious kept videos: 0

## Precheck

- Mac repo: /Users/be/daily-song-list
- Mac repo HEAD: f1b0e8423e755b2c3b38a5288c98bca3e5d092cc
- source-filter.js: sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103, size 60415

## Stage Log

- windows-start-marker: ok
- mac-precheck: ok
- discovery: ok; CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK candidates=225 inspected=14 videos=12 occurrences=97
- export: ok; CODEX_CHANNEL_DISCOVERY_INCREMENT_OK acceptedVideos=12 occurrences=97
- dirty-audit: ok

## Cleanup

- Mac cleanup marker: CODEX_MAC_CLEANUP_OK path=/Users/be/codex-temp/daily-song-list-source-backfill-batch62-amanofustella-shard6of16-rerun3-mac-readonly removed=true
- Mac df -h: /dev/disk3s5 926Gi size, 136Gi used, 751Gi avail, 16% capacity
- Windows disk marker: CODEX_WINDOWS_DISK_STATUS_OK
- Windows C: usedBytes=255839653888 freeBytes=65299324928 tempUsed=false
- Windows D: usedBytes=470180188160 freeBytes=9905086464 artifactWritten=true
- Windows G: usedBytes=1352685256704 freeBytes=695389523968 tempUsed=true tempCleaned=true
