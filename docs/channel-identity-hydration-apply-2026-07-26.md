# Channel identity hydration application — 2026-07-26

## Outcome

`scripts/apply-channel-identity-hydration.js` turns the merged channel identity
audit into a reviewable, idempotent metadata application plan.

- Default mode is dry-run.
- Metadata writes require both `--apply-metadata` and the exact
  `--confirm-apply WRITE_CHANNEL_METADATA` confirmation.
- Apply mode also requires `--expected-deliverable-count`, and rejects partial
  shard reports.
- Only `high-confidence + review_then_hydrate` candidates are eligible.
- Felicia is hard-excluded by disposition plus its strong channel ID/handle;
  its display name is not treated as identity evidence.
- Ambiguous and unresolved queues are always skipped.
- Existing metadata is matched only by channel ID or canonical handle.
  Display names are never identity keys for updates.
- Existing non-empty fields are preserved. Only missing identity fields are
  filled.
- A channel ID/handle conflict is reported and skipped without overwriting the
  existing entry.

## Usage

Dry-run against the current metadata:

```bash
node scripts/apply-channel-identity-hydration.js \
  --candidates /mnt/g/codex-work/.codex-tmp/channel-hydration-audit/results/candidates-full.json \
  --metadata data/external/youtube-channel-discovery/channel-metadata.json \
  --output-dir /mnt/g/codex-work/.codex-tmp/channel-hydration-apply/final-dry-run \
  --expected-deliverable-count 492
```

Explicit application after reviewing the dry-run report:

```bash
node scripts/apply-channel-identity-hydration.js \
  --candidates /mnt/g/codex-work/.codex-tmp/channel-hydration-audit/results/candidates-full.json \
  --metadata data/external/youtube-channel-discovery/channel-metadata.json \
  --output-dir /mnt/g/codex-work/.codex-tmp/channel-hydration-apply/apply \
  --expected-deliverable-count 492 \
  --apply-metadata \
  --confirm-apply WRITE_CHANNEL_METADATA
```

Each run emits:

- `apply-report.json`: before/after hashes and counts, per-candidate changes,
  conflicts, and skips.
- `apply-report.md`: operator-readable summary.
- `generated-entries.json`: only the canonical new entries in the existing
  `channel-metadata.json` entry shape.

## Full 492-candidate dry-run

Input:

- Merged audit source commit:
  `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`.
- High-confidence rows: 493.
- Eligible after Felicia exclusion: 492.
- Existing metadata entries: 664, all with complete ID/handle/URL identity.
- Metadata SHA-256 before and after dry-run:
  `3816232247e802edbd0f239399b6c07d1124f553dc8211e91cadc74f9f967d7c`.

Result:

| Result | Count |
| --- | ---: |
| New canonical metadata entries | 486 |
| Existing complete entries preserved | 4 |
| Duplicate candidate identities consolidated | 2 |
| Existing entries with fields filled | 0 |
| Strong-identity conflicts | 0 |
| Invalid candidates | 0 |
| Felicia excluded | 1 |
| Ambiguous skipped | 2 |
| Unresolved skipped | 2 |
| Changed entries if applied | 486 |
| Metadata entries after application | 1,150 |

The two duplicate candidate identities are:

1. `Rieru Ch. 我部りえる / あおぎり高校`, which resolves to the same
   `UCyY6YeINiwQoA-FnmdQCkug` / `/@chiyomi0812` identity as another
   candidate group.
2. `ヴェルモット・ベルーナ / Vermouth Belluna【APP LAND】`, which
   resolves to the same `UCGPSbXH61y4l85L9XTUl2mA` /
   `/@VermouthBelluna` identity as another candidate group.

The four already-complete identities are kept unchanged:

- `常勝無敗ぐぬぬ - Makenashi Gununu -/ ビバップ高校`
- `不知名イヲ`
- `七海うらら*歌channel、YUENA-ユエナ- channel`
- `CHIYURU ch.三日月ちゆる、Hanon Ch. 香鳴ハノン【パレプロ】`

Review artifacts:

- `/mnt/g/codex-work/.codex-tmp/channel-hydration-apply/final-dry-run/apply-report.json`
- `/mnt/g/codex-work/.codex-tmp/channel-hydration-apply/final-dry-run/apply-report.md`
- `/mnt/g/codex-work/.codex-tmp/channel-hydration-apply/final-dry-run/generated-entries.json`

`generated-entries.json` contains exactly 486 canonical entries. Its SHA-256 is
`ee6d925856fa60e9ddab3209edea22b6a4d69adbcd5c73df04bc475958c0d9d2`.

## Isolated apply and idempotence proof

The repository metadata was copied to:

`/mnt/g/codex-work/.codex-tmp/channel-hydration-apply/isolated-final-20260726-2320/channel-metadata.json`

The first explicit application completed with:

```text
CODEX_CHANNEL_IDENTITY_HYDRATION_OK dryRun=false eligible=492 added=486 filled=0 unchanged=4 conflicts=0 excluded=1 ambiguous=2 unresolved=2 changed=486
```

The second application against the resulting file completed with:

```text
CODEX_CHANNEL_IDENTITY_HYDRATION_OK dryRun=false eligible=492 added=0 filled=0 unchanged=490 conflicts=0 excluded=1 ambiguous=2 unresolved=2 changed=0
```

The metadata SHA-256 before and after the second application was identical:

`f3081bd1e4bcdb991ac5befbeb659a6d5e8bfcee79dde97fdd891adc3a1f8019`

This proves repeat execution is idempotent. The two duplicate candidate rows
remain consolidated into their corresponding single metadata entries.

## Latest-main integration result

The main release task did not replace current metadata with this worktree's
older copy. It downloaded the exact `main` metadata, whose SHA-256 was
`e48502b0ad192c2e7e577a135a88e50b2a5c9275a7f0ac19acef6f9fc8f6c3b7`,
and reran both dry-run and explicit application against that file.

Latest-main result:

| Result | Count |
| --- | ---: |
| Existing metadata entries | 665 |
| New canonical metadata entries | 486 |
| Existing complete entries preserved | 4 |
| Duplicate candidate identities consolidated | 2 |
| Strong-identity conflicts | 0 |
| Felicia excluded | 1 |
| Ambiguous skipped | 2 |
| Unresolved skipped | 2 |
| Metadata entries after application | 1,151 |

The applied metadata SHA-256 is
`bc75b5b35e3ab9be4b0aa29ba197088df717ef46bd40e19ec49fb8e10adebd28`.
A second explicit application returned `changed=0`, and the SHA-256 remained
identical. The reviewed whole-file result is therefore safe to integrate on top
of that exact latest-main input; the original worktree metadata remains
untouched.

## Verification

```bash
node --check scripts/apply-channel-identity-hydration.js
node --test \
  test/channel-identity-hydration-apply.test.js \
  test/channel-identity-hydration-audit.test.js \
  test/channel-metadata-cache.test.js
```

Result: 22 tests passed, 0 failed.

Coverage includes unique mapping, duplicate consolidation, strong-identity
conflict handling, partial-field fill, complete-entry preservation, Felicia
exclusion, ambiguous/unresolved exclusion, full-report count checks, explicit
apply confirmation, dry-run immutability, and second-run `changed=0`.

The generated canonical entry artifact also passed:

```text
CODEX_GENERATED_ENTRIES_OK declared=486 actual=486 uniqueIds=486 uniqueHandles=486 invalid=0 duplicateIds=0 duplicateHandles=0 felicia=0
```
