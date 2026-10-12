# Backfill 说明

Backfill 的目标是在有限 YouTube 请求预算内保持近期榜单新鲜，同时让全量历史 catalog 逐步补齐。当前实现面向 canonical `7d` 与 `all`；`72h/1m` 只作为旧入口兼容。

## 当前策略

- 增量运行优先复用上一份成功快照中仍新鲜、仍符合 curation/blocklist 的视频。
- 新检查队列优先扫描今天和前一天候选，再刷新少量 monthly-filter 候选。
- 当 catalog carry-forward 数量低于 `DAILY_SONG_MONTH_BACKFILL_TARGET` 时，近期 bucket 预留会降低，更多预算给 monthly-filter/catalog 候选。
- 上一次成功快照缺失或太旧时，进入 full recovery：扫描今天、前一天、前两天，再用 monthly-filter 候选填满预算。
- 被检查但没有可用歌曲的视频进入 inspection cache，按 TTL/retention 避免反复浪费请求。

## 相关入口

- `scripts/update-songlist.js`：抓取、队列选择、解析、合并和写完整 payload。
- `scripts/run-core-update.js`：core workflow 的运行入口。
- `scripts/rebuild-derived-data.js`：不抓 YouTube，只基于本地最新 payload 重建派生数据。
- `.github/workflows/update-core.yml`：线上 hourly core 更新流程。

## 环境变量

- `DAILY_SONG_VIDEO_LIMIT`：本轮最多检查的视频数量。
- `DAILY_SONG_RECENT_BUCKET_LIMIT`：近期 bucket 候选上限。
- `DAILY_SONG_MONTH_REFRESH_LIMIT`：carry-forward 活跃时刷新 monthly-filter 候选数量。
- `DAILY_SONG_MONTH_BACKFILL_TARGET`：月度 carry-forward 低于该值时提高 monthly-filter 优先级。
- `DAILY_SONG_MONTH_BACKFILL_RECENT_BUCKET_LIMIT`：backfill 活跃时每个近期 bucket 的更低上限。
- `DAILY_SONG_CARRY_FORWARD_MAX_AGE_HOURS`：允许 carry-forward 的上一成功快照最大年龄。

## 7d/all 要求

`7d/all` 的 backfill 不能只复制旧 `1m` 策略：

- `7d` 使用固定发布时间窗口，避免月度搜索结果把范围语义扩大。
- `all` 基于 catalog 和分片索引，不在每次 hourly run 重新扫描全历史。
- 分片页、搜索索引和快照索引要有独立 version/hash，避免某个分片更新后 meta 与索引不一致。
- 发布验证必须检查真实 `data/ui/meta.json`、至少一个 `7d` 分片、一个 `all` 分片、搜索索引和快照索引，而不是只看本地生成日志。

## Proof 覆盖

proof fixture 覆盖 backfill 相关 UI 契约：

- `desktop-range-7d.png`、`desktop-range-all.png`：当前 range 呈现。
- `desktop-partition-pagination.png`：分片分页路径和 page/pageCount。
- `desktop-search-snapshot-index.png`：query index key 与 snapshot index 新到旧顺序。
