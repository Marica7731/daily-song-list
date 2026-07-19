# Data Cleaning Rules

This note documents the song-list cleanup rules added for the data-quality branch.

## Scope

The cleanup rules operate on parsed song fields only:

- song title
- song artist
- parsed raw song row

Do not drop a row only because a channel name, video title, or playlist title contains a dirty keyword. Source-level blocking remains separate and uses the blocked VTuber channel list.

## Non-Song Markers

Exact title-only markers with unknown artist are treated as non-song rows. Current examples include:

- `OP`, `ED`, `END`
- `Start`
- `曲名`
- `開始`
- `Set List`, `セットリスト`, `セトリ`
- `タイムスタンプ`
- `挨拶`

The intent is to remove chapter headers and axis text, not real songs. False-positive coverage keeps normal songs whose title merely contains a dirty word, and keeps common true-song samples such as `HOT LIMIT`, `READY STEADY GO`, and `はじまりはいつも雨`.

## START Whitelist

`START` and `Start` are not globally deleted when a trusted artist is present. These true-song rows are explicitly retained:

- `StaRt` - `Mrs. GREEN APPLE`
- `START` - `レフティーモンスターP feat. Lily`
- `START` - `愛内里菜`

Unknown-artist `Start` remains a removable section marker.

## Chat Reactions

Short chat-reaction rows are treated as non-song rows when they appear in song title or artist fields. Current patterns cover the reviewed `天Q` family and similar reaction text:

- `天Q`, `DQ`, `DENQ`
- repeated `天Q` plus shout tails such as `WO`, `HO`, or `HE`
- `HAWAWA`
- `BUAAAA`
- `AAA TEST TEST`
- `E HO E HO`
- `HE HE`

These rules are intentionally narrow and do not inspect channel/video names.

## Near-Duplicate Performances

Within a single video, if two parsed rows resolve to the same normalized title and their timestamps are within 30 seconds, they are treated as duplicate axis-author entries.

The deduper:

- keeps known-artist rows over unknown-artist rows;
- otherwise keeps the row with stronger provenance;
- otherwise keeps the earlier timestamp;
- keeps repeats outside the 30-second window;
- attaches compact `nearDuplicateMerge` provenance to the retained row.

This prevents adjacent duplicates such as two axis authors entering the same song one or two seconds apart, while preserving legitimate reprises later in the stream.

## Blocked VTubers

Taiwan VTuber filtering uses `config/blocked-vtuber-channels.json`. The branch adds:

- `Aruma Ch. 薬袋アルマ`
- handle `@ArumaCh`
- aliases `薬袋アルマ`, `藥袋アルマ`, `Minai Aruma`, `Aruma Ch.`

After editing the blocklist, regenerate and validate the generated assets:

```powershell
npm run blocklist:generate
npm run blocklist:validate
```

## Validation Commands

For this class of data cleanup, run:

```powershell
node scripts\rebuild-derived-data.js
node --max-old-space-size=8192 scripts\build-runtime-data.js
node scripts\analyze-data-quality-cleanup.js
node --test test\parser.test.js test\curation.test.js test\source-filter.test.js
node scripts\validate-data.js --core
npm run blocklist:validate
```

`npm run rebuild:derived` also rebuilds review queues. On the 2026-07-20 local dataset, `scripts/build-review-queue.js` did not finish in the interactive window after clearing `data/review/sources`, so `data/review` was restored and not committed as part of this cleanup.

## 2026-07-20 Impact

Local derived-data summary after `node scripts\rebuild-derived-data.js`:

- `songs=40421`
- `fixedTitles=78`
- `repaired=2837`
- `ruleDropped=78`

Final `data/latest.json` curation summary:

- `ruleDroppedEntryCount=78`
- `conversationDroppedEntryCount=76`
- `nearDuplicateDroppedEntryCount=20`
- `qualityDroppedEntryCount=2`
- `fixedTitleCount=702`
- `fixedArtistCount=1058`
- `repairedEntryCount=5676`

Baseline audit with `node scripts\analyze-data-quality-cleanup.js --git-ref HEAD:data/latest.json`:

- `inputVideos=1815`
- `inputSongs=27878`
- `blockedSourceRemoved=2`
- `arumaBlockedVideoCount=2`
- `curationFilteredSongCount=45`
- `nearDuplicateDroppedEntries=9`
- `startWhitelistSamplesRetained=3`
- `falsePositiveSamplesPassed=true`

Post-cleanup analysis with `node scripts\analyze-data-quality-cleanup.js`:

- `inputVideos=1810`
- `inputSongs=27807`
- `afterCurationVideos=1810`
- `afterCurationSongs=27802`
- `curationFilteredSongCount=5`
- `nearDuplicateDroppedEntries=5`
- `startWhitelistSamplesRetained=3`
- `falsePositiveSamplesPassed=true`
- `arumaBlockedVideoCount=0` in final data, meaning the current generated dataset has no Aruma residual rows.
