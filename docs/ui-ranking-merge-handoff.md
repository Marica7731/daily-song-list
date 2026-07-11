# UI 榜单重构合并交接

更新时间：2026-07-11

## 本分支改了什么

本分支只做前端展示重构，不改抓取、整理歌、GitHub Actions、JSON 数据格式或现有数据文件。

主要目标是把旧的“白色大卡片列表”改成更适合长期浏览的榜单信息架构：

- 歌曲榜/歌手榜：统一白色面板内的紧凑 `rank-row` 行。
- 来源展示：折叠状态只显示一个可点击时间戳来源；多来源只保留“查看来源/收起来源”按钮来显示完整时间戳来源。
- 并列排名：同收录次数显示相同名次，使用 competition ranking，例如 `3、2、2、1 => 01、02、02、04`。
- 歌曲索引：`歌曲索引` 不再显示排行榜名次，按索引分组展示歌曲。
- 视频视图：独立 16:9 封面网格，默认只显示前 3 首歌，可展开其余歌曲。
- 顶部和工具栏：简体中文、sticky 筛选栏、紧凑统计 chip、宽页面容器。
- 大列表渲染：歌曲榜、歌手榜、歌曲索引和视频视图先渲染首批结果，再通过“显示更多”追加。

## 修改文件清单

- `index.html`
  - 中文化顶部、范围 tab、视图 tab、搜索框和历史快照下拉。
  - 移除旧的 `videoTemplate` / `rankTemplate`，由 `assets/app.js` 直接按视图创建 DOM。
  - 主内容容器改为 `#videoList.content-shell`。

- `assets/app.js`
  - 重构 `render()`，按 `songRank` / `artistRank` / `songAz` / `videos` 分流渲染。
  - 通过 `assets/ranking-utils.js` 的 `buildCompetitionRanks()`，歌曲榜和歌手榜共用并列排名。
  - 通过 `assets/ranking-utils.js` 的 `buildSongRecords()` 修正同名歌曲聚合：先规范化标题符号、列表序号和全半角差异；同标题下明确不同的已知歌手仍拆开；无/误填歌手合并到重复最多的已知歌手记录。
  - 新增来源展开状态 `state.expandedRows`，视图、范围、搜索、快照变化时清空。
  - 新增 `renderRankRecord()`、`appendSublineSource()`、`renderSourceDrawer()`、`toggleSourceDrawer()`。
  - 新增 `renderSongIndexView()`、`groupSongIndex()`、`songIndexBucket()`，歌曲索引不再复用排行榜行号。
  - 重写 `renderVideo()`，视频卡片默认显示 3 首歌，超过后用 `toggleVideoSongs()` 展开。
  - 新增快照 loader，读取失败时保留上一份成功数据，快速切换时旧响应不会覆盖新选择。
  - 搜索使用 debounce；清空搜索立即渲染。
  - 视图渲染使用 DocumentFragment 和首批分页，避免一次性创建全部 DOM。
  - 时间戳链接仍通过 `youtubeTimeUrl(videoId, seconds)` 生成，不改变跳转语义。

- `assets/styles.css`
  - 按区域重写为 tokens、base、header、sticky toolbar、summary、ranking rows、source drawer、song index、video grid、responsive、accessibility。
  - 页面最大宽度改为 `1520px`，桌面端左右边距使用 `clamp(12px, 2vw, 32px)`。
  - 榜单行用固定列结构和 `min-width: 0`，避免长日文/英文标题撑破布局。
  - 移动端 tab 横向滚动，390px 宽度下无横向溢出。
  - 移动端工具栏为“搜索第一行、范围/视图/快照横向滚动第二行”。
  - 620px 以下隐藏独立收录次数列，避免移动端横向挤压；来源按钮仍保留清晰入口。

- `assets/frontend-utils.js`
  - 提供快照读取竞态控制、失败保留、搜索归一化和过滤纯函数。

- `assets/ranking-utils.js`
  - 提供同名歌曲聚合和 competition ranking 纯函数。
  - 歌曲聚合会保留日文浊点差异，避免把 `ギラギラ` 和 `キラキラ` 这类不同标题误合并。

- `test/frontend-ranking.test.js`
  - 覆盖同标题同歌手合并、同标题不同歌手拆分、未知歌手归并、脏标题展示名、歌手混入标题和并列排名。

- `test/frontend-utils.test.js`
  - 覆盖快照请求竞态、快照失败保留以及搜索过滤。

## 和整理歌链路分支的边界

这次 UI 仍然依赖现有 JSON shape：

```text
payload.groups[range].items[]
  item.videoId
  item.title
  item.channelName
  item.keyword
  item.publishedText
  item.songs[]
    song.time
    song.seconds
    song.title
    song.artist
```

整理歌链路分支如果只改 `scripts/update-songlist.js`、`scripts/song-utils.js`、数据质量或去重规则，通常可以直接合，不需要改 UI。

如果整理歌链路分支改变了字段名、删除字段、改变 `song.artist` 的空值语义，合并后请优先检查：

- `collectSongOccurrences()`
- `filterItems()`
- `filterOccurrences()`
- `buildSongRecords()`
- `buildArtistRecords()`
- `songMeta()`
- `artistMeta()`
- `renderVideo()`

如果新增了更可靠的歌手字段或规范化字段，建议在上述聚合函数里做兼容适配，不要让 UI 直接依赖抓取脚本的临时中间字段。

## 合并冲突处理建议

1. 如果冲突发生在 `scripts/update-songlist.js`、`.github/workflows/update-songlist.yml` 或 `README.md`，优先保留整理歌链路分支；本 UI 分支不需要这些文件。
2. 如果冲突发生在 `assets/app.js`，优先保留本分支的新视图分流、并列排名、来源 drawer 和歌曲索引结构，再把对方新增的数据适配逻辑接进聚合函数。
3. 如果冲突发生在 `index.html`，保留本分支的中文工具栏和 `content-shell` 容器，除非对方新增了前端必要控件。
4. 如果冲突发生在 `assets/styles.css`，保留本分支的整体区域结构，避免把旧的 `.rank-card` / `.source-chip` 大卡片样式合回来。
5. 不要把 `artifacts/ui-screenshots/` 提交进仓库；它只是本地视觉验收截图。

## 验收命令

```powershell
pwsh -NoLogo -NoProfile -Command "npm run check"
pwsh -NoLogo -NoProfile -Command "npm run serve"
```

打开：

```text
http://127.0.0.1:8080/
```

合并后至少检查：

- 最近72小时、月度都能切换。
- 歌曲榜、歌手榜、歌曲索引、视频都能切换。
- 搜索歌曲、歌手、频道、视频标题都能过滤。
- 同次数歌曲/歌手显示并列排名。
- 歌曲索引不显示排行榜名次。
- 来源展开/收起正常，时间戳链接仍是 YouTube `&t=<seconds>s`。
- 历史快照切换后 summary 显示历史快照提示。
- 320x700、390x844、768x1024、920x900、1366x768、1920x1080 无横向溢出。

## 本轮已完成的验证

- `npm run check` 通过，当前覆盖 26 个测试。
- 本地静态服务器 `http://127.0.0.1:8080/` 可打开。
- Chrome headless 截图检查主要断点无横向溢出，390x844 首屏超过 6 条榜单行。
- 已生成本地截图：
  - `artifacts/ui2-final-verified/1920x1080.png`
  - `artifacts/ui2-final-verified/1366x768.png`
  - `artifacts/ui2-final-verified/920x900.png`
  - `artifacts/ui2-final-verified/768x1024.png`
  - `artifacts/ui2-final-verified/390x844.png`
  - `artifacts/ui2-final-verified/320x700.png`

## 已知限制

- 视频封面使用 YouTube 稳定缩略图 URL；网络慢或加载失败时会切到内置占位图。
- 歌曲索引按现有 `makeSongSortKey()` 和标题首字符分组，不新增日文假名转写依赖。
- 本分支不改抓取、数据 schema 或 GitHub Pages workflow；上线仍通过 main 分支 GitHub Pages 自动部署。
