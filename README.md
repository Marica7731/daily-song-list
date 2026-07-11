# Daily Song List

Small GitHub Pages site that collects YouTube videos with usable timestamp song lists, then exposes jump links for two ranges:

- `72h`: videos published within the last 72 hours.
- `1m`: videos returned by YouTube's monthly search filter.

The site keeps one successful snapshot per hour. If a scheduled scrape fails, existing `data/latest.json` and snapshot files remain untouched, so the page continues to show the last successful result.

## How it Works

1. `scripts/update-songlist.js` fetches YouTube search pages for `歌枠` and `弾き語り` using the same `today` and `month` filter URLs used by `Marica7731/mygit`.
   - Search pages are expanded through YouTube search continuation requests, matching the ranking project's "scroll until more results are loaded" behavior without requiring a browser in GitHub Actions.
   - The inspection queue reserves slots for today's, one-day-old, and two-day-old candidates before filling the remaining budget with monthly-filter candidates.
2. It fetches each candidate watch page, extracts description and first comment continuations, parses timestamped song lists, and skips videos without usable songs.
   - Non-song chapter rows, chat highlights, setup sections, channel metrics, custom emoji prefixes, and low-quality mixed comment timelines are filtered before write.
   - Long title-only lists are kept only when they look like a real setlist, such as a clear `縛り`/setlist theme.
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
- `DAILY_SONG_VIDEO_LIMIT`: maximum candidate videos to inspect, default `160`; GitHub Actions uses `240`.
- `DAILY_SONG_VIDEO_CONCURRENCY`: concurrent watch-page inspections, default `2`; GitHub Actions uses `2`.
- `DAILY_SONG_RECENT_BUCKET_LIMIT`: maximum candidates reserved for each 0-24h, 24-48h, and 48-72h bucket, default is based on `DAILY_SONG_VIDEO_LIMIT`; GitHub Actions uses `80`.
- `DAILY_SONG_SEARCH_CONTINUATION_ROUNDS`: maximum YouTube search continuation requests per source, default `40`; GitHub Actions uses `120`.
- `DAILY_SONG_FETCH_RETRIES`: retry count for YouTube 429/5xx responses, default `3`.
- `DAILY_SONG_COMMENT_REPLY_LIMIT`: max reply continuations, default `12`.
- `DAILY_SONG_SNAPSHOT_RETENTION_DAYS`: hourly snapshot retention, default `35`.

## Link Rule

Song rows use canonical watch links with a seconds timestamp:

```text
https://www.youtube.com/watch?v=VIDEO_ID&t=123s
```

Embedded playback, if added later, should use YouTube embed URLs with `?start=<seconds>`.
