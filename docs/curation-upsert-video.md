# 整场直播歌单替换（`upsert_video`）

`upsert_video` 用于人工确认一场已经存在于数据库中的直播歌单后，完整替换该视频原有的歌曲与时间戳。它不会创建频道、头像、标题或发布时间等视频元数据；这些字段继续沿用数据库中该 `videoId` 的记录。

## 准备格式

把待导入内容保存为独立 patch 文件，不要把示例记录直接放进 `config/curation-overrides.json`：

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "action": "upsert_video",
      "videoId": "AAAAAAAAAAA",
      "songs": [
        {
          "seconds": 125,
          "title": "第一首歌",
          "artist": "歌手名"
        },
        {
          "seconds": 366,
          "title": "第二首歌",
          "artist": "未記載"
        }
      ],
      "reason": "user_provided_setlist",
      "note": "来源与核对说明",
      "reviewedAt": "2026-07-26T04:00:00+08:00",
      "reviewedBy": "Marica7731"
    }
  ]
}
```

字段要求：

- `videoId`：11 位 YouTube 视频 ID，必须是数据库中已有视频。
- `songs`：非空数组；`seconds` 必须是 JSON 数字类型的非负整数秒，不能写成 `"125"` 这样的字符串；同一场内不可重复。
- `title`：必填，保留官方标点；不要擅自删除括号、emoji 或 `feat.`。
- `artist`：必填官方歌手名；无法确认时明确填写 `未記載`，不能留空或猜测。
- `isNiche`：可省略；填写时必须是真正的 JSON 布尔值 `true` 或 `false`，不能写成字符串。
- `reason`、`reviewedAt`、`reviewedBy`：必填审计字段。

## 替换语义

- 命中 `videoId` 后，旧的歌曲 occurrence 全部移除，只保留 patch 中的 `songs`。
- 歌曲按 `seconds` 升序输出；视频标题、频道、handle、头像、发布时间等元数据不变。
- `drop_video` 优先于 `upsert_video`。
- 相同 patch 重复合并是幂等的；同一 `videoId` 的新 patch 会更新原有 `upsert_video` 记录。
- 目标 `videoId` 不存在时不会创建缺少频道、标题和发布时间的残缺视频；应用统计会把它列入 `unmatchedUpsertVideoIds`，必须先补齐该视频来源后再发布。
- patch 中的歌曲属于明确人工补录，可保留 `manual-upsert:<videoId>` 来源审计标识。

## 合并与验证

在 WSL 的 G 盘工作树执行，patch 文件也放在 G 盘：

```bash
cd /mnt/g/codex-work/daily-song-list
node scripts/apply-curation-patch.js /mnt/g/path/to/upsert-patch.json
node --test test/curation.test.js test/video-catalog.test.js
node scripts/validate-data.js
git diff -- config/curation-overrides.json
```

确认 diff 只包含目标视频后，再按项目门禁 commit、push。随后：

1. 运行 `Update core song-list data`（Mac self-hosted runner）物化静态核心数据。
2. 等待或运行 `Deploy SQLite runtime DB`。
3. 验证 `healthz`、`meta`、`rankings`，并查询该 `videoId` 的全部新时间戳。

本地配置已修改、测试通过或 workflow 仍在运行，都不等于线上完成。

## 回滚

删除该 `videoId` 对应的 `upsert_video` 记录并重新执行核心数据更新与 Runtime DB 发布。回滚前先确认原始来源数据仍可重建；如果原始来源本身已经被替换或丢失，应先保存并审核原歌单。
