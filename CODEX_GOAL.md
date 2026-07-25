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

## 下一步

1. 提交并 push 首轮审计基础设施。
2. 运行 Mac before 审计，下载并核对 manifest/selector/YOSHIKA/四页证据。
3. 按真实 provenance 写入首批高置信 selector 与回归样本。
4. 再跑 Mac after，更新最终文档、diff 审查、commit 与 push。
