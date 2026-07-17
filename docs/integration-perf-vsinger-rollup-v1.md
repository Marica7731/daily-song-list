# perf-vsinger-rollup-v1 Integration Record

Integration branch: `integration/perf-vsinger-rollup-v1`

Started from `origin/main` at `ee8781f0ae436e64493719b76cadf44d2142d43b`.

## Branches

| Branch | BASE_SHA | HEAD SHA | Merge result | Integration notes |
| --- | --- | --- | --- | --- |
| `ops/update-freshness-v3` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `d0feb2db813f3cef0c2dbc220e32213004fcb7c2` | Merged with no textual conflicts | Keeps fast/backfill/watchdog status handling separated and avoids destructive restore of published runtime shards. |
| `data/vsinger-mcp-adapter-v1` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `d59c0b42a6df8583e0bffd4501c7e98100607610` | Merged with no textual conflicts | Adds bounded VSinger adapter tooling; package commands are wired as dry-run entry points. |
| `data/vsinger-enrichment-v1` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `1c421f2e01d109481428f4473dd5291a23509402` | Merged with no textual conflicts | Adds external alias/video candidate enrichment while keeping candidates separate from verified site records. |
| `perf/request-priority-v2` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `96ccbe9ba2700a9ec3c43a608bfdceebe4f9fa1e` | Merged with no textual conflicts | Scheduler is loaded before `assets/app.js` and now gates page, search, filter, source, setlist, range, snapshot, and idle prefetch requests. |
| `perf/source-entity-shards-v3` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `ce1e96cd1a54283d14df7d9f1c0f3355dcd4f8d8` | Merged with no textual conflicts | Runtime build now emits per-song source chunks only for records beyond inline preview size and no longer writes duplicate legacy source payload copies. |
| `ui/loading-experience-v3` | `01b178a78b06dc607fc9f6948e46b14262885f54` | `87e227e6a9a5d8218ca6b1b40c2826f440448361` | Merged with no textual conflicts | UI class/data/aria contracts are wired to real partial source loading, retry, setlist loading, and safe mobile states. |

## Conflict Resolution

There were no Git textual conflicts during the ordered `--no-ff` merges. Shared-file semantic integration was still required in `assets/app.js`, `scripts/build-runtime-data.js`, `package.json`, `README.md`, and runtime-data outputs so the independently merged branches exercised one request/data flow.

## Test And Validation Log

Final command results were recorded on 2026-07-17 after the integration fixes and final screenshot regeneration.

| Command | Result |
| --- | --- |
| `npm run version:assets` | Passed. Asset version `h5e71af9e06f4`. |
| `npm test` | Passed after regenerating stale screenshots. Final run: 298/298 passing. |
| `npm run test:scale` | Passed. 1/1 scale test passing. |
| `npm run check` | Passed. Syntax, UI proof, blocklist, tests, validation, and budgets passed. |
| `npm run screenshots:readme -- http://127.0.0.1:8080/` | Passed. 72 screenshots, proof input hash `ec58e1114ebe12d55494f2234a6e1e5a12dd5b000c1ef491f04b8fb9ef95bddb`. |
| `CODEX_SCREENSHOT_TAG=perf-vsinger-rollup-v1 npm run verify:local -- http://127.0.0.1:8080/` | Passed. Local screenshots written under `artifacts/h5-redesign/` with tag `perf-vsinger-rollup-v1`. |
| `npm run check:ui-proof` | Passed. `UI_PROOF_OK screenshots=72 proofInputHash=ec58e1114ebe12d55494f2234a6e1e5a12dd5b000c1ef491f04b8fb9ef95bddb`. |
| `npm run check` | Passed again as the final pre-commit gate. |
| `node scripts/benchmark-request-scheduler.js` | Passed. `no_scheduler_source_ms=349.2`, `scheduler_source_ms=62.2`, queue delay `1.2ms`, prefetch aborted, improvement `82.2%`. |
| `node scripts/benchmark-source-detail.js` | Passed. 100-source fixture: 5 chunks, first chunk 6,499 bytes raw, all chunks 32,535 bytes raw / 4,153 bytes gzip, max DOM 32. |

Notes:

- The first `npm test` after the final UI edits failed only because committed UI proof screenshots were stale. `npm run screenshots:readme` regenerated the formal screenshots and the final `npm test` and two `npm run check` runs passed.
- Local server for visual and performance verification: `http://127.0.0.1:8080/`.

## Performance Results

Old scheduler baseline vs integrated scheduler benchmark:

| Metric | Old | New |
| --- | ---: | ---: |
| Source request path, scheduler disabled | 349.2ms | - |
| Source request path, scheduler enabled | - | 62.2ms |
| Scheduler source queue delay | - | 1.2ms |
| Improvement | - | 82.2% |
| Adjacent-page prefetch behavior | Could compete with source work | Aborted/preempted under source work |

Source-detail shard benchmark:

| Fixture | Sources | Chunks | First chunk raw | All chunks raw | All chunks gzip | Max DOM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 sources | 20 | 1 | 6,498 bytes | 6,498 bytes | 1,072 bytes | 20 |
| 100 sources | 100 | 5 | 6,499 bytes | 32,535 bytes | 4,153 bytes | 32 |
| 150 sources | 150 | 8 | 6,499 bytes | 48,982 bytes | 6,283 bytes | 32 |
| Single video, 100 timepoints | 1 | 1 | 7,713 bytes | 7,713 bytes | 1,366 bytes | 1 |

Local UI proof and verify results:

- Source drawer open events in screenshot capture were 0.2-0.4ms, below the 100ms drawer-visible target.
- Query panel open events in screenshot capture were 42.1-76.5ms.
- `verify:local` first 7d render scenarios stayed below 50ms app init and below 45ms first-content/render-request in the sampled desktop viewports.
- `npm run check` budget output: `assets/app.js` raw 301,945 bytes / gzip 63,418 bytes; first-screen gzip 154,542 bytes.
- No per-song source request is near 1MB. The 150-source benchmark decompresses to 48,982 bytes total across all source chunks.

## Data Boundaries

VSinger/external enrichment remains candidate-only. It does not change site collection counts, does not create verified source records, keeps alias/known-song candidate provenance, leaves video candidates unverified, and keeps manual curation authoritative.

## Runtime Request Boundaries

The browser should not request complete `all` JSON, all page shards, all search shards, or all source shards on first paint. Page navigation requests only the target page, search requests only matching prefix shards, filters use compact indexes plus current-page detail shards, and source expansion requests only the opened song source chunks. Video setlists are loaded per button interaction.

Observed request boundaries from `verify:local`:

- 7d first screen requested `data/ui/meta.json`, status/snapshot index, 7d summary/diff, and the first current view page only.
- all fallback scenarios still exercise legacy fallbacks only when compact runtime validation is forced to fail.
- Source expansion requested only the current song's per-song source manifest/chunks, for example `data/ui/ranges/7d/sources/.../manifest.<hash>.json` followed by `chunk-0001...` and later chunks.
- Video setlist requests did not run during source expansion; setlists are fetched only from the copy/setlist interaction.
- Slow/prefetch scenarios did not request unrelated page/source shards while source work was user-visible.

## UI Screenshot Review

Formal screenshot run:

- Command: `npm run screenshots:readme -- http://127.0.0.1:8080/`
- Count: 72 PNG files under `docs/assets/screenshots/`
- Proof hash: `ec58e1114ebe12d55494f2234a6e1e5a12dd5b000c1ef491f04b8fb9ef95bddb`

Every formal screenshot was opened after regeneration. Covered scenes include desktop/tablet/mobile rank views, query panel alignment, compact empty suggestions, page/filter loading, request error retry, immediate/partial/complete/error source drawer states, setlist button loading, bottom safe area, source drawer bottom, and 320px pagination.

## VSinger Data Boundary

Confirmed by tests and package wiring:

- `vsinger:discover-schema` and `vsinger:import-song-catalog` are wired with `--dry-run`.
- Normal `npm run update` / `npm run update:core` does not trigger large external imports.
- External singing counts do not enter ranking or known-song outputs.
- Alias and known-song candidates retain provenance.
- Video candidates remain unverified and do not enter local catalog fields.
- Manual curation has priority over external enrichment.

## Actions Health

Actions and published data were checked from real GitHub/HTTP sources on 2026-07-17 23:31 +08.

- Latest core workflow run observed: `29591633757`, created 2026-07-17T15:19:29Z, still in progress at the query time.
- Previous core workflow success: `29585701992`, schedule run, created 2026-07-17T13:53:10Z and completed 2026-07-17T14:18:40Z. `Update compact runtime data`, `Commit core data or failure status`, and `Published runtime health check` were successful.
- Latest watchdog run observed: `29587145227`, schedule run, completed successfully at 2026-07-17T14:15:33Z with `Check published freshness` and `Summary` successful.
- Backfill workflow is active and isolated in `.github/workflows/update-backfill.yml` with its own `daily-song-list-backfill` concurrency group; no recent backfill run was returned in the sampled run list.
- Core update workflow uses separate `daily-song-list-core` concurrency and failure restore through `node scripts/run-core-update.js restore-after-failure`; static tests reject destructive `git restore` / `git clean` against permanent runtime shards.
- Published `https://ytb-song-rank.culua.com/data/status.json` returned HTTP 200, status `success`, `completedAt` 2026-07-17T14:10:04.834Z.
- Published `https://ytb-song-rank.culua.com/data/ui/meta.json` returned HTTP 200, status `success`, ranges `7d` and `all`, item counts 7d=1061 and all=1521, `capturedAt` 2026-07-17T14:10:04.834Z. At the query time the published data age was about 1h21m, below the 2h stale threshold.
- `npm run health:update` was attempted earlier but timed out locally, so the Actions health conclusion above uses GitHub Actions records plus published HTTP data, not that local timeout.
