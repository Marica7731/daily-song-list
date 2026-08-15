# Daily Song List

Small GitHub Pages site that collects YouTube videos with usable timestamp song lists, then exposes jump links for the current two runtime ranges:

- `7d`: videos published within the last 7 days.
- `all`: the accumulated catalog of videos with usable timestamp song lists.

`72h` and `1m` remain compatibility aliases for old links and legacy data paths. The site keeps successful hourly snapshots permanently. If a scheduled scrape fails, existing `data/latest.json`, snapshot files, and browser runtime files remain untouched, so the page continues to show the last successful result.

## Mac-first WDC release workflow

`.github/workflows/sync-wdc-release.yml` keeps an Ubuntu syntax/regression gate, then assigns the heavy snapshot, build, stream, activation, and verification job to `[self-hosted, macOS, ARM64, daily-song-list-mac]`. Each attempt exclusively owns `/Users/be/codex-temp/dsl-wdc-sync-<run>-<attempt>`; an existing directory is a hard failure rather than a resumable shared workspace.

The Mac runner uses `/Users/be/.local/bin/python3`; it does not assume `/usr/bin/python3` has a PostgreSQL driver. The workflow installs the three binary/hash-locked entries in `scripts/migration/requirements-wdc-mac.txt` into the exact run's `python-deps` directory with `--only-binary=:all: --require-hashes --no-deps --no-cache-dir --timeout 30 --retries 2`. `PYTHONPATH` is the run-local dependency directory plus the checkout, and global/user site-packages are never modified. Node, OpenSSH, and `tar` must already exist. `materialize-pg-release-snapshot.py` reads all pages, scopes, source details, and source occurrences inside one `REPEATABLE READ READ ONLY` transaction. VPS2 only runs a bounded `www-data` relay from loopback TCP to the PostgreSQL Unix socket. The Mac uses strict known hosts for the SSH tunnel; there is no public PostgreSQL port and no database password.

Mac storage is fail-closed and BSD-compatible. `MAC_RUN_MAX_BYTES=32,000,000,000` covers a roughly 13 GB release plus bounded build intermediates, while `MAC_FILESYSTEM_RESERVE_BYTES=15,000,000,000` protects space outside the run. A Python `lstat`/`shutil.disk_usage` preflight reserves the entire remaining run budget before build; a second exact recursive regular-file `st_size` count runs after the bundle is ready. Symlinks and every other non-regular entry are rejected. The workflow never uses GNU `find`/`du` approximations on Mac and never scans or cleans another run directory.

The workflow checks the active revision, source content hash, and source commit at start, after the Mac build, immediately before activation, and after activation. It requires exactly one 64-hex bundle directory and computes release bytes by recursively summing regular-file `st_size`. The bundle never travels through GitHub artifacts and no large archive is written on VPS2: a bounded tar stream goes directly to the exact WDC current-run `release.tar.gz.part`. Failure cleanup derives all paths from run ID and attempt, stops the exact tunnel/relay/backend, and removes only current-run paths. A release moved before installer state exists is removed only when it is not `current`, has no `.rollback-<sha>`, and resolves to the exact `releases/<sha>` direct child; active or rollback-bearing candidates are preserved and make cleanup fail visibly.

## WDC storage safety

WDC production has a project-specific hard ceiling of **40 GB = 40,000,000,000 bytes** for Daily Song List. Reaching the line is a deployment failure, not a warning.

- Before the first current-run write, measure only `/opt/culua/ytb-song-rank` and calculate `current project bytes + bounded compressed archive bytes + one extracted release + 134,217,728-byte control-backup allowance`. Once the archive is present and already included in current project bytes, the second gate is `current project bytes + one extracted release + the same control allowance`.
- The six installer control targets—server, index, hashed app, systemd unit, nginx available, and nginx enabled—are measured exactly with `lstat`; only regular files or symlinks are accepted and their total must remain below **128 MiB = 134,217,728 bytes**. The rollback state copies those small controls, never `serving.sqlite`.
- The archive extracts into a sibling `releases/.incoming-<sha>.*` directory and a same-filesystem `mv` activates `releases/<sha>`. This rename does not copy the database, so the capacity gate deliberately counts one extracted release rather than two.
- If that conservative peak is greater than or equal to `40,000,000,000`, or any input cannot be proved, the deployment **must stop before writing to WDC**.
- The workflow also preserves at least `5,000,000,000` bytes of host filesystem headroom so this project cannot crowd out unrelated workloads.
- WDC writes and cleanup are limited to `/opt/culua/ytb-song-rank` and `/opt/culua/ytb-song-rank/incoming/dsl-wdc-<run>-<attempt>-<64-hex-release>`. Never scan or delete sibling projects or unrelated temporary files to make room.
- Rollback state is retained through all public correctness gates. Only after success may retention remove verified direct 64-hex children of `/opt/culua/ytb-song-rank/releases`, keeping the exact current and previous releases.
- Final acceptance must record project bytes, filesystem availability, current/previous identities, and absence of incoming, rollback, and current-run temporary residue.

The authoritative agent instructions are in [`AGENTS.md`](AGENTS.md). Capacity uncertainty always fails closed and leaves production unchanged.

## UI Screenshots

These committed screenshots are the repository homepage proof set for the current UI. Refresh them whenever a UI-facing change is shipped or when the deployed page needs to show the latest layout:

```powershell
npm run screenshots:readme -- https://ytb-song-rank.culua.com/
```

The maintained layout contract lives in [`docs/ui-spec.md`](docs/ui-spec.md). The full committed UI proof matrix lives in [`docs/ui-proof.md`](docs/ui-proof.md), with freshness checked by `docs/assets/screenshots/manifest.json`. Data flow, storage, range migration, and backfill details live in [`docs/data-architecture.md`](docs/data-architecture.md), [`docs/storage-layout.md`](docs/storage-layout.md), [`docs/range-migration.md`](docs/range-migration.md), and [`docs/backfill.md`](docs/backfill.md). VSinger Moment public HTML cursor backfill operations live in [`docs/vsinger-http-backfill.md`](docs/vsinger-http-backfill.md).

### Desktop Web

| Song ranking | All range via legacy `1m` URL | Artist ranking |
| --- | --- | --- |
| <img src="docs/assets/screenshots/desktop-song-rank.png" alt="Desktop song ranking" width="320" /> | <img src="docs/assets/screenshots/desktop-monthly-song-rank.png" alt="Desktop all range ranking through legacy 1m URL" width="320" /> | <img src="docs/assets/screenshots/desktop-artist-rank.png" alt="Desktop artist ranking" width="320" /> |

| Song index | VTuber channels | Video tab |
| --- | --- | --- |
| <img src="docs/assets/screenshots/desktop-song-index.png" alt="Desktop song index" width="320" /> | <img src="docs/assets/screenshots/desktop-vtuber-rank.png" alt="Desktop VTuber channel ranking" width="320" /> | <img src="docs/assets/screenshots/desktop-video-view.png" alt="Desktop video tab" width="320" /> |

| Summary baseline |
| --- |
| <img src="docs/assets/screenshots/desktop-summary-baseline.png" alt="Desktop summary baseline" width="320" /> |

| 7d range fixture | All range fixture | Data partitions |
| --- | --- | --- |
| <img src="docs/assets/screenshots/desktop-range-7d.png" alt="Desktop 7d range proof fixture" width="320" /> | <img src="docs/assets/screenshots/desktop-range-all.png" alt="Desktop all range proof fixture" width="320" /> | <img src="docs/assets/screenshots/desktop-partition-pagination.png" alt="Desktop partition pagination proof fixture" width="320" /> |

| Cumulative diff proof | Kana/Romaji merge proof |
| --- | --- |
| <img src="docs/assets/screenshots/desktop-all-diff-explanation.png" alt="Desktop cumulative diff explanation proof" width="320" /> | <img src="docs/assets/screenshots/desktop-song-kana-romaji-merged.png" alt="Desktop same-title kana and romaji merge proof" width="320" /> |

| Search and filters | Expanded sources | 3 inline sources |
| --- | --- | --- |
| <img src="docs/assets/screenshots/desktop-query-panel.png" alt="Desktop unified search and filter panel" width="320" /> | <img src="docs/assets/screenshots/desktop-source-expanded.png" alt="Desktop expanded song sources" width="320" /> | <img src="docs/assets/screenshots/desktop-source-inline-3.png" alt="Desktop inline source thumbnails" width="320" /> |

| Middle pagination | Long timestamp source | Search and snapshot indexes |
| --- | --- | --- |
| <img src="docs/assets/screenshots/desktop-pagination-middle.png" alt="Desktop middle pagination state" width="320" /> | <img src="docs/assets/screenshots/desktop-source-long-time.png" alt="Desktop inline source with long timestamp" width="320" /> | <img src="docs/assets/screenshots/desktop-search-snapshot-index.png" alt="Desktop search and snapshot index proof fixture" width="320" /> |

| Tablet 3 inline sources |
| --- |
| <img src="docs/assets/screenshots/tablet-source-inline-3.png" alt="Tablet inline source thumbnails" width="260" /> |

### Mobile H5

| Song ranking | Artist ranking | VTuber channels |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-song-rank.png" alt="Mobile song ranking" width="180" /> | <img src="docs/assets/screenshots/mobile-artist-rank.png" alt="Mobile artist ranking" width="180" /> | <img src="docs/assets/screenshots/mobile-vtuber-rank.png" alt="Mobile VTuber channel ranking" width="180" /> |

| VTuber 320px | Song index |
| --- | --- |
| <img src="docs/assets/screenshots/mobile-vtuber-rank-320.png" alt="Mobile 320px VTuber channel ranking" width="180" /> | <img src="docs/assets/screenshots/mobile-song-index.png" alt="Mobile song index" width="180" /> |

| Summary baseline | Copy toast |
| --- | --- |
| <img src="docs/assets/screenshots/mobile-summary-baseline.png" alt="Mobile summary baseline" width="180" /> | <img src="docs/assets/screenshots/mobile-toast-copy-setlist.png" alt="Mobile copy setlist toast" width="180" /> |

| All-time summary | Trend count increase | Trend rank down |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-all-monotonic-summary.png" alt="Mobile all-time monotonic summary proof" width="180" /> | <img src="docs/assets/screenshots/mobile-trend-count-increase.png" alt="Mobile trend count increase label" width="180" /> | <img src="docs/assets/screenshots/mobile-trend-rank-only-down.png" alt="Mobile trend rank-only down label" width="180" /> |

| Trend correction | Kana/Romaji merge | Video diagnostic |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-trend-corrected-decrease.png" alt="Mobile corrected count decrease label" width="180" /> | <img src="docs/assets/screenshots/mobile-song-kana-romaji-merged.png" alt="Mobile same-title kana and romaji merge proof" width="180" /> | <img src="docs/assets/screenshots/mobile-video-diagnostic-result.png" alt="Mobile video diagnostic proof" width="180" /> |

| Song index middle | Song index last | 320px pagination |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-song-index-middle-page.png" alt="Mobile song index middle page" width="180" /> | <img src="docs/assets/screenshots/mobile-song-index-last-page.png" alt="Mobile song index last page" width="180" /> | <img src="docs/assets/screenshots/mobile-pagination-320.png" alt="Mobile 320px pagination" width="180" /> |

| Video tab | Video expanded top | Video expanded bottom |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-video-view.png" alt="Mobile video tab" width="180" /> | <img src="docs/assets/screenshots/mobile-video-expanded.png" alt="Mobile expanded video card top" width="180" /> | <img src="docs/assets/screenshots/mobile-video-expanded-bottom.png" alt="Mobile expanded video card bottom collapse action" width="180" /> |

| Sources expanded |
| --- |
| <img src="docs/assets/screenshots/mobile-source-expanded.png" alt="Mobile expanded song sources" width="180" /> |

| 0 source | 1 source inline | 2 sources inline |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-source-inline-0.png" alt="Mobile source row with no source" width="180" /> | <img src="docs/assets/screenshots/mobile-source-inline-1.png" alt="Mobile one source inline row with thumbnail" width="180" /> | <img src="docs/assets/screenshots/mobile-source-inline-2.png" alt="Mobile two source inline row with thumbnails" width="180" /> |

| 3 sources compact | More sources | More expanded top |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-source-inline-3.png" alt="Mobile three-source row with two inline thumbnails and one compact view-all action" width="180" /> | <img src="docs/assets/screenshots/mobile-source-more-than-3.png" alt="Mobile row with more than three sources" width="180" /> | <img src="docs/assets/screenshots/mobile-source-more-than-3-expanded.png" alt="Mobile row with all sources expanded top" width="180" /> |

| More expanded bottom |
| --- |
| <img src="docs/assets/screenshots/mobile-source-more-than-3-expanded-bottom.png" alt="Mobile row with all sources expanded bottom collapse action" width="180" /> |

| New-to-old sources | Thumbnail fallback | Long channel |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-source-new-to-old.png" alt="Mobile sources ordered from newest to oldest" width="180" /> | <img src="docs/assets/screenshots/mobile-source-thumb-fallback.png" alt="Mobile inline source thumbnail fallback" width="180" /> | <img src="docs/assets/screenshots/mobile-source-long-channel.png" alt="Mobile inline source with long channel name" width="180" /> |

| Long timestamp | Extra timestamps | Filtered summary |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-source-long-time.png" alt="Mobile inline source with long timestamp" width="180" /> | <img src="docs/assets/screenshots/mobile-source-extra-times.png" alt="Mobile inline source with extra timestamps" width="180" /> | <img src="docs/assets/screenshots/mobile-summary-filtered.png" alt="Mobile filtered summary with natural units" width="180" /> |

| Active controls |
| --- |
| <img src="docs/assets/screenshots/mobile-controls-active.png" alt="Mobile compact active controls" width="180" /> |

| Active query strip | Recent searches | Suggestions |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-active-query-strip.png" alt="Mobile active query strip with search and filters" width="180" /> | <img src="docs/assets/screenshots/mobile-query-history.png" alt="Mobile query panel with stable snapshot history" width="180" /> | <img src="docs/assets/screenshots/mobile-query-suggestions.png" alt="Mobile search suggestions in query panel" width="180" /> |

| Filter controls | Snapshot controls | Bottom navigation |
| --- | --- | --- |
| <img src="docs/assets/screenshots/mobile-query-filter.png" alt="Mobile query panel filter controls" width="180" /> | <img src="docs/assets/screenshots/mobile-query-history.png" alt="Mobile query panel history snapshot controls" width="180" /> | <img src="docs/assets/screenshots/mobile-bottom-nav-active.png" alt="Mobile bottom navigation active icon state" width="180" /> |

## How it Works

1. `scripts/update-songlist.js` fetches YouTube search pages for `歌枠` and `弾き語り` using the same `today` and `month` filter URLs used by `Marica7731/mygit`.
   - Search pages are expanded through YouTube search continuation requests, matching the ranking project's "scroll until more results are loaded" behavior without requiring a browser in GitHub Actions.
   - When the previous successful snapshot is fresh, already inspected videos are carried forward and skipped. The `7d` view is a fixed publish-time window; the `all` view is built from the permanent video catalog. The new inspection queue usually scans today's and one-day-old candidates, then refreshes a small number of catalog/backfill candidates. If carried catalog results are below the backfill target, the queue reserves less of the inspection budget for recent-only videos and fills the remaining budget from catalog candidates first.
   - If the previous successful snapshot is missing or too old, the script falls back to a full recovery queue covering today's, one-day-old, and two-day-old candidates before filling the remaining budget with monthly-filter candidates.
2. It fetches each candidate watch page, extracts description and first comment continuations, parses timestamped song lists, and skips videos without usable songs.
   - Timestamp sources now keep stable review identity: YouTube comments and replies use their `commentId`, descriptions use `description:<videoId>:<hash>`, and hash fallback uses normalized source text SHA-256.
   - `config/non-song-rules.json` contains conservative non-song rules. Global activity rules apply only to unknown-artist rows and cover high-confidence section markers such as song intro/end labels, breaks, stream start/end notes, superchat/member reading, and sound checks. The same titles with explicit known artists are kept for review instead of being automatically dropped.
   - `config/curation-overrides.json` is the durable manual correction file. It supports `drop_entry`, `replace_entry`, `reject_source`, `drop_video`, and `force_keep`, keyed by `videoId` plus stable source and row identity.
   - Non-song chapter rows, chat highlights, setup sections, channel metrics, custom emoji prefixes, and low-quality mixed comment timelines are filtered before write.
   - When one timestamp source already contains many explicit `song / artist` rows, remaining title-only rows from that same source are treated as timeline notes rather than songs and are dropped during generation and carry-forward.
   - Existing snapshots also pass through a front-end in-memory safety filter for high-confidence unknown-artist section markers such as waiting/ending/resume notes, stream sign-off catchphrases, and obvious ordinal title prefixes like `01|`, `10曲目`, or `3 01.`.
   - Long title-only lists are kept only when they look like a real setlist, such as a clear `縛り`/setlist theme.
   - A channel-first regional VTuber source blocklist runs before inspection, during carry-forward, before final merge, during derived-data rebuilds, and in the front-end as an in-memory safety filter for existing snapshots. Daily Song List mirrors the canonical list from `Marica7731/mygit` into `config/blocked-vtuber-channels.json`, then regenerates `assets/blocked-vtuber-meta.js` and `assets/blocked-vtuber-channels.js`; runtime payloads carry `blocklistVersion` and `blocklistHash` so stale data is re-filtered instead of trusted.
3. It writes:
   - `data/latest.json`
   - `data/7d.json`
   - `data/all.json`
   - `data/72h.json` and `data/1m.json` compatibility alias manifests
   - `data/ui/meta.json`
   - `data/ui/7d.<hash>.json`
   - `data/ui/all.<hash>.json`
   - `data/ui/7d.json` and `data/ui/all.json` as legacy compatibility files
   - `data/ui/ranges/<range>/manifest.<hash>.json` and `page-*.json`
   - `data/ui/source-details/<range>/manifest.<hash>.json` and `page-*.json`
   - `data/ui/search/<range>/manifest.<hash>.json` and `page-*.json`
   - `data/diff/latest-7d.json`
   - `data/diff/latest-all.json`
   - `data/audit.json`
   - `data/review/queue.json`
   - `data/review/sources/<videoId>-<sourceHash>.json`
   - `data/review/manifest.json`
   - `data/review/all-niche-unknown.json`
   - `data/review/all-niche-unknown.md`
   - `data/review/parser-corruptions.json`
   - `data/review/confirmed-noise.json`
   - `data/quality-report.json`
   - `data/snapshots/<hour>.json`
   - `data/snapshots/index/YYYY/MM.json`
   - `data/snapshots/index.json`
   - `data/status.json`
   - `data/latest.json`, `data/7d.json`, `data/all.json`, snapshots, and `data/audit.json` remain readable generation/review artifacts.
   - `data/ui/meta.json` is written last and points to content-hashed compact runtime range files plus sharded runtime, source-detail, and search manifests. `dataVersion` and range/shard `sha256` values bind the meta file to the exact payloads so the browser can reject mismatched or empty runtime data instead of rendering a normal empty page.
   - `data/ui/*.json` and `data/ui/**/page-*.json` are the compact browser runtime payloads. They keep only the fields the UI needs, use `seconds` to format timestamp labels, and carry `filterVersion`, `nicheAnnotated`, and `dataVersion` so current data can skip the front-end compatibility safety scan. The browser does not convert an invalid compact range into a large `data/latest.json` response.
   - The diff files compare latest ranks against the previous successful snapshot but are written in compact runtime form. Each `songRank` and `artistRank` entry keeps only `entityKey`, `rankDelta`, `countDelta`, and `isNew`; unchanged entries are omitted. `rankDelta` is `previousRank - currentRank`, so positive values mean the entity moved up and negative values mean it moved down.
   - `curationVersion` and `curationHash` are written into latest payloads, runtime meta, snapshots, and rank diff metadata. Rank diffs clean the previous snapshot in memory with the same current curation rules before comparing, so a new correction does not silently compare cleaned current data with dirty previous data.
   - The committed `7d`, `all`, partition, search-index, and snapshot-index UI proof cases cover the current runtime architecture and are checked with the screenshot manifest.
4. `index.html` + `assets/app.js` render the latest data and allow switching to an hourly snapshot.
   - Default view is song appearance ranking.
   - Artist ranking, song A-Z/kana-romaji sorting, and original video list views are available from the view tabs.
   - The VTuber channel view is channel-based: rows aggregate timestamped songs by source channel, merge same-name legacy rows that lack `channelId` into a known channel id/handle when the identity is unambiguous, and support both `按收录` and `按视频` ranking metrics.
   - Ranking rows place count and trend in a fixed right-side `rank-side` column. Song and song-index source previews now occupy a dedicated grid area spanning the content and right-side columns, grouped by unique source video.
   - Responsive ranking layout uses one maintained breakpoint system: mobile is `<=720px`, tablet is `721px-919px`, and desktop is `>=920px`. Mobile and tablet drawers render in-place below the current row, keep only one row expanded at a time, and use timestamp links whose visible text is only the time while the accessible label keeps song, artist, and channel context.
   - `FrontendUtils.sourcePresentationModel` inlines compact source videos by responsive proof contract: mobile 3+ rows show two inline sources, while desktop/tablet proof fixtures lock the 3-source layout. Inline sources render compact 16:9 video thumbnails without overlay text; the primary timestamp sits below the channel name in the source meta row and remains a jump link. Three or more source videos show a compact `查看全部来源`; one click renders the complete source list and the drawer toolbar provides `收起来源`. One-source rows no longer open drawers.
   - The unified query panel opens its shell before suggestions, recent searches, query indexes, or result-count previews run. Search input, recent searches, suggestions, and filters share one panel on mobile and desktop; there are no separate search/filter tabs. Search input updates only the draft query text, clear button, suggestions timer, and preview timer; IME composition does not rebuild the whole form on every intermediate character.
   - Each inline source includes a micro video thumbnail, channel link, timestamp meta link, optional extra-time toggle, and compact setlist-copy icon. Mobile rows keep the collapsed preview to two real inline sources and use a compact `查看全部来源` action for any 3+ source videos. Tablet and desktop proof fixtures lock the wider 3-source inline layout. The expanded source toolbar exposes the song-level copy action and the top collapse action.
   - Pagination uses one token model across songs, artists, song index, and videos. Numeric pagination uses non-clickable ellipsis markers; Web shows 30 items per page, H5/mobile shows 20, and mobile page controls use previous/input page/choose/next rather than a dropdown.
   - Initial load reads `data/ui/meta.json` first, then loads only the active range shard manifest and first page from `meta.ranges[range].shards.runtime`. It also reads `data/status.json` for the latest scheduler state. The static deploy workflow expands checkout from current shard manifests and explicitly excludes root-level full range JSON and legacy paths. A missing or invalid shard stops with a diagnostic error after one cache-reload retry; it never silently switches to a full range JSON or the large `data/latest.json` payload. Rank diff files load after the first榜单 render.
   - `debug=1` adds a read-only runtime panel with `dataVersion`, active range path, status fields, load-attempt diagnostics, and recent resource timings.
   - Initial load skips `song-search-known-songs.json` when payload songs already contain `isNiche`; older snapshots load that index only when niche annotation is missing. Current data with a supported `filterVersion` and matching blocklist hash skips the full front-end safety filter after loading only the tiny blocklist meta asset; older or historical payloads dynamically load `blocked-vtuber-channels.js` and `source-filter.js` before rendering.
   - Each range keeps derived occurrences, per-view lazy song records, per-view lazy artist records, video search data, and per-record `videoCount` in memory. Pagination and page-size changes reuse those records and only rebuild the visible page DOM. Prepared historical snapshots keep the existing 5-entry in-memory LRU cache, while immutable hourly snapshot JSON uses browser cache.
   - Ordinary interactions keep the address bar clean. Legacy inbound `shared=1` URLs are still parsed once and then removed from the visible URL, but the page no longer provides user-facing share or current-page link copy actions.
   - Unknown-artist rows are visible by default in song ranking, song index, and video views. The positive restrictive filter is `隐藏无歌手`; the URL writes `hideUnknown=1` only when the user explicitly hides them. Legacy inbound `showUnknown=1/0` URLs are parsed for compatibility, but new URLs never emit `showUnknown`. Artist ranking is intentionally unaffected and does not count this condition as an active chip.
   - Song ranking and song index summaries distinguish current visible videos from the range/catalog video directory with a compact `视频visible/source` metric when the source directory is available, while filter/search summaries fall back to the visible video count.
   - Video search keeps song-only matches visible before the fold. Rank views can switch between `按收录` and `按视频`, and latest song/artist ranks display movement from `data/diff`.
5. Public review UI is not shipped.
   - `scripts/build-review-queue.js` and `scripts/export-dirty-candidates.js` still generate `data/review/*` and `data/quality-report.json` for local or offline audit tooling.
   - The normal homepage does not load review data, raw comments, queue data, or GitHub credentials.
   - Dirty-candidate reports use review data file paths and raw hashes for定位; they do not generate public review-page links.
6. GitHub Actions are split by responsibility.
   - `.github/workflows/update-core.yml` runs hourly, builds only core data/runtime files, keeps core runs from cancelling each other, and writes failure status without treating local files as proof that the published runtime is healthy.
   - `.github/workflows/build-review.yml` builds review reports every 6 hours and cannot block the core hourly data update.
   - `.github/workflows/check-code.yml` runs tests and validation on code/workflow pushes.

`data/audit.json` is intentionally generated for review. It records inspected videos, rejected source reasons, rejected timestamp rows, and top channels producing non-song timestamp data.

See `docs/quality-review.md` for the full review queue schema, patch merge flow, rule promotion policy, and carry-forward behavior.

## Commands

```powershell
npm test
npm run update
npm run update:core
npm run review:build
npm run build:runtime
npm run blocklist:generate
npm run blocklist:validate
npm run blocklist:check-sync
node scripts/build-review-queue.js
node scripts/export-dirty-candidates.js
npm run rebuild:derived
node scripts/apply-curation-patch.js path/to/curation_patch.json
npm run validate
npm run validate:core
npm run validate:review
npm run check:budget
npm run check:published
npm run verify:local
npm run screenshots:readme
npm run version:assets
npm run check
python -m http.server 8080
```

Use `npm run build:runtime` rather than invoking `scripts/build-runtime-data.js` directly; the npm entry raises the Node heap for the large request-runtime model. `npm run check:budget` also covers DB/API request-runtime shards. `DAILY_SONG_REQUEST_SEARCH_SHARD_MAX_BYTES` caps generated `data/ui/ranges/*/search/page-*.json` payloads; keep it low enough that static fallback search never serves multi-megabyte surprise pages.

For visual acceptance screenshots, start the static server and pass a traceable tag:

```powershell
$env:CODEX_SCREENSHOT_TAG = (git rev-parse --short HEAD)
npm run verify:local -- http://127.0.0.1:8080/
```

Screenshots are written to `artifacts/h5-redesign/` and should not be committed.

For repository-homepage screenshots, run `npm run screenshots:readme -- <base-url>` and commit the refreshed files in `docs/assets/screenshots/`. This set should be updated with every shipped UI change so the README reflects the current deployed interface, while `artifacts/h5-redesign/` remains the disposable full acceptance output.

`npm run rebuild:derived` never fetches YouTube. It rereads local `data/latest.json` song `raw` fields with the current parser, reapplies durable curation rules and manual overrides, reuses local `data/song-search-known-songs.json`, rewrites `data/latest.json`, `data/7d.json`, `data/all.json`, legacy alias manifests, rank diffs, review reports, and compact `data/ui/*` plus sharded `data/ui/**` runtime files. Use it for parser/rule/report fixes that should update the current published dataset without changing the remote scrape input.

`scripts/sync-blocked-vtuber-channels.js --source <mygit>/config/blocked-vtuber-channels.json` updates the local mirror of the canonical regional VTuber blocklist. After syncing, run `npm run blocklist:generate`, `npm run blocklist:validate`, and `npm run rebuild:derived` so generated browser assets and runtime payload hashes all refer to the same list.

Useful environment variables:

- `DAILY_SONG_SEARCH_LIMIT`: maximum search results per keyword and source group, default `160`; GitHub Actions uses `500`.
- `DAILY_SONG_VIDEO_LIMIT`: maximum candidate videos to inspect, default `160`; GitHub Actions uses `160`.
- `DAILY_SONG_VIDEO_CONCURRENCY`: concurrent watch-page inspections, default `2`; GitHub Actions uses `1` to reduce YouTube 429 pressure.
- `DAILY_SONG_RECENT_BUCKET_LIMIT`: maximum candidates reserved for each recent bucket, default is based on `DAILY_SONG_VIDEO_LIMIT`; GitHub Actions uses `70`.
- `DAILY_SONG_MONTH_REFRESH_LIMIT`: maximum monthly-filter candidates to refresh when carry-forward is active, default is based on `DAILY_SONG_VIDEO_LIMIT`; GitHub Actions uses `20`.
- `DAILY_SONG_MONTH_BACKFILL_TARGET`: if carried monthly videos are below this target, prioritize monthly-filter candidates within the same inspection budget; default is `DAILY_SONG_VIDEO_LIMIT * 18`, and GitHub Actions uses `3000` so the 35-day catalog keeps filling instead of stopping after the first thousand usable videos.
- `DAILY_SONG_MONTH_BACKFILL_RECENT_BUCKET_LIMIT`: per-recent-bucket cap while monthly backfill is active, leaving more of `DAILY_SONG_VIDEO_LIMIT` for month-filter candidates; GitHub Actions uses `20`.
- `DAILY_SONG_MYGIT_TODAY_SNAPSHOTS`: set to `0`, `false`, `off`, or `no` to disable reading `Marica7731/mygit` today snapshots as an extra video discovery source; default enabled.
- `DAILY_SONG_MYGIT_RAW_BASE_URL`: raw GitHub base URL for the mygit repository, default `https://raw.githubusercontent.com/Marica7731/mygit/main`.
- `DAILY_SONG_MYGIT_TODAY_SNAPSHOT_DAYS`: lookback window for mygit today snapshots, default `35`; the actual range is capped by what `mygit/data/today-snapshots/index.json` currently retains.
- `DAILY_SONG_MYGIT_TODAY_SNAPSHOT_LIMIT`: maximum number of mygit today snapshots to read per update, default `35`; the updater selects at most one latest snapshot per retained day.
- `DAILY_SONG_CARRY_FORWARD_MAX_AGE_HOURS`: maximum age of the previous successful snapshot that can be used for carry-forward, default `36`.
- `DAILY_SONG_SEARCH_CONTINUATION_ROUNDS`: maximum YouTube search continuation requests per source, default `40`; GitHub Actions uses `120`.
- `DAILY_SONG_FETCH_RETRIES`: retry count for YouTube 429/5xx responses, default `3`.
- `DAILY_SONG_REQUEST_DELAY_MS`: minimum global delay between YouTube requests, default `0`; GitHub Actions uses `2500`.
- `DAILY_SONG_REQUEST_JITTER_MS`: extra random delay added to each YouTube request spacing, default `0`; GitHub Actions uses `1500`.
- `DAILY_SONG_429_COOLDOWN_MS`: cooldown after retryable YouTube 429 responses, default `15000`; GitHub Actions uses `60000`.
- `DAILY_SONG_RETRY_JITTER_MS`: extra random delay added after retryable YouTube responses, default `0`; GitHub Actions uses `5000`.
- `DAILY_SONG_MAX_429_ERRORS`: stop inspecting new videos after this many YouTube 429 responses, default `8`.
- `DAILY_SONG_COMMENT_REPLY_LIMIT`: max reply continuations, default `12`.
- `DAILY_SONG_SNAPSHOT_RETENTION_DAYS`: legacy compatibility knob; successful hourly snapshots are now kept permanently in the committed snapshot tree.
- `DAILY_SONG_INSPECTION_CACHE_RETENTION_DAYS`: retention for videos that were inspected but did not produce usable songs, default matches snapshot retention.
- `DAILY_SONG_INSPECTION_CACHE_FETCH_ERROR_TTL_HOURS`: short skip window for videos that recently failed inspection, default `6`.
- `DAILY_SONG_INSPECTION_CACHE_NO_USABLE_MIN_AGE_HOURS`: only skip videos with no usable setlist or no timestamp candidates after the video itself is at least this old, default `48`. This keeps just-ended streams eligible for later reinspection while avoiding repeated work on two-day-old videos that still have no usable setlist/progress comments.

The mygit today snapshot integration is a discovery layer only. It reads remote snapshot JSON files, dedupes candidate video IDs, and then lets daily-song-list fetch and parse the watch page, description, comments, curation rules, catalog merge, and ranking exactly as before. No mygit snapshot copies are stored in this repository, so daily-song-list does not need a separate cleanup job for those upstream snapshots.

## Link Rule

Song rows use canonical watch links with a seconds timestamp:

```text
https://www.youtube.com/watch?v=VIDEO_ID&t=123s
```

Embedded playback, if added later, should use YouTube embed URLs with `?start=<seconds>`.
