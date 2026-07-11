# Song-search Niche Labels and Pagination

This project uses page controls for long front-end lists and derives a `小众` label from the current `Marica7731/song-search` data source.

## Data Source

- Primary manifest: `https://marica7731.github.io/song-search/data/index.json`
- Fallback manifest: `https://raw.githubusercontent.com/Marica7731/song-search/main/data/index.json`
- Workflow reference: `https://github.com/Marica7731/song-search/actions/workflows/update.yml`

`scripts/song-search-index.js` downloads the manifest, fetches each listed `data/*.js` file, and extracts the JSON-like arguments inside `window.SONG_DATA.push(...)`. It does not execute remote JavaScript.

The generated local index is `data/song-search-known-songs.json`. It contains normalized title keys and title+artist keys. Manifest files that return 404 are skipped and recorded in `skippedFiles`.

## Niche Marking

`scripts/apply-song-search-niche.js` annotates generated song rows with:

```json
{
  "isNiche": true
}
```

A song is marked niche when neither its normalized title+artist key nor its normalized title key appears in `data/song-search-known-songs.json`.

`npm run update` now runs the existing YouTube update first, then applies the song-search niche annotation. `npm run refresh:song-search` refreshes only the local song-search index.

## Frontend Behavior

- `assets/app.js` reads `data/song-search-known-songs.json` beside `data/latest.json`.
- If a payload already has `isNiche`, the page uses it.
- If a payload does not have `isNiche`, the page annotates it in memory from the local index.
- The `只看小众` toggle filters rank, index, artist, and video views to niche songs.
- Long lists use page controls instead of the old `显示更多` button.

## Verification

```powershell
npm run refresh:song-search
npm run check
python -m http.server 8080
```
