# 数据架构

本文记录当前数据流、canonical range、永久快照和浏览器分片 runtime。当前线上/本地核心 runtime 生成 `7d` 与 `all`；`72h` 与 `1m` 只作为旧链接和旧文件入口的兼容 alias。

## 数据流

1. `scripts/update-songlist.js` 抓取 YouTube 搜索结果、检查视频页、解析 description/comment 中的时间戳歌单，并合并 carry-forward 数据。
2. `scripts/apply-song-search-niche.js` 用 `data/song-search-known-songs.json` 标记小众/已知歌曲。
3. `scripts/build-runtime-data.js` 读取完整生成结果，并在完整、零失败、已记录站长授权的情况下叠加 `data/external/vsinger-http/backfill/manifest.json`，再压缩为浏览器 runtime：
   - `data/ui/meta.json`
   - `data/ui/7d.<hash>.json`
   - `data/ui/all.<hash>.json`
   - `data/ui/7d.json` 与 `data/ui/all.json` legacy fallback
   - `data/ui/ranges/<range>/manifest.<hash>.json` 与分页 runtime
   - `data/ui/source-details/<range>/manifest.<hash>.json` 与按需来源详情页
   - `data/ui/search/<range>/manifest.<hash>.json` 与查询索引页
4. `assets/app.js` 先读 `data/ui/meta.json`，再按当前 range 读取分片 manifest 和当前页。快照由 `data/snapshots/index.json` 与 `data/snapshots/index/YYYY/MM.json` 提供索引，具体快照仍是独立 JSON。

## Runtime 边界

- 完整生成/审核数据保留在 `data/latest.json`、`data/7d.json`、`data/all.json`、`data/audit.json`、`data/review/*`。
- `data/72h.json` 与 `data/1m.json` 是 alias manifest，不再是完整 range group。
- 浏览器 runtime 只保留 UI 需要的字段：视频基础信息、歌曲标题/歌手、`seconds`、`isNiche`、`filterVersion`、`dataVersion`、blocklist 指纹。
- `data/ui/meta.json` 只保存 range、runtime/source-detail/search/request shard 的 manifest 摘要；分页列表留在各 shard manifest 中，避免首屏元数据随全量数据增长。
- `dataVersion` 绑定 meta、range payload、分片 manifest 和分片页；range/shard `sha256` 绑定 meta 与内容 hash 文件。
- 搜索、分页、来源展开和快照选择是前端派生状态，不应回写 runtime payload。

## UI Proof

`test/fixtures/ui-proof-runtime.json` 补充以下 proof 数据：

- `rangeCases.7d` 与 `rangeCases.all`：当前 range tab、runtime path、diff path 和 item count 契约。
- `sourceCases.double`：移动端 2 来源内联布局。
- `sourceCases.triple`：桌面/平板 3 来源 tail + copy-all 布局。
- `sourceCases.newToOld`：来源按 `publishedAt` 新到旧展示的截图 fixture。
- `dataIndexCase.partitions`：分片分页路径和 page/pageCount 契约。
- `dataIndexCase.searchIndexes`：前端 query index key 形态。
- `dataIndexCase.snapshotIndex`：`latest` 加历史快照新到旧顺序。

这些 fixture 与 committed 截图一起锁定当前 `7d/all`、分片 runtime、搜索索引和快照索引的 UI 验收线。
