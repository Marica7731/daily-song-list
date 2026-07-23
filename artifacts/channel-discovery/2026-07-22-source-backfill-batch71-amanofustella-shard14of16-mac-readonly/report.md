# Source backfill batch71 AmanofuStella shard14of16

Status: success
Failure reason:

## Files

- candidate-increment-unfiltered.json
- accepted-increment.json
- dirty-audit.json
- manifest.json
- report.md

## Core statistics

- imported/skipped/failed: 11/0/0
- candidateCount: 208
- inspectedCount: 13
- usableVideoCount: 11
- accepted videos/occurrences/songs: 11/139/127
- uniqueSongs: 127
- publishedTimestamp coverage: 11/11
- occurrence time/seconds coverage: 139/139 / 139/139
- accepted thumbnailUrl coverage: 11/11
- discovery thumbnail coverage: 208/208
- reachedEnd: false
- elapsedSeconds: 107

## Dirty audit policy

- hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
- exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
- live/ライブ rule: drop only when missing singing signal (歌枠, 歌, 弾き語り, karaoke, 歌ってみた)

## Verification markers

- discovery marker: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/@AmanofuStella" candidates=208 inspected=13 videos=11 occurrences=139 elapsedSeconds=107 outputDir="/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery"
- export marker: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=139 output="/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/final/candidate-increment-unfiltered.json"
- final marker: CODEX_SOURCE_BACKFILL_BATCH71_AMANOFUSTELLA_SHARD14OF16_OK
- source-filter.js: size 60415, sha256 bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103

## Cleanup

- Mac temp dir: /Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly
- cleanup marker: CODEX_MAC_CLEANUP_OK removedDiscovery=true; CODEX_MAC_FINAL_CLEANUP_OK removedTempRoot=true
```
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data

```

## Windows disks

CODEX_WINDOWS_DISK_CHECK_OK

- C: used 238.15GB, free 60.93GB.
- D: used 437.89GB, free 9.22GB; final artifact is under this drive only.
- G: used 1268.48GB, free 638.93GB; G:\codex-temp existed with 14 items, no files were written there by this worker.
- C cleanup: accidental temporary runner file was removed before final verification.

## Stage log

```jsonl
{"at":"2026-07-23T05:08:39.528Z","stage":"precheck-git","status":"start","cmd":"git","args":["rev-parse","HEAD"],"timeoutMs":30000}
{"at":"2026-07-23T05:08:39.540Z","stage":"precheck-git","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"f1b0e8423e755b2c3b38a5288c98bca3e5d092cc\n","stderrTail":""}
{"at":"2026-07-23T05:08:39.540Z","stage":"discovery-checkpoint","status":"ready","tempRoot":"/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly","discoveryDir":"/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery","outputDir":"/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/final","precheck":{"repo":"/Users/be/daily-song-list","repoHead":"f1b0e8423e755b2c3b38a5288c98bca3e5d092cc","sourceFilterPath":"/Users/be/daily-song-list/assets/source-filter.js","sourceFilterSize":60415,"sourceFilterSha256":"bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103"}}
{"at":"2026-07-23T05:08:39.540Z","stage":"discovery","status":"start","cmd":"node","args":["scripts/youtube-channel-discovery.js","--channel-url","https://www.youtube.com/@AmanofuStella","--singer-name","AmanofuStella","--output-dir","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery","--cache-dir","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/cache","--max-channel-pages","12","--max-candidates","320","--max-inspect","320","--inspect-shard-index","14","--inspect-shard-count","16","--request-interval-ms","1200","--request-jitter-ms","300","--fresh"],"timeoutMs":2700000}
{"at":"2026-07-23T05:10:26.650Z","stage":"discovery","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel=\"https://www.youtube.com/@AmanofuStella\" candidates=208 inspected=13 videos=11 occurrences=139 elapsedSeconds=107 outputDir=\"/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery\"\n","stderrTail":""}
{"at":"2026-07-23T05:10:26.650Z","stage":"export-unfiltered","status":"start","cmd":"node","args":["scripts/export-channel-discovery-increment.js","--input-dir","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery","--output","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/final/candidate-increment-unfiltered.json","--allow-empty"],"timeoutMs":300000}
{"at":"2026-07-23T05:10:26.827Z","stage":"export-unfiltered","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=11 usableVideos=11 acceptedVideos=11 skippedRegressions=0 occurrences=139 output=\"/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/final/candidate-increment-unfiltered.json\"\n","stderrTail":""}
{"at":"2026-07-23T05:10:26.830Z","stage":"df-before-cleanup","status":"start","cmd":"df","args":["-h","/Users/be","/Users/be/codex-temp"],"timeoutMs":30000}
{"at":"2026-07-23T05:10:26.832Z","stage":"df-before-cleanup","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n","stderrTail":""}
{"at":"2026-07-23T05:10:26.832Z","stage":"cleanup-discovery","status":"start","cmd":"rm","args":["-rf","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/discovery"],"timeoutMs":60000}
{"at":"2026-07-23T05:10:26.835Z","stage":"cleanup-discovery","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"","stderrTail":""}
{"at":"2026-07-23T05:10:26.835Z","stage":"cleanup-runner","status":"start","cmd":"rm","args":["-f","/Users/be/codex-temp/daily-song-list-source-backfill-batch71-amanofustella-shard14of16-mac-readonly/run-mac-batch71-amanofustella-shard14of16.js"],"timeoutMs":30000}
{"at":"2026-07-23T05:10:26.836Z","stage":"cleanup-runner","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"","stderrTail":""}
{"at":"2026-07-23T05:10:26.836Z","stage":"df-after-cleanup","status":"start","cmd":"df","args":["-h","/Users/be","/Users/be/codex-temp"],"timeoutMs":30000}
{"at":"2026-07-23T05:10:26.837Z","stage":"df-after-cleanup","status":"ok","exitCode":0,"signal":null,"timedOut":false,"stdoutTail":"Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n","stderrTail":""}
{"at":"2026-07-23T05:10:26.837Z","stage":"cleanup","status":"ok","attempted":true,"removed":true,"dfBefore":"Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n","dfAfter":"Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n/dev/disk3s5   926Gi   227Gi   660Gi    26%    636k  6.9G    0%   /System/Volumes/Data\n","marker":"CODEX_MAC_CLEANUP_OK removedDiscovery=true"}
```
