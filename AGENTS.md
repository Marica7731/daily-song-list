# AGENTS.md

这份文件告诉维护者怎样安全地清洗和发布歌曲数据。改动前先读一遍。

## 先记住

- 用项目已有的 GitHub Actions 和发布步骤。不要把仓库搬到 VPS，也不要下载完整 Git 历史。
- 命令要有超时：普通检查 10–30 秒，测试约 60 秒，远程检查约 30 秒。不要无限等待。
- 不要猜这个项目用了哪个模型或付费计划。只有检查到实际运行配置或调用记录，才能这样说明。

## 保护数据和配置

1. `data/static/v1/days/**` 是原始历史，不能改写或删除。
2. 不要直接改写 `data/static/v1/state.json`。
3. 不要删除或改名配置、规则、workflow、原始数据或项目目录。只改完成当前任务需要的文件。
4. 不要重写 Git 历史、做 orphan reset、强推或删除分支。仓库变大时先检查原因；只有用户在这次任务里明确同意，才可以考虑重写历史。
5. 不要提交重新生成的榜单、搜索索引、实体页或 review-source 镜像。它们是可以重新生成的结果。

## 清洗歌曲

- 歌手目录在 `config/artist-catalogs/**`。发布前必须通过官方歌曲数量检查。
- 只把确认过的歌名和别名改成目录里的正式写法。
- 有明确歌手、但不在目录里的内容，可以按现有规则放进 `quality-artist-archive.json`；这是整理记录，不是原始历史。
- 只有歌名、没有歌手的有效歌曲不能因为同一来源里有很多歌手而删掉。
- 只删除明确不是歌曲的内容，例如章节、日期、聊天或活动文字。拿不准就保留，不要猜。

## 固定数据和定时工作

- `data/static/v1` 只保存原始来源和控制状态：`days`、`state.json`、`imports`、`recovery`。
- 衍生页面和索引由 `npm run static:rebuild` 生成，不要让数据 workflow 提交这些结果。
- 脏数据维护按定期清理任务执行，不跟每次 freshness 巡检一起跑。要清理时，先运行 `npm run static:rebuild`，再运行 `scripts/static/export-static-dirty-review.js`，最后运行 `scripts/static/heartbeat-dirty-batch.js`。
- 每次脏数据批次最多处理 25 个明确选中的项目，并轮换检查当前记录和历史记录里的确认噪声、解析损坏记录，不要总盯着最新几天。
- 零歌曲不代表视频已处理完。按 `scripts/static/no-song-retry.js` 的间隔继续重试；不能把它加入 `processedVideoIds`，也不能从重试池移走。
- 待处理视频要一直能继续。超过 500 条时，每批最多 120 条；连续 96 轮后最多等 600 秒，再开新一轮。不能因为轮数到顶就永久停住。
- 待处理视频比历史修复更急。超过 500 条时先继续收集，暂停修复；降到 500 条或以下才可以恢复修复。
- GitHub 的 hourly `static-update` 和 15 分钟 freshness watchdog 都可能漏跑。轻量心跳检查最新成功的 `static-update` 和待处理数量；如果成功时间已超过 90 分钟、仍有待处理视频且没有活跃更新，调用现有 `static-freshness-watchdog.yml` 的 `workflow_dispatch`，让它按现有逻辑决定是否重新启动收集。
- `.github/dirty-heartbeat.trigger` 的 push 会同时启动 freshness watchdog 和 `heartbeat-dirty-data.yml` 脏数据批次。不要把它当成单纯的重试按钮；只有要实际执行一次有界脏数据清理时才更新并 push 这个标记。不要另造 workflow。

## 发布和验收

正常发布顺序是：

1. `Check code` 通过。
2. 按现有 heartbeat、恢复和静态更新步骤处理数据。
3. Pages 发布完成。
4. 检查真实网站的 meta、清单、分页和实体详情。

线上检查要跟随自定义域名跳转，并把完整线上 `meta.json` 和发布 commit 的文件比较；只忽略 Pages 自动重写的 `generatedAt` 字段。只比较时间不够。
如果另一次 Pages 发布覆盖了本次发布，只有确认它是包含本次数据 commit 的后续 commit，才能用它验收。自定义域名返回 521/525 时，先检查 Pages 部署和 commit；不能只因边缘节点报错就说数据发布失败。

- 用项目已有的检查和发布门禁。不要增加与任务无关的审批步骤，挡住已经通过检查的正常发布。
- 如果原有检查失败，修复真实问题后再走原发布流程。

## 历史和文档

- 详细的运行结果写在 `docs/heartbeat-log.md`，不要放进本文件。
- 本文件只写长期有效的规则和入口。不要写时间、run id、提交 SHA、队列数字或临时故障。
- 删除、重置或改写历史都不是例行维护，也没有预先批准。需要时必须先取得用户对这次具体操作的明确同意，并准备好可恢复的办法。
