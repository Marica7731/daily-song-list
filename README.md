# Daily Song List

Small GitHub Pages site that collects YouTube videos with usable timestamp song lists, then exposes jump links for two ranges:

- `72h`: videos published within the last 72 hours.
- `1m`: videos published within roughly the last month.

The site keeps one successful snapshot per hour. If a scheduled scrape fails, existing `data/latest.json` and snapshot files remain untouched, so the page continues to show the last successful result.

## How it Works

1. `scripts/update-songlist.js` fetches YouTube search pages for `歌枠` and `弾き語り` using the same month-filter search URLs used by the existing ranking project.
2. It fetches each candidate watch page, extracts description and first comment continuations, parses timestamped song lists, and skips videos without usable songs.
3. It writes:
   - `data/latest.json`
   - `data/72h.json`
   - `data/1m.json`
   - `data/snapshots/<hour>.json`
   - `data/snapshots/index.json`
   - `data/status.json`
4. `index.html` + `assets/app.js` render the latest data and allow switching to an hourly snapshot.
5. `.github/workflows/update-songlist.yml` runs hourly and commits only data changes.

## Commands

```powershell
npm test
npm run update
npm run validate
npm run check
python -m http.server 8080
```

Useful environment variables:

- `DAILY_SONG_SEARCH_LIMIT`: maximum search results per keyword, default `36`.
- `DAILY_SONG_VIDEO_LIMIT`: maximum candidate videos to inspect, default `36`.
- `DAILY_SONG_COMMENT_REPLY_LIMIT`: max reply continuations, default `12`.
- `DAILY_SONG_SNAPSHOT_RETENTION_DAYS`: hourly snapshot retention, default `35`.

## Link Rule

Song rows use canonical watch links with a seconds timestamp:

```text
https://www.youtube.com/watch?v=VIDEO_ID&t=123s
```

Embedded playback, if added later, should use YouTube embed URLs with `?start=<seconds>`.
