# 全库 singleton / 未记载歌手审计（2026-07-26）

## 范围与原则

本审计覆盖 occurrence 仅出现一次的歌曲和 `未記載`/未知/空歌手记录。二者都只是
高风险候选，不是删除条件。原创、冷门歌曲和单次演唱必须保留；只有原始
provenance 足以证明是杂谈、转场或解析错误时才可写 `drop_entry`。错拼、注释边界和
可靠歌手回填优先使用精确 `replace_entry` 或同歌 alias。

专项范围：

- `https://www.youtube.com/@YOSHIKA-Ch`
- occurrences 排名第 1、2 页，每页 20 个频道
- songs 排名第 1、2 页，每页 20 个频道
- 每个频道的全部展开歌曲，而非 UI preview

## 可复查入口

- `scripts/audit-global-song-quality.js`
  - 在 Mac runner 读取 base、YouTube accepted 和 VSinger shards。
  - 第一阶段写 `inventory.jsonl.gz` 与 `inventory-meta.json` checkpoint。
  - 第二阶段按 batch tag 对比既有规则（before）和本批规则（after）。
  - 输出全库分层、selector 精确命中、YOSHIKA、保留 singleton 与待人工项。
- `scripts/audit-production-vtuber-pages.js`
  - 请求四个生产 API 页；每页必须严格返回 20 个频道。
  - 每个频道的 `songs.length` 必须等于 `songCount`，否则审计失败。
  - 输出完整 JSON、gzip JSONL、频道摘要和 artifact digest。
- `scripts/audit-runtime-db.py`
  - 只读打开 Mac 完整生成的 SQLite，执行 `PRAGMA quick_check(1)`。
  - 输出全库计数、YOSHIKA、四页频道列表和 DB SHA-256，不上传完整 DB。
  - 每个频道从完整 `source_occurrences` 重新计算 singleton、未知歌手、可回填候选和
    同标题多歌手冲突，不依赖排名 payload 中不存在的汇总字段。
- `.github/workflows/check-code.yml`
  - 仅在手动 dispatch 且分支为
    `codex/global-singleton-cleanup-20260726` 时运行重型审计 job。
  - runner 临时目录独立于生产 DB cache；不含 SSH、VPS、commit、push 或部署步骤。
  - 可用 workflow input 锁定本批 selector 数量；完成的 inventory checkpoint 会短期上传，
    只要 base/accepted/VSinger 输入及 inventory 代码的内容指纹不变，后续 curation commit
    可显式恢复；同尺寸内容变化也会使 checkpoint 失效，默认不使用 `--fresh`。

## 实时生产基线

取证时间：2026-07-26（Asia/Taipei）。

| 指标 | 当前生产 |
| --- | ---: |
| schemaVersion | 2 |
| videos | 45,252 |
| songs | 44,624 |
| occurrences | 594,582 |
| source occurrences | 1,939,316 |
| channel metadata | 1,168 |
| VSinger external songs | 59,447 |
| VSinger external videos | 63,679 |
| VSinger external occurrences | 525,518 |

生产 meta 的 source commit 是
`1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`，与本分支基线一致。

## YOSHIKA-Ch before（生产）

频道身份：

- 显示名：`YOSHIKA⁂Ch.`
- handle：`@YOSHIKA-Ch`
- channel ID：`UC3xQCiEPSkco54WhuiDcngw`
- source detail key：`82488b92c02b5a8f`

| 指标 | Before |
| --- | ---: |
| videos | 237 |
| songs | 627 |
| occurrences | 4,715 |
| singleton songs | 164 |
| source occurrences 中未记载歌手 | 543 |
| 明显纯数字标题 occurrence | 49 |

纯数字样本包括 `168000`、`168100`、`143705`、`143800`、`143900`、
`143100`、`141100`、`140100`、`131313`、`91600`。它们仍须在 Mac inventory
中核对 `videoId + sourceId + sourceHash + seconds + rawHash` 后才能成为
`drop_entry`；此表本身不授权批量删除。

## 四页生产预检

`scripts/audit-production-vtuber-pages.js` 已在 WSL 用 55 秒外层 timeout 和每请求
12 秒 timeout 完成一次预检：

| 页面 | 频道行 |
| --- | ---: |
| occurrences page 1 | 20 |
| occurrences page 2 | 20 |
| songs page 1 | 20 |
| songs page 2 | 20 |
| 合计 | 80 |

四页完整展开歌曲合计 75,808 条。完整频道列表、每频道歌曲以及明显杂谈、可靠
singleton 保留、可能错拼、未知歌手回填候选、同标题多歌手冲突会以 Mac artifact
为准回填到本文。

生产 VTuber 排名页的展开歌曲契约只包含 `name/key/count`，不包含 artist。页面审计
不得把“artist 字段未提供”误计为“未记载歌手”；页面层负责核对标题、次数和可能
错拼，未知歌手回填与同标题多歌手风险必须回到全库 inventory、source occurrence
或完整 SQLite 证据判定。

浏览器预检进一步发现 YOSHIKA 卡片显示 627 首，但展开详情显示“全部 628 首歌”。
这类 `songCount`/embedded songs 不一致必须作为问题保留，不能让审计脚本提前退出。
Mac SQLite 报告会按每个频道的 `sourceDetailKey` 分组完整 `source_occurrences`，以
source 层的标题、歌手和次数作为完整性判断。

## 当前物化边界

main 的 P0 提交 `c0984812fb0645adba675f07be08ad78ca53885c` 已把
`config/curation-overrides.json` 接入 YouTube accepted runtime 导入，并补充
drop/replace/upsert 的时间字段与回归测试。因此本批优先从
`youtube_channel_discovery` 选择可核验记录；其 curation before/after 应与完整 SQLite
物化结果一致。

VSinger 导入是否覆盖相同 curation 路径仍由 Mac 报告逐项验证，不用 curation 层的理论
delta 代替 runtime DB 证据。Mac 审计会同时提供：

1. curation 层精确 before/after（证明 selector 与规则效果）；
2. 当前核心 exporter 生成的完整 SQLite（证明实际分支运行时物化状态）。

若两者不一致，报告必须明确标记为运行时接线缺口，不能声称生产或分支 DB 已清洗。

## 待回填

- [ ] 全库 before/after 总数及来源、频道、标题模式分层
- [ ] selector 精确命中清单
- [ ] YOSHIKA after 与保留/删除/替换样本
- [ ] 四页 80 个频道完整列表与问题分类
- [ ] 明确保留的真实 singleton 样本
- [ ] 待人工项和疑似错误同名合并
- [ ] Mac run/job/artifact/digest 和完整 SQLite quick-check

## 正式 before 审计（head `6fa10644`）

本节取代上文较早的生产预检数字。正式 Mac self-hosted run
[`30183655942`](https://github.com/Marica7731/daily-song-list/actions/runs/30183655942)
在 2026-07-26 10:26（Asia/Taipei）完成 curation audit；job `89744468699`
全部步骤成功。没有从该 workflow commit、push、部署或上传完整 SQLite。

### Artifact 与完整性

| Artifact | ID | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `global-singleton-curation-audit-30183655942-1` | 8626607541 | 53,015,196 | `d09e66e89c2659aad76abb32bc01d4ffc47d865feb5f30c82e5fab1d34f506cd` |
| `global-singleton-curation-checkpoint-30183655942-1` | 8626595119 | 76,377,039 | `2744e80eb1ade1383cb95c47166ba4fd9982f0bd66b34366b573c1dccc58b488` |

Checkpoint inventory 为 45,571 videos / 603,623 occurrences，gzip SHA-256
`70b1741be4ca419ed9dd62b0707b0e5ba9654977ece173163ca9f60a244a73a9`。
完整 SQLite 大小 13,907,808,256 bytes，SHA-256
`55f74ce6453c01668f4274288ce8698db475c7301bd5897109031085281f1391`，
`PRAGMA quick_check(1)=ok`；审计后已从 runner 临时目录删除。

### 全库总量

原始合并 inventory 经现有 curation/alias 后、但尚未应用本批 selector 的 before：

| Metric | Before |
| --- | ---: |
| videos | 45,484 |
| songs（title/artist identity） | 51,576 |
| occurrences | 588,259 |
| unknown artist songs | 29,379 |
| unknown artist occurrences | 278,129 |
| singleton songs | 29,388 |
| singleton unknown songs | 15,153 |

由当前分支实际 exporter 物化的 runtime DB 口径：

| Metric | Before |
| --- | ---: |
| videos | 45,521 |
| songs | 45,325 |
| occurrences | 594,097 |
| unknown artist songs | 22,285 |
| unknown artist occurrences | 56,146 |
| singleton songs | 26,539 |
| singleton unknown songs | 14,810 |

两个口径不同是因为 runtime exporter 还会执行 canonical grouping、来源合并和已知歌手
fallback；不得把 raw inventory 数字与 runtime ranking 数字互换。

### YOSHIKA before

| Metric | Inventory before | Runtime/source audit before |
| --- | ---: | ---: |
| videos | 237 | 237 |
| songs / song groups | 723 | 627 ranking songs / 655 title-artist groups |
| occurrences | 4,709 | 4,714 |
| unknown artist songs | 460 | 151 |
| unknown artist occurrences | 2,757 | 539 |
| singleton songs | 242 | 186 |
| singleton unknown songs | - | 81 |
| same-title artist conflicts | - | 24 |

本批仅回填两个有唯一高频已知歌手的 YOSHIKA occurrence：

- `ココロのちず / 未記載` → `BOYSTYLE`：全库同 canonical title 仅一个已知歌手，
  已知 30 次；selector `0K3ghcwE1EU@1509`。
- `恋するフォーチュンクッキー / 未記載` → `AKB48`：全库同 canonical title
  仅一个已知歌手，已知 32 次；selector `jd3zEkmOO68@1177`。

未能由唯一可靠已知歌手支持的其余 537 条 source unknown occurrence 均保留。

明确保留的 YOSHIKA singleton 真歌样本：

- `IRIS OUT / 米津玄師`
- `DIVE TO WORLD / CHERRYBLOSSOM`
- `I'm Your Treasure Box / 宝鐘マリン`
- `Realize / 玉置成実`
- `だから僕は音楽を辞めた / ヨルシカ`

短标题/数字也不是删除条件。例如 `3 / After the Rain` 有 26 次；纯数字候选仍须逐条
回到 provenance，不能按模式删除。

### Naraetan before 与首批决策

Naraetan runtime/source before：292 videos、1,396 ranking songs、4,463 occurrences；
完整 source occurrence 形成 1,593 个 title-artist groups，其中 singleton 917、
unknown occurrence 73、unknown groups 71、singleton unknown 70、同标题多歌手冲突 140。

用户截图与 accepted raw 共同确认的 12 个 non-song singleton 采用完整
`videoId + sourceId + sourceHash + seconds + rawHash` selector。`龍角散` 在同一视频同一秒
同时存在 accepted 与 VSinger 两份 provenance，因此用两个 exact selector 清理同一个已确认片段：

`音をねじる`、`頭→目→歯`、`頭痛`、`顔`、`風邪気味かもしれない`、`飛行機`、
`飾り棚`、`餃子`、`高音を出すとおでこが痒くなる`、`魔法少女ごっこ遊び`、
`鼻歌（Last Christmas）`、`龍角散`。

`（音量注意）明日への勇気 / 吉成圭子` 是真歌，采用 exact `replace_entry`
去除演唱警告，并与既有 `明日への勇気` occurrence 合并，绝不 drop。`飛行機` 与该真歌
位于同一视频并共享 sourceId/sourceHash，回归测试要求 seconds/rawHash 不同时不能误命中。
另一个视频中的 `鼻歌 / summertime` 不在本批 selector 内。

本批 tag `global-singleton-20260726` 共 16 个 selector：
13 `drop_entry`（覆盖 12 个已确认 non-song 片段）、1 个标题/注释修正、2 个可靠未知歌手回填。

### 四页 80 个频道与全部展开歌曲

Mac 生产 API 审计严格取得四页各 20 个频道，共 80 个排名位置、75,826 条展开歌曲。

1. occurrences page 1：UTANO、Hanon、月城セシル、水沢オペラ、惑世いと、
   もかん、江波キョウカ、むんもっしゅ、Shairu、小鳥遊ゆとは、茨むあん、
   みたにみく、凰牙るき、戌月れん、蒼星すい、御神楽すずめ、春歌みこと、
   苺咲べりぃ、藤音カナデ、YOSHIKA。
2. occurrences page 2：Noa Polaris、音鍵めろ、渚沢シチ、五木つかさ、CYBILL、
   Naraetan、汐音ベリー、音羽ララ、彷徨鈴、稍麦、狼朗ハツキ、白河しらせ、
   時羽あいの、明日夢かなえ、氷々樹ノルン、ミナミイズミ、紅葉丸、MUS1CA、
   バツ子、魔ノむえる。
3. songs page 1：江波キョウカ、惑世いと、Naraetan、UTANO、まゆり、Hanon、
   月城セシル、獅子神レオナ、keita、音羽ララ、戌月れん、明日夢かなえ、紅葉丸、
   Ellise、MUS1CA、春歌みこと、Noa Polaris、久遠たま、藤音カナデ、茨むあん。
4. songs page 2：小鳥遊ゆとは、ミナミイズミ、むんもっしゅ、稍麦、XIDEN、
   バツ子、凛々咲、ひよりひよこ、ミソラソラ、香椎きなこ、鏡愛しゅくり、
   苺咲べりぃ、空奏イト、凰牙るき、323、神崎メイサ、メーレ、三日月ちゆる、
   蒼羽未音、Shairu。

完整 JSON/JSONL artifact 保留每个频道的 sourceDetailKey、歌曲 key/count 与完整 source
occurrence audit。页面紧凑 payload 不提供 artist，不能据此把歌手误记为 unknown。

### 生产 UI/契约发现

- 当前 in-app 浏览器加载的静态资源把所有频道卡显示成 `3 首歌`：
  前端优先读取 compact preview Map 大小，而 API 只嵌入前三首。
- YOSHIKA API 为 627 首、展开 UI 为 628；Naraetan API 为 1,396，本次浏览器展开为
  1,395，而用户截图曾显示 1,397。API、展开聚合和不同客户端静态资源存在分歧。
- `range=all` URL 下浏览器仍显示“本月”被选中。
- 这些是独立前端/runtime 契约问题；本清洗分支不修改 `assets/`、`server/` 或
  `test/runtime-api.test.js`。

### 首批本地回归

- `config/curation-overrides.json` JSON 校验通过。
- curation、全库审计和四页审计 Node tests：46/46 通过。
- runtime DB audit Python tests：2/2 通过。
- `git diff --check` 通过。

首个 Mac after run `30184771010` 证明原 15 个 selector 均各命中一条；其 runtime after
仍有一条同秒的 VSinger `龍角散 / 未記載`，定位为
`4xWoeTde_jQ@646`、sourceId `48a015c3-8e90-461e-a912-d3e20c1aca72`。
最终门禁是在合入最新 main 后恢复 after checkpoint artifact `8627299029`，
传入 `expected_selector_count=16`。每条 selector 必须精确命中一条真实 inventory row，
并确认 Naraetan 目标标题只保留合并后的真歌 `明日への勇気`。
