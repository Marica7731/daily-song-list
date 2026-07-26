# PostgreSQL 增量 upsert 操作说明

PostgreSQL 是线上结构化数据的目标源；SQLite 只在迁移期间作为只读快照和回滚材料。原始 JSON/HTML、抓取日志和审计附件不放进热库。

API 通过 `--postgres-dsn` 或 `DAILY_SONG_POSTGRES_DSN` 使用 PostgreSQL；未提供该参数时才使用旧 SQLite 兼容模式：

```bash
python3 -m pip install -r requirements-postgres.txt
DAILY_SONG_POSTGRES_DSN="$DAILY_SONG_POSTGRES_DSN" \
  python3 server/song_rank_api.py --postgres-dsn "$DAILY_SONG_POSTGRES_DSN"
```

## 歌单输入

歌单可以先整理成 JSONL，每行一首歌：

```json
{"video_id":"8-RbgojxDHk5","video_url":"https://www.youtube.com/watch?v=8-RbgojxDHk5","date":"2026-07-23","start_time":"01:23:45","title":"曲名","artist":"原歌手","channel_name":"频道显示名"}
```

`video_id + start_time/seconds` 是幂等定位键。频道 `channelId`、`handle`、`displayName` 可以为空，不能根据标题或评论者猜测。

## Mac 上的受控流程

```bash
python3 scripts/db/postgres_upsert.py \
  --input playlist.jsonl \
  --output normalized.json

python3 scripts/db/resolve_channel_handles.py \
  --input normalized.json \
  --output resolved.json \
  --timeout-seconds 20

python3 scripts/db/postgres_upsert.py \
  --input resolved.json \
  --dsn "$DAILY_SONG_POSTGRES_DSN" \
  --apply

# 出现需要撤回时使用操作 ID，不直接修改生产表
python3 scripts/db/postgres_rollback.py \
  --dsn "$DAILY_SONG_POSTGRES_DSN" \
  --operation-id "<operation-id>"
```

第一条命令只校验格式和分组；第二条命令按视频 URL 调用 `yt-dlp` 获取频道身份，无法确认的条目保持 pending；第三条命令在一个事务中写入视频、歌曲、occurrence、操作审计和受影响歌曲聚合。

## `upsert_video` 语义

- `replaceVideo=true` 表示该视频的提交歌单是完整歌单：同一视频、同一来源中未出现在新列表的旧 occurrence 会删除。
- `replaceVideo=false` 只新增或更新提供的时间点，不删除旧数据。
- 每次操作都有 `operation_id`、操作者、理由和结果计数，可据此做回滚工具。
- 未验证的频道身份不会产生“已收录”或可信频道归属。

## 发布门禁

正式写入前必须有：

1. `CODEX_CHANNEL_HANDLE_RESOLVE_OK`，并核对 pending/verified 数量；
2. PostgreSQL 事务提交成功且返回 operation ID；
3. 受影响歌曲/频道的 occurrence、video、song 计数与输入一致；
4. `/healthz`、`/api/meta` 和至少一个受影响视频/频道查询通过；
5. Mac 临时目录清理完成。任何一项失败都保持旧线上版本，不显示半成品。

初次迁移后的计数和抽样校验：

```bash
python3 scripts/db/compare_postgres_runtime.py \
  --sqlite artifacts/runtime/song-rank.sqlite \
  --dsn "$DAILY_SONG_POSTGRES_DSN" \
  --output migration-compare.json
```

只有 `CODEX_POSTGRES_COMPARE_OK` 才允许切换 API；`MISMATCH` 或异常都保持旧服务。
