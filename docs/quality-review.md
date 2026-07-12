# Quality Review Workflow

This project separates three things that used to be easy to mix together:

- parser rules in `config/non-song-rules.json`
- durable manual decisions in `config/curation-overrides.json`
- generated review artifacts in `data/review/*` and `data/quality-report.json`

The homepage runtime stays compact. `index.html` loads `data/ui/*`; `review.html` loads review data only when opened.

## Generated Artifacts

`npm run update` runs:

```powershell
node scripts/update-songlist.js
node scripts/apply-song-search-niche.js
node scripts/build-review-queue.js
node scripts/build-runtime-data.js
```

`scripts/build-review-queue.js` reads `data/latest.json`, `data/audit.json`, retained snapshots, and `data/song-search-known-songs.json`, then writes:

- `data/review/queue.json`: source-level review queue.
- `data/review/sources/<videoId>-<sourceHash>.json`: detail file for each suspicious source.
- `data/review/manifest.json`: small pointer file for review tooling.
- `data/quality-report.json`: aggregate quality metrics and recent history.

Old snapshots often do not have full raw comments. Those queue items have `sourceTextAvailable:false` and `forceRefreshSuggested:true`.

## Manual Patch Format

Persistent fixes live in `config/curation-overrides.json`:

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "action": "drop_entry",
      "videoId": "AAAAAAAAAAA",
      "sourceId": "UgxStableComment",
      "sourceHash": "sha256...",
      "seconds": 644,
      "rawHash": "sha256...",
      "reason": "review_drop_entry",
      "note": "",
      "reviewedAt": "2026-07-12T00:00:00.000Z",
      "reviewedBy": "review.html"
    }
  ]
}
```

Supported actions:

- `drop_entry`: remove one parsed row.
- `replace_entry`: replace `title`, `artist`, and/or `seconds`.
- `reject_source`: remove one comment/description/reply source from best-source scoring.
- `drop_video`: remove the whole video from generated output.
- `force_keep`: keep a row that ordinary heuristics would otherwise reject.

Entry actions must use stable identity: `videoId`, `sourceId` or `sourceHash`, `seconds`, and `rawHash`. `npm run validate` fails on invalid actions, missing `videoId`, invalid `seconds`, and conflicting duplicate rules.

## Review Page

Run a local server:

```powershell
npm run serve
```

Open:

```text
http://127.0.0.1:8080/review.html
```

The page supports high/medium/low filtering, the “小众 + 待补歌手” filter, source grouping, full source text when available, per-row actions, source rejection, video drop, import/export, undo, and patch copy. It never contains a GitHub PAT and does not write to the repository directly.

To merge an exported patch:

```powershell
node scripts/apply-curation-patch.js path/to/curation_patch.json
npm run check
```

## Rule Promotion Policy

Use manual overrides first. Promote only after review:

- one-off mistake: `config/curation-overrides.json`
- repeated same-channel format: `channelScopedExactTitles` or `channelScopedPatterns`
- at least three unrelated channels with positive and negative tests: global rule

Do not add broad regexes for words such as `紹介` or `離席`. The current global rule is exact-title only and applies only when artist is unknown.

## Carry-Forward Behavior

Curation applies twice:

- after parsing a source and before best-source selection
- after fetched videos and carry-forward videos are merged, before groups are built

If `reject_source` targets a carried video whose selected source was the only retained source, the video is removed from public output until it can be fetched again. The same override also removes the video from the carry-forward skip set, so a future matching candidate is inspected instead of skipped.

## Acceptance Checks

Use these commands after changing rules or overrides:

```powershell
npm test
npm run validate
node scripts/build-review-queue.js
npm run check
```

After a full update, verify:

- `曲紹介` and `離席` are absent from public `data/latest.json` song rows when artist is unknown.
- suspicious sources remain in `data/review/queue.json`.
- `review.html` can load source details and export a patch.
- `data/ui/*` contains no raw source text.
- YouTube timestamp links still use `watch?v=<videoId>&t=<seconds>s`.
