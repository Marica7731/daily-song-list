# Daily Song List

Small GitHub Pages site that collects YouTube videos with usable timestamp song lists, then exposes jump links for two ranges:

- `72h`: videos published within the last 72 hours.
- `1m`: videos in the monthly carry-forward window that were returned by YouTube's monthly search filter.

The site keeps one successful snapshot per hour. If a scheduled scrape fails, existing `data/latest.json` and snapshot files remain untouched, so the page continues to show the last successful result.

## How it Works

1. `scripts/update-songlist.js` fetches YouTube search pages for `歌枠` and `弾き語り` using the same `today` and `month` filter URLs used by `Marica7731/mygit`.
   - Search pages are expanded through YouTube search continuation requests, matching the ranking project's "scroll until more results are loaded" behavior without requiring a browser in GitHub Actions.
   - When the previous successful snapshot is fresh, already inspected videos are carried forward and skipped. The `72h` and `1m` views keep separate source membership: a recent video enters `1m` only when it also came from the monthly search filter. The new inspection queue usually scans today's and one-day-old candidates, then refreshes a small number of monthly-filter candidates. If carried monthly results are below the backfill target, the queue reserves less of the inspection budget for recent-only videos and fills the remaining budget from monthly-filter candidates first.
   - If the previous successful snapshot is missing or too old, the script falls back to a full recovery queue covering today's, one-day-old, and two-day-old candidates before filling the remaining budget with monthly-filter candidates.
2. It fetches each candidate watch page, extracts description and first comment continuations, parses timestamped song lists, and skips videos without usable songs.
   - Non-song chapter rows, chat highlights, setup sections, channel metrics, custom emoji prefixes, and low-quality mixed comment timelines are filtered before write.
   - When one timestamp source already contains many explicit `song / artist` rows, remaining title-only rows from that same source are treated as timeline notes rather than songs and are dropped during generation and carry-forward.
   - Existing snapshots also pass through a front-end in-memory safety filter for high-confidence unknown-artist section markers such as waiting/ending/resume notes, stream sign-off catchphrases, and obvious ordinal title prefixes like `01|`, `10曲目`, or `3 01.`.
   - Long title-only lists are kept only when they look like a real setlist, such as a clear `縛り`/setlist theme.
   - A channel-first Taiwan/HK VTuber source blacklist runs before inspection, during carry-forward, before final merge, and in the front-end as an in-memory safety filter for existing snapshots. Maintain it in `TAIWAN_VTUBER_BLACKLIST` in `assets/source-filter.js`; add channel names and stable aliases first, and only add title aliases for exact hashtags or strong source markers.
3. It writes:
   - `data/latest.json`
   - `data/72h.json`
   - `data/1m.json`
   - `data/diff/latest-72h.json`
   - `data/diff/latest-1m.json`
   - `data/audit.json`
   - `data/snapshots/<hour>.json`
   - `data/snapshots/index.json`
   - `data/status.json`
   - The diff files compare the latest generated ranks against the previous successful snapshot from `data/snapshots/index.json`. Each range includes `songRank` and `artistRank` entries with `entityKey`, previous/current rank, rank delta, previous/current count, count delta, and `isNew`. `rankDelta` is `previousRank - currentRank`, so positive values mean the entity moved up and negative values mean it moved down.
4. `index.html` + `assets/app.js` render the latest data and allow switching to an hourly snapshot.
   - Default view is song appearance ranking.
   - Artist ranking, song A-Z/kana-romaji sorting, and original video list views are available from the view tabs.
   - Ranking rows preview one primary source channel inline; `+N 来源` opens the source drawer with every matching timestamp link.
   - Initial load skips `song-search-known-songs.json` when payload songs already contain `isNiche`; older snapshots load that index only when niche annotation is missing. Prepared snapshots are kept in a small in-memory LRU cache, while immutable hourly snapshot JSON uses browser cache.
   - URL state omits defaults, uses browser history for range/view/page/snapshot changes, and keeps search typing on `replaceState`. Song index bucket params are written only for the song index view.
   - Video search keeps song-only matches visible before the fold. Rank views can switch between `按收录` and `按视频`, and latest song/artist ranks display movement from `data/diff`.
5. `.github/workflows/update-songlist.yml` runs hourly and commits only data changes.

`data/audit.json` is intentionally generated for review. It records inspected videos, rejected source reasons, rejected timestamp rows, and top channels producing non-song timestamp data.

## Commands

```powershell
npm test
npm run update
npm run validate
npm run check
python -m http.server 8080
```

Useful environment variables:

- `DAILY_SONG_SEARCH_LIMIT`: maximum search results per keyword and source group, default `160`; GitHub Actions uses `500`.
- `DAILY_SONG_VIDEO_LIMIT`: maximum candidate videos to inspect, default `160`; GitHub Actions uses `160`.
- `DAILY_SONG_VIDEO_CONCURRENCY`: concurrent watch-page inspections, default `2`; GitHub Actions uses `1` to reduce YouTube 429 pressure.
- `DAILY_SONG_RECENT_BUCKET_LIMIT`: maximum candidates reserved for each recent bucket, default is based on `DAILY_SONG_VIDEO_LIMIT`; GitHub Actions uses `70`.
- `DAILY_SONG_MONTH_REFRESH_LIMIT`: maximum monthly-filter candidates to refresh when carry-forward is active, default is based on `DAILY_SONG_VIDEO_LIMIT`; GitHub Actions uses `20`.
- `DAILY_SONG_MONTH_BACKFILL_TARGET`: if carried monthly videos are below this target, prioritize monthly-filter candidates within the same inspection budget; GitHub Actions uses `320`.
- `DAILY_SONG_MONTH_BACKFILL_RECENT_BUCKET_LIMIT`: per-recent-bucket cap while monthly backfill is active, leaving more of `DAILY_SONG_VIDEO_LIMIT` for month-filter candidates; GitHub Actions uses `20`.
- `DAILY_SONG_CARRY_FORWARD_MAX_AGE_HOURS`: maximum age of the previous successful snapshot that can be used for carry-forward, default `36`.
- `DAILY_SONG_SEARCH_CONTINUATION_ROUNDS`: maximum YouTube search continuation requests per source, default `40`; GitHub Actions uses `120`.
- `DAILY_SONG_FETCH_RETRIES`: retry count for YouTube 429/5xx responses, default `3`.
- `DAILY_SONG_REQUEST_DELAY_MS`: minimum global delay between YouTube requests, default `0`; GitHub Actions uses `750`.
- `DAILY_SONG_429_COOLDOWN_MS`: cooldown after retryable YouTube 429 responses, default `15000`.
- `DAILY_SONG_MAX_429_ERRORS`: stop inspecting new videos after this many YouTube 429 responses, default `8`.
- `DAILY_SONG_COMMENT_REPLY_LIMIT`: max reply continuations, default `12`.
- `DAILY_SONG_SNAPSHOT_RETENTION_DAYS`: hourly snapshot retention, default `35`.

## Link Rule

Song rows use canonical watch links with a seconds timestamp:

```text
https://www.youtube.com/watch?v=VIDEO_ID&t=123s
```

Embedded playback, if added later, should use YouTube embed URLs with `?start=<seconds>`.
