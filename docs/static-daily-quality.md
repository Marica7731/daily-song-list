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

## Historical sweep

The builder reads *every* retained day shard, including the older June, July,
August, and September parts, not just the selected frontend range. It records
quarantined counts per original video's UTC publication date in
`quality-audit.json.byDay`. It also produces `quality-review.json`, a
**review-only** report of suspicious remaining titles/credits and description
hashes shared across two to four channels. Review-only candidates are not
automatically discarded. `static:validate` reconciles its day sums and
published occurrence totals so a partial scan cannot masquerade as a full sweep.

Confirmed older-row patterns now include `雑談パート` transitions, clearly
timestamped start-of-stream markers with no credited artist, and one specifically
corroborated spoken sentence where the parser split the fraction `1/3` into
a false artist. Do not turn these examples into generic short-title, slash,
date, or talk-word deletions: valid song names can use all of them.

## Safe credit normalization and real repetitions

Some legacy titles use the normal `title / artist` setlist syntax but the
parser retained the initial delimiter in the credited artist. The publication
layer now converts `/ 和田光司` to `和田光司` (also the full-width separator)
in generated rankings, full setlists and search without rewriting day shards.
It does not change slash-containing legitimate names such as `DISH//`.
`quality-audit.json.normalizedArtistOccurrences` counts corrected rows.

Do not deduplicate a song merely because one video sings it repeatedly. The
July 10 `勝利のマシンロボ100回歌唱耐久` video has 87 distinct timestamps for
the same song and they are genuine occurrences, not a scrape artifact.

## September 26 historical cleanup continuation

The latest completed full-history sweep (before this additional rule set)
reconciled 81 retained publication dates, 86,209 visible song occurrences,
298 quarantined non-song rows, and 381 purely cosmetic slash-prefix artist
credit repairs. These are the observed baseline, **not** a guaranteed count
for a later regenerated snapshot, because the hourly source queue continues.

Confirmed additional non-song patterns are narrowly tied to source-text
evidence: unrelated Japanese talk/news listings, worship livestream notices,
dated chat/stream promotions, timestamps that split dates into fictional
artists, explicit MC/talk/chat sections with their subject in parentheses,
and one technical comment about restarting YouTube. A genuine song named
`1/2`, `MC`, or `トーク` must not be dropped from its title alone.

When a source explicitly formats a real song as
`Song/Artist YYYY/MM/DD`, the date may have been wrongly split into the
displayed artist. The publication layer restores `Song - Artist` only for
unambiguous source-ending patterns; similarly, year-only `Song/Artist/YYYY`
requires just one slash. Ambiguous multi-slash improvised-song credits remain
review-only. `repairedDateCreditOccurrences` and
`repairedDateCreditExamples` record the repair evidence. All original
occurrences and daily source shards are preserved.

The static workflow allows at most three fetch/rebase/fast-forward push
attempts to resolve races with newer main commits, and rechecks that the
generated commit touches only the static-data root before every attempt.


## Full-history cleanup pass: mixed chapters, exact duplicates, and credit repairs

The all-history review also uncovered source-level corruption that broad title
heuristics cannot safely detect. The publication layer now has narrowly reviewed
rules for those exact source formats:

- Mixed karaoke chapter comments where real songs are explicitly numbered and
  conversational timestamps are not. The Maria Aikatsu source keeps all ten
  `♡ N.` song rows; the Claude/Kaelix DAM source keeps all eleven numbered
  song rows and removes the forty reaction/chat chapters.
- The reviewed three-channel `God Miracles Today 11:11` description hash is
  quarantined even though it is below the generic five-channel collision gate.
  The lower threshold is **not** applied globally.
- `MCパート(...)` and `間奏MC(...)` are removed only when the original
  row explicitly contains the parenthesized spoken topic.
- Exact duplicates are deduplicated only inside the same video when timestamp,
  normalized title, and normalized artist all agree. Repeats at different
  timestamps remain separate performances.

Credit cleanup is also derived-only. It strips unambiguous release dates/scoring
notes from artist fields, repairs `Song / Artist / Work / Year` records when the
work field proves the structure, restores a reviewed 岡村靖幸-only stream whose
album labels were parsed as artists, and repairs five undelimited Roboco setlist
credits from the exact reviewed source. Every repair is counted and sampled in
`quality-audit.json`.

None of these operations rewrites the retained `days/*` shards. The accounting
identity is now:

`inputOccurrences = visibleOccurrences + quarantinedOccurrences + deduplicatedOccurrences`

so a generated release cannot silently lose rows. Ambiguous candidates (for
example a plausible song whose artist happens to be `月`, or a long legitimate
character-song credit) stay review-only rather than being guessed away.


### Mixed-source review detector

The review artifact additionally groups rows by video and source hash. A source is
surfaced in `mixedStructuredSetlistSources` when it has at least eight parsed
rows, at least three unnumbered unknown-artist rows, and either three explicitly
numbered song rows or three known-artist rows. This detector is **review-only**:
it does not remove anything by itself. Its purpose is to expose short reaction
chapters that single-row length heuristics miss.

Release/work metadata normalization now also removes a bracketed work label when
it sits directly before an explicit release date, so e.g.
`Vaundy【王様ランキング】（2022/01/07）...` becomes `Vaundy` in the
derived ranking. Year-range structured credits and trailing delimiter artifacts
are repaired only where their original row proves the field boundaries.
