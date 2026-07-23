# VTuber / 榜单 UI 收口清单

这份文档是当前批次的实现清单和前端代码索引。它记录本次先落地的兜底规则，以及仍需单独处理的数据工作，避免 UI 修复和数据清洗在上下文压缩后再次混淆。

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

## 验证入口

```text
npm test
node scripts/check-js-syntax.js
npm run check
```

截图校验按当前交接要求延后；在代码、测试和线上部署稳定后，再运行 `npm run check:vtuber-expand-layout` 及完整 UI proof 矩阵。
