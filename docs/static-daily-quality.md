# Static Pages: daily ranges and conservative data quality

This describes the **GitHub Pages static pipeline**, not the legacy VPS/API views.
The entry points are `index.html`, `assets/static-app.js`, and
`scripts/static/collect-and-build.js`.

## Ranges

- **今日**: from 00:00 Asia/Shanghai on the current calendar day.
- **近 3 天**: the current Shanghai calendar day and two preceding days, not rolling 72 hours.
- **近 7 天 / 近 30 天**: existing rolling windows, unchanged.
- **全部**: all retained history. Range metadata and each ranking's manifest must agree.

The frontend disables range tabs until their manifests are published. Ranked source
detail views and search-result counts must use the selected range as well.

## Data quality

`scripts/static/quality-guard.js` runs after loading day shards and before
generating rankings, entity detail pages, source pages, search indexes and meta.
It does **not** edit `days/*`, `state.json` or original imports.

High-confidence quarantine applies to:

- Date/day markers parsed as songs from an identifiable non-music rosary broadcast.
- A timestamped stream announcement/challenge result with a weekday wrongly parsed as its artist.
- An exact, corroborated non-musical Bible verse broadcast signature.
- The *same long source description hash* reused across >=5 unrelated videos,
  >=5 distinct channels, and >=4 distinct video titles, where the raw source
  text remains the same. This suggests source attachment/caching corruption.

Short, numeric, unknown-artist, foreign-language and natural-language song titles
**are not blanket exclusion rules**. For example, `1/2 - 川本真琴` survives.
Song/artist aliases require separate source-supported review, not this cleaner.

Any run where the new quality layer would quarantine more than 10% of incoming
occurrences **fails before publishing**. Review the generated
`data/static/v1/quality-audit.json` and the summary in `meta.json.quality`.
If a particular rule false-positively quarantines songs, adjust the quality rule
and rerun the builder: original day data is still available. Do not purge or
rewrite historical day shards to reconcile a ranking discrepancy.

A baseline spot check of September 19-25 source shards found 182 highly
suspicious occurrences out of 7,787: 172 rosary-broadcast timestamps, six dated
challenge results, three Bible-verse notices and one dated streaming announcement. This is a sample, **not** the total-site count.

Regression coverage: `node --test test/static-quality-ranges.test.js
test/static-github-pipeline.test.mjs`.
