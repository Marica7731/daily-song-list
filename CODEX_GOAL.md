# Selective source-backfill delivery goal

## Goal

- Deliver production-deduplicated accepted increments for the audited 31-source queue.
- Work only on `agent/source-backfill-selective-increments` in the G-drive worktree.
- Commit and push the feature branch; do not merge `main` or deploy.

## Current scope

- Batch A1: Monica, Shirazuna, toamall, Uzaki, and Sora extracted from existing complete artifacts.
- Batch A2: Ebakyouka with normalized channel handle and the current accepted cleaner.
- Quality quarantine: audit UCr full/fresh without importing both.
- Later selective work: Arale, KOTATSU, and UCw0ty from existing usable artifacts.
- Mac/self-hosted only if production still has a confirmed gap: Amanofu Stella, Kyoka, and Uten Hiyori.
- Rejected for this delivery: Kohana, Asax Mayo, and Laz.

## Constraints

- No Windows long crawl and no `--fresh`.
- Do not import a mixed batch wholesale.
- Do not put partial artifacts into production.
- Do not touch frontend files.
- Do not merge or deploy.

## Acceptance

- [ ] Each accepted file contains only video IDs absent from current production.
- [ ] Cleaner dry-run and time-field coverage are recorded per batch.
- [ ] UCr full/fresh overlap is audited and double import is prevented.
- [ ] Intended files only are committed.
- [ ] Feature branch is pushed.
- [ ] Remaining checkpoint work is explicitly documented.

## Current status

- GitHub `main`: `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`
- Production source commit: `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`
- Production built at: `2026-07-25T19:49:07Z`
- Batch A1 complete: 19 videos / 241 occurrences after production dedup and accepted cleanup.
- Batch A1 stable cleaner dry-run: 19 -> 19 videos, 241 -> 241 occurrences.
- Batch A1 commit/push complete: `dabb1b98` on `agent/source-backfill-selective-increments`.

## Checkpoint: A2 Ebakyouka

- Complete: exact production dedup selected 108 videos / 1498 occurrences from the existing 278-video accepted artifact.
- Complete: canonical channelId and `/@ebakyouka` handle normalization.
- Complete: cleaner write and stable dry-run produced 103 videos / 1476 occurrences with full timestamp/time/seconds coverage and 0 production overlap.
- Next: commit/push A2, then quarantine-audit UCr full versus fresh without importing both.
