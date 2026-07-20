# 发布规范与复盘记录

本文件记录 daily-song-list 的发布方式、加速策略和失败复盘。遇到更快、更稳的方式时，直接补充到本文件；遇到失败时，记录失败入口、症状、根因、避免再犯的规则。

## 发布分层

### 代码 / UI / 配置热修

目标是尽快让用户看到行为修复。

1. 只提交源码、配置、测试和必要文档。
2. 保持瘦提交：不提交本地全量 `data/ui/**` runtime 分片、`data/catalog-segments/**`、`data/review/sources/**` 缓存、`artifacts/**`、`work/**` 或 Python `__pycache__`。
3. 不把本地 `data/latest.json`、range JSON、review queue/source cache 当作线上当前事实；需要线上判断时查 GitHub Actions、目标 URL、`/api/meta` 或 VPS2 日志。
4. 本地最少验证：
   - `node scripts/check-js-syntax.js`
   - `npm run test:db`
   - 涉及 UI 时追加相关 `node --test test/*ui*.test.js test/frontend-utils.test.js test/app-static-performance.test.js`
5. push 到 `main` 后让 `Deploy SQLite runtime DB` 在 GitHub Actions 构建并部署 SQLite。
6. 线上验收以 `/api/meta.source_commit_sha`、HTTP 状态、关键查询和页面交互为准，不用本地文件当线上事实。

### 来源补漏 / 数据批次

目标是让来源增量可追踪、可回滚、可分批发布。

1. 来源抓取先产出 accepted manifest 和每频道 imported / skipped / failed 状态。
2. 每批只合入已经可验收的 accepted JSON 和必要 channel metadata；未完成频道留给下一批。
3. `skipped` 只能代表我们已用 YouTube 自扫或人工记录确认过；VSinger Moment 数据、Moment 命中、旧在线样本都不算“已收录”依据。
4. 新来源批次必须记录：
   - 频道 URL / handle；
   - imported、skipped、failed；
   - 新增 video、occurrence、unique song；
   - published time 覆盖率；
   - 使用的本机或 VPS；
   - 远端临时目录清理结果和 `df -h`。
5. 不把远端 raw cache、checkpoint、review cache、临时脚本或 credentials 提交进仓库。

### 完整 runtime / DB 构建

目标是生产可用，不追求本地推大文件。

1. 常规路径：GitHub Actions 构建 `artifacts/runtime/song-rank.sqlite`，用 `rsync --inplace --partial --compress` 上传候选 DB 到 VPS2。
2. VPS2 激活脚本先校验 sha256 和 smoke query，再原子替换 active DB 并重启 `song-rank-api`。
3. 本地 Windows 可以做功能验证，但不作为完整生产构建的主要机器。

## 2 GiB VPS2 结论

2 GiB VPS2 适合：

- 跑 `song-rank-api`；
- nginx / systemd 托管；
- 接收 GitHub Actions 构建好的 SQLite；
- 执行候选 DB 激活、健康检查和少量 smoke query；
- 手动同步代码并重启已有 DB。

2 GiB VPS2 不适合：

- 常规全量 `npm run db:build`；
- 全量 `npm run update:core`；
- 生成和压缩海量 runtime 分片；
- 多路 YouTube 抓取或 VSinger 大批次回填；
- 同时承担 API 服务和重型构建。

实操结论：生产 2 GiB 可以继续用作运行节点，但构建应放在 GitHub Actions 或更大非雨云临时机器。除非换到更大内存主机，不要启用 `BUILD_DB_ON_VPS=1` 的定时构建。

## 加速规则

1. 优先瘦提交：代码/UI 热修不带全量生成产物。
2. 把生成产物交给 CI：让部署 workflow 在干净 checkout 上重建 DB。
3. 分批来源：谁先有完整 manifest 谁先合，未完成频道不阻塞其他批次。
4. 避免海量小文件进 commit：`data/review/sources/**`、`data/ui/**` 分片只有在明确需要静态 runtime 发布时才纳入。
5. 发布前先看 `git diff --stat`，发现几千个 JSON 或几 GB 改动时，先拆分。
6. 失败时不要盲目重跑上传：先确认失败发生在 build、artifact verification、upload、activate 还是 public verification。
7. 每日快照 workflow 保留保守抓取预算和顺序视频抓取；优化优先做 summary、缓存、重试和失败定位，不把预算调到激进值。
8. backfill inbox 只提交不可变 bundle；不要顺手提交 `data/ui/**`、`data/review/sources/**` 或本地 review queue。

## GitHub Actions handoff

- `Update core song-list data` 是高频轻量入口，目标是刷新 compact/runtime source 数据并把关键运行参数写入 step summary。
- `Prepare backfill inbox bundle` 是低频补漏入口，只准备 `data/backfill-inbox`，不承担完整 DB/runtime 发布。
- `Deploy SQLite runtime DB` 负责完整 SQLite 构建、artifact 校验、rsync 上传、VPS2 激活和公开验证；不要把这个工作迁回 2 GiB VPS2。
- 如果 core/backfill 失败，先在失败记录里写清阶段：sync、fetch/update、restore failure marker、commit/rebase/push、DB build、artifact verify、upload、activate、public verify。
- 如果 deploy 被较新的 run 取消，先查最新 successful deploy 和 `/api/meta.source_commit_sha`；不要用取消的旧 run 判断线上 stale。

## 失败处理

每次失败追加一条记录，格式如下：

```text
日期:
目标 commit:
入口: 本地 / GitHub Actions / VPS2 manual
失败阶段: build / verify artifact / upload / activate / public verify / check-code
症状:
根因:
是否影响线上:
已采取修复:
以后避免:
```

已知经验：

- `Verify runtime API artifact` 失败时，候选 DB 尚未上传或激活，不要手动碰 VPS2 active DB；先修 API 查询或检查脚本。
- deploy workflow 被较新的 run 取消时通常正常；以最新 successful deploy 和 `/api/meta.source_commit_sha` 为准。
- `Check code` 失败不等同于线上 stale；deploy green 且线上 commit 匹配才是上线事实。
- 本地生成的 runtime 分片和 review 缓存混进提交，会显著拖慢 push、checkout、diff 和 Actions。
- 2 GiB VPS2 只做运行、候选 DB 激活、健康检查和少量 smoke query；全量 DB build、runtime 分片生成和重型抓取放 GitHub Actions 或更大机器。
