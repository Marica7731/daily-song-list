# 2026-07-22 source backfill batch16

This is an unresolved queue audit after the `asaxmayo` shard failure. It does not contain an accepted increment and does not modify `data/external`.

## Accepted Evidence Audit

`data/external/youtube-channel-discovery/accepted` was searched with a positive sample check:

- Positive sample: `HazukiHina` matched 1 accepted file.
- The 12 unresolved sources below matched 0 accepted files.
- Marker: `CODEX_UNRESOLVED_ACCEPTED_HIT_AUDIT_OK targets=12 positiveHazukiFiles=1`.

Conclusion: these sources cannot be skipped as already self-crawled.

## Unresolved Sources

| Source | Status | Candidates | Inspected | Accepted videos | Reason |
| --- | --- | ---: | ---: | ---: | --- |
| `AmanofuStella` | pending | 235 | 18 | 0 | needs low-concurrency shard/resume |
| `arale_yumemita` | failed | 186 | 96 | 0 | prior timeout before manifest |
| `ebakyouka` | pending | 464 | 20 | 0 | needs low-concurrency shard/resume |
| `KohanaLam` | pending | 224 | 28 | 0 | needs low-concurrency shard/resume |
| `Kyoka_0609` | pending | 245 | 6 | 0 | needs low-concurrency shard/resume |
| `Laz_Furuto` | pending | 312 | 0 | 0 | candidate-only probe only |
| `UtenHiyori` | pending | 428 | 0 | 0 | candidate-only probe only |
| `SoraOtoha` | failed | 127 | 64 | 0 | prior timeout before manifest |
| `omaru_piano` | failed | 143 | 139 | 0 | prior timeout; requires strict piano/instrument dirty audit |
| `KOTATSUChHaruKotatsubutonclub` | failed | 134 | 130 | 0 | batch13 timeout before manifest |
| `UCrF92dEkXiTtexol0yg4Gmw` | failed | 306 | 135 | 0 | batch13 timeout before manifest |
| `asaxmayo` | failed | 571-591 | shard partial | 0 | batch15 429/timeout; candidate counts differed by host |

## Retry Policy

- Do not import partial checkpoint details.
- Use one stable candidate snapshot per source before sharding.
- Run one shard at a time per host; batch15's two concurrent shards per host hit 429/timeout.
- Increase request interval beyond 5000ms after HTTP 429.
- Commit complete manifests first; incomplete shards stay failed/pending.

## Remote Cleanup

No VPS was used for this audit-only batch, so no remote temporary directory was created.
