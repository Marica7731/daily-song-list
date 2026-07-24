# daily-song-list 交接清单（2026-07-24）

这份文档是压缩上下文后的唯一交接入口。新任务先读本文件、`docs/repo-operations.md`、`docs/ui-spec.md`，再读代码和线上接口。不要根据旧截图直接判断线上现状。

## 当前边界

- 仓库：`https://github.com/Marica7731/daily-song-list.git`
- Windows 轻量编辑和 Git 收口：`G:\\codex-work\\daily-song-list-runtime-fix-20260723`
- 当前分支/HEAD：`main` / `c7610a34`（已与 `origin/main` 对齐）。工作树已有未跟踪的 `.workbuddy/`、`scripts/db/__pycache__/`、`server/__pycache__/`，均不要触碰或提交。
- 大 SQLite、来源抓取、来源合并和长时间构建优先交给 Mac；不要使用 C 盘。Mac 路径、SSH、self-hosted runner 和断点续跑规则见 `docs/repo-operations.md`。
- 用户要求：先修可验证的搜索/交互热路径，再处理脏数据；截图矩阵暂缓到目标集中完成，不能让截图阻塞代码检查。

## 截图、真实浏览器复现与交接补充（2026-07-24）

本节把用户截图中的原始要求和本轮实际线上复现写成可执行验收，不把旧的自动化填值结果当成交互已通过。

### 用户截图中的未关闭问题

- 收录 tag 仍被用户确认“线上问题仍在”。必须重新审计榜单顶层、展开 drawer、来源卡片和静态 fallback；外部 VSinger Moment 证据不能显示 `已收录`，只有本地基线、人工补录或明确来源会话已导入 runtime 的记录可以显示。
- Web 与 H5 的页码输入框仍无法可靠完成“点击、聚焦、选中、清空、输入、提交”。用户截图引用的现场图片为 `file:///D:/Download/剪贴板图片 (22).jpg`；该路径只作为用户提供的证据定位，不代表当前 Windows 工作树可以访问或应被复制。
- Naraetan 脏曲目现场证据引用 `file:///D:/Download/剪贴板文本 (55).txt`、`file:///D:/Download/剪贴板图片 (23).jpg`、`file:///D:/Download/剪贴板图片 (24).jpg`。疑似条目包括：`魔法少女ごっこ遊び`、`32]「ニャーーーーー`（方括号/引号的确切字节必须以原始 JSON/HTML 为准）、`feat.flower`、`龍角散 高音を出すとおでこが痒くなる`、`飾り棚`、`風邪気味かもしれない`。这些是待核对的原始解析结果，不是可直接写入生产清洗表的规范名称。
- 用户要求先扫描全库只出现 1 次的歌曲，输出 video ID、原始 JSON/HTML、频道、歌手和时间点，再决定是否处理；未记录歌手的歌曲必须后置合并，不能先删除或批量改名。
- 同名歌曲有多个歌手时，按 occurrence 次数降序取第一个已知歌手，`未記載` 只能最后兜底。用户举例 `逆光`、`逆光 - Ado`、`逆光 - Ado（Ado）`，但括号、emoji、`feat.` 边界和官方歌手名必须保守处理，不能对全库做无条件正则清洗。
- `フィナーレ` 必须先由原始证据确认标准标题并检查是否应为 `フィナーレ。`；“只有两个来源视频”要分别核对原始数据、canonical merge、过滤规则和预览上限，并扫描是否还有其他只有两个视频的歌曲，不能把它当成特殊 UI 规则。

### 本轮线上交互证据

查询时间约为 `2026-07-24 10:35 +08:00`，入口为 `https://ytb-song-rank.culua.com` 的真实浏览器页面，使用了 DOM 命中检查和 CUA 坐标输入；截图矩阵仍暂缓，但真实交互验证不能暂缓。

- Desktop `?range=all&view=songs`：页码输入可被命中并聚焦，但执行真实 `Ctrl+A` 后输入 `5`，值实际变为 `15`；按 Enter 后进入第 15 页。这证明此前仅使用 Playwright `fill("5")` 的通过结果不能作为选中/清空验收。
- H5 390×844：顶部和底部各有一个页码输入；输入框可命中且可聚焦，真实 `Ctrl+A` 后输入 `5` 同样变为 `15`。用真实坐标点击“选页”后摘要进入第 15 页，说明提交动作存在，但选中/替换当前值的语义仍不可靠。
- H5 线上实际计算尺寸曾为约 `94×38`，左右翻页按钮约 `28×28`；根因审计发现通用 `input:not([type="checkbox"]):not([type="radio"])` 的 specificity 覆盖了 `.page-select input` / `.page-jump input` 的宽高和 padding。页码输入必须恢复为与分页控件同级的尺寸，保留输入加“选页”，不能改成下拉。

### 发布后复测证据（2026-07-24 10:46 +08:00）

- `6b14d2fd` 已推送到 `main`；VPS 静态发布 workflow `30062331363` 成功，远端 checkout、nginx reload 和 index 资源引用校验均通过。GitHub runner 对公开静态文件的探针有 warning，但 VPS checkout verification 通过，不能把 warning 误记为发布失败。
- 线上 index 已引用新版本化资源 `h989054f8a263`。Desktop 页码输入实际为 `type=text`、约 `52×30`；真实点击后输入 `5` 并按 Enter，URL 为 `?range=all&page=5`，摘要为 `第 5 / 1316 页 · 121-150 / 39475 首歌曲`。
- H5 `390×844` 顶部和底部页码输入均约 `46×28`，pointer 命中正常；真实点击后输入 `5` 并点击“选页”进入 `第 5 / 1974 页 · 81-100 / 39475 首歌曲`。重新打开第 1 页后，真实 `Ctrl+A` 输入 `6` 的值为 `6`，不再追加为 `16`。
- 收录 tag 线上样本：`youtube_channel_discovery` 记录显示 `已收录`；`vsinger_moment_http` 的 `水沢オペラ / Opera Ch.`、`もかん ch / Mokan`、`みたにみく- VTuber -` 不显示 tag。顶层样本符合语义，但展开 drawer、来源卡片和静态 fallback 的全路径一致性仍需后续用明确 counterexample 收口。

### 来源会话并行状态（用户截图回报，未在本轮独立查询）

- ebakyouka batch142 已生成可复核 accepted increment：32 个视频、692 个 occurrence/song 记录，时间字段覆盖；无时间候选/无歌曲来源未进入 accepted。该会话已清理 vps-shadow 与 G staging，只保留 D 侧 accepted increment、manifest、audit/validation/report 和小型远程证据。
- 该会话随后继续处理 UCrF92，使用第二台 `vps-jp`，先验证 45-ID seed 再上传轻量运行包；主会话不得重复启动同来源或导入 partial 产物。来源续跑仍遵守 checkpoint 不加 `--fresh`、大任务放 Mac/self-hosted runner、生产导入前人工审查。

## 线上事实（2026-07-24 本轮查询）

查询入口：`https://ytb-song-rank.culua.com`。

- `/healthz` HTTP 200，`status=ok`，`builtAt=2026-07-23T14:19:53Z`。
- 当前动态 runtime 计数：`videos=45169`、`songs=44416`、`occurrences=595180`、`ranking_rows=257222`、`source_occurrences=1940438`、`channel_metadata=1156`。
- 歌曲榜 `q=Noa Polaris&searchFields=all` HTTP 200，返回 3 首；空格已被 API 接受并按 URL 编码传输。
- 频道榜必须使用 API `view=vtubers`，`q=Noa Polaris&searchFields=channel` HTTP 200，返回 1 个频道；结果同时包含频道名、handle、channel ID 和 URL。
- 内部页面视图名 `vtuberRank` 与 API 视图名 `vtubers` 不要混用。错误 view 直接请求 API 会得到 400，应在前端或测试中覆盖这个映射。
- 以上只证明当前动态 API 的能力，不证明所有浏览器输入、筛选状态、分页和展示标签已经正确。

### 已确认但尚未修复的线上缺口

- `nicheOnly` 和 `hideUnknownArtist` 当前在前端 state 中存在，但 Runtime API 请求没有发送这两个参数；线上带参数和不带参数的响应体与 `totalCount` 相同。这是实际功能缺陷，不是截图误差。
- 相关入口：`assets/app.js` 的 `shouldUseRuntimeApiForRequest` 和 runtime request 参数组装，约 3555-3580 行。修复后必须增加“勾选前后请求/结果变化”的回归测试。
- 线上 API 对错误字段和错误 range 返回 400；不要用前端静态 fallback 掩盖请求错误。
- `deploy/vps2/nginx-staging.conf` 的 upstream timeout 当前为 30 秒。短词或全字段搜索会走大表 LIKE、返回多 MB payload，存在 504 风险；优先收紧列表 payload、短词查询保护和详情分离，不要只延长 Nginx timeout。

## 已上线的基线

- `78b7303d fix: 收口 VTuber 榜单展开和响应式布局`
  - 折叠频道行不再外透代表歌曲。
  - 频道标题下显示 handle。
  - 展开歌曲桌面三列、H5 两列，固定卡片轨道并利用序号下方空间。
  - 展开歌手使用最高频的第一个已知歌手，无已知歌手才使用首个兜底值。
  - 展开日期按 `YYYY-MM-DD` 输出。
- `a157d403 ci: 延后截图验收不阻塞代码检查`
  - `check-code` 不再因延后的截图矩阵阻断基础检查。
- 静态和 Pages 发布此前已成功，线上动态 API 本轮仍为健康状态。后续如果改动用户可见代码，必须重新走既有发布入口并做线上验收，不得只停在本地 commit。

## 本轮必须处理

### A. 搜索、筛选和分页热路径

- [ ] 真实浏览器验证输入框：Web 与 H5 的页码输入框必须能点击、聚焦、选中、清空、输入和提交。检查是否有透明层、`pointer-events`、`user-select`、焦点恢复或全局 click handler 抢走事件。
- [ ] 页码输入尺寸与左右翻页按钮同级，不要出现突兀的大输入框；输入和“选页”保留，禁止改成下拉。
- [ ] 歌曲榜支持“歌手 + 歌曲”组合查询，空格必须保留在输入值并以编码形式进入 URL/API；不要用 `trim` 或事件处理误删内部空格。
- [ ] “全不选搜索全部字段”语义保持：歌名、歌手、频道、视频和来源上下文都可匹配；字段勾选不能错位，不能只改 chip 而没有同步请求参数。
- [ ] 频道筛选同时匹配 `channelHandle` 和频道显示名；当前 `vtuberRank` 前端请求固定走 `searchScope=channel` / `searchFields=channel`。
- [ ] 查询失败时保留上一页可用结果，但必须区分 400、404、504 和静态兜底错误；不能把旧数据伪装成新查询结果。
- [ ] 歌曲榜来源链接、视频标题、时间戳链接统一新标签页打开：使用真实 `<a target="_blank" rel="noopener noreferrer">` 或等价可访问实现。
- [ ] 查询按钮不要显示孤立数字徽标/信号点；勾选状态直接在筛选项上表达，筛选弹层位置和宽度不得错位。

### B. VTuber 展示与布局

- [ ] 折叠前只显示频道、handle、主排序指标和展开动作；不展示外层代表歌曲，也不要重复显示歌曲数/视频数。
- [ ] 展开后只在一个地方显示歌曲数量，歌曲数量下面不能出现大块空白；桌面歌曲卡片一行三首，H5/平板一行两首，卡片等宽等高。
- [ ] 序号下方的空白继续用于歌曲卡片区域；长频道名、长歌名、长歌手只截断或换行，不撑大卡片、不制造横向滚动。
- [ ] 展开分页为 Web 30、H5/平板 20；翻页、输入页码后封面、歌手、次数和日期不能消失。
- [ ] H5 不显示含义不清的“展开显示...”文案；只使用明确的 `展开`、`收起`、`全部 N 首` 等语义。
- [ ] 频道头像双端使用统一尺寸、对齐和 fallback 空间；头像失败不能导致文字列或卡片高度跳动。截图验证暂缓，但 DOM/CSS 结构和浏览器尺寸探针先完成。

### C. 收录 tag 语义（当前仍未收口）

- [ ] “已收录”只表示本地基线、人工补录或明确的来源会话已经导入 runtime 的记录。
- [ ] VSinger Moment/外部网站来源只表示外部证据，不能因为有来源就显示“已收录”。
- [ ] 用户从来源会话导入并进入本地曲库的记录才算已收录；UI 不能只看 `sourceUrl`、`knownSourceType` 或任意 occurrence 存在就打 tag。
- [ ] 同一歌曲混有 Moment 和本地/来源会话记录时，tag 按歌曲或记录的收录来源判定，不能把整首歌粗暴标为已收录。
- [ ] 检查榜单顶层、展开 drawer、来源卡片和静态 fallback 是否各自重复计算 tag；统一到一个可测试的 presentation model。

### D. 脏数据和歌手归并

- [ ] 新增只读审计：扫描全库只出现 1 次的歌曲，先输出歌曲、出现的 video ID、原始 JSON/HTML 证据、频道、歌手、时间点和疑似脏数据原因，不直接删除。
- [ ] Naraetan 指定视频按原始 JSON/HTML 对比。用户列出的以下条目先作为疑似错误清单：`魔法少女ごっこ遊び`、`32】「ニャーーーーー`、`feat.flower`、`龍角散 高音を出すとおでこが痒くなる`、`飾り棚`、`風邪気味かもしれない`。确认这些条目来自同一视频的错误解析后，按视频级修复，不能只删排行榜展示值。
- [ ] 先做低误伤的全局同名歌手兜底：同一 canonical song 下有多个非空歌手候选时，按 occurrence 次数降序取第一个展示；`未記載` 只作为没有任何已知歌手时的最后兜底。
- [ ] 例：`逆光`、`逆光 - Ado`、`逆光 - Ado（Ado）` 应在证据确认同一首歌后合并展示为出现次数最多的规范候选，不能把全库所有括号内容无条件删除。
- [ ] 歌手规范化继续遵循官方名称：Ado 装饰/emoji 留 `Ado`；`ヨルシカ`、`yorushika`、`ヨルシカ（yorushika）`优先归到官方 `ヨルシカ`；`DECO27` 等以官方名称为准，feat 主体和合作歌手按实际歌曲保留。
- [ ] 已合并的歌曲不能再显示 `未記載`。这一规则必须同时作用于构建层、API response model、静态导出和 H5/WEB 展示层。
- [ ] `フィナーレ` 先核对原始歌曲名称和标准写法，修正为 `フィナーレ。`；同时调查它只有 2 个来源视频是否是数据不足、标题分裂、过滤规则还是预览上限导致。不能默认它是特殊歌曲。
- [ ] “花になって”与“花になって - Be a flower”只有在网络/原始证据确认是同一录音或同一标准曲目时才合并，避免误合并不同歌曲。
- [ ] 台 V、AI 刷数据频道和明确屏蔽频道沿用已有 blocked-channel 规则；本轮只审查规则是否真正作用到动态构建和静态 fallback，不直接从 UI 隐藏。

### E. 来源、日期和动态 DB

- [ ] 来源 checkpoint 必须先审查再导入。`songCoverage=count-mismatch`、`songUnique=135` 对 `observedSiteSongs=71890` 的旧 manifest 不能当作完整歌曲目录；stream/singer 完成也不代表 song catalog 完整。
- [ ] 续跑保留原目录中的 `manifest.json`、`checkpoint.json`、raw/detail/occurrence/audit 文件，默认不加 `--fresh`；已 imported channel/video 不重复抓。
- [ ] 来源补跑和大 DB 构建优先 Mac，产物放 Mac/G，不放 C；source worker 不自动 import、push 或 deploy。
- [ ] 缺失 `publishedAt` 的视频另做可重跑日期获取任务，建议复用当前仓库 GitHub Action/self-hosted Mac runner，不新建仓库，除非现有 workflow 无法隔离权限和产物。
- [ ] 继续保留 runtime 性能根因记录：同一视频歌单曾在每个 occurrence 重复序列化，导致 source detail 近 194 万行和慢查询；优化要保持 occurrence 只携带当前 song 的 detail，避免重新引入平方级膨胀。
- [ ] 只有动态 DB build、上传、激活和 `/healthz`/`/api/meta`/关键 rankings 查询全部通过后，才算数据库需求上线；静态 JSON 只能作为兜底。

### 来源 checkpoint 续接表

| 来源/批次 | 当前证据 | 续接动作 |
| --- | --- | --- |
| SoraOtoha / batch141 | candidate 128，checkpoint completed 94，本批 18 videos / 336 occurrences | 排除已完成 94 个 ID，约剩 34 个；原始 checkpoint 不在当前 D 产物中，先恢复或重建排除集 |
| ebakyouka / batch142 | candidate 464，completed 142，本批 39 videos / 731 occurrences | 排除 142 个 ID，约剩 322 个；不能把 accepted increment 当完整 checkpoint |
| UCrF92d / batch143 | candidate 234，completed 45，本批 5 videos / 88 occurrences | 排除 45 个 ID，约剩 189 个；先恢复 checkpoint/排除集 |
| UtenHiyori / batch144-150 | candidate 327，completed 262，但最新六个 shard detail/occurrence 为 0 | 不要盲重跑；提高分页范围并更换详情获取路径，保留 262 个 seed completed ID |
| KohanaLam / batch129 | candidate 225，checkpoint details 31，本批 28 videos / 261 occurrences | 先核对后续 batch139 queue refresh，不从 batch129 重复抓 |
| Asaxmayo / batch109 | candidate 53，details 17，occurrences 99，accepted 0 | 当前产物缺 checkpoint，先恢复远端 checkpoint 后续跑 |

审计还发现 D 盘有 202 个 manifest，其中 51 个明确为 `reachedEnd=false`；其中约 10 个是 queue-refresh 记录，不是新来源任务。G 目标工作树只有旧的 27 个 accepted 文件，D 盘最新 batch115+ 增量尚未导入 G。以上是本地 checkpoint 审计结果，不等于线上任务当前状态，续跑前仍要查询真实 runner/Actions 状态。

## 前端主要代码地图

| 文件 | 重点函数/选择器 | 责任 |
| --- | --- | --- |
| `assets/app.js` | `bindQueryOverlayEvents`、`sanitizeQueryDraft`、`searchScopeForView`、`searchFieldsForView`、`requestFiltersForView` | 输入法/空格、字段筛选、内部 view 到 API view 映射 |
| `assets/app.js` | `renderVtuberRank`、`renderRankRecord`、`renderRecordContent`、`renderRankSide` | 榜单行、数量、tag、handle、收起/展开 |
| `assets/app.js` | `renderArtistSongGroup`、`artistLabelForSongGroup`、`sourcePublishedText`、`dateParts` | 展开歌曲卡片、歌手兜底、来源日期 |
| `assets/frontend-utils.js` | `sanitizeQueryDraft`、`searchTokens`、`matchesSearch`、`sourcePresentationModel`、`responsiveListPageSize` | 查询语义、来源模型、分页尺寸 |
| `assets/ranking-utils.js` | `canonicalizeArtistName`、`selectDisplayArtist`、`buildArtistSongGroups` | 歌手展示兜底；完整全局归并仍需数据审计 |
| `assets/styles.css` | `.rank-row`、`.rank-row-vtuber`、`.rank-content`、`.rank-side`、`.artist-song-drawer`、`.artist-song-group-vtuber`、`.pagination`、`@media (max-width: 720px)` | 对齐、固定卡片、分页输入、无横向溢出 |
| `index.html` | `#queryInput`、分页输入结构、query dialog | 初始 DOM、可聚焦输入、搜索和筛选入口 |
| `server/song_rank_api.py` | `normalize_search_fields`、`search_scope_from_fields`、ranking query builders | API 搜索字段、scope、分页、动态 response |
| `scripts/update-asset-version.js` | `currentAssetVersion` 相关资源指纹 | 版本化资源和边缘缓存；修改后需查动态资源引用 |
| `scripts/validate-blocked-vtuber-channels.js` | blocked channel 规则校验 | 屏蔽频道配置合法性 |

## 验收顺序

1. 先在本地或 Mac 构建最小测试数据，验证页码输入聚焦/提交、空格查询、字段勾选和 tag presentation model。
2. 对单次歌曲和 Naraetan 视频只做审计报告，主会话复核原始证据后再生成清洗规则和数据 diff。
3. 对 `フィナーレ。` 做标题/来源/视频数回归 fixture，确认是数据问题还是通用预览逻辑。
4. 运行 `npm test`、`node scripts/check-js-syntax.js`、`npm run check`、`git diff --check`；截图矩阵按用户要求后置。
5. 只 stage 本轮相关文件，commit、push；有用户可见改动时按既有 workflow 发布并查询 run 状态。
6. 线上至少验证 `/healthz` 200、`/api/meta`、歌曲组合查询、频道 handle/名称查询、分页输入后的实际 URL/结果，以及来源 tag/日期/视频链接行为。

## 为什么这批问题耗时较长

1. API 已支持空格和 channel scope，但浏览器输入、筛选字段、内部 `vtuberRank`/API `vtubers` 命名和旧缓存是不同层，必须逐层实测。
2. 折叠频道行、展开歌曲 drawer、歌曲榜来源卡片和静态 fallback 不是同一条渲染路径，数量、歌手和收录 tag 可能在不同层重复计算。
3. 来源数据约有 194 万 source occurrence，旧的逐 occurrence 重复歌单 detail 会放大构建和查询耗时；不能用 Windows 主线程盲跑全量。
4. 部分来源 manifest 只完成 stream/singer，不代表 song catalog 完整；必须区分 checkpoint 可续跑和可安全导入。
5. 用户截图中的“只有两个视频”“未记载”“错误歌名”既可能是原始数据错误，也可能是 canonical merge、预览上限或展示兜底错误，必须保留原始证据再修。

## 交接纪律

- 新任务先读本文件，回复时先列本轮将处理的清单和验收命令。
- 子智能体只能只读审计或在明确分支实现；主任务统一审核 diff、commit、push、deploy。
- 不要触碰 `.workbuddy/`、C 盘、未确认仍在运行的来源输出目录和用户未提交改动。
- 未完成项不能写成已上线；如果只完成代码/测试而未发布，必须明确“交付未完成”。
