# Song-search Library Outside Labels and Pagination

This project uses page controls for long front-end lists and derives a `曲库外`
label from the current `Marica7731/song-search` data source.

`曲库外` means the song was not matched in the known song-search library. It only
means the library has not collected that normalized song key yet; it does not
represent play count, popularity, or how well-known the song is.

## Data Source

- Primary manifest: `https://marica7731.github.io/song-search/data/index.json`
- Fallback manifest: `https://raw.githubusercontent.com/Marica7731/song-search/main/data/index.json`
- Workflow reference: `https://github.com/Marica7731/song-search/actions/workflows/update.yml`

`scripts/song-search-index.js` downloads the manifest, fetches each listed
`data/*.js` file, and extracts the JSON-like arguments inside
`window.SONG_DATA.push(...)`. It does not execute remote JavaScript.

The generated local index is `data/song-search-known-songs.json`. It contains
normalized title keys and title+artist keys. Manifest files that return 404 are
skipped and recorded in `skippedFiles`.

## Library Outside Marking

The generated payload still uses the existing internal compatibility field:

```json
{
  "isNiche": true
}
```

Do not rename this field or the existing `scripts/apply-song-search-niche.js`
script unless the JSON schema and every consumer are migrated together. The
front-end label for this state is `曲库外`.

A song is marked `曲库外` when neither its normalized title+artist key nor its
normalized title key appears in `data/song-search-known-songs.json`.

`npm run refresh:song-search` refreshes only the local song-search index. The
normal data update flow applies the library-outside annotation after the YouTube
update step.

## Frontend Behavior

- `assets/app.js` reads `data/song-search-known-songs.json` beside
  `data/latest.json`.
- If a payload already has `isNiche`, the page uses it.
- If a payload does not have `isNiche`, the page annotates it in memory from the
  local index.
- The visible filter is `只看曲库外`, with help text explaining that this only
  means song-search has not collected the song.
- The filter applies to rank, index, artist, and video views.
- Long rank, index, and video lists use page controls. URL state keeps the
  active range, view, page, page size, index bucket, search text, snapshot, and
  library-outside filter so a filtered page can be reopened or shared.
- Ranking rows preview one primary source inline. When more sources exist, the
  `+N 来源` control stays fully visible and opens the source drawer containing
  every matching timestamp link.

## Verification

For front-end-only changes, do not run `npm run update`.

```powershell
npm run check
python -m http.server 8080
```
