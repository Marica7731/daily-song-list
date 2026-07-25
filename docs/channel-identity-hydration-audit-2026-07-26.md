# Channel identity hydration audit — 2026-07-26

## Scope and safety boundary

This audit covers runtime video records where at least one of `channelId`, `channelHandle`, or `channelUrl` is missing.

- Candidate generation is dry-run only. The tool has no apply, metadata-write, import, merge, or deploy mode.
- `data/external/youtube-channel-discovery/channel-metadata.json` is loaded read-only through the existing `scripts/channel-metadata-cache.js` schema/lookup contract.
- Display names are provisional grouping labels, not channel identities. A display-name-only cache match cannot become high-confidence.
- High-confidence requires a strong runtime identity or a video-level official YouTube identity, followed by confirmation from the official channel page.
- Renames and multilingual display names are retained as aliases/evidence. Conflicting channel IDs/handles remain in the manual queue.
- Deleted/private/unavailable videos remain unresolved unless another strong identity source exists.
- Felicia Lulufleur is an excluded known-positive: it is retained as validation evidence but this branch does not deliver a Felicia metadata patch.
- No accepted source file, curation file, existing metadata asset, frontend file, runtime DB, or production service is modified.

## Reused hydration contract

The existing runtime hydration paths are:

- `scripts/channel-metadata-cache.js` for JS/static runtime hydration.
- `hydrate_payload_channel_metadata()` / `hydrate_item_channel_metadata()` in `scripts/db/build-runtime-db.py` for SQLite runtime hydration.
- `data/external/youtube-channel-discovery/channel-metadata.json` with `displayName`, `channelId`, `channelHandle`, `channelUrl`, `sourceUrl`, avatar, and thumbnail fields.

`scripts/audit-channel-identity-hydration.js` emits review candidates in that field shape. It does not bypass the existing builders and does not write their input asset.

## Resolution evidence and confidence rules

For each provisional group:

1. Preserve any existing strong `channelId`, handle, or canonical channel URL.
2. Consult the existing metadata cache by strong identity. A name-only hit is recorded only as a hint.
3. Use up to three representative video IDs:
   - parse official YouTube watch HTML for `videoDetails.channelId`;
   - if watch HTML is bot-gated, use official YouTube oEmbed for the video's author URL/handle;
   - never send cookies.
4. Fetch the official channel page by ID or handle and parse canonical `externalId`, `canonicalBaseUrl`, and display name.
5. Classify:
   - `high-confidence`: one consistent strong identity plus a complete canonical channel-page identity;
   - `ambiguous`: conflicting identities, name-only hints, canonical mismatch, or incomplete canonical fields;
   - `unresolved`: no channel identity evidence after bounded attempts.

Checkpoint files store only parsed results and status/reason fields; raw HTML, cookies, authorization values, and host addresses are not stored.

## Tool usage

Single run:

```bash
node scripts/audit-channel-identity-hydration.js \
  --output-dir artifacts/channel-identity-audit \
  --cache-dir artifacts/channel-identity-audit/cache \
  --exclude-name Felicia \
  --max-videos-per-group 3 \
  --concurrency 3 \
  --api-concurrency 2 \
  --request-timeout-ms 12000
```

Shard run:

```bash
node scripts/audit-channel-identity-hydration.js \
  --output-dir artifacts/channel-identity-audit/shard-0 \
  --cache-dir artifacts/channel-identity-audit/shared-cache \
  --checkpoint artifacts/channel-identity-audit/shared-cache/checkpoint.json \
  --manifest artifacts/channel-identity-audit/shard-0/manifest.json \
  --stage-log artifacts/channel-identity-audit/shard-0/stage.log \
  --shard-index 0 \
  --shard-count 8 \
  --exclude-name Felicia
```

Merge review artifacts:

```bash
node scripts/audit-channel-identity-hydration.js \
  --merge-input artifacts/channel-identity-audit/shard-0/candidates-shard-000-of-008.json \
  --merge-input artifacts/channel-identity-audit/shard-1/candidates-shard-001-of-008.json \
  --output-json artifacts/channel-identity-audit/candidates-full.json \
  --output-markdown artifacts/channel-identity-audit/candidates-full.md
```

Every successful run prints `CODEX_CHANNEL_IDENTITY_AUDIT_OK`; a successful merge prints `CODEX_CHANNEL_IDENTITY_AUDIT_MERGE_OK`.

## Production baseline

Observed from `https://ytb-song-rank.culua.com` on 2026-07-26:

- `/healthz`: HTTP 200.
- `/api/meta`: HTTP 200.
- Runtime source commit: `1d2bf94f6e69fbefc5a9e488d8fd77de1569f414`.
- Runtime DB counts: 45,252 videos, 44,624 songs, 594,582 occurrences.
- Paginated `view=videos` audit input: 45,223 records across 227 pages.
- Records missing at least one stored identity field: 16,584.
- Provisional missing-identity groups: 497.

The difference between `counts.videos` and `view=videos` ranking records is reported rather than hidden; this audit uses the reviewable records returned by the production ranking endpoint.

## Felicia positive sample

Production `view=vtubers&q=Felicia` returned:

- 239 videos.
- 3,293 occurrences.
- Empty `channelId`, `channelHandle`, and `channelUrl`.

Three preview video IDs (`_FvIbP3SSp4`, `jgycb-eEtD0`, `d-lJ2UQd6yw`) independently returned the same official oEmbed author handle. The official channel page confirmed:

- `channelId`: `UClHap4tvcYZnyiqgAyEs0BQ`
- `channelHandle`: `/@FeliciaLulufleur`
- canonical channel URL: `https://www.youtube.com/channel/UClHap4tvcYZnyiqgAyEs0BQ`

Small-batch completion marker:

```text
CODEX_CHANNEL_IDENTITY_AUDIT_OK records=1 missingRecords=1 selectedGroups=1 highConfidence=1 ambiguous=0 unresolved=0 excludedKnownPositive=1 dryRun=true shard=0/1
```

Disposition: `excluded_known_positive`. No Felicia patch is included in this branch.

## Full audit results

The VPS run used eight sequential shards. Each shard used network concurrency `3`,
API concurrency `2`, a 12-second request timeout, and a 20-minute wrapper timeout.
The shared cache and checkpoint were reused between shards; no run used `--fresh`.

Merged at `2026-07-25T22:40:04Z` (`2026-07-26 06:40:04` Asia/Taipei):

- Audit input: 45,223 reviewable production video records.
- Missing at least one stored identity field: 16,584 records in 497 provisional groups.
- Missing all three identity fields: 14,670 records.
- Occurrences represented by missing-identity records: 195,983.
- High-confidence: 493 groups, including one excluded known-positive.
- Deliverable high-confidence: 492 groups after excluding Felicia.
- Ambiguous: 2 groups.
- Unresolved: 2 groups.

Field coverage:

| Stored field | Before present | Before missing | Before coverage | After 492 deliverable candidates present | Remaining missing | Projected coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `channelId` | 30,553 | 14,670 | 67.56% | 44,843 | 380 | 99.16% |
| `channelHandle` | 30,412 | 14,811 | 67.25% | 44,843 | 380 | 99.16% |
| `channelUrl` | 28,639 | 16,584 | 63.33% | 44,843 | 380 | 99.16% |

The remaining 380 records are exactly the 239 excluded Felicia records plus 141
records in the four manual groups. If Felicia were included, the projected
coverage for each field would be 45,082 / 45,223 (99.69%).

Top missing-identity groups by video count:

| Display name | Videos | Occurrences | Missing fields |
| --- | ---: | ---: | --- |
| みたにみく- VTuber - | 376 | 5,781 | ID, handle, URL |
| 水沢オペラ / Opera Ch. | 373 | 6,330 | ID, handle, URL |
| 藤音カナデ-Fujioto Kanade- | 372 | 4,797 | ID, handle, URL |
| 音羽ララ (Otohane Lara) / シアーミュージックV | 347 | 4,301 | ID, handle, URL |
| もかん ch / Mokan | 346 | 6,137 | ID, handle, URL |
| 狼朗ハツキ - Rourou Hatsuki - | 338 | 4,192 | URL |
| 紅葉丸チャンネル Momijimaru | 255 | 3,603 | ID, handle, URL |
| 鏡愛しゅくり | 241 | 2,859 | ID, handle, URL |
| ふぇりしあ / Felicia Ch | 239 | 3,293 | ID, handle, URL |
| まゆり | 231 | 3,062 | ID, handle, URL |

Top groups by occurrence count are 水沢オペラ (6,330), もかん (6,137),
みたにみく (5,781), 藤音カナデ (4,797), 音羽ララ (4,301), 狼朗ハツキ
(4,192), 紅葉丸 (3,603), Felicia (3,293), 香椎きなこ (3,200), and
まゆり (3,062).

Completion markers:

```text
VPS_AUDIT_ALL_SHARDS_OK shardCount=8
CODEX_CHANNEL_IDENTITY_AUDIT_MERGE_OK inputs=8 highConfidence=493 ambiguous=2 unresolved=2 dryRun=true
VPS_AUDIT_MERGE_OK
```

The generated review artifacts were copied off the VPS to:

- `G:\codex-work\.codex-tmp\channel-hydration-audit\results\candidates-full.json`
- `G:\codex-work\.codex-tmp\channel-hydration-audit\results\candidates-full.md`

## Manual queues

Ambiguous:

1. `Itsuki Natsume / 棗いつき`: 20 videos / 185 occurrences. The three
   representative videos resolve to two distinct channel IDs:
   `UCZ3ryrdsdqezi2q-AfRw6Rw` and `UCbeQJS5Ar0W2PWE1y5LnjrA`.
2. `まゆる / mayuru`: 2 videos / 7 occurrences. The two videos resolve to
   different channel IDs: `UCEsInI6avCL2afoAZX7nVdQ` and
   `UCgP3GbgbuVzAhlctGU5yuPA`.

Unresolved after one bounded retry of only the failed shards:

1. `白傘くらげ【卒業】`: 68 videos / 902 occurrences. Samples:
   `vmf7TLRFZVM`, `dxHUE8gzjGw`, `b3I9NludD2g`.
2. `鈴莉れん / Ren Suzuri`: 51 videos / 401 occurrences. Samples:
   `SYssu02ZVRc`, `jbphDO3SQ14`, `m-VzidZRfa0`.

For both unresolved groups, the retry returned YouTube watch HTTP 429 and
official oEmbed HTTP 403 for all three samples. The 495 already successful
groups were served from the shared cache and were not re-fetched. These four
groups remain manual work; the audit does not guess from their display names.

## Verification

VPS execution used a checksum-verified portable Node.js v22.23.1 runtime in the
task-specific temporary directory; it did not install system packages. The
normalized bounded entry points were:

```bash
bash /tmp/dsl-channel-hydration-audit-20260726/run-vps-all-shards.sh
AUDIT_RETRY_FAILED=1 bash /tmp/dsl-channel-hydration-audit-20260726/run-vps-audit.sh shard 6 8
AUDIT_RETRY_FAILED=1 bash /tmp/dsl-channel-hydration-audit-20260726/run-vps-audit.sh shard 7 8
bash /tmp/dsl-channel-hydration-audit-20260726/merge-vps-results.sh
```

Local verification:

```bash
node --check scripts/audit-channel-identity-hydration.js
node --test test/channel-identity-hydration-audit.test.js test/channel-metadata-cache.test.js
```

Result: 12 tests passed, 0 failed. The test suite covers parsing, stored-field
coverage, confidence and conflict classification, name-only hints,
deleted/private failures, checkpoint/manifest/review artifact generation,
shard merge coverage, mutation flag rejection, and the reused metadata cache
contract.
