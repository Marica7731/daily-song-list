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
- `.github/workflows/check-code.yml`
  - 仅在手动 dispatch 且分支为
    `codex/global-singleton-cleanup-20260726` 时运行重型审计 job。
  - runner 临时目录独立于生产 DB cache；不含 SSH、VPS、commit、push 或部署步骤。

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

## 当前已知物化边界

现有 runtime DB exporter 会对 runtime 导入执行 source filter、song alias 和未知歌手
fallback，但不会把 `config/curation-overrides.json` 应用到 accepted/VSinger 导入。
本清洗分支受写集隔离限制，不修改核心 exporter；Mac 审计会同时提供：

1. curation 层精确 before/after（证明 selector 与规则效果）；
2. 当前核心 exporter 生成的完整 SQLite（证明实际分支运行时物化状态）。

若两者不一致，报告必须明确标记为运行时接线缺口，不能声称生产已清洗。

## 待回填

- [ ] 全库 before/after 总数及来源、频道、标题模式分层
- [ ] selector 精确命中清单
- [ ] YOSHIKA after 与保留/删除/替换样本
- [ ] 四页 80 个频道完整列表与问题分类
- [ ] 明确保留的真实 singleton 样本
- [ ] 待人工项和疑似错误同名合并
- [ ] Mac run/job/artifact/digest 和完整 SQLite quick-check
