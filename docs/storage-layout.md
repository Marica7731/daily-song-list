# 存储布局

本文只描述仓库内生成文件和浏览器 runtime 的职责边界。线上当前状态必须通过发布 URL、GitHub Actions、`check:published` 或实际 HTTP 查询确认，不能仅凭本地文件判断。

## 公开 runtime

- `data/ui/meta.json`：浏览器入口。包含 `dataVersion`、range 文件路径、range hash、item count、status 摘要、catalog 摘要、外部来源摘要、diff 路径和各 shard manifest 摘要；分页列表保留在对应 manifest 文件内。
- `data/ui/7d.<hash>.json`、`data/ui/all.<hash>.json`：内容 hash range payload，保留给 fallback 和兼容校验。
- `data/ui/7d.json`、`data/ui/all.json`：legacy fallback，适合 `no-cache` 校验。
- `data/ui/ranges/<range>/manifest.<hash>.json` 与 `page-*.json`：榜单 runtime 分片。浏览器首屏只需要读取当前 range 的 manifest 和第一页。
- `data/ui/source-details/<range>/manifest.<hash>.json` 与 `page-*.json`：展开来源详情分片，按需读取。
- `data/ui/search/<range>/manifest.<hash>.json` 与 `page-*.json`：搜索/筛选索引分片，查询面板按需读取。
- `data/diff/latest-7d.json`、`data/diff/latest-all.json`：最新榜单趋势 diff，首屏榜单渲染后再加载。
- `data/status.json`：调度状态和失败信息。

## 生成与审核数据

- `data/latest.json`：完整最新 payload，供派生数据、审核和 fallback 使用。
- `data/7d.json`、`data/all.json`：完整 canonical range group 文件。
- `data/72h.json`、`data/1m.json`：旧 range 的 alias manifest，分别指向 `7d` 与 `all`。
- `data/audit.json`：抓取、解析、拒绝和 curation 审计。
- `data/review/*`：本地/离线审核队列，不由主页加载。
- `data/quality-report.json`：质量报告。
- `data/video-catalog.json` 与 `data/catalog-segments/*.json`：永久视频目录和目录分段。

## 快照

- `data/snapshots/index.json`：快照索引，按新到旧组织历史快照入口。
- `data/snapshots/index/YYYY/MM.json`：永久快照索引分片，避免根索引无限膨胀。
- `data/snapshots/<hour>.json`：不可变小时快照。浏览器可以缓存具体快照 JSON，但索引需要随发布刷新。

## 分片契约

`test/fixtures/ui-proof-runtime.json` 的 `dataIndexCase.partitions` 记录当前分片命名形态：

- `data/ui/ranges/7d/page-0012.<hash>.json`
- `data/ui/ranges/all/page-0017.<hash>.json`

当前真实输出位于 `data/ui/ranges/<range>/`、`data/ui/source-details/<range>/` 和 `data/ui/search/<range>/`。每个分片族都有 manifest 来绑定 range、pageSize、pageCount、page hash、搜索索引版本和 fallback 策略；`data/ui/meta.json` 只保存这些 manifest 的路径、hash 和计数摘要，`check:published` 会抽样验证线上 manifest 与分片页。

## UI Proof 存储

- `docs/assets/screenshots/*.png`：README 和 `docs/ui-proof.md` 引用的 committed proof 截图。
- `docs/assets/screenshots/manifest.json`：截图 hash、尺寸、viewport、URL params、selector、proof input hash。
- `scripts/ui-proof-config.js`：截图清单、proof 输入和 fixture contract。
- `scripts/validate-ui-proof.js`：校验 manifest 与当前 proof 输入是否匹配。
