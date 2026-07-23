# Source Backfill Batch 72 - AmanofuStella shard15of16

status: success
channel: https://www.youtube.com/@AmanofuStella
imported/skipped/failed: 12/0/0
candidateCount: 225
inspectedCount: 14
usableVideoCount: 12
accepted videos/occurrences/songs: 12/121/121
uniqueSongs: 119
publishedTimestamp coverage: 12/12
occurrence time/seconds coverage: 121/121
accepted thumbnailUrl coverage: 12/12
discovery thumbnailUrl coverage: 225/225
reachedEnd: true
failureReason:

## Dirty Policy
hardDropTerms: フルート, 生演奏, クラリネット, サックス, サクソフォン, sax, saxophone
exactPhraseDropTerms: piano streaming, piano performance, ピアノ演奏
liveRule: recorded

## Stage Log
```
2026-07-23T13:18:46+08:00 WORKER_START channel=https://www.youtube.com/@AmanofuStella shard=15of16 batch=72
2026-07-23T13:18:46+08:00 PRECHECK repo=/Users/be/daily-song-list
f1b0e8423e755b2c3b38a5288c98bca3e5d092cc
bd441cde1c6926aefe2e9fac95cae0f431dd871eceaa22feb43ce9b0e224e103  assets/source-filter.js
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
2026-07-23T13:18:46+08:00 STAGE_START label=discovery timeoutSeconds=660
2026-07-23T13:18:56+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=10
2026-07-23T13:19:06+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=20
2026-07-23T13:19:17+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=30
2026-07-23T13:19:27+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=40
2026-07-23T13:19:37+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=50
2026-07-23T13:19:47+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=60
2026-07-23T13:19:57+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=70
2026-07-23T13:20:07+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=80
2026-07-23T13:20:17+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=90
2026-07-23T13:20:27+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=100
2026-07-23T13:20:37+08:00 STAGE_PROGRESS label=discovery elapsedSeconds=110
2026-07-23T13:20:37+08:00 STAGE_DONE label=discovery exitCode=0 elapsedSeconds=110
2026-07-23T13:20:37+08:00 STAGE_START label=export-unfiltered timeoutSeconds=180
2026-07-23T13:20:47+08:00 STAGE_PROGRESS label=export-unfiltered elapsedSeconds=10
2026-07-23T13:20:47+08:00 STAGE_DONE label=export-unfiltered exitCode=0 elapsedSeconds=10
2026-07-23T13:20:47+08:00 ACCEPTED_COPY_OK source=/Users/be/codex-temp/daily-song-list-source-backfill-batch72-amanofustella-shard15of16-mac-readonly/candidate-increment-unfiltered.json target=/Users/be/codex-temp/daily-song-list-source-backfill-batch72-amanofustella-shard15of16-mac-readonly/accepted-increment.json
```

## Cleanup / df -h
```
CLEANUP_START 2026-07-23T13:20:47+08:00
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
CLEANUP_AFTER_RM 2026-07-23T13:20:47+08:00
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
CLEANUP_OK 2026-07-23T13:20:47+08:00
```

## Final Cleanup
```
MAC_FINAL_CLEANUP_START 2026-07-23T13:21:23+08:00
MAC_FINAL_CLEANUP_OK exists=0 2026-07-23T13:21:23+08:00
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   234Gi   653Gi    27%    655k  6.8G    0%   /System/Volumes/Data
```

## Windows Disk
```
Name          Used         Free Root
----          ----         ---- ----
C     255733755904  65405222912 C:\
D     470183141376   9902133248 D:\
G    1362025062400 686049718272 G:\
```

## Duration / Windows Cleanup
elapsedSecondsApprox: 122
stageSeconds: discovery=110, export-unfiltered=10
G temp dir exists after cleanup: false
worker-started marker kept: true
