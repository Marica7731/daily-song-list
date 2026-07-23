# daily-song-list 仓库操作手册

这份文档用于多会话、多机器接手 `Marica7731/daily-song-list` 时快速确认工作边界。线上事实必须以 GitHub Actions、VPS/API、目标页面返回为准，本地 JSON、SQLite、截图和旧会话总结只能作为线索。

## 仓库与机器分工

主仓库：

```text
https://github.com/Marica7731/daily-song-list.git
```

Windows 侧用于轻量编辑、Git 收口和线上探针。优先使用 G 盘干净 worktree，例如：

```powershell
G:\codex-work\daily-song-list-runtime-fix-20260723
```

不要把新 worktree 放到 C 盘。C 盘空间会影响系统稳定。D 盘可能已有历史脏数据或大批量生成文件，除非明确确认目标分支和状态，否则不要从 D 盘 worktree commit、push 或发布。

Mac 侧用于大内存/大磁盘任务、SQLite 构建、来源补跑、Actions self-hosted runner 和真实 13GB runtime DB 验证：

```sh
ssh be@192.168.1.13
source ~/.daily-song-list-build-env
cd /Users/be/daily-song-list-hotfix-20260723
```

Mac 常用路径：

```text
/Users/be/daily-song-list-hotfix-20260723
/Users/be/actions-runner-daily-song-list
/Users/be/actions-runner-work
/Users/be/actions-runner-cache/daily-song-list-runtime-db
```

Mac toolchain 环境文件：

```sh
source ~/.daily-song-list-build-env
```

## 权限状态

GitHub 写权限走用户账号级 SSH key。Mac 和 Windows 都应能 push 到主仓库。验证：

```sh
ssh -T git@github.com
git ls-remote git@github.com:Marica7731/daily-song-list.git refs/heads/main
```

VPS2 root 直连默认不依赖本机本地密码文件，生产发布走 GitHub Actions 中的 `VPS2_PASSWORD` secret。没有明确授权时，不要在本地手工操作 VPS2 生产服务。

## 标准工作流

1. 先确认当前目录是目标 repo root：

```powershell
git status --short --branch
git remote -v
git rev-parse --show-toplevel
```

2. 本地编辑优先在 G 盘干净 worktree。不要从历史 dirty worktree 直接提交。

3. 大构建、大导入、大 SQLite 检查优先丢给 Mac：

```sh
ssh be@192.168.1.13
source ~/.daily-song-list-build-env
cd /Users/be/daily-song-list-hotfix-20260723
git fetch --depth=1 --filter=blob:none origin main
git checkout -B main FETCH_HEAD
PYTHON=python3 npm run test:db
```

4. 代码改动完成后先跑最小相关测试，再跑发布前检查。常用入口：

```powershell
node --test test/runtime-api.test.js
node --test test/runtime-db.test.js
node --test test/frontend-utils.test.js
node --test test/app-static-performance.test.js
git diff --check
```

5. commit 前只 stage 本次相关文件：

```powershell
git status --short
git diff -- <file>
git add <file>
git commit -m "fix: ..."
git push origin main
```

## GitHub Actions 发布入口

核心数据更新：

```text
.github/workflows/update-core.yml
```

来源补跑：

```text
.github/workflows/update-backfill.yml
```

来源补跑可能因网络、YouTube 超时、临时磁盘不足、VPS/runner 空间不足或会话中断而停止。续接时不要凭印象从头跑，先确认当前事实：

```powershell
gh run list --repo Marica7731/daily-song-list --workflow update-backfill.yml --limit 10
gh run view --repo Marica7731/daily-song-list <run-id> --log
```

如果是在 Mac 或本地批次目录里继续，先看 batch manifest、accepted/imported 文件和 pending 列表；已 imported 的频道不要重复抓。需要人工分批时，按“未导入 pending 队列”切新 batch 目录，不复用失败批次的临时输出目录。来源产物应最终落在仓库维护的 `data/external/youtube-channel-discovery/accepted/` 或相应 inbox/backfill 目录，临时抓取目录和大 SQLite 不进 commit。

来源持久化目录：

```text
data/external/youtube-channel-discovery/accepted/*.json
data/external/youtube-channel-discovery/channel-metadata.json
```

accepted JSON 里通常会带 `sources`、`videos`、`inputDir` 等字段；`inputDir` 可反查当时的批次来源目录，例如 `artifacts/channel-discovery/<batch-name>/...`。如果某个补跑会话断了，先统计 accepted 里已经出现的 channel handle / channel id，再和 pending 队列做差集。只有差集频道进入下一批。

续接优先顺序：

1. 优先让 GitHub Actions 的 Mac runner 继续跑来源补回，避免占用 Windows 内存。
2. 如果 Actions 队列卡住，再 SSH 到 Mac，用 `source ~/.daily-song-list-build-env` 后在 Mac 仓库或专门 batch 目录继续。
3. 不要在 C 盘放来源临时目录。D 盘空间不足或已有脏工作树时，改用 G 盘或 Mac。
4. 继续前查询已导入频道数、pending 频道数、失败频道和超时频道；交接时写清楚下一批从哪个 manifest/pending 文件开始。
5. 导入完成后先本地/Actions 构建 SQLite，再用线上 `/api/meta` 与关键 `/api/rankings` 验证，不只看文件生成。

代码检查：

```text
.github/workflows/check-code.yml
```

SQLite runtime DB/API 发布：

```text
.github/workflows/deploy-runtime-db.yml
```

静态 VPS 发布：

```text
.github/workflows/deploy-vps-static.yml
```

以上大任务应运行在 self-hosted Mac runner：

```yaml
runs-on: [self-hosted, macOS, ARM64, daily-song-list-mac]
```

## 动态 API 验收

线上动态 API 必须用真实 URL 验证，不用本地 DB 数字代替：

```powershell
curl.exe -sS https://ytb-song-rank.culua.com/healthz
curl.exe -sS "https://ytb-song-rank.culua.com/api/meta"
curl.exe -sS "https://ytb-song-rank.culua.com/api/rankings?range=all&view=songs&metric=occurrences&page=1&pageSize=20&q=noa"
curl.exe -sS "https://ytb-song-rank.culua.com/api/rankings?range=all&view=songs&metric=occurrences&page=1&pageSize=20&q=noa&searchFields=channel"
curl.exe -sS "https://ytb-song-rank.culua.com/api/rankings?range=all&view=vtubers&metric=occurrences&page=1&pageSize=20&q=noa&searchFields=channel"
```

发布完成的最低证据：

- `/healthz` 返回 HTTP 200 且 `status=ok`
- `/api/meta` 计数合理，`source_occurrences`、`ranking_rows` 为正数
- 关键 `/api/rankings` 查询不返回 500/504
- 带 `q` 的列表请求最多返回 50 条；仅由单字符字母、数字或文字组成的短查询返回 400，避免触发无界大 LIKE。两字符及以上查询（例如 `晴る`）以及包含有效长词的组合查询仍可用，完整来源通过 `/api/sources/{sourceDetailKey}?page=...` 分页读取。
- GitHub Actions 对应 run 是 `completed/success`
- 用户可见页面不再依赖静态兜底错误状态

## VPS2 注意事项

VPS2 是低内存/低磁盘生产机，只做代码同步、DB 激活、健康检查和小查询。不要在 VPS2 上跑全量 DB build、全量 source backfill 或大 JSON 生成。

生产目录：

```text
/opt/culua/ytb-song-rank
/var/lib/culua/ytb-song-rank/song-rank.sqlite
```

服务：

```sh
systemctl status song-rank-api --no-pager -l
journalctl -u song-rank-api -n 100 --no-pager
curl -fsS http://127.0.0.1:8765/healthz
```

VPS2 空间不足时，不要直接手工覆盖 DB。优先修 GitHub Actions 的候选上传/压缩上传/短停机激活流程。

## 清理与交接

每批任务结束后清理临时文件、失败 worktree 和无用构建产物。尤其避免：

- C 盘临时大文件
- D 盘历史 dirty worktree 被误提交
- `__pycache__`
- 临时脚本
- 大型 SQLite、JSON shard、日志进入 commit

交接给新会话时至少说明：

- 目标 repo root
- 当前分支和 HEAD
- 哪些文件是本批改动
- 哪些 GitHub Actions run 正在跑
- Mac 是否在跑构建或来源补跑
- 线上 API 关键探针结果
- 哪些需求已上线，哪些只是本地完成

## 来源 checkpoint 续跑补充

来源发现只生成候选 artifact，不直接修改 runtime DB。当前来源工作树和 Mac 临时目录可以使用：

```text
D:\\Projects\\daily_song_list_worker_source_backfill_20260720
/tmp/ytb-song-rank-source-backfill-20260720
```

续跑前保留同一输出目录中的 `manifest.json`、`checkpoint.json`、`raw-videos.json`、`video-details.json`、`occurrences.json` 和 `audits.json`。使用相同频道、相同参数和相同输出目录再次运行，默认不要加 `--fresh`；脚本会从 checkpoint 跳过已完成视频。只有明确重置频道时才使用 `--fresh`，不要因为会话额度中断就创建新目录。

标准命令形态如下，实际参数以来源会话保存的 runner/checkpoint 为准：

```sh
npm run youtube:discover-channel -- --channel-url <url> --singer-name <name> --output-dir <dir> --max-channel-pages 100 --max-candidates 0 --max-inspect 1000 --request-interval-ms 3000 --request-jitter-ms 1500
```

使用 bounded watchdog（例如 20 分钟）。边界到达后先收 checkpoint、summary、heartbeat 和日志；`reachedEnd=false` 只能说明本轮是部分结果，必须记录候选数、详情数、accepted 数、时间字段覆盖和错误信息。来源 worker 不自动 import、push `main` 或 deploy；主会话审核 accepted 增量后再统一导入、构建、提交和发布。

来源完成后至少保存：频道/URL、批次名、checkpoint、去重后的新增视频和 occurrence 数、published timestamp/occurrence 时间/封面覆盖率、过滤原因、产物 SHA 和测试输出。续跑后比较新增 ID，确认没有重复 imported 视频。

## 磁盘边界

- C 盘不放构建产物、SQLite、来源原始数据或压缩包。
- D 盘只保留仍在使用的来源工作树；空间不足时改用 G 盘或 Mac。
- 大构建、来源原始数据和 SQLite 优先放 Mac 或 `G:\\codex-temp`。
- 清理前确认目录不是当前 worker 的输出目录，并检查绝对路径仍在允许目录内。
