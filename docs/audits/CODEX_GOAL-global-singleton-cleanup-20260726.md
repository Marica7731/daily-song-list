# daily-song-list：全库 singleton 与未记载歌手保守清洗

## 目标

在独立分支完成两类高风险数据的系统审计与首批高置信清洗：

1. occurrence 仅出现 1 次的歌曲；
2. `artist=未記載`、`未知` 或空值的歌曲；
3. `https://www.youtube.com/@YOSHIKA-Ch` 的专项 before/after；
4. 四个生产榜单页（occurrences/songs 各第 1、2 页）的全部频道及展开歌曲。

基线为 2026-07-26 实时 `origin/main`
`1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`。本地工作分支是
`codex/global-singleton-cleanup-20260726-clean`，交付时仅推送到远端
`codex/global-singleton-cleanup-20260726`。

## 硬范围

- 只在
  `/mnt/g/codex-work/daily-song-list-global-singleton-cleanup-20260726-v2`
  写入；临时产物只放 `/mnt/g/codex-work/tmp/`。
- 不触碰 `D:\Projects\daily_song_list_dbapi`、
  `daily-song-list-cleanup-upsert-20260726`、其他旧 G worktree、
  `.workbuddy/` 和前端 `assets/`。
- 只使用 WSL bash；大型 SQLite、全库扫描和高内存生成只在 Mac
  self-hosted runner 运行，命令有 timeout/checkpoint/manifest，不使用
  `--fresh`。
- singleton 与未知歌手只是候选，绝不按低频或未知歌手批量删除。
- 不手改生成 DB、静态页面或 runtime 数据，不 merge main，不部署。

## 数据决策规则

- 优先核对仓库原始 JSON/HTML/accepted provenance；公开外部证据只作辅助，
  搜索猜测不能直接写入生产。
- 仅非歌曲、杂谈或转场使用 `drop_entry`；错字、括号注释、feat 边界和同歌变体
  优先 `replace_entry` 或 song alias。
- 同标题多歌手时，优先 occurrence 较高的已知歌手，`未記載` 仅兜底；不同歌曲
  不得因为标题相同而误合并。
- 未知歌手只在同一 canonical title 的可靠高频记录或同源 provenance 足以支持时
  回填；否则保留。

## 验收条件

- [ ] 全库 singleton 与未记载歌手总量，按频道、来源、标题模式分层。
- [ ] 至少一批高置信清洗，覆盖明显杂谈、同歌错拼和可靠未知歌手回填。
- [ ] 每条 selector 精确命中真实 `sourceId`/`sourceHash`/`rawHash`。
- [ ] curation/alias/runtime/validator 回归测试通过。
- [ ] 列出保留的真实 singleton 样本和待人工项。
- [ ] YOSHIKA before/after 包含歌曲、视频、occurrence、未知歌手、singleton，
      以及保留/删除/合并样本。
- [ ] 四页每页 20 个频道及完整歌曲展开内容写入 docs 审计。
- [ ] Mac workflow 完成完整 DB 物化与只读审计，报告 artifact 可复查。
- [ ] diff 仅含本任务文件；commit 并 push 远端目标分支，不 merge、不部署。

## 当前状态

- 2026-07-26：活动 goal 已重建。
- 2026-07-26：首个隔离 worktree 后来出现另一项 UI/API 的外部写入，已原样保留；
  本任务迁移到当前第二个干净 worktree，未覆盖或暂存那些文件。
- 2026-07-26：完成三路只读架构审查。确认 runtime DB exporter 尚未将
  `curation-overrides` 应用于 accepted/VSinger 导入，必须先补物化链路。
- 2026-07-26：生产健康基线为 schema v2、45,252 videos、44,624 songs、
  594,582 occurrences；YOSHIKA 基线为 237 videos、627 songs、
  4,715 occurrences、164 singleton songs，source occurrence 中未知歌手 543 条。
- 2026-07-26：完成 checkpoint 化全库 before/after 审计、四页生产 API 审计和
  完整 SQLite 只读提取脚本；新增分支专用 Mac job，不读取 VPS secret、不部署。
- 2026-07-26：本地 focused tests 37/37 通过，Python audit 脚本可编译，
  `git diff --check` 通过。
- 2026-07-26：四页生产 API 预检全部满足每页 20 个频道，共 80 个频道行，
  完整展开歌曲 75,808 条。
- 2026-07-26：首轮审计基础设施 commit `51d3caf` 已 push。首次 workflow
  dispatch 在 GitHub YAML 解析阶段以 422 拒绝（job env 不允许使用
  `runner.temp`），没有创建 run；已改为首个 step 写入 `GITHUB_ENV`。
- 2026-07-26：Mac run `30174911838` 已按 head `7577f66` 创建。生产页预检发现
  VTuber 展开 songs 不提供 artist；已修正审计语义，不再把缺失字段误记为未知歌手。
- 2026-07-26：浏览器只读预检发现 YOSHIKA 卡片 `songCount=627`，展开详情显示
  628 首；审计改为记录 count mismatch，并由完整 DB `source_occurrences` 生成每频道
  全部歌曲/歌手分组。
- 2026-07-26：四个 UI 目标均确认 20 个频道和正确 metric/page；YOSHIKA 展开可见
  歌手及分页。全库 artifact 将为每个频道保留数字/杂谈/未知歌手的完整 selector
  样本，而非只保留前 20 条普通样本。
- 2026-07-26：新增只报告、不参与合并的 loose title variant 分层；同时列出所有
  同 canonical title 的多已知歌手冲突，避免把不同歌曲误合并。
- 2026-07-26：生产数据更新在审计排队期间把 `origin/main` 前移到
  `4649ebf3a87134ab258045ce14c10a1193b23726`；首轮旧基线 run 仅作探针，最终分支会
  rebase 到该实时 main 并重新审计。
- 2026-07-26：只读复核后补强审计证据：四页读取真实 `totalCount`，YOSHIKA 会合并
  历史拆分身份，SQLite source 审计以完整 occurrence 计算 singleton、未知歌手可回填和
  同标题多歌手冲突；Markdown 也纳入 artifact digest。
- 2026-07-26：本地审计脚本测试 11/11、Python SQLite 单元测试 2/2 通过。Mac job
  支持显式 selector 数量门禁，并可上传/恢复同一 head 的 inventory checkpoint。

## 下一步

1. 等待首轮 Mac 探针完成，下载并核对 manifest/YOSHIKA/四页证据。
2. rebase 到最新 `origin/main`，按真实 provenance 写入首批高置信 selector 与回归样本。
3. 以显式 selector 数量门禁再跑 Mac after，更新最终文档与 run/artifact digest。
4. 完成 diff 审查、目标文档时间戳归档、commit 与 push。

## 2026-07-26 10:30 状态

- 实时 `origin/main` 仍为 `aa346c86ae8d475f87f5160088ecf4c38a3c628d`；审计分支
  head `6fa10644e321b3227ce4a054f2d916c94352fa76` 已包含该基线。
- 正式 before run `30183655942` 的 curation audit job `89744468699` 成功；
  完整 SQLite 13,907,808,256 bytes，SHA-256
  `55f74ce6453c01668f4274288ce8698db475c7301bd5897109031085281f1391`，
  `quick_check=ok`，已从 runner 临时目录删除。
- before artifact ID `8626607541`；可恢复 inventory checkpoint ID `8626595119`。
- 全库 runtime 口径：45,521 videos、45,325 songs、594,097 occurrences、
  56,146 unknown-artist occurrences、26,539 singleton songs。
- 首批已写入 15 个 exact selector：12 个用户确认的 Naraetan non-song drop、
  `明日への勇気` 注释修正、2 个 YOSHIKA 唯一高频已知歌手回填。
- 本地 Node 46/46、Python 2/2 通过；下一步 commit/push 后 dispatch Mac after，
  `expected_selector_count=15` 并恢复 checkpoint，不使用 `--fresh`。
