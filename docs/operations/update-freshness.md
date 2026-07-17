# Update freshness operations

This branch keeps the existing fast update, backfill inbox, and freshness watchdog architecture. It does not add a second parallel publishing system.

## Goals

- Fast `update-core.yml` publishes fresh `7d/all` runtime data without waiting on heavy backfill work.
- Backfill writes immutable inbox bundles under `data/backfill-inbox` only.
- Fast updates may consume backfill bundle videos by `videoId` before runtime generation; repeated consumption is idempotent.
- Watchdog dispatches one fast compensation run for a stale published capture when no fast run is queued or in progress.
- Failure status preserves the last successful `dataCapturedAt` and records the failed attempt metadata.

## Entry points

- `.github/workflows/update-core.yml`: hourly fast data update, commit, push, and published runtime verification.
- `.github/workflows/update-backfill.yml`: daily backfill inbox bundle preparation.
- `.github/workflows/update-watchdog.yml`: published runtime freshness check and compensation dispatch.
- `scripts/analyze-update-health.js`: reads real GitHub Actions runs and writes `artifacts/update-health/report.json` and `report.md`.
- `scripts/run-core-update.js`: fast wrapper, watchdog freshness preflight, backfill inbox consumption, and tracked-output restore helper.
- `scripts/run-backfill-update.js`: immutable backfill bundle writer.
- `scripts/watchdog-update.js`: published freshness decision and `update-core.yml` dispatch.
- `scripts/mark-failure.js`: writes `data/status.json` for failed attempts.
- `scripts/check-published-runtime.js`: verifies Pages/CDN runtime content, hashes, manifests, bootstrap paths, and sample pages.

## Runbook

```bash
node scripts/analyze-update-health.js
node --test test/update-health.test.js
```

The analyzer requires authenticated `gh` access with repository Actions read permission. It queries `update-core.yml`, `update-backfill.yml`, and `update-watchdog.yml` runs directly from GitHub Actions. It does not infer freshness from commits.

The published check used by `update-core.yml` is:

```bash
npm run check:published -- https://ytb-song-rank.culua.com/ --expected-meta data/ui/meta.json
```

It verifies the published `dataVersion`, `capturedAt`, optional `dataCapturedAt`, manifest hashes, request bootstrap path, and sampled current page files. HTTP 200 alone is not treated as success.

## Failure handling

Core failures call:

```bash
node scripts/run-core-update.js restore-after-failure
npm run mark:failure
```

The restore helper only restores tracked core output paths. It does not run `git clean`, does not target `data/backfill-inbox`, and the failure commit stages only `data/status.json`.

`data/status.json` failure records include:

- previous successful `dataCapturedAt`
- failed `attemptedAt`
- `failureStage`
- `failureMessage`
- `runId`
- `runAttempt`
- `headSha`
- `mode`
- current `7d/all` item counts from groups, runtime meta, or last successful status

## Watchdog behavior

Watchdog triggers only when:

- published capture is missing or at least 75 minutes old;
- no `update-core.yml` run is `queued` or `in_progress`;
- no workflow-dispatch compensation already exists for the same stale published capture.

Outputs recorded in the workflow summary:

- `triggerReason`
- `sourceRunId`
- `previousCapturedAt`
- `ageMinutes`
- `dispatchedRunId`

## Push conflict behavior

The core workflow records the `origin/main` base before generation. If `origin/main` moves before commit, the workflow resets to the latest `origin/main` and regenerates data before committing. If push still races another data commit, the push step rebuilds against the latest `origin/main` before retrying.

Backfill push retries rebase only the inbox-only commit. Backfill does not stage runtime, catalog, status, UI shard, snapshot, or diff paths.
