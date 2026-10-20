# Range 迁移说明

当前核心范围已经迁移为 `7d` 和 `all`。`72h` 与 `1m` 只保留为旧链接、旧数据入口和旧分享 URL 的兼容 alias。

## 当前范围

- `7d`：默认范围，固定使用视频发布时间的最近 7 天窗口。
- `all`：全量累计范围，来自永久视频 catalog，不再受月度搜索窗口限制。
- `72h -> 7d`：旧 URL、旧 JSON 路径和旧 diff 概念的兼容入口。
- `1m -> all`：旧 URL、旧 JSON 路径和旧 diff 概念的兼容入口。

## 已落地门禁

1. `scripts/build-runtime-data.js` 写入 `data/ui/meta.json.ranges.7d/all`。
2. `assets/app.js` 的 range tab、URL state、prefetch、diff load、fallback load 全部接受 canonical range，并把旧 range 参数规范化。
3. `check-published-runtime.js` 覆盖 canonical range、legacy alias、runtime 分片、source-detail 分片和 search 分片。
4. 分片 runtime 使用 manifest、page index、content hash 和 fallback 路径绑定。
5. 发布后必须用真实 `data/ui/meta.json`、range payload、页面 range tab 和线上 `check:published` 验证。

## Proof 覆盖

当前 proof 覆盖迁移后的架构：

- 截图：`desktop-range-7d.png`、`desktop-range-all.png`、`desktop-partition-pagination.png`、`desktop-search-snapshot-index.png`。
- 配置：`scripts/ui-proof-config.js` 的 `proofCoverage.rangeFixtures`。
- 校验：`scripts/validate-ui-proof.js` 会检查截图 manifest 中 scene、viewport 和 URL params。
- 测试：`test/ui-proof-fixtures.test.js` 验证 `parseUrlState` 的旧 range 兼容和当前 runtime path 形态。

## 风险

- `all` 不应回退到一次性加载完整历史；首屏必须优先走分片 manifest 和第一页。
- 旧 URL 兼容必须继续输出 canonical URL state，避免旧分享链接把 UI 带回过期 range。
- 新增 range、diff 或分片字段时，需要同步 `validate-data.js`、`check-runtime-budgets.js`、`check-published-runtime.js` 和截图 proof。
