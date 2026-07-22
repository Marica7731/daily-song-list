# Data Cleaning Rules

## Scope

This branch only changes data cleanup, curation, duplicate folding, tests, and blocklist metadata. It does not change UI rendering, API serving, deployment, DNS, or channel discovery scope.

Rules in this document apply to parsed song fields: `title`, `artist`, `raw`, and selected source provenance. They must not drop a row because a channel name or video title contains words such as `OP`, `ED`, `Start`, or `Set List`.

`youtube-channel-discovery` accepted JSON files are also cleaned before release with `node scripts\clean-channel-discovery-accepted.js --write`. The JS runtime ranking exporter and Python runtime DB fallback both apply source-aware non-song predicates again when merging base `data/latest.json` rows with external imports, so stale generated JSON, VSinger Moment rows, and scanned source rows cannot reintroduce already-known chat/comment rows during deploy-time DB rebuilds.

## Reviewed Inputs

- `D:\Download\剪贴板图片 (17).jpg`, `(19).jpg`: song index screenshots with section-marker titles such as `ED`, `OP`, `Start`, `曲名`, `セットリスト`, and similar rows.
- `D:\Download\剪贴板图片 (20).jpg`: same video contains duplicate performances one or two seconds apart from different timestamp authors.
- `D:\Download\剪贴板图片 (21).jpg`: chant/noise rows such as `天Q`, `天Q天Q~~WO~~~`, `HAWAWA`, `BUAAAA`, `HE HE`, `E HO E HO`, and `AAA TEST TEST`.
- `D:\Download\剪贴板文本 (50).txt`, `(51).txt`: song index page snapshots. False-positive samples include real titles and artist/work metadata such as `-ERROR / niki`, `-OZONE-`, and `さらば / キンモクセイ『あたしンち』初代OP ※`.
- Online check: `https://ytb-song-rank.culua.com/data/latest.json`, queried by `node scripts/audit-data-quality-cleanup.js`.
- User-confirmed dirty samples: `ZEAgcWCnkwQ` self-esteem/chat row, `okW2MlmPGe8&t=6697s` regional VTuber row, no-artist Riona rows, and high-volume `なれたん` chat/comment rows.

## High-Confidence Drops

Unknown-artist section labels are rejected by parser and curation rules:

- Exact or normalized labels: `ED`, `OP`, `END`, `Start`, `START`, `Opening`, `opening`, `Ending`, `ending`, `オープニング`, `エンディング`, `エンドカード`, `Intro`, `Outro`, `open`, `OPEN`, `Set List`, `Setlist`, `セットリスト`, `セトリ`, `タイムスタンプ`, `曲名`.
- Stream lifecycle labels: `開始`, `歌唱開始`, `歌唱開始時間`, `歌唱開始時刻`, `配信開始`, `配信スタート`, `待機画面スタート`, `Start Stream`.
- Section-marker rows with descriptor fields are rejected when both sides are non-song metadata, for example `セットリスト / 歌唱開始時間` and `ED / お遊戯あり`.
- `Cパート` / `エンドカード` outro rows are rejected as section metadata, including `END / Cパート` and `エンドカード(Cパート`.
- Activity markers already in the rule file remain scoped to unknown-artist rows: `自己紹介`, `声入り`, `挨拶`, `スパチャ読み`, and related rows.
- Standalone wave separators and event fragments: `～`, `～リアルライブチケット#耐久 7`.
- Chant/reaction rows from the `天Q` screenshot: `天Q`, `HI 天Q~`, `天Q天Q~~WO~~~`, `DQ~`, `HAWAWA`, `BUAAAA`, `HE HE`, `E HO E HO`, `AAA TEST TEST`, plus existing `KOPIPE`, `KP`, `A LELELELE`.
- Commentary/request/poll rows whose song title or raw text self-references `なれたん` are rejected unless they match a reviewed true-song guardrail. Examples include `なれたんに褒められたいハネダン達`, `去年のなれたん...`, and `アンケート (なれたんを家族に例えると)`.
- Unknown-artist rows whose title is the channel or streamer identity are rejected with source context, for example `なれたん` in `Naretan Ch. なれたん`.
- Riona source rows without a reliable artist are rejected by channel scope, while explicit-artist songs on the same channel are retained.
- Bracketed commentary notes such as `【雑談】リクエスト確認` and `（去年のなれたん）...` are rejected as non-song rows.
- Unknown-artist conversational rows are rejected across channels, including greetings and wrap-up chants like `おつはのちゅっちゅる〜！`, generic `雑談`/`聊天`/`挨拶` labels, and person-reference chatter such as `次のバトンは香鳴ハノンちゃん`.
- Singleton pseudo-song rows are rejected only with source-count context. The curation layer, JS runtime ranking exporter, and Python DB fallback compute normalized title source counts, then drop rows where the normalized title appears in one source, the artist is unknown or is an English explanatory gloss, and the title/raw text looks like daily chatter, stream notes, topic labels, or explanation text. Rows with an English explanatory gloss and no song-list ordinal are also rejected before singleton scoring because these are usually translated chapter headings, for example `上野公園の桜 / Cherry Blossoms at Ueno Park`. Reliable English artist names remain guarded, for example `ホログラム / NICO Touches the Walls`, `元彼氏として / My Hair is Bad`, and `明日への扉 / I WiSH`.
- `vsinger_moment_http` / `vsinger-moment` / `moment` provenance is not an `isCollected` source. Only manual, verified, song-search, and accepted `youtube_channel_discovery` rows set the collected flag.
- Accepted YouTube channel discovery rows are audited before import. The importer drops high-confidence non-song rows and reports `rawSongs`, `acceptedSongs`, `droppedSongs`, `suspiciousSongs`, and `importAudit` so source additions do not silently reintroduce known dirty patterns.
- Instrument and background-stream source rows are rejected when the unknown-artist row is an activity/format marker, including `フルート`, `クラリネット`, `生演奏`, `live`, `ライブ`, and the exact phrases `piano streaming` and `ピアノ演奏`. Do not broaden this to standalone `piano` or `ピアノ`; those can be real song titles or artist metadata.

## High-Confidence Artist Completion

Unknown-artist rows may be repaired only when the normalized title exactly matches a reviewed record in `config/known-song-artist-overrides.json`. The repair layer applies these records after parser cleanup and delimiter repair, and only when `artist` is an unknown marker such as `未記載`, `待补歌手`, or `待補歌手`. It does not overwrite explicit artists and does not apply to longer chatter titles such as `熱異常について`.

Current reviewed examples include:

- `熱異常` -> `いよわ`; checked against the local song-search index (`熱異常::いよわfeat足立レイ`), YouTube result query `熱異常 いよわ YouTube`, and Apple Music query `熱異常 いよわ Apple Music`.
- `自己肯定感販売所` -> `みたにみく`; kept separate from the `自己肯定感爆上げ↑↑しゅきしゅきソング` aliases.
- `自己肯定感爆上げ↑↑しゅきしゅきソング` -> `初星学園`; numbered/decorated variants such as `53🎤 自己肯定感爆上げ↑↑しゅきしゅきソング` are cleaned and merged into this reviewed title.
- Frequent current unknown-artist rows with song-search title-artist matches and platform confirmation, including `少女レイ / みきとP`, `IRIS OUT / 米津玄師`, `HOT LIMIT / T.M.Revolution`, `Bling-Bang-Bang-Born / Creepy Nuts`, `怪獣の花唄 / Vaundy`, `天体観測 / BUMP OF CHICKEN`, `新宝島 / サカナクション`, `鬼ノ宴 / 友成空`, and `魂のルフラン / 高橋洋子`.

Do not add a title to `known-song-artist-overrides.json` merely because song-search has a title-only match. Keep it as `待补歌手` when the title maps to multiple plausible artists, appears only once, lacks platform evidence, or looks like commentary, an English explanatory gloss, a chapter heading, translation text, or stream activity. Those rows should be reviewed through curation/non-song rules instead of artist completion.

## Reviewed Same-Song Variants

Safe arrangement/version suffixes can be merged into the base work when the title body and artist identity are compatible. This currently covers English/Eng/英文/英語 versions and a cappella variants written as `a cappella`, `acappella`, `アカペラ`, `阿卡贝拉`, or `清唱`. These rules are mirrored in the JS frontend/runtime helpers and the Python runtime DB builder.

`自己肯定感販売所` is explicitly not an alias of `自己肯定感爆上げ↑↑しゅきしゅきソング`.

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

- query time: `2026-07-20T20:22:52.122Z`
- source generated/captured: `2026-07-19T14:08:56.115Z`
- group: `all`
- videos: `1810 -> 1810`
- songs: `27768 -> 27756`
- blocked videos: `0`
- curation rule drops: `3`
- near-duplicate folded entries: `9` across `9` groups
- dirty keyword rows: `9 -> 9`; remaining matches are reviewed `START` rows retained by guardrails.
- `天Q` rows in the current online snapshot: `0 -> 0`; local positive checks still verify `天Q` variants are dropped.
- START whitelist rows retained: `5 -> 5`
- positive checks dropped: 13 samples, including `ZEAgcWCnkwQ`, `okW2MlmPGe8&t=6697s`, no-artist Riona, `なれたん`, section labels, and chant rows.
- false-positive checks retained: 11 samples, including `-ERROR / niki`, `-OZONE-`, `READY STEADY GO / L'Arc-en-Ciel`, `Open Your Eyes / Guano Apes`, `ENDLESS STORY / REIRA starring YUNA ITO`, and the three START whitelist rows.

Remaining dirty-keyword audit hits include reviewed false positives such as `StaRt` variants and artist/work metadata containing `OP`/`Start`; do not turn these into broad contains-based drops.

2026-07-22 hotfix note:

- Current production VTuber ranking must be queried from `https://ytb-song-rank.culua.com/api/rankings?range=all&view=vtubers&metric=songs&pageSize=20` before prioritizing cleanup. A stale local SQLite artifact still showed Naraetan at `2629` songs, while production returned `2070` songs at the start of this pass.
- The cleanup additions are intentionally narrow: request/chat/topic rows such as `曲のリクエスト`, `KICKBACKという曲の歌い方について`, `劇場版コナンについて`, `本編終了`, `同接100人達成`, and unknown-artist stream BGM notes are dropped.
- Keep the false-positive guards for real songs such as `StaRt`, `START!! True dreams`, `Never Ending Story`, `プレイバック Part2`, and `新時代 (ウタ from ONE PIECE FILM RED)`.
- Keep list-level cleanup shared between import and runtime paths. `SourceFilter.dropSameSecondTranslatedAliasSongs()` is used by the client payload filter, `scripts/db/export-runtime-rankings.js`, and `scripts/clean-channel-discovery-accepted.js`. It only removes Latin/English duplicates when the same source video list contains at least two same-second CJK+Latin pairs, which indicates a bilingual timestamp list; single mixed pairs are left for reviewed aliases.
- Current local cleancheck DB threshold audit (`songCount > 1000 OR occurrences > 5000`) still finds four channels after batch-1 cleanup: Naraetan `1461/4248`, Hanon `1195/6468`, 明日夢かなえ `1056/3665`, and Noa `1030/4695`. Same-second CJK/Latin duplicates were originally concentrated in Naraetan (`842` groups); after the shared list-level pass only one reviewed single-pair source remains, for example `ぴゅあぴゅあはーと / 放課後ティータイム` versus `Pure Pure Heart / Houkago Tea Time`. Residual `ワンコーラス` entries are kept as real song version notes; high-confidence reaction/comment rows such as `くしゃみ`, `助かる`, `ガチ恋距離助かる`, and `ここすき` are dropped in both import and runtime paths.
- Artist metadata stripping belongs in `scripts/song-utils.js` so import and runtime rebuilds agree. Reviewed suffixes include `(EN:...)`, `※Be Careful of Volume`, `※音源一時停止有`, and `(同接200人突破おめでとうございます)`. These suffixes are removed from the artist field, not treated as song aliases.

2026-07-22 second-pass reaction cleanup note:

- Production API threshold audit at `2026-07-21T23:48:56.106Z` found 29 VTuber targets where `songCount > 1000 OR count > 5000`. Query both `metric=songs` and `metric=count`, because count-heavy channels can sit below the song threshold.
- Do not broaden cleanup to every title containing `かわいい` or `可愛い`. Real songs such as `わたしの一番かわいいところ` and `可愛いあの子が気にゐらない` appear frequently in the target set and must be retained.
- Do not treat `No01.` / `No02.` prefixes as non-song by themselves. Those are often song-list ordinals already handled by title cleanup, not proof of noise.
- The reusable import/runtime rule is narrower: short unknown-artist reaction pseudo titles ending in `助かる` / `たすかる`, especially when combined with `くしゃみ`, `咳`, `圧`, `バカ`, or `ちゅ`, are non-song rows. Examples: `くしゃみ助かる`, `くしゃみたすかるんだワ`, `圧助かる`, `ちゅたすかる`.
- Keep this rule in both `assets/source-filter.js` and `scripts/song-utils.js`; source imports, accepted JSON cleanup, runtime export, and the client fallback should agree.

2026-07-22 third-pass prefix cleanup note:

- Production API target audit at `2026-07-22T00:43:41Z` found residual list prefixes in the 29 high-volume VTuber targets: `NoNN. title` in 5 targets / 332 aggregated song rows, and `NN;H:MM:SS title` in 1 target / 205 aggregated song rows.
- These are song-list ordinals or leaked timestamp columns, not non-song rows. Strip the prefix and keep the song; do not drop the row.
- Keep the matching strict: `No` + 1-3 digits + dot + whitespace, or 1-3 digits + semicolon + full `H:MM:SS` + whitespace. Guardrails that must remain unchanged include `No brand girls`, `No Logic`, `No title`, `No.1`, `NO, Thank You!`, `No pain, No game`, and `Re;fract`.
- Maintain the rule in `assets/source-filter.js`, `assets/ranking-utils.js`, and the Python fallback in `scripts/db/build-runtime-db.py`. The JS import/runtime path, frontend search keys, and fallback DB builder need to merge the same base titles.

For accepted JSON impact checks, run:

```powershell
node scripts\audit-accepted-cleaning-impact.js
```

The script reads `data/external/youtube-channel-discovery/accepted/*.json` plus local runtime JSON, reports before/after counts for Naraetan, KanaruHanon, and IsakiRiona, and prints `CODEX_ACCEPTED_CLEANING_IMPACT_OK`. It also verifies `START:DASH!!`, `ENDLESS STORY`, and `Never Ending Story` remain kept.

Latest local accepted impact audit in this branch:

- query time: `2026-07-21T23:56:47.331Z`
- Naraetan accepted source: `2026-07-19-naraetanV-full.json`; songs `5715 -> 5161`; unique normalized titles `2576 -> 2049`; dirty candidates `550 -> 0`.
- KanaruHanon accepted source: `2026-07-19-kanaruhanon-full.json`; songs `6701 -> 6464`; unique normalized titles `1299 -> 1220`; dirty candidates `222 -> 0`.
- IsakiRiona runtime fallback: songs `38 -> 38`; unique normalized titles `19 -> 19`; dirty candidates `0 -> 0`.
- Guardrails retained: `START:DASH!! / μ's`, `ENDLESS STORY / REIRA starring YUNA ITO`, and `Never Ending Story / Limahl`.
