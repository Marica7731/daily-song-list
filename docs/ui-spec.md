# Daily Song List UI 规范

本规范约束静态站当前 UI。后续 UI 改动应先更新本文件，再同步 `assets/styles.css`、浏览器验证脚本和 README 截图。

## 断点与容器

- 手机：`<= 720px`。首屏优先展示状态、范围切换、搜索入口、筛选状态、摘要、紧凑分页和榜单前几行。
- 平板：`721px - 919px`。采用紧凑榜单列，不套用桌面四列密度。
- 桌面：`>= 920px`。主内容宽度使用 `--page-max`，榜单和工具栏横向对齐。
- 页面横向留白来自 `--page-x` 和 `--content-gutter`。禁止用负 margin 或固定宽度制造横向滚动。

## 设计变量

统一变量集中在 `assets/styles.css` 的 `:root`：

- 背景：`--page-bg`、`--card-bg`
- 文字：`--text-main`、`--text-muted`、`--text-soft`
- 分隔：`--divider`、`--divider-strong`
- 品牌：`--brand`、`--brand-strong`、`--brand-soft`
- 警告：`--warning`、`--warning-soft`
- 间距：`--space-1` 4px、`--space-2` 8px、`--space-3` 12px、`--space-4` 16px、`--space-6` 24px
- 圆角：`--radius-control`、`--radius-panel`、`--radius-pill`
- 阴影：`--shadow-soft`

字体字重只使用 400、500、600、700。不得再引入 750、780、850、900 等不稳定字重。

## 榜单行

- 手机列宽：排名约 36px，内容列自适应，次数列约 58px。
- 歌曲名是最高层级，15px-16px，最多两行。
- 歌手、来源、频道和趋势是次级信息，使用 12px-13px。
- 次数和趋势固定在右侧 `rank-side`，不得随标题长度移动。
- 整行不可作为 YouTube 大链接；时间戳、频道和视频标题分别是独立链接。

## 来源披露

歌曲榜和歌曲索引使用同一模型：`FrontendUtils.sourcePresentationModel`。

- 0 个唯一来源视频：内容列显示弱化 `无来源`，没有按钮，没有 drawer。
- 1 个唯一来源视频：内联显示时间点、频道、复制歌单按钮。若同一视频有多个时间点，只展开额外时间点，不打开 drawer。
- 2-3 个唯一来源视频：全部内联显示，末尾提供复制同一首歌全部来源链接按钮。
- 4 个以上唯一来源视频：默认内联前 3 个，显示 `查看其余 N 个来源`。点击一次后显示所有剩余来源，按钮变为 `收起其余来源`。不得再出现二次 `查看更多来源`。
- Drawer 只用于 4+ 的剩余来源，宽度必须占满榜单可用宽度，内容高度由实际内容决定。
- 歌手榜仍保留曲目展开逻辑，不使用歌曲来源内联模型。

## 分页

- `visiblePageTokens` 只返回 `page` 和非交互 `ellipsis`。省略号不可点击，不含跳转目标。
- 手机顶部普通榜单使用邻页 stepper：上一页图标、上一邻页、当前页下拉、下一邻页、下一页图标。
- 手机歌曲索引顶部合并为 `index-toolbar`：首字母选择 + 当前页下拉 + 前后页图标，不显示邻页数字。
- 手机底部保留首页、上一页、页码选择、下一页、末页，以及每页数量控制。
- 桌面/平板可继续使用数字页码和非交互省略号。

## 查询面板

- `queryDialog` 是唯一搜索与筛选入口。
- 搜索输入固定在 tab 上方，始终可见。
- 面板内部有 `搜索` / `筛选` 两个 tab。搜索 tab 包含最近搜索和建议；筛选 tab 包含内容范围、排行条件、显示设置和历史快照。
- 历史快照默认折叠，展开后显示日期和时间选择。
- Footer 只有左侧重置和右侧主操作，结果数量写入主按钮文本。

## 歌曲索引

- 手机端不使用重卡片式索引导航。
- `index-toolbar` 固定在顶部区域下方，合并首字母选择和页码。
- `全部` 桶使用轻量 24px 左右分隔标题；指定桶不重复显示大标题。
- 基础行高约 54px；有内联来源时由内容自然增加，不使用固定高度遮挡。

## 视频页

- 网格使用 `repeat(auto-fit, minmax(280px, 1fr))`。
- 手机视频卡片使用缩略图 + 内容双列，歌单列表占满卡片宽度。
- 展开长歌单后顶部和底部都提供收起按钮。

## 验证与截图

本地验证必须覆盖：

- `npm test`
- `node scripts/check-js-syntax.js`
- `npm run check`
- `npm run version:assets`
- `CODEX_SCREENSHOT_TAG=normalized-ui-v1 npm run verify:local -- http://127.0.0.1:8080/`
- `npm run screenshots:readme -- http://127.0.0.1:8080/`

README 截图矩阵至少包括：

- 桌面歌曲榜、月度榜、视频页、查询面板、展开来源、中页分页。
- 手机歌曲榜、歌手榜、歌曲索引、索引中页、索引末页、视频页、展开视频、active query strip、query recent、query suggestions、query history、展开来源。
- 手机 320px 分页。
- 手机 1 来源、3 来源、4+ 来源收起和 4+ 来源展开。
