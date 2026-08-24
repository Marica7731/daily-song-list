# daily-song-list 主线：增量数据库与安全发布迁移

## 2026-08-22 WDC 服务端受限构建与精确清理（当前 active goal）

- 目标：把 next-serving-v3 的重型 PostgreSQL 物化从 Windows/Mac 移到 WDC 受限沙箱，完成唯一 latest-head 发布、公网 API/浏览器验收、10 分钟稳定观察，并清理本轮精确归属且已闲置的构建垃圾。
- 架构边界：VPS2 仅提供只读 PostgreSQL/有界 relay；Windows/Mac 不再生成或上传全量 SQLite/bundle；WDC 使用带 source commit/content/revision 身份的稀疏代码输入执行物化、serving build 和本机原子激活。
- 强制容量门禁：构建临时卷固定上限 `32,000,000,000` bytes，位于同文件系统且项目树外的 exact owner-marked `/var/tmp/dsl-wdc-volume-<run>-<attempt>`；最终 release `< 16,000,000,000` bytes；WDC 宿主在写入前、构建中里程碑和激活前均须保留 `>= 20,000,000,000` bytes；项目逻辑占用与实际分配占用均 `< 40,000,000,000` bytes。任一测量缺失、达到上限或身份不一致都在生产写入/激活前 fail closed。
- 强制资源门禁：构建 cgroup `MemoryMax <= 2.5GB`、`MemorySwapMax <= 1GB`，限制 CPU/IO/PIDs；relay 单 run 累计 wire bytes `< 16,000,000,000`、连接数 `<= 2`。不得用增大 timeout、无界复制、完整 clone 或清理无关目录换取完成。
- 激活与回滚：不允许压缩 archive 与完整解压 release 同时占用两份空间；只在同一文件系统以 exact owner manifest/realpath/CAS 进入 `releases/<sha>`，保留 current/previous，完整线上门禁通过后才回收精确旧 release。
- 清理授权：仅删除可由 run/owner marker、Git worktree/branch、进程引用和 clean status 共同证明为本轮产生且已闲置的 Mac exact roots、本地 worktree/临时脚本、VPS2 relay roots 与 WDC transient。含用户改动、仍被合法 run 使用、归属不明或不在允许根下的对象一律保留。
- 禁止事项：不修改 DNS、canonical PostgreSQL 内容、生产歌曲数据、共享 index、共享 dirty checkout 或无关目录；不以 green workflow 或 `/healthz` 单点代替真实 release/meta/ranking/source/browser 验收。
- 当前状态：`wdc-meta-transport-fix`。PR `#87` 已由 CI `32563016694` success 后 squash merge 为 `5f58ef45f124bde32aef9b43bdd5759ce6135ec8`，合并后 Check code `32563095113` success 并真实输出 `CODEX_NODE_TESTS_SKIPPED reason=no-node-input-changes`。合法 core `32562788289` success 后 latest main=`86835c195b95115df4412e0410da1a6a629d7d16`；accepted `32563716923` 已激活 `accepted_32563716923_1`（parent=`accepted_32561332302_1`，241 videos/3943 occurrences，content=`7f724ceb7ce64731fc36eed42a4d3b2f53fa53a06381dc4d8c2560bdf9171fc2`，`PG_ONLINE_HEALTH_META_OK`）。唯一 latest-head WDC `32564174900` 在任何 WDC/relay 写入前 failure，正在同轮修复；线上仍为旧 release，交付未完成。
- 2026-08-22 16:18 Asia/Taipei：PR `#86` 已由 CI `32561292308` success 后 squash merge 为 `d2b098bc365ea4e0e7886789495e6777c85582b9`；latest accepted `32561332302` 已激活 `accepted_32561332302_1`（parent=`accepted_32559614201_1`，242 videos/3948 occurrences，content=`490d72ec3a1f62c64192cc8dd80846798655ee328f2711f3c7ea4d7a33c9bb6e`，`PG_ONLINE_HEALTH_META_OK`）。旧-head Mac WDC `32561048339` 已在 checkout 阶段精确取消且 cleanup success。随后 Check code `32561363075` 因 README 的 WDC 文档改动被误判为根 Node 输入，执行陈旧根套件得到 806 tests/727 pass/77 fail；本轮以 fail-closed README 章节分类器修复：仅 `## WDC server-side release workflow` 到 `## UI Screenshots` 之间的变化交给专用 next-serving gate，README 其他区域与所有真实前端/Node 输入仍执行完整根套件。
- 2026-08-22 17:12 Asia/Taipei：WDC `32564174900` 的 Ubuntu gate success，但 controller 在 `WDC_LATEST_HEAD_CONFIRMED` 与 `WDC_BUILD_LOGIC_SHA` 后精确 40 秒返回 exit 124；下一条唯一命令是 VPS2 `/api/meta` identity probe，其内层 curl 合同允许 60 秒而通用 `vps2()` 外层仅允许 40 秒，导致外层先杀死只读探针。Actions/controller cleanup success；WDC control/32GB volume/build/tunnel units均不存在，VPS2 relay未创建，WDC未写入。最小修复为专用 75 秒 identity envelope，且只对 curl timeout/外层 timeout/SSH transport（28/124/255）重试一次；HTTP、解析和身份错误继续 fail closed，通用 40 秒 SSH 与 9 小时总 timeout 均不放宽。
- 已完成实现/验证：relay 累计 16GB 与并发 2 连接门禁、WDC 32GB loop/cgroup/20GB reserve supervisor、server-local materialize/build/activate、incoming owner 断线清理、latest-main no-write、激活前后 source triplet、发布前 exact data gate、同协议前后延迟、10 分钟观察和 current/previous 回滚保留。临时卷现固定在同文件系统的 owner-marked `/var/tmp`，项目逻辑/实际字节双门禁避免稀疏镜像把项目逻辑占用顶过 40GB。next-serving `204/204`、新增 relay/storage/data/workflow/latency `13/13`、3 个 workflow YAML 的 `22` 个 shell block、Python/shell 语法均通过；WDC 真实 `/var/tmp` 64MiB loop 冒烟确认 project/volume device 均为 `2050`、项目逻辑占用保持 `7,611,437,438` bytes；生产版 preflight 对真实项目测得 logical=`7,613,755,792`、allocated=`7,629,680,640`、hostFree=`79,855,972,352`、projectedCopy=`23,747,973,520` bytes，所有 exact probe 均已清理；此前 systemd append/cgroup 冒烟与 3 个哈希锁 wheel 下载亦通过。
- 下一步：完成 VPS2 identity transport 精确回归、全量测试、PR/CI/squash merge；确认 main/accepted 稳定后只运行一个 latest-head WDC，并做公网 API/浏览器验收、10 分钟观察与最终精确清理。

## 2026-08-20 next-serving-v3 WDC 自愈发布（当前权威状态）

- 目标：完成 next-serving-v3 正确性/性能修复、唯一最新-head WDC 发布、真实公网 API/浏览器验收、同协议前后延迟、10 分钟观察与精确清理；未完成部署和公网门禁前不得标记 complete。
- 写集：仅受控 serving worktree 的 materializer、直接回归测试与本状态账本；不碰 DNS、canonical PostgreSQL 内容、生产歌曲数据、共享 index 或无关目录。
- 空间红线：WDC `/opt/culua/ytb-song-rank` 占用 `< 40,000,000,000` bytes 且可用 `>= 5,000,000,000` bytes；大型构建只在 Mac exact run root，运行中不打开临时 SQLite。
- 当前线上：仍为旧 release `3cfb9f8b327534d8f52ec397f2527d849f879708b105d0857de8e5b92d977d85`，因此交付未完成。

### WDC 失败账本（禁止无修复重跑）

| run | head | 失败阶段 | 精确错误/身份 | 对应修复与回归 |
| --- | --- | --- | --- | --- |
| `32368642818` | `d6a2a1e4e265fdf9714dbc36eae679f0305b2eb1` | `affected parent sources`，已完成 `32037/32037` 通用父来源与 `42936/42936` 父视频来源后 | `affected canonical source is missing: all/02bfc2bc89767132736c2e7a`；反算为 legacy ranking-only video `LLe0YJODmFM`，父卡 8 occurrences，本 overlay 删除其中 1 条 | 受影响视频复用严格 ranking fallback，预期 8→7；新增 exact regression；新增全量 affected metadata preflight，并把 affected export 前移到两个大规模 immutable copy 之前 |
| `32376509908` | 同上 | 重复 scheduled run | 旧 head、同一未修复类别，不允许继续 | 已 force-cancel，Mac exact root/relay cleanup 后才允许最新修复 head 唯一重跑 |
| `32381417614` | 同上 | 旧 schedule 在前一任务取消后获得 Mac 并重新物化 | 仍不含本轮修复，必然重复同类失败 | 已于 step 9 精确 force-cancel；exact root 不存在、relay inactive、WDC 未写入 |
| `32392989048` | `5a57f2c540baf8a6713e02b6f945155f4ad78c09` | Mac `actions/checkout@v4`，尚未创建 exact run root/relay | self-hosted workspace 复用的 partial-clone `.git` 已达 37GB（pack 30GB）；fetch 子进程在 `git rev-list --exclude-promisor-objects --alternate-refs` 单核 100% 持续约 27 分钟 | 精确取消且确认 Mac root absent、relay inactive、WDC 未写入；WDC workflow 改用独立 `wdc-release-source` sparse checkout，运行前按 owner/realpath 清理，checkout 后设 1GB fail-closed 门禁并新增 workflow contract 回归 |
| `32393374772` | `5a57f2c540baf8a6713e02b6f945155f4ad78c09` | 合法 core 的 `Checkout controlled core inputs` | 与 WDC 相同的共享 37GB partial-clone；`git rev-list` 持续单核约 100%，阻塞 Mac runner 与后继 WDC | 当前合法 run 不取消；后续 core 改用 owner-marked 独立 `core-update-source`，checkout 后设 5GB fail-closed 门禁并新增 workflow contract 回归 |
| `32399801694` | `5a8971a3f25b75bf4afab7c04ca9d4ce02eaa2d6` | WDC `ubuntu_gate`，尚未进入 Mac/WDC | `test_core_workflow_uses_bounded_isolated_mac_checkout` 找不到 `.github/workflows/update-core.yml`；WDC 两个 sparse checkout 清单未声明新测试依赖 | 在 Ubuntu gate 与 Mac source 两份稀疏清单同时加入 `update-core.yml`，并断言精确出现两次，避免门禁/实际 checkout 漂移 |
| `32400818711` | `61d4d52ecf260894679cf0d0dac6f15efb15b669` | accepted 7D patch 转换，候选构建前 | `video zyngx4g-sy4 occurrence 44 has invalid title`；原始行 `1:07:06 - encore encore encore` 的歌曲标题为空，但同视频还有有效歌曲 | 空/纯空白标题按非歌曲时间戳跳过，不用视频标题伪造歌曲；视频与其他有效歌曲保留，整视频均无有效歌曲时仅跳过该视频，非空损坏标题与整份过滤后空 patch 仍 fail closed；加入精确生产形态转换回归、跳过计数和工作流依赖门禁 |
| `32408693290` | `12ef2063206ebed009ef5de07bac02624f2af8b0` | accepted queued | 同一生产 artifact、未修复转换器，确定会重复上述失败 | 在获得 Mac 前精确取消；修复经 CI 合并后才允许新的 accepted/WDC 运行 |
| `32404690724` | `e8c2f31f7b8ef02900051e1882c857f95df8218a` | WDC 取得 Mac 时 main 已由合法 core 推进到 `61d4d52e` | 旧 event head 只完成 7d 小组合、exact root 约 131MB；继续会发布陈旧 source commit | 已精确取消；cleanup success、Mac root absent、relay inactive、WDC 未写入；仅允许最新 main 唯一发布 |
| `32406152304` | `61d4d52ecf260894679cf0d0dac6f15efb15b669` | backfill `Checkout` 后的 `Commit backfill bundle` | 旧共享 37GB checkout 先以 Git 单核约 91%、RSS 约 10GB 阻塞；bundle 生成成功后，`git add data/backfill-inbox/32406152304.json` 又因路径在旧 sparse 定义外失败 | 后续 backfill 改用 owner-marked `backfill-update-source`，显式 sparse 纳入 `/data/backfill-inbox/**`，`.git` 设 1GB fail-closed 门禁；回归同时锁定 inbox 路径和 commit add 命令 |
| `32431807706` | `18fb09de2a1f6bf053b0fee30ca216b092c3f00d` | `derive_filtered_ranking_scopes`，已完成 affected `21018/21018` 与 parent video `42936/42936` | `all/songs/0007036316d9dffa`：ranking=`771/1 song/737 videos`，source=`771/6 songs/737 videos`；父详情唯一 owner 为 `忘れじの言の葉::未来古代楽団feat安次嶺希和子`，771 条 occurrence 的原始标题有 2 种、歌手拼写有 7 种，错误地逐 occurrence 重算 canonical key | Song 来源写入强制使用详情 `key + title/workTitle` 权威 owner，raw 拼写仅保留在 payload；新增生产形态回归，并在昂贵 occurrence copy 前对全 revision Song 来源执行 owner 元数据门禁。生产只读核验：`32331` 个 Song 排名来源缺详情 `0`，父 revision `40204` 个 Song 详情 owner 不完整 `0` |
| `32451093545` | `1efd60daea5d8492f7e992fdf1ae407cd9c23040` | `derive_filtered_ranking_scopes`，已完成 affected `21018/21018`、parent sources `32037/32037` 与 parent video `42936/42936` | `all/artists/000c1914748382f4`：ranking=`7/1 song/7 videos`，source=`7/2 songs/7 videos`；父详情唯一 owner 为 `honeycomb summer`/`Honeycomb Summer`，7 条父 occurrence 无显式 key，而 lineage 中一条 overlay 使用 legacy `Honeycomb Summer\x1fCrazy:B` key，导致同歌拆成两个 canonical keys | Artist occurrence 写入按详情 `songs[].key + name` 权威 owner 统一父 stable-hash 与 legacy overlay key，raw key 仅保留 payload；新增该生产形态的 derive 回归，并在昂贵 source copy 前对全 revision Artist 详情 song owners 做批量门禁。生产只读核验：当前 lineage `9521` 个 Artist 详情、`21388` 个 song owners，非数组/空数组/缺 name/缺 key 均为 `0`；失败 run cleanup success，Mac exact root absent、relay inactive、WDC 未写入 |
| `32473191786` | `cd89b8a4e793cdcd6fad008c21a3e91984abb581` | authoritative `7d` source export，ranking 已完成，来源 `3100/5167` | `7d/9d99a4a482ed24b2536f0058`：`artist source song owner is ambiguous`，标题 `サインはB`；只读核验最新权威 revision `accepted_32471544096_1`：同一 accepted `songKey=e3bf8d66f08c946857927c15` 有 ASCII `サインはB` 2 条与 NFKC 等价的全角 `サインはＢ` 1 条，另有不同 key 的 `サインはB -New Arrange Ver` 1 条；旧 Artist payload 按 raw title 计数且不带 key，错误制造两个同名 owner | authoritative Artist `songs[]` 改为与 `songCount` 相同的 canonical `songKey` 聚合，保留最频繁 raw spelling 作为显示名、所有 occurrence payload 不改；新增该精确生产形态的 SQLite export 回归，并在首个 7d ranking combo 前对整份 authoritative revision 执行 Artist owner/occurrence 前置门禁，禁止再到来源阶段才发现。失败 run cleanup success，Mac exact root absent、relay inactive、WDC 未写入 |
| `32481749470` | `31543bc2e5e5b05cb5ef6442a3eec4af6a1a4402` | affected parent sources `10500/21018`，前置门禁、7d/all rankings 与 authoritative 7d source 已完成 | `psycopg.OperationalError: consuming input failed: server closed the connection unexpectedly`；VPS2 PostgreSQL 同秒记录 `unexpected EOF on client connection with an open transaction`，无 PG crash/OOM/statement timeout；relay 只在 Actions cleanup 正常停止，证明客户端 SSH/tunnel 会话先断。临时 SQLite 已达 `6848045056` bytes，但旧异常路径会删除全部进度 | 对三个昂贵 source bulk 阶段按完整 source 写入 SQLite completion checkpoint；断线仅删除未完成 source、重连后复核 active/content/source 三元组并从完成 source 续接，数据/身份错误不重试。workflow 增加同一 local port 的 SSH control tunnel supervisor；PG payload cursor fetch 从 `64` 提到有界 `2048` 行，降低跨公网 round-trip 暴露时间，不调大 9 小时 timeout。新增 checkpoint/partial discard、精确 psycopg transport retry/data-error fail-closed、fetch bound 与 tunnel supervisor 回归；失败 run cleanup success，Mac exact root absent、relay inactive、WDC 未写入 |
| `32573323924` | `707e8366561517c94efdd0b42030019ed57bd5c2` | server-side `derive_filtered_ranking_scopes`，已完成 affected `21018/21018`、parent sources `32037` 与 parent video `42936/42936`，并通过既有 Artist/Song owner 门禁 | `all/artists/000c1914748382f4` 再现 ranking=`7/1 song/7 videos`、source=`7/2 songs/7 videos`。只读核验 active lineage 的 full-runtime 详情/排名均只有 owner `honeycomb summer`，7 条父 occurrence 均无 key；delta 物化后的动态 `songs` 计数表却重新引入 legacy `Honeycomb Summer\x1fCrazy:B` 并覆盖详情，证明旧回归只覆盖直接 writer 路径，旧门禁只检查父详情格式 | Artist 来源写入改为始终复用本轮已生成的同 source ranking `songs[].key+name` 权威 owner；动态 count list 与 raw key 只保留在 occurrence payload。新增全量 `PG_SNAPSHOT_ARTIST_RANKING_SOURCE_OWNER_PREFLIGHT`，在任何昂贵 source copy 前校验每个 Artist ranking owner/count；精确生产形态回归把动态 source detail 明确设为两个 legacy keys，仍要求 canonical source=`7/1/7`。失败 run 自动清理固定卷约 `27.7GB`，WDC control/VPS2 relay 均 absent/inactive，生产未写入 |
| `32581739087` | event head `707e8366561517c94efdd0b42030019ed57bd5c2` | Mac 隔离 core checkout；初始 filtered fetch 已完成，按 sparse 路径取 promisor blob 时失败，未进入 build/commit/accepted | `RPC failed; curl 18 Transferred a partial file`、`9497 bytes of body are still expected`、`unexpected disconnect`、`early EOF`，最终 `could not fetch 2aad4b... from promisor remote`。失败后的 always-cleanup 又对没有完整 HEAD 的 checkout 无条件 `git restore data/ui/meta.json`，产生次生 pathspec failure | 保留已下载 partial-clone，仅当 `actions/checkout` 失败且 stderr 命中精确 Git transport 类错误时，复用同一 owner-marked checkout 有界重试 fetch/checkout 最多 3 次；非 transport 错误立即 fail closed。cleanup 在完整 HEAD/已跟踪路径存在时才 restore，否则输出显式 skip marker；新增 workflow 顺序、transport 分类、恢复/非 transport/cleanup marker 回归，不增加仓库范围、构建超时或磁盘上限 |

### 当前状态与下一步

- `done`：affected-source 全量前置门禁已由 PR #72 合并；WDC 独立 checkout 已由 PR #73 合并到 `9fcbb3cb`，CI `32396801128` success，本地 serving `185/185` 与 relay `5/5` 通过。
- `done`：PR #74 已把同一隔离和 fail-closed 容量门禁补到 core workflow；core `32393374772` success 并推进 main 到 `54e0a841`。
- `done`：PR #75 修复 WDC gate 两份 sparse checkout 未携带 core workflow 的快速失败；core `32405289528` 已验证隔离 `.git` 约 133MB，整条 run 约 16 分钟完成。
- `done`：PR #76 / CI `32411760609` 已修复 titleless 7D commentary；真实 artifact `32405289528` 转换为 `256 videos / 4209 valid occurrences`，精确跳过 1 条，main=`a0e0efe3`。
- `done`：空标题 accepted 修复与 backfill 隔离 checkout 已分别由 PR #76/#77 发布验证；overlay-only parent fallback 与 WDC sparse gate 已由 PR #78/#80 修复。
- `done`：run `32431807706` 的 Song owner 晚失败已由 PR #81 修复，完整 next-serving `194/194` 与 relay `5/5` 通过并合并。
- `done`：run `32451093545` 的 all-range Artist owner 晚失败已由 PR #82 / CI `32471176061` 修复，完整 next-serving `196/196` 与 relay `5/5` 通过并合并 `79891670`。
- `done`：run `32473191786` 的 authoritative 7d Artist canonical-key 聚合已由 PR #83 / CI `32477358869` 修复，完整 next-serving `198/198` 与 relay `5/5` 通过并合并 `2e7a29d3`。
- `in_progress`：run `32481749470` 的长事务 SSH/PG transport EOF 已完成精确归因与 cleanup；隔离 worktree 已实现 source 级 checkpoint/reconnect、SSH tunnel supervisor 与有界大批量 fetch，完整 next-serving `202/202`、relay `5/5`、workflow YAML/15 个 shell block、syntax 与 diff check 均通过；PR/CI/squash merge完成前禁止重跑。
- `pending`：合法 core/accepted、Mac writer、VPS2 relay 均空闲后，只调度唯一最新-head `sync-wdc-release.yml force=true`；同类失败无新增门禁时禁止重跑。
- `pending`：成功后立即验证 health/meta/release、一致的四类视图、artists、31 distinct-video 跨页与多 occurrence、搜索/两个筛选、真实浏览器详情、同协议延迟、10 分钟稳定性和精确残留清理。

## Pre-release gate: VTuber source-detail paging and cover mapping

- `pending -> implementation-write`: Noa is the confirmed regression sample; the fix is generic for compact vtuber/source-detail responses.
- Preserve channel handle, name, avatar, occurrence provenance, and per-video thumbnail. Keep `frontend code/style/schema contract frozen; data and backend counts may change normally`.
- Only API detail adaptation/paging/cover selection and contract tests may change. Do not change layout, CSS, field names/types, or URL routes.
- Acceptance requires focused tests, commit/push, the existing candidate compare/health/API/locked-activate gate, and live Noa rankings/source-detail pagination and thumbnail evidence.

## 2026-07-27 10:49 UTC 最新实时状态（以本段为准）

- done：Noa 是通用 source-detail 分页/occurrence 封面映射回归样本，不是 Noa 特例；adapter/API contract 修复已由 run 30256355300 发布。公网 /healthz=200，Noa source page 1/2 均 pageCount=20,totalCount=391，handle/name/avatar 保留，occurrences=292/179 且封面来自不同视频。
- done：Mac 全量 runtime SQLite 已由 run 30257210187 单一临时目录流式导入 VPS2 candidate full_runtime_30257210187_1；manifest sourceDbBytes=14829768704、source SHA=858041e58988...2fc5b0、videos=45605、occurrences=598033，PG preflight remoteFreeBefore=21782056960、currentPgBytes=6896901143、expectedCandidatePeakBytes=18088769582，run success。
- done：ready candidate 已由 run 30259446917 在 candidate API gate 后锁定激活；当前 active=full_runtime_30257210187_1、migration=active、content SHA=6a5b8c4567e6c5c5f2c3fde79cd818c076be8e772ad49fb688d1638ccc2d37ea。公网实时计数为 videos=45605、songs=45561、occurrences=598033、rankingRows=197571、sourceOccurrences=1951433，/healthz=200。
- done：Mac task root 与 VPS candidate API 临时文件已由 workflow cleanup 清理；迁移期间未复制 SQLite 到 VPS，旧 SQLite 路径为 0 bytes。VPS2 当前可用约 14883430400 bytes；旧 full runtime duplicate 尚未删除，待确认新 active 线上稳定后用精确 revision guard 回收。
- pending：Mac source DB 的 sourceCommit=cae598... 已验证包含 curation overrides，但 manifest 明确 sevenDayStatus=pending_new_accepted_increment；这次迁移导入的是清洗主库，不把 7D 或迁移后清洗发布冒充完成。
- in_progress：下一阶段沿 PG accepted-increment workflow 发布现有 curation_ready_pending_release artifact/证据，重点 Naraetan、Ado 逆光、辛いことがある人生でも、同名 リスタート；不重跑全库清洗、不改前端结构/样式/API 契约。
- pending：随后有界续跑 うら飯紺汰 7D discovery/detail/三天规则/curation/release；旧 PID/失败 run 不作为结果，不启动第二个 Mac 重任务。
- frontend code/style/schema contract frozen; data and backend counts may change normally。

## 本会话 Goal（2026-07-27，G 盘正式入口）

由当前主会话负责收口两项用户交付：`PostgreSQL 增量迁移 -> 迁移后发布既有清洗结果` 与 `MyGit 完整 7D 恢复`。后者明确包含 `うら飯紺汰` 来源的 7D 候选发现、详情/时间码、三天规则、curation accepted increment 和线上发布验收；前者通过 candidate gate 后，清洗结果必须沿同一增量入口上线，不能停在本地 artifact。PID=5282 当前仅保留为停止/断点证据；本轮 audit-readonly 未启动、暂停或删除任何 7D 任务，也未创建新的仓库/worktree/目录。主会话负责限定写集、测试、commit、push、既有 workflow、candidate/active 切换和真实线上验收。

当前执行门：旧 SQLite 已按用户授权删除，PG 全量版本已由 Mac self-hosted run `30224885215` 流式写入 VPS2；`full_runtime_30224885215_1` 先 active，随后 metadata/source-detail 修复由 run `30237611997` 以 `candidate -> compare -> health/API -> locked activate` 合并，当前 active=`accepted_30237611997_1`。但实时审计确认“日常更新 -> PG”此前仍未自动接通：`update-core.yml` 会继续提交生成数据，而 PG workflow 只接受手动/accepted dispatch，因此本轮必须补上 workflow-run handoff；不能把已有一次成功 run 写成持续入库已经完成。新 workflow 将只接收已接受的增量文件，未形成 accepted patch 时对核心数据变更 fail-closed，避免新库静默停在旧数据。7D 专项仍需独立 `reachedEnd=true`、时间覆盖、三天状态审计、curation accepted increment 和线上 source-detail 验收；generic 7D 137/2179 不能冒充 `うら飯紺汰` 专项。VPS 远端临时脚本/候选 API 已清理，两个未激活的 ready duplicate revision 已精确删除；Mac run 的 storage manifest 通过 workflow 显式输出门禁保留，任务目录不作为长期 artifact。任何阶段都必须记录 checkpoint/manifest、expected/actual bytes、cleanup evidence；目标未通过持续入库、迁移后全库清洗发布和来源专项线上验收前保持 pending，不得标记 complete。

最新实时交接（2026-07-27 05:18 UTC）：PG alias 兼容补丁 commit `688321a0793099443bc381475cfda1e2a36304d7` 已由 run `30238784985` 完成 candidate compare/health/locked activate，当前 active=`accepted_30238784985_1`；公网 `/healthz`、`/api/meta`、`/api/sources/UCFP9UkgIM_U8NfzRbYEOQdA` 与 `/api/sources/dc7c736a993c4cb9c28f7be0` 均 HTTP 200，二者均返回 Naraetan 名称、handle、头像和歌曲数组。7D run `30238452962` 因约 8 分钟无 step/checkpoint 被取消；随后唯一重试 `30239203546` 因 Mac runner 长时间 `online/busy=true`、job 未分配而取消，均无 manifest、accepted increment、来源导入或生产切换。当前无活动 7D run，下一次只能在 runner 明确 idle 后单实例启动；不能把 queue/cancelled 写成 7D 进行中或完成。
本轮 implementation-write 已提交 `b62e50f`（持续入库 handoff、7D workflow/gate、转换器、三天状态审计）及 `23cc596f`/`6743847d`（reusable artifact 路径与 Mac checkout 认证修复）。7D run `30234065925` 首次因 checkout 认证格式失败，已 cleanup；重试 `30234207137` 因 Mac runner 长时间 `busy=true` 且 job 一直 `runner_name=null`，超过有界等待后取消，未生成 artifact、未导入或切换 PG。当前这不是数据完成证据；需 runner 恢复后只重跑该单一 source workflow。

### 2026-07-27 07:27 UTC 实时状态（以本段为准）

- 唯一 7D run `30244079991` 仍为 `in_progress`，job `89907217361` 在 `mac-daily-song-list-builder` 上运行，固定 head `6c3524c4b7d444492cb18b7a12894eb422872217`；它仍是 Mac 单机、6 shard 串行流程，每 shard `max-inspect=500`。不得启动第二个 7D 实例。
- Naraetan overlay 修复 run `30244929817` 仍为 queued，尚未接管 Mac；因此线上 source detail 当前仍为 `videoCount=1`、`songCount=22`、`totalOccurrenceCount=22`，不能宣称 54/2 聚合差异已修复。
- 本轮新增有界多 worker 协议：`scripts/migration/7d-stream-protocol.py` 实现 videoId 稳定分片、逐视频 canonical hash/ack、fsync 后 checkpoint、重复投递幂等、硬容量上限和 `mediaDownloaded=false`；`test/7d-stream-protocol.test.mjs` 覆盖 nullable/repeated seconds、来源字段保留与冲突 replay。远端 main 提交为 `2ec0d47a`、`f4e07c71`、`7b575501`（README），未接生产数据库，未来 run 才能使用。
- WSL focused 回归：`python3 -m py_compile` 通过；7D/PG/adapter/API 合计 `16 passed, 2 skipped, 0 failed`，两个 skipped 是未安装 PGlite。由本轮提交触发的 Mac Check code runs 已取消，避免占用唯一 7D runner。
- 当前线上正确 API 为 `https://ytb-song-rank.culua.com`：`/healthz`、`/api/meta`、Naraetan `/api/sources/2ee34b53f2838fbac4d98103` 均 HTTP 200；active=`accepted_30243460721_1`，VPS2 PG 可用空间 `21,791,055,872` bytes，`pg_api_server.py` PID `376164`。`https://ytb.culua.com` 是 GitHub Pages 404，不作为 runtime API 验收地址。
- 未完成：当前 7D 尚无最终 accepted manifest/curation/线上专项验收；Naraetan overlay 尚未发布；多 worker 协议尚未接入调度；全库 `curation_ready_pending_release` 与日常 accepted-patch workflow handoff 仍待 candidate gate。目标保持 pending。

## 目标

在唯一正式入口 `G:\codex-work\daily-song-list` 完成可审计的数据库/发布架构迁移，并在迁移完成前保持当前 active 版本可服务。目标链路是：增量 upsert -> 候选版本构建与校验 -> active 原子切换 -> 可验证 rollback -> 真实线上验收。

## 当前阶段

### 2026-07-27 主线实时纠正

### 2026-07-27 Naraetan 频道身份修复（implementation-write done；计数 reconciliation pending）

- `done`：公网 rankings 搜索与 `/api/sources/dc7c736a993c4cb9c28f7be0` 均 HTTP 200；当前 rankings 返回 `name=なれたん Naraetan Ch.`、`channelHandle=/@naraetanV`、头像 URL、`sourceDetailKey=dc7c736a993c4cb9c28f7be0`、`4483/293/1404`（occurrences/videos/songs）。
- `done`：限定改动 `server/pg_adapter.py` 与 focused tests 已由 commit `f449b514a44a332de8251f9bdb653dddbc8e972c` 推送；activation run `30237611997` 已完成锁定切换，公网 `/healthz`、`/api/meta`、rankings 与 source detail 均已验证。前端结构/样式/API URL/字段语义不变。
- `pending`：source detail 当前真实返回 `4461/292` occurrences/videos，排名聚合返回 `4483/293`；身份和歌曲数组已恢复，但这 22 occurrences/1 video 的投影差异需在后续数据 reconciliation 中处理，不能静默补数或把截图旧状态当作当前线上状态。
- focused tests 当前 `11 passed, 2 skipped`（PGlite 未安装）；无前端文件改动。

### 2026-07-27 PG 全量候选与线上切换实时结果

- `migrate-pg-runtime.yml` run `30224885215` 已完成 Mac 单目录全量流式导入；候选 `full_runtime_30224885215_1` 为 `ready`，`videos=45605`、`occurrences=598033`，content SHA-256 为 `6a5b8c4567e6c5c5f2c3fde79cd818c076be8e772ad49fb688d1638ccc2d37ea`。
- 该 run 首次失败原因已定位并修复：候选 gate 拷贝 `/api/meta` 证据时文件名多了下划线；同时修正 service 运行所需的 `/opt/culua/ytb-song-rank/server/` 安装路径。PG adapter 的无搜索词 ranking 路径改为 SQL 聚合 + LIMIT/OFFSET，all ranking 实测约 `0.22s`，避免反向代理 502。
- 候选已由带锁 activate 脚本切为 active；`song-rank-pg-api.service` 实时 `active`，`migration_state` active revision 为 `full_runtime_30224885215_1`。VPS2 最近实测可用空间 `21,778,079,744` bytes；无导入/候选 API 残留进程，临时 API 已清理。
- 2026-07-27 约 `00:20 UTC`：公网 `https://ytb-song-rank.culua.com/healthz`、`/api/meta`、`/api/rankings?range=all&view=songs&metric=occurrences&page=1&pageSize=1`、7d rankings search 均 HTTP 200；`/api/sources/Naraetan?page=1&pageSize=1` HTTP 200（当前 key 未命中返回 found=false，不能当作 Naraetan 数据已发布）。
- 2026-07-27 `01:42–01:45 UTC`：7D candidate gate 的 health/meta/7d rankings/all rankings/search/source 均本地 HTTP 200；candidate RSS 从 OOM 峰值约 1.7 GiB 降至约 64 MiB。`mygit_7d_20260727_2` 激活后 VPS 本地与公网 `https://ytb-song-rank.culua.com` 的 health/meta/7d rankings/all rankings/search/source 均 HTTP 200；active counts 为 `45742/46637/600212`（videos/songs/occurrences），其中 songs 计数已包含增量 song-key 差集且未重复叠加。workflow 正式重跑与 `うら飯紺汰` 专项来源仍 pending，不能标记 goal complete。

- 实时探针发现 VPS2 `song-rank-api` 在 `2026-07-26T20:41:15Z` 被停止，公开 `/healthz` 与 `/api/meta` 当前 HTTP 502；PG 尚未接管，不能把该状态当作迁移中的正常窗口。
- 旧 active SQLite 在 VPS2 原路径缺失，但 Mac cache 仍保留单一已登记副本 `/Users/be/actions-runner-cache/daily-song-list-runtime-db/song-rank.sqlite`：`14,829,768,704` bytes，manifest rollback SHA-256 为 `858041e58988b35f9a60b96ec15668ecb907de41b2b7373a37b4c5e2872fc5b0`。本轮已尝试有界流式恢复；因 Windows→WSL→VPS 管道约 30 秒仅推进约 155 KiB，已停止并删除精确 PID 及不完整目标，VPS 未残留 partial SQLite，需使用 Mac runner 直连的受控 rollback workflow 恢复旧 active 后再继续 PG。
- 后续 Mac→VPS 直连 gzip/分片恢复也已按门禁执行：压缩流实际约 `2,727,423,995` bytes；分片边界曾完成 6 片、每片累计 bytes 校验通过，但 VPS SSH 长连接在约 443 秒后被远端关闭，trap 已删除 `song-rank.sqlite` partial、Mac `/tmp/daily-song-list-vps-key` 与本地临时 key。当前 `song-rank-api` 仍 inactive、公开 health/meta 为 502；阻塞是可复核的 Mac→VPS 长传输/认证通道，不得用空 PG 接管或继续无界重试。
- `migrate-pg-runtime.yml` 的迁移 preflight 已移除“空间不足就停止服务并删除旧 SQLite”的危险行为；新增 `restore-sqlite` 仅在目标缺失、bytes/hash 与已登记 rollback manifest 一致时恢复旧 active。未恢复验证前禁止触发 PG activate。

2026-07-27：主线目标已由用户明确收口为两条交付线：`(1) PostgreSQL 增量迁移 -> 迁移后接入已审计清洗结果；(2) MyGit 完整 7D 恢复`。VPS2 已实时确认 PostgreSQL 16 active、`song_rank` 存在、`www-data` 可通过 Unix-socket peer 登录；`migration_*` 与 full runtime projection schema 已存在，但 `migration_state.active_revision_id` 为空、候选数据为 0。旧 SQLite run `30217524582` 已失败并停止服务；用户明确授权后，已在 Mac rollback DB `858041e58988...` 与空间预算证据下删除 VPS `/var/lib/culua/ytb-song-rank/song-rank.sqlite`（14,829,768,704 bytes），删除前可用约 14.5 GB、删除后约 29.0 GB；因此当前外部 API 待 PG candidate 接管，不把 502 当正常完成。主仓库已有 PG adapter/API wrapper、full runtime stream receiver、candidate service 和 focused tests；Mac PID=5282 已停止，checkpoint 仍是陈旧 `status=running`、`page=101`、80 个去重候选、`reachedEnd=false`。仓库当前存在约 32 万条接手前 staged deletion（含历史生成数据），本轮不得恢复、清理或扩大这批删除。

## 迁移优先时间表（有界，不承诺固定总时长）

- 现在至 30 分钟：确认 Mac 专属 temp root、当前线上 active、VPS2 PostgreSQL peer target 和旧 SQLite 服务；target 已存在，但 schema/数据/API candidate gate 未完成。
- 30–90 分钟：在不复制 SQLite 的前提下实现并测试最小增量链路：schema、upsert、compare、rollback、active/candidate、healthz；禁止改已上线前端。
- 90 分钟–3 小时：仅在 Mac 单一临时目录做小样本/29 份歌单迁移 dry-run 和 handle 解析；只写候选/测试库，不碰生产，必须有 manifest、checkpoint、空间峰值证据；失败或空间不足立即清理并停止。
- 3–5 小时：完成 focused tests、事务 upsert、回滚和候选切换验证；只有真实 DSN、旧 active 可继续服务、compare/health 全绿才接入发布 workflow。
- 5–7 小时：先发布一小批候选或 staging，线上验证 healthz/meta/rankings/版本身份；发布若仍需全量重建或超过 30–60 分钟，回到架构问题，不把清洗塞进长任务。
- 迁移链路通过后，才用同一增量入口发布 Naraetan/Ado/`辛いことがある人生でも` 等清洗规则；清洗目标为分钟到几十分钟，不接受 9 小时无结果。

设备职责：Mac 负责数据库迁移基准、长测试、source build（先空间 preflight、单临时目录、checkpoint/manifest、上限和结束清理）；WDC 只做来源多 IP relay/受控请求；culua 只读探针/小型服务验证；Windows/G 负责协调、短测试、Git/审查，不跑全库构建。

## 空间与清理门禁

- 每个任务开始前必须在 Mac 建立任务专属 temp root，并记录 baseline free、输入/active bytes、预计峰值、硬上限、允许保留的 artifact；中间产物不得散落在仓库、用户目录或 VPS。
- 当前 active SQLite 约 14.8 GB；任何复制、Git pack、WAL、索引和临时文件都必须逐项解释。10 份同等副本约 148 GB；若增长超过预计峰值 20%、连续无有效进展，或出现第二份完整 DB/candidate/backup，立即 pause。
- 触发异常时严格执行 pause -> identify PID/path -> bounded cleanup -> remeasure；不能只停进程留下残留，也不能换盘继续写。Mac 迁移禁止并发 full SQLite copies；VPS 仍只做多 IP relay，不存数据库。
- 长任务必须有 success/failure/timeout cleanup trap：先停止本任务 PID、等待释放句柄，删除本任务 temp root、临时 pack、WAL、candidate 和重复 clone；只保留 checkpoint/manifest/小型报告。清理失败要列出精确路径/PID并继续清理安全部分。
- 清理后必须记录 before/after bytes、free space、保留文件清单和任务状态；没有 cleanup evidence 不得称失败处理完或完成。

接手教训：全量 SQLite 候选替换曾使清洗结果无法上线；`b8b84dcecd`、`678258decb`、`5af7c37c10` 只是草案，尚无真实 DSN、生产服务或主 workflow 接入。来源抓取曾写满 VPS，重抓取/全库构建/长期 raw 或 clone 不得放 VPS；culua 小水管不能承载重任务；日期 worktree/partial data 不得合并全量生成 data。

## 旧会话事项核销（2026-07-27 实时状态）

### A. 频道身份/清洗主线

- `partial/done`：固定搜索链接的当前 7D accepted increment 已通过 PG candidate gate 并激活（137 videos/2179 occurrences）；全库 curation artifact 仍为 `curation_ready_pending_release`，不能把这次来源增量等同于全库清洗上线。
- `curation_ready_pending_release`：全库 singleton/unknown-artist 审计主体、保守 drop/merge 规则与 artifact/证据已具备；尚未经新增量入口发布，禁止删除、回滚或重跑全库清洗。
- `curation_ready_pending_release`：Naraetan、Ado `逆光`、`辛いことがある人生でも`、`うら飯紺汰` 原创 `リスタート` 与凛々咲同名曲规则主体已具备；迁移候选链路通过后立即接入发布和线上验收，不再扩大清洗。
- `done`：`フィナーレ。`/两视频异常已由前序执行会话修复并上线；不再审计、修改或回滚。
- `done`：已上线前端歌曲数显示修复、样式/渲染结构、API 字段语义与收录 tag 已由前序执行会话确认；前端 code/style/schema contract frozen，不重做 UI/API/search/collection-tag。后端数据与频道歌曲数、歌曲数、视频数、次数可随迁移/清洗正常变化，本轮只不改前端结构。
- `done`：7d 数据已由前序发布进入总量；当前线上 `https://ytb-song-rank.culua.com/api/meta` HTTP 200，active `source_commit_sha=fb0dea42fc9e1d15e499b8a10967c1829cf0f60b`，本轮不再审计、修改或回滚该项。
- `done`：旧 D 盘 worktree、日期目录和生成 data 未作为入口；本轮只使用本文件所在正式仓库。

### B. うら飯紺汰来源会话

- `pending`：本次固定搜索链接结果未形成 `うら飯紺汰` 专项 accepted shard；generic 7D 137/2179 已合并，但专项发现/详情/原始证据/线上重点验收仍需独立有界续跑。
- `pending`：旧 clone 在约 1%/0.8 GiB 时未完成；本轮未续用，也未把它当作来源结果。
- `pending`：旧 FETCH_HEAD、package.json、checkpoint、manifest、accepted increment 未形成；需来源时重新按 relay + Mac checkpoint 方案评估。
- `pending`：discovery、详情抓取、原始证据审计、导入和线上验证均未完成；当前迁移优先，不启动来源任务。
- `done`：不续用 VPS clone；VPS（含 WDC）默认仅作受控来源 relay，禁止 clone/数据库/candidate/backup/raw 长期存储。

### C. 迁移交接

- `done`：VPS2 真实 PostgreSQL target 已存在且 `www-data` peer 可连接；Mac run `30224885215` 已完成 full runtime stream，candidate `full_runtime_30224885215_1` 已通过 compare/health/API gate 后原子激活；active counts 为 `45605/45561/598033`（videos/songs/occurrences）。
- `done`：已确认 `deploy-runtime-db.yml` 仍以 Mac 全量构建 SQLite、通过 artifact/SSH 上传至 VPS2 的 `song-rank.sqlite` 为中心；这正是待替换的架构，不视为增量迁移。
- `done`：端到端 full stream、compare、candidate/active 切换和线上健康证据已存在；正式 run 使用 Mac self-hosted 单跳 SSH 传输。首次 gate 因证据文件名拼写失败，已在 workflow 修复；`VPS2_PASSWORD` 仅用于受控 SSH，PG target 使用 VPS2 Unix-socket peer，不伪装为 GitHub PG DSN。
- `done/verification-pending`：generic 7D accepted increment 已由正式 run `30232629804` 完成 candidate -> health/API -> locked activate，active=`accepted_30232629804_1`，旧 revision 链保留 rollback；全库清洗 artifact 与 `うら飯紺汰` 专项仍未完成线上验收。
- `pending`：29 份歌单的 channel handle 解析、可视化/脚本化 upsert 尚未交付。
- `done`：curation/release 分支的中断合并未恢复；禁止合并全量生成 data。
- `pending`：C/D/G/Mac 存储清单与回收规则部分完成；G 盘、正式仓库、Mac 空间/runner/cache、culua 盘和本机残留进程已有证据，WDC/VPS2 角色与空间仍缺可复核 SSH 证据；不以子任务未完成报告代替清理验收。

### 迁移可行性判定（阶段 0）

- `pending`：真实 PostgreSQL target 已由 VPS2 `www-data` Unix-socket peer 实连确认；Mac 数据盘仍需在本轮迁移启动前记录最新 baseline/peak/after。固定迁移 temp root `/tmp/daily-song-list-pg-migration.vi8WS5` 已重新初始化并记录 baseline，当前只保留迁移小文件与依赖；历史 PGlite evidence 不能替代本次 VPS2 实连。
- `done`：旧全量 run `30213710452` 已按授权取消；job `89824129428` 的构建 cancelled，manifest/上传/activate/health/API 均 skipped，runner 已 `online/busy=false`，未改生产数据。
- `done`：旧 active 保留方案已重新实时验证：`https://ytb-song-rank.culua.com/healthz`、`/api/meta`、`/api/rankings` 均 HTTP 200；health counts 为 videos 45605、songs 45561、occurrences 598033。候选未 ready 前不切换，PG 仍为空 active pointer。
- `pending`：GitHub Actions 仍没有 PG secret 注入，但 VPS2 peer target 可由受控 Mac/SSH 任务使用；不得把 SSH 可达性冒充 schema/data/API 完成，需生成受控 manifest 并经 candidate gate。
- `done`：同一 Mac 临时根目录 `/tmp/daily-song-list-pg-migration.vi8WS5` 已完成真实 PGlite schema/upsert/compare/rollback/active 测试（2/2 passed）和 SQLite NDJSON 流式小样本（1 video/3 occurrences）；fixture 仅 `20480` bytes，无完整 SQLite 复制。此次回归保留了两个相同 `seconds`、一个 `seconds=null`、三个不同 `occurrenceId`，并保留空字符串/NULL artist/sourceId/sourceSystem、range_id、song_key。任务 baseline free `481220472 KiB`，expected peak `536870912` bytes，hard cap `2147483648` bytes，stream root peak `107094016` bytes；cleanup `beforeBytes=107094016 afterBytes=0`、free `481115812 KiB -> 481221184 KiB`、retained `none`、status `success`。
- `done`：P1 数据契约已在 migration patch 修正：不再过滤 NULL seconds、不再以默认值覆盖空 artist/source_id/source_system、不再禁止重复 seconds；occurrence_id/position 作为稳定 identity；range/source/song/raw provenance 字段落列；视频删除使用显式 tombstone，解析不会继承已删除父行；activate/rollback 先锁 active state，并在切换时校验 candidate parent 等于当前 active。focused test 覆盖字段保持、tombstone、rollback 和并发候选 parent mismatch。
- `done`：`server/pg_adapter.py`、`server/pg_api_server.py` 已接入兼容 URL wrapper；空 PG 不健康；full projection 已真实导入，ranking/source/meta/health contract 已在候选端口和公网验证。无搜索词 rankings 已改为有界 SQL 聚合分页，避免全量 payload 物化导致代理超时。后续增量仍必须走 candidate -> compare -> health/API -> activate，不得直接写 active。

### 取消旧 SQLite run 的清理核验

- `done`：run `30213710452` 已取消且 runner 空闲；runner workspace 约 617 MiB，未发现 SQLite/WAL/pack/tmp/manifest 残留。精确清理旧 cache DB `14816280576` bytes 与 manifest `348` bytes；Data FS 可用 `466749772 KiB -> 481218864 KiB`，cache 保留文件为 none。另有两个旧 runlogs SQLite（约 9.76 GiB/份）不属于该 run，且 hotfix DB 被 PID 14215 使用，暂不触碰。

## 范围与硬约束

- 只使用 `G:\codex-work\daily-song-list`（WSL `/mnt/g/codex-work/daily-song-list`）；不创建 clone、日期目录或新 worktree，不使用 `D:\Projects\daily_song_list_dbapi`。
- 模式门禁：`audit-readonly` 只用于审计、盘点、定位和风险判断，报告必须指明下一执行会话、限定改动文件、发布入口和线上验收条件；用户目标涉及线上修复、来源、数据库或用户可见行为时必须接续 `implementation-write`。主会话负责最终 diff 审查、push、workflow、发布和线上验证；子任务不得扩大范围，也不得以只读阻断交付。
- 先只读核对仓库、进程、Mac/VPS/G 盘资源、远端与真实线上 API；不以旧截图、旧 commit、旧 run 或 UI 推断已上线。
- 不修改前端样式或已上线歌曲数修复；不重跑来源、不使用 `--fresh`、不并发写同一数据库/来源目录，不发飞书。
- `frontend code/style/schema contract frozen; data and backend counts may change normally`：迁移/清洗可以改变后端数据与统计数字，但不得修改前端布局、卡片、字体、分页控件、渲染结构或 API 字段语义。
- culua 只做有界只读探针；WDC 不构建数据库、不长期存 raw/clone、不写爆磁盘。
- 所有 VPS（含 WDC）只可做来源请求的多 IP 中继/受控抓取；禁止在 VPS clone、存放或构建 100GB 以上数据库，也禁止长期放完整 SQLite/PostgreSQL、candidate、backup、raw。迁移和数据库构建只能在 Mac self-hosted runner；产物只能经受控 artifact/增量协议传递。任何例外必须先给出定量空间预算、任务时长和回收动作并获用户确认，默认拒绝。
- 大型构建、来源抓取、全库扫描和长测试只允许 Mac self-hosted runner；每次任务必须先做空间 preflight，使用单一临时任务目录、checkpoint、manifest、空间上限和结束清理。
- Windows 只做 G 盘上的小型检查、协调和 focused tests；不复制全量 SQLite、不做无界扫描或重型构建。
- 候选未 ready/验证失败时不切生产；迁移或清洗期间线上不得以 502 作为正常方案。

## 阶段验收

1. 只读盘点输出仓库/分支/status、残留进程、远端、Mac/VPS/G 存储、真实线上 active/candidate/health 证据；明确迁移阻塞。
2. 确认真实增量目标、DSN 注入方式、schema、upsert、compare、rollback、candidate/active 切换入口；没有真实目标时明确缺口，不伪装已迁移。
3. focused tests、dry-run、小样本和失败保持旧 active 的回归验证通过。
4. 已审计的保守清洗规则通过增量路径发布；singleton 只作候选，证据不足保留/待审；Naraetan、`辛いことがある人生でも`、`逆光(ウタ from ONE PIECE FILM RED)`、`うら飯紺汰` 原创 `リスタート` 与凛々咲同名曲分离规则有证据。
5. commit、push、既有 workflow 发布成功；线上验证 healthz、meta、rankings、重点条目和 active/candidate 身份，记录时间、状态码、commit/run、计数、存储与失败证据。

## 当前下一步

1. 将本轮 bounded overlay adapter、Naraetan metadata candidate、7D range/source identity 修复、持续入库 workflow-run handoff、7D manifest gate 和最新 goal 通过 GitHub Database API 安全推入 main；只更新本轮文件，不带接手前 staged deletion。
2. 先用 `deploy-pg-incremental.yml` 的 `workflow_run` 入口接住 `Update core song-list data`：对 accepted channel increment 自动生成 compact PG patch；若只有核心 JSON 变化却没有 accepted patch，明确 fail-closed 并记录缺口，不能静默让新库不再进新数据。
3. 在固定 `daily-song-list-source` 入口补齐 `うら飯紺汰` 专项 7D：沿已有 lease/checkpoint 继续详情证据与 curation，不重跑已验收的 533 条候选；生成 `reachedEnd=true`、时间覆盖、三天状态审计、cleaned accepted increment 后，带 `require_7d_gate=true` 接入同一 candidate 入口。
4. 维护同一 workflow 作为日常/7D 增量入口：每次 accepted manifest 必须走 candidate -> compare -> health/API -> locked activate，失败保持当前 active；generic 7D 已完成但专项与全库 curation 仍 pending，不得把 pending 数据静默丢弃。
5. 将既有 `curation_ready_pending_release` artifact 继续按同一 candidate 入口发布；验收新增数据持续可入库：healthz/meta/rankings/source/search、重点歌曲、`うら飯紺汰` 和 active revision 身份。成功后清理 PG 临时文件，VPS 不恢复 SQLite。

## 交接记录

每次状态必须记录：工作树/分支、改动文件、测试、commit/push、发布 run、线上证据、Mac/WDC/G 存储、未完成项。只有真实线上切换和验收完成后才能将平台 goal 标记 complete；阻塞须同一外部条件连续三次且无安全替代路径。

### 
2026-07-27 07:56:49 UTC
 实时状态（以本段为准）
- mode: release-verify + implementation-write（仅迁移 workflow/7D 调度相关写集；不改前端）
- 正式入口: G:\\codex-work\\daily-song-list；本地工作树既有 staged deletions 保持原样，未恢复生成 data。
- 7D run 30244079991: cancelled；job 89907217361 于 2026-07-27T07:35:45Z cancelled，cleanup success，task root beforeBytes=11767808、afterBytes=0；未形成 accepted manifest/increment，未导入生产。
- 旧 SQLite 定时 run 30246931182: cancelled；在 Checkout 阶段停止，未进入 run-core-update/build runtime；日志显示 Mac 工作目录 index.lock 由当前 checkout PID 24141 持有，不能误删。
- Mac preflight: 2026-07-27T07:55:34Z，free=368982316 KiB（约 369 GiB）；当前检查 PID 24141/24136/24134 仍在持锁 checkout，需完成/取消后再按 PID/句柄清理。
- PG active: 仍保留 accepted_30243460721_1；Naraetan overlay run 30244929817 failed at candidate source-detail HTTP 500，candidate 已删除，remoteFreeAfterBytes=21790998528，未切换生产。
- workflow fixes pushed via GitHub Contents API: 4856aa1（Mac Bash 兼容并输出 candidate source error body）；54e57d8（workflow_run 仅在上游成功时允许 PG job，取消旧 core 不再触发激活）。
- 7D streaming protocol commits remain: 2ec0d47、f4e07c7、7b57550；focused tests previously 16 passed/2 skipped/0 failed；协议尚未接入真实多 relay 调度。
- 多 VPS 状态: Mac runner SSH 未发现 vps-racknerd/vps-wdc/vps-jp/vps-aiyun/vps-la/culua alias；Actions 只列 VPS2_PASSWORD。可并发架构已具备协议，但真实 relay host/key/secret 路径尚未接入，不能伪造已并发。
- 未完成: 修复并复现 candidate source-detail 500；处理 Mac checkout lock 的 bounded cleanup；接入真实 relay 后再启动单一 7D candidate/detail run；完成 curation、PG candidate compare/health/API、activate 和线上验收。
- 禁止: D 盘、完整 SQLite/媒体下载、VPS 长期 raw/clone/database、恢复 staged data 删除、前端样式/结构/API 字段 URL 修改、无 ready candidate 切生产。


### 2026-07-27 11:35 UTC

- mode: release-verify + implementation-write (仅 PG adapter 增量投影；不改前端样式、结构、URL 或字段语义)。
- 已确认：Noa 展开详情的分页封面复现不是当前已证实的全局数据写坏；线上 /api/sources/29ae50b7975dbdcf?page=1&pageSize=1 与 page=2 均 HTTP 200，视频分别为 HZ1q27Z5Pqc、0bXKzDEk79E，封面 URL 不同，频道名、handle、avatar 均存在。
- 已修复并推送 cba982f48389652630cdec08a07aa4b1e48f233c：overlay 只回放 immutable full runtime 之后的 lineage，避免历史 occurrence rows 重复计入；source detail 已持久化时先走有界查询。focused tests node --test test/pg-adapter.test.mjs test/pg-api-server.test.mjs = 13 passed / 0 failed。
- adapter 发布 run 30262343247 success；线上 health/meta 复核 HTTP 200，counts=videos 45605 / songs 45561 / occurrences 598033，active=accepted_30261533343_1，旧 full revision 保留。
- curation 状态仍为 curation_ready_pending_release：当前 active overlay manifest 已激活但该单条 tombstone 尚未完成 source/rankings 可见性验收，不把 run success 当成清洗完成。
- 7D：最近 run 30253290230 failure，discovery candidates=1165 但 inspected=0/videos=0/occurrences=0，未生成 accepted increment；不得把它当作完成，也不得并发启动第二个实例。
- 未完成：实现/验证 curation overlay 的实际删除可见性；修复 7D detail worker 的可用详情获取后，再按 candidate -> compare -> health/API -> locked activate 发布。

### 2026-07-27 13:04 UTC 实时交接（本轮主会话）

- `done`：Noa 目前仍是已确认的单频道展开详情回归样本，不足以证明全局封面数据损坏。公网 source detail 已显示不同视频的不同 thumbnail、同一频道的 name/handle/avatar；本轮不改前端布局、样式、URL 或字段契约。
- `done`：commit `07b52babfec8f7a9c42c6d13fa93333ac538233a` 修复 YouTube continuation 选择器跳过已消费 token；commit `f92fa78764f26704bcaec3231296ec9e58f5e92c` 为缺失发布时间写入显式 `publishedAtMissingReason`，commit `0b9c0703e0a8c6d15f16c2496b7c38457c86d0e0` 将 7D workflow 的有界总时长改为 180 分钟、页数保护改为 2000。仅修改 source discovery/test/workflow 文件。
- `done`：7D candidate run `30264934836` success；Mac 单任务 cleanup success；manifest `reachedEnd=true`，pageCount=361，candidateCount=1382，unique videoId=1382，mediaDownloaded=false，候选 artifact 284763 bytes。候选 manifest 的临时下载根 `G:\codex-work\.tmp\urameshi-7d-30264934836` cleanup `beforeBytes=1716726 afterBytes=0`。
- `done`：远端源码内存 focused probe 输出 `FOCUSED_SOURCE_TEST_OK`，覆盖重复 continuation token 和缺失发布时间 reason；完整 Check code runs `30266738996`、`30267004386` 因 Mac job 初始化无 step 被有界取消，未伪造全套测试通过。
- `blocked/pending`：detail run `30267032456`、`30267497473`、`30268118209` 均在 Mac runner `busy=true`、job started 但 5 分钟无任何 step/checkpoint 后取消；每次取消后 runner 回到 `online/busy=false`，没有 accepted increment、detail occurrence、curation 或生产切换。需要 Mac runner 启动层恢复后只启动一个 detail 实例，或由用户提供可用的 Mac runner 外部状态；不能用 candidate manifest 冒充 7D 完成。
- 当前 PG active/线上数据保持不变；没有 partial 7D 导入，没有清洗切换，没有旧 active 回收。goal 仍 pending。
### 2026-07-27 13:26 UTC 实时交接（candidate 复用与 runner 再核对）

- `done`：commit `1559a4f0138ae42e28f400ad102d6c00c5011913` 增加 `--candidate-manifest` 输入；detail shard 可直接复用已验证 candidate NDJSON/manifest，不重复抓取来源。focused in-memory probe 输出 `CANDIDATE_REUSE_PROBE_OK`，验证 `reachedEnd=true`、videoId 保持且 discovery client 未被调用。
- `done`：detail workflow 增加可选 `candidate_run_id`/`candidate_artifact_name`，并把复用 manifest 传给 6 个 shard；总上限仍为 180 分钟，单请求间隔仍为 5 秒+抖动。此次没有恢复旧 source/raw，也没有下载媒体。
- `pending`：detail run `30269601971` 使用 candidate run `30264934836` / artifact `urameshi-7d-30264934836-1` 启动，但 `runnerName=null`、5 分钟无 step/checkpoint，已取消；runner 随后 `online/busy=false`。没有 detail artifact、status-audit、accepted increment、curation 或 PG activate。
- `done`：线上只读复核未受影响：`https://ytb-song-rank.culua.com/healthz` HTTP 200，`/api/meta` HTTP 200，Noa source detail page 1/2 HTTP 200；当前 active revision 仍为 `accepted_30261533343_1`，counts health 为 videos=45605、songs=45560、occurrences=598032。Noa 仍是已确认回归样本，不扩大为全局封面损坏。
- `pending/external`：需要 Mac self-hosted runner 的 job assignment/runner service 恢复后，才可继续单一 detail；候选复用 patch 已准备好，禁止用 cancelled run 或 candidate-only manifest 冒充 7D 完成。

### 2026-08-21 06:40 Asia/Taipei — WDC 发布失败账本与当前状态

- active goal 仍为 next-serving-v3 正确性、性能优化、WDC 发布与公网验收；未发布前不得标记完成。
- WDC run `32419778429`（head `84ccfa913ddc097743257e4a7621eaa39b9241d8`）在 affected-source 全量前置门禁失败：`_load_parent_video_source_batch` 对 overlay-only video `7F4cyWU3k9A` 已允许父数据完全缺失，却仍索引不存在的 `fallback_by_video` 行而抛 `KeyError`。cleanup 已成功，Mac exact root/relay 均不存在，WDC 仍是旧 release。
- 最小修复：只跳过已被 `allow_absent` 明确认定为 overlay-only 的 video；父视频或父 occurrence 仅单边缺失时继续 fail closed，不放宽其他来源身份契约。
- 回归测试 `test_snapshot_affected_preflight_accepts_overlay_only_video_without_parent_rows` 使用生产失败 videoId，要求前置门禁输出 `overlayOnlyVideos=1` 且不制造父 fallback。当前 targeted `1/1`、next-serving `190/190`、relay `5/5` 均通过。
- 旧 head 的重复 WDC run `32422157316` 已精确取消；cleanup success，Mac exact root absent、VPS2 relay inactive、WDC 未写入。下一步为 commit/push/PR/CI/squash merge；等待合法 core/accepted writer 完成后，仅调度唯一 latest-head WDC，并继续完整公网验收。

### 2026-08-21 07:45 Asia/Taipei — Check code 门禁归属修复

- main Check code run `32425535970`（head `cc7c0e8106d834ffcede2012d73695564b335a50`）失败：该提交只改 `scripts/migration/materialize-pg-release-snapshot.py`、对应 Python 回归和本账本，完整 next-serving PR 门禁已为 `190/190`；旧 Check code 仍无差别执行根仓库 Node 套件，触发 77 个对 next-serving Python/发布 workflow 的陈旧重复静态断言。
- 最小修复：Check code 先按 push base 精确识别根 Node 输入；仅逐文件列出的 next-serving-owned Python、WDC deploy 与发布 workflow 改动由完整 `test-next-serving-v3.yml` 阻断，真正改到根 Node/前端/其他迁移脚本输入时仍执行完整 Node 套件。禁止用 `scripts/migration/*.py` 一类宽泛排除。`check-code.yml` 本身加入 next-serving PR path、sparse checkout、diff 与秘密扫描，避免路由规则无门禁修改。
- 回归 `test_check_code_scopes_node_suite_away_from_next_serving_python_changes` 锁定排除清单和 skip marker；当前 targeted `1/1`、next-serving `191/191`、relay `5/5`、workflow YAML、Check code shell syntax 与 `git diff --check` 均通过。下一步为提交、PR/CI/squash merge；不得把这次 CI 归属错误误报为 WDC 数据修复或通过证据。

### 2026-08-21 08:08 Asia/Taipei — WDC 门禁 sparse checkout 修复

- force WDC run `32431309635`（head `3c562c8ae2d550a59dbe9ba544bdec3e2f8cc459`）在 Ubuntu gate 失败：完整 next-serving 测试的 190 项通过，新增 Check code 路由测试因 `.github/workflows/check-code.yml` 未包含在 WDC sparse checkout 而唯一报 `FileNotFoundError`；sync job skipped，Mac materialize/relay/WDC 写入均未开始。
- 最小修复：将 `.github/workflows/check-code.yml` 同时加入 WDC Ubuntu gate 与 Mac source 两份 sparse checkout，避免 Ubuntu 修好后又在 Mac regression 阶段重复失败；不改变发布逻辑、超时、数据或生产状态。
- 新回归 `test_wdc_release_checkouts_include_check_code_contract_for_both_gates` 精确要求该路径出现两次并位于两个 checkout 之后；通过完整测试和 CI 后才允许唯一 latest-head WDC 重跑。

### 2026-08-22 13:35 Asia/Taipei — WDC 传输提速与断线恢复修复

- WDC run `32528974605`（head `33b091564eff5f54e142c9ab92c30ab016076811`）在昂贵 affected-parent source 阶段发生精确 PostgreSQL/SSH transport EOF。热切换同一 run 的 SSH tunnel 到压缩模式后，真实生产形态样本为 raw `4,879,204` bytes、gzip `1,015,917` bytes（约 `4.80x`），实际 relay raw/wire 约 `56.2/12.2 MB`（约 `4.6x`），证明旧 tunnel 未压缩是主要速度瓶颈。
- run 随后未能恢复的第二根因是重连身份检查调用完整 `meta_payload`，错误地重新生成并传输约 `56 MB` 的 overlay/meta，而身份复核实际只需要 active revision、content hash 与 source commit。该长传输再次遇到 SSH 关闭，最终以 `RuntimeError: PostgreSQL snapshot transport did not recover within bounded attempts: phase=affected-parent-sources attempts=12` 失败；WDC 未 bundle/deploy，Mac exact root 已清理。
- 失败 run 的 Actions cleanup 未能关闭 VPS2 relay，已只针对 `dsl-wdc-pg-relay-32528974605-1` 和 `/tmp/dsl-pg-relay-32528974605-1` 精确清理；结果为 unit inactive、remaining backends `0`、root absent。重复 scheduled WDC `32553341859` 已精确取消，合法 core/accepted/backfill 未取消。
- 永久最小修复：WDC SSH control tunnel 从启动即启用 `Compression=yes`；`pg_adapter.meta_payload(..., identity_only=True)` 在 runtime 与 generic runtime 路径读取到轻量身份后立即返回，跳过 overlay reconciliation/counts；transport 重连只使用该轻量模式并继续 fail-closed 比对 active/content/source 三元组。数据错误、身份漂移和 schema 错误仍不得重试，9 小时上限不增加。
- 回归覆盖 workflow 压缩合同、重连必须使用 `identity_only=True`、generic identity-only 不执行昂贵 overlay reconciliation。当前 targeted `4/4`、完整 next-serving `204/204`、relay `5/5`、Python compile、workflow YAML 与 `git diff --check` 均通过。下一步为 commit/push/PR/CI/squash merge；等待最新合法 accepted 完成后只调度唯一 latest-head WDC，并验证压缩 tunnel、轻量重连/完整-source resume、最终 bundle/deploy 与公网验收。

### 2026-08-22 18:13 Asia/Taipei — WDC `/run` noexec askpass 修复

- latest-head WDC run `32566517174`（head `1a05b948ee1e361f0ee14d15b5ae219ab18cb709`）已越过 Ubuntu gate、轻量 meta 身份读取和稀疏源码传输，但在启动 WDC 到 VPS2 的 SSH tunnel 后于 42 秒内退出 `124`。WDC journal 的永久错误为 `/run/dsl-wdc-32566517174-1/vps2-askpass.sh: Permission denied`；宿主 `/run` 挂载含 `noexec`，systemd 按 Restart=on-failure 重启仍必然重复同一错误。不是超时不足，也不能用加长 timeout 修复。
- 失败 run 未创建 32GB 构建卷、未启动 bundle/deploy、未写生产；Actions cleanup 后 WDC control/secret/volume roots 均不存在，tunnel/build units inactive，VPS2 relay/root 已清理，线上仍为旧 release。旧或重复 WDC 不恢复。
- 最小修复保持密码和 known-hosts 仅存于 run-scoped `/run` secret root；经过 source manifest 哈希验证且 mode `0500` 的 `wdc-vps2-askpass.sh` 改从 `/opt/culua/ytb-song-rank/.build/dsl-wdc-<run>-<attempt>/source/deploy` 执行，并精确校验真实脚本目录。删除把可执行脚本复制进 `noexec /run` 的步骤，不放宽 owner、路径、mode、host key 或身份门禁。
- 回归与本地门禁已通过：精确 askpass/noexec 回归 `1/1`、完整 next-serving `207/207`、relay `13/13`，controller/tunnel/askpass shell syntax 与 `git diff --check` 均成功。下一步为 commit/push/PR/CI/squash merge；合法 writer 空闲后只运行唯一 latest-head WDC，并验证 tunnel、32GB 固定卷、2.5GB/1GB cgroup、16GB/2 relay、最终发布与公网验收。

### 2026-08-23 00:12 Asia/Taipei — Mac 稀疏 checkout 断线恢复与精确回收

- scheduled core run `32581739087` 在隔离 checkout 的初次 filtered fetch 已完成后，于 sparse promisor blob 读取遇到 `curl 18 Transferred a partial file`、`unexpected disconnect`、`early EOF`，精确缺失对象 `2aad4b...`；checkout 约 34 MiB、Git RSS 约 9 MiB、Mac 可用约 564 GiB，证明是用户切换节点后的 transport 中断，不是内存或磁盘不足。未进入 build/commit/accepted；旧 cleanup 因无完整 `HEAD` 又执行 `git restore data/ui/meta.json` 而失败。
- main push Check code run `32581763970` 复现同类边界：action 内建 fetch 重试曾从 `curl 92 HTTP/2 CANCEL` 恢复，随后 sparse checkout 又以 `curl 18`、剩余 `12880` bytes、`early EOF`、promisor object `7c4ce8...` 失败；后续 checks 全部 skipped，精确 source cleanup success。该证据要求修复不能只覆盖 core。
- PR `#93` 首个 commit `d2b8681a341c354fa10d152fbe50b153ee07814d` 已为 core checkout 增加 owner-bound partial-clone 复用、仅 transport 错误最多 3 次重试、非 transport fail-closed 和无完整 checkout 时的安全 cleanup；Ubuntu CI run `32583673762` success。
- 本轮继续将同一边界覆盖 Check code 主 checkout、单文件 canonical blocklist checkout 与 backfill checkout，并为 Check/core/backfill 增加 owner marker 下的 job-end 精确删除；Check source 总量硬限 `<1,000,000,000` bytes。accepted run `32583012992` 已按 producer failure 正确 no-op success，没有伪造候选或激活生产。完整回归、PR CI、merge 后 main Check marker及唯一 latest-head WDC 仍待执行，交付未完成。

### 2026-08-23 00:41 Asia/Taipei — 普通 Check 迁出 Mac 本地网络

- PR `#93` 合并后的真实 main Check run `32584508285` 证明 owner-bound 重试和精确回收均按合同执行，但用户切换后的 Mac 网络无法在三次有界尝试内取回同一 promisor object `7c4ce83ecf4963503d766717eade0227bf6634c4`：attempt 1 为 `curl 18` 且尚缺 `25` bytes，attempt 2 为 `curl 92 HTTP/2 CANCEL` 且尚缺 `19642` bytes，attempt 3 再次 `curl 18`/`early EOF`。失败不是磁盘或内存：owned checkout 峰值约 `57.6 MiB`、Mac 可用约 `564 GiB`；job-end cleanup success，source root 与 owner marker 均已删除。
- 继续增加重试次数只会重复消耗用户本地网络并阻塞唯一 Mac runner。最小流程修复把日常 `check` job 迁到 GitHub-hosted `ubuntu-latest`，使用固定 Node 20；真正专用且仅手动触发的 `curation_audit` 仍保留 Mac label。checkout 的 `<1 GB` 硬限、owner marker、仅 transport 重试、非 transport fail-closed 和精确 cleanup 合同全部保留。
- 新回归精确分割两个 job，要求普通 Check 不再含 `daily-song-list-mac` 且必须使用 hosted Node，curation audit 仍为 self-hosted Mac。完成 targeted/full/relay/YAML/shell/diff、PR/CI/squash merge 后，必须由新 main push run 证明 Mac 不再被普通 Check 占用；随后等待合法 core/accepted 收敛并只调度唯一 latest-head WDC。

### 2026-08-23 03:18 Asia/Taipei — WDC Artist 完整 owner 与三首预览边界

- unique latest-head WDC run `32590039517`（head `7c7f7c339c40fb0d50d1d2b7a40fb82c55e3dcc2`）在所有 7d/all 四类排名生成完成后、昂贵 source copy 前由新 Artist owner 门禁 fail closed：`all/6653c1838b14e4a3 ranking=285 owners=3`。构建只使用 WDC 固定 32GB 隔离卷和 2.5GiB memory cgroup；实际失败前卷约 3GB、VPS2→WDC tunnel 约 1.35GB，Mac 不在传输或物化链路。
- 生产数据没有被删改。精确根因为 compact Artist 列表卡按公开契约只保留前三首 `songs` 预览，而门禁错误把 compact payload 当成完整 285 首权威 owner 列表；`songCount=285` 本身正确。失败 run 未 bundle/deploy，cleanup 已删除约 6.85GB 临时 SQLite/固定卷，VPS2 relay inactive，WDC 项目回到旧 release 约 7.61GB。
- 最小修复在 compact 前把完整 Artist song owners 写入构建期私有 SQLite 表；门禁和 source canonicalization 使用完整表，同时验证公开三首预览必须是完整列表前缀。私有表在 `finish()` 前删除，不进入 serving SQLite。缺表、计数不符、顺序/身份漂移继续 fail closed。新增 285-owner 生产形态回归和缺失完整表回归；完成全量门禁、PR/CI/squash merge 后仅运行唯一 latest-head WDC。

### 2026-08-23 03:34 Asia/Taipei — WDC Artist owner 捕获调用边界修复

- unique latest-head WDC run `32593000694`（head `f1dfa3b04ca98748fa7f8f4d65c62ca47030d559`）在 7d 四类与 all/songs 三指标完成后，于 `all/artists` 首次写私有 owner 表时再次 fail closed：`all/6653c1838b14e4a3 ranking=285 owners=3`。精确原因不是上一轮数据判断错误，而是 `SnapshotPageBuilder` 已在 adapter 的 page-independent preparation 阶段启用 `_snapshotCompactCards`；受 overlay 影响的 Artist summary 在 writer 的“compact 前”循环之前就已截为三首，因此 writer 仍收不到完整列表。
- run 失败前固定卷约 `1.82GB`，cgroup memory peak `2,536,812,544` bytes、swap `0`，relay 未超 `16GB/2`；未 bundle/deploy。Actions 的 exact cleanup 成功，WDC 项目恢复 `7,611,437,438` bytes、可用约 `79.4GB`，VPS2 relay inactive，生产 release 未写入。
- 最小修复只给离线 `all/artists` snapshot preparation 增加 `_snapshotPreserveArtistOwnerSongs`：保留完整、当前约 21k 条 canonical Artist-song owner 到 writer 私有表；公开 serving ranking 仍在后续统一 compact 步骤截为三首。该 flag 只允许与 snapshot compact 同时使用，在线 API 不设置。新增生产键 285-owner adapter 回归与 `SnapshotPageBuilder` 真实 flag 传递回归；完成全量门禁、PR/CI/squash merge 后仅运行唯一 latest-head WDC。

### 2026-08-23 04:11 Asia/Taipei — WDC 交接文档的 Check code 范围修复

- PR `#97` 只新增/更新 `AGENTS.md`、`README.md` 与 `docs/WDC_RELEASE_RUNBOOK.md`，用于固化 WDC 的 32GB 构建卷、2.5GiB 内存、1GiB swap、16GB/2 relay、稀疏源码、唯一 latest-head run、SSH/GitHub 操作和精确 cleanup 交接合同；其 PR CI `32595581848` success，squash merge 为 `4208fcbfb2734497c75131c5a2ca9875a8433002`。
- main push Check code run `32595673008` 精确失败边界为 `CODEX_NODE_TESTS_SELECTED count=1 first=docs/WDC_RELEASE_RUNBOOK.md`；随后执行与该 Markdown 文档无关的根 Node 套件，结果 `723 pass / 81 fail / 2 skipped`。这是路径路由误判，不是 WDC 数据、发布代码或公网回归。
- 最小修复仅将精确路径 `docs/WDC_RELEASE_RUNBOOK.md` 加入 next-serving/WDC-owned 排除清单；不排除其他 `docs/*`，真正影响根 Node/前端/通用迁移输入的变更仍执行完整 Node 套件。回归同时要求精确路径存在且禁止宽泛 `docs/*`。完成 targeted/full/relay/YAML/shell/diff、PR/CI/squash merge并由 main push 日志证明 `CODEX_NODE_TESTS_SKIPPED reason=no-node-input-changes` 后，才允许唯一 latest-head WDC。

### 2026-08-23 05:28 Asia/Taipei — WDC overlay Artist occurrence owner 前置门禁

- unique latest-head WDC run `32596661131`（head `13328b64982122d810b5f1144b2d7bb0ddb2e778`）已完成 7d/all 四类排名、7d authoritative sources、完整 Artist/Song owner 与 affected-source 前置门禁，并进入 affected-parent source `6000/21018`；随后精确失败于 `all/4e55bbe59fa2793b`：raw title `09≫Butterfly  // 倖田來未`、legacy ingestion `songKey=34ae49b3c7f0e35ca2d1ea90` 无法映射到当前 Artist ranking owner。
- 只读 PostgreSQL 核验定位到 `accepted_30232192378_1` / video `cAmudvGb0YM`：相同 occurrence 有单空格与双空格标题，artist 为空，raw payload 与 scalar 都保留旧 ingestion key；生产 canonical 内容未删除或修改。Artist ranking owner 使用 `normalizeEntityKey`（NFKC、大小写与内部空白折叠），而 source 的名称回退只做 NFKC/casefold，导致双空格变体绕过同一 owner；这不是磁盘、内存或网络失败。
- 失败 run 的资源硬门禁均真实生效：source checkout `1,742,752` bytes 且无 `.git`，固定卷 `32,000,000,000` bytes，cgroup MemoryMax `2,684,354,560`、swap max `1,073,741,824`、实际 swap `0`，relay `16GB/2` 上限；未 OOM、未 bundle/deploy、WDC 未写入。Actions cleanup success，固定卷/exact root/relay 均 absent/inactive。
- 最小修复让 source name fallback 复用 ranking 的同一 `normalizeEntityKey`，只修 canonical SQLite key/name，raw occurrence JSON 保持原样；新增无 payload 的全 affected-video overlay Artist occurrence owner 前置门禁，在任何 source copy 前用完整 ranking owner 表验证每条被选 occurrence。精确生产形态回归覆盖同一 legacy key 下单/双空格标题，并锁定原始 payload 不变；完成全量测试、PR/CI/squash merge后只运行唯一 latest-head WDC。
- 验证已完成：精确回归 `3/3`、完整 next-serving `218/218`、relay `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与其中 59 个 shell block 均通过；提交严格只包含物化器、回归测试和本失败账本。

### 2026-08-23 06:48 Asia/Taipei — overlay Artist 门禁必须应用最终 runtime replacement

- unique latest-head WDC run `32601841131`（head `d40c8244c9047d46df5911a0a84355fd901a4be3`）在 7d/all 四类排名、7d sources、完整 Artist ranking owner 与 persisted Artist owner 门禁之后，由新增 overlay Artist 前置门禁提前 fail closed：`all/4e55bbe59fa2793b` 的旧候选标题为 `Butter-Fly/和田光司 https://www.youtube.com/watch?v=emj_7G0y6n8`、legacy `songKey=8e9501ebdfb186aa4b98134a`。失败发生在任何 21k/64k source copy 之前，证明早期门禁位置生效。
- 只读 PostgreSQL 生产核验确认该旧候选来自 `accepted_30824108336_1` / video `aPsKoVWQs-E` / occurrence `aPsKoVWQs-E:21:3293`；后续 `accepted_30977555895_1` 已以 runtime replacement 将最终标题明确改为 `Butter-Fly`，并保留旧 URL 标题为 original identity。排名正确应用 replacement，而门禁错误地只验证候选集合、没有应用最终 runtime tombstone/replacement chain，因此这是门禁假失败，不是生产歌名需要正则清洗，更不是允许修改 canonical PostgreSQL 的理由。
- 最小修复让门禁复用 adapter 的最终 runtime change 与 replacement 解析：被替换/删除的旧 candidate 不再参与 owner 校验，replacement 以最终有效 tuple 参与；raw candidate/replacement payload 均不改。门禁同时遍历完整有效集合并一次汇总 owner mismatch 数量及最多 5 个样本，避免每次重跑只暴露第一条同类故障；身份、基数、owner ambiguity 与非匹配异常仍 fail closed。
- 失败 run 的资源合同全部生效：WDC source checkout `1,748,345` bytes 且无 `.git`，固定卷恰为 `32,000,000,000` bytes，MemoryMax `2,684,354,560`、swap max `1,073,741,824`、OOM/kill `0`，relay `16GB/2` 上限；未 bundle/deploy。Actions exact cleanup success，WDC build root/volume 与 VPS2 relay 均 absent/inactive，旧 release 未写入。
- 验证已完成：原始 URL candidate + 后续 `Butter-Fly` replacement 生产形态与上一轮单/双空格 owner 精确回归 `2/2`，完整 next-serving `219/219`、relay/storage/release contract `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与 59 个 shell block 均通过。PR/CI/merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-23 11:57 Asia/Taipei — canonical Song 卡不得按 raw `songKey` 重复计数

- unique latest-head WDC run `32614567419`（head `07801ee3a28bb7a94eb4dea4753a8c041837ff63`）在所有 7d/all 排名、7d sources 及 Artist/Song/affected-source 全量前置门禁通过后，于首个 affected-parent source 由 cardinality gate 提前 fail closed：`all/songs/01a4e810b81fbd3b ranking=(554,2,553,554) source=(554,1,553,554)`。没有进入 21k/64k 昂贵来源复制、bundle 或 deploy。
- 只读 PostgreSQL 证据确认权威卡 owner 为 `蝶々結び::aimer`，base 为 `552 occurrences / 550 videos`；overlay 仍保留 hashed `328e8b3da2343b88213af0ee` 与 legacy `蝶々結び\x1fAimer` 两种 raw ingestion key，但 canonical title/artist 同为 `蝶々結び / Aimer`。来源 writer 按权威卡 owner 正确归一为一首；ranking overlay 错把两种 raw provenance 当成两首。
- 最小修复只收紧 Song 类视图（`songs`、`songIndex`、`vsingerSongs`）的不变量：一个正数 canonical 卡的 `songCount` 恒为 `1`，既覆盖新卡/既有卡 delta，也覆盖 streamed affected reconciliation；Artist/VTuber/video 仍按不同 canonical song identity 计数。raw occurrence payload、canonical PostgreSQL、source writer 和 cardinality gate 均不修改、不放宽。
- 失败 run 的受限资源合同真实生效：固定 image `32,000,000,000` bytes，实际占用峰值约 `3.21GB`，MemoryMax `2,684,354,560`、swap peak `0`、OOM/kill `0`，relay wire 约 `1.48GB / 16GB` 且最多 2 connections；Mac/Windows 不在数据链路。Actions exact cleanup success，WDC 项目回到 `7,611,437,438` bytes、可用约 `79.4GB`，build/guard/tunnel 与 VPS2 relay 均 inactive，生产 release 未写入。
- 验证已完成：精确生产形态回归 `4/4`、完整 next-serving `227/227`、relay/storage/release contract `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与其中 59 个 shell block 均通过。PR/CI/squash merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-23 13:08 Asia/Taipei — VTuber 同视频 replacement 不得从来源丢失

- unique latest-head WDC run `32617382575`（head `abaffff6408c38a46e397b3c4f92732b1d60f1d2`）在全量排名、7d sources 及 Artist/Song/affected-source 前置门禁通过后，于首个 affected-parent source checkpoint fail closed：`all/vtubers/02a4448308f0bbdf ranking=(56,53,2,56) source=(55,52,2,55)`。未进入 bundle/deploy，生产 release 未写入。
- 只读 PostgreSQL 证据确认父 source `戌峯 ひぐれ` 有 56 条；唯一变化是 `accepted_30745527918_1` 对 video `M4iBwhm_hRI`、occurrence `ffca0d2f8e3f1d0b5aa3fd75` 的同视频 `replace_entry`，标题从 `⭐逆光（ウタfrom ONE PIECE FILM RED）` 改为 `逆光`。replacement 保留精确 video/occurrence identity，但不重复携带 channelId/handle/name；它不是删除。
- 根因是来源物化先按精确 identity 删除父 tuple，随后又要求 replacement payload 单独证明 VTuber channel owner，因 channel 字段缺失而静默跳过回填。排名路径使用父视频身份，故仍为正确的 `56/53/2/56`；cardinality gate 正确，不放宽。
- 最小修复只对唯一匹配、`replacementSameVideo=true` 的 VTuber occurrence 使用精确父 source preimage：保留父 video/channel authority，原位更新公开 occurrence；replacement 显式给出冲突 channel identity、缺 title 或改变 video/occurrence identity 时继续 fail closed。raw payload 与 canonical PostgreSQL 均不修改。
- 全 revision 早期门禁复用最终 affected/unaffected source exporter 和 durable checkpoint，先物化所有 all-range VTuber sources，再进入其他 source copy；后续通用阶段跳过已完成 key，不新增第二套算法或磁盘副本。失败 run 的 32GB image、2.5GiB/1GiB cgroup、16GB/2 relay 与 exact cleanup 均生效；WDC 项目恢复约 `7.61GB`、VPS2 relay inactive。
- 验证已完成：精确 replacement 与冲突 owner 回归 `2/2`、完整 next-serving `229/229`、relay/storage/release contract `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与其中 59 个 shell block 均通过。PR/CI/squash merge及唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-23 14:20 Asia/Taipei — 7d runtime replacement 不得跨 range 污染 all 来源

- unique latest-head WDC run `32620456133`（head `56892e5dafd8deb6b9469fbcddc1f8832c05486d`）已在约 35 分钟内完成 7d/all 四类排名、7d sources、Artist/Song/affected-source 全量门禁，并由全 revision VTuber 早期 exporter fail closed：`all/vtubers/2b696ea285946929 ranking=(141,121,8,141) source=(140,120,8,140)`。未进入非 VTuber 昂贵 source copy、bundle 或 deploy，生产 release 未写入。
- 只读 PostgreSQL 核验定位到 `紫薇令あもる / Shibirei Amoru` 的 video `MhemBDB0yJo`、occurrence `position:4`：`accepted_30745527918_1` 是 `rangeId=7d` 的 same-video `replace_entry`，将 `逆光(ウタ from ONE PIECE FILM RED)` / songKey `de3ab...` 改为 `逆光` / songKey `6e23...`；该变更不是 all-range tuple。排名路径按精确 physical range 过滤，来源准备路径却把 lineage 的 runtime changes 原样交给 all source，导致 replacement 的 `rangeId=7d` 覆盖父 all tuple并在最终 all 过滤时丢失一条。
- 最小修复让 `_snapshot_source_overlay_inputs` 复用排名已有 `_overlay_rows_for_range` 合同：`all` 只接收显式 all/历史空 range，`7d` 只接收显式 7d/历史空 range；不修改 raw payload、canonical PostgreSQL 或 cardinality gate。精确生产形态回归断言 7d change 不进入 all source，父 all tuple及 `2/2/1/2` cardinality 保持。
- 本次 run 的固定 image 恰为 `32,000,000,000` bytes，稀疏 source 约 `1.76MB` 且无 `.git`，MemoryMax `2,684,354,560`、swap peak `0`、OOM/kill `0`，relay 约 `1.65GB` 且未超 `16GB/2`；实际构建占用约 `3.53GB`。Actions cleanup success，WDC 项目恢复 `7,611,437,438` bytes、可用约 `79.4GB`，build/tunnel 与 VPS2 relay inactive。重复 scheduled run `32621309890` 已在旧 head 重型阶段早期精确取消，远端 cleanup success。
- 为避免继续“一次重跑只暴露一个键”，本轮同时把现有最终 VTuber affected/unaffected exporter 的 cardinality mismatch 改为 checkpoint 驱动聚合：只捕获结构化 cardinality mismatch，失败 key 不获 checkpoint；普通身份、writer-row-loss、transport 与 PostgreSQL 错误仍立即失败。所有 VTuber key 扫描后、任何非 VTuber source copy 前一次输出全部 mismatch 并失败。
- 验证已完成：跨 range/同视频 replacement/冲突 owner 与 mismatch collector 精确回归 `5/5`、完整 next-serving `232/232`、relay/storage/release contract `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与其中 59 个 shell block 均通过。PR/CI/squash merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-23 16:45 Asia/Taipei — VTuber 父 source owner 与当前频道别名必须合并为同一聚合 owner

- unique latest-head WDC run `32623783472`（head `fe13c15ad8145b8e989643d8069e3cb21570b5de`）由全 revision VTuber 早期 exporter 完整扫描 `661` 个 all-range VTuber sources，在任何非 VTuber 来源复制前一次汇总且 fail closed。只有 `3375a12917fd67fa`、`3788ba1eb3794773`、`6475354d2f0b192c`、`84604a26c58d6f3e`、`dee2dc227e337b1c` 五个 mismatch；ranking/source 分别为 `5532/5531`、`577/571`、`7482/7481`、`4434/4424`、`427/425` occurrences。
- 只读 PostgreSQL 回放确认来源 exporter 的最终值正确：`5531/816/232`、`571/297/54`、`7481/1246/481`、`4424/1343/293`、`425/368/49`（occurrences/songs/videos）。根因是 direct-overlay VTuber ranking 对 selected reset/runtime tombstone 只使用当前视频的 channel 标量；父 source 已有精确 owner 时，旧名字、handle 或同一 strong channel ID 的当前投影被误当为第二个频道。`Rieru Ch. 我部りえる /あおぎり高校` 是只有 legacy name owner 的同一边界，不是生产数据删除或需要修数据。
- 最小修复仅对已选 reset/缺失旧 channel 的有界 video 集合，通过现有 trigram video-search 索引精确回查 persisted VTuber source owner；只在 strong channel ID 相同、handle 精确相同或 batch 内唯一 normalized legacy name 相同时，把 candidate/replacement 的聚合 owner 统一为父 owner。真实频道迁移保留新旧两侧；两个父 source、无效身份或父 ranking/source 不一致均继续 fail closed。raw payload、canonical PostgreSQL 与 source writer 不修改。
- 失败 run 的 Actions cleanup success：32GB 固定 image/exact root 均 absent，VPS2 relay inactive，WDC 项目恢复 `7,611,437,438` bytes、可用 `79,405,547,520` bytes，生产 release 未写入。实际 memory peak `2,684,715,008` bytes、swap `0`、OOM/kill `0`。
- 验证已完成：聚焦 owner/index/ambiguity/legacy alias/true move/replacement 回归通过，完整 next-serving `237/237`、relay/storage/release contract `13/13`、Python compile、`git diff --check`、7 份 workflow YAML 与 59 个 shell block 通过。生产形态只读回放完成五个 source 并输出 `READ_ONLY_ROLLBACK_OK`。PR/CI/squash merge 与唯一 latest-head WDC 仍待完成，交付未完成。

### 2026-08-23 18:02 Asia/Taipei — 推导出的 VTuber 视频 owner 不得伪造父 occurrence preimage

- unique latest-head WDC run `32629989536`（head `ae2856179b7bbc8bfd71fc37271a6be2c6ebe219`）已在 WDC 服务端固定 `32,000,000,000` bytes 隔离卷中完成 7d 四类排名、all/songs 与 all/artists，随后在 all/vtubers 精确聚合 fail closed：`PostgresAdapterError: VTuber occurrence preimage coverage is incomplete`。实际 memory peak 恰为 `2,684,354,560` bytes、swap `0`、OOM/kill `0`，构建卷约 `2.13GB`，relay 约 `1.01GB`，不是容量或 OOM 失败。
- 使用远端 merge 文件哈希 `2148048027caac5c0e4d266a73d8bb7c2a99944540e34f3399fbdcab3feafce1` 对 active `accepted_32589432063_1` / parent `full_runtime_30257210187_1` 做生产只读全 revision 回放，精确得到 requested `2162`、found `2147`、missing `15`；15 条全部是历史 runtime occurrence change，进入 parent-group enrichment 前均无 channel owner，且 exact `(video_id, occurrence_id)` 均不存在于 full-runtime parent。后续按视频查询 persisted VTuber owner 错把这些 newer-overlay-only occurrence 标为父侧可扣除记录，才制造不存在的 preimage；不是生产数据被删除。
- 最小修复复用已有的有界 exact parent occurrence 查询，在每条 runtime occurrence change 上保留“父 tuple 是否存在”和“原始 owner 是否显式”两个构建期私有布尔证据。只有父 tuple 不存在且 owner 纯属后续视频级推导时，VTuber 旧侧 subtraction 被跳过；独立校验的新侧 replacement 仍保留。原始就带 owner、身份冲突、错误 marker 或真实父 tuple 不一致继续 fail closed，不放宽数据身份契约。
- 失败 run 未 bundle/deploy；Actions cleanup success，WDC 固定卷/exact root absent、VPS2 relay inactive、生产 release 未写入。验证已完成：精确回归 `2/2`、完整 next-serving `238/238`、relay/storage/release contract `13/13`、Python compile、7 份 workflow YAML 与 59 个 shell block、`git diff --check` 均通过；修复后的同一生产快照只读全 revision 回放为 requested/found/missing=`2147/2147/0` 并输出 `READ_ONLY_ROLLBACK_OK`。下一步为 commit/push/PR/CI/squash merge，再只运行唯一 latest-head WDC。

### 2026-08-23 20:10 Asia/Taipei — loop backing file 二级页缓存不得突破 2.5 GiB cgroup

- unique latest-head WDC run `32633657925`（head `668d902dd581842fa3e252a55f01a963fd1f4f24`）已越过此前 VTuber preimage 故障，完成 7d/all 四类排名、7d authoritative sources、Artist/Song/affected-source 全量门禁，并在 checkpoint 驱动的 `affected-parent-sources` mismatch collector 中从 `675` 个待检查键推进到约 `276` 个；随后 build unit 精确以 `Result=oom-kill` / exit `75` 失败。`MemoryMax=2,684,354,560`、`MemoryPeak=2,684,968,960`、swap peak `0`，未 bundle/deploy，生产 release 未写入。
- 失败时 Python RSS 仅约 `0.4–0.7 GiB`，而 canonical SQLite/页面文件已约 `4.2 GiB`；materializer 每 2048 行仍持续对内部 SQLite 执行 `fdatasync + POSIX_FADV_DONTNEED` 并输出 `dropped=1`。根因是固定 ext4 volume 的 sparse backing image 通过普通 loop I/O 再形成一层由 build cgroup 计费的宿主页缓存，内部文件的 fadvise 无法驱逐该外层缓存；不是项目需要更大内存、磁盘或取消硬上限。
- 最小修复保持 32GB volume、2.5GiB memory、1GiB swap 与 9 小时 runtime 全部不变：loop attach 必须使用 `losetup --direct-io=on`，并在任何 `mkfs`/mount/materialize 前读回 `DIO=1` 和输出 `WDC_LOOP_DIRECT_IO_OK`，否则 fail closed。cardinality collector 删除未 checkpoint 的单个 partial source 后额外执行 SQLite `shrink_memory` 与精确 temp-file cache drop，避免删除页在同一进程内积累。
- OOM/SIGKILL 后不得盲目复用残留 volume：当前 SQLite 为随机 temp 且 `journal_mode=OFF`，checkpoint 只对同进程内的精确 PostgreSQL transport reconnect 有效；Actions failure cleanup 继续无条件删除 exact-owned volume。完成 direct-I/O/partial-discard 精确回归、全量测试、PR/CI/squash merge后，只运行唯一 latest-head WDC，并必须验证 `WDC_LOOP_DIRECT_IO_OK`、旧 OOM 里程碑已越过、cgroup memory 不再贴顶以及最终公网验收。
- 本地验证已通过：direct-I/O 与 partial-discard 精确回归 `2/2`、完整 next-serving `239/239`、relay/storage/release contract `13/13`、materializer Python compile、build shell syntax、7 份 workflow YAML 与其中 59 个 shell block、`git diff --check`。PR/CI/squash merge及唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-23 21:05 Asia/Taipei — VTuber ranking/source mutation 必须共享同一不可变身份合同

- unique latest-head WDC run `32637171741`（head `817a74381995719eb6e8baf31b524772aa9eb109`）已通过 `WDC_LOOP_DIRECT_IO_OK` 并越过旧 OOM 位置，完整扫描 `661` 个 all-range VTuber source 后一次聚合出 `26` 个 cardinality mismatch；整体 source-ranking 差值为 `+58 occurrences / -3 songs / +2 videos`。run 未 bundle/deploy；Actions exact cleanup success，WDC 固定卷/build root 与 VPS2 relay 均 absent/inactive，生产仍为旧 release。
- 资源合同本次真实生效且不构成失败原因：build unit `MemoryPeak=2,684,604,416` bytes、swap peak `315,932,672` bytes、OOM/kill=`0`，固定 image `32,000,000,000` bytes，稀疏 source 无 `.git`，relay 未越过 `16GB/2`；失败后临时 SQLite 已删除，WDC 项目占用恢复到旧 release 边界。
- 初步只读代码/生产形态证据显示两条相反的不对称必须同时闭合：同视频 replacement 在来源侧可由唯一 persisted preimage 原位更新，但 ranking 严格新侧在缺少独立 channel 字段时可能漏加；newer-overlay-only change 在来源侧 exact occurrenceId 不命中后仍可能用较弱的 video/seconds/title/artist tuple 误删另一条带不同非空 occurrenceId 的 source row。当前正在对全部 26 个键做 bounded、repeatable-read、只读变更矩阵，必须先精确证明正负差值算术，再实施共享 mutation 规则；不得修改 canonical PostgreSQL 或放宽 cardinality gate。
- mismatch collector 当前把捕获到的异常对象连同 traceback 保存在整轮字典中，可能把 exporter 的大闭包/批量 payload 一并保活到扫描结束。无论 cardinality 根因如何，本轮都要改成只保存六个不可变标量的 frozen/slots 记录，并新增弱引用回归，确保被抛异常及其 traceback 立即可回收；数据、transport 与身份异常继续原样 fail closed。
- bounded、repeatable-read 的生产只读矩阵已完成并回滚：`runtime_source_occurrences` 不含 `occurrence_id`/`song_key`，因此严禁把 source-local `position` 伪装成 immutable identity。26 个失败 source 一共出现 `167` 个 reduced-tuple 候选，其中 exact parent occurrence 证明存在的 replacement=`73`、parent-proven tombstone=`79`、父 tuple 明确不存在且只是后续视频 owner 推导的 overlay-only/no-op=`15`；15 条分布为 `3375a12917fd67fa=1`、`6475354d2f0b192c=1`、`84604a26c58d6f3e=11`、`dee2dc227e337b1c=2`。所有正向 occurrence 差值逐键总计恰为 `73`，与应保留的新侧一一闭合。
- 最小修复把 ranking/source mutation 统一到同一证明边界：source 只有 exact `occurrenceId` 才直接匹配；无该列的 persisted source 仅在 exact parent 查询已经证明父 tuple 存在时，才允许用 `video+seconds+canonical title/artist` 的 reduced tuple 原位更新；父 tuple 不存在时禁止弱匹配删除。same-video replacement 若能绑定唯一 persisted VTuber owner，ranking 新侧仍必须加入；只跳过未被父数据证明的旧侧 subtraction。marker 缺失时保持完整 legacy tuple 合同，单边身份或 owner 冲突继续 fail closed。
- 同一生产快照的 patched source replay 已覆盖全部 26 个 key，并输出 `READ_ONLY_ROLLBACK_OK`；occurrence/video 均与目标 ranking 闭合。`84604a26c58d6f3e` 的 patched source 为 `4435 occurrences / 1354 songs / 293 videos`，旧 ranking 为 `4435/1355/293`；该唯一 song 差异由既有、已测试的 VTuber song-count 有界 reconcile 处理，前提是 occurrences/video/timestamps 完全一致且 source songCount 更低，不能用来放宽其他 cardinality。
- collector 已改为只保存 frozen/slots 标量 record，不再持有异常 traceback；12 项精确回归全部通过，完整 next-serving `248/248` 通过，`git diff --check` 通过。回归覆盖 exact-parent replacement、parent-proven tombstone、overlay-only no-op、same-video persisted owner、新旧 marker、冲突/缺失身份及 traceback 弱引用回收。
- 一次额外的“逐 key 完整 public rankings payload”诊断尝试被判定为错误方案：它重复执行 page-independent 全量准备，在 VPS2 约 2GB 宿主上触发 global OOM，内核只杀死 owner-marked 单元 `dsl-wdc-cardinality-diagnostic-32637171741-8` 的只读 Python（anon RSS 约 `1.804GB`）。该事务未提交、单元已退出；随后 PostgreSQL `active`、`pg_isready` accepting、`SELECT 1` 成功，active 仍为 `accepted_32589432063_1`，content/source 前缀仍为 `86fbd44bd80a4e21/a5d92e94583484ed`。不得再运行该重型诊断；后续证明仅使用有界 source replay、算术闭合、回归及下一次 WDC 的全 revision 早期门禁。
- 提交前独立复审发现原精确测试曾把 ranking 绑定后的同一个可变 change 对象直接交给 source，掩盖了生产中两条独立加载链路。已把 source 输入路径改为在 exact-parent markers 落定后独立复用同一 bounded persisted VTuber owner 证明；overlay-only same-video replacement 可只增加新侧，但无 owner、多个 owner、跨视频或冲突 owner 仍 fail closed。生产形态回归现在分别创建 ranking/source change，source 只经 `_snapshot_source_overlay_inputs`，不再依赖 ranking 的原地变异。
- 同次复审还发现 old-side skip 必须晚于 exact source occurrence-ID 判断：即使 runtime parent 已无该 tuple，persisted source payload 中完全相同的 `(videoId, occurrenceId)` 仍是不可变 preimage，可以安全删除或原位 replacement；只有 exact ID miss 时才禁止 reduced-tuple fallback。新增回归同时锁定“exact ID 仍处理”和“相似弱 tuple 仍保留”，避免 source-only preimage 重复或漏删。
- 剩余本地门禁也已完成：relay/storage/release contract `13/13`、Python compile `3/3`、7 份 workflow YAML 与其中 `59` 个 shell block syntax 全部通过。下一步为清除本轮精确归属的 pycache/诊断/远端 owner root，仅提交本节四个文件；push/PR/CI/squash merge 后只运行唯一 latest-head WDC，并在成功 bundle/deploy 后完成公网及真实浏览器验收。交付仍未完成。

### 2026-08-23 23:55 Asia/Taipei — exact legacy VTuber owner 必须保留同视频 replacement 新侧

- unique latest-head WDC run `32645658470`（head `ea78a55ca35234bf435b1e87c48995f342e16ecb`）已通过 `WDC_LOOP_DIRECT_IO_OK`、12 个 7d/all 排名组合、7d authoritative sources、Artist/Song/affected-source 全量门禁，并完成 affected-parent `152/152` 与 parent sources `661/661`；随后全 revision VTuber source cardinality 门禁一次汇总 `22` 个 mismatch 后 fail closed。run 未 bundle/deploy；Actions exact cleanup success，32GB fixed image/build root 与 VPS2 relay 均 absent/inactive，生产 release 未写入。
- bounded repeatable-read 生产只读矩阵已回滚并输出 `READ_ONLY_ROLLBACK_OK`：22 键正差恰为 `+73 occurrences`，对应 73 条不同 video 的 runtime replacement；73/73 都有 exact full-runtime parent occurrence、`replacementSameVideo=true`、replacement video/occurrence 与旧侧完全相同，并且每个 video 在 persisted VTuber source authority 中恰有一个 source/entity owner，无多 owner 反例。72 条为 `フィナーレ / eill -> フィナーレ。 / eill`，另 1 条为 `⭐逆光（ウタfrom ONE PIECE FILM RED） / Ado -> 逆光 / Ado`。
- 这些历史 owner 73/73 都是 name-only legacy identity：旧侧、replacement 和 persisted detail 均没有 immutable channelId/handle。上一轮绑定器虽已查到唯一 source owner，却只接受 `UC...` strong id，因而 73/73 在 strict ranking replacement 中仍被跳过；ranking 减旧侧却未加新侧，而 source exporter 按 exact persisted tuple 原位更新并保持基数，正好形成全部差异。生产 canonical PostgreSQL 与 raw occurrence payload 均未删除或修改。
- 最小修复新增只由 bounded persisted-owner binder 产生的私有证明：仅当 exact parent occurrence、same video、same occurrence、唯一 source/entity owner、无任何显式 channel/handle/url 冲突时，replacement 以 `canonicalVtuberChannelKey` 回到同一聚合 owner；overlay payload 不能自带或伪造该证明。legacy entity key 永不写入公开 `channelId`，也不生成 `/channel/<legacy-name>` URL；cross-video、parent miss、owner ambiguity、强身份冲突继续 fail closed。强 `UC...` owner 与 accepted reset alias 仍走原合同。
- 总控提交前复审又锁定两个旁路：exact-channel scope 旧筛选只认公开强 ID，会漏掉已经由私有 proof 绑定的 legacy replacement；历史 base payload 若错误携带非 `UC...` 的 `channelId`，也不得由 legacy owner 路径生成伪 `/channel/...` URL。现统一通过私有 aggregate owner 选择器进入 exact scope，并在 candidate 缺公开 ID 时对 base channelId 严格 fail closed；legacy key 仍只作内部聚合键。
- 本地验证已完成：legacy 生产形态、exact scope、公开 metadata、parent-miss、冲突 identity 与 strong-owner 路径精确回归 `6/6`，完整 next-serving `249/249`、relay/storage/release contract `13/13`、Python compile、7 份 workflow YAML、7 个部署 shell 脚本、Node syntax 与 `git diff --check` 均通过。push/PR/CI/squash merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-24 01:42 Asia/Taipei — legacy VTuber metadata 不得把内部 owner 键当公开 channelId

- 唯一 latest-head WDC run `32653596544`（head `483270209d34a7ac4fca63dc6f93f9a53fac0be0`）通过固定 32GB image、2.5GiB memory cgroup、7d/all songs 与 artists 视图后，在首次 all/vtubers 页面 hydration 失败：`PostgresAdapterError: VTuber ranking preview identity is invalid`，精确触发 `_canonicalize_vtuber_card_preview` line `7316`。失败 run 未 bundle/deploy，WDC 生产 release 未写入。
- 精确代码形态为旧 owner 的 `channelKey`/`detail_key` 是历史文本键，而同一张卡的全部 occurrence preview 带唯一合法 `UC...` channelId；`_apply_channel_metadata` 在没有公开 `channelId` 时回退把内部键写入 `channelId`，随后严格预览门禁把真实 occurrence 的 UC 身份误判为跨 owner。不是生产数据删除、容量、内存或 transport 故障。
- 资源与清理证据：固定 volume 约 `31.3GB/32GB`，cgroup `MemoryMax=2,684,354,560`、实际 peak 约 `1.2–1.37GB`、swap `0`；relay/tunnel 数据约数百 MB、连接正常；Actions exact cleanup success，临时 root/volume/relay 均已回收，旧 release `3cfb9f8...` 保持不变。
- 最小修复仅在元数据没有显式公开 ID，且全部预览 occurrence 的 channelId 集合恰为一个合法 `UC[A-Za-z0-9_-]{22}` 时，将该 immutable occurrence ID提升为公开 `channelId`；内部 `key`/source detail key 保持历史 owner，多个 UC、显式冲突或非 UC legacy ID继续 fail closed，并移除 legacy 伪 channelId/URL。
- 新增单一合法 UC 提升与多 owner 歧义回归；本地 targeted `2/2`、完整 next-serving `251/251`、`git diff --check` 已通过。提交、PR/CI/squash merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-24 02:03 Asia/Taipei — main Check code 必须监听 server/tests 输入

- main 手动 Check code run `32656479632`（head `05a71cad22c9da6108a358cd201fe74a8b3a73aa`）真实失败于 `Run checks`：`723 pass / 81 fail / 2 skipped`。失败原因是 workflow 的 `on.push.paths` 没有 `server/**` 或 `tests/**`；本次 Python 修复未自动触发 push Check，手动 dispatch 没有 base SHA，因而按合同执行了不适用的完整根 Node 套件。不是 WDC 数据、发布代码、网络或生产内容失败。
- 最小流程修复仅在 `.github/workflows/check-code.yml` 的 push path 中加入 `server/**` 与 `tests/**`；真正 server/tests 变化会进入 next-serving Python/WDC gate，其他根 Node/前端/迁移输入仍走完整 Node 套件。该 workflow 合同回归需在 PR/merge 后由 main push run 证明；在成功 Check code 前不得调度 WDC。

### 2026-08-24 04:35 Asia/Taipei — legacy video card songs 必须从最终 occurrence 集合重建

- unique latest-head WDC run `32657181896`（head `f831b033a64c70e96f730441170cbfcba1cd8a11`，sync job `97237893144`）在 `affected-parent-sources` source cardinality gate fail closed：`all/videos/055eb96097a5c180b5b24797 ranking=(13,15,1,13) source=(13,13,1,13)`。未 bundle/deploy，WDC 未写入；step4 exit 75，CPU 22m12.210s、memory peak 1.2GB、swap 0，宿主可用约 73.0GB，固定卷 used 约 6.23GB/31.32GB，Actions exact cleanup success。
- 只读 PostgreSQL 核验确认视频 `9RARtsp7ong` 的 parent runtime occurrence 有 15 条，ranking card 仍是旧 `songs` payload；两条 exact overlay tombstone 删除 `言い訳タイム/Excuse Time` 与 `言い訳タイム2/Excuse Time 2`，source writer 正确落为 13。根因不是资源或 transport，而是 persisted parent ranking row 以 `detail_key` 保存视频身份，deferred tombstone group 只查 `video_id/videoId`，且 legacy card 没有完整 `occurrences` 时无法从 immutable occurrence identity 重放，导致 ranking 保留 15 条旧 songs。
- 最小修复仅限 `server/pg_adapter.py`：视频 group key 兼容 persisted `detail_key`；在有 deferred reset/candidate/runtime change 的视频卡且 occurrence payload 缺失、preview-limited、或 count 不完整时，按 revision/video/range 有界读取 `runtime_occurrences`（上限 `_MAX_AFFECTED_RUNTIME_OCCURRENCES`），严格校验 video/occurrence identity、重复与 cap；重放最终 runtime changes 后，视频 `songs`/`songCount` 从有效 occurrences 重建。canonical PostgreSQL、raw payload、非视频视图与 cardinality gate 均未放宽。
- 新增精确生产形态回归 `test_generic_video_overlay_rebuilds_legacy_parent_songs_after_tombstones`，锁定真实视频 ID、15→13 occurrence、删除两首旧 song；targeted `3/3`（含相关 video/cardinality tests）和该全套孤立临时目录回归 `1/1` 通过。完整 next-serving `252` tests 中新增/相关场景均通过；剩余 3 个为 Windows `subprocess.run(text=True)` 的 GBK 解码既有环境失败，另有 1 个临时目录 `WinError 5`，同测试单独重跑通过；Python compile、`git diff --check` 通过。提交/推送/PR/CI/squash merge 与唯一 latest-head WDC 重跑仍待完成，交付未完成。

### 2026-08-24 05:55 Asia/Taipei — ranking hydration 必须复用严格 legacy video fallback

- 唯一 latest-head WDC run `32665360138`（head `bf1b169faa0dd9c91c7b1dbec24ada105cf4562f`，sync job `97258007903`）已在 7d/all 四类视图、7d sources 与 Artist/Song/affected-source 全量门禁之后，于 all/videos 首页 hydration fail closed：`PostgresAdapterError: generic video parent occurrence hydration returned no rows`。source identity 为 `accepted_32589432063_1` / content `86fbd44bd80a4e21429f384d8216077facc4c80583ac68cd81f01e4470af1857` / source commit `7c7f7c339c40fb0d50d1d2b7a40fb82c55e3dcc2`；未 bundle/deploy，生产 release 未写入。
- WDC 资源合同真实生效：固定卷 `31,317,221,376` bytes，失败时 volumeUsed 约 `20,717,568` bytes，宿主可用约 `79.3GB`，build cgroup `MemoryMax=2,684,354,560`、`MemoryPeak=523,952,128`、swap `0`，relay wire `268,451,043 / 16,000,000,000`、最多 2 connections；CPU 约 9 分钟，Actions exact cleanup、build/guard/tunnel/relay 均已回收。
- 根因是 PR #112 已修复 source exporter 的 legacy ranking-only parent（有完整 `runtime_ranking_rows` 的 `songs` 数组但没有 `runtime_videos/runtime_occurrences`），但 online-style generic ranking hydration 仍只查询物理 `runtime_occurrences`，对同一合法 legacy shape 报 no rows；不是 PostgreSQL 数据损坏、transport、内存或磁盘失败。
- 最小修复只在 `server/pg_adapter.py` 增加严格 legacy fallback：物理 occurrence 查询为空时，按 parent revision/range/view/metric/scope/detail_key 精确读取 `runtime_ranking_rows`，校验视频 identity、type、父 row counts 与 `songs` 长度、`video_count=1`，再生成仅内存的 occurrence 形状；有 deferred tombstone/replacement 时复用现有 exact video/title/artist overlay，最后从有效 occurrences 重建 `songs`/`songCount`。没有精确 parent ranking row、重复 row、identity/count 不一致仍 fail closed；canonical PostgreSQL、raw payload、资源上限均不放宽。
- 精确回归新增“无 runtime rows 时严格 ranking fallback、tombstone 仍从唯一 title/artist 删除”场景；generic-video 相关 `4/4`、Python compile、`git diff --check` 通过。完整本地 `254` tests 的既有环境结果为 `3` 个 Windows GBK subprocess 解码失败、1 个 Windows 临时目录 `WinError 5`、1 个 `pwd` 导入错误（Linux-only relay test），均与本修复无关；官方 CI 全量门禁仍需在 PR 上证明。失败已修复，下一步仅 commit/push/PR/CI/squash merge 后重新调度一个 latest-head WDC。

### 2026-08-24 08:30 Asia/Taipei — Song source 不得把 7d full-reset 投影进 all

- 唯一 latest-head WDC run `32669828964`（head `3bac7d329ea7e438cdd61e4ca2cd2ee4fdd4a3bc`，sync job `97269031118`）已完成 7d/all 四类排名、7d authoritative sources、Artist/Song/affected-source 全量 owner/preflight 及 VTuber `675/675` 子集；在 `affected-parent-sources` 第一个 source checkpoint 精确 fail closed：`all/songs/0682f35a270f7de2 ranking=(17,1,17,17) source=(18,1,18,18)`。未 bundle/deploy，生产 release 未写入。
- 只读 PostgreSQL 核验：父 source `full_runtime_30257210187_1` 的 all authority 为 `17/1/17/17`；overlay lineage 中唯一相关变更是 `accepted_30347149376_1`、video `stxKMausiFw`、7d `position:0` 的 `melancholic/未記載` occurrence。排名按物理 range 保持 17，但 generic Song source preparation 开启 `include_compatible_full_reset_7d`，把该 7d-only candidate 改投影为 all，导致 source 多出一条。canonical PostgreSQL、raw payload 均未修改。
- 最小修复仅在两个 persisted-source rebuild 路径收紧兼容投影：`record.type == song` 且请求 `range=all` 时不把 7d full-reset 作为 all Song candidate；Artist/Video 与 VTuber channel 仍保留既有兼容合同。这样 source 复用与 ranking 相同的 physical-range 边界，不放宽 cardinality gate。
- 新增精确回归锁定 persisted Song 的 `include_compatible_full_reset_7d=False`，并保留 Artist/VTuber 兼容投影回归；targeted `3/3` 通过。完整本地 `254` tests 结果为既有 Windows GBK subprocess `3` 项失败、1 个 Linux-only `pwd` relay 导入失败、3 skipped；本修复相关测试均通过，Python/contract/diff 门禁待 PR CI 复核。
- 失败 run 的资源合同真实生效：固定卷 `32,000,000,000` bytes，最后 guard volumeUsed `6,294,716,416`、宿主可用约 `73GB`，project `7,631,712,256` allocated / `7,615,721,429` logical，MemoryMax `2,684,354,560`、swap `1,073,741,824`；relay 未超 `16GB/2`。Actions exact cleanup success，临时 root/volume/relay 均 absent，WDC release 未写入。下一步为提交/推送/PR/CI/squash merge，再只调度一个 latest-head WDC；若再次失败仅从该 source checkpoint 诊断续接。
