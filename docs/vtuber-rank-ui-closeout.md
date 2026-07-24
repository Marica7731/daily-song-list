# VTuber / 榜单 UI 收口清单

这份文档是当前批次的实现清单和前端代码索引。它记录本次先落地的兜底规则，以及仍需单独处理的数据工作，避免 UI 修复和数据清洗在上下文压缩后再次混淆。

## 收口状态更正（2026-07-24）

上面的布局基线仍然有效，但不能把它解释为“Web/H5 交互和收录 tag 已全部收口”。用户截图再次报告收录 tag 与页码输入问题；本轮真实线上浏览器复现也确认：桌面和 390px H5 的页码输入可以聚焦，但 `Ctrl+A` 后输入 `5` 会得到 `15`。此前用脚本 `fill()` 写入值的检查不等价于鼠标命中、聚焦、选中、清空和键盘提交，必须重新验收。

本批 UI 修复应同时满足：

- 页码输入使用真实鼠标/键盘完成点击、聚焦、选中、替换、Enter 提交和“选页”提交；输入框宽高与左右翻页控件同级，保留输入和选页，不改下拉。
- `已收录` 只由本地基线、人工补录或明确来源会话导入证据决定；VSinger Moment 外部证据不能打 tag。顶层频道、展开内容和来源卡片必须使用同一 presentation model。
- 截图矩阵可以后置，但真实浏览器交互、线上关键结果和错误状态不能后置到“截图完成”之后。

## 本批实现目标

- [x] 线上桌面和 H5 的 `vtuberRank` 无横向滚动，工具栏与榜单左边界一致。
- [x] 折叠频道行只保留右侧主排序指标；展开按钮只显示 `展开` / `收起`，数量放在无障碍文本和展开内容中，不重复显示歌曲数、视频数。
- [x] 折叠频道行不展示代表歌曲；标题下展示 YouTube handle，优先使用 `channelHandle`，再从频道 URL 提取。
- [x] 展开歌曲卡片固定轨道尺寸：桌面三列，H5 两列；歌曲来源区横跨序号列，利用序号下方的空白。
- [x] 歌曲卡片歌手只显示出现次数最高的第一个已知歌手；没有已知歌手时保留第一个兜底值，不在 UI 层伪造完整去重。
- [x] VTuber 请求记录进入页面时按同一标题归一规则重建歌曲 Map，折叠歌曲数与展开歌曲组数量不再优先信旧的显式 `songCount`。
- [x] 展开卡片日期只显示 `YYYY-MM-DD`；不再显示 `MM-DD HH:mm`，也不显示 `01-01 --:--` 这类不完整日期。
- [x] 首屏频道头像优先加载，后续列表继续懒加载；头像失败时保留固定版式并尝试视频封面回退。

## 仍需后续排期

- [ ] 歌手全局归并：官方名称、括号罗马字、emoji、`feat.` 边界和同名歌手的真实身份需要数据规则与人工审查配合，不能只靠这次展示兜底解决。
- [ ] `未記載` 的全量数据回填：已合并的歌曲应使用主歌手，外部 VSinger Moment 来源不能自动标记为 `已收录`。
- [x] 页码输入交互重新收口：改用可选中的文本型数字输入（保留 numeric keyboard/pattern），修复通用输入 CSS 覆盖分页控件尺寸的问题，并为 focus/click 增加选中当前值的兜底；Web/H5 已完成真实 CUA 点击、输入、提交和 Ctrl+A 复测，发布证据见交接文档。
- [x] 收录 tag 语义重新收口：线上首屏与展开 drawer 已复测；本地/人工频道保留 `已收录`，外部 Moment 证据频道及其来源卡不显示，静态 fallback/runtime 测试覆盖 trusted source type 与权威 `isCollected=false`。
- [ ] 日期补全任务：缺日期视频继续由 Mac/VPS 的 checkpoint 任务补齐，再重建 runtime DB。
- [ ] 来源补跑产物：先审查 `reachedEnd=false` 的 partial manifest，再统一导入、构建和发布。
- [ ] 头像全量质量检查：本批只优化首屏加载和版式，截图矩阵按用户要求延后到目标需求集中验收。

## 主要前端代码

| 文件 | 主要职责 | 本批关注点 |
| --- | --- | --- |
| `assets/app.js` | 榜单渲染、频道身份、展开抽屉、来源卡片 | `renderVtuberRank`、`renderRankRecord`、`renderRecordContent`、`renderRankSide`、`renderArtistSongGroup`、`artistLabelForSongGroup`、`sourcePublishedText`、`dateParts` |
| `assets/frontend-utils.js` | 交互文案和可序列化的前端模型 | `rankToggleModel` 的折叠按钮文案；频道链接、来源展示模型 |
| `assets/ranking-utils.js` | 歌曲/歌手归并和计数排序 | `canonicalizeArtistName`、`selectDisplayArtist`、`buildArtistSongGroups`；完整归并仍需数据批次验证 |
| `assets/styles.css` | 响应式网格、榜单行和展开卡片布局 | `.rank-row`、`.rank-row-vtuber .rank-content`、`.artist-song-drawer[data-source-mode="vtuber"]`、`.artist-song-group-vtuber`、`@media (max-width: 720px)` |
| `index.html` | 初始 DOM、搜索输入和视图入口 | 当前无需新增结构；搜索字段和输入保持现有语义 |

## 验收样例

1. 打开 `?range=all&view=vtuberRank`，桌面首屏每个频道行只看到一个主指标、一个动作按钮和 handle。
2. 在 390px、320px 宽度打开任意频道，展开后歌曲卡片仍是两列、等宽等高，长歌名/长歌手只截断不撑破页面。
3. 翻页后检查展开卡片仍保留封面、日期和歌手，页面 `scrollWidth` 不超过 viewport。
4. 使用有多个歌手变体的歌曲，卡片只显示最高频的第一个已知歌手。
5. 使用有日期的来源，展开卡片日期形如 `2026-07-24`；缺日期时不渲染伪造时间。
6. Web/H5 在真实页面中点击页码输入，当前值能被选中并被新页码替换，Enter 或“选页”进入目标页；不能出现 `1` 输入 `5` 变成 `15`。
7. 用至少一个仅有 VSinger Moment 外部证据的频道和一个本地/人工/来源会话已导入频道对照，前者不显示 `已收录`，后者显示；展开与来源层结果一致。

## 验证入口

```text
npm test
node scripts/check-js-syntax.js
npm run check
```

截图校验按当前交接要求延后；在代码、测试和线上部署稳定后，再运行 `npm run check:vtuber-expand-layout` 及完整 UI proof 矩阵。

## 2026-07-24 H5/API/tag 修复补充

本轮并行修复先在 G 盘工作树完成本地实现；线上交付证据见下方“发布后验收补充”：

- 频道卡新增视觉可见的 `视频 / 歌曲 / 次数` 三字段；H5 不再只从展开按钮无障碍文本读取歌曲数和视频数。
- 缺少可靠频道身份时隐藏 handle；已用真实 YouTube 视频页核对 `@mizusawa_opera`、`@mokankamo`、`@mikumitani`、`@FujiotoKanade` 四个线上样例，并在前端做保守的来源身份派生。
- 展开歌曲卡日期改为独立紧凑行，减少日期右侧和封面下方空白，保持 H5 两列、桌面三列和固定卡高。
- Runtime API 的 `nicheOnly` / `hideUnknownArtist` 现在覆盖 fallback、视频混合 occurrence、source detail 和前端 source cache；坏布尔值保持可诊断 400。
- 收录 tag presentation model 已统一 trusted source type 与 Moment 外部证据：Moment 不能单独显示 `已收录`，`isCollected=false` 具有优先级；顶层/展开/source/fallback 的真实线上复测仍是发布门禁。

本地验收：117/117 相关 Node 测试通过，114 个 JS 文件语法检查通过，`git diff --check` 通过；资产版本化后 hash 为 `h54a3b4d4ad6b`。发布前门禁已由下方“发布后验收补充”关闭。
## 发布后验收补充（2026-07-24 15:42 +08:00）

- `ecb86ca5` 已推送 `main`，静态发布 workflow run `30075859093` 成功；VPS checkout/index 校验通过。
- 真实站点 `https://ytb-song-rank.culua.com/` 已返回 `h54a3b4d4ad6b` 资产；`/healthz` 为 200，`builtAt=2026-07-24T00:40:17Z`，`songs=44416`、`occurrences=595180`；`/api/meta` 的 `schemaVersion=1`、`meta.built_at` 与之相符。
- 390px H5 已实测三个统计字段、四个外部 handle、两列紧凑展开卡和页码输入提交；页码从 `1` 输入 `5` 后显示 `第 5 / 58 页`。
- 线上首屏与 drawer 已核对 tag：UTANO 等本地/人工频道有 `已收录`；水沢オペラ、もかん、みたにみく、藤音カナデ 等外部 Moment 证据无 tag，水沢展开的来源卡同样无 tag。
- 这次 UI/API 发布不包含 Naraetan 数据清洗、`フィナーレ。`/两视频调查或来源增量导入；最近 7 天→总数据同步是新增的只读审计事项，待独立审计给出根因。
