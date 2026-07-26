# daily-song-list 主线：增量数据库与安全发布迁移

## 目标

在唯一正式入口 `G:\codex-work\daily-song-list` 完成可审计的数据库/发布架构迁移，并在迁移完成前保持当前 active 版本可服务。目标链路是：增量 upsert -> 候选版本构建与校验 -> active 原子切换 -> 可验证 rollback -> 真实线上验收。

## 当前阶段

2026-07-27：主线接手后已完成取消旧 SQLite run、Mac 空间/残留核验和精确 cache 清理；已进入 `implementation-write` 的本地/runner ephemeral PG 迁移链路。仓库当前存在约 32 万条接手前 staged deletion（含历史生成数据和旧 `CODEX_GOAL.md`），本轮不得恢复、清理或扩大这批删除。生产 PostgreSQL target/DSN 仍缺失，故生产迁移尚未开始；本地链路必须先证明可运行。

## 迁移优先时间表（有界，不承诺固定总时长）

- 现在至 30 分钟：取消旧 run 后完成有界 preflight，建立 Mac 专属 temp root；确认 runner/Mac 空间、当前线上 active 和生产 target/DSN。没有生产目标不阻断本地链路，但不得声称生产迁移。
- 30–90 分钟：在不复制 SQLite 的前提下实现并测试最小增量链路：schema、upsert、compare、rollback、active/candidate、healthz；禁止改已上线前端。
- 90 分钟–3 小时：仅在 Mac 单一临时目录做小样本/29 份歌单迁移 dry-run 和 handle 解析；只写候选/测试库，不碰生产，必须有 manifest、checkpoint、空间峰值证据；失败或空间不足立即清理并停止。
- 3–5 小时：完成 focused tests、事务 upsert、回滚和候选切换验证；只有真实 DSN、旧 active 可继续服务、compare/health 全绿才接入发布 workflow。
- 5–7 小时：先发布一小批候选或 staging，线上验证 healthz/meta/rankings/版本身份；发布若仍需全量重建或超过 30–60 分钟，回到架构问题，不把清洗塞进长任务。
- 迁移链路通过后，才用同一增量入口发布 Naraetan/Ado/`辛いことがある人生でも` 等清洗规则；清洗目标为分钟到几十分钟，不接受 9 小时无结果。

设备职责：Mac 负责数据库迁移基准、长测试、source build（先空间 preflight、单临时目录、checkpoint/manifest、上限和结束清理）；WDC 只做来源多 IP relay/受控请求；culua 只读探针/小型服务验证；Windows/G 负责协调、短测试、Git/审查，不跑全库构建。

## 空间与清理门禁

- 每个任务开始前必须在 Mac 建立任务专属 temp root，并记录 baseline free、输入/active bytes、预计峰值、硬上限、允许保留的 artifact；中间产物不得散落在仓库、用户目录或 VPS。
- 当前 active SQLite 约 14.8 GB；任何复制、Git pack、WAL、索引和临时文件都必须逐项解释。10 份同等副本约 148 GB；若增长超过预计峰值 20%、连续无有效进展，或出现第二份完整 DB/candidate/backup，立即 pause。
- 触发异常时严格执行 pause -> identify PID/path -> bounded cleanup -> remeasure；不能只停进程留下残留，也不能换盘继续写。Mac 迁移禁止并发 full SQLite copies；VPS 仍只做多 IP relay，不存数据库。
- 长任务必须有 success/failure/timeout cleanup trap：先停止本任务 PID、等待释放句柄，删除本任务 temp root、临时 pack、WAL、candidate 和重复 clone；只保留 checkpoint/manifest/小型报告。清理失败要列出精确路径/PID并继续清理安全部分。
- 清理后必须记录 before/after bytes、free space、保留文件清单和任务状态；没有 cleanup evidence 不得称失败处理完或完成。

接手教训：全量 SQLite 候选替换曾使清洗结果无法上线；`b8b84dcecd`、`678258decb`、`5af7c37c10` 只是草案，尚无真实 DSN、生产服务或主 workflow 接入。来源抓取曾写满 VPS，重抓取/全库构建/长期 raw 或 clone 不得放 VPS；culua 小水管不能承载重任务；日期 worktree/partial data 不得合并全量生成 data。

## 旧会话事项核销（2026-07-27 实时状态）

### A. 频道身份/清洗主线

- `curation_ready_pending_release`：全库 singleton/unknown-artist 审计主体、保守 drop/merge 规则与 artifact/证据已具备；尚未经新增量入口发布，禁止删除、回滚或重跑全库清洗。
- `curation_ready_pending_release`：Naraetan、Ado `逆光`、`辛いことがある人生でも`、`うら飯紺汰` 原创 `リスタート` 与凛々咲同名曲规则主体已具备；迁移候选链路通过后立即接入发布和线上验收，不再扩大清洗。
- `done`：`フィナーレ。`/两视频异常已由前序执行会话修复并上线；不再审计、修改或回滚。
- `done`：已上线前端歌曲数显示修复、样式/渲染结构、API 字段语义与收录 tag 已由前序执行会话确认；前端 code/style/schema contract frozen，不重做 UI/API/search/collection-tag。后端数据与频道歌曲数、歌曲数、视频数、次数可随迁移/清洗正常变化，本轮只不改前端结构。
- `done`：7d 数据已由前序发布进入总量；当前线上 `https://ytb-song-rank.culua.com/api/meta` HTTP 200，active `source_commit_sha=fb0dea42fc9e1d15e499b8a10967c1829cf0f60b`，本轮不再审计、修改或回滚该项。
- `done`：旧 D 盘 worktree、日期目录和生成 data 未作为入口；本轮只使用本文件所在正式仓库。

### B. うら飯紺汰来源会话

- `pending`：旧 clone 在约 1%/0.8 GiB 时未完成；本轮未续用，也未把它当作来源结果。
- `pending`：旧 FETCH_HEAD、package.json、checkpoint、manifest、accepted increment 未形成；需来源时重新按 relay + Mac checkpoint 方案评估。
- `pending`：discovery、详情抓取、原始证据审计、导入和线上验证均未完成；当前迁移优先，不启动来源任务。
- `done`：不续用 VPS clone；VPS（含 WDC）默认仅作受控来源 relay，禁止 clone/数据库/candidate/backup/raw 长期存储。

### C. 迁移交接

- `blocked`：生产 PostgreSQL 只有草案；实时仓库/ GitHub repo secret、variable、environment 均未发现真实 DSN、生产服务或容量证据（仅 secret `VPS2_PASSWORD`、variable `DAILY_SONG_REQUIRE_PUBLISHED_API=1`、environment `github-pages`）。生产迁移未开始；不在空项目、VPS 或完整 clone 上耗时，但本地/runner ephemeral PG 链路继续执行。
- `done`：已确认 `deploy-runtime-db.yml` 仍以 Mac 全量构建 SQLite、通过 artifact/SSH 上传至 VPS2 的 `song-rank.sqlite` 为中心；这正是待替换的架构，不视为增量迁移。
- `pending`：端到端小样本导入、compare、rollback、candidate/active 切换和线上健康证据尚不存在。
- `pending`：29 份歌单的 channel handle 解析、可视化/脚本化 upsert 尚未交付。
- `done`：curation/release 分支的中断合并未恢复；禁止合并全量生成 data。
- `pending`：C/D/G/Mac 存储清单与回收规则部分完成；G 盘、正式仓库、Mac 空间/runner/cache、culua 盘和本机残留进程已有证据，WDC/VPS2 角色与空间仍缺可复核 SSH 证据；不以子任务未完成报告代替清理验收。

### 迁移可行性判定（阶段 0）

- `blocked`：生产迁移仍受「真实 PostgreSQL target/DSN 注入路径」阻塞；Mac runner 已释放并通过只读 SSH preflight，`bedeMacBook-Air.local` 数据盘 926 GiB、可用约 445 GiB，无 build/clone/fetch/yt-dlp 进程。ephemeral temp root `/tmp/daily-song-list-pg-migration.vi8WS5` 已建立，baseline free `492773130240` bytes、expected peak `536870912` bytes、hard cap `2147483648` bytes；本地链路不得突破上限。
- `done`：旧全量 run `30213710452` 已按授权取消；job `89824129428` 的构建 cancelled，manifest/上传/activate/health/API 均 skipped，runner 已 `online/busy=false`，未改生产数据。
- `done`：旧 active 保留方案已被实时验证为当前线上 SQLite runtime 仍可服务：`https://ytb-song-rank.culua.com/healthz` HTTP 200，`/api/meta` HTTP 200，active `source_commit_sha=fb0dea42fc9e1d15e499b8a10967c1829cf0f60b`；候选未 ready 前不切换。
- `blocked`：生产 target 缺口保留为外部阻塞；GitHub 只读核对仍只有 `VPS2_PASSWORD`、`DAILY_SONG_REQUIRE_PUBLISHED_API=1` 和 `github-pages`，没有 `DAILY_SONG_POSTGRES_DSN` 或 PG host/port/user 注入路径。不得把本地测试冒充生产迁移。
- `done`：同一 Mac 临时根目录 `/tmp/daily-song-list-pg-migration.vi8WS5` 已完成真实 PGlite schema/upsert/compare/rollback/active 测试（2/2 passed）和 SQLite NDJSON 流式小样本（1 video/3 occurrences）；fixture 仅 `20480` bytes，无完整 SQLite 复制。此次回归保留了两个相同 `seconds`、一个 `seconds=null`、三个不同 `occurrenceId`，并保留空字符串/NULL artist/sourceId/sourceSystem、range_id、song_key。任务 baseline free `481220472 KiB`，expected peak `536870912` bytes，hard cap `2147483648` bytes，stream root peak `107094016` bytes；cleanup `beforeBytes=107094016 afterBytes=0`、free `481115812 KiB -> 481221184 KiB`、retained `none`、status `success`。
- `done`：P1 数据契约已在 migration patch 修正：不再过滤 NULL seconds、不再以默认值覆盖空 artist/source_id/source_system、不再禁止重复 seconds；occurrence_id/position 作为稳定 identity；range/source/song/raw provenance 字段落列；视频删除使用显式 tombstone，解析不会继承已删除父行；activate/rollback 先锁 active state，并在切换时校验 candidate parent 等于当前 active。focused test 覆盖字段保持、tombstone、rollback 和并发候选 parent mismatch。
- `blocked`：当前仍只有数据库/候选原型，没有 PG-backed `/healthz`、`/api/meta`、`/api/rankings`、source-detail adapter，也没有真实生产 DSN；因此本轮结果是 `未可生产发布`。不触发 workflow、不切 active、不把旧 SQLite workflow 或 ephemeral PGlite 当生产迁移。

### 取消旧 SQLite run 的清理核验

- `done`：run `30213710452` 已取消且 runner 空闲；runner workspace 约 617 MiB，未发现 SQLite/WAL/pack/tmp/manifest 残留。精确清理旧 cache DB `14816280576` bytes 与 manifest `348` bytes；Data FS 可用 `466749772 KiB -> 481218864 KiB`，cache 保留文件为 none。另有两个旧 runlogs SQLite（约 9.76 GiB/份）不属于该 run，且 hotfix DB 被 PID 14215 使用，暂不触碰。

## 范围与硬约束

- 只使用 `G:\codex-work\daily-song-list`（WSL `/mnt/g/codex-work/daily-song-list`）；不创建 clone、日期目录或新 worktree，不使用 `D:\Projects\daily_song_list_dbapi`。
- 模式门禁：`audit-readonly` 只用于审计、盘点、定位和风险判断，报告必须指明下一执行会话、限定改动文件、发布入口和线上验收条件；用户目标涉及线上修复、来源、数据库或用户可见行为时必须接续 `implementation-write`。主会话负责最终 diff 审查、push、workflow、发布和线上验证；子任务不得扩大范围，也不得以只读阻断交付。
- 先只读核对仓库、进程、Mac/VPS/G 盘资源、远端与真实线上 API；不以旧截图、旧 commit、旧 run 或 UI 推断已上线。
- 不修改前端样式或已上线歌曲数修复；不重跑来源、不使用 `--fresh`、不并发写同一数据库/来源目录，不发飞书。
- `frontend code/style/schema contract frozen; data and backend counts may change normally`：迁移/清洗可以改变后端数据与统计数字，但不得修改前端布局、卡片、字体、分页控件、渲染结构或 API 字段语义。
- culua 只做有界只读探针；WDC 不构建数据库、不长期存 raw/clone、不写爆磁盘。
- 所有 VPS（含 WDC）只可做来源请求的多 IP 中继/受控抓取；禁止在 VPS clone、存放或构建 100GB 以上数据库，也禁止长期放完整 SQLite/PostgreSQL、candidate、backup、raw。迁移和数据库构建只能在 Mac self-hosted runner；产物只能经受控 artifact/增量协议传递。任何例外必须先给出定量空间预算、任务时长和回收动作并获用户确认，默认拒绝。
- 大型构建、来源抓取、全库扫描和长测试只允许 Mac self-hosted runner；每次任务必须先做空间 preflight，使用单一临时任务目录、checkpoint、manifest、空间上限和结束清理。
- Windows 只做 G 盘上的小型检查、协调和 focused tests；不复制全量 SQLite、不做无界扫描或重型构建。
- 候选未 ready/验证失败时不切生产；迁移或清洗期间线上不得以 502 作为正常方案。

## 阶段验收

1. 只读盘点输出仓库/分支/status、残留进程、远端、Mac/VPS/G 存储、真实线上 active/candidate/health 证据；明确迁移阻塞。
2. 确认真实增量目标、DSN 注入方式、schema、upsert、compare、rollback、candidate/active 切换入口；没有真实目标时明确缺口，不伪装已迁移。
3. focused tests、dry-run、小样本和失败保持旧 active 的回归验证通过。
4. 已审计的保守清洗规则通过增量路径发布；singleton 只作候选，证据不足保留/待审；Naraetan、`辛いことがある人生でも`、`逆光(ウタ from ONE PIECE FILM RED)`、`うら飯紺汰` 原创 `リスタート` 与凛々咲同名曲分离规则有证据。
5. commit、push、既有 workflow 发布成功；线上验证 healthz、meta、rankings、重点条目和 active/candidate 身份，记录时间、状态码、commit/run、计数、存储与失败证据。

## 当前下一步

1. 将当前限定 migration 写集和本文件提交到独立 `codex/pg-migration-prototype` 分支；不恢复 staged data、不改前端、不提交 workflow 草稿。
2. 真实 PG target/DSN 和 PG-backed API adapter 到位后，另行做候选发布；在此之前状态保持 `未可生产发布`，不触发生产 workflow。
3. 如继续推进，下一步必须先实现并单独测试兼容 API adapter，再做 staging/小批 candidate -> compare -> health/API -> activate；旧 active 仍需保持可服务。

## 交接记录

每次状态必须记录：工作树/分支、改动文件、测试、commit/push、发布 run、线上证据、Mac/WDC/G 存储、未完成项。只有真实线上切换和验收完成后才能将平台 goal 标记 complete；阻塞须同一外部条件连续三次且无安全替代路径。
