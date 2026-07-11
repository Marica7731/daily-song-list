# UI 榜单重构合并交接

更新时间：2026-07-11

## 本分支改了什么

本分支只做前端展示重构，不改抓取、整理歌、GitHub Actions、JSON 数据格式或现有数据文件。

主要目标是把旧的“白色大卡片列表”改成更适合长期浏览的榜单信息架构：

- 歌曲榜/歌手榜：统一白色面板内的紧凑 `rank-row` 行。
- 来源展示：折叠状态只显示一个来源摘要，点击行、展开按钮或“另有 N 个来源”后显示完整时间戳来源。
- 并列排名：同收录次数显示相同名次，使用 competition ranking，例如 `3、2、2、1 => 01、02、02、04`。
- 歌曲索引：`歌曲索引` 不再显示排行榜名次，按索引分组展示歌曲。
- 视频视图：独立 16:9 封面网格，默认只显示前 3 首歌，可展开其余歌曲。
- 顶部和工具栏：中文文案、sticky 筛选栏、紧凑统计 chip、宽页面容器。

## 修改文件清单

- `index.html`
  - 中文化顶部、范围 tab、视图 tab、搜索框和历史快照下拉。
  - 移除旧的 `videoTemplate` / `rankTemplate`，由 `assets/app.js` 直接按视图创建 DOM。
  - 主内容容器改为 `#videoList.content-shell`。

- `assets/app.js`
  - 重构 `render()`，按 `songRank` / `artistRank` / `songAz` / `videos` 分流渲染。
  - 新增 `buildCompetitionRanks()`，歌曲榜和歌手榜共用并列排名。
  - 新增来源展开状态 `state.expandedRows`，视图、范围、搜索、快照变化时清空。
  - 新增 `renderRankRecord()`、`renderSourcePreview()`、`renderSourceDrawer()`、`toggleSourceDrawer()`。
  - 新增 `renderSongIndexView()`、`groupSongIndex()`、`songIndexBucket()`，歌曲索引不再复用排行榜行号。
  - 重写 `renderVideo()`，视频卡片默认显示 3 首歌，超过后用 `toggleVideoSongs()` 展开。
  - 时间戳链接仍通过 `youtubeTimeUrl(videoId, seconds)` 生成，不改变跳转语义。

- `assets/styles.css`
  - 按区域重写为 tokens、base、header、sticky toolbar、summary、ranking rows、source drawer、song index、video grid、responsive、accessibility。
  - 页面最大宽度改为 `1520px`，桌面端左右边距使用 `clamp(12px, 2vw, 32px)`。
  - 榜单行用固定列结构和 `min-width: 0`，避免长日文/英文标题撑破布局。
  - 移动端 tab 横向滚动，390px 宽度下无横向溢出。

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

- 最近72小时、近30天都能切换。
- 歌曲榜、歌手榜、歌曲索引、视频都能切换。
- 搜索歌曲、歌手、频道、视频标题都能过滤。
- 同次数歌曲/歌手显示并列排名。
- 歌曲索引不显示排行榜名次。
- 来源展开/收起正常，时间戳链接仍是 YouTube `&t=<seconds>s`。
- 历史快照切换后 summary 显示历史快照提示。
- 390x844、768x1024、1366x768、1920x1080 无横向溢出。

## 本轮已完成的验证

- `npm run check` 通过。
- 本地静态服务器 `http://127.0.0.1:8080/` 可打开。
- Playwright 截图检查无控制台错误、无横向溢出。
- 已生成本地截图：
  - `artifacts/ui-screenshots/1920-song-rank.png`
  - `artifacts/ui-screenshots/1366-song-expanded.png`
  - `artifacts/ui-screenshots/768-artist-rank.png`
  - `artifacts/ui-screenshots/390-song-index.png`
  - `artifacts/ui-screenshots/1366-videos.png`
  - `artifacts/ui-screenshots/390-search-results.png`
  - `artifacts/ui-screenshots/390-no-results.png`
  - `artifacts/ui-screenshots/768-history-snapshot.png`

## 已知限制

- 视频封面使用 YouTube 稳定缩略图 URL；网络慢或加载失败时会切到内置占位图。
- 歌曲索引按现有 `makeSongSortKey()` 和标题首字符分组，不新增日文假名转写依赖。
- 本分支没有发布到线上，也没有改 GitHub Pages workflow。
