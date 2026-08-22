# WDC 受限发布接手与审计 Runbook

本文是 Daily Song List 的 WDC 生产发布操作入口。它描述当前仓库实现的有界服务器侧发布链、必须保留的证据、允许的重试边界，以及总控接手时可直接执行的命令。

所有命令默认在 WSL bash 中执行。命令中的 `RUN_ID`、`ATTEMPT`、`RELEASE_SHA`、`EXPECTED_HEAD`、`PR_NUMBER` 必须替换为现场的精确值；占位符校验失败应直接停止。不得把主机地址、凭据值、Git extra header、私钥或 secret 写入命令、日志、截图或本文。

## 1. 权限与完成定义

- 文档、审查或候选分控只可做本地只读核对和明确授权的候选文件编辑；不得 commit、push、merge、dispatch、cancel、SSH 写入、发布、重启、清理或数据库写入。
- 只有总控可以执行本文标为 **写操作** 或 **破坏性操作** 的命令。执行前必须保存对应的只读证据。
- “workflow 成功”“测试全绿”“healthz 为 200”“候选已生成”都不是独立的上线证明。
- 生产目标只有在唯一 latest-head WDC run 完成、全量 API/数据/浏览器验收通过、连续 10 分钟观察通过、精确残留清理完成，并确认 `update-core.yml` 已恢复为 `active` 后才可 complete。
- 本文若与工作流或脚本不一致，停止操作。以代码事实定位差异，在同一个受审查变更中修复代码、测试和文档，不能用文档掩盖实现缺口。

## 2. 真实实现入口

| 文件 | 当前职责 |
| --- | --- |
| `.github/workflows/sync-wdc-release.yml` | workflow 名 `Sync complete immutable release to WDC`；latest-main/active-writer 门禁、Ubuntu gate、Ubuntu 轻控制器、always cleanup |
| `.github/workflows/update-core.yml` | workflow 名 `Update core song-list data`；WDC 活跃窗口互斥，路径为 `update-core.yml` |
| `.github/workflows/deploy-pg-accepted-increment.yml` | workflow 名 `Prepare PostgreSQL accepted increment handoff` |
| `.github/workflows/deploy-pg-incremental.yml` | workflow 名 `Deploy PostgreSQL accepted increment`；accepted candidate/activation |
| `.github/workflows/update-backfill.yml` | workflow 名 `Prepare backfill inbox bundle` |
| `deploy/orchestrate-wdc-bounded-release.sh` | 单 run/attempt 控制器；建立 relay、隧道、WDC owner roots、启动 build、核对身份、激活、观察、收尾 |
| `deploy/run-wdc-bounded-build.sh` | WDC 固定 ext4 loop volume、cgroup 校验、本机物化、单次 release copy |
| `deploy/check-wdc-build-storage.py` | preflight/runtime/pre-copy/post-copy 存储核算与 30 秒 guard |
| `deploy/cleanup-wdc-bounded-build.sh` | 只清理一个精确 run/attempt；保护 active/rollback release |
| `deploy/install-wdc-release.sh` | 备份六个控制目标、原子替换 `releases/current`、失败回滚、finalize |
| `deploy/finalize-wdc-bounded-release.sh` | 健康、双 release 保留、空间复核、删除 rollback state |
| `deploy/verify-wdc-release-data.py` | 激活前的 serving SQLite 数据合同与跨页正样本 |
| `deploy/verify-wdc-public-release.py` | 公网 identity、四类排名、搜索、筛选、来源、静态资源和同协议延迟验收 |
| `scripts/migration/materialize-pg-release-snapshot.py` | `REPEATABLE READ READ ONLY` 快照、durable source checkpoint、精确 transport reconnect |
| `scripts/migration/pg-peer-relay.py` | loopback Unix-socket relay；累计字节与连接数硬上限 |
| `tests/test_next_serving_v3.py` | release、存储、retry、README scope 和公网合同回归 |
| `tests/test_pg_peer_relay.py` | relay 字节/连接/身份门禁回归 |

`scripts/migration/requirements-wdc-linux.txt` 是 WDC run-local Python wheel 的唯一 hash-locked 依赖清单。`scripts/migration/requirements-wdc-mac.txt` 仍存在于仓库，但当前 WDC 服务器侧发布不得使用 Mac 物化或承载数据库。

当前 workflow 参数也是审计合同：schedule 为每日 `17 5 * * *`；manual input `force` 默认 `false`；concurrency group 为 `daily-song-list-wdc-release-server-v4` 且 `cancel-in-progress: false`；queued lease 的有效年龄上限为 3,600 秒；Ubuntu gate timeout 35 分钟，controller job timeout 600 分钟。release window 把以下四个 workflow 视为写者：`Update core song-list data`、`Prepare backfill inbox bundle`、`Prepare PostgreSQL accepted increment handoff`、`Deploy PostgreSQL accepted increment`。

## 3. 数据与文件拓扑

```text
GitHub-hosted Ubuntu
  ├─ latest-main / active-writer / CI gate
  └─ <100 MB hash-manifested sparse controller source
                         │
VPS2 (vps-racknerd)      │                     WDC (vps-wdc)
authoritative PostgreSQL │                     /var/tmp/dsl-wdc-volume-R-A
READ ONLY snapshot ── bounded loopback relay ── SSH tunnel ── fixed ext4 volume
                                                             │
                                                             ├─ materialize pages + SQLite
                                                             ├─ remove intermediates
                                                             └─ one copy to releases/.incoming-...
                                                                   │ same-filesystem rename
                                                                   ▼
                                                              releases/<64hex>
                                                                   │ atomic current symlink swap
                                                                   ▼
                                                           current + retained previous directory
```

关键边界：

- VPS2 是权威 PostgreSQL 节点。relay 只监听 loopback，并连接本机 PostgreSQL Unix socket；它不是数据库副本，也不公开数据库端口。
- Ubuntu 只传输 `SOURCE_FILES` 明确列出的、带 `source-manifest.sha256` 的稀疏控制源；WDC 端强制无 `.git` 且总量小于 100 MB。禁止完整 clone、Git object pack、工作树历史或生产数据集复制。
- WDC 在 `/var/tmp/dsl-wdc-volume-<run>-<attempt>` 的固定 ext4 loop 文件系统内完成所有重型物化。Windows 和 Mac 不承担 PG payload、materialized SQLite、bundle 上传或大型临时数据。
- 不生成 release tar/archive。构建后先删除 pages、frontend、依赖和原始 serving-store 路径，只保留 hard-linked immutable release，再跨文件系统复制一次到 `.incoming`，最后在 `releases` 内原子 rename。
- `install-wdc-release.sh` 用临时 symlink 加 `mv -Tf` 原子替换 `releases/current`。先前的 current target 与六个控制文件备份记录在 `.rollback-<sha>`；finalize 后保留当前与上一版两个 64-hex release 目录。当前实现没有单独的 `previous` symlink，审计时应记录“current symlink + retained previous directory”的真实形态。

## 4. 数据规模语义

以下对象不是同一数量，任何报告必须分别命名：

- canonical song entity：清洗、alias、归一化后的歌曲实体或排名实体；
- occurrence：一次视频时间点上的歌曲出现记录；
- source occurrence/source detail：来源维度的原始或投影记录；
- video、VTuber、artist、历史 revision：各有独立基数与保留规则。

因此，约三四万或数万级 canonical song entity 只说明聚合实体规模，不能推出 occurrence、来源、视频或历史 revision 只剩同样数量，更不能描述为“旧数据被删了”。若要证明删除或完整保留，必须对 immutable source、revision lineage、PG 表和备份单独审计。

WDC cleanup 的对象只有精确 run control、secret、loop volume、relay、incoming candidate、未激活且无 rollback 保护的 release。任何 cleanup 不得执行 PostgreSQL `DELETE`、`DROP`、`TRUNCATE`、表文件操作，也不得触碰 canonical PG、生产歌曲数据、immutable input 或备份。

## 5. 不可放宽的硬门禁

所有数值均为十进制 bytes；代码中的比较边界按表中符号执行。

| 门禁 | 必须满足 | 实现位置 |
| --- | ---: | --- |
| WDC fixed build volume | 容量 `<= 32,000,000,000`；当前镜像精确为该值，挂载后可用总容量约 31–32GB | workflow、`run-wdc-bounded-build.sh`、storage checker |
| immutable release | `0 < logical bytes < 16,000,000,000` | build script、storage checker |
| WDC host availability | runtime/copy/final `>= 20,000,000,000` | storage checker、finalize、observation |
| WDC preflight availability | `host free - 32,000,000,000 >= 20,000,000,000` | storage checker |
| Daily Song List project | allocated 与 logical 均 `< 40,000,000,000` | storage checker、finalize |
| projected project copy peak | `current logical + release + 134,217,728 < 40,000,000,000` | storage checker |
| build memory | `MemoryMax = 2,684,354,560`（2.5 GiB，不可提高） | orchestrator、build self-check |
| build swap | `MemorySwapMax = 1,073,741,824`（1 GiB，不可提高） | orchestrator、build self-check |
| relay cumulative wire | `bytesForwarded <= 16,000,000,000`，超限 fail closed | relay、orchestrator stats gate |
| relay concurrency | `maxConnections = 2` | relay、ready/stats gate |
| source transfer | hash-manifested tree `< 100,000,000`，无 `.git` | orchestrator |
| source checkout Git data | 不进行完整 checkout/clone；controller sparse checkout `fetch-depth: 1` | workflow |
| build runtime | `RuntimeMaxSec = 32,400`；单一 build unit | orchestrator |

到达 `40,000,000,000` 或 `16,000,000,000` 的线即失败，不是告警。preflight 的 host free 实际要求至少 `52,000,000,000`，因为必须同时容纳 32GB 固定 volume 和 20GB host reserve。

任何测量缺失、超时、格式异常、symlink/non-regular entry、realpath 不一致或 owner 不一致都不得用估算放行。

## 6. run/attempt 身份与 marker

每个 WDC workflow attempt 的唯一 owner 是 `<GITHUB_RUN_ID>:<GITHUB_RUN_ATTEMPT>`。以下身份必须一致：

| 节点 | 精确对象 | marker / 身份 |
| --- | --- | --- |
| Ubuntu controller | `$RUNNER_TEMP/dsl-wdc-controller-<run>-<attempt>` | `.codex-owned-run` = `<run>:<attempt>` |
| VPS2 | `/tmp/dsl-pg-relay-<run>-<attempt>` | `.codex-owned-run`；unit `dsl-wdc-pg-relay-<run>-<attempt>` |
| VPS2 PG session | PostgreSQL application name | `dsl-wdc-snapshot-<run>-<attempt>` |
| WDC control | `/opt/culua/ytb-song-rank/.build/dsl-wdc-<run>-<attempt>` | `.codex-owned-run` |
| WDC secret | `/run/dsl-wdc-<run>-<attempt>` | `.codex-owned-run` |
| WDC volume | `/var/tmp/dsl-wdc-volume-<run>-<attempt>` | `.codex-owned-run`；mounted root 内 `.codex-owned-volume` |
| WDC loop | exact volume root | `.loop-device` 与 `build-volume.ext4` |
| WDC units | exact attempt | `dsl-wdc-build-*`、`dsl-wdc-storage-guard-*`、`dsl-wdc-pg-tunnel-*` |
| incoming release | `releases/.incoming-<sha>.<run>-<attempt>` | adjacent `.owner` = `<run>:<attempt>` |
| immutable release | `releases/<64hex>` | `.complete` = release SHA；manifest/meta hash identity |
| rollback | `releases/.rollback-<sha>` | `backups-complete`、`previous-target`、`previous-release-sha` |

marker 存在本身不授权删除。还必须同时证明 GitHub run/attempt 注册、terminal job status、无精确 unit/process/mount/loop/PG session 引用，以及对 Git worktree 适用的 clean status。

## 7. 失败与重试策略

| 失败类别 | 动作 |
| --- | --- |
| active revision/content SHA/source commit 漂移 | 立即失败；不 retry、不激活、不另开第二 run |
| 数据合同、来源数、跨页、排名、搜索、筛选、browser 错误 | 立即失败并保留 rollback；同轮修代码/数据，CI/merge 后只发一个新 latest-head run |
| 容量、cgroup、owner、realpath、marker、symlink、release identity 错误 | 立即失败；不清理归属不明对象，不通过删除其他数据“腾空间” |
| stale workflow head | 在写入前 clean no-op；激活前再次发现 stale 则保留生产不变并退出 |
| GitHub/control-plane 有界网络错误 | 只按脚本已有的 bounded timeout/retry；不得因此创建重复 release run |
| PostgreSQL snapshot transport loss | 仅由精确 driver predicate checkpoint/reconnect/resume；次数有界且每次重验 identity |
| 非 transport exception | 原样抛出；不得 checkpoint/retry 伪装成功 |

`materialize-pg-release-snapshot.py` 的当前 predicate 同时要求：异常模块属于 `psycopg`、类名为 `OperationalError` 或 `InterfaceError`，且异常链消息命中以下明确连接丢失签名之一：

- `server closed the connection unexpectedly`
- `consuming input failed`
- `connection is closed`
- `connection not open`
- `terminating connection due to administrator command`

这是“精确 transport EOF/connection-loss 类”的代码边界，不是任意包含 `EOF`、timeout、SQL 错误或数据错误的字符串匹配。最多 3 次 transport retry；每次 reconnect 最多 12 次、间隔 5 秒。重连后重新开启 `REPEATABLE READ READ ONLY` transaction，并核对 active revision、content SHA-256、source commit；任何 identity 改变立即终止。

durable source checkpoint 写在同一个构建 SQLite 内。只有一整个 source 的 detail/occurrences 与计数/身份检查共同提交后，checkpoint 才成立；部分 source 在 resume 前会被删除后重做。checkpoint 表在最终 serving store 完成前被删除，不进入 production release。

## 8. 发布状态机

不得跳步或并行制造第二个写者。

1. **TAKEOVER**：读取平台 goal、`CODEX_GOAL.md`、handoff、repo root/branch/status、`main` head、workflow state 和所有 active runs。
2. **WAIT_LEGAL_WRITERS**：等待唯一合法 `Update core song-list data` 与其后继 `Prepare/Deploy PostgreSQL accepted increment` 完成；确认 accepted revision 已真实激活且 health/meta identity 一致。失败或 queued lease 异常不是 WDC 放行条件。
3. **FREEZE_FUTURE_CORE_IF_REQUIRED**：只有当前合法 core 已开始、且无限定时排队会饿死 WDC 时，总控才可暂停 `update-core.yml` 的未来触发；不得取消正在运行的合法 core。记录 workflow ID、暂停前后 state 和当前 core run。
4. **UNIQUE_LATEST_HEAD_WDC**：证明无 active writer、无另一个有效 queued/in-progress WDC，`main` head 精确稳定后，只 dispatch 一次 `Sync complete immutable release to WDC`。记录 run ID、attempt、owner、head SHA。
5. **RESOURCE_AND_MARKER_MONITOR**：只监控该 owner 的 VPS2 relay、PG application name、WDC control/secret/volume、cgroup、storage guard、project bytes、host free、relay stats。不得扫描或操作无关对象。
6. **SAME_ROUND_FIX**：任何 identity/data/code/capacity 错误都停止发布。保留可审计日志和 rollback；在同一交付轮修复候选与回归，不直接 rerun 旧失败 attempt。
7. **CI_AND_MERGE**：相关 `Check code`、`Test next serving v3` 和目标测试全绿；diff/secret/范围审查通过；精确 head merge，不 admin bypass。
8. **ONE_RERUN**：合并后重新读取 `main`，等待 writers 清空，只 dispatch 一个新 latest-head WDC run。旧 run 不得同时继续写。
9. **ONLINE_ACCEPTANCE**：验证 `healthz`、`api/meta`、release identity、7d/all × songs/artists/vtubers/videos × occurrences/songs/videos、来源详情与跨页、title/artist search、niche/visible/visibleNiche filters、首页和 immutable assets；再做真实桌面/移动浏览器交互。
10. **TEN_MINUTE_OBSERVATION**：激活后连续样本 0..10，每分钟一次；公网 identity、WDC 本机 health、API/nginx active、project `<40GB`、host free `>=20GB` 必须全程成立。任何一次失败触发 rollback，不 finalize。
11. **EXACT_CLEANUP**：finalize 后只保留 current/previous 两个 release；证明本 attempt 的 control、secret、volume、relay、incoming、rollback、transient units 和 PG session 均消失。归属不明残留不删，报告 gap。
12. **REENABLE_UPDATE_CORE**：若本轮曾暂停 `update-core.yml`，恢复并验证 state=`active`；再确认没有因为恢复而制造重复 active writer。
13. **COMPLETE**：记录时间、run ID/attempt/owner/head/release/revision/source commit、HTTP 状态、关键字段、浏览器证据、10 分钟窗口、storage/cleanup 证据，才可完成生产 goal。

## 9. WSL 只读接手命令

以下均为 **只读**。任何命令超时都记为 verification gap，不能当作空结果或清理授权。

### 9.1 本地 repo 与 goal

```bash
set -euo pipefail
export REPO='Marica7731/daily-song-list'
export CORE_WORKFLOW='Update core song-list data'
export ACCEPTED_PREP_WORKFLOW='Prepare PostgreSQL accepted increment handoff'
export ACCEPTED_DEPLOY_WORKFLOW='Deploy PostgreSQL accepted increment'
export BACKFILL_WORKFLOW='Prepare backfill inbox bundle'
export WDC_WORKFLOW='Sync complete immutable release to WDC'

timeout 10s git rev-parse --show-toplevel
timeout 10s git branch --show-current
timeout 10s git rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 timeout 20s git status --short --branch
timeout 10s sed -n '1,260p' CODEX_GOAL.md
timeout 30s gh auth status
timeout 30s gh api "repos/$REPO/branches/main" --jq '{sha:.commit.sha}'
timeout 30s gh api "repos/$REPO/actions/workflows/update-core.yml" \
  --jq '{id,name,path,state}'
```

不得执行 `gh auth token`、输出 credential store、读取 Git extra header 或用带 credential 的 remote URL 替代 `REPO`。

### 9.2 active run 全景

```bash
timeout 30s gh run list --repo "$REPO" --limit 100 \
  --json databaseId,workflowName,headSha,event,status,conclusion,createdAt,updatedAt,url \
  | jq -c --arg core "$CORE_WORKFLOW" \
          --arg prep "$ACCEPTED_PREP_WORKFLOW" \
          --arg deploy "$ACCEPTED_DEPLOY_WORKFLOW" \
          --arg backfill "$BACKFILL_WORKFLOW" \
          --arg wdc "$WDC_WORKFLOW" '
      [.[] | select(.status == "queued" or .status == "in_progress") |
       select(.workflowName == $core or .workflowName == $prep or
              .workflowName == $deploy or .workflowName == $backfill or
              .workflowName == $wdc)]'

timeout 30s gh run list --repo "$REPO" --workflow "$WDC_WORKFLOW" --limit 20 \
  --json databaseId,headSha,event,status,conclusion,createdAt,updatedAt,url
```

对一个已选 run 读取 attempt 与 workflow path：

```bash
RUN_ID='replace-with-digits'
case "$RUN_ID" in (*[!0-9]*|'') echo 'invalid RUN_ID' >&2; exit 2;; esac
timeout 30s gh api "repos/$REPO/actions/runs/$RUN_ID" \
  --jq '{id,run_attempt,name,path,head_sha,event,status,conclusion,created_at,updated_at,html_url}'
timeout 30s gh run view "$RUN_ID" --repo "$REPO" \
  --json status,conclusion,headSha,jobs,url
```

### 9.3 SSH alias 与只读连通性

```bash
timeout 10s ssh -G vps-wdc >/dev/null
timeout 10s ssh -G vps-racknerd >/dev/null
timeout 30s ssh -o BatchMode=yes vps-wdc true
timeout 30s ssh -o BatchMode=yes vps-racknerd true
```

这两项只允许使用现有 alias。若 alias 不解析或 BatchMode 失败，报告本机配置/认证 gap；不要把实际 HostName、地址或 key 内容复制到文档或命令。

### 9.4 WDC 精确 owner 盘点

```bash
RUN_ID='replace-with-digits'
ATTEMPT='replace-with-digits'
case "$RUN_ID:$ATTEMPT" in (*[!0-9:]*|:*|*:) echo 'invalid owner' >&2; exit 2;; esac
OWNER="$RUN_ID:$ATTEMPT"

timeout 30s ssh -o BatchMode=yes vps-wdc bash -s -- \
  "$RUN_ID" "$ATTEMPT" "$OWNER" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"; owner="$3"
project='/opt/culua/ytb-song-rank'
control="$project/.build/dsl-wdc-$run-$attempt"
secret="/run/dsl-wdc-$run-$attempt"
volume="/var/tmp/dsl-wdc-volume-$run-$attempt"
for root in "$control" "$secret" "$volume"; do
  if [ -e "$root" ]; then
    printf 'ROOT %s owner=' "$root"
    sed -n '1p' "$root/.codex-owned-run"
  else
    printf 'ROOT %s absent\n' "$root"
  fi
done
for unit in dsl-wdc-build dsl-wdc-storage-guard dsl-wdc-pg-tunnel; do
  systemctl show "${unit}-${run}-${attempt}.service" \
    -p Id -p ActiveState -p SubState -p MainPID -p MemoryCurrent \
    -p MemoryMax -p MemorySwapCurrent -p MemorySwapMax -p ControlGroup \
    --no-pager || true
done
findmnt --target "$volume/volume" --output TARGET,SOURCE,FSTYPE,OPTIONS --noheadings || true
losetup -j "$volume/build-volume.ext4" || true
du -sb -- "$project"
df -B1 --output=target,size,used,avail "$project"
readlink "$project/releases/current"
find "$project/releases" -mindepth 1 -maxdepth 1 -printf '%f %y\n' | sort
REMOTE
```

不得把 `absent`、unit 不存在或命令超时解读为“安全删除”；还需要 GitHub terminal status、VPS2、process/handle 和 release protection 证据。

### 9.5 VPS2 relay 与 PG session 盘点

```bash
timeout 30s ssh -o BatchMode=yes vps-racknerd bash -s -- \
  "$RUN_ID" "$ATTEMPT" "$OWNER" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"; owner="$3"
root="/tmp/dsl-pg-relay-$run-$attempt"
unit="dsl-wdc-pg-relay-$run-$attempt.service"
app="dsl-wdc-snapshot-$run-$attempt"
if [ -e "$root" ]; then
  printf 'RELAY owner='; sed -n '1p' "$root/.codex-owned-run"
  test ! -e "$root/ready.json" || sed -n '1p' "$root/ready.json"
  test ! -e "$root/stats.json" || sed -n '1p' "$root/stats.json"
else
  echo 'RELAY absent'
fi
systemctl show "$unit" -p Id -p ActiveState -p SubState -p MainPID \
  -p MemoryCurrent -p MemoryMax --no-pager || true
runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT pid,state,backend_type FROM pg_stat_activity WHERE application_name = '$app' ORDER BY pid"
REMOTE
```

`SELECT pg_stat_activity` 是只读盘点。不要在盘点阶段 terminate backend、restart service 或删除 relay root。

## 10. 有保护的 GitHub 写操作

以下命令均为 **写操作**，只允许总控执行。每个命令前先重复第 9 节只读查询，并把结果保存到交接证据。

### 10.1 暂停未来 core 触发

只在一个精确合法 core 已经开始，且未来的小时级触发会持续阻塞唯一 WDC 窗口时使用。disable 不得被用来取消当前 core。

```bash
CORE_RUN_ID='replace-with-digits'
case "$CORE_RUN_ID" in (*[!0-9]*|'') exit 2;; esac
timeout 30s gh api "repos/$REPO/actions/runs/$CORE_RUN_ID" \
  --jq '{id,run_attempt,name,head_sha,status,conclusion}'
timeout 30s gh api "repos/$REPO/actions/workflows/update-core.yml" \
  --jq '{id,name,path,state}'

# WRITE: only after the evidence above names the intended workflow and legal run.
timeout 30s gh workflow disable update-core.yml --repo "$REPO"
timeout 30s gh api "repos/$REPO/actions/workflows/update-core.yml" \
  --jq '{id,name,path,state}'
```

期望暂停后的 state 是 `disabled_manually`。若不是，停止；不要连续重试 disable。

### 10.2 唯一 latest-head dispatch

dispatch 前，active run 全景必须是空的合法 release window，且 `EXPECTED_HEAD` 必须与刚读取的 `main` 相同。

```bash
EXPECTED_HEAD='replace-with-40-lowercase-hex'
case "$EXPECTED_HEAD" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#EXPECTED_HEAD}" -eq 40
ACTUAL_HEAD="$(timeout 30s gh api "repos/$REPO/branches/main" --jq '.commit.sha')"
test "$ACTUAL_HEAD" = "$EXPECTED_HEAD"

timeout 30s gh run list --repo "$REPO" --limit 100 \
  --json databaseId,workflowName,headSha,status,conclusion,createdAt,url \
  | jq -e --arg core "$CORE_WORKFLOW" \
          --arg prep "$ACCEPTED_PREP_WORKFLOW" \
          --arg deploy "$ACCEPTED_DEPLOY_WORKFLOW" \
          --arg backfill "$BACKFILL_WORKFLOW" \
          --arg wdc "$WDC_WORKFLOW" '
      [.[] | select(.status == "queued" or .status == "in_progress") |
       select(.workflowName == $core or .workflowName == $prep or
              .workflowName == $deploy or .workflowName == $backfill or
              .workflowName == $wdc)] | length == 0'

# WRITE: exactly one controlled catch-up dispatch from current main.
timeout 30s gh workflow run sync-wdc-release.yml --repo "$REPO" \
  --ref main -f force=true

# READ: identify and verify the exact new run before any later action.
timeout 30s gh run list --repo "$REPO" --workflow "$WDC_WORKFLOW" --limit 5 \
  --json databaseId,headSha,event,status,conclusion,createdAt,url
```

不要在上一条 dispatch 的 run ID 尚未唯一确认时再次执行。`force=true` 只表示立即执行当前 latest head，仍不能绕过 identical-identity no-op、latest-head、active-writer、identity 或容量门禁；定时运行和无需立即追赶的普通手动运行保留默认 `force=false`。

### 10.3 精确 cancel

cancel 不是故障重试工具，只能用于总控已经判定必须停止的一个精确 WDC run。先验证 run、attempt、owner、workflow name、head 和非 terminal status。

```bash
RUN_ID='replace-with-digits'
ATTEMPT='replace-with-digits'
EXPECTED_HEAD='replace-with-40-lowercase-hex'
OWNER="$RUN_ID:$ATTEMPT"
case "$RUN_ID:$ATTEMPT" in (*[!0-9:]*|:*|*:) exit 2;; esac
test "${#EXPECTED_HEAD}" -eq 40

RUN_JSON="$(timeout 30s gh api "repos/$REPO/actions/runs/$RUN_ID")"
jq -e --arg owner "$OWNER" --arg head "$EXPECTED_HEAD" --arg workflow "$WDC_WORKFLOW" '
  (.id|tostring) + ":" + (.run_attempt|tostring) == $owner and
  .head_sha == $head and .name == $workflow and
  (.status == "queued" or .status == "in_progress")' <<<"$RUN_JSON"

# WRITE: cancel only this proven run.
timeout 30s gh run cancel "$RUN_ID" --repo "$REPO"

# READ: bounded status snapshot; repeat manually, never use an unbounded watch.
timeout 30s gh api "repos/$REPO/actions/runs/$RUN_ID" \
  --jq '{id,run_attempt,status,conclusion,updated_at}'
```

cancel 后等待 workflow `always()` cleanup。若 cleanup 不完整，先保留证据，再按第 13 节处理；不得立即开第二 run。

### 10.4 CI 后精确 merge

```bash
PR_NUMBER='replace-with-digits'
PR_HEAD='replace-with-40-lowercase-hex'
case "$PR_NUMBER" in (*[!0-9]*|'') exit 2;; esac
case "$PR_HEAD" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#PR_HEAD}" -eq 40

# READ
timeout 30s gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json number,state,isDraft,headRefOid,mergeStateStatus,statusCheckRollup,url
timeout 60s gh pr checks "$PR_NUMBER" --repo "$REPO"

# WRITE: no admin bypass; exact reviewed head only.
timeout 60s gh pr merge "$PR_NUMBER" --repo "$REPO" --squash \
  --match-head-commit "$PR_HEAD" --delete-branch

# READ
timeout 30s gh pr view "$PR_NUMBER" --repo "$REPO" \
  --json state,headRefOid,mergeCommit,url
timeout 30s gh api "repos/$REPO/branches/main" --jq '{sha:.commit.sha}'
```

若仓库保护策略要求 merge queue 或其他入口，命令失败即停止并报告；不得加 `--admin`。

### 10.5 恢复 update-core

只能在在线验收、10 分钟观察和精确 residue gate 全部通过后执行。

```bash
# READ
timeout 30s gh api "repos/$REPO/actions/workflows/update-core.yml" \
  --jq '{id,name,path,state}'

# WRITE
timeout 30s gh workflow enable update-core.yml --repo "$REPO"

# READ: must be active.
timeout 30s gh api "repos/$REPO/actions/workflows/update-core.yml" \
  --jq '{id,name,path,state}'
timeout 30s gh run list --repo "$REPO" --limit 30 \
  --json databaseId,workflowName,headSha,status,conclusion,createdAt,url \
  | jq -c '[.[] | select(.status == "queued" or .status == "in_progress")]'
```

## 11. 构建与 marker 监控判定

一个健康 run 应依次出现以下代码 marker；缺失 marker 不等于失败原因已知，但一定不能放行：

1. `WDC_RELEASE_WINDOW_READY`
2. `WDC_UBUNTU_SERVER_GATE_OK`
3. `WDC_LATEST_HEAD_CONFIRMED`
4. `PG_SOURCE_IDENTITY`
5. `VPS2_RELAY_READY ... maxBytes=16000000000 maxConnections=2`
6. `WDC_HASHED_SPARSE_SOURCE_OK`
7. `WDC_CGROUP_LIMITS_OK`
8. `WDC_STORAGE_PREFLIGHT_OK` 与周期性 `WDC_STORAGE_RUNTIME_OK`
9. `WDC_PG_CANONICAL_SNAPSHOT_OK`
10. `WDC_SERVER_RELEASE_READY` / `WDC_BOUNDED_BUILD_OK`
11. `VPS2_RELAY_BUDGET_OK`
12. `SOURCE_TRIPLET_STABLE_BEFORE_ACTIVATE`
13. `WDC_LATEST_HEAD_STABLE_BEFORE_ACTIVATE`
14. `DEPLOY_ACTIVATED_PENDING_PUBLIC`
15. `WDC_PUBLIC_RELEASE_VERIFIED`
16. 11 个 `WDC_PUBLIC_OBSERVATION_OK` 与对应 `WDC_LOCAL_OBSERVATION_OK`
17. `DEPLOY_FINALIZED`
18. `WDC_BOUNDED_CLEANUP_OK`、`VPS2_BOUNDED_RELAY_CLEAN`
19. `WDC_FINAL_RESIDUE_OK`
20. `WDC_BOUNDED_RELEASE_COMPLETE`

`WDC_NO_CHANGE` 是合法 no-op：active revision、source commit 与 build logic 都已部署时，不复制也不激活。`WDC_STALE_HEAD_NO_WRITE` 与 `WDC_STALE_HEAD_BEFORE_ACTIVATE` 也是安全退出，不能把它们写成“新 release 已上线”。

## 12. 公网、数据与浏览器验收

当前代码的目标站点是 `https://next.ytb-song-rank.culua.com`。以下为只读补充验收；workflow 内的 `deploy/verify-wdc-public-release.py` 仍是权威自动合同。

### 12.1 identity 与四类排名

```bash
BASE='https://next.ytb-song-rank.culua.com'
RELEASE_SHA='replace-with-64-lowercase-hex'
case "$RELEASE_SHA" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#RELEASE_SHA}" -eq 64

timeout 30s curl --silent --show-error --fail --location \
  --connect-timeout 8 --max-time 20 "$BASE/healthz" | jq -c .
timeout 30s curl --silent --show-error --fail --location \
  --connect-timeout 8 --max-time 20 "$BASE/api/meta" \
  | jq -c '{meta,capabilities}'

for range_id in 7d all; do
  for view in songs artists vtubers videos; do
    for metric in occurrences songs videos; do
      timeout 30s curl --silent --show-error --fail --location \
        --connect-timeout 8 --max-time 20 --get "$BASE/api/rankings" \
        --data-urlencode "v=$RELEASE_SHA" \
        --data-urlencode "range=$range_id" \
        --data-urlencode "view=$view" \
        --data-urlencode "metric=$metric" \
        --data-urlencode 'page=1' --data-urlencode 'pageSize=30' \
        | jq -e --arg range "$range_id" --arg view "$view" --arg metric "$metric" \
            '.records | type == "array" and length > 0'
    done
  done
done
```

必须同时核对响应 HTTP 200、`X-Release-Sha`、`X-Server-Commit`、`X-Data-Source`、release/revision/source identity 和非空且 key 唯一的 records。仅 `jq` 成功不能替代 header 证据；权威脚本会验证这些 header。

### 12.2 搜索、筛选与来源

```bash
SEARCH_TITLE='replace-with-a-title-observed-in-the-current-release'
SEARCH_ARTIST='replace-with-an-artist-observed-in-the-current-release'
PROBE_SOURCE_KEY='replace-with-16-to-64-lowercase-hex'

timeout 30s curl --silent --show-error --fail --location --get "$BASE/api/rankings" \
  --data-urlencode "v=$RELEASE_SHA" --data-urlencode 'range=all' \
  --data-urlencode 'view=songs' --data-urlencode 'metric=occurrences' \
  --data-urlencode "q=$SEARCH_TITLE" --data-urlencode 'searchFields=title' \
  --data-urlencode 'page=1' --data-urlencode 'pageSize=12' | jq -e '.records|length>0'

timeout 30s curl --silent --show-error --fail --location --get "$BASE/api/rankings" \
  --data-urlencode "v=$RELEASE_SHA" --data-urlencode 'range=all' \
  --data-urlencode 'view=songs' --data-urlencode 'metric=occurrences' \
  --data-urlencode "q=$SEARCH_ARTIST" --data-urlencode 'searchFields=artist' \
  --data-urlencode 'page=1' --data-urlencode 'pageSize=12' | jq -e '.records|length>0'

for flags in 'nicheOnly=1' 'hideUnknownArtist=1' \
             'nicheOnly=1&hideUnknownArtist=1'; do
  timeout 30s curl --silent --show-error --fail --location \
    --connect-timeout 8 --max-time 20 \
    "$BASE/api/rankings?v=$RELEASE_SHA&range=all&view=songs&metric=occurrences&page=1&pageSize=30&$flags" \
    | jq -e '.records|type=="array"'
done

timeout 30s curl --silent --show-error --fail --location \
  --connect-timeout 8 --max-time 20 \
  "$BASE/api/sources/$PROBE_SOURCE_KEY?v=$RELEASE_SHA&range=all&page=1&pageSize=17" \
  | jq -e '.found == true and .totalVideoCount > 0 and .totalOccurrenceCount > 0'
```

`PROBE_SOURCE_KEY` 必须来自本 run 的 `build-result.json` / `WDC_SERVER_BUILD_RESULT_OK`，不能复用历史 run 的正样本。自动 verifier 还要求跨两页合计 31 个 video 的当前正样本、精确来源合同和 invalid pagination 400。

### 12.3 真实浏览器

自动 API 脚本不替代真实浏览器。用受控桌面浏览器打开 `https://next.ytb-song-rank.culua.com/`，至少完成：

- 7d/all 切换；songs、artists、vtubers、videos 四个视图均能进入；
- occurrences、songs、videos 指标切换后列表与说明同步变化；
- title 与 artist 搜索各一次，清空搜索可恢复；
- niche、hide unknown artist、二者组合筛选各一次；
- 展开一个来源，跨页浏览并打开一个 YouTube timestamp jump link；
- 分页首/中/末页，刷新后 release identity 不回退；
- 桌面宽度与约 320px 移动宽度均无阻断交互或错误卡；
- Network/response 证据指向当前 `RELEASE_SHA`，不依赖旧 origin 或 fallback。

记录浏览器时间、URL、release SHA、操作结果和截图/录屏位置。不要只记录“页面能打开”。

### 12.4 10 分钟观察

workflow 已在 `orchestrate-wdc-bounded-release.sh` 内执行样本 0..10、间隔 60 秒。人工补充观察可运行：

```bash
for sample in $(seq 0 10); do
  date -u +'%Y-%m-%dT%H:%M:%SZ'
  timeout 30s curl --silent --show-error --fail --location \
    --connect-timeout 8 --max-time 20 "$BASE/healthz" \
    | jq -e --arg release "$RELEASE_SHA" \
        '.status == "ok" and .releaseContentSha == $release'
  if [ "$sample" -lt 10 ]; then sleep 60; fi
done
```

任何一个样本失败都不能 finalize。检查公网的同时还要保留 workflow 的 WDC 本机 service、nginx、project bytes 和 host free 样本。

## 13. 精确 cleanup

### 13.1 删除授权前四证据

对任何 Git worktree，必须同时有：

1. **owner marker**：marker 内容精确匹配预期 owner；
2. **registration**：`git worktree list --porcelain` 精确注册该路径和 HEAD/branch，或 GitHub API 精确注册 run/attempt；
3. **no process reference**：无 process cwd/open handle、systemd unit、mount、loop device、SSH tunnel、PG application session；
4. **clean status**：目标 worktree `git status --porcelain=v1` 为空，且没有未跟踪用户文件。

WDC run roots 不是 Git worktree，还必须用 GitHub terminal status 代替“运行已结束”的证明；稀疏 source 明确无 `.git`。若任一证据缺失，停止删除并交接。共享 `.git`、index、用户改动、归属不明目录、current、previous、active process 或 rollback-protected release 均不得删除。

### 13.2 WDC 精确 cleanup（破坏性）

优先让 workflow 的 `always()` step 调用仓库内审核过的脚本。仅在 run 已 terminal、owner 四证据齐全且自动 cleanup 明确失败时，总控才可手工调用同一脚本：

```bash
RUN_ID='replace-with-digits'
ATTEMPT='replace-with-digits'
JOB_STATUS='cancelled' # success|failure|cancelled|skipped，必须与 GitHub 证据一致
RELEASE_SHA='replace-with-64-lowercase-hex'
OWNER="$RUN_ID:$ATTEMPT"
case "$RUN_ID:$ATTEMPT" in (*[!0-9:]*|:*|*:) exit 2;; esac
test "${#RELEASE_SHA}" -eq 64

# READ: repeat GitHub, WDC marker/unit/mount/loop probes from section 9.

# DESTRUCTIVE: exact repository cleanup implementation, no substitute path.
timeout 90s ssh -o BatchMode=yes vps-wdc bash -s -- \
  "$RUN_ID" "$ATTEMPT" "$JOB_STATUS" "$RELEASE_SHA" "$OWNER" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"; status="$3"; sha="$4"; owner="$5"
script="/opt/culua/ytb-song-rank/.build/dsl-wdc-$run-$attempt/source/deploy/cleanup-wdc-bounded-build.sh"
test -x "$script" && test ! -L "$script"
test "$(cat "/opt/culua/ytb-song-rank/.build/dsl-wdc-$run-$attempt/.codex-owned-run")" = "$owner"
exec "$script" "$run" "$attempt" "$status" "$sha"
REMOTE
```

若 script、marker 或精确 path 不存在，不得自己拼一个 broad delete。报告残留并通过受审查代码/恢复入口处理。

### 13.3 VPS2 relay 精确 cleanup（破坏性）

以下等价于 orchestrator 的 exact relay cleanup，包含终止本 run 的只读 snapshot session；它不修改歌曲数据。只允许在 WDC build/tunnel 已停、GitHub run terminal、marker 匹配时执行：

```bash
# DESTRUCTIVE TO SESSION/FILES: exact owner only.
timeout 90s ssh -o BatchMode=yes vps-racknerd bash -s -- \
  "$RUN_ID" "$ATTEMPT" "$OWNER" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"; owner="$3"
root="/tmp/dsl-pg-relay-$run-$attempt"
unit="dsl-wdc-pg-relay-$run-$attempt.service"
app="dsl-wdc-snapshot-$run-$attempt"
test -d "$root" && test ! -L "$root"
test "$(readlink -f "$root")" = "$root"
test "$(cat "$root/.codex-owned-run")" = "$owner"
systemctl stop "$unit"
! systemctl is-active --quiet "$unit"
runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$app' AND pid <> pg_backend_pid()" >/dev/null
test "$(runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$app'")" = 0
rm -rf -- "$root"
systemctl reset-failed "$unit" >/dev/null 2>&1 || true
REMOTE
```

这里的 `rm -rf` 只接受已由正则 owner、realpath、marker、unit 和 PG session 共同锁定的单一 literal root。不得换成 `/tmp/dsl-pg-relay-*` 或任何 glob。

### 13.4 cleanup 后只读 residue gate

```bash
timeout 30s ssh -o BatchMode=yes vps-wdc bash -s -- \
  "$RUN_ID" "$ATTEMPT" "$RELEASE_SHA" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"; sha="$3"
project='/opt/culua/ytb-song-rank'
test ! -e "$project/.build/dsl-wdc-$run-$attempt"
test ! -e "/run/dsl-wdc-$run-$attempt"
test ! -e "/var/tmp/dsl-wdc-volume-$run-$attempt"
for unit in dsl-wdc-build dsl-wdc-storage-guard dsl-wdc-pg-tunnel; do
  ! systemctl is-active --quiet "${unit}-${run}-${attempt}.service"
done
test -L "$project/releases/current"
test "$(basename "$(readlink "$project/releases/current")")" = "$sha"
test "$(find "$project/releases" -mindepth 1 -maxdepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9a-f]{64}' | wc -l)" = 2
du -sb -- "$project"
df -B1 --output=avail "$project"
REMOTE

timeout 30s ssh -o BatchMode=yes vps-racknerd bash -s -- \
  "$RUN_ID" "$ATTEMPT" <<'REMOTE'
set -euo pipefail
run="$1"; attempt="$2"
test ! -e "/tmp/dsl-pg-relay-$run-$attempt"
! systemctl is-active --quiet "dsl-wdc-pg-relay-$run-$attempt.service"
runuser -u www-data -- psql -d song_rank -v ON_ERROR_STOP=1 -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'dsl-wdc-snapshot-$run-$attempt'"
REMOTE
```

最后一条 PG count 必须为 `0`。residue gate 不删除任何对象。

## 14. Mac、Linux、Windows 磁盘与 worktree 治理

### 14.1 Linux/WSL 只读盘点

```bash
REPO_ROOT='/mnt/g/codex-work/daily-song-list'
WORKTREE='/mnt/g/codex-work/replace-with-exact-worktree'
test -d "$REPO_ROOT" && test -d "$WORKTREE"
timeout 20s git -C "$REPO_ROOT" worktree list --porcelain
GIT_OPTIONAL_LOCKS=0 timeout 20s git -C "$WORKTREE" status --porcelain=v1 --branch
timeout 20s du -sb -- "$WORKTREE"
timeout 20s df -B1 --output=target,size,used,avail "$WORKTREE"
timeout 20s lsof +D "$WORKTREE" 2>/dev/null || {
  status=$?
  test "$status" -eq 1 || { echo 'process-reference proof incomplete' >&2; exit 75; }
}
```

`lsof` 超时或报错是 proof gap。精确 cleanup 只能使用 `git -C "$REPO_ROOT" worktree remove -- "$WORKTREE"`，不得加 `--force`，不得 `git clean`，不得 broad `git worktree prune`。

### 14.2 macOS 只读盘点

```bash
REPO_ROOT='/Users/be/replace-with-exact-repo'
WORKTREE='/Users/be/codex-temp/replace-with-exact-worktree'
test -d "$REPO_ROOT" && test -d "$WORKTREE"
git -C "$REPO_ROOT" worktree list --porcelain
GIT_OPTIONAL_LOCKS=0 git -C "$WORKTREE" status --porcelain=v1 --branch
du -sk -- "$WORKTREE"
df -Pk -- "$WORKTREE"
command -v gtimeout >/dev/null || { echo 'bounded lsof unavailable' >&2; exit 75; }
gtimeout 20s lsof +D "$WORKTREE" 2>/dev/null || {
  status=$?
  test "$status" -eq 1 || { echo 'process-reference proof incomplete' >&2; exit 75; }
}
```

Mac runner 上任何数据库构建/checkpoint 正在使用目标路径时不得 cleanup。即使目录名带 Codex/run ID，也必须有 owner marker、worktree registration、clean status 和 no-handle 四证据。删除只通过精确 `git worktree remove -- "$WORKTREE"`；不删除 runner cache、Keychain、共享 `.git` 或用户目录。

### 14.3 Windows worktree 的 WSL bash 只读盘点

```bash
REPO_WIN='G:\codex-work\daily-song-list'
WORKTREE_WIN='C:\Users\replace-with-user\.codex\worktrees\replace-with-id\daily-song-list'
timeout 20s git.exe -C "$REPO_WIN" worktree list --porcelain
GIT_OPTIONAL_LOCKS=0 timeout 20s git.exe -C "$WORKTREE_WIN" status --porcelain=v1 --branch
timeout 20s cmd.exe /d /c "where handle64.exe" >/dev/null || {
  echo 'native Windows handle proof unavailable' >&2; exit 75;
}
set +e
timeout 20s handle64.exe -nobanner "$WORKTREE_WIN"
HANDLE_STATUS=$?
set -e
test "$HANDLE_STATUS" -eq 0 || test "$HANDLE_STATUS" -eq 1 || {
  echo 'native Windows handle proof incomplete' >&2; exit 75;
}
```

WSL `/proc` 只能证明 WSL process，不能证明 native Windows handle；`handle64.exe` 不可用时不得清理。精确删除只可由总控在取回 diff 后执行：

```bash
# DESTRUCTIVE: only after all four proofs and an exact literal path.
timeout 60s git.exe -C "$REPO_WIN" worktree remove -- "$WORKTREE_WIN"
```

不得跨 shell 枚举后拼接删除命令；不得用 PowerShell/cmd glob、`rmdir /s`、`Remove-Item -Recurse`、`git clean` 或 broad prune。共享 `.git/index`、归属不明目录、用户改动、正在运行的 Codex/build/test 都是硬阻塞。

## 15. 文档与候选验证

文档分控只运行不会构建、下载或生成 cache 的静态检查：

```bash
git diff --check -- AGENTS.md README.md docs/WDC_RELEASE_RUNBOOK.md
git diff --stat -- AGENTS.md README.md docs/WDC_RELEASE_RUNBOOK.md
wc -c AGENTS.md README.md docs/WDC_RELEASE_RUNBOOK.md
test "$(wc -c < AGENTS.md)" -lt 10000000
test "$(wc -c < README.md)" -lt 10000000
test "$(wc -c < docs/WDC_RELEASE_RUNBOOK.md)" -lt 10000000
```

总控把文档应用到包含当前 WDC 代码的正式候选后，再运行这些代码级验证；文档分控不得为了验证而下载 wheels、构建数据库或触发 workflow：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s tests -p 'test_pg_peer_relay.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s tests -p 'test_next_serving_v3.py' -v
for script in \
  deploy/cleanup-wdc-bounded-build.sh \
  deploy/finalize-wdc-bounded-release.sh \
  deploy/install-wdc-release.sh \
  deploy/orchestrate-wdc-bounded-release.sh \
  deploy/run-wdc-bounded-build.sh \
  deploy/start-wdc-pg-tunnel.sh \
  deploy/wdc-vps2-askpass.sh; do
  bash -n "$script"
done
```

若 README 只改 WDC bounded section，可在集成分支用当前 base SHA 执行：

```bash
BASE_SHA='replace-with-40-lowercase-hex'
PYTHONDONTWRITEBYTECODE=1 python3 -B \
  scripts/migration/check-wdc-readme-scope.py --base "$BASE_SHA"
```

期望输出 `CODEX_README_WDC_SCOPE_OK`。AGENTS/runbook 仍需独立 diff 审查，不在该 README-only exemption 内。

## 16. 总控交接清单

文档或修复分控必须停在未 commit 状态并交付：

- 精确 worktree 路径、repo root、branch/detached HEAD、base SHA、开始和结束 `git status`；
- 修改文件列表及每个文件用途；
- path-scoped diff/stat 和 `git diff --check` 结果；
- 实际读取过的 workflow/script/marker/参数，以及基于代码发现的差异；
- 已运行的静态验证、未运行的构建/测试/线上验证及原因；
- 未核实项、当前 production/run/workflow state 不作推断的明确声明；
- `commit: none`、`push: none`、`dispatch/cancel/deploy/restart/cleanup: none`。

总控接手后先重新读取正式 worktree 状态和线上权威状态，再选择性应用 diff。不得直接把分控记录中的旧 run ID、revision、release SHA 或状态当作当前证据。
