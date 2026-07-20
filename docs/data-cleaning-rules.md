# Data Cleaning Rules

## Scope

This branch only changes data cleanup, curation, duplicate folding, tests, and blocklist metadata. It does not change UI rendering, API serving, deployment, DNS, or channel discovery scope.

Rules in this document apply to parsed song fields: `title`, `artist`, `raw`, and selected source provenance. They must not drop a row because a channel name or video title contains words such as `OP`, `ED`, `Start`, or `Set List`.

## Reviewed Inputs

- `D:\Download\剪贴板图片 (17).jpg`, `(19).jpg`: song index screenshots with section-marker titles such as `ED`, `OP`, `Start`, `曲名`, `セットリスト`, and similar rows.
- `D:\Download\剪贴板图片 (20).jpg`: same video contains duplicate performances one or two seconds apart from different timestamp authors.
- `D:\Download\剪贴板图片 (21).jpg`: chant/noise rows such as `天Q`, `天Q天Q~~WO~~~`, `HAWAWA`, `BUAAAA`, `HE HE`, `E HO E HO`, and `AAA TEST TEST`.
- `D:\Download\剪贴板文本 (50).txt`, `(51).txt`: song index page snapshots. False-positive samples include real titles and artist/work metadata such as `-ERROR / niki`, `-OZONE-`, and `さらば / キンモクセイ『あたしンち』初代OP ※`.
- Online check: `https://ytb-song-rank.culua.com/data/latest.json`, queried by `node scripts/audit-data-quality-cleanup.js`.

## High-Confidence Drops

Unknown-artist section labels are rejected by parser and curation rules:

- Exact or normalized labels: `ED`, `OP`, `END`, `Start`, `START`, `Opening`, `opening`, `Ending`, `ending`, `Intro`, `Outro`, `open`, `OPEN`, `Set List`, `Setlist`, `セットリスト`, `セトリ`, `タイムスタンプ`, `曲名`.
- Stream lifecycle labels: `開始`, `歌唱開始`, `歌唱開始時間`, `歌唱開始時刻`, `配信開始`, `配信スタート`, `待機画面スタート`, `Start Stream`.
- Section-marker rows with descriptor fields are rejected when both sides are non-song metadata, for example `セットリスト / 歌唱開始時間` and `ED / お遊戯あり`.
- Activity markers already in the rule file remain scoped to unknown-artist rows: `自己紹介`, `声入り`, `挨拶`, `スパチャ読み`, and related rows.
- Standalone wave separators and event fragments: `～`, `～リアルライブチケット#耐久 7`.
- Chant/reaction rows from the `天Q` screenshot: `天Q`, `HI 天Q~`, `天Q天Q~~WO~~~`, `DQ~`, `HAWAWA`, `BUAAAA`, `HE HE`, `E HO E HO`, `AAA TEST TEST`, plus existing `KOPIPE`, `KP`, `A LELELELE`.

## START Guardrail

`START` and `Start` are not globally removed. Unknown-artist `START` section markers are dropped, but explicit known-artist rows are kept. Tests cover:

- `StaRt / Mrs. GREEN APPLE`
- `START / レフティーモンスターP feat. Lily`
- `START / 愛内里菜`

If future review finds another real `START`, `Opening`, `Ending`, or `END` song, add a false-positive sample or known-song override before broadening cleanup.

## Near-Duplicate Folding

`scripts/curation.js` folds duplicate performances only inside the same video when:

- normalized song title keys match,
- timestamps differ by at most 30 seconds,
- artists are the same after normalization, or one side is unknown.

The retained row prefers forced-kept entries, then explicit known artists, then song-search-recognized entries, then earlier timestamps. The retained row carries `dedupe.reason = "near_duplicate_same_video"`, `windowSeconds = 30`, and a `duplicates` array with title, artist, time, seconds, source id/hash, raw hash, and raw text.

Same-song reprises outside the 30-second window are kept.

## Blocked VTuber

`Aruma Ch. 薬袋アルマ` is added through the existing regional VTuber blocklist:

- channel id: `UCD1QOCJIAPsMKMvRSXjLahw`
- handle: `@ArumaCh`
- evidence: `https://www.youtube.com/@ArumaCh`, `https://www.youtube.com/channel/UCD1QOCJIAPsMKMvRSXjLahw`, user-confirmed TW

After editing `config/blocked-vtuber-channels.json`, regenerate static assets with:

```powershell
node scripts\generate-blocked-vtuber-channels.js
npm run blocklist:validate
```

## Audit Command

Run:

```powershell
node scripts\audit-data-quality-cleanup.js
```

The script fetches the current online `data/latest.json`, applies local blocklist and curation rules in memory, verifies positive dirty samples and false-positive samples, and prints `CODEX_DATA_QUALITY_AUDIT_OK`.

Latest audit in this branch:

- query time: `2026-07-20T09:47:40.224Z`
- source generated/captured: `2026-07-19T14:08:56.115Z`
- group: `all`
- videos: `1815 -> 1813`
- songs: `27878 -> 27819`
- blocked videos: `2`
- curation rule drops: `16`
- near-duplicate folded entries: `9` across `9` groups
- dirty keyword rows: `22 -> 9`; remaining matches are reviewed `START` rows retained by guardrails.
- `天Q` rows in the current online snapshot: `0 -> 0`; local positive checks still verify `天Q` variants are dropped.
- START whitelist rows retained: `5 -> 5`
- false-positive checks retained: 11 samples, including `-ERROR / niki`, `-OZONE-`, `READY STEADY GO / L'Arc-en-Ciel`, `Open Your Eyes / Guano Apes`, `ENDLESS STORY / REIRA starring YUNA ITO`, and the three START whitelist rows.

Remaining dirty-keyword audit hits include reviewed false positives such as `StaRt` variants and artist/work metadata containing `OP`/`Start`; do not turn these into broad contains-based drops.
