# 2026-07-23-source-backfill-batch123-ucrf92d-continuation

- channel: https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw
- status: partial_artifact_ready
- strategy: bounded partial shard only; no full discovery/import marker
- probe candidates: 113
- partial inspected: 15
- usable videos before dirty audit: 6
- accepted videos after dirty audit: 6
- accepted occurrences/songs after dirty audit: 113
- reachedEndAllTabs: false
- failureReason: partial_checkpoint_reached_end_false;bounded_shard0of8_only;not_imported

## Dirty Audit
- hard dropped videos: 0
- suspicious-only videos: 1

## Accepted Videos
- YR05aqjl3pA | songs=12 | 弾き語り配信｜初見さんも大歓迎です！（2026/6/13アーカイブ）
- cYI3x_dpybM | songs=17 | 【旅行の思い出／映画トーク／ライブ告知】弾き語り配信（2026/4/4アーカイブ）
- PDvrfy8kXaY | songs=27 | 【リリース情報/新曲/結婚】弾き語り配信（2026/2/14アーカイブ）
- T1mGGARi_fU | songs=29 | 【2026/1/10アーカイブ】弾き語り配信🎹
- dZnlfB7dO2s | songs=27 | 【2025/12/13アーカイブ】弾き語り配信🎹
- LS332UnockQ | songs=1 | 【女子大生が歌ってみた】やさしさに包まれたなら / 松任谷由実

## Markers
- export-partial.log: CODEX_TIMEOUT_WRAPPER_START timeoutSeconds=300 command=['npm', 'run', 'youtube:export-channel-increment', '--', '--output', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/accepted/2026-07-23-source-backfill-batch123-ucrf92d-continuation.partial.accepted.json', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/partial-shard0of8']
- export-partial.log: CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=1 readVideos=6 usableVideos=6 acceptedVideos=6 skippedRegressions=0 occurrences=113 output="/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/accepted/2026-07-23-source-backfill-batch123-ucrf92d-continuation.partial.accepted.json"
- export-partial.log: CODEX_TIMEOUT_WRAPPER_EXIT code=0
- partial-shard0of8.log: CODEX_TIMEOUT_WRAPPER_START timeoutSeconds=1200 command=['npm', 'run', 'youtube:discover-channel', '--', '--channel-url', 'https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw', '--singer-name', 'UCrF92dEkXiTtexol0yg4Gmw', '--output-dir', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/partial-shard0of8', '--cache-dir', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/cache', '--max-channel-pages', '5', '--max-candidates', '113', '--max-inspect', '15', '--inspect-shard-index', '0', '--inspect-shard-count', '8', '--request-interval-ms', '750', '--request-jitter-ms', '250']
- partial-shard0of8.log: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw" candidates=113 inspected=15 videos=6 occurrences=113 elapsedSeconds=96 outputDir="/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/partial-shard0of8"
- partial-shard0of8.log: CODEX_TIMEOUT_WRAPPER_EXIT code=0
- probe.log: CODEX_TIMEOUT_WRAPPER_START timeoutSeconds=300 command=['npm', 'run', 'youtube:discover-channel', '--', '--channel-url', 'https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw', '--singer-name', 'UCrF92dEkXiTtexol0yg4Gmw', '--output-dir', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/probe', '--cache-dir', '/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/cache', '--max-channel-pages', '5', '--max-candidates', '120', '--max-inspect', '0', '--candidate-only', '--fresh', '--request-interval-ms', '500', '--request-jitter-ms', '100']
- probe.log: CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK channel="https://www.youtube.com/channel/UCrF92dEkXiTtexol0yg4Gmw" candidates=113 inspected=0 videos=0 occurrences=0 elapsedSeconds=14 outputDir="/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation/probe"
- probe.log: CODEX_TIMEOUT_WRAPPER_EXIT code=0

## Remote Cleanup
- CODEX_CLEANUP_OK path=/tmp/ytb-song-rank-source-backfill-20260720/batch123-ucrf92d-continuation
- df before:

```text
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   335Gi   552Gi    38%    710k  5.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   335Gi   552Gi    38%    710k  5.8G    0%   /System/Volumes/Data
```
- df after:

```text
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   926Gi   335Gi   552Gi    38%    710k  5.8G    0%   /System/Volumes/Data
/dev/disk3s5   926Gi   335Gi   552Gi    38%    710k  5.8G    0%   /System/Volumes/Data
```
