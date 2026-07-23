# Source Backfill Batch112 Queue Refresh Audit

- Status: audit_only
- Scope: refresh batch104 remaining queue using current committed artifacts; no YouTube fetch; no data/external write.
- Source count: 13
- Accepted totals represented by existing ready/partial artifacts: videos=390, occurrences=5224, songs=4799

## Status Counts

- failed: 1
- imported_shards_ready: 2
- pending_partial: 3
- partial_artifact_ready: 2
- skipped: 1
- imported_artifact_ready: 1
- failed_pending_shards: 1
- skipped_duplicate: 1
- pending: 1

## Sources

| Handle | Status | Accepted videos | Accepted occurrences | Accepted songs | Evidence | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- |
| arale_yumemita | failed | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch104-queue-audit/manifest.json | timeout checkpoint from batch104; no accepted manifest |
| AmanofuStella | imported_shards_ready | 164 | 1588 | 1584 | artifacts/channel-discovery/2026-07-22-source-backfill-batch53..72-amanofustella-shards | 16/16 latest shard manifests are success; no source-level consolidated file found in this audit |
| asaxmayo | pending_partial | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch109-asaxmayo-hazukihina/manifest.json | bounded full run interrupted before complete discovery marker |
| ebakyouka | partial_artifact_ready | 18 | 455 | 395 | artifacts/channel-discovery/2026-07-22-source-backfill-batch31-ebakyouka-partial/manifest.json | source has 464 candidates; this batch only exports the 18 completed details from the prior checkpoint |
| HazukiHina | skipped | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch110-hazukihina-instrumental-audit/manifest.json | dirty_audit_dropped_all_instrumental_or_live_performance_content |
| KohanaLam | partial_artifact_ready | 2 | 13 | 13 | artifacts/channel-discovery/2026-07-22-source-backfill-batch32-kohanalam-partial/manifest.json | source has 224 candidates; this batch only exports the accepted subset from the 3 completed checkpoint details |
| KOTATSUChHaruKotatsubutonclub | imported_artifact_ready | 40 | 420 | 395 | artifacts/channel-discovery/2026-07-22-source-backfill-batch29-kotatsu-consolidated/manifest.json | 4/4 shards consolidated into artifact-local accepted increment |
| Kyoka_0609 | imported_shards_ready | 148 | 2684 | 2357 | artifacts/channel-discovery/2026-07-22-source-backfill-batch34..51-kyoka-shards | 16/16 latest shard manifests are success; accepted increments are per-shard artifacts |
| Laz_Furuto | failed_pending_shards | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-22-source-backfill-batch24-laz-furuto-shard0/manifest.json; artifacts/channel-discovery/2026-07-23-source-backfill-batch108-mac-candidate-probes/manifest.json | historical shard0 timed out; later candidate probe was bounded and not import-ready |
| omaru_piano | skipped_duplicate | 18 | 64 | 55 | artifacts/channel-discovery/2026-07-23-source-backfill-batch83-omaru-piano-duplicate-evidence/manifest.json | batch22_imported_artifact_ready_already_exists |
| SoraOtoha | pending | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch104-queue-audit/manifest.json | no newer source-specific artifact found in this refresh audit |
| UCrF92dEkXiTtexol0yg4Gmw | pending_partial | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch111-ucrf92d-probe-full/manifest.json | probe_reached_end_all_tabs_false;candidate_count_gt_20 |
| UtenHiyori | pending_partial | 0 | 0 | 0 | artifacts/channel-discovery/2026-07-23-source-backfill-batch107-utenhiyori-continuation/manifest.json | mac_continuation_timed_out_before_complete_manifest |

## Next Queue

- arale_yumemita: failed; timeout checkpoint from batch104; no accepted manifest
- asaxmayo: pending_partial; bounded full run interrupted before complete discovery marker
- Laz_Furuto: failed_pending_shards; historical shard0 timed out; later candidate probe was bounded and not import-ready
- SoraOtoha: pending; no newer source-specific artifact found in this refresh audit
- UCrF92dEkXiTtexol0yg4Gmw: pending_partial; probe_reached_end_all_tabs_false;candidate_count_gt_20
- UtenHiyori: pending_partial; mac_continuation_timed_out_before_complete_manifest
