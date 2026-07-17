# ADR: request-priority-v2 浏览器请求调度器

## 状态

Accepted for implementation on `perf/request-priority-v2`.

## 背景

移动网络下，下一页预取、搜索索引预热、来源详情、缩略图和当前页面摘要可能同时触发 `fetch`。如果这些请求没有统一调度，低价值预取会占住连接，用户点击来源、分页、筛选或搜索时需要等待已经开始的预取完成。

本分支只建立独立调度器，不修改 `assets/app.js`、入口 HTML、来源分片格式或数据生成逻辑。来源分片仍由 `perf/source-entity-shards-v3` 负责。

## 决策

新增 `assets/request-scheduler.js`，用 UMD 形式同时支持浏览器全局对象和 Node 测试。浏览器侧暴露：

- `window.RequestScheduler`
- `window.dailySongRequestScheduler`
- `window.printRequestSchedulerStats()`

核心 API：

```js
const scheduler = RequestScheduler.createRequestScheduler();

const pageRevision = scheduler.bumpRevision("page");
const result = await scheduler.requestResource({
  key: "range:7d:page:0002",
  url: "data/ui/ranges/7d/views/default/page-0002.hash.json",
  priority: RequestScheduler.PRIORITIES.USER_BLOCKING,
  revision: pageRevision,
  cacheMode: "force-cache",
  parser: (response) => response.json(),
});

if (result.status === "success") {
  render(result.data);
}
```

## 优先级与并发

调度器支持三档优先级：

- `user-blocking`: 用户点击查看全部来源、分页、应用筛选、搜索、复制歌单、切换范围或视图。
- `normal`: 当前页面摘要、小型索引、当前可见缩略图。
- `idle`: 上一页/下一页预取、其他范围预热、搜索索引预热、非可见缩略图、后续来源 chunk。

默认并发：

- `user-blocking`: 3
- `normal`: 2
- `idle`: 1

`idle` 只有在没有 `user-blocking` 和 `normal` 活跃请求时才启动。发生新的 `user-blocking` 请求时，调度器会立即 abort 活跃或排队中的可抢占 `idle` 请求，释放并发槽后启动用户请求。同一个 `key`/`url` 的请求会去重并共享同一个 Promise。

## 网络感知

调度器读取 `navigator.connection.saveData`、`effectiveType` 和 `downlink`。不支持 Network Information API 时使用安全默认值：允许调度，但 `idle` 仍保持单并发且可被抢占。

规则：

- `saveData=true`: 禁用自动预取。
- `slow-2g` 或 `2g`: 禁用自动预取，调低用户和普通请求并发，后续来源 chunk 只能由显式滚动加载触发。
- `3g`: `idle` 只保留单并发。
- `4g`: 空闲时允许预取相邻页，但用户请求仍会抢占。

## 空闲预取

调用 `scheduleIdlePrefetch()` 时，预取必须同时满足：

- 当前主请求完成。
- 查询面板未打开。
- 没有正在输入搜索。
- 没有来源详情加载。
- `document.visibilityState === "visible"`。
- 浏览器进入 idle。
- `saveData` 未启用。

调度器优先使用 `scheduler.postTask({ priority: "background" })`，回退到 `requestIdleCallback`，再回退到 `setTimeout`。自动预取只接受 `prefetchKind: "previous-page"` 或 `"next-page"`，禁止预取所有页。

## Revision 与取消

调度器维护四类推荐 revision：

- `page`
- `query`
- `source`
- `range`

集成方在用户动作开始时调用 `bumpRevision(scope)`，把返回值传给 `requestResource({ revision })`。响应完成时如果 revision 已过期，结果返回 `status: "stale"`，调用方不得应用该响应。

支持外部 `AbortSignal`。用户取消、切换上下文或组件卸载时，集成方可以传入自己的 `AbortController.signal`，调度器会统一记录 `abortReason`。

## 缓存、重试与遥测

默认会缓存成功响应。`cacheMode: "no-store"` 或 `"reload"` 会绕过缓存。请求失败时可通过 `retries` 配置重试次数。

遥测记录字段：

- `queuedAt`
- `startedAt`
- `completedAt`
- `abortedAt`
- `priority`
- `queueDelay`
- `transferSize`
- `decodedBodySize`
- `duration`
- `cacheHit`
- `abortReason`

`window.printRequestSchedulerStats()` 返回只读快照，并在支持时用 `console.table` 输出，不在生产界面显示任何调试信息。

## app.js 集成点

后续集成分支应在 `assets/app.js` 的这些位置接入：

- 统一 JSON 请求入口：把现有 `fetch`/`readCachedRequestJson` 包装为 `scheduler.requestResource()`。
- 分页与范围切换：用户点击页码或切换范围时 bump `page`/`range` revision，并使用 `user-blocking`。
- 查询面板与搜索：应用筛选或输入搜索时 bump `query` revision，并使用 `user-blocking`。
- 来源详情：打开全部来源时 bump `source` revision，首 chunk 使用 `user-blocking`，后续 chunk 由滚动显式触发。
- 相邻页预取：只通过 `scheduleIdlePrefetch()` 请求上一页和下一页。
- 缩略图：可见缩略图使用 `normal`，非可见缩略图使用 `idle`，并允许被用户请求抢占。

## 验证

新增测试：

- `node --test test/request-scheduler.test.js`

覆盖抢占、快速分页、快速搜索、搜索后切范围、去重、旧响应 stale、saveData、2g、3g、页面隐藏、失败重试、用户取消和缓存命中。

新增 benchmark：

- `node scripts/benchmark-request-scheduler.js`

模拟 1.5MB 预取、80KB 来源首 chunk、200KB 页码详情和 50KB 搜索分片。结果必须证明用户点击来源时预取被中止，来源请求立即获得请求槽，并显著快于无调度器 FIFO 基线。

## 仍存在的问题

- 本分支没有修改 `index.html`，因此新资产不会自动进入页面。
- 本分支没有修改 `assets/app.js`，实际业务请求仍需后续集成分支接入。
- 后续集成时需要根据真实 UI 状态传入 `queryPanelOpen`、`searchTyping`、`sourceDetailLoading` 和 `mainRequestActive`。
- 浏览器 PerformanceResourceTiming 的精确 `transferSize` 需要集成分支按 URL 关联，当前独立调度器优先使用 `content-length` 或解析后估算。
