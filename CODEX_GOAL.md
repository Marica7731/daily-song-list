# daily-song-list｜全库频道身份 hydration 审计

## 目标

在不修改生产数据、accepted 来源文件、现有 channel metadata 资产或前端的前提下，实现可复用、默认 dry-run 的全库频道身份审计与 hydration 候选生成工具。工具从生产/runtime 数据中识别 `channelId`、`channelHandle`、`channelUrl` 缺失记录，利用 videoId、只读 metadata cache 与 YouTube 官方页面反查频道身份，并输出 high-confidence、ambiguous 和 unresolved 三类候选。

## 范围

- 新增一个审计/候选生成脚本、对应测试与审计报告。
- 只读复用 `scripts/channel-metadata-cache.js` 和现有 metadata schema。
- 在 `vps-wdc` 运行 Felicia 正样本和 8 个有界全量分片。
- 输出可复核 JSON/Markdown；不提供 metadata 写入、import、merge 或 deploy 模式。
- Felicia 只作为已知正样本，最终标记为 `excluded_known_positive`，不交付其 patch。

## 验收条件

1. 按实际缺失的三个存储字段分组并统计视频数、occurrence 数和字段覆盖。
2. 显示名不作为唯一身份；高置信必须有强身份证据并经官方频道页确认。
3. 改名、同名、多语言名、删除/私享/受限视频进入相应证据或人工队列。
4. 缓存、checkpoint、manifest、阶段日志、分片和网络并发/超时均有边界。
5. Felicia 正样本可识别但不进入可交付候选。
6. 完成全量分片、测试、diff 审查、feature branch commit + push；不 merge main、不建 PR、不 deploy。

## 当前状态（2026-07-26）

- 状态：实现与远程审计已完成；等待本轮 feature commit/push。
- worktree：`/mnt/g/codex-work/daily-song-list-channel-hydration-audit-20260726`
- branch：`codex/channel-hydration-audit-20260726`
- 基线：`origin/main` commit `c0984812fb0645adba675f07be08ad78ca53885c`
- 生产 source commit：`1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`
- 全量：45,223 records；16,584 条至少缺一个身份字段；497 个分组；195,983 occurrences。
- 分类：493 high-confidence（含 1 个排除的 Felicia 正样本）、492 个可交付 high-confidence、2 ambiguous、2 unresolved。
- 可交付候选 projected coverage：三个字段均为 44,843 / 45,223（99.16%）。
- 未修改 metadata、accepted、curation、frontend、runtime DB 或生产服务。

## 验证证据

- 生产探针：`/healthz` HTTP 200；`/api/meta` HTTP 200；`view=videos` 共 227 页。
- Felicia：239 videos / 3,293 occurrences；三个视频样本指向同一官方 handle，频道页确认 `UClHap4tvcYZnyiqgAyEs0BQ`；结果为 `excluded_known_positive`。
- 小批完成标记：`CODEX_CHANNEL_IDENTITY_AUDIT_OK records=1 missingRecords=1 selectedGroups=1 highConfidence=1 ambiguous=0 unresolved=0 excludedKnownPositive=1 dryRun=true shard=0/1`
- 全量完成标记：`VPS_AUDIT_ALL_SHARDS_OK shardCount=8`
- 合并完成标记：`CODEX_CHANNEL_IDENTITY_AUDIT_MERGE_OK inputs=8 highConfidence=493 ambiguous=2 unresolved=2 dryRun=true`
- 有界重试：只重试失败所在 shard 6/7；495 个成功分组复用缓存，结果仍为 2 unresolved。
- 本地检查：`node --check scripts/audit-channel-identity-hydration.js`
- 本地测试：`node --test test/channel-identity-hydration-audit.test.js test/channel-metadata-cache.test.js`，12 passed / 0 failed。
- 完整结果：`G:\codex-work\.codex-tmp\channel-hydration-audit\results\candidates-full.json` 与 `candidates-full.md`。

## 剩余人工清单

- ambiguous：`Itsuki Natsume / 棗いつき`、`まゆる / mayuru`（样本出现冲突频道 ID）。
- unresolved：`白傘くらげ【卒業】`、`鈴莉れん / Ren Suzuri`（有界重试仍为 watch 429 / oEmbed 403）。
- Felicia patch 由独立来源任务处理；本分支不交付。

## 下一步

1. 审查本轮四个写集文件和 metadata 资产未变证据。
2. 提交并 push feature branch。
3. 清理 VPS 任务临时目录；不 merge、不建 PR、不 deploy。
