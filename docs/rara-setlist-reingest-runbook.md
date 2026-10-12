# Rara standard setlist re-ingest runbook

This is the context-free entry point for auditing or rebuilding the Rara channel-setlist
import. Read it before dispatching discovery or changing
`data/static/v1/imports/rara-takanashi.json`.

The goal is not merely a green Actions run. Completion means a fully audited import,
generated static output, a Pages deployment, and matching raw-main and public checks.

## Quick start

1. Read `AGENTS.md`, this runbook, and `docs/youtube-channel-discovery.md`.
2. Record the current remote `main` commit and the live `meta.json` before changing anything.
3. Audit the existing import before running discovery:
   - `candidateCount == inspectedCount == auditCount`
   - `failedCount == 0`
   - `allCandidatesAccounted == true`
   - `videos.length == setlistVideoCount`
   - the sum of `videos[*].songs.length == occurrenceCount`
   - all four target videos have the expected song counts
4. Decide whether the existing checkpoint is safe to resume:
   - No artifact: run fresh.
   - Checkpoint produced by the current parser and schema: resume is allowed.
   - Checkpoint predates the parser repair or came from the stale import: force a new
     inspection. Never resume it merely because an artifact exists.
5. Dispatch `.github/workflows/discover-vtuber-streams.yml` on `main` with the immutable
   Rara identity below. Keep `DISCOVERY_TIMEOUT_SECONDS=18000` and
   `timeout-minutes=360`.
6. Poll with bounded `gh run view ... --json status,conclusion,jobs` probes of at most
   30 seconds. Do not use an unbounded `gh run watch` or an endless polling loop.
7. Run `check-code`, rebuild the static output, deploy Pages, and perform the raw-main and
   public acceptance checks in this document.
8. Record commit SHAs, run IDs, import SHA-256, counts, URLs, and residual risks in
   `AGENTS.md`.

A recoverable discovery or inspection error is an instruction to correct and dispatch
again. It is not a reason to mark the collection target blocked or failed. This no-block
rule does not override identity, capacity, raw-history integrity, security, or WDC storage
hard gates.

## Canonical identity and inputs

- Workflow: `.github/workflows/discover-vtuber-streams.yml`
- Channel ID: `UCLIEOGtrywxsLztMPPKtfkA`
- Handle: `@RaraTakanashi`
- Artifact slug: `rara-takanashi`
- URL: `https://www.youtube.com/@RaraTakanashi/streams`
- Import: `data/static/v1/imports/rara-takanashi.json`
- Keywords:
  `歌,弹唱,弾唱,弾き語,弹语,日语,日本語,live,karaoke,カラオケ`

`data/static/v1/imports/inspection-priority-ids.json` is a priority-video control file,
not a channel-setlist import. `readChannelSetlistImports()` must continue excluding it.
Otherwise the build fails with:

```text
unsupported channel setlist import: inspection-priority-ids.json
```

The channel-setlist import enters the generated `sources`, `entities`, `search`, and
ranking layers. It does not rewrite raw day shards.

## The two root causes

### 1. The old parser rejected valid structured lines

The reported videos contain standard full-width slash structured setlists. The old
title/artist split and topic/activity filtering could reject most rows, leaving only one
or two songs per video. The pre-repair result was:

| Video | Expected | Before |
| --- | ---: | ---: |
| `9TSHn43ttmc` | 11 | 2 |
| `QS2ePMOPgzQ` | 10 | 1 |
| `ZbO6Smsa69k` | 16 | 5 |
| `srlj9HE3kJ4` | 12 | 4 |

The recovered parser must preserve structured rows while still excluding obvious OP, ED,
greeting, and activity rows. Do not "fix" low counts by relaxing every risk rule; verify
the exact target counts and inspect rejected entries.

### 2. Discovery resumed a stale artifact

The workflow automatically downloads the newest compatible
`vtuber-streams-rara-takanashi-*` artifact unless force mode is active. Its
`checkpoint.json` marks every candidate complete, so a later run can skip the old
inspection results, update only source identity fields, and export the old song detail
again.

A resume is safe only when the checkpoint already reflects the current parser and schema.
For a parser repair or a stale import, force reinspection.

`FORCE_REINSPECT` is not a normal workflow-dispatch input. The workflow derives it from a
push head commit containing `[force-rara-reinspect]`. A forced run must show:

```text
VTUBER_FORCE_REINSPECT enabled
```

It must not show `VTUBER_RESUME_OK` for an older artifact. Make only a reviewed, scoped
change to `.github/workflows/discover-vtuber-streams.yml` when this trigger is required.

## Performance and timeout policy

The current discovery budget is intentionally the maximum supported job budget:

- `DISCOVERY_TIMEOUT_SECONDS=18000` (5 hours)
- GitHub job `timeout-minutes=360`
- 297 candidates gives `18000 / 297 = 60.6` seconds per candidate

Do not start a large re-ingest with guessed 1.5-hour or 3-hour limits. Estimate from
measured throughput before reducing any deadline:

```text
estimated_remaining_seconds = elapsed_seconds / inspected_count
                              * remaining_count
                              * safety_factor
```

Use at least a 2x safety factor for YouTube throttling, retries, page discovery, and
artifact upload. Raising a timeout is a valid performance fix. Hitting a timeout is a
signal to estimate, correct, and dispatch again, not a terminal outcome.

Every local or remote probe must have a bounded timeout:

- normal inspection: 10-30 seconds
- tests: about 60 seconds
- GitHub/API/HTTP probe: at most 30 seconds
- discovery: fixed 5-hour workflow budget

Never perform an unbounded wait.

## Non-blocking publication behavior

Commit `8eaee92db004b628aca5a4821cb75c3c1f00b0bc` changed the static collector so an
entirely failed inspection batch no longer throws before publication:

```text
batch_degraded attempted=... failed=...; continuing with last successful state
```

The collector then:

- retains the last successful static state;
- records each error in `state.lastFailures`;
- continues through build and validation;
- allows commit and Pages publication to proceed.

A `batch_degraded` line is not permission to hide data errors. Preserve it as evidence and
continue diagnosis or dispatch another bounded pass. Regression coverage lives in
`test/static-github-pipeline.test.mjs`.

GitHub concurrency cancellation is also not automatically data loss. Confirm which job
actually executed the static build, commit, and Pages steps before treating cancellation
as failure.

## Re-ingest procedure

1. Read the current import and calculate its SHA-256. Save the current `main` SHA.
2. Compare the four target counts and the aggregate summary with the acceptance values
   below.
3. Inspect discovery logs/artifact metadata for `VTUBER_RESUME_OK`,
   `VTUBER_FORCE_REINSPECT`, checkpoint coverage, and `inspectedInLatestRun`.
4. Force reinspection when the checkpoint is stale. Otherwise dispatch a normal fresh or
   resumable run.
5. Keep all workflow inputs at the reviewed Rara identity. Do not substitute a handle,
   URL, channel ID, or display name from a title string.
6. Wait only through bounded status probes. Continue correcting and redispatching
   recoverable failures.
7. The workflow must export only `data/static/v1/imports/rara-takanashi.json`, rebase onto
   latest `main`, and verify that this is the sole changed path.
8. Run `check-code`. Run static update/build and `static:validate`.
9. Deploy Pages.
10. Perform all raw-main and public checks below. Record evidence before completion.

The workflow's own export gate requires:

```text
kind == channel-setlists
schemaVersion == 1
allCandidatesAccounted == true
inspectedCount == candidateCount
failedCount == 0
videos.length == setlistVideoCount
audits.length == candidateCount
sum(video.songs.length) == occurrenceCount
```

## Acceptance values for the completed repair

These are historical evidence for the completed 2026-10-07 re-ingest, not values to force
on later runs that legitimately add videos:

- candidates/audits: `297/297`
- setlist videos: `288`
- occurrences: `3364`
- no-song videos: `9`
- failed: `0`
- target songs: `11/10/16/12`
- import SHA-256:
  `d17d4f8614fd9627a0e9c030c635d839cf0b3659befdd5d5e12ad5e0abac5410`
- import bytes: `5464664`

The stale pre-repair state was `297` candidates, `266` setlist videos, `1839`
occurrences, `31` no-song videos, and target counts `2/1/5/4`.

Historical delivery evidence:

- `check-code` run `37554009229` succeeded for
  `8eaee92db004b628aca5a4821cb75c3c1f00b0bc`.
- Pages run `37554376137` succeeded.
- Stale discovery run `37542489722` was cancelled so its old checkpoint could not
  overwrite the import.
- At acceptance, live `meta.json` had
  `generatedAt=2026-10-07T00:42:53.189Z`,
  `sourceSnapshotId=20261007T001125Z`, `videoCount=12737`, and
  `songOccurrenceCount=170524`.
- At acceptance, search had `16` shards and `71837` items; ranking `all` had `48877`
  total songs across `978` pages.
- Homepage, meta, import, source, entity, search, ranking, and raw-day HTTP checks were
  all `200`.

Aggregate ranking and search totals change on later runs. Validate their manifests and
internal counts at the time of each release instead of requiring these historical totals
forever.

## Online acceptance

Use the public Pages URL and raw `main` independently. Add a cache-busting query when
checking HTML or `meta.json`; GitHub Pages CDN can briefly serve an older object.

```bash
BASE='https://marica7731.github.io/daily-song-list'
RAW='https://raw.githubusercontent.com/Marica7731/daily-song-list/main'
STAMP="$(date -u +%Y%m%d%H%M%S)"

curl -fsS --max-time 30 -o /dev/null -w '%{http_code}\n' "$BASE/?cache-bust=$STAMP"
curl -fsS --max-time 30 -o /dev/null -w '%{http_code}\n' \
  "$BASE/data/static/v1/meta.json?cache-bust=$STAMP"
curl -fsS --max-time 30 -o /dev/null -w '%{http_code}\n' \
  "$BASE/data/static/v1/imports/rara-takanashi.json?cache-bust=$STAMP"

curl -fsS --max-time 30 "$RAW/data/static/v1/imports/rara-takanashi.json" |
  shasum -a 256
```

Required public resources:

- homepage and cache-busted `meta.json`
- `imports/rara-takanashi.json`
- all four target `sources/**/<videoId>.json` files
- `entities/vtubers/42fdf086631f2494.json`
- search manifest and every referenced shard
- `rankings/all/songs/manifest.json` and referenced pages
- the relevant raw day shard

For the main Rara entity, count occurrences grouped by video ID and require:

```text
9TSHn43ttmc = 11
QS2ePMOPgzQ = 10
ZbO6Smsa69k = 16
srlj9HE3kJ4 = 12
```

Also compare the Pages import SHA-256 with raw `main`; they must match. A green workflow
without these public checks is not release evidence.

## Raw-day boundary

Rara channel-import content is accepted in the generated layers:
`sources`, `entities`, `search`, and rankings. It is not a reason to rewrite
`data/static/v1/days/2026-07-07/part-0001.json`.

The raw day can legitimately contain zero songs for these channel-import videos. A zero
count there does not prove the channel import failed. Conversely, do not edit or pad raw
history to make an acceptance probe pass. Raw history stays immutable.

## Recovery rules

- Import is stale or parser changed: force reinspection; never resume the old checkpoint.
- Discovery times out after partial progress: inspect checkpoint provenance, then resume
  only if it was produced by the current parser, otherwise force again.
- All static inspections fail: keep `batch_degraded`, retain `lastFailures`, rebuild from
  the last successful state, and dispatch a corrected pass.
- Import validation fails: fix the parser/exporter/test first; do not hand-edit counts.
- `inspection-priority-ids.json` is rejected: fix the import-directory filter.
- Actions cancels in a shared concurrency group: verify which run actually built, committed,
  and deployed before deciding whether another run is required.
- Pages shows old meta: cache-bust and compare with raw `main`.
- Any residual data concern: record it and continue diagnosis. Do not convert a recoverable
  error into a blocked goal.

## Residual risk: duplicate channel entity

The same `channelId` can still split into two entities when historical `channelName`
values differ:

- Primary `42fdf086631f2494`: contains the four target videos with `11/10/16/12`.
- Alias `b3e83d61df92ec93`: approximately `304` occurrences across `24` videos and does
  not contain the four targets.

This identity normalization issue was not expanded into the re-ingest change. Treat it as
a separate residual risk; do not move or delete occurrences without a reviewed identity
migration.
