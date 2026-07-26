# daily-song-list 清洗与 upsert 上线收口

## 目标

接管并完成 daily-song-list 的 curation 清洗与 `upsert_video` 工作，先验收 Naraetan，再形成可继续扩展到其他频道的保守清洗流程；最终通过既有 GitHub Actions 发布到生产并做真实线上验证。

## 范围

- 验收 Naraetan 首批 curation：只删除有原始证据的非歌曲，歌曲别名合并必须保守。
- 修复 Naraetan alias 与已生成静态数据不一致导致的 Check code 失败。
- 审查并完善 `upsert_video` 的 schema、整场替换语义、测试和用户操作文档。
- 形成 Naraetan 后续批次与其他频道的全库清洗候选审计计划。
- 恢复“新增 31 个 YouTube 来源”的完整交付边界：逐来源核对当前 main、生产 videoId 覆盖、本地 accepted 与 checkpoint，只续跑真实缺口。
- 审计最近 7 天数据自动进入总库的端到端链路；评估现有补丁是否正确，并确保 7 天增量使用当前清洗、字段和来源标记规则。
- P0：恢复生产 `/api/rankings` 的 VTuber 频道查询，修复 502 根因；错误状态保留上一页但改为简洁、可重试、可展开诊断的提示。
- 全库 singleton/未记载歌手清洗已委派独立任务 `019f9aff-32a6-73f0-88d6-e7e7c3a74250`；本任务只负责后续审查与集成，避免与其写集冲突。
- 该独立清洗任务的业务验收包括 `@YOSHIKA-Ch` before/after，以及生产 VTuber 榜按次数/按歌曲数各前两页逐频道歌曲审阅。
- 不做飞书通知。
- 不触碰旧 G 工作树中的 `.workbuddy/`、未提交删除或其他用户改动。
- 不与 source-backfill 会话并发写同一数据库、来源目录或 checkpoint。
- 大型数据库构建、全库扫描和长任务只使用 Mac self-hosted runner；轻中型隔离测试可使用已验证连通的 `vps-wdc`。

## 验收条件

1. `upsert_video` 不依赖生产配置中的假示例；合法记录有严格 videoId、歌曲、时间戳和操作者校验。
2. 有可直接填写的整场歌单 JSON 示例、上线入口和回滚说明。
3. Naraetan 首批按类别抽样核对原始 JSON/HTML；已知真曲保留，脏条目不再进入生成数据。
4. Check code 全绿；核心数据更新和 Runtime DB 发布成功。
5. 线上 `healthz`、`meta`、`rankings` 返回预期状态码和关键字段；Naraetan 目标脏项及 upsert 结果有生产查询证据。
6. 后续清洗候选来自只读审计，不能把外部搜索的猜测直接导入生产。
7. 31 个来源均有明确终态：已上线、真实增量待发布、或因缺少 usable detail 保留 checkpoint；不得把 crawler 进度当作生产缺口。
8. 最近 7 天的线上视频能自动进入总库，字段覆盖、清洗结果、来源标记与当前规则一致；以生产 API 的实际 7 天样本和总量变化验收。
9. `/api/rankings?range=all&view=vtubers&metric=occurrences&page=1&pageSize=20` 线上恢复 200；502/504 不再把完整查询串直接铺在页面上，用户可重试并展开诊断信息。

## 当前状态（2026-07-26）

- Check code run `30175755772`：`430/430` 测试通过，失败仅来自
  `data/diff/latest-1m.json` 与 `data/diff/latest-all.json` 各自 gzip 超预算约 120 KB。
- 根因：Mac sparse checkout 缺少旧 snapshot 工作区文件时，rank diff 没有回退到运行开始前的
  `data/latest.json`，导致全库 `10381` 首歌与 `4565` 位歌手被错误标为新上榜；snapshot index
  同时会按 `fs.existsSync` 错误丢弃未展开的历史条目。
- 当前修复分支：`codex/fix-rank-diff-snapshot-20260726`。计划补齐 previous payload 回退和
  sparse-safe snapshot index 保留规则，通过测试后推送 main 并重跑 Check code/update-core。
- rank-diff 修复已推送 main：`0049dccca73203803ac19509560f5f5e9a338ad9`。
- 已审查来源与 Felicia 身份整合已推送 main：`499f34585d77935770c7143118bab68295928128`。
- 来源分支 `agent/source-backfill-usable-artifacts-20260726` 已完成内容级复核：
  KOTATSU、Arale、UCw0ty 合计 `181 videos / 1834 occurrences`，字段覆盖 100%，
  cleaner 二次 dry-run 为零变化，生产/main overlap 为零。
- Felicia Lulufleur 已确认官方频道 `UClHap4tvcYZnyiqgAyEs0BQ` / `@FeliciaLulufleur`；
  metadata hydration 可回填生产既有 `239 videos / 3293 occurrences` 的 channelId/handle/url。
  另有 44 个生产缺失 videoId 仅保留 checkpoint，因无 usable song detail 尚未生成 accepted。
- 全库频道身份 dry-run 审计已完成：生产 `45223` records 中 `16584` 条至少缺一个字段，
  合并为 497 组；493 组 high-confidence，其中 Felicia 作为已单独交付正样本排除，
  实际可交付 492 组。2 组 ambiguous、2 组 unresolved 保留人工复核。
  候选预计把三字段覆盖提高至 `44843 / 45223`（99.16%）；本轮只交付审计脚本、测试和报告，
  不自动写 metadata。
- Naraetan 首批已合并：`6d2163c`。
- `upsert_video` 已推送：`938bf7d`，文档提交 `7541a18`，示例修正 `1d2bf94`。
- Check code run `30172044209` 失败：413 个测试通过，但 `validate-data` 报告 17 条 alias 尚未物化到静态核心数据。
- Runtime DB run `30172044212` 仍需确认最终状态和线上结果。
- 来源补跑 task `019f9a04-513d-77d0-ae9a-bf17249815d5` 的原目标为 31 个来源；`df608da6` 只代表最后一轮 Hanon/Noa 去重增量，不能代替整个任务。当前正在按实时 main/生产逐来源重新审计 2026-07-20 至 07-25 的 accepted、manifest 与 checkpoint。
- 2026-07-26 已从生产 API 按 `searchScope=video` 核对 `aibg0-_tU6c`、`mt55aKAdYqM`、`HZ1q27Z5Pqc`、`0bXKzDEk79E`，4 个查询均 HTTP 200 且 `totalCount=0`，符合真实新增视频预期。
- `vps-wdc` 已从 WSL 使用 SSH BatchMode 只读连通。
- Naraetan 首批只读验收结论为拒绝：96 条新增 drop 中至少 8 条明确真曲被误删，另有同秒翻译与替え歌高风险项；发布前必须按逐条证据收口。
- Naraetan batch1 原有 100/100 `selected:` selector 与 accepted comment sourceId 不一致。当前分支已用 SHA-256 `468e8db1…656e` 的 accepted JSON 唯一匹配并机械替换为真实 `sourceId/sourceHash`；二次审计 `changedRecordCount=0`，回归测试要求 100 条 selector 唯一且不再使用 `selected:`。
- 远端 `Deploy SQLite runtime DB` run `30172044212` 在 2026-07-26 刷新时仍停留于 `Upload and activate database`，不能视为完成。
- 原 G 工作树处于 detached HEAD `564aada`，有用户未提交内容；本任务使用独立工作树：
  `/mnt/g/codex-work/daily-song-list-cleanup-upsert-20260726`。

## 下一步

1. 完成 Naraetan 只读验收并收口 17 条 alias 物化失败。
2. 完成 31 来源审计；选择性纳入所有真实未上线 accepted increment，已在线数据只保留审计证据，缺详情来源才续跑。
3. 完成 `upsert_video` 的严格校验、整场替换、catalog 防回流、unmatched 报告及回归测试。
4. 审计并修复最近 7 天数据自动入总库链路，同步当前 cleaner/curation、字段与来源标记规则。
5. 修复生产 502 和错误提示 UI，并完成真实浏览器交互验收。
6. 在 Mac runner 运行核心数据构建与全量校验。
7. commit、push，按既有 workflow 发布。
8. 验证生产 API 和 Naraetan、31 来源增量、最近 7 天自动入库结果，记录 run ID、时间和证据。

## Integration checkpoint (2026-07-26)

- Integrated P0 compact VTuber payload, retryable diagnostic UI, and VPS upstream timeout 30s -> 60s.
- Integrated accepted-runtime curation/upsert/drop sync, strict time fields, metadata refresh ordering, and final 7d-to-all continuity gate.
- Integrated Naraetan conservative corrections and full upsert_video semantics/documentation.
- Integrated accepted increments: Hanon 2/16, Noa 2/19, selective A1 19/241, Ebakyouka 103/1476; cleaner dry-run 126 videos / 1752 occurrences with zero changes.
- Lightweight WSL regression: 116/116 passed; syntax checks passed.
- No commit, push, workflow dispatch, deployment, or live post-deploy acceptance yet.
- Independent singleton/unknown-artist task remains active and owns YOSHIKA plus the four-page channel audit.

## Release checkpoint (2026-07-26 07:20 +08:00)

- `Update core song-list data` run `30176739632` generated commit
  `a01cc8723692fda7a527c62812e97719399bd732` from parent
  `149245d814899dffcbc7ebbff18fff4c09ebafd2`; its 4.67 GB generated-object
  push is still active on the Mac runner and must not be cancelled while
  `git-remote-https` is making CPU/network progress.
- The regenerated rank diffs now retain a non-null previous snapshot and are
  within budget: latest-all gzip 3,361 bytes, latest-1m gzip 3,370 bytes,
  latest-7d gzip 9,025 bytes.
- Generated continuity audit: all 136 recent videos are present in the base
  all range; all 2,208 recent occurrences have seconds, time, sourceId and
  rawHash. YouTube accepted increments are intentionally merged by the runtime
  DB exporter rather than written into the base `data/all.json`.
- Full channel identity hydration was rerun against current main metadata SHA
  `e48502b0...f6c3b7`: 492 eligible candidates produced 486 additions, 4
  unchanged identities, 2 duplicate-candidate consolidations and 0 conflicts.
  Felicia plus 2 ambiguous and 2 unresolved groups remain excluded. Explicit
  apply produced SHA `bc75b5b3...adebd28`; a second apply returned changed=0.
- The current deployed index still references stale
  `assets/app-ha7da65830b9d.js`, which does not send `compact=1`. The reviewed
  source assets generate version `h50a70f4cceb4`; the new hashed app contains
  compact VTuber requests and the retryable diagnostic card.
- Local pre-publish verification: channel hydration suites 22/22 passed;
  asset syntax passed; app gzip 79,149 bytes and CSS gzip 15,204 bytes are
  within budget. After supplying a temporary G-drive `python` -> `python3`
  test shim, the combined UI/runtime selection run passed 62/62; final Check
  code on Mac remains authoritative.
- No new metadata, hashed asset, runtime DB or static page has been published
  at this checkpoint. Production still reports the old runtime source and
  Felicia handle search returns zero; delivery remains incomplete.

## Release checkpoint (2026-07-26 09:45 +08:00)

- Remote `main` and production Runtime DB now run
  `aa346c86ae8d475f87f5160088ecf4c38a3c628d`; Runtime DB workflow
  `30179793634` succeeded and production `healthz`, `meta`, and rankings
  recovered from the deployment-time 502.
- Production verification found a remaining pipeline gap: VSinger runtime
  videos are merged after `hydratePayloadWithChannelMetadata()`. As a result,
  Felicia display-name search still returns 239 videos, while
  `@FeliciaLulufleur` returns zero and those rows have empty channel identity
  fields.
- The current focused worktree is
  `/mnt/g/codex-work/daily-song-list-runtime-channel-fix-20260726`. The fix is
  limited to Runtime ranking export order and regression tests; deployed Web/H5
  styling is out of scope.
- Naraetan production acceptance still shows non-song entries including
  `音をねじる`, `頭→目→歯`, `頭痛`, `顔`, `風邪気味かもしれない`, `飛行機`,
  `飾り棚`, `餃子`, `高音を出すとおでこが痒くなる`, `魔法少女ごっこ遊び`,
  `鼻歌 Humming("Last Christmas")`, and `龍角散`. These must be removed only
  through evidence-backed curation. `(音量注意)明日への勇気` is a real song
  and must be normalized/merged to `明日への勇気`, not dropped.
- Independent tasks now split the cleanup work: the existing task owns
  Naraetan, YOSHIKA, and the four VTuber-rank page audit; task
  `019f9c2f-b11f-7191-8bd3-97dd31d936f1` audits all singleton and unknown-artist
  candidates read-only.
