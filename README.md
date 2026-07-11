# Daily Song List

Small GitHub Pages site that collects YouTube videos with usable timestamp song lists, then exposes jump links for two ranges:

- `72h`: videos published within the last 72 hours.
- `1m`: videos returned by YouTube's monthly search filter.

The site keeps one successful snapshot per hour. If a scheduled scrape fails, existing `data/latest.json` and snapshot files remain untouched, so the page continues to show the last successful result.

## How it Works

1. `scripts/update-songlist.js` fetches YouTube search pages for `歌枠` and `弾き語り` using the same `today` and `month` filter URLs used by `Marica7731/mygit`.
   - Search pages are expanded through YouTube search continuation requests, matching the ranking project's "scroll until more results are loaded" behavior without requiring a browser in GitHub Actions.
   - When the previous successful snapshot is fresh, already inspected videos are carried forward and skipped. The new inspection queue scans only today's and one-day-old candidates, then refreshes a small number of monthly-filter candidates.
   - If the previous successful snapshot is missing or too old, the script falls back to a full recovery queue covering today's, one-day-old, and two-day-old candidates before filling the remaining budget with monthly-filter candidates.
2. It fetches each candidate watch page, extracts description and first comment continuations, parses timestamped song lists, and skips videos without usable songs.
   - Non-song chapter rows, chat highlights, setup sections, channel metrics, custom emoji prefixes, and low-quality mixed comment timelines are filtered before write.
   - Long title-only lists are kept only when they look like a real setlist, such as a clear `縛り`/setlist theme.
   - A channel-first Taiwan/HK VTuber source blacklist runs before inspection, during carry-forward, before final merge, and in the front-end as an in-memory safety filter for existing snapshots. Maintain it in `TAIWAN_VTUBER_BLACKLIST` in `assets/source-filter.js`; add channel names and stable aliases first, and only add title aliases for exact hashtags or strong source markers.
3. It writes:
   - `data/latest.json`
   - `data/72h.json`
   - `data/1m.json`
   - `data/audit.json`
   - `data/snapshots/<hour>.json`
   - `data/snapshots/index.json`
   - `data/status.json`
4. `index.html` + `assets/app.js` render the latest data and allow switching to an hourly snapshot.
   - Default view is song appearance ranking.
   - Artist ranking, song A-Z/kana-romaji sorting, and original video list views are available from the view tabs.
   - Ranking rows preview one primary source channel inline; `+N 来源` opens the source drawer with every matching timestamp link.
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
